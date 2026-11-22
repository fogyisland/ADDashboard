#!/usr/bin/env node
// R161.35 step 2 (2026-11-22) — seal the member-script manifest.
//
// Rewrites the `sha256` field of every entry in agent/src/member-scripts.js
// with the digest of the current file on disk.
//
// ★ Run this ONLY after intentionally editing or adding a script in
//   agent/scripts/. It is the "build-time seal" step: the manifest that ships
//   with the agent is the one an attacker cannot change without the build.
//
// ★ It refuses to seal a script that does not exist, so a typo in `file`
//   cannot leave a manifest pointing at nothing.
//
// Usage:
//   node Server/scripts/audit/refresh-member-script-hashes.mjs           # write
//   node Server/scripts/audit/refresh-member-script-hashes.mjs --check   # verify only

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');
const MANIFEST_PATH = join(SERVER_ROOT, 'agent', 'src', 'member-scripts.js');
const SCRIPTS_DIR = join(SERVER_ROOT, 'agent', 'scripts');

const checkOnly = process.argv.includes('--check');

if (!existsSync(MANIFEST_PATH)) {
  console.error(`FATAL: manifest not found: ${MANIFEST_PATH}`);
  process.exit(2);
}

const source = readFileSync(MANIFEST_PATH, 'utf8');

// Load the manifest by importing it (it is plain ESM with no side effects
// beyond computing the scripts dir).
const { MEMBER_SCRIPTS } = await import(`file://${MANIFEST_PATH.replace(/\\/g, '/')}`);

const ids = Object.keys(MEMBER_SCRIPTS);
if (ids.length === 0) {
  console.error('FATAL: manifest declares no scripts');
  process.exit(2);
}

let next = source;
const problems = [];
const sealed = [];

for (const id of ids) {
  const entry = MEMBER_SCRIPTS[id];
  const file = join(SCRIPTS_DIR, entry.file);
  if (!existsSync(file)) {
    problems.push(`${id}: file not found: ${entry.file}`);
    continue;
  }
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  sealed.push({ id, file: entry.file, digest, was: entry.sha256 || '(none)' });

  const escapedFile = entry.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Replace the sha256 of the entry keyed by `id`. The entry block is
  // `  id: { ... file: 'x.ps1', sha256: '...' ... }` — match the file line
  // and the sha256 line that follows it.
  const entryRe = new RegExp(
    `(\\n\\s*${id}:\\s*\\{[\\s\\S]*?file:\\s*'${escapedFile}'[\\s\\S]*?sha256:\\s*')([0-9a-f]*)(')`
  );
  if (!entryRe.test(next)) {
    problems.push(`${id}: could not locate the sha256 line for file '${entry.file}' in the manifest`);
    continue;
  }
  next = next.replace(entryRe, `$1${digest}$3`);
}

for (const s of sealed) {
  const status = s.was === s.digest ? 'ok   ' : (s.was === '(none)' ? 'seal ' : 'UPDATE');
  console.log(`  ${status} ${s.id.padEnd(20)} ${s.file.padEnd(32)} ${s.digest.slice(0, 12)}…`);
}
for (const p of problems) console.error(`  ERROR ${p}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) — manifest NOT written`);
  process.exit(1);
}

if (checkOnly) {
  const stale = sealed.filter((s) => s.was !== s.digest);
  if (stale.length > 0) {
    console.error(`\n${stale.length} script(s) have a stale digest: ${stale.map((s) => s.id).join(', ')}`);
    console.error('Run without --check to reseal.');
    process.exit(1);
  }
  console.log('\nmanifest is up to date');
  process.exit(0);
}

if (next !== source) {
  writeFileSync(MANIFEST_PATH, next, 'utf8');
  console.log(`\nwrote ${MANIFEST_PATH}`);
} else {
  console.log('\nmanifest unchanged');
}
