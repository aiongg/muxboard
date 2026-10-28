#!/usr/bin/env node
// Command-line control of a running Muxboard over its Unix socket.
//   muxboard ls [--json]
//   muxboard new [--account NAME] [--name NAME] [--effort LEVEL] [--trust] DIR
//   muxboard restart [--account NAME] [--effort LEVEL] [--kill-jobs] [--trust] SESSION...
//   muxboard watch [--once] [--json] [--interval SECONDS] [SESSION...]
// new and restart work only from a session whose "may manage sessions" switch
// is on.

import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SOCKET = join(process.env.XDG_RUNTIME_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'muxboard'), 'muxboard.sock');

const USAGE = `usage:
  muxboard ls [--json]
  muxboard new [--account NAME] [--name NAME] [--effort LEVEL] [--trust] DIR
  muxboard restart [--account NAME] [--effort LEVEL] [--kill-jobs] [--trust] SESSION...
  muxboard watch [--once] [--json] [--interval SECONDS] [SESSION...]

new starts a Claude Code session in DIR (under ~), named after the folder
unless --name is given, in the active account unless --account is given.

restart relaunches each idle session under its name. In its own account it
resumes the conversation; with --account set to another account it starts a
new conversation and sends nothing. --kill-jobs also restarts sessions that
only run background shells or agents, killing those jobs.

--effort starts the session with that effort level (low, medium, high, xhigh or
max). Without it, Claude Code uses its own default.

--trust answers yes when the new process asks whether to trust the folder.

watch reports when the named sessions (default: every session but your own)
start waiting for input: a permission prompt, a question, a plan approval or
the folder trust dialog. It prints the waiting question, then a line when the
session moves on. Sessions already waiting are reported at the start. It runs
until stopped; --once exits after the first report. --json prints one JSON
object per event. --interval sets the polling period (default 3 seconds).`;

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = request({
      socketPath: SOCKET, method, path,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let out;
        try { out = JSON.parse(text); } catch { out = { error: text || `HTTP ${res.statusCode}` }; }
        if (res.statusCode >= 400) reject(new Error(out.error || `HTTP ${res.statusCode}`));
        else resolve(out);
      });
    });
    req.on('error', err => reject(err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
      ? new Error(`muxboard is not running (no socket at ${SOCKET})`) : err));
    req.end(data);
  });
}

async function ls(args) {
  const st = await call('GET', '/sessions');
  if (args.includes('--json')) return console.log(JSON.stringify(st, null, 2));
  if (st.active) console.log(`new sessions start in: ${st.active}`);
  const rows = st.sessions.map(s => [s.name, s.account ?? '-', s.status, s.control ? 'may manage sessions' : '']);
  const w = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), 4));
  for (const r of rows) console.log(r.map((c, i) => i < 3 ? c.padEnd(w[i]) : c).join('  ').trimEnd());
}

const trustNote = t => t === 'accepted' ? ', folder trusted'
  : t === 'unanswered' ? ', trust prompt not answered — check the session' : '';

async function create(args) {
  let account = null, name = null, effort = null, trust = false, dir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') account = args[++i];
    else if (args[i] === '--name') name = args[++i];
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--trust') trust = true;
    else if (args[i].startsWith('-') || dir !== null) throw new Error(`unexpected ${args[i]}\n${USAGE}`);
    else dir = args[i];
  }
  if (!dir || account === undefined || name === undefined) throw new Error(USAGE);
  const r = await call('POST', '/new', { pane: process.env.TMUX_PANE, dir: resolve(dir), name, account, effort, trust });
  console.log(`${r.name}: started${account ? ` in ${account}` : ''}${trustNote(r.trust)}`);
  if (r.trust === 'unanswered') process.exitCode = 1;
}

