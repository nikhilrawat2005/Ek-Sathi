/* ═══════════════════════════════════════════════════════════
   EK SATHI — AI Companion for Learning & Growth
   Frontend app (v5): Chat + Hackathon Lab + GitHub/Website Study
   Frontend is 100% localhost; all auth is local (Bearer dev-local).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const API = '';               // relative API base (same origin)
const TOKEN = 'dev-local';    // local-only auth token

/* ── State ─────────────────────────────────────────────── */
let currentSessionId = null;
let sessions = [];
let hackathons = [];
let currentHackId = null;
let attachedFiles = [];       // [{ id, name, size }] to attach to next chat msg
let voiceEnabled = localStorage.getItem('tts_enabled') !== '0';

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
  if (view === 'hackathon') loadHackathons();
  if (view === 'study') { /* study is lazy */ }
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
  $('messages-container').innerHTML = '';
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
  c.innerHTML = '';
  if (!messages?.length) { resetChatUI(); return; }
  messages.forEach((m) => appendMessage(m.role, m.content, c));
}

/* Render advanced blocks (charts & mermaid) inside a message bubble */
function enhanceRenderedBubbles(root) {
  root.querySelectorAll('.message-bubble').forEach((bubble) => {
    // mermaid
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
    // charts (```chart {json})
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
    if (voiceEnabled && data.reply) speak(data.reply);
  } catch (err) {
    typing.remove();
    appendMessage('assistant', '⚠️ ' + (err.message || 'Something went wrong.'));
  }
}

/* ── TTS ───────────────────────────────────────────────── */
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const clean = String(text).replace(/[#*`>\-]/g, ' ').slice(0, 400);
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'en-IN';
  window.speechSynthesis.speak(u);
}
function initTTS() {
  const btn = $('tts-toggle-btn');
  btn.textContent = voiceEnabled ? '🔊 Voice' : '🔇 Voice';
  if (voiceEnabled) btn.classList.add('on');
  else btn.classList.remove('on');
  btn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem('tts_enabled', voiceEnabled ? '1' : '0');
    btn.textContent = voiceEnabled ? '🔊 Voice' : '🔇 Voice';
    if (voiceEnabled) { btn.classList.add('on'); } else { btn.classList.remove('on'); window.speechSynthesis.cancel(); }
  });
}

/* ── Welcome chips ─────────────────────────────────────── */
function bindWelcomeChips() {
  const chips = document.querySelectorAll('.welcome-chip');
  chips.forEach((c) => c.addEventListener('click', () => {
    $('message-input').value = c.textContent.trim();
    sendMessage();
  }));
}

/* ── Hackathon ─────────────────────────────────────────── */
async function loadHackathons() {
  try {
    const data = await apiFetch('/api/hackathons');
    hackathons = data.hackathons || [];
    renderHackathons();
  } catch (err) { console.error(err); }
}

function renderHackathons() {
  const list = $('hack-list');
  if (!hackathons.length) {
    list.innerHTML = '<div class="empty-msg" style="padding:20px;text-align:center;color:var(--text3)">Koi hackathon nahi hai. "＋ Add" se add karo.</div>';
    return;
  }
  list.innerHTML = hackathons.map((h) => `
    <div class="ws-item ${h.id === currentHackId ? 'selected' : ''}" data-id="${escHtml(h.id)}">
      <div class="ws-item-row">
        <div class="ws-item-title">${escHtml(h.title || 'Untitled')}</div>
      </div>
      <div class="ws-item-sub">${escHtml(h.link || h.mode || '')} ${h.participating ? '· ✅ participating' : ''}</div>
      ${h.startDate ? `<div class="ws-item-sub">📅 ${new Date(h.startDate).toLocaleDateString()} ${h.endDate ? '→ ' + new Date(h.endDate).toLocaleDateString() : ''}</div>` : ''}
      <div class="ws-item-actions">
        ${h.prize ? `<span class="ws-item-sub">💰 ${escHtml(h.prize)}</span>` : ''}
      </div>
    </div>`).join('');
  list.querySelectorAll('.ws-item').forEach((el) => {
    el.addEventListener('click', () => openHackathon(el.dataset.id));
  });
}

