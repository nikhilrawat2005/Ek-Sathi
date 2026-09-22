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

// Match a keyword only when it appears as a whole term, so "java" never matches
// "javascript" (it starts inside the word). Leading \b handled separately; the
// trailing guard is a negative word-char lookahead so that terms ending in a
// non-word char like "c++" or "c#" still match.
function kwPattern(w) {
  const esc = String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim().replace(/\s+/g, '[\\s\\-–—]+');
  return new RegExp(`\\b${esc}(?![a-z0-9])`, 'i');
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
    if (isNonBulletMetadata(bare)) continue;
    out.push(bare);
  }
  return out;
}

// Contact, date-range and label metadata lines are NOT bullets — when counted
// they skew the metric/verb ratios and the total-bullet number. Keep the bullet
// pool strictly to content lines that describe actual work.
function isNonBulletMetadata(line) {
  const t = String(line || '').trim();
  if (!t || /^https?:\/\//i.test(t)) return true;
  if (hasEmail(t) || hasPhone(t)) return true;
  if (/^(?:phone|mobile|email|mail|address|location|linkedin|github|portfolio|website)\s*[:.]/i.test(t)) return true;
  if (/^\s*(?:[a-z]{3,12}\.?\s?\d{1,2},?\s)?\d{4}\s*[-–—]\s*(?:present|current|\d{4}|[a-z]{3,12}\.?\s?\d{1,2},?\s\d{4})\s*$/i.test(t)) return true;
  if (/^[\d\s.v+\-–—(),/:@#|•.]+$/i.test(t) && /\d/.test(t) && t.length <= 45) return true;
  return false;
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
  const spec = bullets.filter((b) => GENERIC_KEYWORDS.some((k) => kwPattern(k).test(b))).length;
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
    matched = dict.filter((w) => kwPattern(w).test(text));
  } else {
    kwSource = 'generic';
    dict = GENERIC_KEYWORDS;
    matched = dict.filter((w) => kwPattern(w).test(text));
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
    crit('impact.quantified', 'Bullets with metrics (numbers/%)', clamp(100 * (0.08 + 1.5 * metricFrac)), 34,
      metricFrac >= 0.5 ? `Strong: ${quantified}/${bullets.length} bullets contain real numbers/percentages (${Math.round(metricFrac * 100)}%).` : (quantified ? `Only ${Math.round(metricFrac * 100)}% of bullets contain metrics — the rest are plain statements.` : 'No bullet contains a number or percentage — recruiters need visible proof of impact.'),
      '"Improved load time by 45%", "Handled 1k+ users", "Cut cost from ₹X to ₹Y" — add a number to every impact line.'),
    crit('impact.specificity', 'Concrete tech/domain keywords in bullets', clamp(100 * specFrac * 1.2), 33,
      specFrac > 0.4 ? `${Math.round(specFrac * 100)}% of bullets mention concrete technology or products.` : `Too few bullets (${Math.round(specFrac * 100)}%) name something specific — the profile reads generic.`,
      'Use exact nouns such as React, AWS, dashboard or specific APIs — not just "worked with tools".'),
    crit('impact.fillers', 'No filler phrases (responsible for / helped...)', clamp(100 - 110 * fillerFrac), 33,
      filler.length ? `${filler.length} bullet(s) rely on weak filler phrasing — substance beyond "what was done" is missing.` : 'No boring filler phrases found.',
      'Cut the filler and state the scope plus the result — stay concrete.'),
  ];

  const action = [
crit('action.strongLead', 'Bullets start with a strong action verb', Math.min(60, Math.round(100 * strongFrac / 0.8)), 60,
      strongFrac >= 0.7 ? `${Math.round(strongFrac * 100)}% of bullets start with strong verbs — outstanding.` : (strongFrac > 0 ? `Only ${Math.round(strongFrac * 100)}% of bullets start with a strong verb.` : 'No bullet starts with a strong verb (they begin with a noun, "I" or a pronoun).'),
      'Start every bullet with Built, Designed, Automated, Optimized, Launched, Led...'),
    crit('action.weakLead', 'Weak opening verbs avoided (Contributed to...)', clamp(100 - 130 * weakFrac), 25,
      weakFrac > 0.2 ? `${Math.round(weakFrac * 100)}% of bullets start with weak verbs — impact is being dampened.` : (weakLead ? `${weakLead} bullet(s) start with weak verbs.` : 'No weak opening verbs found.'),
      'Replace "Worked on X" with "Shipped/Built X" — the same work reads twice as strong.'),
    crit('action.verbMix', 'Strong : weak verb ratio', (strongLead || weakLead) ? clamp(100 * (strongLead / (strongLead + weakLead))) : 25, 15,
      (strongLead || weakLead) ? `Strong:weak = ${strongLead}:${weakLead}.` : 'No action verbs detected at all.',
      'Raise strong verbs to ≥ 80% of bullets; take weak verbs to zero.'),
  ];

  const format = [
    crit('format.sections', 'Standard ATS sections found', secCount >= 5 ? 15 : secCount === 4 ? 12 : secCount === 3 ? 8 : secCount === 2 ? 5 : 0, 15,
      secCount > 0 ? `${secCount} standard sections found. Missing: ${heuristics.missingSections.length ? heuristics.missingSections.join(', ') : '—'}.` : 'No standard section headers found.',
      'Use standard headers: SKILLS, EXPERIENCE, PROJECTS, EDUCATION, SUMMARY.'),
    crit('format.email', 'Contact email present', hasEmail(text) ? 12 : 0, 12,
      hasEmail(text) ? 'Email found.' : 'Email NOT found!',
      'Place a clear email at the top.'),
    crit('format.phone', 'Phone number present', hasPhone(text) ? 10 : 0, 10,
      hasPhone(text) ? 'Phone found.' : 'Phone NOT found.',
      'Use the format +91-XXXXXXXXXX.'),
    crit('format.location', 'Location/city present', hasLocation(text) ? 6 : 0, 6,
      hasLocation(text) ? 'Location present.' : 'Location not visible.',
      'Add City, Country (ATS location filter).'),
    crit('format.links', 'Social/profile links (GitHub/LinkedIn)', hosts.github || hosts.linkedin ? 12 : (hosts.portfolio ? 7 : 0), 12,
      (hosts.github || hosts.linkedin) ? 'GitHub/LinkedIn link found — professional.' : (hosts.portfolio ? 'Only a portfolio link found — GitHub/LinkedIn also needed.' : 'No GitHub/LinkedIn link found.'),
      'Add working LinkedIn + GitHub links (their status is verified below).'),
    crit('format.periods', 'No trailing "." on bullets', clamp(12 - 11 * trailFrac), 12,
      trailFrac > 0.2 ? `${Math.round(trailFrac * 100)}% of bullets end with "." — outdated/ATS-hostile.` : 'Bullet endings are ATS-friendly.',
      'Do not end bullets with a sentence period (dots in abbreviations are fine).'),
    crit('format.headers', 'Consistent casing of section headers', headOk ? 10 : 4, 10,
      headOk ? 'Headers use consistent uppercase/title-case.' : 'Headers mix title/ALL-CAPS/lowercase — parsing risk.',
      'Use one style for every header: SKILLS, EXPERIENCE, ...'),
    crit('format.places', 'No placeholder/junk text', clamp(10 - 4 * places), 10,
      places ? `${places} placeholder term(s) found (${PLACEHOLDER_TERMS.slice(0, 3).join(', ')}...).` : 'No placeholder junk found.',
      'Remove XXX/TODO/lorem ipsum — a draft resume does not look serious.'),
  ];
  if (pageCount != null) {
    format.push(crit('format.pages', 'Single page / compact', pageCount <= 1 ? 15 : pageCount === 2 ? 10 : pageCount === 3 ? 5 : 2, 15,
      pageCount <= 1 ? `Resume is ${pageCount} page — one page is ideal for this profile.` : `Resume is ${pageCount} pages.`,
      years < 4 && pageCount > 1 ? 'For early-career profiles 1 page is best; cut irrelevant content.' : 'Stay within 1-2 pages; trim redundant lines.'));
  }

  const experience = [
    crit('exp.present', 'Experience section present', hasExp ? 20 : 0, 20,
      hasExp ? 'Experience section found.' : 'Experience section NOT found (cover with internships/projects).',
      'Follow Role → Company → Duration under every entry.'),
    crit('exp.roles', 'Role/title lines detected', roleLines >= 2 ? 20 : roleLines === 1 ? 12 : 4, 20,
      roleLines >= 2 ? `${roleLines} role-like lines detected.` : 'Role/title not clearly visible.',
      'Bold role + company for every entry: "SDE Intern — Acme Corp".'),
    crit('exp.dates', 'Date ranges present', dateCount >= 3 ? 20 : dateCount === 2 ? 16 : dateCount === 1 ? 9 : 3, 20,
      dateCount >= 3 ? `${dateCount} dates found.` : `Only ${dateCount} date(s) found.`,
      'Add "Jun 2021 – Aug 2024" to every role (ATS counts tenure from dates).'),
    crit('exp.tenure', 'Work tenure (years) visible', years >= 4 ? 18 : years >= 2 ? 16 : years >= 1 ? 12 : years > 0 ? 6 : 8, 20,
      years > 0 ? `~${years} years of tenure estimated.` : 'Tenure could not be estimated.',
      years < 2 ? 'Add exact dates per role — explain short tenures too.' : 'Keep tenure clearly visible.'),
    crit('exp.quantified', 'Metric-rich bullets in experience', clamp(20 * metricFrac * 1.25), 20,
      metricFrac >= 0.6 ? 'Experience shows achieved results.' : 'Experience achievements have no numbers — weak impact.',
      'Add 2-3 achieved-result bullets per role ("reduced downtime 40%").'),
  ];

  const skills = [
    crit('skills.present', 'Skills section present', hasSkills ? 18 : 0, 18,
      hasSkills ? 'Skills section found.' : 'Skills section NOT found.',
      'Keep a category-wise SKILLS section.'),
    crit('skills.count', 'Enough distinct tech skills (5+)', matched.length >= 6 ? 14 : matched.length >= 3 ? 9 : matched.length >= 1 ? 4 : 0, 14,
      matched.length >= 6 ? `${matched.length} tech terms detected.` : `Only ${matched.length} tech term(s) detected.`,
      'List 5-15 relevant skills (Languages/Frameworks/Tools/Databases).'),
    crit('skills.cat', 'Skills categorized (languages:)', catOk ? 12 : 0, 12,
      catOk ? 'Category labels found (Languages:/Frameworks:...).' : 'Skills are a plain list — no categories.',
      'Use "Languages: JavaScript, TypeScript | Frameworks: React, Node".'),
    crit('skills.alignment', `${kwSource === 'jd' ? 'JD' : 'Role'} keyword overlap`, Math.round(56 * (1 - Math.exp(-kwFrac * 3.5))), 56,
      kwSource === 'jd' ? `${matched.length}/${dict.length} JD keywords matched. Missing: ${dict.slice(0, 8).filter((w) => !matched.includes(w)).join(', ') || '—'}.` : `${matched.length}/${dict.length} standard IT keywords matched — paste a target JD for exact alignment.`,
      kwSource === 'jd' ? 'Use the exact JD buzzwords (skills + tools + jargon) with correct spellings.' : 'Provide a target JD so a real keyword match can be computed.'),
  ];

  return { impact, action, format, experience, skills };
}

// The deterministic scorer penalises a trailing "." on bullets (format.periods).
// AI rewrites must follow the same rule, so a suggested rewrite never contradicts
// the score. Keep dots that are not sentence terminators (e.g. "v1.2", "Inc.").
function stripTrailPeriod(s) {
  return String(s || '').replace(/(?<![0-9A-Z])\.(?=\s*$)/, '').replace(/\s+$/, '');
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
  if (heuristics.strongVerbs > 3) strengths.push('Most bullets start with strong action verbs — good.');
  if (heuristics.quantifiedBullets >= 3) strengths.push('Real numbers are present — impact is visible.');
  if (heuristics.hasEmail && heuristics.hasPhone) strengths.push('Contact information is complete.');
  if (heuristics.sectionsDetected.length >= 4) strengths.push('Standard ATS sections are present.');
  if (heuristics.metricFrac >= 40) strengths.push(`${heuristics.metricFrac}% of bullets carry metrics — data-backed.`);

  if (heuristics.quantifiedBullets < 3) negatives.push(`Only ${heuristics.quantifiedBullets} bullets contain metrics — quantify your results.`);
  if (heuristics.weakVerbs > 2) negatives.push(`Weak opening verbs (${heuristics.weakVerbs}) lower the impact.`);
  if (!heuristics.hasEmail) negatives.push('Email is missing.');
  if (!heuristics.hasPhone) negatives.push('Phone number is missing.');
  if (heuristics.missingSections && heuristics.missingSections.length) negatives.push(`Missing sections: ${heuristics.missingSections.join(', ')}.`);
  if (!(heuristics.social && (heuristics.social.github || heuristics.social.linkedin))) negatives.push('No GitHub/LinkedIn link found.');
  if (heuristics.trailingPeriods > 0) negatives.push('Bullets end with "." — fix the formatting.');

  const sec = (heuristics.sectionsDetected || []).map((s) => ({
    section: s,
    verdict: s === 'Experience' ? (heuristics.quantifiedBullets >= 3 ? 'ok' : 'weak') : heuristics.metricFrac >= 40 ? 'ok' : 'ok',
    whatWorks: [s + ' section is present.'],
    whatToImprove: s === 'Experience' ? ['Add 2-3 quantified result bullets per role.'] : ['Make the content more result-oriented and specific.'],
  }));
  const weakest = Object.entries(breakdown).reduce((a, b) => (b[1] < a[1] ? b : a))[0];

  const deductions = topDeductions(criteria || []);
  const potential = Math.min(100, Math.round(atsScore + deductions.reduce((s, d) => s + (100 - atsScore) * 0.12, 0)));

  return {
    executiveSummary: `ATS score ${atsScore}/100 (${verdict}). Weakest dimension: ${weakest}. Top-3 deductions: ${deductions.map((d) => d.label).join(', ') || '—'}.`,
    contentQuality: 'AI critique timed out, so this is a deterministic analysis — based on numbers, verbs, filler and tenure checks. Re-run to get a full AI content review.',
    strengths: strengths.length ? strengths : ['The resume was submitted — focus on the improvements listed below.'],
    criticalNegatives: negatives.length ? negatives : ['No critical negatives detected.'],
    atsKeywordsFound: (heuristics.skillMatch ? heuristics.skillMatch.matched : []).slice(0, 12),
    missingRecommendedKeywords: (heuristics.skillMatch && heuristics.skillMatch.source === 'jd' && heuristics.skillMatch.matched.length < heuristics.skillMatch.total) ? (heuristics.skillMatch.matched.length ? (heuristics.skillMatch.dictMissing || []) : []) : [],
    bulletImprovements: [],
    actionPlan: [
      `Fix the weakest dimension first: ${weakest}.`,
      heuristics.quantifiedBullets < 3 ? 'Add a number to every impact bullet.' : 'Push for deeper metric coverage.',
      !heuristics.hasEmail ? 'Add email + phone + location at the top.' : 'Verify the contact section.',
      'Keep it to one page with consistent formatting and standard section headers.',
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
    `Today's date: ${new Date().toISOString().slice(0, 10)}. Judge the resume as of this date (treat "present" roles accordingly).`,
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
    atsKeywordsFound: Array.isArray(parsed.atsKeywordsFound) ? parsed.atsKeywordsFound.slice(0, 30).map(String).filter((k) => kwPattern(k).test(resumeText)) : [],
    missingRecommendedKeywords: Array.isArray(parsed.missingRecommendedKeywords) ? parsed.missingRecommendedKeywords.slice(0, 15).map(String).filter((k) => (targetJobDescription && !kwPattern(k).test(resumeText))).filter(Boolean) : [],
    bulletImprovements: Array.isArray(parsed.bulletImprovements) ? parsed.bulletImprovements.slice(0, 4).map((b) => ({ original: String(b.original || ''), improved: stripTrailPeriod(String(b.improved || '')) })).filter((b) => b.original && b.improved) : [],
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
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#4f46e5').text(`Improvement potential: ~${audit.potentialScore}/100 if the top-${(audit.topDeductions || []).length} deductions are fixed`, 44, y, { width: W });
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
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#b45309').text('Top Deductions — What Hurts the Score Most', 44, y, { width: W });
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