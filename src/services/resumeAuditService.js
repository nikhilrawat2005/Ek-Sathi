const { callLLM } = require('./llmService');
const { extractText } = require('./documentReaderService');
const PDFDocument = require('pdfkit');

const CRIT_MODEL = process.env.RESUME_AI_MODEL || 'google/gemini-2.5-flash';
const LLM_TIMEOUT_MS = 135000;

const SECTION_RE = /^(education|experience|work experience|professional experience|work|projects|project|technical skills|skills|summary|objective|profile|certifications|certificates|achievements|awards|accomplishments|interests|hobbies|languages|references|leadership|publications|extra.?curricular|activities|contact|personal details|additional|open source):?$/i;
const BULLET_TOKEN_RE = /^[\s]*[-*•▪‣◦–]\s*/;
const URL_RE = /https?:\/\/[^\s)\]]+/gi;

const STRONG_VERBS = ['built','developed','designed','created','led','launched','optimized','optimised','automated','implemented','engineered','deployed','managed','spearheaded','improved','reduced','increased','architected','delivered','shipped','mentored','streamlined','refactored','scaled','accelerated','modernized','modernised','established','drove','grew','introduced','orchestrated','pioneered','revitalized','cut','boosted'];
const WEAK_VERBS = ['focused on','contributed to','assisted','participated in','was responsible for','responsible for','helped','worked on','supported','involved in','learned about','took part in','helped in','did some'];
const FILLER_PHRASES = ['responsible for','assisted','helped','focused on','contributed to','participated in','worked on','various','etc','and more','involved in','some tasks','day-to-day'];

const GENERIC_KEYWORDS = ['react','node','typescript','javascript','python','java','sql','database','rest','api','cloud','aws','docker','kubernetes','git','github','cicd','ci/cd','linux','html','css','mongodb','postgres','mysql','express','redux','testing','jest','agile','scrum','team','leadership','communication','problem solving','algorithms','oop','system design','microservices','frontend','backend','fullstack','mobile','flutter','android','ios','ml','machine learning','ai','data','analytics','sass','vercel','firebase','graphql'];
const STOPS = new Set(['the','and','for','with','your','you','are','our','using','from','this','that','will','can','should','about','into','their','what','who','where','when','how','they','them','have','has','had','was','were','been','being','his','her','its','not','but','or','on','in','a','an','to','of','at','by','as','is','it','we','us','our','all','also','more','than']);

const METRIC_UNIT_RE = /(\d+(?:\.\d+)?\s*(%|percent|₹|rs\.?|rs\b|users?|clients?|customers?|projects?|stars?|downloads?|installs?|revenue|sales?|orders?|views?|visits?|traffic|conversions?|responses?|requests?|transactions?|lines?|pages?|tests?|gb|mb|tb|fps|ms\b|score|rating|deployments?|issues?|pulls?|commits?|students?|employees?|members?|k\b))/i;
const PLACEHOLDER_TERMS = ['lorem ipsum','xxx','todo','tbd','placeholder','your name','my name','"your','add your','sample text','changeme','example.com'];

function countMetrics(bullets) {
  let n = 0;
  for (const b of bullets) {
    const bt = b.trim();
    if (METRIC_UNIT_RE.test(bt)) { n++; continue; }
    if (!/\d/.test(bt)) continue;
    const loneYear = /^(19|20)\d{2}$/.test(bt) || /^\(?(19|20)\d{2}[)\s-]+(19|20)\d{2}[\)\s-]*$/.test(bt) || /^[A-Z][a-z]+\s+(19|20)\d{2}\s*[-–]\s*(Present|(19|20)\d{2})$/i.test(bt);
    if (loneYear) continue;
    if (/(100|\d{3,}|[0-9]+\.[0-9]+)/.test(bt)) n++;
  }
  return n;
}

function totalYears(text) {
  const yrs = (String(text || '').match(/(19|20)\d{2}/g) || []).map(Number).filter((y) => y >= 1970 && y <= 2100);
  if (!yrs.length) return 0;
  return Math.max(0, (Math.max(...yrs) - Math.min(...yrs)) || 1);
}

function collectUrls(text, extraUrls) {
  const out = [];
  const push = (u) => {
    u = String(u || '').trim().replace(/[.,;:!?)\]]+$/, '');
    if (/^https?:\/\//i.test(u) && out.indexOf(u) === -1) out.push(u);
  };
  (String(text || '').match(URL_RE) || []).forEach(push);
  (Array.isArray(extraUrls) ? extraUrls : []).forEach(push);
  return out;
}

// PDF hyperlinks live in /URI annotations, NOT in the text layer — pdf-parse
// only returns visible text (e.g. "GitHub | LinkedIn" labels), so plain text
// scraping misses the actual destination URLs. Read them straight from bytes.
function extractPdfUris(fileBuffer) {
  const raw = Buffer.isBuffer(fileBuffer) ? fileBuffer.toString('latin1') : String(fileBuffer || '');
  const out = [];
  const push = (u) => {
    u = String(u || '').trim().replace(/[.,;:!?)\]]+$/, '');
    if (/^https?:\/\//i.test(u) && out.indexOf(u) === -1) out.push(u);
  };
  let m;
  const paren = /\/URI\s*\(([^()]*)\)/g;
  while ((m = paren.exec(raw)) && out.length < 12) { let u = m[1]; try { u = decodeURIComponent(u); } catch (e) { /* keep raw */ } push(u); }
  const hex = /\/URI\s*<([0-9a-fA-F]+)>/g;
  while ((m = hex.exec(raw)) && out.length < 12) { try { push(Buffer.from(m[1], 'hex').toString('latin1')); } catch (e) { /* ignore */ } }
  return out;
}