async function openHackathon(id) {
  currentHackId = id;
  renderHackathons();
  try {
    const data = await apiFetch(`/api/hackathons/${id}`);
    const h = data.hackathon;
    renderHackathonDetail(h);
    $('hack-empty-state').style.display = 'none';
    $('hack-workspace').style.display = 'flex';
    renderHackMsgs(h.messages || []);
  } catch (err) {
    alert('Could not open hackathon: ' + err.message);
  }
}

function renderHackathonDetail(h) {
  $('hack-title').textContent = h.title || 'Untitled';
  $('hack-meta').innerHTML = [
    h.link ? `<a href="${escHtml(h.link)}" target="_blank" rel="noopener">🔗 ${escHtml(h.link)}</a>` : '',
    h.mode ? `· ${escHtml(h.mode)}` : '',
    h.prize ? `· 🏆 ${escHtml(h.prize)}` : '',
    h.status ? `· <span class="ws-chat-header-status ${h.status === 'ended' ? 'grey' : 'green'}">${escHtml(h.status)}</span>` : '',
  ].filter(Boolean).join(' ');
  $('hack-participating').checked = !!h.participating;
}

function renderHackMsgs(messages) {
  const c = $('hack-messages');
  c.innerHTML = '';
  (messages || []).forEach((m) => {
    const div = document.createElement('div');
    div.className = `ws-msg ${m.role === 'user' ? 'user' : 'assistant'}`;
    div.innerHTML = `
      <div class="ws-msg-role">${m.role === 'user' ? 'You' : 'Ek Sathi'}</div>
      <div class="ws-msg-text">${mdToHtml(m.content)}</div>`;
    c.appendChild(div);
  });
  scrollToBottom(c);
}

function hackMsg(role, text) {
  const c = $('hack-messages');
  const div = document.createElement('div');
  div.className = `ws-msg ${role === 'user' ? 'user' : 'assistant'}`;
  div.innerHTML = `
    <div class="ws-msg-role">${role === 'user' ? 'You' : 'Ek Sathi'}</div>
    <div class="ws-msg-text">${mdToHtml(text)}</div>`;
  c.appendChild(div);
  scrollToBottom(c);
}

