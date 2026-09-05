#!/usr/bin/env node
// Serve the real UI backed by invented sessions. Useful for working on the
// frontend with nothing running, and for capturing screenshots without
// putting anyone's actual projects on display.
//
//   node scripts/demo.mjs        # http://127.0.0.1:8801
//
// Every action is a no-op that just reports success.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const PORT = Number(process.env.DEMO_PORT || 8801);
const PUBLIC_DIR = resolve(new URL('../public/', import.meta.url).pathname);

const SESSIONS = [
  {
    name: 'acme-api',
    repo: '~/projects/acme-api',
    status: 'working',
    ageMinutes: 34,
    remoteControl: true,
    attached: false,
    version: '2.1.219',
    peek: [
      '❯ add rate limiting to the public endpoints',
      '',
      '● Token bucket per API key, refilled on a timer. Starting with the',
      '  middleware, then wiring it into the public router.',
      '',
      '● Read(src/middleware/mod.rs)',
      '  └ Read 84 lines',
      '',
      '● Write(src/middleware/rate_limit.rs)',
      '  └ Wrote 96 lines',
      '',
      '● Bash(cargo test -p acme-api)',
      '  └ running 42 tests …',
      '',
      '✻ Brewing… (esc to interrupt)',
    ],
  },
  {
    name: 'docs-site',
    repo: '~/projects/docs-site',
    status: 'attention',
    ageMinutes: 8,
    remoteControl: true,
    attached: false,
    version: '2.1.219',
    peek: [
      '❯ publish the new getting-started guide to staging',
      '',
      '● The guide builds clean. Deploying to the staging bucket now.',
      '',
      '● Bash(./scripts/deploy.sh --env staging)',
      '  └ This overwrites everything currently in staging.',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. Yes, and don’t ask again for deploy.sh',
      '  3. No, tell Claude what to do differently',
    ],
  },
  {
    name: 'toy-compiler',
    repo: '~/projects/toy-compiler',
    status: 'idle',
    ageMinutes: 190,
    remoteControl: true,
    attached: true,
    version: '2.1.219',
    peek: [
      '❯ why does the parser drop trailing commas?',
      '',
      '● parse_list() consumes the comma, then checks for the closing brace',
      '  and breaks — so the element parsed just before it is never pushed.',
      '',
      '● Read(src/parser.rs)',
      '  └ Read 210 lines',
      '',
      '● Edit(src/parser.rs)',
      '  └ Push the pending element before breaking out of the loop.',
      '',
      '● Fixed. Added a regression test for `[1, 2, 3,]` covering both the',
      '  array and object cases.',
      '',
      '✻ Cooked for 8s',
    ],
  },
];

// A fuller board, so the list has to earn its keep.
const MORE = [
  ['website', 'idle', 412, ['❯ tighten the hero copy', '', '● Done — three variants in copy/hero.md.', '', '✻ Cooked for 12s']],
  ['infra', 'working', 3, ['❯ rotate the staging certs', '', '● Bash(./scripts/certs.sh --env staging)', '  └ requesting …', '', '✻ Brewing… (esc to interrupt)']],
  ['mobile-app', 'attention', 27, ['● Edit(app/src/main/Nav.kt)', '', 'Do you want to make this edit?', '❯ 1. Yes', '  2. Yes, allow all edits this session', '  3. No']],
  ['billing', 'idle', 95, ['❯ reconcile last month', '', '● 14 invoices matched, 2 flagged for review — see reconcile.md.']],
  ['search-index', 'working', 61, ['● Bash(cargo bench)', '  └ running 8 benches …', '', '✻ Simmering… (esc to interrupt)']],
  ['design-system', 'idle', 840, ['● Tokens exported. Nothing else pending.']],
  ['ci-migration', 'working', 12, ['● Read(.github/workflows/ci.yml)', '  └ Read 122 lines', '', '✻ Thinking… (esc to interrupt)']],
  ['notebooks', 'idle', 1500, ['❯ summarise the retention analysis', '', '● Weekly retention is flat at 41%; the D30 dip is a tracking bug.']],
  ['toy-compiler-2', 'attention', 5, ['Plan mode is on. Approve the plan?', '❯ 1. Yes, clear context and go', '  2. Yes, keep context', '  3. No, keep planning']],
];
for (const [name, status, ageMinutes, peek] of MORE) {
  SESSIONS.push({ name, repo: `~/projects/${name}`, status, ageMinutes, remoteControl: true, attached: false, version: '2.1.219', peek });
}

const FOLDERS = ['acme-api', 'docs-site', 'infra', 'toy-compiler', 'website']
  .map(name => ({
    name,
    path: `/home/you/projects/${name}`,
    root: '~/projects',
    running: SESSIONS.filter(s => s.name === name).length,
  }));

const CONFIG = {
  roots: ['~/projects'],
  shortcuts: [
    { label: '/clear', send: '/clear' },
    { label: '/compact', send: '/compact' },
    { label: '↵ enter', key: 'enter' },
    { label: 'esc', key: 'escape' },
  ],
};

function state() {
  const now = Date.now();
  return {
    host: 'workshop',
    now,
    tmuxRunning: true,
    sessions: SESSIONS.map(s => ({
      name: s.name,
      cwd: s.repo,
      repo: s.repo,
      createdAt: now - s.ageMinutes * 60_000,
      attached: s.attached,
      remoteControl: s.remoteControl,
      pid: 1000,
      version: s.version,
      stale: s.version !== '2.1.219',
      status: s.status,
      peek: s.peek,
    })),
    folders: FOLDERS,
    restore: null,
    config: CONFIG,
    claude: { version: '2.1.219', updating: false, lastUpdate: null, pending: [] },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/api/state') return send(res, 200, state());
  if (pathname === '/api/config') return send(res, 200, CONFIG);
  if (pathname.startsWith('/api/')) return send(res, 200, { ok: true, demo: true });

  const full = resolve(join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname));
  if (!full.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    if (!(await stat(full)).isFile()) return notFound(res);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(full));
  } catch {
    notFound(res);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`muxboard demo on http://127.0.0.1:${PORT} (invented sessions, nothing real)`);
});

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function notFound(res) { res.writeHead(404); res.end('not found'); }