function classifyLinks(urls) {
  const hosts = { github: false, linkedin: false, portfolio: false };
  for (const raw of (Array.isArray(urls) ? urls : [])) {
    try { const u = new URL(raw); hosts.github = hosts.github || /github\.com$/i.test(u.hostname); hosts.linkedin = hosts.linkedin || /linkedin\.com$/i.test(u.hostname); hosts.portfolio = hosts.portfolio || !(/github\.com|linkedin\.com/i.test(u.hostname)); } catch (e) { /* ignore */ }
  }
  return hosts;
}

function placeholderHits(text) {
  const t = String(text || '').toLowerCase();
  return PLACEHOLDER_TERMS.filter((p) => t.includes(p)).length;
}

function headersConsistent(sections, text) {
  if (sections.length < 3) return false;
  const heads = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.replace(/[#*_`.]+/g, '').replace(/:$/i, '').trim();
    if (t && t.length < 40 && SECTION_RE.test(t)) heads.push(t);
  }
  const saved = heads.filter((h) => /^[A-Z][^A-Za-z]/.test(h) || /^[A-Z][a-z]+\s*$/.test(h) || /^[A-Z][A-Za-z\s]{2,}$/.test(h));
  const title = heads.filter((h) => /^[A-Z][a-z]+(\s*[A-Z][a-z]+)*$/.test(h)).length;
  const upper = heads.filter((h) => /^[A-Z][A-Z\s]{2,}$/.test(h.replace(/\W/g, ' ').trim())).length;
  return (title + upper) >= Math.max(2, Math.ceil(heads.length * 0.7));
}

function categorizedSkills(text) {
  return /(languages|frameworks|tools|technologies|databases|platforms|libraries|skills)[^:\n]{0,40}:{1}/i.test(String(text || ''));
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function detectSections(text) {
  const found = new Set();
  for (const line of splitLines(text)) {
    const t = line.replace(/[#*_`.]+/g, '').replace(/:$/i, '').trim().toLowerCase();
    if (t && t.length < 40 && SECTION_RE.test(t)) found.add(normalSectionKey(t));
  }
  return [...found];
}

const SEC_ALIAS = { 'education': 'Education', 'experience': 'Experience', 'work experience': 'Experience', 'professional experience': 'Experience', 'work': 'Experience', 'projects': 'Projects', 'project': 'Projects', 'technical skills': 'Skills', 'skills': 'Skills', 'summary': 'Summary', 'objective': 'Summary', 'profile': 'Summary', 'certifications': 'Certifications', 'certificates': 'Certifications', 'achievements': 'Achievements', 'awards': 'Achievements', 'accomplishments': 'Achievements', 'contact': 'Contact', 'personal details': 'Contact' };
function normalSectionKey(t) { return SEC_ALIAS[t] || t; }

function extractBullets(text) {
  const out = [];
  for (const line of splitLines(text)) {
    const t = line.toLowerCase().replace(/[#*_`.]+/g, '').replace(/:$/i, '').trim();
    if (t && t.length < 40 && SECTION_RE.test(t)) continue;
    const bare = line.replace(BULLET_TOKEN_RE, '');
    if (!bare || bare.length < 6) continue;
    if (/^https?:\/\//i.test(bare)) continue;
    out.push(bare);
  }
  return out;
}

const hasEmail = (text) => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
const hasPhone = (text) => /(\+?\d[\s-]?){9,}\d/.test(text) || /(\+91|0091)[\s-]?\d{10}/.test(text);
const hasLocation = (text) => /,\s*[A-Z][a-zA-Z\u00C0-\u024F ]{2,}\b/.test(text) || /\b(India|United\s?States|USA|UK|London|New\s?York|San\s?Francisco|Bangalore|Bengaluru|Hyderabad|Pune|Delhi|Noida|Gurugram|Ghaziabad|Toronto|Berlin|Singapore)\b/i.test(text);
const matchDates = (text) => (text.match(/(19|20)\d{2}/g) || []).length;

async function checkLinks(urls) {
  const picked = (Array.isArray(urls) ? urls : []).slice(0, 4);
  if (!picked.length) return [];
  return Promise.all(picked.map(async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
      return { url, status: r.ok ? 'ok' : `http-${r.status}` };
    } catch (e) {
      return { url, status: ctl.signal.aborted ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(t);
    }
  }));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`AI critique timed out after ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

function crit(key, label, score, max, why, advice) {
  const sc = Math.max(0, Math.min(max, Math.round(+score || 0)));
  const status = sc >= max ? 'pass' : (sc >= max * 0.5 ? 'warn' : 'fail');
  return { key, label, score: sc, max, status, why, advice };
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

function gradeOf(v) { return v >= 90 ? 'A+' : v >= 80 ? 'A' : v >= 65 ? 'B' : v >= 50 ? 'C' : 'D'; }

function buildCriteriaGroups({ text, bullets, sections, jd, heuristics, pageCount, urls = [] }) {
  const quantified = countMetrics(bullets);
  const metricFrac = bullets.length ? quantified / bullets.length : 0;
  const filler = bullets.filter((b) => FILLER_PHRASES.some((f) => b.toLowerCase().includes(f)));
  const fillerFrac = bullets.length ? filler.length / bullets.length : 0;
  const strongLead = bullets.filter((b) => STRONG_VERBS.some((v) => b.toLowerCase().startsWith(v))).length;
  const weakLead = bullets.filter((b) => WEAK_VERBS.some((v) => b.toLowerCase().startsWith(v))).length;
  const strongFrac = bullets.length ? strongLead / bullets.length : 0;
  const weakFrac = bullets.length ? weakLead / bullets.length : 0;
  const trailFrac = bullets.length ? bullets.filter((b) => /\.$/.test(b)).length / bullets.length : 0;
  const spec = bullets.filter((b) => GENERIC_KEYWORDS.some((k) => new RegExp(`\\b${k}`, 'i').test(b))).length;
  const specFrac = bullets.length ? spec / bullets.length : 0;
  const dateCount = matchDates(text);
  const years = totalYears(text);
  const hosts = classifyLinks(urls);
  const places = placeholderHits(text);
  const headOk = headersConsistent(sections, text);
  const catOk = categorizedSkills(text);

  const jdCtx = jd || '';
  const jdTokens = [...new Set((jdCtx.toLowerCase().match(/[a-z][a-z0-9+#./-]{2,}/g) || []).filter((w) => w.length > 2 && !STOPS.has(w)))].slice(0, 60);
  let matched = [];
  let kwSource = 'jd';
  let dict = jdTokens;
  if (jdTokens.length >= 3) {
    dict = jdTokens;
    kwSource = 'target-jd';
    matched = dict.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text));
  } else {
    kwSource = 'generic';
    dict = GENERIC_KEYWORDS;
    matched = dict.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text.toLowerCase()));
  }
  const kwFrac = dict.length ? matched.length / dict.length : 0;
  const kwScore = clamp(100 * (1 - Math.exp(-kwFrac * 4.2)));

  heuristics.quantifiedBullets = quantified;
  heuristics.strongVerbs = strongLead;
  heuristics.weakVerbs = weakLead;
  heuristics.fillerBullets = filler.length;
  heuristics.trailingPeriods = trailFrac > 0 ? Math.round(trailFrac * bullets.length) : 0;
  heuristics.metricFrac = Math.round(metricFrac * 100);
  heuristics.skillMatch = { matched, total: dict.length, source: kwSource };
  heuristics.totalYears = years;
  heuristics.social = hosts;
  heuristics.summaryPresent = sections.includes('Summary');
  heuristics.missingSections = ['Summary', 'Experience', 'Skills', 'Education'].filter((s) => !sections.includes(s));
  heuristics.places = places;

  const secCount = sections.length;
  const hasExp = sections.includes('Experience');
  const hasSkills = sections.includes('Skills');
  const roleLines = bullets.filter((b) => /(engineer|developer|intern|analyst|scientist|architect|lead|head|manager|consultant|designer|trainee)/i.test(b)).length;

  const impact = [
    crit('impact.quantified', 'Metrics wali bullets (numbers/%)', clamp(100 * (0.08 + 1.5 * metricFrac)), 34,
      metricFrac >= 0.5 ? `Mazboot: ${quantified}/${bullets.length} bullets me real numbers/% hain (${Math.round(metricFrac * 100)}%).` : (quantified ? `Sirf ${Math.round(metricFrac * 100)}% bullets me metrics hain — baaki plain statements hain.` : 'Koi bullet bhi number/% ke saath nahi — recruiter ko proof chahiye.'),
      '"Improved load time by 45%", "Handled 1k+ users", "Cut cost from ₹X to ₹Y" — har impact-line me number do.'),
    crit('impact.specificity', 'Concrete tech/domain keywords wali bullets', clamp(100 * specFrac * 1.2), 33,
      specFrac > 0.4 ? `${Math.round(specFrac * 100)}% bullets me concrete tech/product ki baat hai.` : `Bahut kam bullets (${Math.round(specFrac * 100)}%) me concrete cheez mention hai — generic lagta hai.`,
      'React, AWS, dashboard, API jaise exact nouns use karo, sirf "worked with tools" nahi.'),
    crit('impact.fillers', 'Filler phrases (responsible for / helped...)', clamp(100 - 110 * fillerFrac), 33,
      filler.length ? `${filler.length} bullet(s) weak filler phrase se bhari hain — substance sirf wahi likha hai jo "kiya".` : 'Koi boring filler nahi mila.',
      'Filler hatao aur batao: kitna bada scope, kaun sa result — concrete rakho.'),
  ];

  const action = [
    crit('action.strongLead', 'Strong action verb se shuru bullets', Math.min(60, Math.round(100 * strongFrac / 0.8)), 60,
      strongFrac >= 0.7 ? `${Math.round(strongFrac * 100)}% bullets strong verb se shuru — outstanding.` : (strongFrac > 0 ? `Sirf ${Math.round(strongFrac * 100)}% bullets strong verb se shuru hoti hain.` : 'Koi bullet strong verb se shuru nahi hoti (naam/\"I\"/pronoun se jaati hain).'),
      'Har bullet: Built, Designed, Automated, Optimized, Launched, Led se shuru karo.'),
    crit('action.weakLead', 'Weak opening verbs avoid (Contributed to...)', clamp(100 - 130 * weakFrac), 25,
      weakFrac > 0.2 ? `${Math.round(weakFrac * 100)}% bullets weak verb se shuru — impact dab raha hai.` : (weakLead ? `${weakLead} bullet(s) weak verb se shuru.` : 'Koi weak opening verb nahi.'),
      '"Worked on X" ki jagah "Shipped/Built X" — wohi kaam double impact.'),
    crit('action.verbMix', 'Strong vs weak ka ratio', (strongLead || weakLead) ? clamp(100 * (strongLead / (strongLead + weakLead))) : 25, 15,
      (strongLead || weakLead) ? `Strong:weak = ${strongLead}:${weakLead}.` : 'Action verbs hi nahi mile.',
      'Strong verbs ≥ 80% tak le aao; weak verbs zero karo.'),
  ];

  const format = [
    crit('format.sections', 'Standard ATS sections found', secCount >= 5 ? 15 : secCount === 4 ? 12 : secCount === 3 ? 8 : secCount === 2 ? 5 : 0, 15,
      secCount > 0 ? `${secCount} standard sections mili. Missing: ${heuristics.missingSections.length ? heuristics.missingSections.join(', ') : '—'}.` : 'Koi standard section header nahi mila.',
      'SKILLS, EXPERIENCE, PROJECTS, EDUCATION, SUMMARY sab standard headers me likho.'),
    crit('format.email', 'Contact email present', hasEmail(text) ? 12 : 0, 12,
      hasEmail(text) ? 'Email mila.' : 'Email nahi mila!',
      'Top me clear email daalo.'),
    crit('format.phone', 'Phone number present', hasPhone(text) ? 10 : 0, 10,
      hasPhone(text) ? 'Phone mila.' : 'Phone nahi mila.',
      '+91-XXXXXXXXXX format me daalo.'),
    crit('format.location', 'Location/city present', hasLocation(text) ? 6 : 0, 6,
      hasLocation(text) ? 'Location hai.' : 'Location nahi dikhi.',
      'City, Country add karo (ATS location filter).'),
    crit('format.links', 'Social/profile links (GitHub/LinkedIn)', hosts.github || hosts.linkedin ? 12 : (hosts.portfolio ? 7 : 0), 12,
      (hosts.github || hosts.linkedin) ? 'GitHub/LinkedIn link mila — professional.' : (hosts.portfolio ? 'Sirf portfolio link mila — GitHub/LinkedIn bhi chahiye.' : 'Koi GitHub/LinkedIn link nahi mila.'),
      'LinkedIn + GitHub working links add karo (niche status check bhi hota hai).'),
    crit('format.periods', 'Bullets me trailing "." nahi', clamp(12 - 11 * trailFrac), 12,
      trailFrac > 0.2 ? `${Math.round(trailFrac * 100)}% bullets \".\" se khatam — outdated/ATS-dikkat.` : 'Bullet endings ATS-friendly hain.',
      'Bullet ke end me sentence-dot nahi; abbreviations ke dot okay.'),
    crit('format.headers', 'Section headers ki casing consistent', headOk ? 10 : 4, 10,
      headOk ? 'Headers consistent uppercase/title-case me hain.' : 'Headers ki casing mixed hai (title/ALL-CAPS/lowercase) — parse issue.',
      'Har header same style: SKILLS, EXPERIENCE,...'),
    crit('format.places', 'Placeholder/junk text nahi', clamp(10 - 4 * places), 10,
      places ? `${places} placeholder term(s) mile (${PLACEHOLDER_TERMS.slice(0, 3).join(', ')}...).` : 'Koi placeholder junk nahi mila.',
      'XXX/TODO/lorem ipsum waghera hatao — draft resume serious nahi lagta.'),
  ];
  if (pageCount != null) {
    format.push(crit('format.pages', 'Single page / compact', pageCount <= 1 ? 15 : pageCount === 2 ? 10 : pageCount === 3 ? 5 : 2, 15,
      pageCount <= 1 ? `Resume ${pageCount} page ka hai — 1-pager ideal.` : `Resume ${pageCount} pages ka hai.`,
      years < 4 && pageCount > 1 ? 'Freshers ke liye 1 page best; irrelevant cheezein hatao.' : '1-2 pages limit; redundant lines cut karo.'));
  }

  const experience = [
    crit('exp.present', 'Experience section present', hasExp ? 20 : 0, 20,
      hasExp ? 'Experience section mili.' : 'Experience section nahi mili (internships/projects se cover karo).',
      'Experience me Role → Company → Duration pattern.'),
    crit('exp.roles', 'Role/title lines detected', roleLines >= 2 ? 20 : roleLines === 1 ? 12 : 4, 20,
      roleLines >= 2 ? `${roleLines} role-like lines mili.` : 'Role/title clearly nahi dikh rahe.',
      'Har entry bold role + company: "SDE Intern — Acme Corp".'),
    crit('exp.dates', 'Date ranges present', dateCount >= 3 ? 20 : dateCount === 2 ? 16 : dateCount === 1 ? 9 : 3, 20,
      dateCount >= 3 ? `${dateCount} dates mili.` : `Sirf ${dateCount} date(s) mili.`,
      'Har role ke saath "Jun 2021 – Aug 2024" (ATS tenure count karta hai).'),
    crit('exp.tenure', 'Work tenure (years) visible', years >= 4 ? 18 : years >= 2 ? 16 : years >= 1 ? 12 : years > 0 ? 6 : 8, 20,
      years > 0 ? `~${years} saal ka tenure approx.` : 'Tenure estimate nahi hua.',
      years < 2 ? 'Har role ki exact dates daalo — short tenures bhi with reasons.' : 'Tenure clear rakho.'),
    crit('exp.quantified', 'Experience me metric bullets', clamp(20 * metricFrac * 1.25), 20,
      metricFrac >= 0.6 ? 'Experience me achieved-results dikhte hain.' : 'Experience me achievements number ke bina — impact weak.',
      'Har role me 2-3 achieved-metrics bullets ("reduced downtime 40%").'),
  ];

  const skills = [
    crit('skills.present', 'Skills section present', hasSkills ? 18 : 0, 18,
      hasSkills ? 'Skills section mili.' : 'Skills section nahi mili.',
      'SKILLS section apni category-wise rakho.'),
    crit('skills.count', 'Enough distinct tech skills (5+)', matched.length >= 6 ? 14 : matched.length >= 3 ? 9 : matched.length >= 1 ? 4 : 0, 14,
      matched.length >= 6 ? `${matched.length} tech terms detected.` : `Sirf ${matched.length} tech term mila.`,
      '5-15 relevant skills (Languages/Frameworks/Tools/Databases).'),
    crit('skills.cat', 'Skills categorized (languages:)', catOk ? 12 : 0, 12,
      catOk ? 'Category labels mile (Languages:/Frameworks:...).' : 'Skills plain list me hain — categories nahi.',
      '"Languages: JavaScript, TypeScript | Frameworks: React, Node" format use karo.'),
    crit('skills.alignment', `${kwSource === 'jd' ? 'JD' : 'Role'} keywords ka overlap`, Math.round(56 * (1 - Math.exp(-kwFrac * 3.5))), 56,
      kwSource === 'jd' ? `${matched.length}/${dict.length} JD-keywords mile. Missing: ${dict.slice(0, 8).filter((w) => !matched.includes(w)).join(', ') || '—'}.` : `${matched.length}/${dict.length} standard IT keywords mile — target JD paste karo to exact alignment dikhe.`,
      kwSource === 'jd' ? 'JD ke exact buzzwords (skills+tools+jargon) ki spellings use karo.' : 'Target JD do taaki real keyword-match bane.'),
  ];

  return { impact, action, format, experience, skills };
}

function dimScore(group) {
  const sum = group.reduce((a, c) => a + c.score, 0);
  const max = group.reduce((a, c) => a + c.max, 0) || 1;
  return Math.min(96, Math.round((100 * sum) / max));
}

function topDeductions(criteria) {
  return criteria
    .filter((c) => c.score < c.max)
    .map((c) => ({ ...c, gap: 1 - c.score / c.max }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 3)
    .map((c) => ({ key: c.key, label: c.label, advice: c.advice }));
}

function fallbackCritique({ atsScore, verdict, breakdown, heuristics, bullets, criteria }) {
  const strengths = [];
  const negatives = [];
  if (heuristics.strongVerbs > 3) strengths.push('Kai bullets strong action verbs se shuru — good.');
  if (heuristics.quantifiedBullets >= 3) strengths.push('Real numbers present — impact dikh raha hai.');
  if (heuristics.hasEmail && heuristics.hasPhone) strengths.push('Contact info complete hai.');
  if (heuristics.sectionsDetected.length >= 4) strengths.push('Standard ATS sections present hain.');
  if (heuristics.metricFrac >= 40) strengths.push(`${heuristics.metricFrac}% bullets me metrics hain — data-backed.`);

  if (heuristics.quantifiedBullets < 3) negatives.push(`Sirf ${heuristics.quantifiedBullets} bullets me metrics — results quantify karo.`);
  if (heuristics.weakVerbs > 2) negatives.push(`Weak opening verbs (${heuristics.weakVerbs}) impact kam kar rahe hain.`);
  if (!heuristics.hasEmail) negatives.push('Email missing.');
  if (!heuristics.hasPhone) negatives.push('Phone missing.');
  if (heuristics.missingSections && heuristics.missingSections.length) negatives.push(`Missing sections: ${heuristics.missingSections.join(', ')}.`);
  if (!(heuristics.social && (heuristics.social.github || heuristics.social.linkedin))) negatives.push('GitHub/LinkedIn link nahi mila.');
  if (heuristics.trailingPeriods > 0) negatives.push('Bullets "." se khatam ho rahi hain.');

  const sec = (heuristics.sectionsDetected || []).map((s) => ({
    section: s,
    verdict: s === 'Experience' ? (heuristics.quantifiedBullets >= 3 ? 'ok' : 'weak') : heuristics.metricFrac >= 40 ? 'ok' : 'ok',
    whatWorks: [s + ' section exist karti hai.'],
    whatToImprove: s === 'Experience' ? ['Har role ke liye 2-3 quantified result bullets.'] : ['Content ko aur result-oriented/specific banao.'],
  }));
  const weakest = Object.entries(breakdown).reduce((a, b) => (b[1] < a[1] ? b : a))[0];

  const deductions = topDeductions(criteria || []);
  const potential = Math.min(100, Math.round(atsScore + deductions.reduce((s, d) => s + (100 - atsScore) * 0.12, 0)));

  return {
    executiveSummary: `ATS score ${atsScore}/100 (${verdict}). Sabse kamzor dimension: ${weakest}. Score ko rokenewale top-3: ${deductions.map((d) => d.label).join(', ') || '—'}.`,
    contentQuality: 'AI critique timeout ke baad deterministic analysis diya — numbers/verbs/filler/tenure checks based. Exact content-review ke liye dobara run karo.',
    strengths: strengths.length ? strengths : ['Resume submit hua — ab improvements par focus karo.'],
    criticalNegatives: negatives.length ? negatives : ['Koi critical negative nahi mila.'],
    atsKeywordsFound: (heuristics.skillMatch ? heuristics.skillMatch.matched : []).slice(0, 12),
    missingRecommendedKeywords: (heuristics.skillMatch && heuristics.skillMatch.source === 'jd' && heuristics.skillMatch.matched.length < heuristics.skillMatch.total) ? (heuristics.skillMatch.matched.length ? (heuristics.skillMatch.dictMissing || []) : []) : [],
    bulletImprovements: [],
    actionPlan: [
      `Sabse weak dimension fix karo: ${weakest}.`,
      heuristics.quantifiedBullets < 3 ? 'Har impact bullet me number add karo.' : 'Metrics wali depth aur badhao.',
      !heuristics.hasEmail ? 'Email + phone + location top me add karo.' : 'Contact section verify karo.',
      '1 page / consistent formatting + standard section headers.',
    ],
    sectionReview: sec,
    grades: {
      impactAndMetrics: gradeOf(breakdown.impactAndMetrics),
      actionVerbs: gradeOf(breakdown.actionVerbs),
      formattingAndClarity: gradeOf(breakdown.formattingAndClarity),
      experienceDepth: gradeOf(breakdown.experienceDepth),
      skillsRelevance: gradeOf(breakdown.skillsRelevance),
    },
    topDeductions: deductions,
    potentialScore: potential,
  };
}

async function critiqueResume({ resumeText, targetJobDescription, atsScore, breakdown, verdict, heuristics, bullets }) {
  const sys = `You are a ruthless resume/ATS auditor in the style of Hiration depth. You only judge what is literally in the resume text — never invent facts. Output STRICT JSON only, no prose, no markdown fences. Keys:
{
 "executiveSummary": "2-3 sentences, realistic verdict on this resume",
 "contentQuality": "2-3 sentences: is the substance meaningful (results, scope, specifics), or just generic duties — is what is written WORTH keeping?",
 "strengths": ["..."],
 "criticalNegatives": ["..."],
 "atsKeywordsFound": ["only keywords literally present in the text"],
 "missingRecommendedKeywords": ["only if a target JD was given; keywords from JD missing in text; else []"],
 "bulletImprovements": [{"original": "exact bullet copied verbatim from resume", "improved": "rewritten with strong verb + metric + result"}],
 "actionPlan": ["4 numbered, concrete steps"],
 "sectionReview": [{"section":"SectionName","verdict":"strong|ok|weak","whatWorks":["..."],"whatToImprove":["..."]}]
}
Constraints: bulletImprovements MUST reference existing bullets; max 6 sectionReview entries; keep JSON valid (escape quotes).`;
  const usr = [
    `ATS score (deterministic, machine-computed): ${atsScore}/100 — verdict: ${verdict}.`,
    `Breakdown: impact=${breakdown.impactAndMetrics}, action=${breakdown.actionVerbs}, format=${breakdown.formattingAndClarity}, experience=${breakdown.experienceDepth}, skills=${breakdown.skillsRelevance}.`,
    `Heuristics: totalBullets=${heuristics.totalBullets}, quantified=${heuristics.quantifiedBullets}, strongVerbs=${heuristics.strongVerbs}, weakVerbs=${heuristics.weakVerbs}, fillerBullets=${heuristics.fillerBullets}, trailingPeriods=${heuristics.trailingPeriods}, email=${heuristics.hasEmail}, phone=${heuristics.hasPhone}, totalYears=${heuristics.totalYears ?? '?'}, missingSections=${(heuristics.missingSections || []).join(', ') || 'none'}, social=${JSON.stringify(heuristics.social || {})}, sections=${(heuristics.sectionsDetected || []).join(', ')}, keywordMatch=${JSON.stringify(heuristics.skillMatch || {})}.`,
    targetJobDescription ? `TARGET JD:\n${targetJobDescription}\n\n` : 'No target JD given — judge vs a strong general SWE/fresher resume.\n\n',
    `RESUME TEXT:\n${resumeText.slice(0, 14000)}`,
  ].join('\n');
  const raw = await callLLM({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ],
    role: 'research',
    hint: CRIT_MODEL,
    model: CRIT_MODEL,
    preferOpenRouter: true,
    temperature: 0.2,
    max_tokens: 3000,
  });
  let parsed;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const inner = raw.content ?? raw.text ?? raw.result ?? (raw.choices && raw.choices[0] && (raw.choices[0].message && raw.choices[0].message.content));
    if (typeof inner === 'string') {
      const m = inner.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : inner);
    } else {
      try { parsed = JSON.parse(JSON.stringify(raw)); } catch { parsed = {}; }
    }
  } else {
    const str = String(raw || '');
    const m = str.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : str);
  }
  return {
    executiveSummary: String(parsed.executiveSummary || ''),
    contentQuality: String(parsed.contentQuality || ''),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 6).map(String) : [],
    criticalNegatives: Array.isArray(parsed.criticalNegatives) ? parsed.criticalNegatives.slice(0, 6).map(String) : [],
    atsKeywordsFound: Array.isArray(parsed.atsKeywordsFound) ? parsed.atsKeywordsFound.slice(0, 30).map(String) : [],
    missingRecommendedKeywords: Array.isArray(parsed.missingRecommendedKeywords) ? parsed.missingRecommendedKeywords.slice(0, 15).map(String) : [],
    bulletImprovements: Array.isArray(parsed.bulletImprovements) ? parsed.bulletImprovements.slice(0, 4).map((b) => ({ original: String(b.original || ''), improved: String(b.improved || '') })).filter((b) => b.original && b.improved) : [],
    actionPlan: Array.isArray(parsed.actionPlan) ? parsed.actionPlan.slice(0, 6).map(String) : [],
    sectionReview: Array.isArray(parsed.sectionReview) ? parsed.sectionReview.slice(0, 6).map((s) => ({
      section: String(s.section || ''),
      verdict: ['strong', 'ok', 'weak'].includes(String(s.verdict || '')) ? String(s.verdict) : 'ok',
      whatWorks: Array.isArray(s.whatWorks) ? s.whatWorks.map(String) : [],
      whatToImprove: Array.isArray(s.whatToImprove) ? s.whatToImprove.map(String) : [],
    })) : [],
  };
}

