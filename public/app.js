// Muxboard client. Vanilla, no build step.

const $ = s => document.querySelector(s);
const appEl = $('#app'), rowsEl = $('#rows'), emptyEl = $('#empty'), restoreEl = $('#restoreBanner');
const offlineEl = $('#offline'), toastEl = $('#toast');
const backdrop = $('#backdrop'), newSheet = $('#newSheet'), sendSheet = $('#sendSheet');
const settingsSheet = $('#settingsSheet');
const detailBody = $('#detailBody'), detailEmpty = $('#detailEmpty');
const screenEl = $('#dScreen'), screenText = $('#dScreenText');

let state = null;
let failures = 0;
let pollTimer = null;
let sendTargetName = null;
let selected = null;          // name of the session shown in the detail pane
const armed = new Map();      // "stop:name" / "fresh:name" -> disarm timer for two-tap confirm

// Two panes side by side on a wide screen; one at a time on a phone.
const wide = matchMedia('(min-width: 880px)');

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
  $('#pwCurrentField').hidden = !on;
  $('#pwRemove').hidden = !on;
  $('#logoutBtn').hidden = !on;
  $('#pwSubmit').textContent = on ? 'change password' : 'set password';
  $('#pwNew').placeholder = on ? 'new password' : 'password';
}

// One field with a reveal toggle beats asking people to type it twice.
for (const btn of document.querySelectorAll('.reveal')) {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.reveal);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'show' : 'hide';
  });
}

function clearPasswordFields() {
  for (const id of ['#pwCurrent', '#pwNew']) {
    $(id).value = '';
    $(id).type = 'password';
  }
  for (const btn of document.querySelectorAll('.reveal')) btn.textContent = 'show';
}

$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const next = $('#pwNew').value;
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
  renderRows();
  renderDetail();
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

// ------------------------------------------------------------------- list

// Rows render incrementally — nodes are reused across polls, so a refresh
// never resets the list's scroll position or interrupts a scroll gesture.
function renderRows() {
  const sessions = state.sessions;
  emptyEl.hidden = sessions.length > 0;
  const byName = new Map();
  for (const el of rowsEl.children) byName.set(el.dataset.name, el);

  let prev = null;
  for (const s of sessions) {
    let row = byName.get(s.name);
    if (row) byName.delete(s.name);
    else row = createRow(s);
    const want = prev ? prev.nextElementSibling : rowsEl.firstElementChild;
    if (row !== want) rowsEl.insertBefore(row, want);
    updateRow(row, s);
    prev = row;
  }
  for (const gone of byName.values()) gone.remove();
}

function createRow(s) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `
  <button class="row" data-name="${esc(s.name)}">
    <span class="status"></span>
    <span class="row-body">
      <span class="row-top"><span class="row-name">${esc(s.name)}</span><span class="age"></span></span>
      <span class="row-sub"></span>
      <span class="row-last"></span>
    </span>
    <span class="row-arrow" aria-hidden="true">❯</span>
  </button>`;
  const row = tpl.content.firstElementChild;
  row.addEventListener('click', () => select(s.name));
  return row;
}

function updateRow(row, s) {
  row.classList.toggle('on', s.name === selected);
  row.setAttribute('aria-current', s.name === selected ? 'true' : 'false');
  const dot = row.querySelector('.status');
  dot.className = `status ${s.status}`;
  dot.title = s.status;
  row.querySelector('.age').textContent = age(s.createdAt);
  row.querySelector('.row-sub').innerHTML = `<span class="row-repo">${esc(s.repo)}</span>${badges(s)}`;
  // The last thing on screen, so a glance at the list says what each one is up to.
  const last = s.peek.map(l => l.trim()).filter(Boolean).at(-1) || '';
  row.querySelector('.row-last').textContent = last;
}

function badges(s) {
  return `${s.remoteControl ? '<span class="badge app">app</span>' : ''}
      ${s.attached ? '<span class="badge tty">tty</span>' : ''}
      ${s.status === 'attention' ? '<span class="badge state-word">needs you</span>' : ''}
      ${state.claude?.pending?.includes(s.name) ? '<span class="badge queued">restart queued</span>'
        : s.stale ? `<span class="badge stale">${esc(s.version || 'old')}</span>` : ''}`;
}

