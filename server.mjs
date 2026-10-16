#!/usr/bin/env node
// Muxboard — manage Claude Code sessions living in tmux, from a phone.
// Zero runtime dependencies. Serves the PWA and a small JSON API on localhost.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile, rm, open as openFile } from 'node:fs/promises';
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
const STATE_DIR = join(process.env.XDG_STATE_HOME || join(HOME, '.local/state'), 'muxboard');
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

const SCRYPT = { N: 32768, r: 8, p: 1 };

function makeAuthRecord(password) {
  const salt = randomBytes(16);
  return {
    alg: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('hex'),
    hash: scryptSync(password, salt, 32, { ...SCRYPT, maxmem: 128 * 1024 * 1024 }).toString('hex'),
    secret: randomBytes(32).toString('hex'),
    updatedAt: new Date().toISOString(),
  };
}

async function writeAuth(record) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  authCache = { mtimeMs: -1, value: null };
}

// Guessing is throttled process-wide; this is a single-user password.
let loginFailures = 0;
let lockedUntil = 0;

function throttleCheck() {
  const wait = lockedUntil - Date.now();
  if (wait > 0) throw httpError(429, `too many attempts — wait ${Math.ceil(wait / 1000)}s`);
}

function noteFailure() {
  loginFailures++;
  if (loginFailures >= 3) lockedUntil = Date.now() + Math.min(60_000, 250 * 2 ** (loginFailures - 3));
}

// -------------------------------------------------------------- user config
// Everything a person tailors — which folders to offer, which send-key chips
// to show — lives in one small JSON file, editable from the app or by hand.

const DEFAULT_SHORTCUTS = [
  { label: '/clear', send: '/clear' },
  { label: '↵ enter', key: 'enter' },
  { label: 'esc', key: 'escape' },
];

const DEFAULT_ROLLOVER_COMMAND = '/restore';

const DEFAULT_WARM_HANDOFF = { enabled: true, idleMinutes: 50, minTokens: 200000, command: '/handoff' };
// Claude Code's main-session prompt cache lives one hour on a subscription.
// The handoff's first request must land inside it, so the idle threshold is
// capped below the hour and a session idle past HANDOFF_TOO_LATE_MIN is left
// alone — by then the handoff itself would be the cold send it exists to avoid.
const HANDOFF_MAX_IDLE_MIN = 55;
const HANDOFF_TOO_LATE_MIN = 58;

// list, use, dir and add are argv arrays run without a shell; null hides the
// picker. labels maps an account name to a display name.
const DEFAULT_ACCOUNTS = { freshAbove: 100000, list: null, use: null, dir: null, add: null, labels: {} };

const defaultConfig = () => ({
  roots: [shortPath(REPOS_ROOT)],
  shortcuts: DEFAULT_SHORTCUTS.map(s => ({ ...s })),
  rolloverCommand: DEFAULT_ROLLOVER_COMMAND,
  warmHandoff: { ...DEFAULT_WARM_HANDOFF },
  accounts: { ...DEFAULT_ACCOUNTS },
});

// Named keys a chip or the keypad may press, mapped to tmux key names.
const KEYS = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  tab: 'Tab', btab: 'BTab', enter: 'Enter', escape: 'Escape', backspace: 'BSpace',
};

function cleanShortcut(s) {
  if (!s || typeof s !== 'object') return null;
  const label = String(s.label ?? '').trim().slice(0, 24);
  if (!label) return null;
  if (typeof s.key === 'string' && KEYS[s.key]) return { label, key: s.key };
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
  const rolloverCommand = typeof raw?.rolloverCommand === 'string' && raw.rolloverCommand.trim().startsWith('/')
    ? raw.rolloverCommand.trim().replace(/[\r\n]+/g, ' ').slice(0, 60)
    : DEFAULT_ROLLOVER_COMMAND;
  return {
    roots: roots.length ? roots : def.roots, shortcuts, rolloverCommand,
    warmHandoff: cleanWarmHandoff(raw?.warmHandoff),
    accounts: cleanAccounts(raw?.accounts),
  };
}

// idleMinutes stops short of the one-hour cache TTL, so the handoff turn still
// starts while the cache is warm. The command may be a slash command or plain
// text; either way it is one line, typed like a send-sheet message.
function cleanWarmHandoff(raw) {
  const d = DEFAULT_WARM_HANDOFF;
  const int = (v, min, max, def) => Number.isInteger(v) && v >= min && v <= max ? v : def;
  const command = typeof raw?.command === 'string' ? raw.command.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) : '';
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    idleMinutes: int(raw?.idleMinutes, 1, HANDOFF_MAX_IDLE_MIN, d.idleMinutes),
    minTokens: int(raw?.minTokens, 0, 10_000_000, d.minTokens),
    command: command || d.command,
  };
}

// The account commands are argv arrays: no shell ever parses them, and an
// account name only ever replaces "{name}" inside one element. A use, dir or
// add command without "{name}" could not say which account it is about.
function cleanAccounts(raw) {
  const d = DEFAULT_ACCOUNTS;
  const argv = v => Array.isArray(v) && v.length >= 1 && v.length <= 16 &&
    v.every(a => typeof a === 'string' && a.length <= 200) && v[0].trim() ? [...v] : null;
  const named = v => { const a = argv(v); return a && a.some(x => x.includes('{name}')) ? a : null; };
  return {
    freshAbove: Number.isInteger(raw?.freshAbove) && raw.freshAbove >= 0 && raw.freshAbove <= 10_000_000
      ? raw.freshAbove : d.freshAbove,
    list: argv(raw?.list),
    use: named(raw?.use),
    dir: named(raw?.dir),
    add: named(raw?.add),
    labels: cleanLabels(raw?.labels),
  };
}

