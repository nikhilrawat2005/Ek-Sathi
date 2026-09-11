// ---------------------------------------------------------------------------
// Ek Sathi — GitHub & Website Study API
//   POST /api/study/github           { url|text }  → analyze a GitHub repo (tree, README, key source files)
//   POST /api/study/github/ask       { url|text, question } → Q&A on the analyzed repo (no LLM key)
//   GET  /api/study/github/search    ?q=&limit=    → search public repos by keyword/topic
//   GET  /api/study/github/user      ?username=    → public user profile + their public repos
//   POST /api/study/website          { url }       → decode a PUBLIC website (stack, structure, SEO, scripts)
//   POST /api/study/website/ask      { url, question } → Q&A on the decoded website (no LLM key)
//
// Nothing here requires an LLM key: GitHub is the REST API, websites are fetched
// and decoded server-side over HTTPS only (public, processable content).
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const repo = require('../services/repoService');
const crawler = require('../services/crawlerService');

// POST /api/study/github { url | text }
router.post('/github', requireAuth, async (req, res) => {
  try {
    const input = req.body && req.body.url ? String(req.body.url) : (req.body && req.body.text ? String(req.body.text) : '');
    if (!input.trim()) return res.status(400).json({ error: 'Provide a GitHub repo URL or "owner/repo" text.' });
    const result = await repo.analyzeRepo(input);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/study/github/ask { url|text, question } → interactive Q&A on the repo
router.post('/github/ask', requireAuth, async (req, res) => {
  try {
    const input = req.body && req.body.url ? String(req.body.url) : (req.body && req.body.text ? String(req.body.text) : '');
    const question = String((req.body && req.body.question) || '').trim();
    if (!input.trim()) return res.status(400).json({ error: 'Provide a GitHub repo URL or "owner/repo" text.' });
    if (!question) return res.status(400).json({ error: 'Sawaal likho (question required).' });
    const analysis = await repo.analyzeRepo(input);
    if (analysis.status !== 'ok') {
      return res.status(200).json({ status: analysis.status, message: analysis.message || 'Repo analyze nahi ho paya.' });
    }
    const { answer } = repo.answerRepoQuestion(analysis, question);
    res.json({ status: 'ok', question, repo: analysis.repo, answer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/study/github/search?q=react+ai&limit=5
router.get('/github/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Search query required (?q=...)' });
    const result = await repo.searchRepos(q, req.query.limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/study/github/user?username=nikhilrawat2005
router.get('/github/user', requireAuth, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username required (?username=...)' });
    const [profile, repos] = await Promise.all([
      repo.getUserProfile(username),
      repo.listUserRepos(username, req.query.limit),
    ]);
    res.json({ profile, repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/study/github/profile?username=X → DEEP profile scan: ALL repos,
// commit counts, README summaries + combined overview box data (~70000 char budget)
router.get('/github/profile', requireAuth, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Username or profile link required (?username=...)' });
    const result = await repo.getUserProfileFull(username, { capRepos: req.query.cap });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/study/github/explain { url|text } → full LLM explanation for a repo card
router.post('/github/explain', requireAuth, async (req, res) => {
  try {
    const input = req.body && req.body.url ? String(req.body.url) : (req.body && req.body.text ? String(req.body.text) : '');
    if (!input.trim()) return res.status(400).json({ error: 'Provide a GitHub repo URL or "owner/repo" text.' });
    const analysis = await repo.analyzeRepo(input);
    if (analysis.status !== 'ok') {
      return res.status(200).json({ status: analysis.status, message: analysis.message || 'Repo analyze nahi ho paya.' });
    }
    const explained = await repo.explainRepo(analysis);
    res.json({ status: 'ok', repo: analysis.repo, explanation: explained.explanation || '', readCount: analysis.readCount || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/study/website { url }
router.post('/website', requireAuth, async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: 'URL is required.' });
    const decode = await crawler.scrapeURL(url, { inspectArchitecture: true });
    res.json({ status: 'ok', decode });
  } catch (err) {
    res.status(500).json({ error: err.message, hint: 'Only public http(s) URLs are allowed.' });
  }
});

// POST /api/study/website/ask { url, question } → Q&A from decoded website content
router.post('/website/ask', requireAuth, async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    const question = String((req.body && req.body.question) || '').trim();
    if (!url) return res.status(400).json({ error: 'URL is required.' });
    if (!question) return res.status(400).json({ error: 'Sawaal likho (question required).' });
    const decode = await crawler.scrapeURL(url, { inspectArchitecture: true });
    const answer = answerSiteQuestion(decode, question);
    res.json({ status: 'ok', question, url: decode.url, answer });
  } catch (err) {
    res.status(500).json({ error: err.message, hint: 'Only public http(s) URLs are allowed.' });
  }
});

// ── Website Q&A (deterministic, no LLM key) ─────────────────
const SITE_STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'and', 'or', 'for', 'in', 'on', 'this', 'that', 'of', 'to', 'about', 'what', 'how', 'which', 'site', 'website', 'webpage', 'page', 'tell', 'explain', 'will', 'its', 'it', 'with', 'as', 'at', 'by', 'does', 'do', 'me']);

function siteTokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+#.\-]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !SITE_STOP.has(t));
}

function answerSiteQuestion(decode, question) {
  const q = String(question || '').toLowerCase().trim();
  const arch = (decode && decode.architecture) || {};
  const out = [];

  const has = (...re) => re.some(r => r.test(q));

  if (has(/tech|stack|framework|built|language|library|backend|frontend/)) {
    out.push('## 🧰 Tech Stack (decoded)');
    out.push(`**Frameworks:** ${(arch.framework || []).length ? arch.framework.join(', ') : 'koi specific framework detect nahi hua'}`);
    out.push(`**Styling:** ${(arch.styling || []).length ? arch.styling.join(', ') : 'n/a'}`);
    out.push(`**Libraries:** ${(arch.libraries || []).length ? arch.libraries.join(', ') : 'n/a'}`);
    if (arch.meta && Object.keys(arch.meta).length) out.push('\n**Meta hints:** ' + Object.keys(arch.meta).map(k => `${k}=${arch.meta[k]}`).slice(0, 8).join(', '));
    if (decode.hiddenData) {
      const hd = decode.hiddenData;
      const parts = [];
      if (hd.nextData) parts.push('Next.js __NEXT_DATA__');
      if (hd.nuxtData) parts.push('Nuxt __NUXT__');
      if (hd.inlineState) parts.push('inline state/SSR data');
      if (parts.length) out.push('\n**SSR/state hints:** ' + parts.join(', '));
    }
  } else if (has(/what.*(site|website|about|do)/, /ye (site|kya)/, /overview/, /purpose/, /kaam/)) {
    out.push('## 🎯 Site Overview');
    out.push(`**Title:** ${decode.title || 'n/a'}`);
    out.push(decode.description ? `**Description:** ${decode.description}` : '_Meta description nahi mila._');
    if ((decode.headings || []).length) {
      out.push('\n**Page headings samajhne ke liye:**');
      decode.headings.slice(0, 12).forEach(h => out.push(`- H${h.tag} — ${h.text}`));
    }
  }

  if (has(/structure|section|navigation|layout|head/, /layout/)) {
    out.push('## 🧱 Page Structure');
    const headings = decode.headings || [];
    if (headings.length) {
      out.push('**Found ' + headings.length + ' headings** — page ka outline:');
      headings.slice(0, 20).forEach(h => out.push(`- H${h.tag}: ${h.text}`));
    } else {
      out.push('Koi heading tag detect nahi hua (ho sakta hai JS-rendered page ho).');
    }
    out.push('\n**Links found on page:** ' + ((decode.links || []).length) + ' (first few:)');
    (decode.links || []).slice(0, 10).forEach(l => out.push(`- ${l.text || l.url} → ${l.url}`));
  }

  if (has(/seo|meta|og|twitter|descri/) || /description/.test(q)) {
    out.push('## 🔍 SEO / Meta');
    out.push(`**Title:** ${decode.title || 'n/a'}`);
    out.push(`**Description:** ${decode.description || 'n/a'}`);
    out.push(`**Has structured data (JSON-LD):** ${decode.jsonLd && decode.jsonLd.length ? decode.jsonLd.length + ' blocks' : 'no'}`);
  }

  // Generic keyword fallback over visible content + headings (only if no intent matched).
  if (!out.length) {
    const terms = siteTokenize(q);
    const haystackText = (decode.contentSnippet || '') + '\n' + (decode.headings || []).map(h => h.text).join('\n');
    const lower = haystackText.toLowerCase();
    const found = terms.filter(t => lower.includes(t));
    out.push(`## 🔎 "${question}" — content search`);
    if (found.length) {
      out.push('**Milne wale keywords:** ' + found.join(', '));
      const snippet = decode.contentSnippet || '';
      if (snippet) out.push('\n**Page ka content (snippet):**\n\n' + snippet.slice(0, 1500));
    } else {
      out.push('Eska answer is page ke content me nahi mila. Page sirf ' + ((decode.contentSnippet || '').length || 0) + ' chars ka text content dikha raha hai.');
    }
  }

  out.push('\n---\n_Note: sirf PUBLIC content analyse hua hai — private APIs, forms ya login-required data access nahi hote._');
  return out.join('\n');
}

module.exports = router;