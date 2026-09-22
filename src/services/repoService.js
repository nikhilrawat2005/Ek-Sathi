// ---------------------------------------------------------------------------
// Repo Service — lets Bob the Builder self-read any GitHub repository
// (public repos anonymously; private repos need GITHUB_TOKEN in .env).
// Uses only the GitHub REST API + raw.githubusercontent.com — no git binary.
// ---------------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const CACHE_TTL = 30 * 60 * 1000; // 30 min
const cache = new Map();

const MAX_FILES = 40;        // max files to actually read
const MAX_TOTAL_BYTES = 70 * 1024; // 70 KB of file content total per repo read
const MAX_FILE_BYTES = 120 * 1024;  // single file cap
const MAX_DISPLAY_FILE = 4500;      // chars shown per file in context

// Profile deep-scan limits (user requested a generous scraping budget)
const PROFILE_NODE_CHARS = 70000;   // combined repo README/content budget for LLM (~70000)
const PROFILE_REPO_CAP = 100;       // max repos scraped per profile
const PROFILE_SUMMARY_TOP = 25;     // repos that get a README summary card
const PROFILE_CACHE_TTL = 15 * 60 * 1000;

const SKIP_DIRS = ['node_modules', '.git', '.next', '.nuxt', 'dist', 'build', 'out', 'vendor', 'coverage', '.cache', 'public/build', '__pycache__', '.venv', 'venv', 'target', '.github/workflows'];
const SKIP_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'composer.lock', 'poetry.lock', 'Cargo.lock', 'Gemfile.lock', 'go.sum'];
const SKIP_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mp3', '.zip', '.gz', '.pdf', '.min.js', '.min.css', '.map'];
const TEXT_EXT = ['.md', '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rb', '.java', '.kt', '.php', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.html', '.css', '.scss', '.less', '.vue', '.svelte', '.json', '.yml', '.yaml', '.toml', '.sh', '.sql', '.txt', '.env', '.cfg', '.conf', '.ini'];

function fetchGH(path, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'bob-the-builder',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  return fetch(`${API}${path}`, { headers, signal: ctrl.signal })
    .then(async (res) => {
      clearTimeout(t);
      const body = await res.json().catch(() => ({}));
      const link = res.headers.get('link') || '';
      return { status: res.status, body, link };
    })
    .catch((err) => {
      clearTimeout(t);
      return { status: 0, body: { message: err.name === 'AbortError' ? 'timeout' : err.message } };
    });
}

// ── URL detection ───────────────────────────────────────────
function extractRepoUrls(text) {
  const found = [];
  const seen = new Set();
  const push = (owner, repo, url) => {
    const key = `${owner}/${repo}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ owner, repo, url });
    }
  };
  const ghRe = /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
  let m;
  while ((m = ghRe.exec(text)) !== null) push(m[1], m[2], m[0]);
  if (!found.length) {
    const bare = text.trim();
    if (bare.length <= 80 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bare)) {
      const [o, r] = bare.split('/');
      push(o, r, bare);
    }
  }
  return found;
}

// ── Repo info ───────────────────────────────────────────────
async function getRepoInfo(owner, repo) {
  const { status, body } = await fetchGH(`/repos/${owner}/${repo}`);
  if (status === 0) return { error: 'network', message: body.message };
  if (status === 403) return { error: 'rate_limit', message: 'GitHub API rate limit hit (anonymous: 60/hr). Add GITHUB_TOKEN env to raise it.' };
  if (status === 404) return { error: 'not_found', message: `Repo "${owner}/${repo}" nahi mila — ho sakta hai private ho.` };
  if (status !== 200) return { error: 'api', message: body.message || `GitHub API error ${status}` };
  return {
    fullName: body.full_name,
    description: body.description || '',
    language: body.language || null,
    defaultBranch: body.default_branch || 'main',
    private: !!body.private,
    stars: body.stargazers_count || 0,
    forks: body.forks_count || 0,
    updatedAt: body.updated_at || null,
  };
}

// ── Recursive file tree ─────────────────────────────────────
async function getTree(owner, repo, branch) {
  const { status, body } = await fetchGH(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (status !== 200) {
    // Some repos have odd default branches / no tree — retry on 'main'
    if (branch !== 'main') return getTree(owner, repo, 'main');
    return { tree: [], truncated: false };
  }
  return { tree: body.tree || [], truncated: !!body.truncated };
}

function isTextFile(path) {
  const lower = String(path || '').toLowerCase();
  if (SKIP_FILES.includes(lower.split('/').pop())) return false;
  if (SKIP_EXT.some(ext => lower.endsWith(ext))) return false;
  if (SKIP_DIRS.some(dir => path.startsWith(dir + '/') || path.split('/').includes(dir))) return false;
  if (/\.min\.(js|css)$/.test(lower)) return false;
  if (TEXT_EXT.some(ext => lower.endsWith(ext))) return true;
  // Extensionless well-known text files (e.g. "README", "LICENSE", "Dockerfile", "Makefile")
  const name = String(path.split('/').pop() || '').toLowerCase();
  return /^(readme|license|copying|dockerfile|makefile|justfile|rakefile|gemfile|changelog|codeowners|gitignore|gitattributes|editorconfig|dockerignore)$/.test(name);
}

function prioritize(tree) {
  const blobs = (tree || []).filter(b => b.type === 'blob' && typeof b.size === 'number' && b.size > 0 && b.size <= MAX_FILE_BYTES && isTextFile(b.path));
  const score = (p, size) => {
    const name = String(p || '').split('/').pop().toLowerCase();
    let s = 0;
    if (name === 'readme.md') s += 1000;
    if (name === 'package.json') s += 600;
    if (name === 'tsconfig.json' || name === 'pyproject.toml' || name === 'go.mod' || name === 'requirements.txt') s += 400;
    if (name === '.env.example' || name === 'docker-compose.yml' || name === 'dockerfile') s += 350;
    if (name.startsWith('index.') || name.startsWith('main.') || name.startsWith('app.') || name === 'server.js' || name === 'app.js') s += 200;
    if (name.includes('readme') || name.includes('test') || name.includes('config')) s += 100;
    const depth = p.split('/').length;
    if (depth <= 2) s += 80;
    if (depth <= 3) s += 30;
    return s + (100 - Math.min(100, size / 2000));
  };
  return blobs
    .map(b => ({ ...b, score: score(b.path, b.size) }))
    .sort((a, b) => b.score - a.score);
}

// ── Read file contents (raw first, contents API fallback) ──
async function fetchFile(owner, repo, branch, path) {
  const encPath = path.split('/').map(encodeURIComponent).join('/');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`${RAW}/${owner}/${repo}/${encodeURIComponent(branch)}/${encPath}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const text = await res.text();
      if (text.length > 0 && !text.startsWith('<!DOCTYPE') && !text.startsWith('<html')) return text;
    }
  } catch (e) { /* fall through to contents API */ }
  // Fallback: contents API (base64)
  const { status, body } = await fetchGH(`/repos/${owner}/${repo}/contents/${encPath}?ref=${encodeURIComponent(branch)}`, 10000);
  if (status === 200 && body && body.content) {
    try { return Buffer.from(body.content, 'base64').toString('utf8'); } catch (e) { return null; }
  }
  return null;
}

