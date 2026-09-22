/* ═══════════════════════════════════════════════════════════
   EK SATHI — AI Companion for Learning & Growth
   Frontend app (v7): Chat + Hackathon/Internship Discovery + Study
   Frontend is 100% localhost; all auth is local (Bearer dev-local).
   ═══════════════════════════════════════════════════════════ */
'use strict';

// Automatically determine API base: if opened via file:// or another port, fallback gracefully
const API = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http'))
  ? ''
  : 'http://localhost:3000';
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
  let res;
  try {
    res = await fetch(API + url, { ...opts, headers });
  } catch (netErr) {
    throw new Error(`Failed to connect to backend server (${API || 'localhost:3000'}). Make sure "npm run dev" is running.`);
  }
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
/* ── In-flight request lock ────────────────────────────── */
const _opBusy = {};
function lockOp(name, btn) {
  if (_opBusy[name]) return false;
  _opBusy[name] = true;
  if (btn) btn.disabled = true;
  return true;
}
function unlockOp(name, btn) {
  _opBusy[name] = false;
  if (btn) btn.disabled = false;
}

/* ── Chat send ─────────────────────────────────────────── */
async function sendMessage() {
  const input = $('message-input');
  const text = input.value.trim();
  if (!text) return;
  if (!lockOp('chat', $('send-btn'))) return;
  input.value = '';
  input.style.height = 'auto';
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
    unlockOp('chat', $('send-btn'));
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

function setScanStatus(text, busy) {
  const el = $('scan-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

let savedCards = [];
let _savedActive = false;

async function loadSavedCards() {
  try {
    const data = await apiFetch('/api/hackathons/discover/saved');
    savedCards = data.cards || [];
    renderSavedGrid();
  } catch (err) {
    $('saved-grid').innerHTML = `<div class="d-card-empty">⚠️ ${escHtml(err.message)}</div>`;
  }
}

function renderSavedGrid() {
  const grid = $('saved-grid');
  if (!savedCards.length) {
    grid.innerHTML = `<div class="d-card-empty">Abhi kuch saved nahi hai — Discover me kisi card pe "💾 Save" dabao, phir yahan uska discussion memory ke saath milega.</div>`;
    return;
  }
  grid.innerHTML = savedCards.map((c) => {
    const isIntern = (c.type || 'hackathon') === 'internship';
    const badge = isIntern ? '💼 INTERNSHIP' : '🏆 HACKATHON';
    const metaBits = [
      c.mode ? c.mode : '',
      c.location ? c.location : '',
      isIntern ? (c.stipend ? `, stipend ${c.stipend}` : '') : (c.fee ? `, ${c.fee}` : ''),
      isIntern && c.duration ? `, ${c.duration}` : '',
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
          ${c.prize ? `<p style="margin-top:6px"><span class="d-prize">💰 ${escHtml(c.prize)}</span></p>` : ''}
          ${isIntern && c.company ? `<p style="margin-top:4px">🏢 ${escHtml(c.company)}</p>` : ''}
          ${metaBits ? `<p style="margin-top:6px">📍 ${escHtml(metaBits)}</p>` : ''}
        </div>
        ${(c.tags && c.tags.length) ? `<div class="d-card-meta">${c.tags.slice(0, 6).map((t) => `<span class="d-card-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="d-card-foot">
          ${c.link ? `<a class="d-link" href="${escHtml(c.link)}" target="_blank" rel="noopener">🔗 View details ↗</a>` : ''}
          <div class="d-card-actions">
            <button class="btn-ghost" data-discuss="${escHtml(c.id)}">💬 Discuss${c.discussionCount ? ` · ${c.discussionCount}m` : ''}</button>
          </div>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('[data-discuss]').forEach((b) => b.addEventListener('click', () => {
    const card = savedCards.find((x) => x.id === b.dataset.discuss);
    if (card) openContextChat(subjectFromCard(card), CC_SUGGEST[card.type || 'hackathon'] || CC_SUGGEST.hackathon);
  }));
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
  if (!lockOp('scan', btn)) return;
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
    unlockOp('scan', btn);
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

function fmtDate(val) {
  if (!val) return '';
  const d = new Date(typeof val === 'number' ? val : String(val).slice(0, 10));
  if (isNaN(d)) return String(val).slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function cardDateLabel(c) {
  if (c.registrationDeadline) return `⏰ Reg closes ${fmtDate(c.registrationDeadline)}`;
  if (c.startDate) return `🚀 ${fmtDate(c.startDate)}${c.endDate ? ' → ' + fmtDate(c.endDate) : ''}`;
  return '';
}

function renderDiscoverGrid() {
  const grid = $('discover-grid');
  const list = filteredCards();
  if (!list.length) {
    const q = ($('discover-filter').value || '').trim() || ($('discover-source-filter').value) || ($('discover-type-filter').value);
    grid.innerHTML = `<div class="d-card-empty" style="grid-column:1/-1">${
      discoverCards.length
        ? 'No cards match the current filter.'
        : (q ? 'Scanning nahi hua abhi — "🔄 Scan Now" dabao.' : 'No live opportunities yet — hit "🔄 Scan Now" to scrape real data.')}</div>`;
    return;
  }

  const cardHtml = (c) => {
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
      <div class="d-card ${isIntern ? 'intern' : 'hack'}" data-id="${escHtml(c.id)}">
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
            <button class="btn-ghost" data-discuss="${escHtml(c.id)}">💬 Discuss</button>
            <button class="btn-ghost" data-save="${escHtml(c.id)}">💾 Save</button>
            <button class="btn-ghost-red" data-dismiss="${escHtml(c.id)}">✕ Dismiss</button>
          </div>
        </div>
      </div>`;
  };

  const hacks = list.filter((c) => (c.type || 'hackathon') !== 'internship');
  const interns = list.filter((c) => (c.type || 'hackathon') === 'internship');
  const parts = [];
  if (hacks.length) {
    parts.push(`<div class="disc-section"><div class="disc-section-head hack"><span class="disc-ico">🏆</span> Hackathons <span class="disc-count">${hacks.length}</span><span class="disc-hint">top 20</span></div><div class="disc-cards">${hacks.map(cardHtml).join('')}</div></div>`);
  }
  if (interns.length) {
    parts.push(`<div class="disc-section"><div class="disc-section-head intern"><span class="disc-ico">💼</span> Internships <span class="disc-count">${interns.length}</span><span class="disc-hint">top 10</span></div><div class="disc-cards">${interns.map(cardHtml).join('')}</div></div>`);
  }
  grid.innerHTML = parts.join('');

  grid.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    const id = b.dataset.save;
    try {
      await apiFetch(`/api/hackathons/discover/${id}/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participating: false }) });
      if (_ccSubject && _ccSubject.id === id && _ccMessages.length) {
        try {
          await apiFetch(`/api/hackathons/discover/${id}/discussion`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: _ccMessages }) });
        } catch (e) { /* seed persist optional */ }
      }
      await loadDiscoverCards();
      await loadSavedCards();
    } catch (err) { alert('Save failed: ' + err.message); }
    finally { b.disabled = false; }
  }));
  grid.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    const id = b.dataset.dismiss;
    try {
      await apiFetch(`/api/hackathons/discover/${id}/dismiss`, { method: 'POST' });
      await loadDiscoverCards();
    } catch (err) { alert('Dismiss failed: ' + err.message); }
    finally { b.disabled = false; }
  }));
  grid.querySelectorAll('[data-discuss]').forEach((b) => b.addEventListener('click', () => {
    const card = discoverCards.find((x) => x.id === b.dataset.discuss);
    if (card) openContextChat(subjectFromCard(card), CC_SUGGEST[card.type || 'hackathon'] || CC_SUGGEST.hackathon);
  }));
}

