/* ═══════════════════════════════════════════════════════════
   EK SATHI — AI Companion for Learning & Growth
   Frontend app (v7): Chat + Hackathon/Internship Discovery + Study
   Frontend is 100% localhost; all auth is local (Bearer dev-local).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const API = '';               // relative API base (same origin)
const TOKEN = 'dev-local';    // local-only auth token

/* ── State ─────────────────────────────────────────────── */
let currentSessionId = null;
let sessions = [];
let discoverCards = [];
let attachedFiles = [];       // [{ id, name, size }] to attach to next chat msg

const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── API helpers ───────────────────────────────────────── */
async function apiFetch(url, opts = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) };
  const res = await fetch(API + url, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

/* ── Navigation ────────────────────────────────────────── */
function showView(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'hackathon') loadDiscoverCards();
}

/* ── Sessions ──────────────────────────────────────────── */
async function loadSessions() {
  try {
    const data = await apiFetch('/api/sessions');
    sessions = data.sessions || [];
    renderSessions();
  } catch (err) { console.error(err); }
}

function renderSessions() {
  const list = $('sessions-list');
  if (!sessions.length) {
    list.innerHTML = '<div class="sessions-empty">No chats yet</div>';
    return;
  }
  list.innerHTML = sessions.map((s) => `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" data-id="${escHtml(s.id)}">
      <div class="session-title">${escHtml(s.title || 'Untitled')}</div>
      <button class="btn-delete-session" title="Delete chat" data-del="${escHtml(s.id)}">🗑</button>
    </div>`).join('');
  list.querySelectorAll('.session-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-delete-session')) return;
      switchSession(el.dataset.id);
    });
  });
  list.querySelectorAll('.btn-delete-session').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      if (!confirm('Delete this chat?')) return;
      try {
        await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
        if (currentSessionId === id) { currentSessionId = null; resetChatUI(); }
        await loadSessions();
      } catch (err) { alert(err.message); }
    });
  });
}

async function createSession() {
  const data = await apiFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  sessions.unshift(data.session);
  renderSessions();
  return data.session.id;
}

async function switchSession(id) {
  currentSessionId = id;
  renderSessions();
  $('chat-session-title').textContent = (sessions.find((s) => s.id === id) || {}).title || 'Chat';
  const typing = document.querySelector('.typing-indicator');
  if (typing) typing.remove();
  try {
    const data = await apiFetch(`/api/sessions/${id}/messages`);
    renderMessages(data.messages || []);
  } catch (err) {
    console.error(err);
    renderMessages([]);
  }
}

function resetChatUI() {
  currentSessionId = null;
  $('chat-session-title').textContent = 'New Chat';
  const welcome = `
    <div id="welcome-screen" class="welcome-screen">
      <div class="welcome-orb">🦉</div>
      <h1 class="welcome-title">Hi, I'm Ek Sathi</h1>
      <p class="welcome-sub">Your AI Companion for Learning & Growth</p>
      <div class="welcome-suggestions">
        <button class="welcome-chip">Explain a coding concept</button>
        <button class="welcome-chip">Help me debug this code</button>
        <button class="welcome-chip">What should I learn next?</button>
        <button class="welcome-chip">Build me a study plan</button>
      </div>
    </div>`;
  $('messages-container').innerHTML = welcome;
  bindWelcomeChips();
}

