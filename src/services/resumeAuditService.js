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

async function checkLinks(text) {
  const urls = [];
  for (const raw of (text.match(URL_RE) || [])) {
    let u = raw.trim();
    u = u.replace(/[.,;:!?)\]]+$/, '');
    if (/^https?:\/\//i.test(u) && urls.indexOf(u) === -1) urls.push(u);
  }
  const picked = urls.slice(0, 4);
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
  const status = score >= max ? 'pass' : (score >= max * 0.5 ? 'warn' : 'fail');
  return { key, label, score, max, status, why, advice };
}

function buildCriteriaGroups({ text, bullets, sections, jd, heuristics, pageCount }) {
  const quantified = bullets.filter((b) => /\d/.test(b) && /(\d\s*(%|₹|rs\.?|rs\b|users|projects|stars|clients|lines|pages|tasks|repos|commits|k\b|million|downloads)|[0-9]{2,})/i.test(b)).length;
  const quantFrac = bullets.length ? quantified / bullets.length : 0;
  const filler = bullets.filter((b) => FILLER_PHRASES.some((f) => b.toLowerCase().includes(f)));
  const longBullets = bullets.filter((b) => b.length > 220).length;
  const thinBullets = bullets.filter((b) => b.length < 15).length;
  const trailingPeriods = bullets.filter((b) => /\.$/.test(b)).length;
  const strongLead = bullets.filter((b) => STRONG_VERBS.some((v) => b.toLowerCase().startsWith(v))).length;
  const weakLead = bullets.filter((b) => WEAK_VERBS.some((v) => b.toLowerCase().startsWith(v))).length;

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
  const kwScore = Math.round(100 * (1 - Math.exp(-kwFrac * 3.2)));

  heuristics.quantifiedBullets = quantified;
  heuristics.strongVerbs = strongLead;
  heuristics.weakVerbs = weakLead;
  heuristics.trailingPeriods = trailingPeriods;
  heuristics.fillerBullets = filler.length;
  heuristics.longBullets = longBullets;
  heuristics.thinBullets = thinBullets;
  heuristics.skillMatch = { matched, total: dict.length, source: kwSource };

  const secCount = sections.length;
  const hasExp = sections.includes('Experience');
  const hasSkills = sections.includes('Skills');
  const expBullets = bullets.length;
  const dateCount = matchDates(text);
  const roleLines = bullets.filter((b) => /(engineer|developer|intern|analyst|scientist|architect|lead|head|manager|consultant|designer|trainee)/i.test(b)).length;

  const impact = [
    crit('impact.quantified', 'Metrics wali bullets (numbers/% ke saath)', Math.min(60, Math.round(100 * (1 - Math.exp(-quantFrac * 4)))), 60,
      quantFrac > 0.3 ? `Total ${bullets.length} bullets me se ${quantified} numbers/percentages ke saath hain (${Math.round(quantFrac * 100)}%).` : (quantified ? `Sirf ${quantified} bullets me real metrics hain — baki plain statements hain.` : 'Koi bhi bullet number/% ke saath nahi hai — ATS aur recruiter dono ko proof chahiye.'),
      'Har impact-line me number do: "Improved load time by 45%", "Handled 1k+ users", "Reduced cost from ₹X to ₹Y".'),
    crit('impact.density', 'Filler words / halki phrases (responsible for, helped...)', Math.max(0, 20 - 18 * Math.min(1, filler.length / 3)), 20,
      filler.length ? `${filler.length} bullets me weak filler phrase mila (responsible for / helped / various...).` : 'Koi boring filler phrase nahi — solid.',
      'Filler phrases ko hatakar concrete kaam batao: kitna bada scope, kitna result.'),
    crit('impact.balance', 'Bullet length balance (nahi lambi, nahi bohot thin)', Math.round(20 - 8 * Math.min(1, longBullets / 3) - 5 * Math.min(1, thinBullets / 3)), 20,
      `${longBullets} lambi (>220 chars) aur ${thinBullets} thin (<15 chars) bullets. 1-2 lines ideal hota hai.`,
      'Har bullet 1-2 line me: kya kiya + kaise kiya + kya nikla. Lambi lines ko 2 bullets me toda karo.'),
  ];

  let strongCover = 100;
  let weakNote = 'Koi weak opening verb nahi.';
  if (bullets.length) {
    const total = strongLead + weakLead;
    strongCover = Math.round(100 * (total ? strongLead / total : 0.5));
    if (!total) { strongCover = 30; weakNote = 'Bullets action verb se start nahi hoti (jaise "I was", "My role", naam se).'; }
  }
  const action = [
    crit('action.strong', 'Bullets strong action verb se shuru (Built, Designed, Automated...)', Math.min(70, strongCover), 70,
      strongLead ? `${strongLead}/${bullets.length} bullets strong verb se start (${strongCover}/100).` : weakNote,
      'Bullet ko हमेशा strong verb se shuru karo: Built, Designed, Automated, Optimized, Launched, Led.'),
    crit('action.weak', 'Weak verbs avoid (Contributed to, Was responsible for...)', Math.round(30 - 5 * Math.min(3, weakLead)), 30,
      weakLead ? `${weakLead} bullet "contributed/assisted/responsible" jaise weak verb se start hoti hai — impact nahi dikhta.` : 'Weak opening verbs nahi hain.',
      '"Worked on X" ki jagah "Built X" ya "Shipped X" likho — wohi kaam, double impact.'),
  ];

  const sectionsScore = secCount >= 4 ? 18 : (secCount >= 2 ? 9 : 0);
  const format = [
    crit('format.sections', 'Standard ATS sections found (Summary, Skills, Experience...)', sectionsScore, 18,
      secCount ? `${secCount} standard sections mili: ${sections.slice(0, 6).join(', ')}.` : 'Koi standard section header nahi mila.',
      'ATS standard headers ko hi use karo: SKILLS, EXPERIENCE, PROJECTS, EDUCATION, SUMMARY.'),
    crit('format.email', 'Contact email present', hasEmail(text) ? 14 : 0, 14,
      hasEmail(text) ? 'Email mila (recruiter ke liye zaroori).' : 'Resume me email nahi mila!',
      'Top me clear email daalo (N-times same format).'),
    crit('format.phone', 'Phone number present', hasPhone(text) ? 10 : 0, 10,
      hasPhone(text) ? 'Phone number mila.' : 'Phone number nahi mila.',
      'Phone country code ke saath daalo: +91-XXXXXXXXXX.'),
    crit('format.location', 'Location / city present', hasLocation(text) ? 6 : 0, 6,
      hasLocation(text) ? 'Location mention hai.' : 'Location nahi dikhi.',
      'City, Country add karo (ATS location filter me use hota hai).'),
    crit('format.links', 'Working profile links (GitHub/LinkedIn/Portfolio)', heuristics.links && heuristics.links.length ? 12 : 0, 12,
      heuristics.links && heuristics.links.length ? `${heuristics.links.length} link(s) mile (niche status check karo).` : 'Koi https:// link nahi mila.',
      'LinkedIn + GitHub + Portfolio ke working links add karo.'),
    crit('format.periods', 'Bullets me trailing "." nahi hona chahiye', Math.round(20 - 18 * (bullets.length ? trailingPeriods / bullets.length : 0)), 20,
      trailingPeriods ? `${trailingPeriods}/${bullets.length} bullets "." ke saath khatam hoti hain — ATS parse me dikkat + outdated formatting.` : 'Bullets dot ke bina hain — ATS friendly.',
      'Har bullet ke end me "." hatao (full forms ke liye "." allowed, sentence-end nahi).'),
  ];
  if (pageCount != null) {
    format.push(crit('format.pages', 'Single page / compact', pageCount <= 1 ? 20 : Math.max(0, 20 - 12 * Math.min(3, pageCount - 1)), 20,
      pageCount <= 1 ? `Resume ${pageCount} page ka hai — 1-pager ideal.` : `Resume ${pageCount} pages ka hai.`,
      '1-2 pages me rakho; 2 pages sirf tab jab 5+ saal ka experience ho. Unrelated cheezein hatao.'));
  }

  const experience = [
    crit('exp.present', 'Experience/Work section present', hasExp ? 25 : 0, 25,
      hasExp ? 'Experience section mili.' : 'Experience section nahi mili.',
      'Experience section me Role → Company → Duration ka format rakho.'),
    crit('exp.dates', 'Date ranges present (e.g. Jun 2021 - Present)', dateCount >= 1 ? 25 : 5, 25,
      dateCount ? `${dateCount} date(s) mili (year-based).` : 'Koi date range nahi mili (Roles ke saath honi chahiye).',
      'Har role ke saath "Jun 2021 – Aug 2024" jaisi dates daalo.'),
    crit('exp.roles', 'Role/company lines detected', Math.round(25 * Math.min(1, roleLines / 2)), 25,
      roleLines ? `${roleLines} role-like line mili.` : 'Role/title wali lines nahi dikhi.',
      'Har entry: Bold role title + company + duration.'),
    crit('exp.depth', 'Experience me detail bullets', Math.round(25 * Math.min(1, expBullets / 5)), 25,
      expBullets ? `${expBullets} detail bullet lines total.` : 'Bahut kam content.',
      'Har role ke under 3-4 result-oriented bullets likho.'),
  ];

  const skills = [
    crit('skills.present', 'Skills section present', (hasSkills || sections.some((s) => /skill/i.test(s))) ? 20 : 0, 20,
      hasSkills ? 'Skills section mili.' : 'Skills section nahi mili.',
      'SKILLS section me categories ka use karo: Languages / Frameworks / Tools / Databases.'),
    crit('skills.count', 'Enough skills listed (5+)', dict.length >= 5 ? 20 : 10, 20,
      dict.length ? `${dict.length} matching terms resume me check hue.` : 'Skills nahi dikhi.',
      '5-15 relevant skills list karo, par sab aana bhi chahiye (bluff mat karo).'),
    crit('skills.alignment', `${kwSource === 'jd' ? 'JD' : 'Role'} keywords ka overlap`, Math.min(60, kwScore), 60,
      kwSource === 'jd' ? `${matched.length}/${dict.length} JD-keywords resume me mile. Missing: ${dict.slice(0, 8).filter((w) => !matched.includes(w)).join(', ')}.` : `${matched.length}/${dict.length} standard IT keywords mile (koi JD dene pe precise then-align hota hai).`,
      kwSource === 'jd' ? 'JD ke exact buzzwords (skills + tools + jargon) ki spellings use karo — wo ATS match karta hai.' : 'Target JD paste karo taaki exact keyword-alignment dikhe.'),
  ];

  return { impact, action, format, experience, skills };
}
function dimScore(group) {
  const sum = group.reduce((a, c) => a + c.score, 0);
  const max = group.reduce((a, c) => a + c.max, 0) || 1;
  return Math.round((100 * sum) / max);
}