/* ── Study: GitHub Profile (deep scan) ───────────────── */
function githubLabel(raw) {
  const m = String(raw || '').match(/github\.com\/([A-Za-z0-9_.-]+)/i);
  if (m) return m[1];
  const u = String(raw || '').trim();
  return /^[A-Za-z0-9_.-]+$/.test(u) ? u : u;
}

async function analyzeGithubProfile(fresh) {
  const raw = $('github-input').value.trim();
  if (!raw) return;
  const res = $('github-results');

  let username = '';
  const urlMatch = raw.match(/github\.com\/([A-Za-z0-9_.-]+)/i);
  if (urlMatch) username = urlMatch[1];
  else if (/^[A-Za-z0-9_.-]+$/.test(raw) && raw.length <= 80) username = raw;
  else { res.innerHTML = '<div class="empty-msg">⚠️ Invalid input — use https://github.com/username or just a GitHub username.</div>'; return; }

  if (!lockOp('github', $('github-analyze-btn'))) return;

  addStudyHistory('github', username, githubLabel(raw));
  renderStudyHistory();

  res.innerHTML = '<div class="empty-msg">⏳ GitHub profile scrape ho raha hai — sab public repos scan ho rahe hain (≈30s)…</div>';
  $('github-qa').style.display = 'none';
  try {
    const data = await apiFetch(`/api/study/github/profile?username=${encodeURIComponent(username)}${fresh ? '&fresh=1' : ''}`);
    if (data.error) { res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(data.message || data.error)}</div>`; return; }
    window._ghProfile = data;
    renderGithubProfile(data);
  } catch (err) {
    res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
  } finally {
    unlockOp('github', $('github-analyze-btn'));
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
      <button class="btn-outline cc-open-btn" id="github-profile-discuss-btn">💬 Discuss with Ek Sathi</button>
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
  const pb = $('github-profile-discuss-btn');
  if (pb) pb.addEventListener('click', () => openContextChat(githubProfileSubject(data), CC_SUGGEST.github, { repos: data.repos || [] }));
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
  if (!lockOp('gh-modal')) return;
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
  } finally {
    unlockOp('gh-modal');
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
function domainLabel(raw) {
  try { return String(new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname).replace(/^www\./, ''); }
  catch (e) { return String(raw).trim(); }
}

async function analyzeWebsite(fresh) {
  const url = $('website-input').value.trim();
  if (!url) return;
  if (!lockOp('website', $('website-analyze-btn'))) return;
  const res = $('website-results');
  addStudyHistory('website', url, domainLabel(url));
  renderStudyHistory();
  res.innerHTML = '<div class="empty-msg">⏳ Deep website scrape ho raha hai — home + internal pages + CSS scan (≈20-30s)…</div>';
  try {
    const data = await apiFetch('/api/study/website', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, ...(fresh ? { fresh: 1 } : {}) }) });
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
        <button class="btn-outline cc-open-btn" id="website-discuss-btn">💬 Discuss with Ek Sathi</button>
      </div>`;
    const db = $('website-discuss-btn');
    if (db) db.addEventListener('click', () => openContextChat(websiteSubject(d), CC_SUGGEST.website));
  } catch (err) {
    res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
  } finally {
    unlockOp('website', $('website-analyze-btn'));
  }
}

/* ── Study: Persistent History (chips, re-scrape on click) ─ */
const STUDY_HISTORY_KEY = 'es_study_history_v1';
const STUDY_HISTORY_CAP = 12;
let _studyHistory = [];