/* ── Chat: message rendering ───────────────────────────── */
function scrollToBottom(container = $('messages-container')) {
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function mdToHtml(md) {
  if (typeof marked !== 'undefined') return marked.parse(String(md || ''), { breaks: true, gfm: true });
  return escHtml(md);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function appendMessage(role, text, container) {
  const c = container || $('messages-container');
  const welcome = c.querySelector('#welcome-screen');
  if (welcome) welcome.remove();
  const row = document.createElement('div');
  row.className = `message-row ${role === 'user' ? 'user' : 'assistant'}`;
  row.innerHTML = `
    <div class="message-bubble-wrapper">
      <div class="message-bubble">${mdToHtml(text)}</div>
      <div class="message-time-badge">${role === 'user' ? 'You' : 'Ek Sathi'}</div>
    </div>`;
  c.appendChild(row);
  enhanceRenderedBubbles(row);
  scrollToBottom(c);
  return row;
}

function renderMessages(messages) {
  const c = $('messages-container');
  if (!messages?.length) { resetChatUI(); return; }
  c.innerHTML = '';
  messages.forEach((m) => appendMessage(m.role, m.content, c));
}

/* Render advanced blocks (charts & mermaid) inside a message bubble */
function enhanceRenderedBubbles(root) {
  root.querySelectorAll('.message-bubble').forEach((bubble) => {
    bubble.querySelectorAll('pre.language-mermaid, code.language-mermaid').forEach((node) => {
      const pre = node.closest('pre') || node;
      pre.className = 'mermaid-src';
      try {
        const code = node.textContent.trim();
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid';
        wrapper.textContent = code;
        pre.replaceWith(wrapper);
        if (window.mermaid) mermaid.run({ nodes: [wrapper] }).catch(() => {});
      } catch (e) {}
    });
    bubble.querySelectorAll('pre.language-chart').forEach((pre) => {
      try {
        const cfg = JSON.parse(pre.textContent);
        if (!cfg || !cfg.type) return;
        const wrap = document.createElement('div');
        wrap.style.marginTop = '10px';
        wrap.innerHTML = '<canvas style="max-width:100%"></canvas>';
        pre.replaceWith(wrap);
        new Chart(wrap.querySelector('canvas'), {
          type: cfg.type,
          data: cfg.data,
          options: cfg.options || { responsive: true },
        });
      } catch (e) {}
    });
  });
}

/* ── Chat: typing indicator ────────────────────────────── */
function addTyping(container = $('messages-container')) {
  const welcome = container.querySelector('#welcome-screen');
  if (welcome) welcome.remove();
  const row = document.createElement('div');
  row.className = 'message-row assistant typing-fade';
  row.innerHTML = `
    <div class="message-bubble-wrapper">
      <div class="message-bubble">
        <div class="typing-indicator"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="typing-label">Ek Sathi soch raha hai…</span></div>
      </div>
    </div>`;
  container.appendChild(row);
  scrollToBottom(container);
  return row;
}

/* ── Chat: file attach ─────────────────────────────────── */
function bindAttach() {
  $('attach-btn').addEventListener('click', () => $('file-upload-input').click());
  $('file-upload-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      const data = await apiFetch('/api/files/upload', { method: 'POST', body: fd });
      const uploaded = data.files || (data.file ? [data.file] : []);
      uploaded.forEach((f) => {
        attachedFiles.push({ id: f.id, name: f.originalName || f.name || 'file', size: f.sizeBytes || 0 });
      });
      renderFileChips();
    } catch (err) { alert('Upload failed: ' + err.message); }
  });
}

function renderFileChips() {
  const row = $('file-chip-row');
  if (!attachedFiles.length) { row.innerHTML = ''; return; }
  row.innerHTML = attachedFiles.map((f, i) => `
    <span class="file-chip" title="${escHtml(f.name)}">
      📎 ${escHtml(f.name)}
      <button data-i="${i}" class="file-chip-x">✕</button>
    </span>`).join('');
  row.querySelectorAll('.file-chip-x').forEach((b) => b.addEventListener('click', () => {
    attachedFiles.splice(Number(b.dataset.i), 1);
    renderFileChips();
  }));
}

function clearAttachments() {
  attachedFiles = [];
  renderFileChips();
}

/* ── Chat: send ────────────────────────────────────────── */
async function sendMessage() {
  const input = $('message-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  $('send-btn').disabled = true;
  if (!currentSessionId) currentSessionId = await createSession();
  const docs = attachedFiles.map((f) => ({ id: f.id, name: f.name }));
  appendMessage('user', text);
  clearAttachments();
  const typing = addTyping();
  try {
    const model = $('model-selector').value || undefined;
    const data = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSessionId, message: text, model, documents: docs.length ? docs : undefined }),
    });
    typing.remove();
    if (data.updatedTitle) {
      $('chat-session-title').textContent = data.updatedTitle;
      const s = sessions.find((x) => x.id === currentSessionId);
      if (s) s.title = data.updatedTitle;
      renderSessions();
    }
    appendMessage('assistant', data.reply || '…');
  } catch (err) {
    typing.remove();
    appendMessage('assistant', '⚠️ ' + (err.message || 'Something went wrong.'));
  } finally {
    $('send-btn').disabled = false;
    $('message-input').focus();
  }
}