function buildHeuristics({ bullets, sections, hasEmailV, hasPhoneV, hasLocV, kv }) {
  const h = {
    totalBullets: bullets.length,
    quantifiedBullets: 0,
    strongVerbs: 0,
    weakVerbs: 0,
    trailingPeriods: 0,
    fillerBullets: 0,
    metricFrac: 0,
    hasEmail: hasEmailV,
    hasPhone: hasPhoneV,
    hasLocation: hasLocV,
    sectionsDetected: sections,
    skillMatch: kv,
    links: [],
    missingSections: [],
    totalYears: 0,
    social: { github: false, linkedin: false, portfolio: false },
    summaryPresent: false,
    places: 0,
  };
  return h;
}

async function auditResume({ resumeText, targetJobDescription = '', pageCount = null, fileName = '', extraUrls = [] } = {}) {
  const text = String(resumeText || '').trim();
  if (text.length < 50) throw new Error(`Resume text too short (${text.length} chars) — minimum 50 characters needed to audit.`);
  const jd = String(targetJobDescription || '').trim();
  const foundUrls = collectUrls(text, extraUrls);

  const bullets = extractBullets(text);
  const sections = detectSections(text);
  const h0 = buildHeuristics({
    bullets, sections,
    hasEmailV: hasEmail(text),
    hasPhoneV: hasPhone(text),
    hasLocV: hasLocation(text),
    kv: { matched: [], total: 0, source: 'pending' },
  });

  const links = await checkLinks(foundUrls);
  h0.links = links;

  const groups = buildCriteriaGroups({ text, bullets, sections, jd, heuristics: h0, pageCount, urls: foundUrls });
  const breakdown = {
    impactAndMetrics: dimScore(groups.impact),
    actionVerbs: dimScore(groups.action),
    formattingAndClarity: dimScore(groups.format),
    experienceDepth: dimScore(groups.experience),
    skillsRelevance: dimScore(groups.skills),
  };
  const atsBaseScore = clamp(0.25 * breakdown.impactAndMetrics + 0.20 * breakdown.actionVerbs + 0.15 * breakdown.formattingAndClarity + 0.15 * breakdown.experienceDepth + 0.25 * breakdown.skillsRelevance);
  const atsScore = atsBaseScore > 87 ? Math.round(atsBaseScore - (atsBaseScore - 87) * 0.6) : atsBaseScore;
  const verdict = atsScore >= 80 ? 'ATS-Ready' : atsScore >= 65 ? 'Strong Contender' : atsScore >= 50 ? 'Needs Polish' : 'High Risk';

  const criteria = [...groups.impact, ...groups.action, ...groups.format, ...groups.experience, ...groups.skills];
  const deductions = topDeductions(criteria);
  const grades = {
    impactAndMetrics: gradeOf(breakdown.impactAndMetrics),
    actionVerbs: gradeOf(breakdown.actionVerbs),
    formattingAndClarity: gradeOf(breakdown.formattingAndClarity),
    experienceDepth: gradeOf(breakdown.experienceDepth),
    skillsRelevance: gradeOf(breakdown.skillsRelevance),
  };
  const potentialScore = Math.min(100, Math.round(atsScore + deductions.reduce((s, d) => s + (100 - atsScore) * 0.12, 0)));

  let ai = null;
  try {
    ai = await withTimeout(critiqueResume({ resumeText: text, targetJobDescription: jd, atsScore, breakdown, verdict, heuristics: h0, bullets }), LLM_TIMEOUT_MS);
  } catch (e) {
    console.warn('[resume] AI critique fail -> deterministic fallback:', e.message);
    ai = fallbackCritique({ atsScore, verdict, breakdown, heuristics: h0, bullets, criteria });
  }

  return {
    atsScore,
    verdict,
    jdUsed: jd,
    pageCount: pageCount != null ? pageCount : null,
    breakdown,
    grades,
    topDeductions: deductions,
    potentialScore,
    criteria,
    links,
    heuristics: {
      totalBullets: h0.totalBullets,
      quantifiedBullets: h0.quantifiedBullets,
      strongVerbs: h0.strongVerbs,
      weakVerbs: h0.weakVerbs,
      fillerBullets: h0.fillerBullets,
      trailingPeriods: h0.trailingPeriods,
      metricFrac: h0.metricFrac,
      totalYears: h0.totalYears,
      missingSections: h0.missingSections,
      social: h0.social,
      hasEmail: h0.hasEmail,
      hasPhone: h0.hasPhone,
      hasLocation: h0.hasLocation,
      sectionsDetected: h0.sectionsDetected,
      skillMatch: h0.skillMatch,
    },
    ...ai,
  };
}