function loadStudyHistory() {
  try { _studyHistory = JSON.parse(localStorage.getItem(STUDY_HISTORY_KEY) || '[]'); }
  catch (e) { _studyHistory = []; }
  if (!Array.isArray(_studyHistory)) _studyHistory = [];
  return _studyHistory;
}
function saveStudyHistory() {
  try { localStorage.setItem(STUDY_HISTORY_KEY, JSON.stringify(_studyHistory)); } catch (e) {}
}
function addStudyHistory(kind, value, label) {
  const norm = String(value).trim().replace(/\/+$/, '');
  const exists = _studyHistory.findIndex((h) => h.kind === kind && h.value.toLowerCase() === norm.toLowerCase());
  if (exists >= 0) {
    _studyHistory[exists].label = label || _studyHistory[exists].label;
    _studyHistory[exists].ts = Date.now();
    const [moved] = _studyHistory.splice(exists, 1);
    _studyHistory.unshift(moved);
  } else {
    _studyHistory.unshift({ kind, value: norm, label: label || kind, ts: Date.now() });
  }
  _studyHistory = _studyHistory.filter((h) => h.kind === 'github' || h.kind === 'website').slice(0, STUDY_HISTORY_CAP * 2);
  saveStudyHistory();
}
function renderStudyHistory() {
  loadStudyHistory();
  const forKind = (kind) => _studyHistory
    .filter((h) => h.kind === kind)
    .map((h) => `<button class="study-history-chip" data-hkind="${kind}" data-hlabel="${escHtml(h.label)}" title="↻ Re-scrape fresh — changes detect karne ke liye">↻ ${escHtml(h.label)}</button>`)
    .join('');
  const ghEl = $('github-history'), weEl = $('website-history');
  if (ghEl) ghEl.innerHTML = _studyHistory.some(h => h.kind === 'github') ? `<span class="study-history-label">History</span>${forKind('github')}` : '';
  if (weEl) weEl.innerHTML = _studyHistory.some(h => h.kind === 'website') ? `<span class="study-history-label">History</span>${forKind('website')}` : '';
  document.querySelectorAll('.study-history-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const hlabel = chip.dataset.hlabel || '';
      const hum = _studyHistory.find((h) => h.label.toLowerCase() === hlabel.toLowerCase());
      if (!hum) return;
      if (hum.kind === 'github') {
        const input = $('github-input');
        input.value = hum.value;
        analyzeGithubProfile(true);
      } else {
        const input = $('website-input');
        input.value = hum.value;
        analyzeWebsite(true);
      }
    });
  });
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

/* ── Context Chat drawer (discuss any scraped item) ─────── */
const CC_TYPE = {
  hackathon: { icon: '🏆', label: 'Hackathon' },
  internship: { icon: '💼', label: 'Internship' },
  website: { icon: '🌐', label: 'Website' },
  github: { icon: '👤', label: 'GitHub Profile' },
  repo: { icon: '📦', label: 'GitHub Repo' },
  resume: { icon: '📄', label: 'Resume' },
};
const CC_SUGGEST = {
  hackathon: ['🎯 Isme main kya bana sakta hu?', '💰 Prize aur deadlines kya hain?', '🙋 Kya main participate karu?', '🧰 Konse skills chahiye?'],
  internship: ['💼 Ye internship kaisi hai?', '📝 Kya skills chahiye iske liye?', '💰 Stipend kitna hai?', '👀 Apply karna chahiye kya?'],
  website: ['🎯 Is site ka final goal kya hai?', '🧰 Kis tech se bani hai?', '🎨 Fonts aur color palette batao', '📄 Kin pages pe focus karna chahiye?'],
  github: ['👤 Is developer ka kaam kaisa hai?', '🧰 Kis tech pe focus karte hain?', '📈 Kya strengths/languages prominent hain?', '🚀 Kaunsa repo sabse valuable hai?'],
  repo: ['🎯 Ye repo kya karta hai?', '⚙️ Architecture/tech stack kya hai?', '🚀 Kya main isse chalana/build karna seekh sakta hu?', '📂 Kis code se bana hai?'],
  resume: ['💪 Mera strongest point kya hai?', '🔍 Missing keywords kaunse hain?', '✍️ Har bullet ko kaise improve karu?', '🎯 Is JD ke liye kya highlight karu?'],
};
let _ccSubject = null;
let _ccMessages = [];
let _ccPersistId = null;
let _ccProfileSubject = null;
let _ccProfileRepos = [];

function githubProfileSubject(d) {
  const p = d.profile || {};
  const s = d.stats || {};
  const repos = d.repos || [];
  const ctx = [
    'Type: GitHub Profile',
    `Login: ${p.login || ''}`,
    `Name: ${p.name || ''}`,
    `Bio: ${p.bio || ''}`,
    `Location: ${p.location || ''}`,
    `Company: ${p.company || ''}`,
    `Public repos: ${p.publicRepos ?? repos.length}`,
    `Followers: ${p.followers || 0}`,
    `Total stars: ${s.totalStars || 0}`,
    `Total forks: ${s.totalForks || 0}`,
    `Top languages: ${s.topLanguages || 'n/a'}`,
    `Profile overview: ${(d.overview || '').slice(0, 2500)}`,
    ...(repos.length ? ['', 'REPOS (name ⭐stars ⑂forks 📝commits):'] : []),
    ...repos.map((r) => `• ${r.full_name} [${r.language || '?'}] ⭐${r.stars ?? 0} ⑂${r.forks ?? 0}${r.commits != null ? ' 📝' + r.commits : ''} — ${(r.summary || r.description || '').slice(0, 160)}`),
  ].filter(Boolean).join('\n');
  return { type: 'github', title: (p.name || p.login || 'GitHub Profile'), subtitle: '@' + (p.login || ''), contextText: ctx };
}