/* ── Welcome chips ─────────────────────────────────────── */
function bindWelcomeChips() {
  const chips = document.querySelectorAll('.welcome-chip');
  chips.forEach((c) => c.addEventListener('click', () => {
    $('message-input').value = c.textContent.trim();
    sendMessage();
  }));
}

/* ── Discovery: Hackathon Lab ──────────────────────────── */
const DISCOVER_STATUS = $('scan-status');

function setScanStatus(text, busy) {
  if (!DISCOVER_STATUS) return;
  DISCOVER_STATUS.textContent = text;
  DISCOVER_STATUS.classList.toggle('busy', !!busy);
}

async function loadDiscoverCards() {
  try {
    const data = await apiFetch('/api/hackathons/discover');
    discoverCards = data.cards || [];
    const meta = data.meta || {};
    if (meta.nextRunAt) {
      setScanStatus(`📥 ${discoverCards.length} live candidates · next auto-scan ${new Date(meta.nextRunAt).toLocaleString()}`, false);
    } else {
      setScanStatus(`📥 ${discoverCards.length} live candidates`, false);
    }
    renderDiscoverGrid();
  } catch (err) {
    console.error(err);
    setScanStatus('⚠️ ' + err.message, false);
    $('discover-grid').innerHTML = `<div class="d-card-empty">Could not load discoveries.</div>`;
  }
}

async function scanNow() {
  const btn = $('hack-scan-btn');
  btn.disabled = true;
  setScanStatus('⏳ Scraping Devpost · Unstop · Devfolio · HackerEarth · MLH · Internshala…', true);
  try {
    const data = await apiFetch('/api/hackathons/discover/run', { method: 'POST' });
    if (data.paused) {
      setScanStatus('⏸ Discovery is paused.', false);
    } else if (data.skipped) {
      setScanStatus(`⏳ Already scanned · next at ${new Date(data.nextRunAt).toLocaleString()}`, false);
    } else {
      setScanStatus(`✅ +${data.added} new live opportunities · next at ${new Date(data.nextRunAt).toLocaleString()}`, false);
    }
    await loadDiscoverCards();
  } catch (err) {
    setScanStatus('⚠️ ' + err.message, false);
  } finally {
    btn.disabled = false;
  }
}

function filteredCards() {
  const q = ($('discover-filter').value || '').trim().toLowerCase();
  const src = $('discover-source-filter').value;
  const type = $('discover-type-filter').value;
  return discoverCards.filter((c) => {
    if (src && c.platform !== src) return false;
    if (type && (c.type || 'hackathon') !== type) return false;
    if (!q) return true;
    const hay = `${c.title} ${c.summary || ''} ${c.prize || ''} ${(c.tags || []).join(' ')} ${c.platform} ${c.type || ''}`.toLowerCase();
    return hay.includes(q);
  });
}

function cardDateLabel(c) {
  if (c.registrationDeadline) return `⏰ Reg closes ${String(c.registrationDeadline).slice(0, 10)}`;
  if (c.startDate) return `🚀 ${String(c.startDate).slice(0, 10)} ${c.endDate ? '→ ' + String(c.endDate).slice(0, 10) : ''}`;
  return '';
}

