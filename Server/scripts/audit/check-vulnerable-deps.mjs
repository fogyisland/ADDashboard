#!/usr/bin/env node
// R161.34 — Vulnerable-dependency guard.
//
// WHY THIS EXISTS
// ---------------
// The red-team audit found that the frontend xlsx parser was `xlsx@0.18.5`
// (SheetJS), which carries TWO high-severity advisories that BOTH land
// directly on our attack surface:
//
//   · GHSA-4r6h-8v6p-xvw6 — Prototype Pollution in sheetJS   (<0.19.3)
//   · GHSA-5pgg-2g8v-p4x9 — SheetJS ReDoS                   (<0.20.2)
//
// Our usage is `BulkImportDialog.vue`: the operator picks an .xlsx file and
// the browser parses it. That is *exactly* "untrusted file → parser", so both
// advisories were reachable (pollute Object.prototype, or freeze the tab
// with a ReDoS).
//
// There is no patched release ON NPM — SheetJS withdrew the package from the
// registry and only serves fixed versions (0.19.3+ / 0.20.2+) from their own
// CDN. `npm audit` reports `fixAvailable: false`. The only way out of that
// trap is a different library, so the frontend now uses `exceljs`.
//
// This guard exists so the swap cannot silently regress: nobody re-adds
// `xlsx` (or any other dependency with a known high/critical advisory)
// without this script turning red.
//
// ★ WHY A STATIC LIST INSTEAD OF `npm audit` AT RUNTIME:
//   `npm audit` needs the network and a populated node_modules; it cannot
//   run on the target host and it re-reports transitive noise that changes
//   weekly. A static denylist of (package, vulnerable-range) pairs is
//   deterministic, offline, and fails closed.
//
// ★ THE DENYLIST IS ABOUT **DIRECT** DEPENDENCIES ONLY:
//   Transitive advisories are the package manager's job (`npm audit fix`).
//   A direct dependency is a decision WE make, so WE guard it.
//
// Usage:  node Server/scripts/audit/check-vulnerable-deps.mjs
//         node Server/scripts/audit/check-vulnerable-deps.mjs --json
// Exit:   0 = no violation, 1 = at least one violation.
// Output: Server/scripts/audit/vulnerable-deps.json (machine-readable)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonOnly = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Locate the repo root: walk up until a directory contains a 'Server' subdir.
// ---------------------------------------------------------------------------
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'Server'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(__dirname);
if (!repoRoot) {
  console.error('FATAL: could not locate the repo root (no "Server" directory above this script).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The denylist: direct dependencies that must NOT appear.
//
//   pkg        — package name
//   maxSafe   — highest version that is still safe (exclusive). A declared
//                range is rejected if it can resolve to a vulnerable version.
//   advisory  — the human-readable reason (shown in the report).
//
// ★ `maxSafe` semantics: "every version >= maxSafe is fine, everything
//   below is not". For xlsx that is deliberately `null` because the safe
//   releases are not on npm at all — the whole package is unusable, no
//   matter which version you ask for.
// ---------------------------------------------------------------------------
const DENYLIST = [
  {
    pkg: 'xlsx',
    maxSafe: null,          // no safe release exists on npm (SheetJS withdrew it)
    advisory: 'GHSA-4r6h-8v6p-xvw6 (Prototype Pollution) + GHSA-5pgg-2g8v-p4x9 (ReDoS). '
      + 'No fixed release on npm; the frontend parses operator-uploaded xlsx files, '
      + 'so both advisories are directly reachable. Use exceljs instead.'
  }
];

// ---------------------------------------------------------------------------
// Minimal semver range check.
// ---------------------------------------------------------------------------
// We only need to answer one question: "can this declared range resolve to a
// version < maxSafe?" A full semver implementation is overkill and a
// dependency we do not want in an audit script.
//
// Supported range forms (that is what package.json actually uses here):
//   "1.2.3"        exact
//   "^1.2.3"       >=1.2.3 <2.0.0
//   "~1.2.3"       >=1.2.3 <1.3.0
//   ">=1.2.3"      >=1.2.3
//   ">1.2.3"       >1.2.3
//   "1.2.x"        >=1.2.0 <1.3.0
//   "1.x"          >=1.0.0 <2.0.0
//   "*" / ""       any
//
// Returns:
//   'vulnerable'  — the range admits at least one version below maxSafe
//   'safe'        — the range admits only versions >= maxSafe
//   'unknown'     — the range form is not understood (fail closed: treat as
//                   vulnerable so a weird range never slips through silently)
// ---------------------------------------------------------------------------
function parseVersion(text) {
  const m = String(text).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: m[2] === undefined ? null : Number(m[2]),
    patch: m[3] === undefined ? null : Number(m[3])
  };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor === null || b.minor === null) return 0;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch === null || b.patch === null) return 0;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Can `range` resolve to a version strictly below `maxSafe`?
 * @param {string} range
 * @param {string} maxSafe  semver string; null means "no safe version exists"
 * @returns {'vulnerable'|'safe'|'unknown'}
 */