async function sendHackMessage() {
  if (!currentHackId) { alert('Pehle ek hackathon select karo.'); return; }
  const input = $('hack-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  hackMsg('user', text);
  hackMsg('assistant', '⏳ Ek Sathi soch raha hai…');
  try {
    const data = await apiFetch(`/api/hackathons/${currentHackId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const msgs = $('hack-messages');
    msgs.querySelectorAll('.ws-msg').forEach((el) => {
      if (el.textContent.includes('soch raha hai')) el.remove();
    });
    hackMsg('assistant', data.reply || '…');
    if (voiceEnabled && data.reply) speak(data.reply);
  } catch (err) {
    const msgs = $('hack-messages');
    msgs.querySelectorAll('.ws-msg').forEach((el) => {
      if (el.textContent.includes('soch raha hai')) el.remove();
    });
    hackMsg('assistant', '⚠️ ' + err.message);
  }
}

/* ── Hackathon modal ───────────────────────────────────── */
function openHackModal() {
  $('hack-modal').style.display = 'flex';
  $('hack-form').style.display = 'none';
  $('hack-paste-input').value = '';
}

function closeHackModal() {
  $('hack-modal').style.display = 'none';
}

function bindHackModal() {
  $('hack-add-btn').addEventListener('click', openHackModal);
  $('hack-modal-close').addEventListener('click', closeHackModal);
  $('hack-cancel-btn').addEventListener('click', closeHackModal);
  $('hack-modal').addEventListener('click', (e) => { if (e.target === $('hack-modal')) closeHackModal(); });

  $('hack-parse-btn').addEventListener('click', async () => {
    const raw = $('hack-paste-input').value.trim();
    if (!raw) { alert('Kuch paste karo pehle.'); return; }
    try {
      const data = await apiFetch('/api/hackathons/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawText: raw }) });
      const p = data.parsed || {};
      $('hack-f-title').value = p.title || '';
      $('hack-f-link').value = p.link || '';
      $('hack-f-source').value = p.source || '';
      $('hack-f-mode').value = p.mode === 'online' ? 'Online' : p.mode === 'offline' ? 'Offline' : p.mode === 'hybrid' ? 'Hybrid' : '';
      $('hack-f-prize').value = p.prize || '';
      $('hack-f-desc').value = p.description || '';
      $('hack-f-rules').value = (p.rules || []).join('\n');
      if (p.startDate) $('hack-f-start').value = new Date(Number(p.startDate)).toISOString().slice(0, 10);
      if (p.endDate) $('hack-f-end').value = new Date(Number(p.endDate)).toISOString().slice(0, 10);
      $('hack-form').style.display = 'block';
    } catch (err) { alert('Parse failed: ' + err.message); }
  });

  $('hack-manual-btn').addEventListener('click', () => { $('hack-form').style.display = 'block'; });

  $('hack-save-btn').addEventListener('click', async () => {
    const title = $('hack-f-title').value.trim();
    const link = $('hack-f-link').value.trim();
    if (!title && !link) { alert('Title ya Link to do.'); return; }
    const body = {
      title: title || undefined,
      link: link || undefined,
      source: $('hack-f-source').value.trim() || undefined,
      mode: $('hack-f-mode').value.toLowerCase() || undefined,
      prize: $('hack-f-prize').value.trim() || undefined,
      description: $('hack-f-desc').value.trim() || undefined,
      rules: $('hack-f-rules').value.split('\n').map((s) => s.trim()).filter(Boolean),
      startDate: $('hack-f-start').value ? new Date($('hack-f-start').value).getTime() : undefined,
      endDate: $('hack-f-end').value ? new Date($('hack-f-end').value).getTime() : undefined,
    };
    try {
      const data = await apiFetch('/api/hackathons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closeHackModal();
      await loadHackathons();
      if (data.hackathon?.id) openHackathon(data.hackathon.id);
    } catch (err) { alert('Save failed: ' + err.message); }
  });
}

function bindHackActions() {
  $('hack-participating').addEventListener('change', async (e) => {
    if (!currentHackId) return;
    try {
      await apiFetch(`/api/hackathons/${currentHackId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participating: e.target.checked }),
      });
      renderHackathons();
    } catch (err) { alert(err.message); }
  });
  $('hack-scrape-btn').addEventListener('click', async () => {
    if (!currentHackId) return;
    try {
      const data = await apiFetch(`/api/hackathons/${currentHackId}/scrape`, { method: 'POST' });
      renderHackathonDetail(data.hackathon);
      await loadHackathons();
    } catch (err) { alert('Scrape failed: ' + err.message); }
  });
  $('hack-discover-btn').addEventListener('click', async () => {
    try {
      const data = await apiFetch('/api/hackathons/discover');
      const cards = data.cards || [];
      if (!cards.length) {
        alert(cards.length ? '' : 'Abhi koi naye hackathon nahi mile. Baad me try karo');
        return;
      }
      const lines = cards.slice(0, 8).map((c) => `${c.title || 'Untitled'} — ${c.link || ''}`.trim());
      alert('🔍 Discovered candidates:\n\n' + lines.join('\n') + '\n\nKisi ko save karne ke liye chat me likho ya manual add karo.');
    } catch (err) { alert('Discover failed: ' + err.message); }
  });
  $('hack-send').addEventListener('click', sendHackMessage);
  $('hack-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendHackMessage(); } });
}

