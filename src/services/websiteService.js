// ---------------------------------------------------------------------------
// Ek Sathi — Depth-Site Scraper ("Beast" mode for whole websites)
//   Deep mode: home + up to N internal pages + linked CSS, then extract
//   stack, typography/fonts, color palette/design tokens, purpose, field.
//   Mirrors the repoService deep-scan approach with a ~45KB text budget.
// ---------------------------------------------------------------------------
const cheerio = require('cheerio');
const { fetchWithTimeout, validatePublicUrl, isJunkUrl } = require('./crawlerService');

const TEXT_BUDGET = 45000;   // merged visible text fed to the LLM
const CSS_BUDGET = 30000;    // CSS window used for font/color + LLM hinting
const CSS_DL_BUDGET = 140000;// hard cap on stylesheet bytes we download
const PAGE_CAP = 10;         // max internal pages crawled
const CACHE_TTL = 15 * 60 * 1000;

const cache = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset', 'revert']);

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function cacheKey(url) { return url.replace(/\/$/, '').toLowerCase(); }

async function fetchHtml(url, timeoutMs = 10000) {
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res;
}

// ── Per-page extraction ────────────────────────────────────
function extractPage($, html, baseUrl) {
  const title = $('title').text().trim()
    || $('meta[property="og:title"]').attr('content')
    || $('meta[name="twitter:title"]').attr('content') || '';
  const description = $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content') || '';
  const siteName = $('meta[property="og:site_name"]').attr('content') || '';
  const generator = $('meta[name="generator"]').attr('content') || '';
  const favicon = ($('link[rel="icon"], link[rel="shortcut icon"]').first().attr('href') || '');
  let faviconAbs = '';
  try { if (favicon) faviconAbs = new URL(favicon, baseUrl).href; } catch (_) {}

  // readable text (main/article first, else cleaned body)
  const cleanDoc = cheerio.load(html);
  cleanDoc('script, style, noscript, svg, iframe, nav, footer, header, aside, canvas, video, audio, form, .sidebar, [role="banner"], [role="navigation"], [role="complementary"], .cookie, .ad, .modal, .popup').remove();
  let text = cleanDoc('main, article, [role="main"], #content, .content, .post-content, .article-body').first().text().replace(/\s+/g, ' ').trim();
  if (!text || text.length < 150) text = cleanDoc('body').text().replace(/\s+/g, ' ').trim();

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length > 3) headings.push(`${el.tagName.toUpperCase()}: ${t}`);
  });

  // internal same-origin links (nav priority)
  const internal = [];
  const seen = new Set();
  let origin = '';
  try { origin = new URL(baseUrl).origin; } catch (_) {}
  $('a[href]').each((_, el) => {
    if (internal.length >= PAGE_CAP * 3) return false;
    const raw = $(el).attr('href');
    if (!raw) return;
    try {
      const u = new URL(raw, baseUrl);
      if (u.origin !== origin) return;
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      const href = u.href.split('#')[0];
      if (seen.has(href) || isJunkUrl(href)) return;
      seen.add(href);
      const label = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 90);
      if (label) internal.push({ url: href, text: label });
    } catch (_) {}
  });

  const cssUrls = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try { cssUrls.push(new URL(href, baseUrl).href); } catch (_) {}
  });

  const inlineCss = [];
  $('style').each((_, el) => {
    const s = $(el).html() || '';
    if (s) inlineCss.push(s);
  });

  const forms = [];
  $('form').each((_, el) => {
    if (forms.length >= 3) return false;
    const actionTxt = $(el).attr('action') || '';
    let action = actionTxt;
    try { if (actionTxt) action = new URL(actionTxt, baseUrl).href; } catch (_) {}
    const inputs = [];
    $(el).find('input, textarea, select').each((__, inp) => {
      const type = $(inp).attr('type') || 'text';
      if (['hidden', 'submit', 'button'].includes(type)) return;
      const ph = $(inp).attr('placeholder') || '';
      const name = $(inp).attr('name') || '';
      const label = $(inp).closest('label').text().trim() || $(inp).parent().find('label').first().text().trim() || '';
      inputs.push({ type, name: name.slice(0, 40), label: (label || ph).slice(0, 60) });
    });
    forms.push({ action: action || '(same page)', method: ($(el).attr('method') || 'get').toUpperCase(), inputs: inputs.slice(0, 6) });
  });

  return { title, description, siteName, generator, favicon: faviconAbs, text, headings, internal, cssUrls, inlineCss, forms };
}