function fallbackCritique({ atsScore, verdict, breakdown, heuristics, bullets }) {
  const strengths = [];
  const negatives = [];
  if (heuristics.strongVerbs > 0) strengths.push('Kai bullets strong action verbs se shuru ho rahi hain — good.');
  if (heuristics.quantifiedBullets >= 3) strengths.push('Real numbers/percentages present hain — impact dikh raha hai.');
  if (heuristics.hasEmail) strengths.push('Contact email present hai.');
  if (heuristics.sectionsDetected.length >= 4) strengths.push('Standard ATS sections present hain.');
  if (heuristics.quantifiedBullets < 3) negatives.push('Sirf ' + heuristics.quantifiedBullets + ' bullets me metrics hain — results quantify karo.');
  if (heuristics.weakVerbs > 0) negatives.push('Weak opening verbs (' + heuristics.weakVerbs + ') impact kam kar rahe hain.');
  if (!heuristics.hasEmail) negatives.push('Email missing hai — recruiters ko contact nahi milega.');
  if (heuristics.trailingPeriods > 0) negatives.push('Bullets "." ke saath khatam ho rahi hain.');
  if (heuristics.links && !heuristics.links.length) negatives.push('Koi working profile link nahi mila (GitHub/LinkedIn add karo).');

  const sec = heuristics.sectionsDetected.map((s) => ({
    section: s,
    verdict: s === 'Experience' ? (heuristics.quantifiedBullets >= 3 ? 'ok' : 'weak') : 'ok',
    whatWorks: [s + ' section exist karti hai.'],
    whatToImprove: s === 'Experience' ? ['Har role ke liye 3-4 quantified result bullets likho.'] : ['Section content ko aur specific banao.'],
  }));
  const weakest = Object.entries(breakdown).reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  return {
    executiveSummary: `ATS score ${atsScore}/100 (${verdict}). Sabse kamzor dimension: ${weakest}.`,
    contentQuality: 'AI kritique timeout ke baad deterministic analysis diya — numbers/verbs/filler checks ke based. Exact content-ki-umar LLM se dobara try karo.',
    strengths: strengths.length ? strengths : ['Resume wejha gaya — ab improvements dekho.'],
    criticalNegatives: negatives.length ? negatives : ['Koi critical negative nahi mila.'].slice(0, 1),
    atsKeywordsFound: (heuristics.skillMatch ? heuristics.skillMatch.matched : []).slice(0, 12),
    missingRecommendedKeywords: (heuristics.skillMatch && heuristics.skillMatch.source === 'jd' ? heuristics.skillMatch.matched.length < heuristics.skillMatch.total : false) ? (heuristics.skillMatch.matched ? [] : []) : [],
    bulletImprovements: [],
    actionPlan: [
      `Sabse weak dimension fix karo: ${weakest}.`,
      heuristics.quantifiedBullets < 3 ? 'Har impact bullet me number add karo.' : 'Metrics wali chize aur depth do.',
      !heuristics.hasEmail ? 'Email + location + links top me add karo.' : 'Contact section verify karo.',
      'Resume ko 1 page / consistent formatting me rakho.',
    ],
    sectionReview: sec,
  };
}