/* ── Study: GitHub ─────────────────────────────────────── */
async function analyzeGitHub() {
  const input = $('github-input').value.trim();
  if (!input) return;
  const res = $('github-results');
  const isUrl = /^https?:\/\//i.test(input);
  res.innerHTML = '<div class="empty-msg">⏳ GitHub repo analyze ho raha hai…</div>';
  try {
    const data = await apiFetch('/api/study/github', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: isUrl ? input : undefined, text: isUrl ? undefined : input }) });
    if (data.status !== 'ok') {
      res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(data.message || 'Analyze nahi ho paya')}</div>`;
      return;
    }
    const repo = data.repo || {};
    res.innerHTML = `
      <div class="repo-card">
        <div class="repo-card-head">
          <h3>📦 ${escHtml(repo.fullName || '')}</h3>
          <a class="btn-small" href="${escHtml(repo.fullName ? 'https://github.com/' + repo.fullName : '#')}" target="_blank" rel="noopener">Open on GitHub ↗</a>
        </div>
        <p class="ws-item-sub">${escHtml(repo.description || '')}</p>
        <div class="repo-stats">
          <span>⭐ ${repo.stars ?? 0}</span><span>⑂ ${repo.forks ?? 0}</span>
          <span>🧬 ${escHtml(repo.language || 'n/a')}</span>
          <span>🔧 ${escHtml(repo.defaultBranch || 'main')}</span>
        </div>
        ${data.stats ? `<p class="ws-item-sub">📁 ${escHtml(data.stats.fileCount || '0')} files · top dirs: ${escHtml(data.stats.topDirs || 'n/a')} · top ext: ${escHtml(data.stats.topExt || 'n/a')}</p>` : ''}
        ${data.readCount ? `<p class="ws-item-sub">📖 Read ${data.readCount} key files${data.truncated ? ' (tree truncated)' : ''}</p>` : ''}
      </div>`;
    $('github-qa').style.display = 'flex';
    $('github-repo-name').textContent = repo.fullName || '';
    $('github-repo-desc').textContent = repo.description || '';
    $('github-messages').innerHTML = '';
  } catch (err) {
    res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(err.message)}</div>`;
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
    if (data.status === 'ok') {
      hackMsgInto($('github-messages'), 'assistant', data.answer || '…');
    } else {
      hackMsgInto($('github-messages'), 'assistant', '⚠️ ' + (data.message || 'Jawab nahi mila'));
    }
  } catch (err) {
    typing.remove();
    hackMsgInto($('github-messages'), 'assistant', '⚠️ ' + err.message);
  }
}

/* ── Study: Website ────────────────────────────────────── */
async function analyzeWebsite() {
  const url = $('website-input').value.trim();
  if (!url) return;
  const res = $('website-results');
  res.innerHTML = '<div class="empty-msg">⏳ Website decode ho raha hai…</div>';
  try {
    const data = await apiFetch('/api/study/website', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    if (data.status !== 'ok') {
      res.innerHTML = `<div class="empty-msg">⚠️ ${escHtml(data.message || 'Decode nahi ho paya')}</div>`;
      return;
    }
    const d = data.decode || {};
    const arch = d.architecture || {};
    res.innerHTML = `
      <div class="repo-card">
        <div class="repo-card-head">
          <h3>🌐 ${escHtml(d.title || d.url || url)}</h3>
          <a class="btn-small" href="${escHtml(d.url || url)}" target="_blank" rel="noopener">Open ↗</a>
        </div>
        ${d.description ? `<p class="ws-item-sub">${escHtml(d.description)}</p>` : ''}
        <div class="repo-stats">
          ${(arch.framework || []).length ? `<span>🧩 ${escHtml(arch.framework.join(', '))}</span>` : ''}
          ${(arch.styling || []).length ? `<span>🎨 ${escHtml(arch.styling.join(', '))}</span>` : ''}
          <span>✏️ ${(d.headings || []).length} headings</span>
          <span>🔗 ${(d.links || []).length} links</span>
        </div>
      </div>`;
    $('website-qa').style.display = 'flex';
    $('website-domain').textContent = d.title || d.url || url;
    $('website-arch').textContent = (arch.framework || []).join(', ') || 'website analysis';
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
  $('github-analyze-btn').addEventListener('click', analyzeGitHub);
  $('github-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyzeGitHub(); });
  $('github-ask-btn').addEventListener('click', askGitHub);
  $('github-question').addEventListener('keydown', (e) => { if (e.key === 'Enter') askGitHub(); });
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
  const closeSide = () => sidebar.classList.remove('open');
  const toggleSide = () => sidebar.classList.toggle('open');
  [$('toggle-sidebar-btn'), $('mobile-menu-btn')].forEach((b) => b && b.addEventListener('click', toggleSide));
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', closeSide));
  $('logout-btn').addEventListener('click', () => {
    if (confirm('Clear local preferences and reload?')) { localStorage.clear(); location.reload(); }
  });

  initTTS();
  bindAttach();
  bindHackModal();
  bindHackActions();
  bindStudy();
  bindWelcomeChips();
  resetChatUI();
  if (voiceEnabled && !ttsWarmed) { window.speechSynthesis.getVoices(); ttsWarmed = true; }

  loadSessions();

  // Auto-restore last model choice
  const m = localStorage.getItem('preferred_model');
  if (m) $('model-selector').value = m;
}

let ttsWarmed = false;

document.addEventListener('DOMContentLoaded', init);