// Labels are display-only, so the client may set them. An empty one is dropped.
function cleanLabels(raw) {
  const out = Object.create(null); // an account may be called "constructor"
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, v] of Object.entries(raw).slice(0, 64)) {
    if (!ACCOUNT_NAME.test(name) || typeof v !== 'string') continue;
    const label = v.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 32).trim();
    if (label) out[name] = label;
  }
  return out;
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
  // The account commands run programs, so only the file on disk sets them;
  // whatever a client sends for them is ignored. Labels come from the client.
  let stored = null;
  try { stored = JSON.parse(await readFile(CONFIG_FILE, 'utf8')); } catch { /* none yet */ }
  const { list, use, dir, add } = cleanAccounts(stored?.accounts);
  cfg.accounts = { ...cfg.accounts, list, use, dir, add };
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
  // A server holding only login sessions counts as not running, so a login
  // after a reboot can't save an empty snapshot over the restore offer.
  let tmuxRunning = false;
  for (const line of res.out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached, panePid, cwd, cmd] = line.split(SEP);
    if (seen.has(name)) continue; // one entry per session (active pane wins)
    if (isLoginSession(name)) { // runs claude, but only to sign in
      const account = name.slice(LOGIN_PREFIX.length);
      if (!logins.has(account) && !loginBusy.has(account)) tmux('kill-session', '-t', `=${name}`); // orphaned
      continue;
    }
    tmuxRunning = true;
    const claude = findClaudeProcess(Number(panePid));
    if (!claude && cmd !== 'claude') continue;
    seen.add(name);
    const pid = claude ? claude.pid : Number(panePid);
    const configDir = processConfigDir(pid);
    sessions.push({
      name,
      cwd,
      repo: shortPath(cwd),
      createdAt: Number(created) * 1000,
      attached: Number(attached) > 0,
      remoteControl: claude ? claude.remoteControl : false,
      pid,
      version: claudeExeVersion(pid),
      configDir, // server-side only: /api/state sends the account label
      account: accountName(configDir),
    });
  }
  const pids = new Set(sessions.map(s => s.pid));
  for (const pid of configDirCache.keys()) if (!pids.has(pid)) configDirCache.delete(pid);
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  return { tmuxRunning, sessions };
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
    return versionFromPath(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''));
  } catch {
    return null;
  }
}

function versionFromPath(p) {
  const m = p.match(/\/versions\/([^/]+)$/);
  return m ? m[1] : null;
}

// Numeric compare of dotted versions: negative when a is older than b.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ----------------------------------------------------------------- accounts
// Claude Code keeps an account's credentials, session registry and transcripts
// under CLAUDE_CONFIG_DIR, or ~/.claude when it is unset. A process's account
// is fixed at exec, so it is read once per pid from /proc/<pid>/environ.

const DEFAULT_CLAUDE_HOME = join(HOME, '.claude');
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ACTIVE_TTL_MS = 10_000;

// pid → CLAUDE_CONFIG_DIR ('' when unset), or null when /proc can't say.
const configDirCache = new Map();

// Only CLAUDE_CONFIG_DIR is kept; every other variable is discarded on the spot.
function processConfigDir(pid) {
  if (configDirCache.has(pid)) return configDirCache.get(pid);
  let dir = '';
  try {
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      if (entry.startsWith('CLAUDE_CONFIG_DIR=')) { dir = entry.slice('CLAUDE_CONFIG_DIR='.length); break; }
    }
  } catch {
    return null; // not cached: the next poll may be able to read it
  }
  configDirCache.set(pid, dir);
  return dir;
}

const claudeHome = dir => dir ? resolve(dir.replace(/^~(?=\/|$)/, HOME)) : DEFAULT_CLAUDE_HOME;
const sessionHome = s => claudeHome(s.configDir);

// ~/.claude-b → "b"; unset or ~/.claude → "default"; unknown → null.
function accountLabel(dir) {
  if (dir == null) return null;
  const home = claudeHome(dir);
  if (home === DEFAULT_CLAUDE_HOME) return 'default';
  return basename(home).replace(/^\./, '').replace(/^claude-/, '') || basename(home);
}

// A spawned child must not look like it runs inside Claude Code.
function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

// The active account is whatever a new session would get: sessions start
// through a zsh login shell, so ask one. Polls never wait for it: they get the
// cached value (null before the first read) and refresh it in the background
// once it is older than ACTIVE_TTL_MS.
async function readActiveAccount() {
  try {
    const { stdout } = await exec('/bin/zsh', ['-lc', 'print -r -- "${CLAUDE_CONFIG_DIR-}"'],
      { timeout: 5000, env: childEnv() });
    const dir = stdout.replace(/\n$/, '').split('\n').at(-1); // a profile may print first
    return { dir };
  } catch {
    return null;
  }
}

let activeCache = { at: 0, value: null };
let activeRead = null;
function refreshActive() {
  const read = readActiveAccount().then(value => {
    if (activeRead === read) { activeCache = { at: Date.now(), value }; activeRead = null; }
    return value;
  });
  activeRead = read;
  return read;
}

const activeAccountNow = () => refreshActive();

function cachedActiveAccount() {
  if (!activeRead && (!activeCache.at || Date.now() - activeCache.at > ACTIVE_TTL_MS)) refreshActive();
  return activeCache.value;
}

// Badges and the active-account line need either a working account tool or a
// session already running outside the default account; a setup with one
// account never pays for the shell spawn.
const accountsInUse = (sessions, cfg) => accountsAvailable(cfg) ||
  sessions.some(s => s.configDir && claudeHome(s.configDir) !== DEFAULT_CLAUDE_HOME);

const toolError = err => String(err.stderr || err.message || err).replace(/\s+/g, ' ').trim().slice(0, 500);
const toolArgv = (argv, name) => argv.map(a => a.replaceAll('{name}', name));

async function execAccountTool(argv, timeout) {
  const [cmd, ...args] = argv;
  const { stdout } = await exec(cmd.replace(/^~(?=\/)/, HOME), args, { timeout, env: childEnv() });
  return stdout;
}

// The tool's own output stays in the server log; the client gets the exit code.
async function runAccountTool(argv, timeout) {
  try {
    return await execAccountTool(argv, timeout);
  } catch (err) {
    console.error(`account command ${argv[0]} failed: ${toolError(err)}`);
    throw httpError(500, `account command failed (exit ${err.code ?? err.signal ?? '?'})`);
  }
}