function repoSubject(r) {
  if (!r) return null;
  const ctx = [
    'Type: GitHub Repo',
    `Name: ${r.full_name || r.name}`,
    `Language: ${r.language || ''}`,
    `Stars: ${r.stars ?? ''}`,
    `Forks: ${r.forks ?? ''}`,
    `Commits: ${r.commits != null ? r.commits : 'unknown'}`,
    `Last updated: ${r.updated_at || ''}`,
    `Description: ${r.description || ''}`,
    `Summary (from README): ${(r.summary || '').slice(0, 2000)}`,
    `Open: https://github.com/${r.full_name || r.name}`,
  ].filter(Boolean).join('\n');
  return { type: 'repo', title: (r.full_name || r.name || 'Repository'), subtitle: (r.language || 'GitHub Repo'), contextText: ctx };
}

async function ccRepoChanged(value) {
  if (!_ccProfileSubject) return;
  if (value && _ccProfileRepos.length) {
    const r = _ccProfileRepos.find((x) => x.full_name === value);
    if (r) { await _ccRender(repoSubject(r)); return; }
  }
  await _ccRender(_ccProfileSubject);
}

/* ── Resume ATS Audit ──────────────────────────────────── */
let _lastAudit = null;
let _lastResumeName = 'resume';
let _lastResumeText = '';

function resumeSubject(info) {
  const a = info.audit || {};
  const b = a.breakdown || {};
  const h = a.heuristics || {};
  const sm = h.skillMatch || {};
  const ctx = [
    'Type: Resume ATS Audit',
    `Resume: ${info.name || 'resume'}${a.pageCount != null ? ` (${a.pageCount} page(s))` : ''}`,
    `ATS score: ${a.atsScore != null ? a.atsScore + '/100' : 'n/a'} (${a.verdict || ''})${a.jdUsed ? ' — targeted job description audit' : ''}`,
    `Breakdown — Impact & Metrics ${b.impactAndMetrics}/100, Action Verbs ${b.actionVerbs}/100, Formatting & Clarity ${b.formattingAndClarity}/100, Experience Depth ${b.experienceDepth}/100, Skills Relevance ${b.skillsRelevance}/100`,
    `Criteria marks: ${(a.criteria || []).slice(0, 16).map((c) => `${c.label}=${c.score}/${c.max} (${c.status})`).join(' | ')}`,
    `Dimension grades: ${Object.entries(a.grades || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'}`,
    `Top deductions: ${(a.topDeductions || []).map((d) => `${d.label} (${d.key})`).join(' | ') || 'none'}`,
    `Improvement potential: ${a.potentialScore != null ? '~' + a.potentialScore + '/100' : 'n/a'}`,
    `Experience: ${h.totalYears != null ? h.totalYears + ' yr(s)' : 'n/a'} — missing sections: ${(h.missingSections || []).join(', ') || 'none'}${h.summaryPresent === false ? ' (summary missing)' : ''}`,
    `Social links: ${['github', 'linkedin', 'portfolio'].map((k) => `${k} ${h.social && h.social[k] ? '✅' : '❌'}`).join(', ')}`,
    `Keyword match: ${sm.matched && sm.matched.length ? sm.matched.length + '/' + sm.total + ' (' + sm.source + ')' : 'n/a'} ` + (sm.matched && sm.matched.length ? '— found: ' + sm.matched.slice(0, 12).join(', ') : ''),
    `Sections detected: ${(h.sectionsDetected || []).join(', ') || 'none'}`,
    `Links: ${(a.links || []).map((l) => `${l.status} ${l.url}`).join(' | ') || 'no links found'}`,
    `Content quality: ${a.contentQuality || ''}`,
    `Strengths: ${(a.strengths || []).join(' | ')}`,
    `Critical negatives: ${(a.criticalNegatives || []).join(' | ')}`,
    `Missing keywords: ${(a.missingRecommendedKeywords || []).join(', ') || 'none flagged'}`,
    `Section review: ${(a.sectionReview || []).map((s) => `${s.section} (${s.verdict}) — ${(s.whatToImprove || []).join('; ')}`).join(' | ')}`,
    `Action plan: ${(a.actionPlan || []).join(' | ')}`,
    '',
    'Resume text (excerpt):',
    String(info.text || '').slice(0, 4000),
  ].filter(Boolean).join('\n');
  return { type: 'resume', title: `Resume Audit: ${info.name || 'resume'}`, subtitle: `ATS ${a.atsScore != null ? a.atsScore + '/100' : 'n/a'}`, contextText: ctx };
}

async function resumeAudit() {
  const file = $('resume-file').files[0];
  const text = $('resume-paste').value.trim();
  const jd = $('resume-jd').value.trim();
  if (!file && text.length < 50) { alert('Resume upload karo (PDF/DOCX/TXT) ya kam se kam 50 chars ka text paste karo.'); return; }
  if (!lockOp('resume-audit', $('resume-audit-btn'))) return;
  const res = $('resume-results');
  res.innerHTML = '<div class="empty-msg">⏳ ATS audit chal raha hai… (score local heuristics se, critique AI se)</div>';
  try {
    let data;
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      if (jd) fd.append('targetJobDescription', jd);
      data = await apiFetch('/api/resume/audit', { method: 'POST', body: fd });
    } else {
      data = await apiFetch('/api/resume/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, targetJobDescription: jd }) });
    }
    _lastAudit = data.audit;
    _lastResumeName = data.fileName || 'resume';
    _lastResumeText = file ? 'File: ' + (file.name || 'resume') : text;
    renderResumeAudit(data);
    $('resume-actionbar').style.display = '';
  } catch (err) {
    res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
  } finally {
    unlockOp('resume-audit', $('resume-audit-btn'));
  }
}

function scoreTone(v) { return v >= 80 ? '#16a34a' : v >= 60 ? '#d97706' : '#dc2626'; }