// ── Top-level stats ─────────────────────────────────────────
function treeStats(tree) {
  const dirs = new Set();
  const extCount = {};
  let files = 0;
  (tree || []).forEach(b => {
    if (b.type !== 'blob' || !b.path) return;
    files++;
    const parts = b.path.split('/');
    if (parts.length > 1) dirs.add(parts[0]);
    const dot = parts[parts.length - 1].lastIndexOf('.');
    if (dot > 0) {
      const ext = String(parts[parts.length - 1] || '').slice(dot).toLowerCase();
      extCount[ext] = (extCount[ext] || 0) + 1;
    }
  });
  const topExt = Object.entries(extCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e, n]) => `${e}×${n}`).join(', ');
  return { fileCount: files, topDirs: [...dirs].slice(0, 10).join(', '), topExt };
}

// ── Build readable context block ────────────────────────────
function buildRepoContext(a) {
  const lines = [];
  lines.push('━━━ 📦 GITHUB REPO ANALYSIS (Ek Sathi self-read this repository) ━━━');
  lines.push(`Repo: **${a.repo.fullName}**`);
  if (a.repo.description) lines.push(`About: ${a.repo.description.slice(0, 300)}`);
  lines.push(`Language: ${a.repo.language || 'n/a'} · Default branch: ${a.repo.defaultBranch} · ⭐ ${a.repo.stars} · Forks: ${a.repo.forks}`);
  lines.push(`Size: ${a.stats.fileCount} files · top dirs: ${a.stats.topDirs || 'n/a'} · top extensions: ${a.stats.topExt || 'n/a'}`);
  lines.push(`Read ${a.readCount} key files (of ${a.stats.fileCount})`);
  if (a.truncated) lines.push('⚠️ Repo tree was truncated (huge repo) — analysis covers the most relevant files.');
  lines.push('');
  lines.push('## 🔑 KEY FILES (actual code read below — use these EXACT details)');
  a.files.forEach(f => {
    const ext = String(f.path || '').split('.').pop().toLowerCase();
    const lang = ({ js: 'js', mjs: 'js', ts: 'ts', jsx: 'jsx', tsx: 'tsx', py: 'python', json: 'json', html: 'html', css: 'css', scss: 'css', md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'bash', go: 'go', java: 'java', c: 'c', cpp: 'cpp', rb: 'ruby', php: 'php', kt: 'kotlin' })[ext] || '';
    lines.push('');
    lines.push(`### 📄 ${f.path}`);
    lines.push('```' + lang);
    lines.push(f.content.slice(0, MAX_DISPLAY_FILE));
    lines.push('```');
  });
  return lines.join('\n');
}

