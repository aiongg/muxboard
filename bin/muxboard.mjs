#!/usr/bin/env node
// Command-line control of a running Muxboard over its Unix socket.
//   muxboard ls [--json]
//   muxboard new [--account NAME] [--name NAME] [--trust] DIR
//   muxboard restart [--account NAME] [--kill-jobs] [--trust] SESSION...
// new and restart work only from a session whose "may manage sessions" switch
// is on.

import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SOCKET = join(process.env.XDG_RUNTIME_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'muxboard'), 'muxboard.sock');

const USAGE = `usage:
  muxboard ls [--json]
  muxboard new [--account NAME] [--name NAME] [--trust] DIR
  muxboard restart [--account NAME] [--kill-jobs] [--trust] SESSION...

new starts a Claude Code session in DIR (under ~), named after the folder
unless --name is given, in the active account unless --account is given.

restart relaunches each idle session under its name. In its own account it
resumes the conversation; with --account set to another account it starts a
new conversation and sends nothing. --kill-jobs also restarts sessions that
only run background shells or agents, killing those jobs.

--trust answers yes when the new process asks whether to trust the folder.`;

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
  let account = null, name = null, trust = false, dir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') account = args[++i];
    else if (args[i] === '--name') name = args[++i];
    else if (args[i] === '--trust') trust = true;
    else if (args[i].startsWith('-') || dir !== null) throw new Error(`unexpected ${args[i]}\n${USAGE}`);
    else dir = args[i];
  }
  if (!dir || account === undefined || name === undefined) throw new Error(USAGE);
  const r = await call('POST', '/new', { pane: process.env.TMUX_PANE, dir: resolve(dir), name, account, trust });
  console.log(`${r.name}: started${account ? ` in ${account}` : ''}${trustNote(r.trust)}`);
  if (r.trust === 'unanswered') process.exitCode = 1;
}

async function restart(args) {
  const names = [];
  let account = null, killJobs = false, trust = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') account = args[++i];
    else if (args[i] === '--kill-jobs') killJobs = true;
    else if (args[i] === '--trust') trust = true;
    else if (args[i].startsWith('-')) throw new Error(`unknown option ${args[i]}\n${USAGE}`);
    else names.push(args[i]);
  }
  if (!names.length || (account !== null && !account)) throw new Error(USAGE);
  const { results } = await call('POST', '/restart', { pane: process.env.TMUX_PANE, names, account, killJobs, trust });
  let failed = false;
  for (const r of results) {
    if (r.error) { failed = true; console.log(`${r.name}: not restarted — ${r.error}`); continue; }
    const how = r.resumed ? 'resumed' : `new conversation${r.uuid ? `, previous ${r.uuid}` : ''}`;
    console.log(`${r.name}: restarted in ${r.account ?? 'its account'}, ${how}${trustNote(r.trust)}`);
    if (r.trust === 'unanswered') failed = true;
  }
  if (failed) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'ls') await ls(rest);
  else if (cmd === 'new') await create(rest);
  else if (cmd === 'restart') await restart(rest);
  else { console.log(USAGE); process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0; }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