const RE_GROUP_META = [
  ['impact', '💪 Impact & Metrics', 'Numbers/proof ke saath results'],
  ['action', '⚡ Action Verbs', 'Strong opening verbs'],
  ['format', '🧾 Formatting & Clarity', 'Contact, sections, periods, pages'],
  ['experience', '🎓 Experience Depth', 'Roles + dates depth'],
  ['skills', '🎯 Skills & Keywords', 'JD/role keyword alignment'],
];

function renderResumeAudit(data) {
  const a = data.audit;
  const tone = scoreTone(a.atsScore);
  const b = a.breakdown || {};
  const h = a.heuristics || {};
  const sm = h.skillMatch || {};
  const gradeOf = (v) => (v == null ? '—' : v >= 90 ? 'A+' : v >= 80 ? 'A' : v >= 65 ? 'B' : v >= 50 ? 'C' : 'D');
  const grades = a.grades || {};
  const bars = [
    ['impactAndMetrics', 'Impact & Metrics', b.impactAndMetrics, 'quantified bullets ka ratio'],
    ['actionVerbs', 'Action Verbs', b.actionVerbs, 'strong vs weak opening verbs'],
    ['formattingAndClarity', 'Formatting & Clarity', b.formattingAndClarity, 'contact, sections, trailing periods'],
    ['experienceDepth', 'Experience Depth', b.experienceDepth, 'roles + dates kitne hain'],
    ['skillsRelevance', 'Skills Relevance', b.skillsRelevance, a.jdUsed ? 'target JD keyword match' : 'generic IT skills match'],
  ];
  const critGroups = RE_GROUP_META.map(([key, title, hint]) => ({
    title, hint,
    items: (a.criteria || []).filter((c) => String(c.key || '').split('.')[0] === key),
  })).filter((g) => g.items.length);
  const links = a.links || [];
  const sections = a.sectionReview || [];
  const meta = [
    `${data.charCount ? data.charCount + ' chars' : ''}`,
    a.pageCount != null ? `${a.pageCount} ${a.pageCount === 1 ? 'page' : 'pages'}${a.pageCount > 1 ? ' ⚠️' : ' ✅ single'}` : '',
    `${h.totalBullets || 0} bullets`,
    sm.total ? `${sm.matched.length}/${sm.total} keywords (${sm.source === 'jd' ? 'JD' : 'generic'})` : '',
    links.length ? `${links.length} links` : '',
    a.jdUsed ? '🎯 JD targeted' : 'no JD',
  ].filter(Boolean).map((m) => `<span class="re-meta-chip">${escHtml(m)}</span>`).join('');
  const res = $('resume-results');
  res.innerHTML = `
    <div class="re-card">
      <div class="re-head">
        <div class="re-score" style="--re-tone:${tone};--re-pct:${a.atsScore}">
          <div class="re-score-num">${a.atsScore}/100</div>
          <div class="re-verdict">${escHtml(a.verdict)}${a.jdUsed ? ' 🎯 targeted' : ''}</div>
        </div>
        <div class="re-meta">
          <div class="re-file">📄 ${escHtml(data.fileName || 'resume')}</div>
          <div class="re-meta-row">${meta}</div>
          <div class="re-sub">${a.jdUsed ? '🎯 Target JD: ' + escHtml(a.jdUsed.slice(0, 90)) : 'Koi target JD nahi diya — generic IT benchmark use hua. JD paste karoge to exact keyword-alignment milega.'}</div>
        </div>
      </div>
      <div class="re-bars">
        ${bars.map(([key, label, val, hint]) => `
          <div class="re-bar">
            <div class="re-bar-top"><span>${label}</span><span class="re-bar-val" style="color:${scoreTone(val)}">${val}/100 <span class="re-grade">${grades[key] || gradeOf(val)}</span></span></div>
            <div class="re-bar-track"><div class="re-bar-fill" style="width:${val}%;background:${scoreTone(val)}"></div></div>
            <div class="re-bar-hint">${hint}</div>
          </div>`).join('')}
      </div>
      ${a.potentialScore != null ? `<div class="re-potential">🔥 Improvement potential: ~${a.potentialScore}/100 agar top deductions fix karein</div>` : ''}
    </div>

    <div class="re-card">
      <div class="re-card-title">🔍 Har mark ka hisaab — criteria-by-criteria</div>
      <div class="re-crit-groups">
        ${critGroups.map((g) => `
        <div class="re-crit-group">
          <div class="re-crit-group-head"><span>${g.title}</span><span class="dim">${g.hint}</span></div>
          ${g.items.map((c) => `
            <div class="re-crit">
              <div class="re-crit-top">
                <span class="re-crit-dot ${c.status === 'pass' ? 'pass' : c.status === 'warn' ? 'warn' : 'fail'}"></span>
                <span class="re-crit-label">${escHtml(c.label)}</span>
                <span class="re-crit-score" style="color:${scoreTone((c.score / c.max) * 100)}">${c.score}/${c.max}</span>
              </div>
              <div class="re-crit-track"><div class="re-crit-fill ${c.status === 'pass' ? 'pass' : c.status === 'warn' ? 'warn' : 'fail'}" style="width:${Math.max(2, Math.round((c.score / c.max) * 100))}%"></div></div>
              <div class="re-crit-why">${escHtml(c.why || '')}</div>
              ${c.advice ? `<div class="re-crit-advice">💡 ${escHtml(c.advice)}</div>` : ''}
            </div>`).join('')}
        </div>`).join('')}
      </div>
    </div>

    ${(a.topDeductions || []).length ? `
    <div class="re-card">
      <div class="re-card-title">🔻 Top Deductions — sabse zyada score girane wale</div>
      ${a.topDeductions.map((d) => `
        <div class="re-deduct">
          <div class="re-deduct-head"><span class="re-deduct-key">${escHtml(String(d.key || '').split('.').pop())}</span><span class="re-deduct-label">${escHtml(d.label || '')}</span></div>
          <div class="re-crit-advice">💡 ${escHtml(d.advice || '')}</div>
        </div>`).join('')}
    </div>` : ''}

    <div class="re-card">
      <p class="re-summary">${mdToHtml(a.executiveSummary || '')}</p>
      ${a.contentQuality ? `<p class="re-cq"><span class="re-cq-label">📝 Content ka substance (worth it hai kya):</span> ${escHtml(a.contentQuality)}</p>` : ''}
      <div class="re-cols">
        <div class="re-col">
          <div class="re-col-title">✅ Strengths</div>
          <ul>${(a.strengths || []).map((s) => `<li>${escHtml(s)}</li>`).join('') || '<li class="dim">—</li>'}</ul>
        </div>
        <div class="re-col">
          <div class="re-col-title bad">⚠️ Critical Negatives</div>
          <ul>${(a.criticalNegatives || []).map((s) => `<li>${escHtml(s)}</li>`).join('') || '<li class="dim">—</li>'}</ul>
        </div>
      </div>
    </div>

    ${sections.length ? `
    <div class="re-card">
      <div class="re-card-title">📚 Section-by-section review</div>
      <div class="re-sec-grid">
        ${sections.map((s) => `
        <div class="re-sec re-sec-${s.verdict || 'ok'}">
          <div class="re-sec-head"><span class="re-sec-name">${escHtml(s.section || 'Section')}</span><span class="re-sec-v">${s.verdict === 'strong' ? '✅ strong' : s.verdict === 'weak' ? '❌ weak' : '🔸 ok'}</span></div>
          ${(s.whatWorks || []).length ? `<div class="re-sec-works">${s.whatWorks.map((w) => `<div>✓ ${escHtml(w)}</div>`).join('')}</div>` : ''}
          ${(s.whatToImprove || []).length ? `<div class="re-sec-fix">${s.whatToImprove.map((w) => `<div>🛠 ${escHtml(w)}</div>`).join('')}</div>` : ''}
        </div>`).join('')}
      </div>
    </div>` : ''}

    ${links.length ? `
    <div class="re-card">
      <div class="re-card-title">🔗 Link status (real check)</div>
      <div class="re-links">
        ${links.map((l) => `
        <div class="re-link">
          <span class="re-link-status ${l.status === 'ok' ? 'ok' : 'bad'}">${l.status}</span>
          <span class="re-link-url">${escHtml(l.url)}</span>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="re-card">
      <div class="re-kw">
        <div class="re-col-title">🔑 ATS Keywords Found (${(a.atsKeywordsFound || []).length})</div>
        <div class="re-chips">${(a.atsKeywordsFound || []).slice(0, 25).map((k) => `<span class="chip chip-ok">${escHtml(k)}</span>`).join('') || '<span class="dim">text me koi common keyword nahi mila</span>'}</div>
        <div class="re-col-title">🧩 Missing / Recommended</div>
        <div class="re-chips">${(a.missingRecommendedKeywords || []).slice(0, 25).map((k) => `<span class="chip chip-warn">${escHtml(k)}</span>`).join('') || '<span class="dim">generic skills already hain</span>'}</div>
      </div>
    </div>

    ${(a.bulletImprovements || []).length ? `
    <div class="re-card">
      <div class="re-col-title">✍️ Bullet Rewrites</div>
      ${a.bulletImprovements.slice(0, 4).map((bi) => `
        <div class="re-rw">
          <div class="re-rw-orig">${escHtml(bi.original || '')}</div>
          <div class="re-rw-arrow">↓ improved</div>
          <div class="re-rw-new">${escHtml(bi.improved || '')}</div>
        </div>`).join('')}
    </div>` : ''}

    <div class="re-card">
      <div class="re-col-title">🎯 Action Plan</div>
      <ol class="re-plan">${(a.actionPlan || []).slice(0, 4).map((s) => `<li>${escHtml(s)}</li>`).join('') || ''}</ol>
    </div>`;
  res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function resumeAuditPdf() {
  if (!_lastAudit) return;
  if (!lockOp('resume-pdf', $('resume-report-pdf-btn'))) return;
  const base = String(_lastResumeName || 'resume').replace(/\.[^.]+$/, '').replace(/[^\w\- ]/g, '').slice(0, 50) || 'resume';
  try {
    await downloadFile('/api/resume/audit-pdf', { audit: _lastAudit, fileName: _lastResumeName }, base + '_ATS_Report.pdf');
  } catch (err) {
    alert('PDF download fail: ' + err.message);
  } finally {
    unlockOp('resume-pdf', $('resume-report-pdf-btn'));
  }
}

function resumeDiscuss() {
  if (!_lastAudit) return;
  openContextChat(resumeSubject({ audit: _lastAudit, name: _lastResumeName, text: _lastResumeText }), CC_SUGGEST.resume);
}

function clearResume() {
  _lastAudit = null; _lastResumeName = 'resume'; _lastResumeText = '';
  $('resume-file').value = '';
  $('resume-file-name').textContent = '';
  $('resume-paste').value = '';
  $('resume-jd').value = '';
  $('resume-results').innerHTML = '';
  $('resume-actionbar').style.display = 'none';
}

async function downloadFile(url, payload, filename) {
  const res = await fetch(API + url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) { /* non-JSON */ } throw new Error((d && d.error) || 'HTTP ' + res.status); }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function bindResume() {
  $('resume-audit-btn').addEventListener('click', resumeAudit);
  $('resume-report-pdf-btn').addEventListener('click', resumeAuditPdf);
  $('resume-discuss-btn').addEventListener('click', resumeDiscuss);
  $('resume-clear-btn').addEventListener('click', clearResume);
  $('resume-file').addEventListener('change', () => {
    const f = $('resume-file').files[0];
    $('resume-file-name').textContent = f ? `📎 ${f.name} (${(f.size / 1024).toFixed(0)} KB)` : '';
    if (f) $('resume-paste').value = '';
  });
}

function buildContextChat() {
  let overlay = $('context-chat');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'context-chat';
  overlay.className = 'cc-overlay';
  overlay.innerHTML = `
    <div class="cc-panel">
      <div class="cc-header">
        <span class="cc-ico" id="cc-ico">🌐</span>
        <div class="cc-id">
          <div class="cc-title" id="cc-title"></div>
          <div class="cc-sub" id="cc-sub"></div>
        </div>
        <button class="cc-close" onclick="closeContextChat()" title="Close">✕</button>
      </div>
      <div class="cc-repo-wrap" id="cc-repo-wrap" style="display:none">
        <select class="cc-repo-select" id="cc-repo-select" onchange="ccRepoChanged(this.value)"></select>
      </div>
      <div class="cc-msgs" id="cc-msgs"></div>
      <div class="cc-chips" id="cc-chips"></div>
      <div class="cc-input-row">
        <textarea id="cc-input" class="ws-chat-input" rows="1" placeholder="Ek Sathi se baat karo — Enter se bhejo, Shift+Enter se nayi line…"></textarea>
        <button class="cc-send" id="cc-send" onclick="ccSend()" title="Send">➤</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeContextChat(); });
  document.body.appendChild(overlay);
  const inp = overlay.querySelector('#cc-input');
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ccSend(); } });
  inp.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; });
  return overlay;
}

async function openContextChat(subject, suggested, opts) {
  opts = opts || {};
  const o = buildContextChat();
  o.classList.add('open');

  // GitHub profile drawer: repo dropdown above the messages
  if (opts.repos && opts.repos.length) {
    _ccProfileSubject = subject;
    _ccProfileRepos = opts.repos;
    $('cc-repo-wrap').style.display = '';
    $('cc-repo-select').innerHTML =
      '<option value="">👤 Whole profile</option>' +
      opts.repos.map((r) => `<option value="${escHtml(r.full_name)}">📦 ${escHtml(r.name)}</option>`).join('');
    $('cc-repo-select').value = '';
  } else {
    _ccProfileSubject = null;
    _ccProfileRepos = [];
    $('cc-repo-wrap').style.display = 'none';
  }

  await _ccRender(subject, suggested);
}

async function _ccRender(subject, suggested) {
  const meta = CC_TYPE[subject && subject.type] || CC_TYPE.website;
  _ccPersistId = (subject && subject.id) ? String(subject.id) : null;
  _ccSubject = subject;
  _ccMessages = [];
  $('cc-ico').textContent = meta.icon;
  $('cc-title').textContent = subject && subject.title ? subject.title : 'Discussion';
  $('cc-sub').textContent = (subject && subject.subtitle) || meta.label;
  const msgs = $('cc-msgs');
  msgs.innerHTML = '';
  const chips = $('cc-chips');
  chips.innerHTML = (suggested && suggested.length ? suggested : CC_SUGGEST[subject && subject.type] || CC_SUGGEST.website)
    .map((s) => `<button class="cc-chip" data-q="${escHtml(s)}" onclick="ccSend(this.dataset.q)">${escHtml(s)}</button>`).join('');
  const title = subject && subject.title ? subject.title : 'ye topic';

  // Saved card → load its persisted discussion memory and continue from there
  if (_ccPersistId) {
    try {
      const data = await apiFetch(`/api/hackathons/discover/${_ccPersistId}/discussion`);
      if (data.status === 'ok' && data.messages && data.messages.length) {
        _ccMessages = data.messages.slice();
        data.messages.forEach((m) => hackMsgInto(msgs, m.role === 'user' ? 'user' : 'assistant', m.content));
        hackMsgInto(msgs, 'assistant', `📌 Yeh baat saved memory se continue ho rahi hai — ${data.messages.length} messages yaad hain. Poochte raho!`);
        setTimeout(() => { $('cc-input').focus(); }, 80);
        return;
      }
    } catch (e) { /* memory load failed → fresh start */ }
  }

  hackMsgInto(msgs, 'assistant', `👋 Main **${title}** ki scraped details ke saath discuss kar sakta hu. Jo bhi poochna ho, poocho!`);
  setTimeout(() => { $('cc-input').focus(); }, 80);
}

function closeContextChat() {
  const o = $('context-chat');
  if (o) o.classList.remove('open');
}

function ccTypingInto(container) {
  const div = document.createElement('div');
  div.className = 'ws-msg assistant';
  div.innerHTML = `<div class="ws-msg-role">Ek Sathi</div><div class="ws-msg-text"><span class="typing-indicator"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="typing-label">soch raha hu…</span></span></div>`;
  container.appendChild(div);
  scrollToBottom(container);
  return div;
}

async function ccSend(text) {
  const inp = $('cc-input');
  const q = typeof text === 'string' ? text.trim() : (inp.value || '').trim();
  if (!q || !_ccSubject) return;
  if (!lockOp('cc-send', $('cc-send'))) return;
  inp.value = '';
  inp.style.height = 'auto';
  const msgs = $('cc-msgs');
  $('cc-chips').innerHTML = '';
  _ccMessages.push({ role: 'user', content: q });
  hackMsgInto(msgs, 'user', q);
  const typing = ccTypingInto(msgs);
  try {
    let data;
    if (_ccPersistId) {
      // Saved item → server keeps the memory, conversation continues from it
      data = await apiFetch(`/api/hackathons/discover/${_ccPersistId}/discussion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: q }),
      });
      typing.remove();
      if (data.status === 'ok') {
        if (data.answer) {
          _ccMessages.push({ role: 'assistant', content: data.answer });
          hackMsgInto(msgs, 'assistant', data.answer);
        }
      } else {
        hackMsgInto(msgs, 'assistant', '⚠️ ' + (data.message || data.error || 'Jawab nahi mila'));
      }
    } else {
      data = await apiFetch('/api/study/discuss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: _ccSubject, messages: _ccMessages }),
      });
      typing.remove();
      if (data.status === 'ok') {
        _ccMessages.push({ role: 'assistant', content: data.answer });
        hackMsgInto(msgs, 'assistant', data.answer || '…');
      } else {
        hackMsgInto(msgs, 'assistant', '⚠️ ' + (data.message || data.error || 'Jawab nahi mila'));
      }
    }
  } catch (err) {
    typing.remove();
    hackMsgInto(msgs, 'assistant', '⚠️ ' + err.message);
  } finally {
    unlockOp('cc-send', $('cc-send'));
    inp.focus();
  }
}

