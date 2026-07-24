#!/usr/bin/env node
// Set or clear Muxboard's optional password.
//
//   node scripts/password.mjs           # prompt, then save
//   node scripts/password.mjs --remove  # go back to no password
//   echo 'hunter2' | node scripts/password.mjs   # non-interactive
//
// The hash lives in auth.json (mode 0600), separate from config.json because
// that one is sent to the browser. Setting a password also rotates the session
// secret, which signs out every device.

import { scryptSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'muxboard');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');
const PARAMS = { N: 32768, r: 8, p: 1 };

if (process.argv.includes('--remove')) {
  try {
    await unlink(AUTH_FILE);
    console.log('Password removed — Muxboard no longer asks for one.');
  } catch (err) {
    if (err.code === 'ENOENT') console.log('No password was set.');
    else throw err;
  }
  process.exit(0);
}

const password = process.stdin.isTTY ? await promptTwice() : (await readStdin()).trim();

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { ...PARAMS, maxmem: 128 * 1024 * 1024 });

await mkdir(CONFIG_DIR, { recursive: true });
await writeFile(AUTH_FILE, JSON.stringify({
  alg: 'scrypt',
  ...PARAMS,
  salt: salt.toString('hex'),
  hash: hash.toString('hex'),
  secret: randomBytes(32).toString('hex'),
  updatedAt: new Date().toISOString(),
}, null, 2) + '\n', { mode: 0o600 });
await chmod(AUTH_FILE, 0o600);

console.log(`Password saved to ${AUTH_FILE}`);
console.log('Every device will need to log in again.');

// ------------------------------------------------------------------- prompts

async function promptTwice() {
  const first = await hidden('New password: ');
  const again = await hidden('Repeat password: ');
  if (first !== again) {
    console.error("Passwords didn't match.");
    process.exit(1);
  }
  return first;
}

function hidden(query) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let asked = false;
    rl._writeToOutput = () => {
      if (!asked) { rl.output.write(query); asked = true; } // swallow the typing
    };
    rl.question(query, answer => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