// ── Main entry: analyze a GitHub repo (cached) ──────────────
async function analyzeRepo(urlOrText) {
  const parts = extractRepoUrls(urlOrText)[0];
  if (!parts) return { status: 'no_repo', message: 'Koi valid GitHub repo link nahi mila.' };
  const key = `${parts.owner}/${parts.repo}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const info = await getRepoInfo(parts.owner, parts.repo);

  let result;
  if (info.error) {
    result = { status: 'error', repo: { fullName: key }, error: info.error, message: info.message };
  } else if (info.private && !GITHUB_TOKEN) {
    result = {
      status: 'private',
      repo: { fullName: info.fullName, private: true },
      message: `Repo "${info.fullName}" PRIVATE hai. GitHub pe public karke dobara link bhejo (ya GITHUB_TOKEN env lagao).`,
    };
  } else {
    try {
      const { tree, truncated } = await getTree(parts.owner, parts.repo, info.defaultBranch);
      const prioritized = prioritize(tree);
      const selected = prioritized.slice(0, MAX_FILES);
      let totalBytes = 0;
      const readList = [];
      for (const f of selected) {
        if (totalBytes >= MAX_TOTAL_BYTES) break;
        const content = await fetchFile(parts.owner, parts.repo, info.defaultBranch, f.path);
        if (content) {
          readList.push({ path: f.path, content });
          totalBytes += content.length;
        }
      }
      const stats = treeStats(tree);
      const files = readList.sort((a, b) => {
        const nameRank = (p) => (/readme\.md$/i.test(p) ? 0 : 1);
        return nameRank(a.path) - nameRank(b.path);
      });
      result = {
        status: 'ok',
        repo: info,
        filesRead: files,
        readCount: files.length,
        stats,
        truncated,
        context: buildRepoContext({ repo: info, files, stats, readCount: files.length, truncated }),
      };
    } catch (err) {
      result = { status: 'error', repo: { fullName: key }, error: 'read', message: err.message };
    }
  }

  cache.set(key, { ts: Date.now(), data: result });
  return result;
}

// ─────────────────────────────────────────────────────────
// GitHub Search — find interesting repos by keyword/topic.
// Free: 10 searches/min anonymous, 30/min with GITHUB_TOKEN.
// Returns { items, count } or { error, message }.
// ─────────────────────────────────────────────────────────

async function searchRepos(query, limit = 5) {
  const q = (query || '').trim();
  if (!q) return { error: 'empty_query', message: 'Search query empty.' };
  const per = Math.min(Math.max(parseInt(limit) || 5, 1), 10);
  const url = `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${per}`;
  const { status, body } = await fetchGH(url, 15000);
  if (status === 0) return { error: 'network', message: 'GitHub se connect nahi ho paya.' };
  if (status === 403) return { error: 'rate_limit', message: 'GitHub search rate limit hit (10/min anonymous). Thodi der baad try karo, ya GITHUB_TOKEN laga do.' };
  if (status !== 200) return { error: 'api', status, message: `GitHub search failed (${status}).` };
  const items = (body.items || []).map(it => ({
    full_name: it.full_name,
    html_url: it.html_url,
    description: it.description,
    language: it.language,
    stars: it.stargazers_count,
    forks: it.forks_count,
    updated_at: it.updated_at,
    topics: Array.isArray(it.topics) ? it.topics.slice(0, 5) : [],
  }));
  return { items, count: items.length };
}

// ═══════════════════════════════════════════════════════════
// Deterministic Q&A on the analyzed repo — works with ZERO
// LLM keys. We search the files Ek Sathi actually read for
// keyword hits and answer the question from real code.
// ─────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'but',
  'for', 'in', 'on', 'with', 'without', 'this', 'that', 'these', 'those', 'of',
  'to', 'how', 'what', 'why', 'does', 'do', 'did', 'can', 'could', 'would',
  'should', 'will', 'me', 'my', 'i', 'we', 'it', 'its', 'as', 'at', 'by', 'from',
  'about', 'explain', 'tell', 'which', 'who', 'when', 'write', 'give', 'show',
  'me', 'up', 'down', 'than', 'then', 'so', 'if', 'has', 'have', 'had', 'into',
  'out', 'not', 'no', 'you', 'your', 'use', 'uses', 'used', 'using', 'repo',
  'repository', 'please', 'also', 'there', 'their', 'them', 'any', 'all', 'are',
]);

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9+#.\-]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

function extractSnippet(content, term, maxChars = 220) {
  const lower = String(content || '').toLowerCase();
  const idx = lower.indexOf(String(term).toLowerCase());
  if (idx === -1) return '';
  const start = Math.max(0, idx - maxChars / 3);
  let snippet = content.slice(start, start + maxChars);
  snippet = snippet.replace(/\s+/g, ' ');
  return '…' + snippet + '…';
}

// Score every read file against a question's search terms.
function rankFiles(files, terms) {
  return (files || []).map(f => {
    const name = String(f.path || '').toLowerCase();
    let pathScore = 0;
    if (/readme\.md$/i.test(name)) pathScore += 40;
    if (/package\.json$/.test(name)) pathScore += 25;
    if (/requirements|pyproject|go\.mod|composer/.test(name)) pathScore += 20;
    let scores = 0;
    const hits = [];
    (terms || []).forEach(term => {
      const n = (String(f.content || '').toLowerCase().split(term).length - 1);
      if (n > 0) { scores += Math.min(n, 6); hits.push(term); }
    });
    return { file: f, name, pathScore, scores, hits };
  })
  .filter(r => r.scores > 0)
  .sort((a, b) => (b.scores + b.pathScore) - (a.scores + a.pathScore));
}

function depsOf(pkgContent) {
  try {
    const pkg = JSON.parse(pkgContent);
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies);
    const names = Object.keys(deps || {});
    return { runtime: Object.keys(pkg.dependencies || {}), dev: Object.keys(pkg.devDependencies || {}), all: names, scripts: pkg.scripts || {} };
  } catch (e) { return null; }
}

// Detect which file list best matches an intent (runtime deps, db, auth...).
function findIntentFile(files, patterns) {
  const re = new RegExp(patterns.join('|'), 'i');
  return (files || []).find(f => re.test(f.path));
}

/**
 * answerRepoQuestion(analysis, question) → { answer }
 * analysis = the object returned by analyzeRepo() (status 'ok').
 * Returns a markdown answer built ONLY from real repo data.
 */
function answerRepoQuestion(analysis, question) {
  if (!analysis) return { answer: 'Pehle repo analyze karo, phir sawaal poocho.' };
  if (analysis.status !== 'ok') {
    return { answer: analysis.message || 'Repo analysis available nahi hai.' };
  }
  const q = String(question || '').toLowerCase().trim();
  const info = analysis.repo || {};
  const files = analysis.filesRead || [];
  const out = [];

  const has = (...re) => re.some(r => r.test(q));

  // 1) Meta questions — answerable from repo metadata alone.
  if (!q) {
    out.push('Koi sawaal likho — jaise: **"ye project kya karta hai?"**, **"tech stack kya hai?"**, **"kaise run karein?"**');
    return { answer: out.join('\n') };
  }

  if (has(/what.*(do|this repo|it|purpose|about|project)/, /ye (kya|project)/, /overview/, /summari/, /introduce/)) {
    out.push('## 🎯 Purpose / Overview');
    out.push(info.description ? `**About:** ${info.description}` : '_Repo description nahi di gayi._');
    const readme = files.find(f => /readme\.md$/i.test(f.path));
    if (readme) {
      const first = readme.content.split('\n').filter(l => l.trim() && !/^#/.test(l)).slice(0, 6).join('\n').slice(0, 700);
      if (first.trim()) out.push('\n**README se (sabse important baatein):**\n\n' + first);
    }
    if (!readme && info.description) out.push('\n_README nahi pada, bas GitHub metadata se._');
  }

  if (has(/tech.*stack/, /language/, /framework/, /stack/, /dependency/, /library/, /what.*built/, /written in/, /language use/)) {
    out.push('## 🧰 Tech Stack');
    out.push(`**Main language:** ${info.language || 'n/a'} · **Extensions in repo:** ${analysis.stats && analysis.stats.topExt || 'n/a'}`);
    const pkg = files.find(f => /package\.json$/.test(f.path));
    const req = files.find(f => /^requirements\.txt$/.test(f.path));
    const go = files.find(f => /^go\.mod$/.test(f.path));
    const pyproj = files.find(f => /^pyproject\.toml$/.test(f.path));
    if (pkg) {
      const d = depsOf(pkg.content);
      if (d) {
        out.push('\n**npm runtime dependencies:** ' + (d.runtime.length ? d.runtime.slice(0, 20).join(', ') : '_none_'));
        if (d.dev.length) out.push('**dev dependencies:** ' + d.dev.slice(0, 15).join(', '));
      }
    }
    if (req) out.push('\n**Python (requirements.txt):**\n' + req.content.slice(0, 600));
    if (pyproj) out.push('\n**Python (pyproject.toml):**\n' + pyproj.content.slice(0, 600));
    if (go) out.push('\n**Go modules:**\n' + go.content.slice(0, 600));
  }

  if (has(/how.*(run|start|install|use)/, /kaise (run|start|chal|install)/, /getting started/, /setup/, /install/)) {
    out.push('## 🚀 How to Run / Setup');
    const readme = files.find(f => /readme\.md$/i.test(f.path));
    const pkg = files.find(f => /package\.json$/.test(f.path));
    if (pkg) {
      const d = depsOf(pkg.content);
      if (d && d.scripts) {
        out.push('**npm scripts available:**\n');
        Object.keys(d.scripts).slice(0, 10).forEach(s => out.push(`- \`npm run ${s}\` → ${(d.scripts[s] || '').slice(0, 80)}`));
      }
    }
    if (readme) {
      const body = readme.content;
      const m = body.match(/(?:\#+\s*(?:Installation|Setup|Getting Started|Usage|Run|Quick Start)[^\n]*\n)([\s\S]{0,1200})/i);
      if (m) out.push('\n**Setup section from README:**\n\n' + m[1].slice(0, 1000));
      else out.push('\n**README ki shuruaat:**\n\n' + body.split('\n').filter(l => l.trim()).slice(0, 15).join('\n').slice(0, 800));
    }
    const docker = files.find(f => /docker(compose)?\.ya?ml$/i.test(f.path) || /^dockerfile$/i.test(f.path));
    if (docker) out.push(`\n**Docker file:** \`${docker.path}\` repo me hai — Docker based run possible hai.`);
  }

  if (has(/folder|director|structure|layout|file.*organi/, /files.*important/, /important file/)) {
    out.push('## 📁 Folder Structure');
    out.push(`**Total files:** ${analysis.stats && analysis.stats.fileCount} · **Top dirs:** ${analysis.stats && analysis.stats.topDirs || 'n/a'}`);
    out.push('\n**Key files jo padhe gaye (in priority order):**\n');
    (files || []).slice(0, 25).forEach((f, i) => out.push(`${i + 1}. \`${f.path}\` (~${(f.content || '').length} chars)`));
  }

  if (has(/auth|login|jwt|token|session|password|firebase|oauth|login/)) {
    out.push('## 🔐 Authentication / Login');
    const hits = rankFiles(files, ['auth', 'login', 'jwt', 'token', 'session', 'password', 'firebase', 'oauth', 'signin']);
    if (!hits.length) out.push('Is repo me authorization ka code nahi mila (ya read kiye files me nahi tha).');
    hits.slice(0, 5).forEach(({ file, hits }) => {
      const f = file;
      out.push(`\n**${f.path}** — keywords: ${hits.join(', ')}`);
      out.push('```\n' + extractSnippet(f.content, hits[0], 260) + '\n```');
    });
  }

  if (has(/database|db|sql|mongo|postgres|mysql|sqlite|redis|prisma|firestore|supabase|storage|migration/)) {
    out.push('## 🗄️ Database / Storage');
    const terms = ['database', 'prisma', 'sequelize', 'mongoose', 'mongodb', 'postgres', 'mysql', 'sqlite', 'redis', 'firestore', 'supabase', 'createconnection', 'new pool', 'client(', 'knex'];
    const hits = rankFiles(files, terms);
    if (!hits.length) out.push('Read kiye files me database integration ka code nahi mila.');
    hits.slice(0, 5).forEach(({ file, hits }) => {
      out.push(`\n**${file.path}** — keywords: ${hits.join(', ')}`);
      out.push('```\n' + extractSnippet(file.content, hits[0], 260) + '\n```');
    });
  }

  if (has(/api|endpoint|route|rest|graphql|request|server|backend/)) {
    out.push('## 🔌 API / Routes');
    const hits = rankFiles(files, ['router.', 'app.get', 'app.post', 'router.get', 'router.post', '@app.route', 'endpoint', 'express', 'fastify', 'graphql', 'api/']);
    if (!hits.length) out.push('API routes ya server code nahi mila read kiye files me.');
    hits.slice(0, 5).forEach(({ file, hits }) => {
      out.push(`\n**${file.path}**`);
      out.push('```\n' + extractSnippet(file.content, hits[0], 300) + '\n```');
    });
  }

  if (has(/deploy|host|vercel|netlify|docker|heroku|render|aws|cloud/)) {
    out.push('## ☁️ Deployment / Hosting');
    const terms = ['vercel.json', 'netlify.toml', 'now.json', 'dockerfile', 'docker-compose', 'render.yaml', 'heroku', '.github/workflows', 'fly.toml', 'railway'];
    const hits = rankFiles(files, terms);
    const cfg = files.filter(f => /vercel\.json|netlify\.toml|dockerfile|docker-compose|render\.ya|^\.github/.test(f.path));
    if (cfg.length) cfg.slice(0, 5).forEach(f => out.push(`\n**${f.path}:**\n\`\`\`\n${f.content.slice(0, 400)}\n\`\`\``));
    if (!cfg.length && !hits.length) out.push('Deployment config file nahi mili read kiye files me.');
    hits.filter(h => !cfg.includes(h.file)).slice(0, 3).forEach(({ file, hits }) => out.push(`\n**${file.path}** — keywords: ${hits.join(', ')}`));
  }

  if (has(/error|bug|prob|fix/)) {
    out.push('## 🐞 Errors / Known Issues');
    const hits = rankFiles(files, ['error', 'catch', 'exception', 'throw new', 'issue', 'todo', 'fixme', 'return null']);
    hits.slice(0, 4).forEach(({ file, hits }) => {
      out.push(`\n**${file.path}**`);
      out.push('```\n' + extractSnippet(file.content, hits[0], 240) + '\n```');
    });
  }

  // 6) Generic fallback — pure keyword search across read files.
  if (!out.length) {
    const terms = tokenize(q);
    const ranked = rankFiles(files, terms);
    if (ranked.length) {
      out.push(`## 🔎 "${question}" — search hits`);
      ranked.slice(0, 5).forEach(({ file, hits, scores }) => {
        out.push(`\n**${file.path}** (hit score ${scores}) — keywords: ${hits.join(', ')}`);
        const snippet = extractSnippet(file.content, hits[0], 300);
        if (snippet) out.push('```\n' + snippet + '\n```');
        else out.push('```\n' + file.content.slice(0, 300) + '\n```');
      });
    } else {
      out.push(`Is repo ke read kiye files (${analysis.readCount || 0}) me **"${question}"** se match nahi mila.`);
      out.push('\nTry karo: kya karta hai / tech stack / how to run / folder structure / auth / database / api.');
    }
  }

  return { answer: out.join('\n') };
}

