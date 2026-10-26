#!/usr/bin/env node
// Command-line control of a running Muxboard over its Unix socket.
//   muxboard ls [--json]
//   muxboard restart [--account NAME] [--kill-jobs] SESSION...
// Restart works only from a session whose "may restart others" switch is on.

import { request } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SOCKET = join(process.env.XDG_RUNTIME_DIR ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'muxboard'), 'muxboard.sock');

const USAGE = `usage:
  muxboard ls [--json]
  muxboard restart [--account NAME] [--kill-jobs] SESSION...

restart relaunches each idle session under its name. In its own account it
resumes the conversation; with --account set to another account it starts a
new conversation and sends nothing. --kill-jobs also restarts sessions that
only run background shells or agents, killing those jobs.`;

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
  const rows = st.sessions.map(s => [s.name, s.account ?? '-', s.status, s.control ? 'may restart others' : '']);
  const w = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length), 4));
  for (const r of rows) console.log(r.map((c, i) => i < 3 ? c.padEnd(w[i]) : c).join('  ').trimEnd());
}

async function restart(args) {
  const names = [];
  let account = null, killJobs = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') account = args[++i];
    else if (args[i] === '--kill-jobs') killJobs = true;
    else if (args[i].startsWith('-')) throw new Error(`unknown option ${args[i]}\n${USAGE}`);
    else names.push(args[i]);
  }
  if (!names.length || (account !== null && !account)) throw new Error(USAGE);
  const { results } = await call('POST', '/restart', { pane: process.env.TMUX_PANE, names, account, killJobs });
  let failed = false;
  for (const r of results) {
    if (r.error) { failed = true; console.log(`${r.name}: not restarted — ${r.error}`); continue; }
    const how = r.resumed ? 'resumed' : `new conversation${r.uuid ? `, previous ${r.uuid}` : ''}`;
    console.log(`${r.name}: restarted in ${r.account ?? 'its account'}, ${how}`);
  }
  if (failed) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'ls') await ls(rest);
  else if (cmd === 'restart') await restart(rest);
  else { console.log(USAGE); process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0; }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