// Every account feature needs a list command that runs. Until it has run
// cleanly for the current config, they stay hidden and nothing else
// account-related is spawned. A failure is logged once per config and retried
// every ACCOUNTS_TTL_MS, so installing the tool later is picked up. The same
// run fills the name → config dir map (from the dir command) that names each
// session's account.
const ACCOUNTS_TTL_MS = 5 * 60_000;
// A config dir is one line, absolute or ~/…; empty means the default one.
const ACCOUNT_DIR = /^(?:~\/|\/)[^\x00-\x1f]{0,400}$/;
const accountKey = cfg => JSON.stringify([cfg.accounts.list, cfg.accounts.dir]);
const noAccounts = key => ({ key, at: Date.now(), ok: false, names: [], dirs: new Map(), homes: new Map() });
let dirsCache = { ...noAccounts(null), at: 0 };
let dirsRead = null, loggedFailure = null;

async function readAccountDirs(cfg) {
  const key = accountKey(cfg);
  let names;
  try {
    const out = await execAccountTool(cfg.accounts.list, 10_000);
    names = [...new Set(out.split('\n').map(l => l.trim()).filter(n => ACCOUNT_NAME.test(n)))].slice(0, 32);
  } catch (err) {
    if (loggedFailure !== key) console.error(`accounts unavailable: ${cfg.accounts.list[0]}: ${toolError(err)}`);
    loggedFailure = key;
    return noAccounts(key);
  }
  loggedFailure = null;
  const dirs = new Map();
  if (cfg.accounts.dir) {
    await Promise.all(names.map(async n => {
      try {
        const dir = (await execAccountTool(toolArgv(cfg.accounts.dir, n), 10_000)).trim();
        if (dir === '' || ACCOUNT_DIR.test(dir)) dirs.set(n, dir);
      } catch { /* this account gets no status and no login */ }
    }));
  }
  const homes = new Map();
  for (const [n, d] of dirs) if (!homes.has(claudeHome(d))) homes.set(claudeHome(d), n);
  return { key, at: Date.now(), ok: true, names, dirs, homes };
}

// fresh skips a read already in flight, for after the tool changed something.
function refreshAccountDirs(cfg, fresh = false) {
  const key = accountKey(cfg);
  if (!fresh && dirsRead?.key === key) return dirsRead.promise;
  const promise = readAccountDirs(cfg).then(v => {
    if (dirsRead?.promise === promise) { dirsCache = v; dirsRead = null; }
    return v;
  });
  dirsRead = { key, promise };
  return promise;
}

// Polls never wait: they see the last result and start a check when the
// config changed or the result is old.
function accountsAvailable(cfg) {
  if (!cfg.accounts.list) return false;
  const key = accountKey(cfg);
  if (!dirsRead && (dirsCache.key !== key || Date.now() - dirsCache.at > ACCOUNTS_TTL_MS)) refreshAccountDirs(cfg);
  return dirsCache.key === key && dirsCache.ok;
}

async function accountDirs(cfg, fresh = false) {
  if (!cfg.accounts.list) throw httpError(404, 'no account list command configured');
  const cached = dirsCache.key === accountKey(cfg) && Date.now() - dirsCache.at <= ACCOUNTS_TTL_MS;
  const v = cached && !fresh ? dirsCache : await refreshAccountDirs(cfg, fresh);
  if (!v.ok) throw httpError(503, 'accounts are unavailable');
  return v;
}

// The tool's name for a config dir, else the derived label.
function accountName(dir) {
  if (dir == null) return null;
  return dirsCache.homes.get(claudeHome(dir)) ?? accountLabel(dir);
}

async function useAccount(cfg, name) {
  if (!cfg.accounts.use) throw httpError(400, 'no account switch command configured');
  if (!ACCOUNT_NAME.test(name)) throw httpError(400, 'invalid account name');
  await runAccountTool(toolArgv(cfg.accounts.use, name), 15_000);
  const [, active] = await Promise.all([refreshAccountDirs(cfg, true), activeAccountNow()]);
  return { active: active ? accountName(active.dir) : null };
}

async function addAccount(cfg, name) {
  if (!cfg.accounts.add) throw httpError(400, 'no account add command configured');
  if (!ACCOUNT_NAME.test(name)) throw httpError(400, 'invalid account name');
  await accountDirs(cfg);
  await runAccountTool(toolArgv(cfg.accounts.add, name), 30_000);
  await refreshAccountDirs(cfg, true);
  return { ok: true };
}

// `claude auth status` prints JSON; only three of its fields leave the server.
const STATUS_TTL_MS = 60_000;
const statusCache = new Map(); // config home → { at, promise }

function authStatus(dir, fresh = false) {
  const home = claudeHome(dir);
  const hit = statusCache.get(home);
  if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.promise;
  const env = childEnv();
  if (dir) env.CLAUDE_CONFIG_DIR = home; else delete env.CLAUDE_CONFIG_DIR;
  const promise = exec(CLAUDE_BIN, ['auth', 'status'], { timeout: 15_000, env })
    // Logged out may exit non-zero and still print the JSON.
    .then(r => r.stdout, err => String(err.stdout || ''))
    .then(out => {
      try {
        const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
        const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : null;
        return { loggedIn: j.loggedIn === true, email: str(j.email, 200), plan: str(j.subscriptionType, 40) };
      } catch {
        return null;
      }
    });
  statusCache.set(home, { at: Date.now(), promise });
  return promise;
}

async function accountsView(cfg) {
  const [{ names, dirs }, active] = await Promise.all([accountDirs(cfg, true), activeAccountNow()]);
  const activeName = active ? accountName(active.dir) : null;
  const accounts = await Promise.all(names.map(async name => {
    const st = dirs.has(name) ? await authStatus(dirs.get(name)) : null;
    return {
      name, label: Object.hasOwn(cfg.accounts.labels, name) ? cfg.accounts.labels[name] : null, active: name === activeName,
      loggedIn: st?.loggedIn ?? null, email: st?.email ?? null, plan: st?.plan ?? null,
      canLogin: dirs.has(name),
    };
  }));
  return { active: activeName, accounts, canUse: !!cfg.accounts.use, canAdd: !!cfg.accounts.add };
}