// ── GitHub user profile + repos (for accurate "mere kitne repos hain" answers) ──

function cleanUsername(input) {
  return String(input || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/+$/, '').split('/')[0];
}

// Returns real public profile data for a GitHub user.
async function getUserProfile(usernameInput) {
  const username = cleanUsername(usernameInput);
  if (!username) return { error: 'empty_username', message: 'Username empty.' };
  const { status, body } = await fetchGH(`/users/${encodeURIComponent(username)}`, 15000);
  if (status === 0) return { error: 'network', message: 'GitHub se connect nahi ho paya.' };
  if (status === 403) return { error: 'rate_limit', message: 'GitHub rate limit hit (60/hr anonymous). Thodi der baad try karo, ya GITHUB_TOKEN laga do.' };
  if (status === 404) return { error: 'not_found', message: `GitHub pe "${username}" jaise user nahi mila.` };
  if (status !== 200) return { error: 'api', status, message: `GitHub profile fetch failed (${status}).` };
  return {
    login: body.login,
    name: body.name || body.login,
    bio: body.bio || '',
    location: body.location || '',
    avatar_url: body.avatar_url || '',
    html_url: body.html_url || `https://github.com/${username}`,
    public_repos: body.public_repos ?? 0,
    total_private_repos: body.total_private_repos ?? null,
    followers: body.followers ?? 0,
    following: body.following ?? 0,
    created_at: body.created_at || '',
    blog: body.blog || '',
    company: body.company || '',
  };
}