// ── Font + color analysis over CSS text ────────────────────
function analyzeDesign(cssText, pages) {
  const css = String(cssText || '').slice(0, CSS_BUDGET);
  const fonts = [];
  const fontCount = new Map();

  // font-family declarations
  const famRe = /font-family\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = famRe.exec(css)) !== null) {
    const parts = m[1].split(',');
    for (let p of parts) {
      p = p.trim().replace(/^['"]|['"]$/g, '').trim();
      if (!p || GENERIC_FONTS.has(p.toLowerCase())) continue;
      fontCount.set(p, (fontCount.get(p) || 0) + 1);
    }
  }
  // @font-face blocks
  const ffRe = /@font-face\s*\{([^}]+)\}/gi;
  while ((m = ffRe.exec(css)) !== null) {
    const fm = m[1].match(/font-family\s*:\s*['"]?([^;'"{}]+)/);
    if (fm) {
      const name = fm[1].trim();
      if (!fontCount.has(name)) fontCount.set(name, 1);
    }
  }
  // CSS custom properties with font stacks
  const varRe = /--[a-z0-9-]*(?:font|family)[a-z0-9-]*\s*:\s*([^;]+)/gi;
  while ((m = varRe.exec(css)) !== null) {
    const parts = m[1].split(',');
    for (let p of parts) {
      p = p.trim().replace(/^['"]|['"]$/g, '').trim();
      if (!p || GENERIC_FONTS.has(p.toLowerCase())) continue;
      fontCount.set(p, (fontCount.get(p) || 0) + 1);
    }
  }
  // Google / Bunny font CDN families from <link> found on pages
  const cdnRe = /(?:fonts\.googleapis\.com|fonts\.bunny\.net)\/css2?\?[^"'\s]*family=([^&"'\s]+)/gi;
  const cdnSeen = new Set();
  for (const p of pages) {
    const link = String(p.cssUrls ? p.cssUrls.join(' ') : '');
    while ((m = cdnRe.exec(link)) !== null) {
      const fam = decodeURIComponent(m[1]).replace(/:[0-9,]+$/i, '').replace(/\+/g, ' ').replace(/'/g, '');
      if (fam && !cdnSeen.has(fam)) { cdnSeen.add(fam); fontCount.set(fam, (fontCount.get(fam) || 0) + 1); }
    }
  }

  const sortedFonts = [...fontCount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedFonts.slice(0, 8)) fonts.push({ name, weight: count });

  // colors
  const colorCount = new Map();
  const tokens = [];
  function addColor(hex, role) {
    if (!hex || !/^#[0-9a-f]{3,8}$/i.test(hex)) return;
    let c = hex.toLowerCase();
    if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    colorCount.set(c, (colorCount.get(c) || 0) + 1);
    if (role) tokens.push({ color: c, name: role });
  }
  function rgbToHex(s) {
    const m = s.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (!m) return '';
    const to = (n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, '0');
    return `#${to(m[1])}${to(m[2])}${to(m[3])}`;
  }

  // design tokens (CSS custom properties)
  const tokRe = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/g;
  const tokSeen = new Set();
  while ((m = tokRe.exec(css)) !== null) {
    const rr = m[2].trim().startsWith('#') ? m[2].trim() : rgbToHex(m[2].trim());
    if (rr && !tokSeen.has(rr)) { tokSeen.add(rr); addColor(rr, m[1].replace(/^-+/, '')); }
  }

  const hexRe = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
  while ((m = hexRe.exec(css)) !== null) addColor(m[0]);
  const rgbRe = /rgba?\([\d.]+[,\s]+[\d.]+[,\s]+[\d.]+[^)]*\)/g;
  while ((m = rgbRe.exec(css)) !== null) { const h = rgbToHex(m[0]); if (h) addColor(h); }

  const colors = [...colorCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([hex, count]) => ({ hex, count }));
  const tokenMap = new Map(tokens.map(t => [t.color, t.name]));

  return { fonts, colors, tokens: tokens.slice(0, 14) };
}

// ── Tech stack detection ───────────────────────────────────
function detectStack(htmls, headers, cssText) {
  const hay = (htmls || []).join(' ') + '\n' + String(cssText || '').slice(0, 60000);
  const out = { frameworks: [], styling: [], libraries: [], cms: [], ssg: [], runtime: [] };

  const add = (arr, name) => { if (!arr.includes(name)) arr.push(name); };

  if (/__NEXT_DATA__|\/_next\/|next\.js/i.test(hay)) add(out.frameworks, 'Next.js (React)');
  if (/__NUXT__|__NUXT_DATA__|\/_nuxt\//i.test(hay)) add(out.frameworks, 'Nuxt.js (Vue)');
  if (/data-reactroot|react\.production\.min\.js|react-dom/i.test(hay)) add(out.frameworks, 'React');
  if (/data-v-[a-f0-9]+|vue\.global\.js|createApp\(/.test(hay)) add(out.frameworks, 'Vue.js');
  if (/ng-version|ng-app|@angular/i.test(hay)) add(out.frameworks, 'Angular');
  if (/svelte-|\/_app\/immutable\/|svelte\.internal/i.test(hay)) add(out.frameworks, 'Svelte/SvelteKit');
  if (/astro-island|data-astro-/i.test(hay)) add(out.frameworks, 'Astro');
  if (/data-gatsby|gatsby\-/i.test(hay)) add(out.frameworks, 'Gatsby (React)');
  if (/__remix_context|remix\.route/i.test(hay)) add(out.ssg, 'Remix');
  if (/preact\.min|preact\/dist/i.test(hay)) add(out.frameworks, 'Preact');
  if (/solid\.js|data-hk=/i.test(hay)) add(out.frameworks, 'SolidJS');
  if (/<!--.*wp-content|wp-content\/|wp-includes\/|\/wp-json/i.test(hay)) { add(out.cms, 'WordPress (PHP)'); add(out.runtime, 'PHP'); }
  if (/blogger\.com|blogspot\.com|data:blog\./i.test(hay)) add(out.cms, 'Blogger');
  if (/cdn\.shopify\.com|\/cart\.js|Shopify\.theme/i.test(hay)) add(out.cms, 'Shopify');
  if (/wix\.com.*viewer|static\.parastorage\.com|XW_Viewer/i.test(hay)) add(out.cms, 'Wix');
  if (/squarespace|static1\.squarespace\.com/i.test(hay)) add(out.cms, 'Squarespace');
  if (/ghost\.io|ghost-url|`$.ghost`/i.test(hay)) add(out.cms, 'Ghost');
  if (/bubble\.io|bubblecdn/i.test(hay)) add(out.cms, 'Bubble (no-code)');
  if (/webflow\.io|webflow\.js/i.test(hay)) add(out.cms, 'Webflow');
  if (/vermilion\.vercel|vercel\.com|_vercel/i.test(hay)) add(out.runtime, 'Vercel');
  if (/netlify|_redirects/i.test(hay)) add(out.runtime, 'Netlify');
  if (/amazonaws\.com|\/cloudfront\.net/i.test(hay)) add(out.runtime, 'AWS/CloudFront');

  if (/tailwindcss|tailwind\.config|class="[^"]*\b(flex|grid|p-\d|rounded-lg|text-slate|bg-slate)\b/i.test(hay)) add(out.styling, 'Tailwind CSS');
  if (/bootstrap|btn-primary|\/bootstrap@|<link[^>]+bootstrap/i.test(hay)) add(out.styling, 'Bootstrap');
  if (/css-modules|\.module\.css/i.test(hay)) add(out.styling, 'CSS Modules');
  if (/styled-components|\.styled\.|\$\{.*css`/i.test(hay)) add(out.styling, 'styled-components (CSS-in-JS)');
  if (/sass|scss|\.scss|\.sass\b/i.test(hay)) add(out.styling, 'Sass/SCSS');
  if (/grommet|material-ui|@mui|mui\.com/i.test(hay)) add(out.libraries, 'Material UI');
  if (/framer-motion|motion\.div/i.test(hay)) add(out.libraries, 'Framer Motion');
  if (/three\.min\.js|three@|THREE\./i.test(hay)) add(out.libraries, 'Three.js (3D)');
  if (/gsap|ScrollTrigger|TweenMax/i.test(hay)) add(out.libraries, 'GSAP (animations)');
  if (/chart\.js|Chartjs|chart\.min/i.test(hay)) add(out.libraries, 'Chart.js');
  if (/swiper|swiper\.js/i.test(hay)) add(out.libraries, 'Swiper/slider');
  if (/lucide|fontawesome|@fortawesome|fa-solid/i.test(hay)) add(out.libraries, 'icon system (Lucide/FontAwesome)');
  if (/(?:https?:\/\/|[^a-z])cdn\.(?:jsdelivr|unpkg|place?)\./i.test(hay)) add(out.libraries, 'CDN delivery');

  // header hints
  const hd = headers || {};
  if (hd.server) out.runtime.push(`server: ${String(hd.server).slice(0, 30)}`);
  if (hd['x-powered-by']) out.frameworks.push(`x-powered-by: ${String(hd['x-powered-by']).slice(0, 30)}`);
  if (hd['x-vercel-id'] || hd['x-vercel-cache']) { if (!out.runtime.some(r => r.includes('Vercel'))) out.runtime.push('Vercel'); }

  return out;
}

// ── Deep crawl the whole site ──────────────────────────────
async function deepScrapeSite(urlInput, opts = {}) {
  const url = normalizeUrl(urlInput);
  const key = cacheKey(url);
  if (cache.has(key) && Date.now() - cache.get(key).ts < CACHE_TTL) return cache.get(key).site;

  let mainRes;
  try {
    await validatePublicUrl(url);
    mainRes = await fetchHtml(url);
  } catch (err) {
    return { status: 'error', url, message: err.message, hint: 'Sirf public HTTP(S) URLs allowed hain.' };
  }

  try {
    const html = mainRes.text || '';
    const $ = cheerio.load(html);
    const main = extractPage($, html, mainRes.headers && mainRes.headers['x-final-url'] || url);

    // pick up to PAGE_CAP internal pages (prefer nav/header/footer links)
    const internal = main.internal.slice(0, PAGE_CAP * 2);
    const pageSnippets = [];
    const pageList = [];
    const allCssUrls = new Set(main.cssUrls.slice(0, 6));
    const seenPage = new Set([key]);

    const fetched = await Promise.allSettled(internal.slice(0, PAGE_CAP).map(async (l) => {
      const pk = cacheKey(l.url);
      if (seenPage.has(pk)) return null;
      seenPage.add(pk);
      const r = await fetchHtml(l.url, 9000);
      const p = cheerio.load(r.text);
      const pg = extractPage(p, r.text, l.url);
      for (const u of pg.cssUrls.slice(0, 6)) allCssUrls.add(u);
      return { url: l.url, label: l.text, title: pg.title, text: pg.text.slice(0, 6000), headings: pg.headings.slice(0, 8) };
    }));
    for (const r of fetched) {
      if (r.status === 'fulfilled' && r.value) {
        pageSnippets.push(r.value);
        pageList.push({ url: r.value.url, title: r.value.title || r.value.label || r.value.url });
      }
    }

    // CSS bundle
    let cssTotal = '';
    const cssDl = await Promise.allSettled(
      [...allCssUrls].slice(0, 8).map(async (u) => { const r = await fetchHtml(u, 8000); return r.text || ''; })
    );
    for (const r of cssDl) {
      if (r.status === 'fulfilled' && r.value) {
        if (cssTotal.length >= CSS_DL_BUDGET) break;
        cssTotal += r.value + '\n';
      }
    }
    for (const s of main.inlineCss) cssTotal += s + '\n';

    const allHtml = [html, ...pageSnippets.map(p => '')].join('');
    const stack = detectStack([html], mainRes.headers, cssTotal);

    // JSON-LD types from raw html
    const jsonLdTypes = [];
    try {
      const $l = cheerio.load(html);
      $l('script[type="application/ld+json"]').each((_, el) => {
        try {
          const j = JSON.parse($l(el).html());
          const t = j['@type'] || (j['@graph'] && j['@graph'][0] && j['@graph'][0]['@type']);
          if (t) (Array.isArray(t) ? t : [t]).forEach(x => { if (!jsonLdTypes.includes(x)) jsonLdTypes.push(x); });
        } catch (_) {}
      });
    } catch (_) {}

    const design = analyzeDesign(cssTotal, [main, ...pageSnippets]);

    // merged readable text
    const textParts = [main.text.slice(0, 10000)];
    pageSnippets.forEach(p => textParts.push(p.text));
    const mergedText = textParts.join('\n\n').replace(/\s+/g, ' ').trim().slice(0, TEXT_BUDGET);

    const site = {
      status: 'ok',
      url,
      title: main.title || pageSnippets[0]?.title || '',
      description: main.description,
      siteName: main.siteName,
      generator: main.generator,
      favicon: main.favicon,
      stack,
      design,
      jsonLdTypes,
      pages: [{ url, title: main.title || 'Home' }, ...pageList],
      forms: main.forms,
      headings: main.headings.slice(0, 14),
      textChars: mergedText.length,
      mergedText,
      scrapeMeta: `${main.siteName || main.title || url} · ${mergedText.length.toLocaleString()} chars from ${1 + pageSnippets.length} pages`,
      scrapedPages: 1 + pageSnippets.length,
    };
    cache.set(key, { ts: Date.now(), site });
    return site;
  } catch (err) {
    console.error('[WebsiteService] deepScrapeSite error:', err.message);
    return { status: 'error', url, message: err.message };
  }
}

// ── Beast analysis (LLM narrative) ─────────────────────────
async function analyzeWebsite(urlInput, opts = {}) {
  const site = await deepScrapeSite(urlInput);
  if (site.status !== 'ok') return site;

  const stackStr = [
    ...site.stack.frameworks, ...site.stack.cms, ...site.stack.ssg,
    ...site.stack.styling, ...site.stack.libraries, ...site.stack.runtime,
  ].join(', ') || 'no specific markers detected';
  const colorsStr = site.design.colors.map(c => `${c.hex} (×${c.count})`).join(', ') || 'none extracted';
  const tokensStr = site.design.tokens.map(t => `--${t.name}: ${t.color}`).join(', ');
  const fontsStr = site.design.fonts.map(f => `${f.name} (×${f.weight})`).join(', ') || 'system fonts';

  const websiteText = `${site.textChars} chars of real visible text were merged from ${site.scrapedPages} pages.`;
  const visibleSnippet = site.mergedText ? site.mergedText.slice(0, 12000) : '';

  try {
    const llm = require('./llmService');
    const res = await llm.callLLM({
      role: 'review',
      messages: [{
        role: 'system',
        content: `You are a sharp website technical auditor for a Computer Science/IT student.
Analyze the REAL extracted website evidence below and produce a precise, deep, honest technical+design breakdown.
Reply ONLY clean markdown with EXACTLY these section headers (keep every header):
## 📌 Overview
## 🎯 Final Goal & Purpose
## 🏷️ Industry / Field
## 🧰 Tech Stack & Architecture
## 🔤 Typography & Fonts
## 🎨 Color Palette & Design System
## 📄 Key Pages & Navigation
## ✨ Notable Details

Rules:
- Base EVERY claim on the extracted evidence. If a section has no evidence, say exactly that in one line.
- Explain HOW the site is built (framework, styling, hosting hints, SSR, CMS).
- Typography: interpret the detected font families (names, pairing, vibe), UI scale hints if visible.
- Colors: interpret the palette (primary/secondary/neutral roles from tokens or frequency), pick 2 adjectives for the vibe.
- Final goal kya hai aur kis field/industry ki site hai — clearly.
- Hinglish 5%: you may add ONE casual Hinglish aside line at the end (keep it respectful).`,
      }, {
        role: 'user',
        content: `WEBSITE: ${site.url}
TITLE: ${site.title || 'n/a'}
DESCRIPTION: ${site.description || 'n/a'}
JSON-LD TYPES: ${site.jsonLdTypes.join(', ') || 'none'}
TECH STACK: ${stackStr}
FONTS: ${fontsStr}
COLOR PALETTE: ${colorsStr}
DESIGN TOKENS: ${tokensStr || 'none'}
PAGES (${site.pages.length}): ${site.pages.map(p => p.title || p.url).slice(0, 12).join(' → ')}
FORMS: ${site.forms.map(f => `${f.method} ${f.action.slice(0, 60)}`).join('; ') || 'none visible'}

${websiteText}

REAL VISIBLE TEXT EXTACT (top of merged content):
${visibleSnippet || 'No readable text was extracted.'}`,
      }],
      temperature: 0.3,
      max_tokens: 2400,
    });

    return {
      status: 'ok',
      url: site.url,
      title: site.title,
      description: site.description,
      favicon: site.favicon,
      stack: site.stack,
      design: site.design,
      jsonLdTypes: site.jsonLdTypes,
      pages: site.pages,
      forms: site.forms,
      textChars: site.textChars,
      scrapedPages: site.scrapedPages,
      analysis: res.text,
    };
  } catch (err) {
    console.warn('[WebsiteService] LLM analysis failed, returning raw site:', err.message);
    return { ...site, status: 'ok', analysis: '' };
  }
}

// ── Deep Q&A (LLM over the whole site) ─────────────────────
async function askWebsiteQuestion(urlInput, question) {
  const site = await deepScrapeSite(urlInput);
  if (site.status !== 'ok') throw new Error(site.message || 'Site scrape nahi ho paya.');
  const llm = require('./llmService');
  const stackStr = [...site.stack.frameworks, ...site.stack.cms, ...site.stack.styling, ...site.stack.libraries, ...site.stack.runtime].join(', ');
  const res = await llm.callLLM({
    role: 'review',
    messages: [{
      role: 'system',
      content: `You are an expert who has studied an entire website. Answer the user's question using ONLY the REAL extracted website evidence below. If the evidence doesn't contain the answer, say "Is evidence me uska answer nahi mila" and give the closest related fact you DID find. Be precise and technical. Reply in Hinglish or English to match the question, max ~220 words, clean markdown.`,
    }, {
      role: 'user',
      content: `WEBSITE: ${site.url}
TITLE: ${site.title}
STACK: ${stackStr}
COLORS: ${site.design.colors.map(c => c.hex).join(' ')}
FONTS: ${site.design.fonts.map(f => f.name).join(', ')}
PAGES: ${site.pages.map(p => p.title || p.url).slice(0, 15).join(' → ')}

QUESTION: ${question}

REAL VISIBLE TEXT EXTACT (${site.textChars} chars merged from ${site.scrapedPages} pages):
${site.mergedText ? site.mergedText.slice(0, 14000) : 'No readable text extracted.'}`,
    }],
    temperature: 0.3,
    max_tokens: 700,
  });
  return { answer: res.text, site };
}

module.exports = { deepScrapeSite, analyzeWebsite, askWebsiteQuestion };