// ------------------------------------------------------------- account login
// `claude auth login --claudeai` runs in a hidden tmux session: it prints a
// sign-in URL, the user signs in on their phone, and the code they get back is
// typed into the pane. The code is a secret: it is never logged, stored,
// echoed or put in an error message.

const LOGIN_PREFIX = 'muxboard-login-';
const LOGIN_URL_MS = 30_000;
const LOGIN_CODE_MS = 30_000;
const LOGIN_MAX_MS = 10 * 60_000;
const LOGIN_CODE = /^[A-Za-z0-9#_.~+\/=-]{1,512}$/;
const LOGIN_URL = /https:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&()*+,;=%]+/;
const LOGIN_OK = /login successful|successfully logged in|logged in as/i;
const LOGIN_FAILED = /error|failed|invalid|expired|denied/i;
const isLoginSession = name => name.startsWith(LOGIN_PREFIX);

const logins = new Map(); // account name → { session, dir, url, timer }
const loginBusy = new Set();

function endLogin(name) {
  const l = logins.get(name);
  if (l) clearTimeout(l.timer);
  logins.delete(name);
  return tmux('kill-session', '-t', `=${LOGIN_PREFIX}${name}`);
}

// Logins left by an earlier run of the server can't be finished: their state is gone.
async function killLoginSessions() {
  const res = await tmux('list-sessions', '-F', '#{session_name}');
  if (!res.ok) return;
  for (const name of res.out.split('\n')) if (isLoginSession(name)) await tmux('kill-session', '-t', `=${name}`);
}

async function loginPane(session) {
  const target = `=${session}:`;
  const [dead, pane] = await Promise.all([
    tmux('display-message', '-p', '-t', target, '#{pane_dead}'),
    tmux('capture-pane', '-p', '-J', '-t', target),
  ]);
  return { gone: !pane.ok, dead: !dead.ok || dead.out.trim() === '1', out: pane.out };
}

async function withLogin(name, run) {
  if (!ACCOUNT_NAME.test(name)) throw httpError(400, 'invalid account name');
  if (loginBusy.has(name)) throw httpError(409, 'a login step for this account is already running');
  loginBusy.add(name);
  try { return await run(); } finally { loginBusy.delete(name); }
}

// One login per account: asking again while one runs returns its URL.
function startLogin(cfg, name) {
  return withLogin(name, async () => {
    const live = logins.get(name);
    if (live?.url && !(await loginPane(live.session)).dead) return { url: live.url };
    if (!cfg.accounts.dir) throw httpError(400, 'no account dir command configured');
    const { dirs } = await accountDirs(cfg);
    if (!dirs.has(name)) throw httpError(404, 'no config dir known for this account');
    const dir = dirs.get(name);
    await endLogin(name); // a leftover from an earlier run of the server
    const session = LOGIN_PREFIX + name;
    const account = dir ? `export CLAUDE_CONFIG_DIR=${shq(claudeHome(dir))}; ` : 'unset CLAUDE_CONFIG_DIR; ';
    // BROWSER=true: the CLI must not open a browser on this machine.
    const cmd = `unset CLAUDECODE; export BROWSER=true; ${account}exec ${shq(CLAUDE_BIN)} auth login --claudeai`;
    // Registered first, so listSessions() never takes it for an orphan.
    const entry = { session, dir, url: null, timer: setTimeout(() => endLogin(name), LOGIN_MAX_MS) };
    entry.timer.unref();
    logins.set(name, entry);
    // Wide enough that the URL is never wrapped by the TUI; -J rejoins tmux's own wraps.
    const res = await tmux('new-session', '-d', '-s', session, '-x', '1000', '-y', '50', '-c', HOME,
      '/bin/zsh', '-lc', cmd);
    if (!res.ok) { await endLogin(name); throw httpError(500, res.err); }
    // Keep the pane after exit, so the final message can still be read.
    await tmux('set-option', '-w', '-t', `=${session}:`, 'remain-on-exit', 'on');
    const until = Date.now() + LOGIN_URL_MS;
    while (Date.now() < until) {
      await sleep(500);
      const pane = await loginPane(session);
      const m = pane.out.match(LOGIN_URL);
      if (m) {
        entry.url = m[0].replace(/[.,;:!?)\]]+$/, '');
        return { url: entry.url };
      }
      if (pane.gone || pane.dead) break;
    }
    await endLogin(name);
    throw httpError(502, 'the login command printed no sign-in URL');
  });
}

// load-buffer reads the text from stdin into a one-off buffer; paste-buffer -d
// types it into the pane and deletes the buffer.
async function pasteSecret(target, text) {
  const buffer = `muxboard-${randomBytes(8).toString('hex')}`;
  try {
    const load = exec('tmux', ['load-buffer', '-b', buffer, '-'], { timeout: 5000 });
    load.child.stdin.end(text);
    await load;
  } catch {
    return false;
  }
  if ((await tmux('paste-buffer', '-d', '-b', buffer, '-t', target)).ok) return true;
  await tmux('delete-buffer', '-b', buffer);
  return false;
}

