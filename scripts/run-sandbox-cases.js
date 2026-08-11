#!/usr/bin/env node
// run-sandbox-cases.js — exercise the Node.js DDL sandbox (center/src/packages/ddl-sandbox.js)
// against the shared fixture file used by .NET's SandboxGoldenTests.
//
// Usage:
//   node scripts/run-sandbox-cases.js [path/to/sandbox-cases.json]
//
// Exit code:
//   0  — every case matched the expected outcome
//   1  — at least one case diverged, or the runner hit an error
//
// One PASS/FAIL line per case, plus a final summary line. No external
// dependencies — this repo is ESM ("type": "module"); we use a dynamic
// import so the file works regardless of where the runner is invoked from.

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Repo root: scripts/ -> ../
const REPO_ROOT = resolve(__dirname, '..');
// Sandbox lives in the center sub-project (ESM module).
const SANDBOX_PATH = resolve(REPO_ROOT, 'center/src/packages/ddl-sandbox.js');

function defaultFixture() {
  return resolve(REPO_ROOT, 'Tests/fixtures/sandbox-cases.json');
}

async function loadFixture(pathArg) {
  const fixturePath = pathArg ? resolve(pathArg) : defaultFixture();
  let raw;
  try {
    raw = await readFile(fixturePath, 'utf8');
  } catch (e) {
    console.error(`FAIL — cannot read fixture at ${fixturePath}: ${e.message}`);
    process.exit(1);
  }
  try {
    return { fixturePath, cases: JSON.parse(raw) };
  } catch (e) {
    console.error(`FAIL — fixture at ${fixturePath} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

function compareBlocked(actual, expected) {
  // The fixture's `expectedBlocked` is treated as a literal string by both
  // .NET (SandboxGoldenTests.Golden_Matches_NodeJs_Output uses
  // Assert.Equal) and the Node side. The value matches what the Node
  // sandbox returns verbatim:
  //   - pattern matches        -> the regex.source string
  //     (e.g. ";\\s*\\S", "\\bpkg_...\\.[a-z0-9_]+")
  //   - token walker failures  -> free-form messages like
  //     "unknown identifier: DROPPED"
  // Both are pre-escaped correctly in the JSON fixture, so plain string
  // equality is the right comparison.
  if (typeof actual !== 'string') return `blocked value was not a string: ${actual}`;
  if (actual === expected) return null;
  return `blocked value differs: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

async function main() {
  const pathArg = process.argv[2];
  const { fixturePath, cases } = await loadFixture(pathArg);

  let sandbox;
  try {
    sandbox = await import(pathToFileURL(SANDBOX_PATH).href);
  } catch (e) {
    console.error(`FAIL — cannot import sandbox module at ${SANDBOX_PATH}: ${e.message}`);
    process.exit(1);
  }

  if (typeof sandbox.scanSql !== 'function') {
    console.error(`FAIL — sandbox module did not export scanSql()`);
    process.exit(1);
  }

  console.log(`Running ${cases.length} sandbox case(s) from ${fixturePath}`);
  console.log(`Sandbox module: ${SANDBOX_PATH}`);

  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const c of cases) {
    let result;
    try {
      result = sandbox.scanSql(c.sql, c.selfPackage);
    } catch (e) {
      fail += 1;
      failures.push(`FAIL ${c.name} — scanSql() threw: ${e.message}`);
      console.log(`FAIL ${c.name} — scanSql() threw: ${e.message}`);
      continue;
    }

    if (result.ok !== c.expectedOk) {
      fail += 1;
      const msg = `expectedOk=${c.expectedOk}, got ok=${result.ok}, blocked=${JSON.stringify(result.blocked)}`;
      failures.push(`FAIL ${c.name} — ${msg}`);
      console.log(`FAIL ${c.name} — ${msg}`);
      continue;
    }

    if (!c.expectedOk) {
      const diff = compareBlocked(result.blocked, c.expectedBlocked);
      if (diff) {
        fail += 1;
        const msg = `${diff} (got blocked=${JSON.stringify(result.blocked)})`;
        failures.push(`FAIL ${c.name} — ${msg}`);
        console.log(`FAIL ${c.name} — ${msg}`);
        continue;
      }
    }

    pass += 1;
    console.log(`PASS ${c.name}`);
  }

  console.log(`${pass}/${cases.length} cases matched`);

  if (fail > 0) {
    console.error('--- failure detail ---');
    for (const f of failures) console.error(f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`FAIL — runner crashed: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