async function restart(args) {
  const names = [];
  let account = null, effort = null, killJobs = false, trust = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') account = args[++i];
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--kill-jobs') killJobs = true;
    else if (args[i] === '--trust') trust = true;
    else if (args[i].startsWith('-')) throw new Error(`unknown option ${args[i]}\n${USAGE}`);
    else names.push(args[i]);
  }
  if (!names.length || (account !== null && !account)) throw new Error(USAGE);
  const { results } = await call('POST', '/restart', { pane: process.env.TMUX_PANE, names, account, effort, killJobs, trust });
  let failed = false;
  for (const r of results) {
    if (r.error) { failed = true; console.log(`${r.name}: not restarted — ${r.error}`); continue; }
    const how = r.resumed ? 'resumed' : `new conversation${r.uuid ? `, previous ${r.uuid}` : ''}`;
    console.log(`${r.name}: restarted in ${r.account ?? 'its account'}, ${how}${trustNote(r.trust)}`);
    if (r.trust === 'unanswered') failed = true;
  }
  if (failed) process.exitCode = 1;
}

async function watch(args) {
  const names = [];
  let once = false, asJson = false, interval = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--once') once = true;
    else if (args[i] === '--json') asJson = true;
    else if (args[i] === '--interval') interval = Number(args[++i]);
    else if (args[i].startsWith('-')) throw new Error(`unknown option ${args[i]}\n${USAGE}`);
    else names.push(args[i]);
  }
  if (!(interval >= 1)) throw new Error('--interval must be at least 1 second');
  const pane = process.env.TMUX_PANE;
  const path = `/attention${pane ? `?pane=${encodeURIComponent(pane)}` : ''}`;
  const time = () => new Date().toTimeString().slice(0, 8);
  const emit = ev => {
    if (asJson) return console.log(JSON.stringify({ at: new Date().toISOString(), ...ev }));
    if (ev.event === 'waiting') {
      console.log(`${time()} ${ev.session}: waiting for input`);
      if (ev.prompt) console.log(ev.prompt.split('\n').map(l => `    ${l}`).join('\n'));
    } else if (ev.event === 'answered') console.log(`${time()} ${ev.session}: no longer waiting (${ev.status})`);
    else if (ev.event === 'gone') console.log(`${time()} ${ev.session}: session ended`);
    else console.log(`${time()} ${ev.message}`);
  };

  const seen = new Map(); // session → prompt text while it waits, null otherwise
  let first = true, down = false;
  for (;;) {
    let st;
    try {
      st = await call('GET', path);
      if (down) emit({ event: 'note', message: 'muxboard is reachable again' });
      down = false;
    } catch (err) {
      if (first) throw err;
      if (!down) emit({ event: 'note', message: `${err.message}; retrying` });
      down = true;
    }
    if (st) {
      const current = new Map(st.sessions.map(s => [s.name, s]));
      if (first) {
        const missing = names.filter(n => !current.has(n) && n !== st.caller);
        if (missing.length) throw new Error(`no such session: ${missing.join(', ')}`);
        if (names.includes(st.caller)) throw new Error('a session cannot watch itself');
      }
      const watched = names.length ? names : [...new Set([...current.keys(), ...seen.keys()])];
      let reported = false;
      for (const name of watched) {
        const s = current.get(name);
        const before = seen.get(name);
        if (!s) {
          if (seen.has(name)) { emit({ event: 'gone', session: name }); seen.delete(name); }
          continue;
        }
        if (s.status === 'attention') {
          const prompt = s.prompt ?? '';
          if (before !== prompt) {
            emit({ event: 'waiting', session: name, account: s.account, prompt });
            reported = true;
          }
          seen.set(name, prompt);
        } else {
          if (typeof before === 'string') emit({ event: 'answered', session: name, status: s.status });
          seen.set(name, null);
        }
      }
      if (once && reported) return;
      first = false;
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'ls') await ls(rest);
  else if (cmd === 'new') await create(rest);
  else if (cmd === 'restart') await restart(rest);
  else if (cmd === 'watch') await watch(rest);
  else { console.log(USAGE); process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0; }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