function subjectFromCard(c) {
  const isIntern = (c.type || 'hackathon') === 'internship';
  const parts = [
    `Type: ${isIntern ? 'Internship' : 'Hackathon'}`,
    c.platform ? `Platform: ${c.platform}` : '',
    c.title ? `Title: ${c.title}` : '',
    c.company ? `Company: ${c.company}` : '',
    c.summary ? `Summary: ${c.summary}` : '',
    c.whatToBuild ? `What to build: ${c.whatToBuild}` : '',
    c.prize ? `${isIntern ? 'Stipend' : 'Prize'}: ${c.prize}` : '',
    c.mode ? `Mode: ${c.mode}` : '',
    c.location ? `Location: ${c.location}` : '',
    c.fee ? `Fee: ${c.fee}` : '',
    isIntern && c.stipend ? `Stipend: ${c.stipend}` : '',
    isIntern && c.duration ? `Duration: ${c.duration}` : '',
    c.seatsStatus ? `Seats: ${c.seatsStatus}` : '',
    c.teamSize ? `Team size: ${c.teamSize}` : '',
    c.eligibility ? `Eligibility: ${c.eligibility}` : '',
    (c.registrationDeadline || c.startDate || c.endDate) ? `Dates: ${c.registrationDeadline || ''}${c.startDate ? ` · ${c.startDate}${c.endDate ? ' → ' + c.endDate : ''}` : ''}` : '',
    c.tags && c.tags.length ? `Tags: ${c.tags.join(', ')}` : '',
    c.link ? `Link: ${c.link}` : '',
  ].filter(Boolean).join('\n');
  return { id: c.id, type: isIntern ? 'internship' : 'hackathon', title: c.title || 'Untitled', subtitle: c.platform || '', contextText: parts };
}