function renderDiscoverGrid() {
  const grid = $('discover-grid');
  const list = filteredCards();
  if (!list.length) {
    const q = ($('discover-filter').value || '').trim() || ($('discover-source-filter').value) || ($('discover-type-filter').value);
    grid.innerHTML = `<div class="d-card-empty">${
      discoverCards.length
        ? 'No cards match the current filter.'
        : (q ? 'Scanning nahi hua abhi — "🔄 Scan Now" dabao.' : 'No live opportunities yet — hit "🔄 Scan Now" to scrape real data.')}</div>`;
    return;
  }
  grid.innerHTML = list.map((c) => {
    const isIntern = (c.type || 'hackathon') === 'internship';
    const badge = c.typeDisplay || (isIntern ? '💼 INTERNSHIP' : '🏆 HACKATHON');
    const metaBits = [
      c.mode ? c.mode : '',
      c.location ? c.location : '',
      isIntern ? (c.stipend ? `, stipend ${c.stipend}` : '') : (c.fee ? `, ${c.fee}` : ''),
      isIntern && c.duration ? `, ${c.duration}` : '',
      !isIntern && c.seatsStatus ? `, ${c.seatsStatus}` : '',
    ].join(' | ').replace(/^\s*\|\s*/, '');
    return `
      <div class="d-card" data-id="${escHtml(c.id)}">
        <div class="d-card-head">
          <div>
            <div class="d-card-title">${escHtml(c.title || 'Untitled')}</div>
            <div class="d-card-source ${escHtml(c.platform || '')}">${escHtml(badge)} · ${escHtml(c.platform || '')}</div>
          </div>
        </div>
        <div class="d-card-body">
          ${c.summary ? `<p>${escHtml(c.summary)}</p>` : ''}
          ${c.whatToBuild ? `<p style="margin-top:6px"><strong>What to build:</strong> ${escHtml(c.whatToBuild)}</p>` : ''}
          ${c.prize ? `<p style="margin-top:6px"><span class="d-prize">💰 ${escHtml(c.prize)}</span></p>` : ''}
          ${isIntern && c.company ? `<p style="margin-top:4px">🏢 ${escHtml(c.company)}</p>` : ''}
          ${metaBits ? `<p style="margin-top:6px">📍 ${escHtml(metaBits)}</p>` : ''}
          ${cardDateLabel(c) ? `<p style="margin-top:4px">${escHtml(cardDateLabel(c))}</p>` : ''}
        </div>
        ${(c.tags && c.tags.length) ? `<div class="d-card-meta">${c.tags.slice(0, 6).map((t) => `<span class="d-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="d-card-foot">
          ${c.link ? `<a class="d-link" href="${escHtml(c.link)}" target="_blank" rel="noopener">🔗 View details ↗</a>` : ''}
          <div class="d-card-actions">
            <button class="btn-ghost" data-save="${escHtml(c.id)}">💾 Save</button>
            <button class="btn-ghost-red" data-dismiss="${escHtml(c.id)}">✕ Dismiss</button>
          </div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.save;
    try {
      await apiFetch(`/api/hackathons/discover/${id}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participating: false }) });
      await loadDiscoverCards();
    } catch (err) { alert('Save failed: ' + err.message); }
  }));
  grid.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.dismiss;
    try {
      await apiFetch(`/api/hackathons/discover/${id}/dismiss`, { method: 'POST' });
      await loadDiscoverCards();
    } catch (err) { alert('Dismiss failed: ' + err.message); }
  }));
}

