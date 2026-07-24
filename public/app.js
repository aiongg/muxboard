// Muxboard client. Vanilla, no build step.

const $ = s => document.querySelector(s);
const cardsEl = $('#cards'), emptyEl = $('#empty'), restoreEl = $('#restoreBanner');
const offlineEl = $('#offline'), toastEl = $('#toast');
const backdrop = $('#backdrop'), newSheet = $('#newSheet'), sendSheet = $('#sendSheet');
const settingsSheet = $('#settingsSheet');

let state = null;
let failures = 0;
let pollTimer = null;
let sendTargetName = null;
const armed = new Map();      // session name -> disarm timeout for stop confirm

// ------------------------------------------------------------------- utils

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function age(ms) {
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(path, {
      signal: ctrl.signal,
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (isError ? ' error' : '');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3000);
}

// ------------------------------------------------------------------ polling

async function poll() {
  clearTimeout(pollTimer);
  try {
    state = await api('/api/state');
    failures = 0;
    hideOffline();
    showLogin(false);
    render();
  } catch (e) {
    if (e.status === 401) return showLogin(true); // locked: stop polling until unlocked
    failures++;
    if (!state || failures >= 2) showOffline();
  }
  const delay = offlineEl.hidden ? 3500 : 3000;
  if (!document.hidden) pollTimer = setTimeout(poll, delay);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

function showOffline() {
  offlineEl.hidden = false;
  $('#connDot').className = 'dot off';
  $('#offlineStatus').textContent = 'retrying automatically…';
  // Name the machine once we've ever reached it, even on a cold offline start.
  const host = state?.host || localStorage.getItem('muxboard.host');
  if (host) $('#offlineTitle').textContent = `${host} is unreachable`;
}
function hideOffline() {
  offlineEl.hidden = true;
  $('#connDot').className = 'dot on';
  $('#hostName').textContent = state.host;
  localStorage.setItem('muxboard.host', state.host);
}
$('#retryBtn').addEventListener('click', poll);

// -------------------------------------------------------------------- login

const loginEl = $('#login');

function showLogin(on) {
  if (loginEl.hidden !== on) return; // already in the right state
  loginEl.hidden = !on;
  if (on) {
    clearTimeout(pollTimer);
    offlineEl.hidden = true;
    $('#loginStatus').textContent = '';
    $('#loginPass').value = '';
    $('#loginPass').focus();
  }
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const password = $('#loginPass').value;
  if (!password) return;
  $('#loginStatus').textContent = 'checking…';
  try {
    await api('/api/login', { method: 'POST', body: { password } });
    $('#loginPass').value = '';
    showLogin(false);
    poll();
  } catch (err) {
    $('#loginStatus').textContent = err.message;
    $('#loginPass').select();
  }
});

// Reflect auth state wherever it shows: the password section swaps between
// "claim this instance" and "change or remove the existing password".
function renderAuth() {
  const on = !!state?.auth?.enabled;
  $('#pwState').textContent = on
    ? 'A password is required to use this Muxboard.'
    : 'No password — anyone who can reach this Muxboard can use it.';
  $('#pwCurrent').hidden = !on;
  $('#pwRemove').hidden = !on;
  $('#logoutBtn').hidden = !on;
  $('#pwSubmit').textContent = on ? 'change password' : 'set password';
}

function clearPasswordFields() {
  for (const id of ['#pwCurrent', '#pwNew', '#pwRepeat']) $(id).value = '';
}

$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const next = $('#pwNew').value;
  if (next !== $('#pwRepeat').value) return toast("passwords don't match", true);
  if (next.length < 8) return toast('password must be at least 8 characters', true);
  try {
    await api('/api/password', {
      method: 'POST',
      body: { password: next, current: $('#pwCurrent').value },
    });
    clearPasswordFields();
    toast('password saved — other devices must log in again');
    poll();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#pwRemove').addEventListener('click', async () => {
  try {
    await api('/api/password', { method: 'POST', body: { remove: true, current: $('#pwCurrent').value } });
    clearPasswordFields();
    toast('password removed');
    poll();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    state = null;
    closeSheets();
    showLogin(true);
  } catch (err) {
    toast(err.message, true);
  }
});