// ----------------------------------------------------------------- detail

let shownName = null; // which session the detail pane currently displays

function renderDetail() {
  const s = selected && state.sessions.find(x => x.name === selected);
  if (!s) {
    if (selected) {
      // The session we were looking at is gone (stopped, or never existed).
      select(null, { replace: true });
      return;
    }
    if (!selected && wide.matches && state.sessions.length) {
      select(state.sessions[0].name, { replace: true }); // never an empty pane on desktop
      return;
    }
    detailBody.hidden = true;
    detailEmpty.hidden = false;
    shownName = null;
    return;
  }
  detailEmpty.hidden = true;
  detailBody.hidden = false;
  const fresh = shownName !== s.name;
  shownName = s.name;

  const dot = $('#dStatus');
  dot.className = `status ${s.status}`;
  dot.title = s.status;
  $('#dName').textContent = s.name;
  $('#dAge').textContent = age(s.createdAt);
  $('#dMeta').innerHTML = `<span>${esc(s.repo)}</span>${badges(s)}`;

  // The screen sticks to the bottom like a terminal: follow new output unless
  // the user has scrolled up to read.
  const text = s.peek.join('\n');
  if (fresh || screenText.textContent !== text) {
    const stick = fresh || screenEl.scrollTop + screenEl.clientHeight >= screenEl.scrollHeight - 8;
    screenText.textContent = text;
    if (stick) screenEl.scrollTop = screenEl.scrollHeight;
  }
  syncActionButtons();
  sendRect = $('#sendBtn').getBoundingClientRect();
}

// Selection drives the URL hash so a reload lands on the same session, and on
// a phone the browser's back button returns to the list.
function nameFromHash() {
  try { return decodeURIComponent(location.hash.slice(1)) || null; } catch { return null; }
}

function select(name, { replace = false } = {}) {
  selected = name;
  const url = name ? `#${encodeURIComponent(name)}` : location.pathname;
  if (replace || wide.matches || name === nameFromHash()) history.replaceState({ s: name }, '', url);
  else history.pushState({ s: name, pushed: true }, '', url);
  appEl.dataset.view = name ? 'detail' : 'list';
  if (state) { renderRows(); renderDetail(); }
}

window.addEventListener('popstate', () => {
  selected = nameFromHash();
  appEl.dataset.view = selected ? 'detail' : 'list';
  if (state) { renderRows(); renderDetail(); }
});

$('#backBtn').addEventListener('click', () => {
  if (history.state?.pushed) history.back();
  else select(null, { replace: true });
});

// ----------------------------------------------------------------- actions