/* ── Study: GitHub Profile (deep scan) ───────────────── */
async function analyzeGithubProfile() {
  const raw = $('github-input').value.trim();
  if (!raw) return;
  const res = $('github-results');

  let username = '';
  const urlMatch = raw.match(/github\.com\/([A-Za-z0-9_.-]+)/i);
  if (urlMatch) username = urlMatch[1];
  else if (/^[A-Za-z0-9_.-]+$/.test(raw) && raw.length <= 80) username = raw;
  else { res.innerHTML = '<div class="empty-msg">⚠️ Invalid input — use https://github.com/username or just a GitHub username.</div>'; return; }

  res.innerHTML = '<div class="empty-msg">⏳ GitHub profile scrape ho raha hai — sab public repos scan ho rahe hain (≈30s)…</div>';
  $('github-qa').style.display = 'none';
  try {
    const data = await apiFetch(`/api/study/github/profile?username=${encodeURIComponent(username)}`);
    if (data.error) { res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(data.message || data.error)}</div>`; return; }
    window._ghProfile = data;
    renderGithubProfile(data);
  } catch (err) {
    res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
  }
}

function renderGithubProfile(data) {
  const res = $('github-results');
  const p = data.profile || {};
  const s = data.stats || {};
  const repos = data.repos || [];

  const LANG_CLR = { JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572a5', Java:'#b07219', Go:'#00ADD8', Rust:'#dea584', C:'#555555', 'C++':'#f34b7d', Ruby:'#701516', PHP:'#4F5D95', Swift:'#F05138', Kotlin:'#A97BFF', HTML:'#e34c26', CSS:'#563d7c', Dart:'#00B4AB', Shell:'#89e051', Vue:'#41b883', Svelte:'#ff3e00', Jupyter:'#DA5B0B' };

  const profileHtml = `
    <div class="gh-profile-overview">
      <div class="gh-profile-top">
        ${p.avatar_url ? `<img class="gh-avatar" src="${escHtml(p.avatar_url)}" alt="">` : ''}
        <div class="gh-profile-info">
          <h3 style="margin:0">${escHtml(p.name || p.login || '')}</h3>
          <p class="gh-bio" style="margin:4px 0 0;font-size:12px;color:var(--text2)">
            @${escHtml(p.login || '')}${p.location ? ' · ' + escHtml(p.location) : ''}${p.company ? ' · ' + escHtml(p.company) : ''}
            ${p.blog ? ` · <a href="${escHtml(p.blog)}" target="_blank" rel="noopener" style="color:var(--accent)">website</a>` : ''}
          </p>
          ${p.bio ? `<p class="ws-item-sub" style="margin-top:6px;font-style:italic">${escHtml(p.bio)}</p>` : ''}
          <div class="gh-stats-row">
            <span>📦 ${s.totalRepos ?? repos.length} repos</span>
            <span>⭐ ${s.totalStars ?? 0} stars</span>
            <span>⑂ ${s.totalForks ?? 0} forks</span>
            <span>👥 ${p.followers ?? 0} followers</span>
            ${s.topLanguages ? `<span>🧬 ${escHtml(s.topLanguages)}</span>` : ''}
          </div>
        </div>
      </div>
      ${data.overview ? `<div class="gh-overview-text">${mdToHtml(data.overview)}</div>` : ''}
      <p class="ws-item-sub" style="margin-top:8px;font-size:11px;opacity:0.7">
        Scraped ${s.readmesSummarized ?? 0} READMEs · ${(s.contentChars ?? 0).toLocaleString()} chars
        ${data.meta?.auth === 'token' ? ' · 🔑 authenticated' : ' · anonymous'}
      </p>
    </div>`;

  let cardsHtml = '<div class="gh-repo-grid">';
  repos.forEach(r => {
    const color = LANG_CLR[r.language] || '#8b8b8b';
    cardsHtml += `
      <div class="gh-repo-card" onclick="openRepoModal('${escHtml(r.full_name).replace(/'/g, "\\'")}')">
        <div class="gh-repo-card-head">
          <span class="gh-lang-dot" style="background:${color}"></span>
          <h4 class="gh-repo-name">${escHtml(r.name)}</h4>
          <div class="gh-repo-badges">
            <span class="gh-badge">⭐ ${r.stars ?? 0}</span>
            <span class="gh-badge">⑂ ${r.forks ?? 0}</span>
            ${r.commits != null ? `<span class="gh-badge">📝 ${r.commits}</span>` : ''}
          </div>
        </div>
        <p class="ws-item-sub" style="margin:0">${escHtml(r.description ? r.description.slice(0, 130) : 'No description')}</p>
        ${r.summary ? `<p class="gh-repo-summary">${escHtml(r.summary.slice(0, 220))}</p>` : ''}
        <div class="gh-repo-card-foot">
          <span class="gh-lang-badge" style="background:${color}20;color:${color}">${escHtml(r.language)}</span>
          <span class="gh-view-link">View Details →</span>
        </div>
      </div>`;
  });
  cardsHtml += '</div>';

  res.innerHTML = profileHtml + cardsHtml;
}

async function openRepoModal(fullName) {
  let overlay = $('gh-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'gh-modal-overlay';
    overlay.className = 'gh-modal-overlay';
    overlay.innerHTML = `
      <div class="gh-modal">
        <button class="gh-modal-close" onclick="closeRepoModal()">✕</button>
        <div id="gh-modal-header"></div>
        <div class="gh-modal-body" id="gh-modal-body"></div>
        <div class="gh-modal-qa" id="gh-modal-qa" style="display:none">
          <input id="gh-modal-question" class="ws-chat-input" placeholder="Ask about this repo…" style="flex:1">
          <button id="gh-modal-ask-btn" class="btn-small" onclick="askModalRepo()">Ask</button>
        </div>
        <div id="gh-modal-messages" class="ws-chat-messages" style="max-height:260px;overflow-y:auto;display:none"></div>
      </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeRepoModal(); });
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  window._ghModalRepo = fullName;

  $('gh-modal-header').innerHTML = `<h3 style="margin:0 0 4px">📦 ${escHtml(fullName)}</h3>
    <a class="d-link" href="https://github.com/${escHtml(fullName)}" target="_blank" rel="noopener">Open on GitHub ↗</a>`;
  $('gh-modal-body').innerHTML = '<div class="empty-msg">⏳ Full repo analysis — README + key source files read…</div>';
  $('gh-modal-qa').style.display = 'none';
  $('gh-modal-messages').style.display = 'none';
  $('gh-modal-messages').innerHTML = '';

  try {
    const data = await apiFetch('/api/study/github/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://github.com/${fullName}` }) });
    if (data.status === 'ok') {
      $('gh-modal-body').innerHTML = mdToHtml(data.explanation || 'No explanation generated.');
      $('gh-modal-qa').style.display = 'flex';
    } else {
      $('gh-modal-body').innerHTML = `<div class="empty-msg">⚠️ ${escHtml(data.message || 'Analysis failed')}</div>`;
    }
  } catch (err) {
    $('gh-modal-body').innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
  }
}