// Returns the actual public repos of a GitHub user (fresh from API).
async function listUserRepos(usernameInput, limit = 30) {
  const username = cleanUsername(usernameInput);
  if (!username) return { error: 'empty_username', message: 'Username empty.' };
  const per = Math.min(Math.max(parseInt(limit) || 30, 1), 100);
  const { status, body } = await fetchGH(`/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=${per}`, 15000);
  if (status === 0) return { error: 'network', message: 'GitHub se connect nahi ho paya.' };
  if (status === 403) return { error: 'rate_limit', message: 'GitHub rate limit hit. Thodi der baad try karo, ya GITHUB_TOKEN laga do.' };
  if (status === 404) return { error: 'not_found', message: `GitHub pe "${username}" jaise user nahi mila.` };
  if (status !== 200) return { error: 'api', status, message: `GitHub repos fetch failed (${status}).` };
  const repos = (Array.isArray(body) ? body : []).map(r => ({
    full_name: r.full_name,
    html_url: r.html_url,
    name: r.name,
    description: r.description,
    language: r.language,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    fork: !!r.fork,
    updated_at: r.updated_at,
  }));
  return { repos, count: repos.length };
}

// ═══════════════════════════════════════════════════════════
// PROFILE DEEP-SCAN — GitHub person → combined overview + per-repo cards
// "All repos that person has, combined into one explanation box,
//  then one card per repo with stars + commits + README summary."
// ═══════════════════════════════════════════════════════════