async function doSend(name, payload, doneMsg) {
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}/keys`, { method: 'POST', body: payload });
    if (doneMsg) toast(`${name}: ${doneMsg}`);
    setTimeout(poll, doneMsg ? 600 : 350);
  } catch (e) {
    toast(e.message, true);
  }
}

// A single keypress — arrows to pick a menu option, enter, esc. No toast: the
// screen itself shows the result a moment later.
function sendKey(key) {
  if (selected) doSend(selected, { kind: 'key', key });
}

$('#keypad').addEventListener('click', e => {
  const btn = e.target.closest('[data-key]');
  if (btn) sendKey(btn.dataset.key);
});

// On a desktop, focus the screen and the navigation keys go straight through.
const KEY_FROM_EVENT = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'escape' };
document.addEventListener('keydown', e => {
  if (document.activeElement === screenEl && backdrop.hidden && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const key = KEY_FROM_EVENT[e.key];
    if (key) { e.preventDefault(); sendKey(key); return; }
  }
  if (e.key === 'Escape') closeSheets();
});

$('#sendBtn').addEventListener('click', () => { if (selected) openSendSheet(selected); });

// Disruptive actions take two taps: the first arms the button for 3s.
function twoTap(act, btn, run) {
  const key = `${act}:${selected}`;
  if (armed.has(key)) {
    clearTimeout(armed.get(key));
    armed.delete(key);
    syncActionButtons();
    run(selected);
  } else {
    armed.set(key, setTimeout(() => { armed.delete(key); syncActionButtons(); }, 3000));
    syncActionButtons();
  }
}

function syncActionButtons() {
  for (const [act, btn] of [['fresh', $('#freshBtn')], ['stop', $('#stopBtn')]]) {
    const on = armed.has(`${act}:${selected}`);
    btn.textContent = on ? 'sure?' : act;
    btn.classList.toggle('armed', on);
  }
}

// Roll the session over to a fresh context: the server captures the
// transcript UUID, /clear s, and invokes the restore skill.
$('#freshBtn').addEventListener('click', e => twoTap('fresh', e.currentTarget, name => {
  api(`/api/sessions/${encodeURIComponent(name)}/rollover`, { method: 'POST' })
    .then(() => { toast(`${name}: fresh chat — restoring from the transcript`); setTimeout(poll, 800); })
    .catch(e => toast(e.message, true));
}));

$('#stopBtn').addEventListener('click', e => twoTap('stop', e.currentTarget, name => {
  api(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(() => { toast(`${name} stopped`); poll(); })
    .catch(e => toast(e.message, true));
}));

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
  if (chip.dataset.key) doSend(sendTargetName, { kind: 'key', key: chip.dataset.key }, `sent ${chip.textContent.trim()}`);
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

function showSettingsTab(name) {
  for (const seg of $('#segments').querySelectorAll('.seg')) {
    const on = seg.dataset.tab === name;
    seg.classList.toggle('on', on);
    seg.setAttribute('aria-selected', String(on));
  }
  for (const panel of settingsSheet.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

$('#segments').addEventListener('click', e => {
  const seg = e.target.closest('.seg');
  if (seg) showSettingsTab(seg.dataset.tab);
});

// A few layout facts, for diagnosing a phone that hides part of the UI: the
// viewport the page laid out in, what the browser reports as the bottom
// system-bar inset, and where the send button actually landed.
let sendRect = null; // where the send button last laid out, while a session was open
function renderDiagnostics() {
  const inset = getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom').trim() || '0px';
  const send = sendRect || { top: 0, bottom: 0 };
  const visual = window.visualViewport ? Math.round(window.visualViewport.height) : innerHeight;
  $('#diag').textContent = `viewport ${innerWidth}×${innerHeight} · visual ${visual} · page ${document.scrollingElement.scrollHeight}`
    + ` · safe-bottom ${inset} · send ${Math.round(send.top)}–${Math.round(send.bottom)}`;
}

function openSettings() {
  renderSettings();
  renderAuth();
  clearPasswordFields();
  renderDiagnostics();
  showSettingsTab('folders');
  openSheet(settingsSheet);
}

$('#settingsBtn').addEventListener('click', () => { closeSheets(); openSettings(); });

$('#rootForm').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#rootInput').value.trim();
  if (!v) return;
  if (await saveConfig({ ...conf(), roots: [...conf().roots, v] })) $('#rootInput').value = '';
});

// "@up" in the add form → a keypress chip. Server-side names in KEYS (server.mjs).
const KEY_SHORTHAND = {
  enter: 'enter', return: 'enter', esc: 'escape', escape: 'escape',
  up: 'up', down: 'down', left: 'left', right: 'right', tab: 'tab',
  'shift-tab': 'btab', shifttab: 'btab', btab: 'btab', backspace: 'backspace', bs: 'backspace',
};
function keyFromShorthand(v) {
  const m = /^@([a-z-]+)$/i.exec(v.trim());
  return m ? KEY_SHORTHAND[m[1].toLowerCase()] || null : null;
}

$('#shortcutForm').addEventListener('submit', async e => {
  e.preventDefault();
  const label = $('#scLabel').value.trim();
  const value = $('#scSend').value.trim();
  if (!label || !value) return;
  const key = keyFromShorthand(value);
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
  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Browsers only look for a new worker on navigation, and a phone that
    // resumes a backgrounded PWA never navigates. Check on every foreground
    // instead, and every so often while open.
    const check = () => { if (!document.hidden) reg.update().catch(() => {}); };
    document.addEventListener('visibilitychange', check);
    setInterval(check, 15 * 60 * 1000);
  }).catch(() => {});
  // The cache name is the shell version actually being served, for diagnosis.
  caches.keys().then(keys => { $('#shellVersion').textContent = keys.join(', ') || 'none'; }).catch(() => {});
} else {
  $('#shellVersion').textContent = 'no service worker';
}
select(nameFromHash(), { replace: true });
poll();
