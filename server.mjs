#!/usr/bin/env node
// Muxboard — manage Claude Code sessions living in tmux, from a phone.
// Zero runtime dependencies. Serves the PWA and a small JSON API on localhost.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, readlinkSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, basename, sep } from 'node:path';
import { homedir, hostname } from 'node:os';
import { scryptSync, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const exec = promisify(execFile);

const PORT = Number(process.env.PORT || 8800);
const HOST = process.env.HOST || '127.0.0.1';
const HOME = homedir();
const REPOS_ROOT = process.env.MUX_ROOT || process.env.DECK_ROOT || HOME;
const CLAUDE_BIN = process.env.MUX_CLAUDE || process.env.DECK_CLAUDE || join(HOME, '.local/bin/claude');
const STATE_DIR = join(HOME, '.local/state/muxboard');
const SNAPSHOT_FILE = join(STATE_DIR, 'snapshot.json');
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'muxboard');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');
const PUBLIC_DIR = join(new URL('.', import.meta.url).pathname, 'public');
const HOSTNAME = hostname();

// ---------------------------------------------------------------------- auth
// A password is optional: with no auth.json the server behaves as if this
// section did not exist. When one is set, every /api/ route needs a session
// cookie. The hash lives outside config.json because that file is handed to
// the client on every poll.

const SESSION_COOKIE = 'muxboard_session';
const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000;

let authCache = { mtimeMs: -1, value: null };
function loadAuth() {
  let st;
  try {
    st = statSync(AUTH_FILE);
  } catch {
    authCache = { mtimeMs: -1, value: null };
    return null;
  }
  if (st.mtimeMs !== authCache.mtimeMs) {
    let value = null;
    try {
      const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
      if (raw?.hash && raw?.salt && raw?.secret) value = raw;
    } catch { /* unreadable or malformed: treated as no password */ }
    authCache = { mtimeMs: st.mtimeMs, value };
  }
  return authCache.value;
}

