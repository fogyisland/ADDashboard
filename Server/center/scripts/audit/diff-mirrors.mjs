#!/usr/bin/env node
// R120 Audit Task 8 — Publish mirror byte-equal drift detector
// (R114.A LESSON复审;commit `92d157d` proved mirror drift = boot-fail bug class)
//
// Walks center ↔ publish/system/center and agent ↔ publish/installer/agentInstall/agent
// and reports any byte-difference. Excludes dev-only paths that intentionally don't
// ship (tests, mock runners, probe scripts, runtime artifacts).
//
// Output: center/mirror-diff.json (empty array = clean).
// Exit:   0 if no drift, 1 if any drift found.
//
// Usage:  node center/scripts/audit/diff-mirrors.mjs
//         node --test center/tests/audit/publish-mirror.test.js

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script lives at center/scripts/audit/diff-mirrors.mjs (3 levels deep
// under repo root). The output JSON must land at center/mirror-diff.json
// (next to center/, NOT inside it), so we walk up exactly 3 ancestors.
const repoRoot = join(__dirname, '..', '..', '..');

// Exclusions — paths that legitimately do NOT ship to the publish mirror.
//
// `diff -rq` on Windows emits two line shapes:
//   Only in '<dir>': <name>           — file/dir exists in only one side
//   Files '<a>' and '<b>' differ      — content drift between both sides
//
// We exclude based on:
//   (1) path-fragments anywhere in the line (e.g., `/tests/`, `/logs/`,
//       `/node_modules/`, `/probe-`)
//   (2) the trailing filename after `': '` in an `Only in` line
//       (e.g., `logs`, `tests`, `node_modules`, `mock-daemon.mjs`)
//   (3) SQLite artifact filename extensions (`.db`, `.db-shm`, `.db-wal`)
//
// Categories:
//   1. Test dirs (`tests/`) — never ship to mirror (gitignored in publish/*)
//   2. Runtime artifacts (`logs/`, `node_modules/`, `*.db`, `mock-daemon.err`)
//   3. Dev-only mock + probe scripts (NOT tracked on mirror per `git ls-files`):
//      mock-replication.mjs, mock-snapshot.mjs DO ship; others don't.
//   4. Local-secret config files (`appsettings.dev.json`,
//      `appsettings.example.json`, `appsettings.json`)
//   5. Web frontend test output (`web/tests/`)
//   6. Audit-output JSON (`findings.json`, `mirror-diff.json` itself)
const EXCLUDE_PATH_FRAGMENTS = [
  '/tests/',            // any path with /tests/ subdir
  "/tests':",           // `<dir>/tests':` (the colon comes AFTER the single-quote)
  '/node_modules/',
  "/node_modules':",
  '/logs/',
  "/logs':",
  '/web/tests/',
  "/web/tests':",
  '/agent/tests/',
  "/agent/tests':",
  '/agent/scripts/tests',
  '/probe-',
  '/probe.',
];

const EXCLUDE_NAME_PATTERNS = [
  // Common subdirs that appear as the trailing name in `Only in '<dir>': <name>`
  'logs',
  'node_modules',
  'tests',
  'mock-daemon.err',
  // Files that should never appear on the mirror side:
  'findings.json',
  'process-exit-findings.json',
  'error-coverage-findings.json',
  'mirror-diff.json',
  'appsettings.dev.json',
  'appsettings.example.json',
  'appsettings.json',
  // Dev-only mock + probe scripts (verified NOT in mirror per `git ls-files`):
  'mock-ad-admin-e2e.mjs',
  'mock-ad-admin.mjs',
  'mock-discover.mjs',
  'mock-file-push.mjs',
  'mock-heartbeat-daemon.mjs',
  'mock-heartbeat.mjs',
  'mock-member-commands-e2e.mjs',
  'mock-member-commands.mjs',
  'mock-multi-agent.mjs',
  'check-hb.js',
  'cleanup-stale-mocks.js',
  'verify-report-requested-http.js',
  'verify-report-requested.js',
  // Agent-side runtime artifacts:
  'queue.db',
  'queue.db-shm',
  'queue.db-wal',
];

// Return { excluded, why } where `why` is for debug logging only.
function isExcluded(line) {
  const norm = line.replace(/\\/g, '/');

  // Path fragments — match anywhere
  if (EXCLUDE_PATH_FRAGMENTS.some((p) => norm.includes(p))) return true;

  // `Only in '<dir>': <name>` line — extract the trailing filename
  const onlyInMatch = norm.match(/^Only in '.+': (.+)$/);
  if (onlyInMatch) {
    const name = onlyInMatch[1];
    if (EXCLUDE_NAME_PATTERNS.includes(name)) return true;
    // probe-* scripts and *.sql probe files are dev-only:
    //   probe-r108-*, probe-r114-*, probe-r115-*, probe-r118-*,
    //   probe-route-500, probe-port-status-tables, probe-partner-table-gap
    if (/^probe-/.test(name) || /^probe-\w+\.sql$/.test(name)) return true;
    // SQLite artifacts by extension (queue.db-wal, queue.db-shm, *.db)
    if (/\.(db|db-shm|db-wal)$/.test(name)) return true;
    return false;
  }

  // `Files ... and ... differ` line — content drift, never exclude (real bug)
  return false;
}

function diffTree(label, a, b) {
  // diff -rq: exit 0 = identical, 1 = differences, 2 = error
  try {
    const out = execFileSync('diff', ['-rq', a, b], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { label, diff: out, error: null };
  } catch (e) {
    if (e.status === 1) {
      // Differences found — that's our finding payload, not an error
      return { label, diff: e.stdout?.toString() || '', error: null };
    }
    return { label, diff: '', error: e.stderr?.toString() || e.message };
  }
}

const findings = [];

// Center tree diff
const centerA = join(repoRoot, 'center');
const centerB = join(repoRoot, 'publish', 'system', 'center');
const centerResult = diffTree('center→publish/system/center', centerA, centerB);

if (centerResult.error) {
  findings.push({ side: 'center', error: centerResult.error, drifts: [] });
} else {
  const drifts = centerResult.diff
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isExcluded(l));
  if (drifts.length > 0) {
    findings.push({ side: 'center', drifts });
  }
}

// Agent tree diff
const agentA = join(repoRoot, 'agent');
const agentB = join(repoRoot, 'publish', 'installer', 'agentInstall', 'agent');
const agentResult = diffTree('agent→publish/installer/agentInstall/agent', agentA, agentB);

if (agentResult.error) {
  findings.push({ side: 'agent', error: agentResult.error, drifts: [] });
} else {
  const drifts = agentResult.diff
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isExcluded(l));
  if (drifts.length > 0) {
    findings.push({ side: 'agent', drifts });
  }
}

const outPath = join(repoRoot, 'center', 'mirror-diff.json');
writeFileSync(outPath, JSON.stringify(findings, null, 2) + '\n');

if (findings.length === 0) {
  console.log('mirror-diff: 0 sides with drift (center ↔ publish/system/center + agent ↔ publish/installer/agentInstall/agent)');
  process.exit(0);
}

console.log(`mirror-diff: ${findings.length} side(s) with drift — see center/mirror-diff.json`);
for (const f of findings) {
  console.log(`  ${f.side}: ${(f.drifts || []).length} drift(s)`);
}
process.exit(1);