function rangeAdmitsVulnerable(range, maxSafe) {
  const raw = String(range || '').trim();
  if (raw === '' || raw === '*' || raw === 'latest') {
    // "any version" ⇒ if no safe version exists, this is vulnerable.
    return maxSafe === null ? 'vulnerable' : 'unknown';
  }
  if (maxSafe === null) {
    // No safe release of this package exists at all ⇒ ANY declared range is
    // a violation, whatever it says.
    return 'vulnerable';
  }
  const safe = parseVersion(maxSafe);
  if (!safe) return 'unknown';

  // Strip the leading operator.
  const opMatch = raw.match(/^(\^|~|>=|>|<=|<|=)?\s*(.+)$/);
  if (!opMatch) return 'unknown';
  const op = opMatch[1] || '=';
  const rest = opMatch[2].trim();

  // Wildcard forms: "1.2.x" / "1.x"
  if (/[xX*]/.test(rest)) {
    const parts = rest.split('.');
    const major = Number(parts[0]);
    if (!Number.isInteger(major)) return 'unknown';
    if (op === '^' || op === '~' || op === '=' || op === '') {
      // ^1.x / ~1.x / 1.x ⇒ admits major 1 ⇒ if major 1 is below maxSafe
      // (i.e. maxSafe.major > 1) it is vulnerable.
      return safe.major > 1 ? 'vulnerable' : 'safe';
    }
    return 'unknown';
  }

  const v = parseVersion(rest);
  if (!v) return 'unknown';

  if (op === '=' || op === '') {
    return compareVersions(v, safe) < 0 ? 'vulnerable' : 'safe';
  }
  if (op === '>=' ) {
    // >=v is safe iff v >= maxSafe
    return compareVersions(v, safe) >= 0 ? 'safe' : 'unknown';
  }
  if (op === '>') {
    // >v admits maxSafe itself ⇒ safe (maxSafe is allowed)
    return 'safe';
  }
  if (op === '<=' || op === '<') {
    // Admit versions below v ⇒ vulnerable unless v <= maxSafe... but
    // "<= maxSafe" would admit maxSafe-1 which is unsafe. Treat as
    // vulnerable whenever the range can reach below maxSafe.
    return compareVersions(v, safe) <= 0 ? 'vulnerable' : 'safe';
  }
  if (op === '^') {
    // ^v ⇒ >=v and <next-major (or <next-minor for 0.x)
    const upper = { major: v.major + (v.major === 0 ? 1 : 1), minor: 0, patch: 0 };
    const admitsOld = v.major === 0
      ? { major: 0, minor: (v.minor ?? 0) + 1, patch: 0 }
      : upper;
    // The range's lower bound is v; if v itself is below maxSafe the range
    // admits it ⇒ vulnerable.
    if (compareVersions(v, safe) < 0) return 'vulnerable';
    // Otherwise the whole range is >= v >= maxSafe ⇒ safe.
    void admitsOld;
    return 'safe';
  }
  if (op === '~') {
    // ~v ⇒ >=v, <v.minor+1
    if (compareVersions(v, safe) < 0) return 'vulnerable';
    return 'safe';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Scan every package.json that declares dependencies for the product.
// ---------------------------------------------------------------------------
const TARGET_MANIFESTS = [
  { rel: join('Server', 'center', 'package.json'), why: 'the center service (runs on the target host)' },
  { rel: join('Server', 'package.json'), why: 'the server workspace root' },
  { rel: join('Server', 'agent', 'package.json'), why: 'the AD agent' },
  { rel: join('Server', 'noadagent', 'package.json'), why: 'the non-AD agent' },
  { rel: join('ADAgent', 'agent', 'package.json'), why: 'the AD green package' },
  { rel: join('MemberAgent', 'agent', 'package.json'), why: 'the member green package' },
  { rel: join('LinuxServer', 'center', 'package.json'), why: 'the Linux delivery manifest' }
];

const findings = [];
const scanned = [];

for (const target of TARGET_MANIFESTS) {
  const abs = join(repoRoot, target.rel);
  if (!existsSync(abs)) {
    scanned.push({ manifest: target.rel, present: false, why: target.why });
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    findings.push({
      severity: 'error',
      code: 'D0-unreadable-manifest',
      manifest: target.rel,
      detail: `cannot parse: ${e.message}`
    });
    continue;
  }
  const deps = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {})
  };
  const declared = [];
  for (const rule of DENYLIST) {
    const range = deps[rule.pkg];
    if (range === undefined) continue;
    declared.push(rule.pkg);
    const verdict = rangeAdmitsVulnerable(range, rule.maxSafe);
    if (verdict === 'safe') continue;
    findings.push({
      severity: 'error',
      code: 'D1-vulnerable-dependency',
      manifest: target.rel,
      why: target.why,
      package: rule.pkg,
      declaredRange: range,
      safeVersion: rule.maxSafe ?? '(none published on npm)',
      advisory: rule.advisory,
      detail: verdict === 'unknown'
        ? `"${rule.pkg}": "${range}" — range form not understood; treated as a violation (fail closed)`
        : `"${rule.pkg}": "${range}" resolves to a version with a known advisory`
    });
  }
  scanned.push({
    manifest: target.rel,
    present: true,
    why: target.why,
    denylistHits: declared
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const report = {
  generatedAt: new Date().toISOString(),
  rule: 'R161.34 — vulnerable direct dependencies are forbidden',
  denylist: DENYLIST.map(d => ({ pkg: d.pkg, maxSafe: d.maxSafe, advisory: d.advisory })),
  scanned,
  findings,
  errorCount: findings.length
};

const outFile = join(repoRoot, 'Server', 'scripts', 'audit', 'vulnerable-deps.json');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const f of findings) {
    console.error(`  ERROR [${f.code}] ${f.manifest}: ${f.detail}`);
    if (f.advisory) console.error(`         advisory: ${f.advisory}`);
  }
  console.log(`--- ${findings.length} error(s) -> Server/scripts/audit/vulnerable-deps.json`);
}

process.exit(findings.length > 0 ? 1 : 0);