function submitLoginCode(name, raw) {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!LOGIN_CODE.test(code)) throw httpError(400, 'that does not look like a sign-in code');
  return withLogin(name, async () => {
    const l = logins.get(name);
    if (!l) throw httpError(404, 'no login is running for this account — start again');
    const target = `=${l.session}:`;
    const before = await loginPane(l.session);
    if (before.gone || before.dead) { await endLogin(name); throw httpError(410, 'the login ended — start again'); }
    const seen = new Set(before.out.split('\n').map(r => r.trim()));
    // A line holding any part of the code is never reported back.
    const leaks = r => r.includes(code) || (code.length >= 12 && (r.includes(code.slice(0, 12)) || r.includes(code.slice(-12))));
    try {
      // The code reaches tmux on stdin, never in an argv, and failures get fixed messages.
      if (!await pasteSecret(target, code)) throw httpError(500, 'could not type the code');
      await sleep(150);
      await tmux('send-keys', '-t', target, 'Enter');
      let done = false, errorLine = null;
      const until = Date.now() + LOGIN_CODE_MS;
      while (!done && Date.now() < until) {
        await sleep(500);
        const pane = await loginPane(l.session);
        const fresh = pane.out.split('\n').map(r => r.trim()).filter(r => r && !seen.has(r) && !leaks(r));
        const bad = fresh.findLast(r => LOGIN_FAILED.test(r));
        if (bad) errorLine = bad.slice(0, 200);
        done = pane.gone || pane.dead || !!bad || fresh.some(r => LOGIN_OK.test(r));
      }
      const st = await authStatus(l.dir, true);
      const out = { loggedIn: !!st?.loggedIn, email: st?.email ?? null };
      if (!out.loggedIn) out.error = errorLine || (done ? 'sign-in failed' : 'the login did not finish in time');
      return out;
    } finally {
      await endLogin(name);
    }
  });
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
  // A turn can end while background shells or subagents keep running. The
  // footer then counts the shells ("· 2 shells ·") and the agent panel under
  // it lists "● main" and one row per running agent. Killing the session now
  // would kill that work.
  else if (/·\s*\d+\s+(?:shells?|agents?)\s*·|^\s*●\s+main\s*$/m.test(vis.out)) status = 'background';
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

// configDir pins the account (CLAUDE_CONFIG_DIR, '' for the default one);
// left undefined, the session gets whatever the login shell sets.
async function createSession({ dir, name, cont, resume, configDir }) {
  const target = expandDir(dir);
  const base = sanitizeName(name) || sanitizeName(basename(target)) || 'session';
  if (base.startsWith('muxboard-login')) throw httpError(400, 'that session name is reserved');
  const finalName = await uniqueName(base);
  if (isLoginSession(finalName)) throw httpError(400, 'that session name is reserved');
  const rcName = `${HOSTNAME}:${finalName}`;
  const account = configDir === undefined ? ''
    : configDir ? `export CLAUDE_CONFIG_DIR=${shq(configDir)}; ` : 'unset CLAUDE_CONFIG_DIR; ';
  const resumeFlag = resume ? `--resume ${shq(resume)} ` : cont ? '--continue ' : '';
  const cmd = `${account}exec ${shq(CLAUDE_BIN)} ${resumeFlag}--remote-control --name ${shq(rcName)}`;
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

async function sendKeys(name, { kind, key, text }) {
  const target = `=${name}:`;
  // { kind: 'key', key: 'up' }; the older { kind: 'enter' | 'escape' } still works.
  const named = KEYS[kind === 'key' ? key : kind];
  if (kind === 'key' && !named) throw httpError(400, `unknown key: ${key}`);
  if (named) {
    const res = await tmux('send-keys', '-t', target, named);
    if (!res.ok) throw httpError(404, res.err);
    return;
  }
  const body = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!body) throw httpError(400, 'empty text');
  const res = await tmux('send-keys', '-t', target, '-l', '--', body);
  if (!res.ok) throw httpError(404, res.err);
  // Slash commands pop the TUI autocomplete; give it a beat before Enter.
  await sleep(body.startsWith('/') ? 450 : 120);
  await tmux('send-keys', '-t', target, 'Enter');
}

// --------------------------------------------------------------- rollover

// Claude Code maintains ~/.claude/sessions/<pid>.json for each running
// process; it names the transcript UUID exactly, where mtime heuristics on
// the projects folder would guess. The format is internal to Claude Code
// (like the TUI layout peek() reads), so validate before believing it: the
// process start time proves the file describes this incarnation of the pid,
// and the cwd must match the pane's.
function sessionUuid(pid, cwd, home = DEFAULT_CLAUDE_HOME) {
  let reg;
  try { reg = JSON.parse(readFileSync(join(home, 'sessions', `${pid}.json`), 'utf8')); }
  catch { return null; }
  if (!/^[0-9a-f][0-9a-f-]{34}[0-9a-f]$/.test(reg?.sessionId || '')) return null;
  if (reg.cwd && cwd && reg.cwd !== cwd) return null;
  if (reg.procStart) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (String(starttime) !== String(reg.procStart)) return null;
    } catch {
      return null;
    }
  }
  return reg.sessionId;
}

// Roll a session over to a fresh context instead of paying to revive the old
// one: once the prompt cache has lapsed, ANY model turn in the old session —
// /compact included — re-ingests the whole context at full input cost. So the
// old session gets no turn at all: capture its transcript UUID, /clear (a
// local TUI command, no model call), and hand the UUID to the fresh context,
// whose restore skill mines the transcript selectively.
async function rollover(name) {
  const { sessions } = await listSessions();
  const s = sessions.find(x => x.name === name);
  if (!s) throw httpError(404, 'no such session');
  const { status } = await peek(name);
  if (status !== 'idle') throw httpError(409, `session is ${status} — roll over when it is idle`);
  const uuid = sessionUuid(s.pid, s.cwd, sessionHome(s));
  if (!uuid) throw httpError(500, 'could not identify the session transcript');
  const cfg = await loadConfig();
  await sendKeys(name, { kind: 'command', text: '/clear' });
  await sleep(1500); // let the TUI settle on the fresh prompt
  await sendKeys(name, { kind: 'command', text: `${cfg.rolloverCommand} ${uuid}` });
  return { uuid };
}

// --------------------------------------------------------- account reopen

// The prompt cache is per account, so a session reopened in another account
// starts cold either way. A small context is cheap to re-read and resumes as
// is; a big one starts fresh and restores from the transcript, as rollover
// does. Waiting on the restore send keeps the request open for up to
// REOPEN_READY_MS.
const REOPEN_READY_MS = 30_000;
const reopening = new Set();

// The TUI is ready for input once its input box renders empty on an idle
// screen. Gives up when the session dies (e.g. a resume that found nothing).
async function waitForPrompt(name, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(500);
    const { status } = await peek(name);
    if (status === 'gone') return false;
    if (status === 'idle' && await promptDraft(name) === '') return true;
  }
  return false;
}