function closeRepoModal() {
  const o = $('gh-modal-overlay');
  if (o) o.style.display = 'none';
}

async function askModalRepo() {
  const q = $('gh-modal-question').value.trim();
  const repo = window._ghModalRepo;
  if (!q || !repo) return;
  $('gh-modal-question').value = '';
  const msgs = $('gh-modal-messages');
  msgs.style.display = 'flex';
  hackMsgInto(msgs, 'user', q);
  const typing = hackMsgInto(msgs, 'assistant', '⏳ Looking for answer…');
  try {
    const data = await apiFetch('/api/study/github/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://github.com/${repo}`, question: q }) });
    typing.remove();
    if (data.status === 'ok') hackMsgInto(msgs, 'assistant', data.answer || '…');
    else hackMsgInto(msgs, 'assistant', '⚠️ ' + (data.message || 'No answer found.'));
  } catch (err) {
    typing.remove();
    hackMsgInto(msgs, 'assistant', '⚠️ ' + err.message);
  }
}

async function askGitHub() {
  const q = $('github-question').value.trim();
  const input = $('github-input').value.trim();
  if (!q || !input) { alert('Pehle repo analyze karo, phir sawaal likho.'); return; }
  $('github-question').value = '';
  const isUrl = /^https?:\/\//i.test(input);
  hackMsgInto($('github-messages'), 'user', q);
  const typing = hackMsgInto($('github-messages'), 'assistant', '⏳ Sawaal ka jawab dhoondh raha hu…');
  try {
    const data = await apiFetch('/api/study/github/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: isUrl ? input : undefined, text: isUrl ? undefined : input, question: q }) });
    typing.remove();
    if (data.status === 'ok') hackMsgInto($('github-messages'), 'assistant', data.answer || '…');
    else hackMsgInto($('github-messages'), 'assistant', '⚠️ ' + (data.message || 'Jawab nahi mila'));
  } catch (err) {
    typing.remove();
    hackMsgInto($('github-messages'), 'assistant', '⚠️ ' + err.message);
  }
}

/* ── Study: Website (beast deep-scan) ───────────────────── */
async function analyzeWebsite() {
  const url = $('website-input').value.trim();
  if (!url) return;
  const res = $('website-results');
  res.innerHTML = '<div class="empty-msg">⏳ Deep website scrape ho raha hai — home + internal pages + CSS scan (≈20-30s)…</div>';
  try {
    const data = await apiFetch('/api/study/website', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (data.status !== 'ok') {
      res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(data.message || 'Website scrape nahi ho paya')}</div>`;
      return;
    }
    const d = data;
    const stack = d.stack || {};
    const design = d.design || {};
    const swatches = (design.colors || []).map((c, i) => {
      const token = (design.tokens || []).find(t => t.color === c.hex);
      return `<span class="site-swatch" style="background:${c.hex}" title="${escHtml(c.hex)} ×${c.count}${token ? ' · --' + escHtml(token.name) : ''}">
        <span class="site-swatch-label">${escHtml(c.hex)}${token ? ' <b>--' + escHtml(token.name) + '</b>' : ''}</span></span>`;
    }).join('');

    const chipRow = (label, items) => {
      const arr = Array.isArray(items) ? items.filter(Boolean) : [];
      return arr.length ? `<div class="site-chip-row"><span class="site-chip-label">${label}</span>${arr.map(x => `<span class="site-chip">${escHtml(String(x))}</span>`).join('')}</div>` : '';
    };

    const fontsRow = (design.fonts || []).map(f => `<span class="site-chip site-chip-font">🔤 ${escHtml(f.name)}<i> ×${f.weight}</i></span>`).join('');
    const pagesRow = (d.pages || []).slice(0, 12).map(p => {
      const u = p.url || '';
      return `<a class="site-page-link" href="${escHtml(u)}" target="_blank" rel="noopener">${escHtml(p.title || u)} ↗</a>`;
    }).join('');

    res.innerHTML = `
      <div class="gh-profile-overview">
        <div class="gh-profile-top">
          ${d.favicon ? `<img class="site-favicon" src="${escHtml(d.favicon)}" onerror="this.style.display='none'" alt=""/>` : '<span class="site-favicon site-favicon-empty">🌐</span>'}
          <div class="gh-profile-info">
            <h3 style="margin:0 0 2px">🌐 ${escHtml(d.title || d.url || url)}</h3>
            ${d.description ? `<p class="ws-item-sub" style="margin:0 0 4px">${escHtml(d.description)}</p>` : ''}
            <p class="ws-item-sub" style="margin:0">${escHtml(d.scrapeMeta || '')} ${(d.jsonLdTypes || []).length ? '· <b>JSON-LD:</b> ' + escHtml(d.jsonLdTypes.slice(0, 4).join(', ')) : ''}</p>
          </div>
        </div>
        ${chipRow('🧩 Frameworks', [...(stack.frameworks || []), ...(stack.cms || []), ...(stack.ssg || [])])}
        ${chipRow('🎨 Styling', stack.styling)}
        ${chipRow('📚 Libraries', stack.libraries)}
        ${chipRow('⚙️ Runtime', stack.runtime)}
        ${swatches ? `<div class="site-chip-row"><span class="site-chip-label">🎨 Color palette (${(design.colors || []).length})</span><span class="site-swatch-row">${swatches}</span></div>` : ''}
        ${fontsRow ? `<div class="site-chip-row"><span class="site-chip-label">🔤 Fonts (${(design.fonts || []).length})</span>${fontsRow}</div>` : ''}
        ${pagesRow ? `<div class="site-chip-row site-pages-row"><span class="site-chip-label">📄 Pages (${(d.pages || []).length})</span><span class="site-pages">${pagesRow}</span></div>` : ''}
        <div class="site-analysis">${d.analysis ? mdToHtml(d.analysis) : '<p class="ws-item-sub">Bhaasha analysis generate nahi ho paya — upar ke extracted facts dekh lo.</p>'}</div>
      </div>`;
    $('website-qa').style.display = 'flex';
    $('website-domain').textContent = d.title || d.url || url;
    $('website-arch').textContent = [...(stack.frameworks || []), ...(stack.cms || []), ...(stack.styling || [])].slice(0, 4).join(', ') || 'website deep-scan';
    $('website-messages').innerHTML = '';
  } catch (err) {
    res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
  }
}

async function askWebsite() {
  const q = $('website-question').value.trim();
  const url = $('website-input').value.trim();
  if (!q || !url) { alert('Pehle website analyze karo, phir sawaal likho.'); return; }
  $('website-question').value = '';
  hackMsgInto($('website-messages'), 'user', q);
  const typing = hackMsgInto($('website-messages'), 'assistant', '⏳ Sawaal ka jawab dhoondh raha hu…');
  try {
    const data = await apiFetch('/api/study/website/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, question: q }) });
    typing.remove();
    if (data.status === 'ok') {
      hackMsgInto($('website-messages'), 'assistant', data.answer || '…');
    } else {
      hackMsgInto($('website-messages'), 'assistant', '⚠️ ' + (data.message || 'Jawab nahi mila'));
    }
  } catch (err) {
    typing.remove();
    hackMsgInto($('website-messages'), 'assistant', '⚠️ ' + err.message);
  }
}

/* shared ws message helper */
function hackMsgInto(container, role, text) {
  const div = document.createElement('div');
  div.className = `ws-msg ${role === 'user' ? 'user' : 'assistant'}`;
  div.innerHTML = `
    <div class="ws-msg-role">${role === 'user' ? 'You' : 'Ek Sathi'}</div>
    <div class="ws-msg-text">${mdToHtml(text)}</div>`;
  container.appendChild(div);
  scrollToBottom(container);
  return div;
}

/* ── Study bind ────────────────────────────────────────── */
function bindStudy() {
  $('github-analyze-btn').addEventListener('click', analyzeGithubProfile);
  $('github-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyzeGithubProfile(); });
  $('website-analyze-btn').addEventListener('click', analyzeWebsite);
  $('website-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyzeWebsite(); });
  $('website-ask-btn').addEventListener('click', askWebsite);
  $('website-question').addEventListener('keydown', (e) => { if (e.key === 'Enter') askWebsite(); });
  document.querySelectorAll('.study-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.study-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const which = tab.dataset.tab;
      document.querySelectorAll('.study-tab-content').forEach((c) => { c.style.display = c.id === `study-${which}` ? 'block' : 'none'; });
    });
  });
}

/* ── Discovery bind ────────────────────────────────────── */
function bindDiscovery() {
  $('hack-scan-btn').addEventListener('click', scanNow);
  $('discover-filter').addEventListener('input', renderDiscoverGrid);
  $('discover-source-filter').addEventListener('change', renderDiscoverGrid);
  $('discover-type-filter').addEventListener('change', renderDiscoverGrid);
}

/* ── Init ──────────────────────────────────────────────── */
function init() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('new-chat-btn').addEventListener('click', () => { resetChatUI(); });
  $('send-btn').addEventListener('click', sendMessage);
  $('message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('message-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 180) + 'px';
  });
  $('model-selector').addEventListener('change', (e) => { localStorage.setItem('preferred_model', e.target.value); });

  const sidebar = $('sidebar');
  if (sidebar) {
    const closeSide = () => sidebar.classList.remove('open');
    const toggleSide = () => sidebar.classList.toggle('open');
    [$('toggle-sidebar-btn'), $('mobile-menu-btn')].forEach((b) => b && b.addEventListener('click', toggleSide));
    document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', closeSide));
  }
  $('logout-btn').addEventListener('click', () => {
    if (confirm('Clear local preferences and reload?')) { localStorage.clear(); location.reload(); }
  });

  bindAttach();
  bindStudy();
  bindDiscovery();
  bindWelcomeChips();
  resetChatUI();

  loadSessions();

  const m = localStorage.getItem('preferred_model');
  if (m) $('model-selector').value = m;
}

document.addEventListener('DOMContentLoaded', init);