// ----------------------------------------------------------------- render

function render() {
  renderUpdate();
  renderRestore();
  renderCards();
  renderFolders();
  renderChips();
  // Only the labels, never the list DOM — a poll must not disturb the sheet.
  if (!settingsSheet.hidden) renderAuth();
}

// ------------------------------------------------------------ claude update

const updateBanner = $('#updateBanner');
let wasUpdating = false;
let updateKey = '';

$('#updateBtn').addEventListener('click', async () => {
  if (state?.claude?.updating) return;
  try {
    await api('/api/update', { method: 'POST' });
    toast('updating claude code…');
    poll();
  } catch (e) {
    toast(e.message, true);
  }
});

function renderUpdate() {
  const c = state.claude || {};
  const btn = $('#updateBtn');
  btn.classList.toggle('busy', !!c.updating);
  btn.title = c.version ? `Claude Code ${c.version}` : 'Update Claude Code';

  if (wasUpdating && !c.updating && c.lastUpdate) {
    const u = c.lastUpdate;
    toast(u.error ? `update failed: ${u.error}`
      : u.changed ? `claude updated: ${u.before} → ${u.after}`
      : `claude is up to date (${c.version})`, !!u.error);
  }
  wasUpdating = !!c.updating;

  // Offer a rolling restart whenever sessions run an older version than the
  // installed binary — however that gap came to be (update button, an update
  // run elsewhere, or long-lived sessions outliving several releases).
  const stale = state.sessions.filter(s => s.stale && !c.pending?.includes(s.name));
  const show = stale.length > 0 && c.version &&
    localStorage.getItem('muxboard.dismissStale') !== c.version;
  if (!show) { updateBanner.hidden = true; updateKey = ''; return; }
  updateBanner.hidden = false;
  const key = c.version + ':' + stale.map(s => s.name).join(',');
  if (updateKey === key) return; // keep nodes stable across polls
  updateKey = key;
  updateBanner.innerHTML = `
    <h3>${stale.length} session${stale.length > 1 ? 's' : ''} on older claude</h3>
    <p class="restore-sub">Installed: ${esc(c.version)} —
      ${stale.map(s => `${esc(s.name)} runs ${esc(s.version || '?')}`).join(', ')}.
      Rolling restart recycles each session once it goes idle — its
      conversation resumes where it left off.</p>
    <div class="restore-actions">
      <button class="btn small" id="updRestartAll">restart ${stale.length > 1 ? 'all' : 'it'}</button>
      <button class="btn small" id="updDismiss">later</button>
    </div>`;
  $('#updRestartAll').addEventListener('click', async () => {
    try {
      await api('/api/restart', { method: 'POST', body: { names: stale.map(s => s.name) } });
      toast('restarting sessions as each goes idle');
      poll();
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('#updDismiss').addEventListener('click', () => {
    localStorage.setItem('muxboard.dismissStale', c.version);
    updateBanner.hidden = true;
  });
}

// Cards render incrementally — nodes are reused across polls, so a refresh
// never resets a screen's scroll position or interrupts a scroll gesture.
function renderCards() {
  const sessions = state.sessions;
  emptyEl.hidden = sessions.length > 0;
  const byName = new Map();
  for (const el of cardsEl.children) byName.set(el.dataset.name, el);

  let prev = null;
  for (const s of sessions) {
    let card = byName.get(s.name);
    const fresh = !card;
    if (card) byName.delete(s.name);
    else card = createCard(s);
    const want = prev ? prev.nextElementSibling : cardsEl.firstElementChild;
    if (card !== want) cardsEl.insertBefore(card, want);
    updateCard(card, s, fresh);
    prev = card;
  }
  for (const gone of byName.values()) gone.remove();
}

function createCard(s) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `
  <article class="card" data-name="${esc(s.name)}">
    <header class="card-top">
      <span class="status"></span>
      <h2>${esc(s.name)}</h2>
      <span class="age"></span>
    </header>
    <div class="meta"></div>
    <div class="screen" role="log" aria-label="Terminal screen" tabindex="0"></div>
    <div class="actions">
      <button class="btn" data-act="send">send</button>
      <button class="btn danger" data-act="stop">stop</button>
    </div>
  </article>`;
  const card = tpl.content.firstElementChild;
  card.querySelector('[data-act=send]').addEventListener('click', () => openSendSheet(s.name));
  card.querySelector('[data-act=stop]').addEventListener('click', e => stopFlow(s.name, e.currentTarget));
  return card;
}

function updateCard(card, s, forceBottom = false) {
  const dot = card.querySelector('.status');
  dot.className = `status ${s.status}`;
  dot.title = s.status;
  card.querySelector('.age').textContent = age(s.createdAt);
  card.querySelector('.meta').innerHTML = `
      <span>${esc(s.repo)}</span>
      ${s.remoteControl ? '<span class="badge app">app</span>' : ''}
      ${s.attached ? '<span class="badge tty">tty</span>' : ''}
      ${s.status === 'attention' ? '<span class="badge state-word">needs you</span>' : ''}
      ${state.claude?.pending?.includes(s.name) ? '<span class="badge queued">restart queued</span>'
        : s.stale ? `<span class="badge stale">${esc(s.version || 'old')}</span>` : ''}`;

  // The screen sticks to the bottom like a terminal: follow new output unless
  // the user has scrolled up to read.
  const screen = card.querySelector('.screen');
  const text = s.peek.join('\n');
  if (screen.textContent !== text) {
    const stick = forceBottom ||
      screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 8;
    screen.textContent = text;
    if (stick) screen.scrollTop = screen.scrollHeight;
  }
}

// ----------------------------------------------------------------- actions

async function doSend(name, payload, doneMsg) {
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}/keys`, { method: 'POST', body: payload });
    toast(`${name}: ${doneMsg}`);
    setTimeout(poll, 600);
  } catch (e) {
    toast(e.message, true);
  }
}

function stopFlow(name, btn) {
  if (armed.has(name)) {
    clearTimeout(armed.get(name));
    armed.delete(name);
    api(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then(() => { toast(`${name} stopped`); poll(); })
      .catch(e => toast(e.message, true));
  } else {
    btn.textContent = 'sure?';
    btn.classList.add('armed');
    armed.set(name, setTimeout(() => {
      armed.delete(name);
      btn.textContent = 'stop';
      btn.classList.remove('armed');
    }, 3000));
  }
}

// ------------------------------------------------------------------ sheets

function openSheet(sheet) {
  backdrop.hidden = false;
  sheet.hidden = false;
}
function closeSheets() {
  backdrop.hidden = true;
  newSheet.hidden = true;
  sendSheet.hidden = true;
  settingsSheet.hidden = true;
}
backdrop.addEventListener('click', closeSheets);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });

// Drag a sheet downward to dismiss it. The first decisive move owns the
// gesture: dragging down while the sheet is at scroll-top is ours (claimed
// with preventDefault before the browser starts a scroll); anything else is
// the browser's. State resets on every touchstart so a cancelled or scrolled
// gesture can never leak into the next one.
for (const sheet of [newSheet, sendSheet, settingsSheet]) {
  let startY = 0, delta = 0, mode = null; // null = undecided, 'drag' | 'scroll'
  let lastY = 0, lastT = 0, vel = 0;

  const settle = () => {
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    mode = null;
    delta = 0;
  };

  sheet.addEventListener('touchstart', e => {
    mode = null;
    delta = 0;
    vel = 0;
    startY = lastY = e.touches[0].clientY;
    lastT = e.timeStamp;
    if (e.touches.length > 1 || e.target.closest('textarea, input')) mode = 'scroll';
  }, { passive: true });

  sheet.addEventListener('touchmove', e => {
    if (mode === 'scroll') return;
    const y = e.touches[0].clientY;
    const dy = y - startY;
    if (mode === null) {
      if (Math.abs(dy) < 6) return; // jitter — intent not clear yet
      mode = dy > 0 && sheet.scrollTop <= 1 ? 'drag' : 'scroll';
      if (mode === 'scroll') return;
    }
    if (!e.cancelable) return settle(); // browser already owns this gesture
    e.preventDefault();
    if (e.timeStamp > lastT) vel = (y - lastY) / (e.timeStamp - lastT);
    lastY = y;
    lastT = e.timeStamp;
    delta = Math.max(0, dy);
    sheet.classList.add('dragging');
    sheet.style.transform = `translateY(${delta}px)`;
  }, { passive: false });

  sheet.addEventListener('touchend', () => {
    if (mode !== 'drag') { mode = null; return; }
    sheet.classList.remove('dragging');
    const flick = vel > 0.6 && delta > 24;
    if (flick || delta > Math.min(160, sheet.offsetHeight * 0.3)) dismissSheet(sheet);
    else sheet.style.transform = '';
    mode = null;
    delta = 0;
  });

  sheet.addEventListener('touchcancel', settle);
}

// Slide the sheet off-screen from wherever the finger left it, then hide.
function dismissSheet(sheet) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    sheet.removeEventListener('transitionend', finish);
    closeSheets();
    sheet.style.transform = '';
  };
  sheet.addEventListener('transitionend', finish);
  setTimeout(finish, 240);
  sheet.style.transform = 'translateY(110%)';
}

$('#newBtn').addEventListener('click', () => openSheet(newSheet));

// Only touch the DOM when the list actually changed — the 3.5s poll must not
// replace nodes under the user's finger mid-gesture.
let folderListHTML = '';
function renderFolders() {
  const multi = conf().roots.length > 1;
  const html = state.folders.map(f => `
    <button class="folder" data-path="${esc(f.path)}">
      <span class="f-name">${esc(f.name)}${multi ? `<span class="f-root">${esc(f.root)}</span>` : ''}</span>
      ${f.running ? `<span class="f-live">${f.running} live</span>` : ''}
      <span class="f-arrow">❯</span>
    </button>`).join('');
  if (html === folderListHTML) return;
  folderListHTML = html;
  $('#folderList').innerHTML = html;
  for (const el of $('#folderList').querySelectorAll('.folder')) {
    el.addEventListener('click', () => createSession(el.dataset.path));
  }
}

$('#customForm').addEventListener('submit', e => {
  e.preventDefault();
  const dir = $('#customDir').value.trim();
  if (dir) createSession(dir);
});

async function createSession(dir) {
  closeSheets();
  const cont = $('#resumeToggle').checked;
  try {
    const made = await api('/api/sessions', { method: 'POST', body: { dir, continue: cont } });
    toast(`${made.name} starting — appears in the Claude app shortly`);
    setTimeout(poll, 800);
  } catch (e) {
    toast(e.message, true);
  }
}

function openSendSheet(name) {
  sendTargetName = name;
  $('#sendTarget').textContent = name;
  $('#sendText').value = '';
  openSheet(sendSheet);
}

$('#chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip || !sendTargetName) return;
  closeSheets();
  if (chip.dataset.key) doSend(sendTargetName, { kind: chip.dataset.key }, `sent ${chip.textContent.trim()}`);
  else doSend(sendTargetName, { kind: 'command', text: chip.dataset.send }, `sent ${chip.dataset.send}`);
});

// ---------------------------------------------------------------- settings
// Shortcuts and repo roots live in the server's config file, so they follow
// you to every device instead of living in one browser.

const conf = () => state?.config || { roots: [], shortcuts: [] };
let chipsHTML = '';

function renderChips() {
  const html = conf().shortcuts.map(s => s.key
    ? `<button class="chip" data-key="${esc(s.key)}">${esc(s.label)}</button>`
    : `<button class="chip" data-send="${esc(s.send)}">${esc(s.label)}</button>`).join('');
  if (html === chipsHTML) return;
  chipsHTML = html;
  $('#chips').innerHTML = html || '<span class="set-hint">No shortcuts yet — add some below.</span>';
}

async function saveConfig(next) {
  try {
    const saved = await api('/api/config', { method: 'PUT', body: next });
    if (state) state.config = saved;
    renderSettings();
    renderChips();
    poll();
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

function renderSettings() {
  const c = conf();
  $('#rootList').innerHTML = c.roots.map((r, i) => `
    <div class="setrow">
      <span class="setrow-main">${esc(r)}</span>
      <button class="btn small danger" data-root="${i}" aria-label="Remove ${esc(r)}">remove</button>
    </div>`).join('') || '<p class="set-hint">No folders configured.</p>';
  for (const b of $('#rootList').querySelectorAll('[data-root]')) {
    b.addEventListener('click', () => {
      const roots = c.roots.filter((_, i) => i !== Number(b.dataset.root));
      if (!roots.length) return toast('keep at least one folder', true);
      saveConfig({ ...c, roots });
    });
  }

  $('#shortcutList').innerHTML = c.shortcuts.map((s, i) => `
    <div class="setrow">
      <span class="setrow-main">${esc(s.label)}</span>
      <span class="setrow-sub">${esc(s.key ? `@${s.key}` : s.send)}</span>
      <button class="btn small danger" data-sc="${i}" aria-label="Remove ${esc(s.label)}">remove</button>
    </div>`).join('') || '<p class="set-hint">No shortcuts yet.</p>';
  for (const b of $('#shortcutList').querySelectorAll('[data-sc]')) {
    b.addEventListener('click', () =>
      saveConfig({ ...c, shortcuts: c.shortcuts.filter((_, i) => i !== Number(b.dataset.sc)) }));
  }
}

function openSettings() {
  renderSettings();
  renderAuth();
  clearPasswordFields();
  openSheet(settingsSheet);
}

$('#settingsBtn').addEventListener('click', () => { closeSheets(); openSettings(); });

$('#rootForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#rootInput').value.trim();
  if (!v) return;
  if (await saveConfig({ ...conf(), roots: [...conf().roots, v] })) $('#rootInput').value = '';
});

$('#shortcutForm').addEventListener('submit', async e => {
  e.preventDefault();
  const label = $('#scLabel').value.trim();
  const value = $('#scSend').value.trim();
  if (!label || !value) return;
  const key = /^@(enter|return)$/i.test(value) ? 'enter'
    : /^@(esc|escape)$/i.test(value) ? 'escape' : null;
  const entry = key ? { label, key } : { label, send: value };
  if (await saveConfig({ ...conf(), shortcuts: [...conf().shortcuts, entry] })) {
    $('#scLabel').value = '';
    $('#scSend').value = '';
  }
});

$('#sendGo').addEventListener('click', () => {
  const text = $('#sendText').value.trim();
  if (!text || !sendTargetName) return;
  closeSheets();
  doSend(sendTargetName, { kind: text.startsWith('/') ? 'command' : 'text', text }, `sent to ${sendTargetName}`);
});

// ----------------------------------------------------------------- restore

function renderRestore() {
  const r = state.restore;
  const dismissed = localStorage.getItem('muxboard.dismissRestore');
  if (!r || String(r.savedAt) === dismissed) { restoreEl.hidden = true; return; }
  restoreEl.hidden = false;
  restoreEl.innerHTML = `
    <h3>rebooted — these were open</h3>
    ${r.sessions.map(s => `
      <div class="restore-row">
        <span class="r-name">${esc(s.name)}<span class="r-path">${esc(s.repo)}</span></span>
        <button class="btn small" data-restore="${esc(s.name)}">restore</button>
      </div>`).join('')}
    <div class="restore-actions">
      <button class="btn small" id="restoreAll">restore all</button>
      <button class="btn small" id="restoreDismiss">dismiss</button>
    </div>`;
  for (const btn of restoreEl.querySelectorAll('[data-restore]')) {
    btn.addEventListener('click', () => doRestore([btn.dataset.restore]));
  }
  $('#restoreAll').addEventListener('click', () => doRestore(r.sessions.map(s => s.name)));
  $('#restoreDismiss').addEventListener('click', () => {
    localStorage.setItem('muxboard.dismissRestore', String(r.savedAt));
    restoreEl.hidden = true;
  });
}

async function doRestore(names) {
  try {
    await api('/api/restore', { method: 'POST', body: { names } });
    toast(`restoring ${names.length} session${names.length > 1 ? 's' : ''} — resuming last conversations`);
    setTimeout(poll, 800);
  } catch (e) {
    toast(e.message, true);
  }
}

// ------------------------------------------------------------------- boot

// The shell is served cache-first, so a new service worker's assets would
// otherwise only appear on some later launch. Reload once as soon as the new
// worker takes control, and the app updates on the first reopen.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing stale yet
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js');
}
poll();