function checkPassword(password, auth) {
  let derived;
  try {
    derived = scryptSync(String(password), Buffer.from(auth.salt, 'hex'), 32,
      { N: auth.N || 32768, r: auth.r || 8, p: auth.p || 1, maxmem: 128 * 1024 * 1024 });
  } catch {
    return false;
  }
  const expected = Buffer.from(auth.hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Sessions are stateless and signed, so a service restart doesn't sign anyone
// out. Changing the password rotates the secret, which invalidates them all.
const signSession = (auth, issued, nonce) =>
  createHmac('sha256', Buffer.from(auth.secret, 'hex')).update(`${issued}.${nonce}`).digest('hex');

function issueSession(auth) {
  const issued = Date.now();
  const nonce = randomBytes(12).toString('hex');
  return `${issued}.${nonce}.${signSession(auth, issued, nonce)}`;
}

function validSession(token, auth) {
  const [issued, nonce, mac] = String(token || '').split('.');
  if (!issued || !nonce || !mac) return false;
  const age = Date.now() - Number(issued);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_MAX_AGE) return false;
  const want = Buffer.from(signSession(auth, Number(issued), nonce), 'hex');
  const got = Buffer.from(mac, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionCookie(req, token) {
  const https = req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE / 1000}; HttpOnly; SameSite=Strict` +
    (https ? '; Secure' : '');
}

// Guessing is throttled process-wide; this is a single-user password.
let loginFailures = 0;
let lockedUntil = 0;

// -------------------------------------------------------------- user config
// Everything a person tailors — which folders to offer, which send-key chips
// to show — lives in one small JSON file, editable from the app or by hand.

const DEFAULT_SHORTCUTS = [
  { label: '/clear', send: '/clear' },
  { label: '↵ enter', key: 'enter' },
  { label: 'esc', key: 'escape' },
];

const defaultConfig = () => ({
  roots: [shortPath(REPOS_ROOT)],
  shortcuts: DEFAULT_SHORTCUTS.map(s => ({ ...s })),
});

function cleanShortcut(s) {
  if (!s || typeof s !== 'object') return null;
  const label = String(s.label ?? '').trim().slice(0, 24);
  if (!label) return null;
  if (s.key === 'enter' || s.key === 'escape') return { label, key: s.key };
  const send = String(s.send ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  return send ? { label, send } : null;
}

function normalizeConfig(raw) {
  const def = defaultConfig();
  const roots = Array.isArray(raw?.roots)
    ? [...new Set(raw.roots.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()))].slice(0, 8)
    : [];
  const shortcuts = Array.isArray(raw?.shortcuts)
    ? raw.shortcuts.map(cleanShortcut).filter(Boolean).slice(0, 12)
    : def.shortcuts;
  return { roots: roots.length ? roots : def.roots, shortcuts };
}

let configCache = null;
async function loadConfig() {
  if (configCache) return configCache;
  let raw = null;
  try { raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  configCache = normalizeConfig(raw);
  return configCache;
}

async function saveConfig(raw) {
  const cfg = normalizeConfig(raw);
  for (const r of cfg.roots) expandDir(r); // same $HOME rule as session dirs
  configCache = cfg;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

// ---------------------------------------------------------------- tmux layer

async function tmux(...args) {
  try {
    const { stdout } = await exec('tmux', args, { timeout: 5000 });
    return { ok: true, out: stdout };
  } catch (err) {
    return { ok: false, out: '', err: String(err.stderr || err.message || err) };
  }
}

const SEP = '\x1f';

// A "muxboard session" is any tmux session whose active pane is running Claude Code.
async function listSessions() {
  const fmt = [
    '#{session_name}', '#{session_created}', '#{session_attached}',
    '#{pane_pid}', '#{pane_current_path}', '#{pane_current_command}',
  ].join(SEP);
  const res = await tmux('list-panes', '-a', '-F', fmt);
  if (!res.ok) return { tmuxRunning: false, sessions: [] };

  const sessions = [];
  const seen = new Set();
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, panePid, cwd, cmd] = line.split(SEP);
    if (seen.has(name)) continue; // one entry per session (active pane wins)
    const claude = findClaudeProcess(Number(panePid));
    if (!claude && cmd !== 'claude') continue;
    seen.add(name);
    sessions.push({
      name,
      cwd,
      repo: shortPath(cwd),
      createdAt: Number(created) * 1000,
      attached: Number(attached) > 0,
      remoteControl: claude ? claude.remoteControl : false,
      pid: claude ? claude.pid : Number(panePid),
      version: claudeExeVersion(claude ? claude.pid : Number(panePid)),
    });
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  return { tmuxRunning: true, sessions };
}

// Walk the pane's process tree looking for the claude binary.
function findClaudeProcess(rootPid, depth = 0) {
  if (!rootPid || depth > 4) return null;
  const info = procInfo(rootPid);
  if (info && info.isClaude) return info;
  for (const child of procChildren(rootPid)) {
    const found = findClaudeProcess(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function procInfo(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const exe = cmdline[0] || '';
    const isClaude = /(^|\/)claude(\s|$)/.test(exe) || cmdline.slice(0, 2).some(a => a.endsWith('/claude'));
    return { pid, isClaude, remoteControl: cmdline.includes('--remote-control') };
  } catch {
    return null;
  }
}

function procChildren(pid) {
  const kids = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const data = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
      if (data) kids.push(...data.split(/\s+/).map(Number));
    }
  } catch { /* process vanished */ }
  return kids;
}

// The native install launches a per-version binary (~/.local/share/claude/
// versions/<v>), so a running process's exe link names the exact version it
// is still executing — even after that file was deleted by an update.
function claudeExeVersion(pid) {
  try {
    const exe = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    const m = exe.match(/\/versions\/([^/]+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function shortPath(p) {
  if (!p) return '';
  if (p.startsWith(HOME)) return '~' + p.slice(HOME.length);
  return p;
}

// -------------------------------------------------------- transcript peeking

// Capture the pane and trim Claude Code's TUI chrome so the peek shows the
// conversation, not the input box borders. Status is read from the visible
// screen only — spinners and dialogs live there, and stale copies of them in
// scrollback must not count. The returned lines include scrollback when asked,
// so the client's screen can scroll back through recent history. lines <= 0
// means "everything captured".
async function peek(name, lines = 0, scrollback = 0) {
  const vis = await tmux('capture-pane', '-p', '-t', `=${name}:`);
  if (!vis.ok) return { lines: [], status: 'gone' };

  let status = 'idle';
  if (/esc to interrupt/i.test(vis.out)) status = 'working';
  // The TUI renders choice dialogs (trust, permissions, plan approval) as a
  // numbered list with a ❯ cursor — that's the "waiting on you" signal.
  if (/❯\s*\d+\.\s/.test(vis.out)) status = 'attention';

  let out = vis.out;
  if (scrollback > 0) {
    const res = await tmux('capture-pane', '-p', '-t', `=${name}:`, '-S', `-${scrollback}`);
    if (res.ok) out = res.out;
  }
  let rows = out.split('\n').map(r => r.trimEnd());

  // Strip trailing blank rows and footer hints.
  while (rows.length && isChromeFooter(rows[rows.length - 1])) rows.pop();

  // Strip the prompt box: the last bordered block hugging the bottom.
  const lastClose = rows.length - 1;
  if (lastClose >= 0 && /^\s*[╰└]/.test(rows[lastClose])) {
    let open = lastClose;
    while (open >= 0 && !/^\s*[╭┌]/.test(rows[open])) open--;
    if (open >= 0 && lastClose - open <= 8) rows = rows.slice(0, open);
  }

  while (rows.length && rows[rows.length - 1] === '') rows.pop();

  // Collapse runs of blank rows and drop banner noise, keep the tail.
  const cleaned = [];
  for (let r of rows) {
    if (/·\s*\/passes|Share Claude Code/.test(r)) continue;
    if (/\/remote-control is active|https:\/\/claude\.ai\/code\//.test(r)) continue;
    // The welcome-screen logo is block-element art; fonts render it as tofu.
    if (/^\s*[▀-▟]/.test(r)) r = r.replace(/^\s*[▀-▟](?:[▀-▟ ]*[▀-▟])?\s*/, '');
    if (r === '' && (!cleaned.length || cleaned[cleaned.length - 1] === '')) continue;
    cleaned.push(r);
  }
  while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return { lines: lines > 0 ? cleaned.slice(-lines) : cleaned, status };
}

function isChromeFooter(row) {
  if (row === '') return true;
  if (/^\s*─{8,}/.test(row)) return true;   // prompt-area rules (may embed the session name)
  if (/^\s*❯\s*$/.test(row)) return true;   // empty input prompt
  if (/^\s*\/rc\s*$/.test(row)) return true;
  return /\? for shortcuts|← for agents|shift\+tab to cycle|@ to mention|ctrl\+_ to undo|bypass permissions|plan mode|accept edits on|manual mode|auto mode on|·\s*\/effort/i.test(row);
}

// ------------------------------------------------------------ session verbs

function sanitizeName(raw) {
  const s = String(raw || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40);
}

async function uniqueName(base) {
  const { sessions } = await listSessions();
  const taken = new Set(sessions.map(s => s.name));
  const all = await tmux('list-sessions', '-F', '#{session_name}');
  if (all.ok) for (const n of all.out.split('\n')) taken.add(n);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// Accept any existing directory under $HOME; "~" expands to $HOME. The check
// is made against the resolved real path, so a symlink pointing out of $HOME
// can't be used to reach the rest of the filesystem.
const HOME_REAL = (() => { try { return realpathSync(HOME); } catch { return HOME; } })();

function expandDir(dir) {
  const r = resolve(String(dir || '').replace(/^~(?=\/|$)/, HOME));
  let real;
  try { real = realpathSync(r); } catch { throw httpError(400, `no such directory: ${shortPath(r)}`); }
  if (real !== HOME_REAL && !real.startsWith(HOME_REAL + sep)) {
    throw httpError(400, 'directory must be under ~');
  }
  if (!statSync(real).isDirectory()) throw httpError(400, `not a directory: ${shortPath(r)}`);
  return real;
}

async function createSession({ dir, name, cont }) {
  const target = expandDir(dir);
  const base = sanitizeName(name) || sanitizeName(basename(target)) || 'session';
  const finalName = await uniqueName(base);
  const rcName = `${HOSTNAME}:${finalName}`;
  const cmd = `exec ${shq(CLAUDE_BIN)} ${cont ? '--continue ' : ''}--remote-control --name ${shq(rcName)}`;
  const res = await tmux('new-session', '-d', '-s', finalName, '-c', target, '/bin/zsh', '-lc', cmd);
  if (!res.ok) throw httpError(500, res.err);
  return { name: finalName, rcName };
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

async function killSession(name) {
  const res = await tmux('kill-session', '-t', `=${name}`);
  if (!res.ok) throw httpError(404, res.err);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendKeys(name, { kind, text }) {
  const target = `=${name}:`;
  if (kind === 'escape') return void await tmux('send-keys', '-t', target, 'Escape');
  if (kind === 'enter') return void await tmux('send-keys', '-t', target, 'Enter');
  const body = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!body) throw httpError(400, 'empty text');
  const res = await tmux('send-keys', '-t', target, '-l', '--', body);
  if (!res.ok) throw httpError(404, res.err);
  // Slash commands pop the TUI autocomplete; give it a beat before Enter.
  await sleep(body.startsWith('/') ? 450 : 120);
  await tmux('send-keys', '-t', target, 'Enter');
}

// ------------------------------------------------ claude update & recycling

let versionCache = { value: null, at: 0 };
async function claudeVersion(force = false) {
  if (!force && versionCache.value && Date.now() - versionCache.at < 3600_000) return versionCache.value;
  try {
    const { stdout } = await exec(CLAUDE_BIN, ['--version'], { timeout: 15000 });
    versionCache = { value: stdout.trim().replace(/\s*\(.*\)$/, ''), at: Date.now() };
  } catch {
    versionCache = { value: null, at: Date.now() };
  }
  return versionCache.value;
}

const update = { running: false, last: null };
async function runUpdate() {
  update.running = true;
  const before = await claudeVersion(true);
  try {
    await exec(CLAUDE_BIN, ['update'], { timeout: 300000 });
    const after = await claudeVersion(true);
    update.last = { at: Date.now(), before, after, changed: !!after && after !== before };
  } catch (err) {
    update.last = {
      at: Date.now(), before, after: before, changed: false,
      error: String(err.stderr || err.message || err).slice(0, 400),
    };
  } finally {
    update.running = false;
  }
}

// Rolling restart: queued sessions are recycled — killed and relaunched with
// --continue, resuming the same conversation on the new binary — one sweep at
// a time, each as soon as it is seen idle. Busy or attention sessions wait.
const pendingRestart = new Set();
const restarting = new Set();
let restartTimer = null, sweepBusy = false;

function ensureRestartLoop() {
  if (restartTimer) return;
  restartTimer = setInterval(async () => {
    if (sweepBusy) return;
    if (!pendingRestart.size && !restarting.size) {
      clearInterval(restartTimer);
      restartTimer = null;
      return;
    }
    sweepBusy = true;
    try {
      const { sessions } = await listSessions();
      const peeked = await Promise.all(sessions.map(async s => ({ ...s, peek: await peek(s.name) })));
      processRestarts(peeked);
    } finally {
      sweepBusy = false;
    }
  }, 5000);
}

// A session with no saved conversation cannot be recycled: --continue with
// nothing to continue exits immediately and the tmux session dies with it.
function hasConversation(cwd) {
  try {
    const proj = join(HOME, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    return readdirSync(proj).some(f => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

function processRestarts(peeked) {
  const live = new Map(peeked.map(s => [s.name, s]));
  for (const name of pendingRestart) {
    const s = live.get(name);
    if (!s) { pendingRestart.delete(name); continue; }
    if (!hasConversation(s.cwd)) { pendingRestart.delete(name); continue; }
    if (restarting.has(name) || s.peek.status !== 'idle') continue;
    restarting.add(name);
    (async () => {
      try {
        await killSession(name);
        await createSession({ dir: s.cwd, name, cont: true });
      } catch { /* session vanished mid-recycle; nothing to roll back */ }
      finally {
        pendingRestart.delete(name);
        restarting.delete(name);
      }
    })();
  }
}

// ------------------------------------------------------- snapshot & restore

function bootId() {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return 'unknown'; }
}

let snapshotCache = null;
async function loadSnapshot() {
  if (snapshotCache) return snapshotCache;
  try { snapshotCache = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')); }
  catch { snapshotCache = { bootId: null, updatedAt: 0, sessions: [] }; }
  return snapshotCache;
}

async function saveSnapshot(sessions) {
  const snap = {
    bootId: bootId(),
    updatedAt: Date.now(),
    sessions: sessions.map(s => ({ name: s.name, cwd: s.cwd })),
  };
  const prev = await loadSnapshot();
  if (JSON.stringify(prev.sessions) === JSON.stringify(snap.sessions) && prev.bootId === snap.bootId) return;
  snapshotCache = snap;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
}

// Restore is offered only when the box rebooted since the snapshot was taken.
async function restoreOffer(tmuxRunning, live) {
  const snap = await loadSnapshot();
  if (!snap.sessions.length || snap.bootId === bootId()) return null;
  const liveNames = new Set(live.map(s => s.name));
  const missing = snap.sessions.filter(s => !liveNames.has(s.name) && existsSync(s.cwd));
  if (!missing.length) return null;
  return { savedAt: snap.updatedAt, sessions: missing.map(s => ({ ...s, repo: shortPath(s.cwd) })) };
}

// ----------------------------------------------------------------- folders

async function listFolders(liveSessions, cfg) {
  const counts = {};
  for (const s of liveSessions) counts[s.cwd] = (counts[s.cwd] || 0) + 1;
  const out = [];
  const seen = new Set();
  for (const root of cfg.roots) {
    let base;
    try { base = expandDir(root); } catch { continue; } // missing root: skip
    let entries = [];
    try { entries = await readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(base, entry.name);
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ name: entry.name, path, root: shortPath(base), running: counts[path] || 0 });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// -------------------------------------------------------------- HTTP layer

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw httpError(413, 'body too large');
  }
  return data ? JSON.parse(data) : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = resolve(join(PUBLIC_DIR, file));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return notFound(res);
  try {
    const info = await stat(full);
    if (!info.isFile()) return notFound(res);
    const ext = extname(full);
    const immutable = ext === '.woff2' || ext === '.png' || ext === '.svg';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache',
    });
    res.end(await readFile(full));
  } catch {
    notFound(res);
  }
}

// Muxboard has no auth, so a browser on any web page must not be able to drive it.
// Browsers send "simple" POSTs cross-origin with no preflight — the attacker
// can't read the reply, but the side effect (keystrokes into a live session)
// still happens. Same-origin browser requests identify themselves via
// Sec-Fetch-Site or a matching Origin; anything cross-site is refused.
// Non-browser clients (curl, scripts) send neither header and are unaffected.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function notFound(res) { res.writeHead(404); res.end('not found'); }
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return json(res, 403, { error: 'cross-site request blocked' });
    }
    // The app shell is public so it can render a login screen; the API is not.
    if (!path.startsWith('/api/')) return await serveStatic(res, path);

    const auth = loadAuth();

    if (req.method === 'GET' && path === '/api/auth') {
      return json(res, 200, {
        enabled: !!auth,
        authenticated: !auth || validSession(readCookie(req, SESSION_COOKIE), auth),
      });
    }

    if (req.method === 'POST' && path === '/api/login') {
      if (!auth) return json(res, 400, { error: 'no password is set' });
      const wait = lockedUntil - Date.now();
      if (wait > 0) return json(res, 429, { error: `too many attempts — wait ${Math.ceil(wait / 1000)}s` });
      const body = await readBody(req);
      if (!checkPassword(body.password ?? '', auth)) {
        loginFailures++;
        if (loginFailures >= 3) {
          lockedUntil = Date.now() + Math.min(60_000, 250 * 2 ** (loginFailures - 3));
        }
        return json(res, 401, { error: 'wrong password' });
      }
      loginFailures = 0;
      lockedUntil = 0;
      res.setHeader('Set-Cookie', sessionCookie(req, issueSession(auth)));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/logout') {
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
      return json(res, 200, { ok: true });
    }

    if (auth && !validSession(readCookie(req, SESSION_COOKIE), auth)) {
      return json(res, 401, { error: 'authentication required' });
    }

    if (req.method === 'GET' && path === '/api/state') {
      const { tmuxRunning, sessions } = await listSessions();
      const cfg = await loadConfig();
      const current = await claudeVersion();
      const peeked = await Promise.all(sessions.map(async s => ({ ...s, peek: await peek(s.name, 0, 300) })));
      if (tmuxRunning) await saveSnapshot(sessions);
      return json(res, 200, {
        host: HOSTNAME,
        now: Date.now(),
        tmuxRunning,
        sessions: peeked.map(s => ({
          ...s,
          status: s.peek.status,
          peek: s.peek.lines,
          stale: !!(s.version && current && s.version !== current),
        })),
        folders: await listFolders(sessions, cfg),
        restore: await restoreOffer(tmuxRunning, sessions),
        config: cfg,
        auth: { enabled: !!auth },
        claude: {
          version: current,
          updating: update.running,
          lastUpdate: update.last,
          pending: [...pendingRestart, ...restarting],
        },
      });
    }

    if (path === '/api/config') {
      if (req.method === 'GET') return json(res, 200, await loadConfig());
      if (req.method === 'PUT') return json(res, 200, await saveConfig(await readBody(req)));
    }

    if (req.method === 'POST' && path === '/api/update') {
      if (update.running) return json(res, 409, { error: 'update already running' });
      runUpdate();
      return json(res, 202, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/restart') {
      const body = await readBody(req);
      const { sessions } = await listSessions();
      const live = new Set(sessions.map(s => s.name));
      for (const n of body.names || []) if (live.has(n)) pendingRestart.add(n);
      ensureRestartLoop();
      return json(res, 200, { queued: [...pendingRestart] });
    }

    if (req.method === 'POST' && path === '/api/sessions') {
      const body = await readBody(req);
      const made = await createSession({ dir: body.dir, name: body.name, cont: !!body.continue });
      return json(res, 201, made);
    }

    const sess = path.match(/^\/api\/sessions\/([^/]+)(\/[a-z]+)?$/);
    if (sess) {
      const name = decodeURIComponent(sess[1]);
      const sub = sess[2] || '';
      if (req.method === 'DELETE' && !sub) { await killSession(name); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && sub === '/keys') {
        await sendKeys(name, await readBody(req));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && sub === '/peek') {
        const n = Math.min(Number(url.searchParams.get('lines') || 40), 200);
        return json(res, 200, await peek(name, n, 300));
      }
    }

    if (req.method === 'POST' && path === '/api/restore') {
      const body = await readBody(req);
      const snap = await loadSnapshot();
      const wanted = snap.sessions.filter(s => body.names?.includes(s.name));
      const made = [];
      for (const s of wanted) made.push(await createSession({ dir: s.cwd, name: s.name, cont: true }));
      return json(res, 200, { restored: made });
    }

    notFound(res);
  } catch (err) {
    json(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`muxboard listening on http://${HOST}:${PORT} (root: ${REPOS_ROOT})`);
});