// expect is the active account the client showed when the button was armed;
// a switch since then means the user agreed to a different target.
async function reopen(name, expect) {
  if (reopening.has(name)) throw httpError(409, 'already reopening');
  reopening.add(name);
  try {
    if (restarting.has(name) || pendingRestart.has(name)) throw httpError(409, 'a restart is queued for this session');
    const { sessions } = await listSessions();
    const s = sessions.find(x => x.name === name);
    if (!s) throw httpError(404, 'no such session');
    const { status } = await peek(name);
    if (status !== 'idle') throw httpError(409, `session is ${status} — reopen it when it is idle`);
    if (await promptDraft(name) !== '') throw httpError(409, 'input box not empty');
    const active = await activeAccountNow();
    if (!active) throw httpError(500, 'could not determine the active account');
    const activeName = accountName(active.dir);
    if (activeName !== expect) throw httpError(409, `new sessions now start in ${activeName} — check and try again`);
    const cfg = await loadConfig();

    // Everything that can fail is checked before the old session dies.
    const target = expandDir(s.cwd);
    const oldHome = sessionHome(s), newHome = claudeHome(active.dir);
    const uuid = sessionUuid(s.pid, s.cwd, oldHome);
    if (!uuid) throw httpError(409, "could not identify the session's conversation");
    const info = await transcriptTail(join(projectDir(s.cwd, oldHome), `${uuid}.jsonl`));
    const tokens = info?.lastAssistant?.tokens ?? 0;
    // --resume only finds transcripts under the new account's own projects
    // folder, so it is used only when that account can see this one.
    const visible = existsSync(join(projectDir(s.cwd, newHome), `${uuid}.jsonl`));
    const path = !info ? 'new' // registered, but no turn was ever recorded
      : tokens <= cfg.accounts.freshAbove && visible ? 'continue' : 'transcript';

    await killSession(name);
    let made;
    try {
      made = await createSession({
        dir: target, name, configDir: active.dir, resume: path === 'continue' ? uuid : undefined,
      });
    } catch (err) {
      // Put the conversation back where it was rather than leave nothing running.
      try {
        await createSession({ dir: target, name, configDir: s.configDir ?? undefined, resume: info ? uuid : undefined });
      } catch { /* report the original failure */ }
      throw err;
    }
    const out = { name: made.name, account: activeName, path, tokens, sent: false };
    if (path === 'transcript') {
      if (!await waitForPrompt(made.name, REOPEN_READY_MS)) return out;
      await sleep(1000); // let commands and skills finish loading
      await sendKeys(made.name, { kind: 'command', text: `${cfg.rolloverCommand} ${uuid}` });
      out.sent = true;
    }
    return out;
  } finally {
    reopening.delete(name);
  }
}

// ------------------------------------------------------------ warm handoff

// The other side of rollover: while a big idle session's cache is still warm,
// type the handoff command into it once, so a handoff exists before the cache
// lapses. Nothing is cleared; the session just sits idle with a handoff
// written. Idle time and context size come from the session's transcript —
// another Claude Code internal format, read defensively: only the file's tail,
// and anything unparseable or unexpected means "don't send".

const HANDOFF_FILE = join(STATE_DIR, 'handoff.json');
const HANDOFF_TICK_MS = 60_000;
const TAIL_BYTES = 256 * 1024;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Claude Code names a project's transcript folder after its cwd, with every
// character other than a letter or digit turned into "-".
const projectDir = (cwd, home = DEFAULT_CLAUDE_HOME) => join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

// Persisted so a restart neither forgets a toggle nor re-sends a handoff:
// toggles are per tmux session name (overrides of warmHandoff.enabled), sent
// handoffs per transcript UUID.
let handoffState = null;
async function loadHandoffState() {
  if (handoffState) return handoffState;
  let raw = null;
  try { raw = JSON.parse(await readFile(HANDOFF_FILE, 'utf8')); } catch { /* first run */ }
  handoffState = {
    toggles: raw?.toggles && typeof raw.toggles === 'object' ? raw.toggles : {},
    sent: raw?.sent && typeof raw.sent === 'object' ? raw.sent : {},
  };
  return handoffState;
}

async function saveHandoffState() {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(HANDOFF_FILE, JSON.stringify(handoffState, null, 2) + '\n');
}

// Session name → when the handoff for its current idle period went out.
// Rebuilt by every tick; the client shows it as "handoff sent hh:mm".
const handoffSentAt = new Map();

function handoffView(name, cfg, st) {
  const enabled = typeof st.toggles[name] === 'boolean' ? st.toggles[name] : cfg.warmHandoff.enabled;
  return { enabled, sentAt: handoffSentAt.get(name) || null };
}

async function setHandoffToggle(name, enabled) {
  const { sessions } = await listSessions();
  if (!sessions.some(s => s.name === name)) throw httpError(404, 'no such session');
  const st = await loadHandoffState();
  st.toggles[name] = !!enabled;
  await saveHandoffState();
  return handoffView(name, await loadConfig(), st);
}

// Re-read only when the file changed; most ticks cost one stat per session.
const tailCache = new Map();
async function transcriptTail(path) {
  let st;
  try { st = await stat(path); } catch { return null; }
  const hit = tailCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.info;
  let info = await readTail(path, st.size, TAIL_BYTES);
  // One assistant record can outgrow the window (a long answer, a big edit).
  if (!info.lastAssistant && st.size > TAIL_BYTES) info = await readTail(path, st.size, TAIL_BYTES * 8);
  tailCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, info });
  return info;
}