async function auditResumeBuffer(fileBuffer, originalName, targetJobDescription = '') {
  const { text, pageCount } = await extractText(fileBuffer, originalName);
  const audit = await auditResume({ resumeText: text, targetJobDescription, pageCount, fileName: originalName, extraUrls: extractPdfUris(fileBuffer) });
  return { audit, fileName: originalName, charCount: text.length, pageCount: pageCount != null ? pageCount : null };
}

/* ── ATS Report PDF ──────────────────────────────────────── */
function buildAuditReportPdf(audit, resumeName = 'resume') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 88;
    let y = 44;
    const ensure = (h) => { if (y + h > doc.page.height - 40) { doc.addPage(); y = 44; } };
    const tone = audit.atsScore >= 85 ? '#16a34a' : audit.atsScore >= 70 ? '#d97706' : '#dc2626';

    doc.font('Helvetica-Bold').fontSize(17).fillColor('#111827').text('ATS Resume Audit Report', 44, y, { width: W });
    y += 22;
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(`${resumeName || 'resume'}  •  ${new Date().toLocaleString()}${audit.pageCount != null ? '  •  ' + audit.pageCount + ' page(s)' : ''}${audit.heuristics && audit.heuristics.totalYears ? '  •  ~' + audit.heuristics.totalYears + 'y tenure' : ''}`, 44, y, { width: W });
    y += 16;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(tone).text(`SCORE: ${audit.atsScore}/100 (Grade ${audit.grades ? (audit.grades.impactAndMetrics + audit.grades.actionVerbs + audit.grades.formattingAndClarity + audit.grades.experienceDepth + audit.grades.skillsRelevance).slice(0, 1) : '?'}) — ${audit.verdict}`, 44, y, { width: W });
    y += 20;

    const dims = [['Impact & Metrics', audit.breakdown.impactAndMetrics, audit.grades && audit.grades.impactAndMetrics], ['Action Verbs', audit.breakdown.actionVerbs, audit.grades && audit.grades.actionVerbs], ['Formatting & Clarity', audit.breakdown.formattingAndClarity, audit.grades && audit.grades.formattingAndClarity], ['Experience Depth', audit.breakdown.experienceDepth, audit.grades && audit.grades.experienceDepth], ['Skills Relevance', audit.breakdown.skillsRelevance, audit.grades && audit.grades.skillsRelevance]];
    for (const [label, val, g] of dims) {
      ensure(18);
      doc.font('Helvetica').fontSize(9).fillColor('#374151').text(`${label}  ${val}/100  (${g || '?'})`, 44, y, { width: W });
      y += 12;
      doc.rect(44, y, W, 5).fill('#e5e7eb');
      doc.rect(44, y, Math.max(1, Math.min(W, (W * val) / 100)), 5).fill(tone);
      y += 10;
    }
    if (audit.potentialScore != null) {
      ensure(14);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#4f46e5').text(`Improvement potential: ~${audit.potentialScore}/100 (top-${(audit.topDeductions || []).length} deductions fix karne par)`, 44, y, { width: W });
      y += 14;
    }
    y += 4;

    const critText = audit.criteria.slice(0, 16).map((c) => `${c.label}: ${c.score}/${c.max} ${c.status.toUpperCase()}. ${c.why}`).join('\n');
    if (critText) {
      ensure(24);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Per-Criteria Breakdown', 44, y, { width: W });
      y += 14;
      ensure(critText.length / 3);
      doc.font('Helvetica').fontSize(8).fillColor('#374151').text(critText, 44, y, { width: W, lineGap: 4 });
      y = doc.y + 10;
    }

    if (audit.topDeductions && audit.topDeductions.length) {
      ensure(14);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#b45309').text('Top Deductions — kya result cheer raha hai', 44, y, { width: W });
      y += 14;
      ensure(14);
      doc.font('Helvetica').fontSize(8.5).fillColor('#92400e').text(audit.topDeductions.map((d, i) => `${i + 1}. ${d.label}: ${d.advice}`).join('\n'), 44, y, { width: W, lineGap: 3 });
      y = doc.y + 8;
    }

    const execText = audit.executiveSummary || '';
    if (execText) {
      ensure(16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Executive Summary', 44, y, { width: W });
      y += 14;
      ensure(14);
      doc.font('Helvetica').fontSize(9).fillColor('#374151').text(execText, 44, y, { width: W });
      y = doc.y + 8;
    }
    const cq = audit.contentQuality || '';
    if (cq) {
      ensure(14);
      doc.font('Helvetica').fontSize(9).fillColor('#374151').text(cq, 44, y, { width: W });
      y = doc.y + 8;
    }

    if (audit.strengths && audit.strengths.length) {
      ensure(16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#16a34a').text('Strengths', 44, y, { width: W });
      y += 14;
      ensure(14);
      doc.font('Helvetica').fontSize(8.5).fillColor('#166534').text(audit.strengths.map((s) => '• ' + s).join('\n'), 44, y, { width: W, lineGap: 3 });
      y = doc.y + 8;
    }
    if (audit.criticalNegatives && audit.criticalNegatives.length) {
      ensure(16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#dc2626').text('Critical Negatives', 44, y, { width: W });
      y += 14;
      ensure(14);
      doc.font('Helvetica').fontSize(8.5).fillColor('#991b1b').text(audit.criticalNegatives.map((n) => '• ' + n).join('\n'), 44, y, { width: W, lineGap: 3 });
      y = doc.y + 8;
    }

    if (audit.sectionReview && audit.sectionReview.length) {
      ensure(16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Section-by-Section Review', 44, y, { width: W });
      y += 14;
      for (const s of audit.sectionReview.slice(0, 5)) {
        ensure(16);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text(`${s.section || ''} (${s.verdict || 'ok'})`, 44, y, { width: W });
        y = doc.y + 4;
        ensure(12);
        doc.font('Helvetica').fontSize(8).fillColor('#374151').text([...(s.whatWorks || []).map((w) => '  ✓ ' + w), ...(s.whatToImprove || []).map((w) => '  ✗ ' + w)].join('\n'), 44, y, { width: W, lineGap: 2 });
        y = doc.y + 5;
      }
    }

    if (audit.links && audit.links.length) {
      ensure(12);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text('Link Status: ' + audit.links.map((l) => `${l.status} (${l.url})`).join('  |  '), 44, y, { width: W });
      y = doc.y + 8;
    }

    if (audit.bulletImprovements && audit.bulletImprovements.length) {
      ensure(16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Bullet Rewrites', 44, y, { width: W });
      y += 14;
      for (const b of audit.bulletImprovements.slice(0, 3)) {
        ensure(18);
        doc.font('Helvetica').fontSize(8).fillColor('#9ca3af').text('- ' + (b.original || ''), 44, y, { width: W });
        y = doc.y + 3;
        ensure(14);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#16a34a').text('+ ' + (b.improved || ''), 44, y, { width: W });
        y = doc.y + 5;
      }
    }

    if (audit.actionPlan && audit.actionPlan.length) {
      ensure(16);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Action Plan', 44, y, { width: W });
      y += 14;
      ensure(14);
      doc.font('Helvetica').fontSize(8.5).fillColor('#374151').text(audit.actionPlan.map((a, i) => `${i + 1}. ${a}`).join('\n'), 44, y, { width: W, lineGap: 3 });
    }

    doc.end();
  });
}

module.exports = { auditResume, auditResumeBuffer, buildAuditReportPdf };