function parseLastPageFromLink(link) {
  const m = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link || '');
  return m ? parseInt(m[1], 10) : 0;
}

// Total commit count for a repo via the Link header of /commits?per_page=1
async function getCommitCount(owner, repo) {
  const { status, body, link } = await fetchGH(`/repos/${owner}/${repo}/commits?per_page=1`, 15000);
  if (status !== 200) return null;
  const last = parseLastPageFromLink(link);
  if (last > 0) return last;
  return Array.isArray(body) ? body.length : 0;
}

// Full README of a repo via the contents API (auto-detects name, base64)
async function fetchReadmeText(owner, repo) {
  const { status, body } = await fetchGH(`/repos/${owner}/${repo}/readme`, 15000);
  if (status !== 200 || !body || !body.content) return '';
  try {
    return Buffer.from(body.content, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

const profileCache = new Map();

/**
 * getUserProfileFull(username) →
 * { status:'ok', profile, overview, repos[{.., commits, summary}], stats, meta }
 * Scrapes ALL public repos of the person (paginated), fetches commit counts,
 * reads READMEs (up to PROFILE_NODE_CHARS total ≈ 70000), then one LLM call
 * produces the combined overview + a short summary per repo.
 */
async function getUserProfileFull(usernameInput, opts = {}) {
  const username = cleanUsername(usernameInput);
  if (!username) return { error: 'empty_username', message: 'Username / GitHub profile link required.' };

  const cacheKey = username;
  const cached = opts.fresh ? null : profileCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL) return cached.data;

  const profile = await getUserProfile(username);
  if (profile.error) return profile;

  // 1) Fetch ALL public repos (paginated, up to 10 pages)
  const allRepos = [];
  const perPage = 100;
  const cap = Math.min(Math.max(parseInt(opts.capRepos) || PROFILE_REPO_CAP, 1), 200);
  let page = 1;
  while (page <= 10) {
    const { status, body, link } = await fetchGH(`/users/${username}/repos?sort=updated&per_page=${perPage}&page=${page}`, 20000);
    if (status === 403) {
      if (!allRepos.length) return { error: 'rate_limit', message: 'GitHub API rate limit hit. Thodi der baad try karo ya .env me GITHUB_TOKEN laga do (60/hr anonymous → 5000/hr).' };
      break;
    }
    if (status !== 200 || !Array.isArray(body) || body.length === 0) break;
    allRepos.push(...body);
    const last = parseLastPageFromLink(link);
    if (last <= page) break;
    page++;
  }

  const repos = allRepos.slice(0, cap).map(r => ({
    name: r.name,
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description || '',
    language: r.language || 'n/a',
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    fork: !!r.fork,
    updated_at: r.updated_at,
    default_branch: r.default_branch || 'main',
  }));
  const topSorted = [...repos].sort((a, b) => b.stars - a.stars);

  // 2) Commit counts — best effort for every scraped repo (break on rate limit)
  let rateLimited = false;
  for (const r of topSorted) {
    if (rateLimited) break;
    const c = await getCommitCount(username, r.name);
    if (c === null) rateLimited = true;
    else r.commits = c;
  }

  // 3) READMEs — top repos by stars, aggregated up to ~70000 chars
  let contentBudget = 0;
  const readmes = [];
  for (const r of topSorted) {
    if (contentBudget >= PROFILE_NODE_CHARS) break;
    const text = await fetchReadmeText(username, r.name);
    if (text) {
      readmes.push({ repo: r.full_name, stars: r.stars, text });
      contentBudget += text.length;
    }
  }

  // 4) One LLM call: combined overview + per-repo README summaries
  let overview = '';
  const repoSummaries = new Map();
  try {
    const llm = require('./llmService');
    const repoList = topSorted.map((r, i) => `${i + 1}. "${r.full_name}"${r.description ? ' — ' + r.description.slice(0, 140) : ''} | ${r.language} | ⭐${r.stars}`).join('\n');
    const readmeBlock = readmes
      .map((rm, i) => `◆ ${i + 1}. [${rm.repo}] (⭐${rm.stars})\n${rm.text.slice(0, 12000)}`)
      .join('\n\n---\n\n');

    const res = await llm.callLLM({
      role: 'review',
      messages: [
        {
          role: 'system',
          content: `You are Ek Sathi, a GitHub profile analyst. You just deep-scraped a developer's GitHub profile. Reply ONLY clean JSON (no fences, no backticks).
Return EXACTLY this shape:
{
  "overview": "3-5 punchy sentences: overall what this developer builds, main themes + tech skills, work personality — combine profile bio + repo names/descriptions + READMEs.",
  "repos": [
    { "id": "owner/repo", "summary": "2 short sentences: what the repo does + the tech stack used (base on README if present, else name/description)" }
  ]
}
Rules:
- "id" MUST exactly match one of the repo names below.
- Only include repos listed below. Include EVERY repo.
- If a repo has no README, write summary from its name/description.`,
        },
        {
          role: 'user',
          content: `USER: ${profile.name || username}
BIO: ${profile.bio || 'no bio'}
LOCATION: ${profile.location || 'n/a'}
FOLLOWERS: ${profile.followers}

REPOS (${topSorted.length}):
${repoList}

README CONTENT (top ${readmes.length} repos by stars, budget ~${PROFILE_NODE_CHARS} chars):
${readmeBlock || 'No READMEs were retrievable — summarize from names/descriptions only.'}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const raw = res.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    overview = String(parsed.overview || '').trim();
    if (Array.isArray(parsed.repos)) {
      parsed.repos.forEach(rp => {
        if (rp && rp.id && rp.summary) repoSummaries.set(String(rp.id).trim(), String(rp.summary).trim());
      });
    }
  } catch (e) {
    console.warn('[RepoService] Profile overview LLM failed:', e.message);
  }

  if (!overview) {
    overview = `${profile.name || username} is a GitHub developer with ${repos.length} public repo${repos.length === 1 ? '' : 's'} (${topSorted.filter(r => r.stars > 0).length} starred). Open GitHub profile for the full history.`;
  }

  // 5) Final robots
  const finalRepos = topSorted.map(r => ({
    name: r.name,
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description,
    language: r.language,
    stars: r.stars,
    forks: r.forks,
    commits: r.commits !== undefined ? r.commits : null,
    updated_at: r.updated_at,
    summary: repoSummaries.get(r.full_name) || (r.description ? r.description.slice(0, 240) : 'No README / description available.'),
  }));

  // 6) Aggregate stats
  const langCount = {};
  repos.forEach(r => { if (r.language && r.language !== 'n/a') langCount[r.language] = (langCount[r.language] || 0) + 1; });
  const topLanguages = Object.entries(langCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, n]) => `${l}×${n}`).join(', ');

  const result = {
    status: 'ok',
    profile: {
      login: profile.login,
      name: profile.name,
      bio: profile.bio,
      location: profile.location,
      avatar_url: profile.avatar_url,
      html_url: profile.html_url,
      publicRepos: profile.public_repos,
      followers: profile.followers,
      following: profile.following,
      created_at: profile.created_at,
      blog: profile.blog,
      company: profile.company,
    },
    overview,
    repos: finalRepos,
    stats: {
      totalRepos: repos.length,
      totalStars: repos.reduce((s, r) => s + r.stars, 0),
      totalForks: repos.reduce((s, r) => s + r.forks, 0),
      topLanguages,
      readmesSummarized: readmes.length,
      contentChars: contentBudget,
    },
    meta: { scrapedAt: new Date().toISOString(), auth: GITHUB_TOKEN ? 'token' : 'anonymous' },
  };

  profileCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

/**
 * explainRepo(analysis) — LLM narrative for the pop-out repo card.
 * Uses the deep analysis from analyzeRepo() (files + README actually read).
 */
async function explainRepo(analysis) {
  if (!analysis || analysis.status !== 'ok') {
    return { status: 'error', message: (analysis && analysis.message) || 'Repo analyze nahi hua.' };
  }
  try {
    const llm = require('./llmService');
    const res = await llm.callLLM({
      role: 'review',
      messages: [
        {
          role: 'system',
          content: `You are Ek Sathi, a friendly GitHub repo explainer. Your job: take the deep repo analysis below and write a clear, structured markdown explanation of the repo. Base EVERYTHING only on the data given — NEVER invent features, files, or commands that are not present.
Structure:
## 💡 Idea & Purpose — what the project is, what problem it solves
## ⚙️ How It Works — architecture flow in plain words (no code dumps)
## 🧰 Tech Stack — languages, frameworks, dependencies (explicit list from data)
## 📂 Key Files — the actual files read and what each does (markdown list, 1 line each, only real files)
## 🚀 Setup / Run — only if README or package scripts show it (exact commands from data)
Be concise and practical. Hinglish light is fine.`,
        },
        {
          role: 'user',
          content: analysis.context || JSON.stringify(analysis).slice(0, 4000),
        },
      ],
      temperature: 0.3,
      max_tokens: 1200,
    });
    return { status: 'ok', explanation: res.text.trim(), repo: analysis.repo, readCount: analysis.readCount || 0 };
  } catch (e) {
    console.warn('[RepoService] explainRepo failed:', e.message);
    return { status: 'error', message: 'Explanation LLM failed: ' + e.message };
  }
}

module.exports = { extractRepoUrls, analyzeRepo, getRepoInfo, searchRepos, getUserProfileFull, explainRepo, getUserProfile, listUserRepos, answerRepoQuestion };