function websiteSubject(d) {
  const stack = d.stack || {};
  const design = d.design || {};
  const parts = [
    d.title ? `Title: ${d.title}` : '',
    d.url ? `URL: ${d.url}` : '',
    d.description ? `Description: ${d.description}` : '',
    d.scrapeMeta ? `Scrape: ${d.scrapeMeta}` : '',
    d.jsonLdTypes && d.jsonLdTypes.length ? `JSON-LD: ${d.jsonLdTypes.join(', ')}` : '',
    stack.frameworks && stack.frameworks.length ? `Frameworks: ${stack.frameworks.join(', ')}` : '',
    stack.cms && stack.cms.length ? `CMS: ${stack.cms.join(', ')}` : '',
    stack.styling && stack.styling.length ? `Styling: ${stack.styling.join(', ')}` : '',
    stack.libraries && stack.libraries.length ? `Libraries: ${stack.libraries.join(', ')}` : '',
    stack.runtime && stack.runtime.length ? `Runtime: ${stack.runtime.join(', ')}` : '',
    design.colors && design.colors.length ? `Colors: ${design.colors.map((c) => `${c.hex}×${c.count}`).join(', ')}` : '',
    design.fonts && design.fonts.length ? `Fonts: ${design.fonts.map((f) => f.name).join(', ')}` : '',
    d.pages && d.pages.length ? `Pages:\n${d.pages.slice(0, 12).map((p) => `• ${p.title || p.url} — ${p.url}`).join('\n')}` : '',
    d.analysis ? `\nDETAILED ANALYSIS:\n${d.analysis}` : '',
  ].filter(Boolean).join('\n');
  return { type: 'website', title: d.title || d.url || 'Website', subtitle: d.url || '', contextText: parts };
}