async function critiqueResume({ resumeText, targetJobDescription, atsScore, breakdown, verdict, heuristics, bullets }) {
  const sys = `You are a ruthless resume/ATS auditor. You only judge what is literally in the resume text — never invent facts. Output STRICT JSON only, no prose, no markdown fences. Keys:
{
 "executiveSummary": "2-3 sentences, realistic verdict on this resume",
 "contentQuality": "2-3 sentences: is the substance meaningful (results, scope, specifics), or is it just filled with generic duties — is it WORTH writing?",
 "strengths": ["..."],
 "criticalNegatives": ["..."],
 "atsKeywordsFound": ["only keywords literally present in the text"],
 "missingRecommendedKeywords": ["only if a target JD was given; keywords from JD missing in text; else []"],
 "bulletImprovements": [{"original": "exact bullet copied verbatim from resume", "improved": "rewritten with strong verb + metric + result"}],
 "actionPlan": ["4 numbered, concrete steps"],
 "sectionReview": [{"section":"SectionName","verdict":"strong|ok|weak","whatWorks":["..."],"whatToImprove":["..."]}]
}
Constraints: bulletImprovements entries MUST be small set of existing bullets; max 6 sectionReview entries; keep JSON valid (escape quotes).`;
  const usr = [
    `ATS score (deterministic, machine-computed): ${atsScore}/100 — verdict: ${verdict}.`,
    `Breakdown: impact=${breakdown.impactAndMetrics}, action=${breakdown.actionVerbs}, format=${breakdown.formattingAndClarity}, experience=${breakdown.experienceDepth}, skills=${breakdown.skillsRelevance}.`,
    `Heuristics: totalBullets=${heuristics.totalBullets}, quantified=${heuristics.quantifiedBullets}, strongVerbs=${heuristics.strongVerbs}, weakVerbs=${heuristics.weakVerbs}, fillerBullets=${heuristics.fillerBullets}, trailingPeriods=${heuristics.trailingPeriods}, email=${heuristics.hasEmail}, phone=${heuristics.hasPhone}, sections=${(heuristics.sectionsDetected || []).join(', ')}, keywordMatch=${JSON.stringify(heuristics.skillMatch || {})}.`,
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
    longBullets: 0,
    thinBullets: 0,
    hasEmail: hasEmailV,
    hasPhone: hasPhoneV,
    hasLocation: hasLocV,
    sectionsDetected: sections,
    skillMatch: kv,
    links: [],
  };
  return h;
}