async function readTail(path, size, bytes) {
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fh = await openFile(path, 'r');
  try { await fh.read(buf, 0, buf.length, start); } finally { await fh.close(); }
  const lines = buf.toString('utf8').split('\n');
  if (start > 0) lines.shift(); // partial first line

  let lastAssistant = null;
  const prompts = []; // real user prompts, oldest first
  for (const line of lines) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const at = Date.parse(r?.timestamp);
    if (!Number.isFinite(at) || r.isSidechain) continue;
    const msg = r.message;
    if (r.type === 'assistant' && msg?.usage && msg.model !== '<synthetic>') {
      const u = msg.usage;
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      lastAssistant = { at, tokens };
    } else if (r.type === 'user' && !r.isMeta && r.promptId && (!r.origin || r.origin.kind === 'human')) {
      // Typed by a person (terminal or app) — not a tool result, task
      // notification, or the text a skill injects.
      const c = msg?.content;
      if (Array.isArray(c) && c.some(p => p?.type === 'tool_result')) continue;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text).join(' ') : '';
      prompts.push({ at, text });
    }
  }
  return { lastAssistant, prompts };
}

// A slash command is recorded as <command-name>/x</command-name> plus
// <command-args>; plain text as itself.
function isHandoffPrompt(text, command) {
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
  const typed = name ? `${name[1]} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] || ''}` : text;
  return norm(typed) === norm(command);
}