/* ── Study bind ────────────────────────────────────────── */
function bindStudy() {
  renderStudyHistory();
  $('github-analyze-btn').addEventListener('click', analyzeGithubProfile);
  $('github-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyzeGithubProfile(); });
  $('website-analyze-btn').addEventListener('click', analyzeWebsite);
  $('website-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyzeWebsite(); });
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
  const tabDiscover = $('tab-discover');
  const tabSaved = $('tab-saved');
  if (tabDiscover && tabSaved) {
    const setTab = (which) => {
      _savedActive = which === 'saved';
      tabDiscover.classList.toggle('active', !_savedActive);
      tabSaved.classList.toggle('active', _savedActive);
      $('panel-discover').style.display = _savedActive ? 'none' : 'flex';
      $('panel-saved').style.display = _savedActive ? 'flex' : 'none';
      if (_savedActive) loadSavedCards(); else renderDiscoverGrid();
    };
    tabDiscover.addEventListener('click', () => setTab('discover'));
    tabSaved.addEventListener('click', () => setTab('saved'));
  }
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
  bindResume();
  bindDiscovery();
  bindWelcomeChips();
  resetChatUI();

  loadSessions();

  const m = localStorage.getItem('preferred_model');
  if (m) $('model-selector').value = m;
}

document.addEventListener('DOMContentLoaded', init);