async function auditResume({ resumeText, targetJobDescription = '', pageCount = null, fileName = '' } = {}) {
  const text = String(resumeText || '').trim();
  if (text.length < 50) throw new Error(`Resume text too short (${text.length} chars) — minimum 50 characters needed to audit.`);
  const jd = String(targetJobDescription || '').trim();

  const bullets = extractBullets(text);
  const sections = detectSections(text);
  const h0 = buildHeuristics({
    bullets, sections,
    hasEmailV: hasEmail(text),
    hasPhoneV: hasPhone(text),
    hasLocV: hasLocation(text),
    kv: { matched: [], total: 0, source: 'pending' },
  });

  const links = await checkLinks(text);
  h0.links = links;

  const groups = buildCriteriaGroups({ text, bullets, sections, jd, heuristics: h0, pageCount });
  const breakdown = {
    impactAndMetrics: dimScore(groups.impact),
    actionVerbs: dimScore(groups.action),
    formattingAndClarity: dimScore(groups.format),
    experienceDepth: dimScore(groups.experience),
    skillsRelevance: dimScore(groups.skills),
  };
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const atsScore = clamp(0.25 * breakdown.impactAndMetrics + 0.20 * breakdown.actionVerbs + 0.15 * breakdown.formattingAndClarity + 0.15 * breakdown.experienceDepth + 0.25 * breakdown.skillsRelevance);
  const verdict = atsScore >= 80 ? 'ATS-Ready' : atsScore >= 65 ? 'Strong Contender' : atsScore >= 50 ? 'Needs Polish' : 'High Risk';

  const criteria = [...groups.impact, ...groups.action, ...groups.format, ...groups.experience, ...groups.skills];

  let ai = null;
  try {
    ai = await withTimeout(critiqueResume({ resumeText: text, targetJobDescription: jd, atsScore, breakdown, verdict, heuristics: h0, bullets }), LLM_TIMEOUT_MS);
  } catch (e) {
    console.warn('[resume] AI critique fail -> deterministic fallback:', e.message);
    ai = fallbackCritique({ atsScore, verdict, breakdown, heuristics: h0, bullets });
  }

  return {
    atsScore,
    verdict,
    jdUsed: jd,
    pageCount: pageCount != null ? pageCount : null,
    breakdown,
    criteria,
    links,
    heuristics: {
      totalBullets: h0.totalBullets,
      quantifiedBullets: h0.quantifiedBullets,
      strongVerbs: h0.strongVerbs,
      weakVerbs: h0.weakVerbs,
      fillerBullets: h0.fillerBullets,
      trailingPeriods: h0.trailingPeriods,
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
  const audit = await auditResume({ resumeText: text, targetJobDescription, pageCount, fileName: originalName });
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
    doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(`${resumeName || 'resume'}  •  ${new Date().toLocaleString()}${audit.pageCount != null ? '  •  ' + audit.pageCount + ' page(s)' : ''}`, 44, y, { width: W });
    y += 16;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(tone).text(`SCORE: ${audit.atsScore}/100  —  ${audit.verdict}`, 44, y, { width: W });
    y += 20;

    const dims = [['Impact & Metrics', audit.breakdown.impactAndMetrics], ['Action Verbs', audit.breakdown.actionVerbs], ['Formatting & Clarity', audit.breakdown.formattingAndClarity], ['Experience Depth', audit.breakdown.experienceDepth], ['Skills Relevance', audit.breakdown.skillsRelevance]];
    for (const [label, val] of dims) {
      ensure(18);
      doc.font('Helvetica').fontSize(9).fillColor('#374151').text(`${label}  ${val}/100`, 44, y, { width: W });
      y += 12;
      doc.rect(44, y, W, 5).fill('#e5e7eb');
      doc.rect(44, y, Math.max(1, Math.min(W, (W * val) / 100)), 5).fill(tone);
      y += 10;
    }
    y += 6;

    const critText = audit.criteria.slice(0, 14).map((c) => `${c.label}: ${c.score}/${c.max} ${c.status.toUpperCase()}. ${c.why}`).join('\n');
    if (critText) {
      ensure(24);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Per-Criteria Breakdown', 44, y, { width: W });
      y += 14;
      ensure(critText.length / 3);
      doc.font('Helvetica').fontSize(8).fillColor('#374151').text(critText, 44, y, { width: W, lineGap: 4 });
      y = doc.y + 10;
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