// What sits in the TUI's input box: '' when empty, null when the box can't be
// found. Dim text there is a suggestion Claude Code offers, not a draft.
async function promptDraft(name) {
  const res = await tmux('capture-pane', '-p', '-e', '-t', `=${name}:`);
  if (!res.ok) return null;
  const rows = res.out.split('\n');
  const plain = rows.map(r => r.replace(ANSI, ''));
  const isRule = r => /^\s*─{8,}/.test(r);
  let close = plain.length - 1;
  while (close >= 0 && !isRule(plain[close])) close--;
  let open = close - 1;
  while (open >= 0 && !isRule(plain[open])) open--;
  if (open < 0 || close - open > 12 || !/^\s*❯/.test(plain[open + 1] || '')) return null;
  return rows.slice(open + 1, close)
    .map(r => r.replace(/\x1b\[2m[\s\S]*?(?=\x1b\[(?:0|22)?m|$)/g, '').replace(ANSI, ''))
    .join(' ').replace(/^\s*❯/, '').trim();
}

let handoffBusy = false;
async function handoffTick() {
  if (handoffBusy) return;
  handoffBusy = true;
  try {
    const cfg = await loadConfig();
    const st = await loadHandoffState();
    const { tmuxRunning, sessions } = await listSessions();
    if (!tmuxRunning) return;
    let dirty = false;
    for (const s of sessions) {
      try {
        if (await considerHandoff(s, cfg, st)) dirty = true;
      } catch (err) {
        console.error(`warm handoff: ${s.name}: ${err.message}`);
      }
    }
    const live = new Set(sessions.map(s => s.name));
    for (const name of handoffSentAt.keys()) if (!live.has(name)) handoffSentAt.delete(name);
    for (const [uuid, rec] of Object.entries(st.sent)) {
      if (Date.now() - rec.at > 7 * 24 * 3600_000) { delete st.sent[uuid]; dirty = true; }
    }
    if (dirty) await saveHandoffState();
  } finally {
    handoffBusy = false;
  }
}

// Returns true when it changed the persisted state.
async function considerHandoff(s, cfg, st) {
  const wh = cfg.warmHandoff;
  const uuid = sessionUuid(s.pid, s.cwd, sessionHome(s));
  const info = uuid && await transcriptTail(join(projectDir(s.cwd, sessionHome(s)), `${uuid}.jsonl`));
  if (!info) { handoffSentAt.delete(s.name); return false; }

  // Once per idle period. The handoff turn writes assistant records of its
  // own, which restart the idle clock; only a person's next prompt re-arms.
  let changed = false;
  const sent = st.sent[uuid];
  if (sent) {
    if (!info.prompts.some(p => p.at > sent.at && !isHandoffPrompt(p.text, sent.command))) {
      handoffSentAt.set(s.name, sent.at);
      return false;
    }
    delete st.sent[uuid];
    changed = true;
  }
  handoffSentAt.delete(s.name);

  if (!handoffView(s.name, cfg, st).enabled) return changed;
  const last = info.lastAssistant;
  if (!last || last.tokens < wh.minTokens) return changed;
  // A prompt newer than the last answer means a turn in flight or cut short.
  if (info.prompts.length && info.prompts.at(-1).at > last.at) return changed;
  const idleMin = (Date.now() - last.at) / 60_000;
  if (idleMin < wh.idleMinutes || idleMin >= HANDOFF_TOO_LATE_MIN) return changed;

  // Never type into a session that is busy, asking something, or holding a
  // half-written message.
  if ((await peek(s.name)).status !== 'idle') return changed;
  if (await promptDraft(s.name) !== '') return changed;

  // Recorded before sending, so a failure mid-send can't cause a second one.
  const rec = { at: Date.now(), command: wh.command, name: s.name };
  st.sent[uuid] = rec;
  await saveHandoffState();
  await sendKeys(s.name, { kind: 'command', text: wh.command });
  handoffSentAt.set(s.name, rec.at);
  console.log(`warm handoff: sent ${wh.command} to ${s.name} (idle ${Math.floor(idleMin)}m, ${last.tokens} tokens)`);
  return changed;
}

// ------------------------------------------------ claude update & recycling

let versionCache = { value: null, at: 0 };
async function claudeVersion(force = false) {
  // The native install is a symlink to versions/<v>. Reading it is instant
  // and always current — Claude Code updates itself in the background, and
  // a cached `--version` would lag that by up to an hour, flagging sessions
  // on the new binary as "older" than the install.
  try {
    const v = versionFromPath(realpathSync(CLAUDE_BIN));
    if (v) return v;
  } catch { /* not the native layout; ask the binary */ }
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
// --continue in the same account, resuming the same conversation on the new
// binary — one sweep at a time, each as soon as it is seen idle. Busy or
// attention sessions wait.
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
function hasConversation(cwd, home = DEFAULT_CLAUDE_HOME) {
  try {
    return readdirSync(projectDir(cwd, home)).some(f => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

function processRestarts(peeked) {
  const live = new Map(peeked.map(s => [s.name, s]));
  for (const name of pendingRestart) {
    const s = live.get(name);
    if (!s) { pendingRestart.delete(name); continue; }
    if (!hasConversation(s.cwd, sessionHome(s))) { pendingRestart.delete(name); continue; }
    if (restarting.has(name) || reopening.has(name) || s.peek.status !== 'idle') continue;
    restarting.add(name);
    (async () => {
      try {
        await killSession(name);
        // Same account as before: --continue elsewhere would find another
        // account's conversations, or none.
        await createSession({ dir: s.cwd, name, cont: true, configDir: s.configDir ?? undefined });
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
    sessions: sessions.map(s => ({ name: s.name, cwd: s.cwd, configDir: s.configDir })),
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
  return { savedAt: snap.updatedAt, sessions: missing.map(s => ({ name: s.name, cwd: s.cwd, repo: shortPath(s.cwd) })) };
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
      throttleCheck();
      const body = await readBody(req);
      if (!checkPassword(body.password ?? '', auth)) {
        noteFailure();
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

    // Set, change, or clear the password from the app. Claiming an unprotected
    // Muxboard needs nothing extra — whoever can reach it can already drive it
    // — but touching an existing password always requires that password, so a
    // borrowed session alone can't lock the owner out.
    if (req.method === 'POST' && path === '/api/password') {
      const body = await readBody(req);
      if (auth) {
        throttleCheck();
        if (!checkPassword(body.current ?? '', auth)) {
          noteFailure();
          return json(res, 401, { error: 'wrong current password' });
        }
        loginFailures = 0;
        lockedUntil = 0;
      }
      if (body.remove) {
        if (!auth) return json(res, 400, { error: 'no password is set' });
        await rm(AUTH_FILE, { force: true });
        authCache = { mtimeMs: -1, value: null };
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
        return json(res, 200, { enabled: false });
      }
      const next = String(body.password ?? '');
      if (next.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
      const record = makeAuthRecord(next);
      await writeAuth(record);
      // Keep the device that just set it signed in; every other one is out.
      res.setHeader('Set-Cookie', sessionCookie(req, issueSession(record)));
      return json(res, 200, { enabled: true });
    }

    if (req.method === 'GET' && path === '/api/state') {
      const { tmuxRunning, sessions } = await listSessions();
      const cfg = await loadConfig();
      const current = await claudeVersion();
      const peeked = await Promise.all(sessions.map(async s => ({ ...s, peek: await peek(s.name, 0, 300) })));
      if (tmuxRunning) await saveSnapshot(sessions);
      const handoff = await loadHandoffState();
      const active = accountsInUse(sessions, cfg) ? cachedActiveAccount() : null;
      return json(res, 200, {
        host: HOSTNAME,
        now: Date.now(),
        tmuxRunning,
        sessions: peeked.map(({ configDir, ...s }) => ({
          ...s,
          status: s.peek.status,
          peek: s.peek.lines,
          stale: !!(s.version && current && compareVersions(s.version, current) < 0),
          handoff: handoffView(s.name, cfg, handoff),
        })),
        folders: await listFolders(sessions, cfg),
        restore: await restoreOffer(tmuxRunning, sessions),
        config: cfg,
        auth: { enabled: !!auth },
        // available: the account tool works, so the accounts tab is shown.
        accounts: {
          active: active ? accountName(active.dir) : null,
          available: accountsAvailable(cfg),
          switchable: accountsAvailable(cfg) && !!cfg.accounts.use,
        },
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

    if (req.method === 'GET' && path === '/api/accounts') {
      return json(res, 200, await accountsView(await loadConfig()));
    }

    if (req.method === 'POST' && path === '/api/accounts') {
      const body = await readBody(req);
      return json(res, 200, await addAccount(await loadConfig(), String(body.name ?? '')));
    }

    if (req.method === 'POST' && path === '/api/accounts/active') {
      const body = await readBody(req);
      return json(res, 200, await useAccount(await loadConfig(), String(body.name ?? '')));
    }

    const login = path.match(/^\/api\/accounts\/([^/]+)\/login(\/code)?$/);
    if (login) {
      const name = decodeURIComponent(login[1]);
      if (req.method === 'POST' && !login[2]) return json(res, 200, await startLogin(await loadConfig(), name));
      if (req.method === 'DELETE' && !login[2]) {
        if (!ACCOUNT_NAME.test(name)) throw httpError(400, 'invalid account name');
        await endLogin(name);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && login[2]) {
        // A parse error can quote the body, and the body holds the code.
        let body;
        try { body = await readBody(req); } catch { throw httpError(400, 'bad request'); }
        return json(res, 200, await submitLoginCode(name, body.code));
      }
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
      if (isLoginSession(name)) return notFound(res);
      if (req.method === 'DELETE' && !sub) { await killSession(name); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && sub === '/keys') {
        await sendKeys(name, await readBody(req));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && sub === '/rollover') {
        return json(res, 200, await rollover(name));
      }
      if (req.method === 'POST' && sub === '/reopen') {
        const body = await readBody(req);
        return json(res, 200, await reopen(name, String(body.account ?? '')));
      }
      if (req.method === 'POST' && sub === '/handoff') {
        const body = await readBody(req);
        return json(res, 200, await setHandoffToggle(name, body.enabled));
      }
      if (req.method === 'GET' && sub === '/peek') {
        const n = Math.min(Number(url.searchParams.get('lines') || 40), 200);
        return json(res, 200, await peek(name, n, 300));
      }
    }

    if (req.method === 'POST' && path === '/api/restore') {
      const body = await readBody(req);
      const snap = await loadSnapshot();
      const wanted = snap.sessions.filter(s => body.names?.includes(s.name) && !isLoginSession(s.name));
      const made = [];
      for (const s of wanted) {
        made.push(await createSession({ dir: s.cwd, name: s.name, cont: true, configDir: s.configDir ?? undefined }));
      }
      return json(res, 200, { restored: made });
    }

    notFound(res);
  } catch (err) {
    json(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`muxboard listening on http://${HOST}:${PORT} (root: ${REPOS_ROOT})`);
  killLoginSessions();
  setTimeout(handoffTick, 5000);
  setInterval(handoffTick, HANDOFF_TICK_MS);
});
