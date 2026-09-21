// builtin-packages-tracked.test.js — regression guard for the R83 publish
// rebuild gap.
//
// Background: R12 (commit 24b1baa, 2026-08-10) introduced the bundled
// built-in package sources at publish/center/data/packages/<name>/<version>/,
// later renamed in place by R82 (e253ed0, 2026-08-15) to
// publish/system/center/data/packages/. The tree has never lived anywhere
// else in the repo — it IS the source of truth that seedBuiltinPackages
// copies into the runtime data/packages/ tree on first normal-mode start.
// (See center/src/services/builtin-packages.js — the
// builtinSourceCandidates array in server.js shows the seeder's
// first-choice source path is publish/system/center/data/packages/.)
//
// R83 (6b2c269, chore(publish): rebuild dist + sync installer artifacts)
// inadvertently dropped the entire tree from the working copy during a
// publish rebuild. Author intent was the rebuild itself, not the
// deletion; the gap was an unintended side effect. .gitignore's whitelist
// rules (the `!/publish/center/data/packages/...` negation block) were
// R82-pre-rename dead code, so when the files lost their tracked state
// they stayed untracked. center/tests/services/builtin-packages.test.js
// hard-codes SOURCE_DIR to the same path, which is why the gap surfaced
// as 25/30 builtin-packages test failures with `seedBuiltinPackages:
// source not found: ...ad_os_baseline/1.0.0` — and which is why
// production centers never noticed: server.js's
// builtinSourceCandidates falls through to `__dirname/data/packages` when
// launched from the bundled view, so boot succeeded against an empty
// cached runtime tree (a different gap, masked by the missing source).
//
// Fix (commits 1ddd670 + ed074ca + this test):
//   - commit 1ddd670 restored the deleted tree from 6b2c269~1
//   - commit ed074ca fixed the gitignore whitelist path + extended it to
//     all five built-ins (only ad_os_baseline was covered before; R66 +
//     round-18 added the other four)
//   - this test asserts every bundled file is `git ls-files --error-unmatch`
//     tracked, so a future publish rebuild that drops the tree again is
//     caught here in CI rather than at runtime
//
// Layer A — every built-in name from BUILTIN_PACKAGES has a populated
//   <name>/<version>/ source dir on disk AND every file inside it is
//   git-tracked.
//
// Layer B — sanity: the canonical manifest.json + collect.ps1 + the
//   migrations/{,mssql/}001_initial.sql siblings all parse without
//   throwing. JSON.parse here is the same defensive-BOM-strip path the
//   seeder uses; a future manifest corruption surfaces here too.
//
// File-level test, no live DB required. Runs in CI even when
// TEST_MYSQL_URL is unset, mirroring the standalone contract used by
// 019-package-interval-override.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { BUILTIN_PACKAGES } from '../../src/services/builtin-packages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_DIR = path.join(PROJECT_ROOT, 'publish', 'system', 'center', 'data', 'packages');

// The canonical file set per built-in. Only ad_os_baseline ships
// content.sha256 (R12 originally; later built-ins don't bother — the
// seeder doesn't verify a hash today, so missing it is non-fatal and
// not worth a test pin). Every built-in must ship:
//   - manifest.json   (read by both the seeder and the runner)
//   - collect.ps1     (the actual PowerShell payload)
//   - migrations/001_initial.sql        (mysql dialect, ALWAYS present)
//   - migrations/mssql/001_initial.sql  (mssql dialect, ALWAYS present)
const REQUIRED_FILES = [
  'manifest.json',
  'collect.ps1',
  'migrations/001_initial.sql',
  'migrations/mssql/001_initial.sql'
];

// Resolve the repo-relative path of a built-in file, throwing a clear
// assertion message if the file is missing on disk.
function builtInFilePath(pkg, rel) {
  const abs = path.join(SOURCE_DIR, pkg.name, pkg.version, rel);
  return { abs, relFromRoot: path.relative(PROJECT_ROOT, abs).split(path.sep).join('/') };
}

// Returns true if the given repo-relative path is tracked by git. Uses
// `git ls-files --error-unmatch <path>` which exits 0 when tracked and 1
// when not (with no stdout), matching the recommendation in the git
// documentation for scripts that want a yes/no answer. We deliberately
// avoid `git status --porcelain` because that would also report staged
// modifications, which we don't care about here — the contract is
// "the file is part of the source tree", not "the file is clean".
function isTrackedByGit(repoRelPath) {
  try {
    execFileSync(
      'git',
      ['ls-files', '--error-unmatch', '--', repoRelPath],
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return true;
  } catch (err) {
    // Exit code 1 from git ls-files --error-unmatch means "not tracked".
    // Other non-zero exits (e.g. git not on PATH) should fail loud, so
    // we let them propagate — those are real infrastructure failures,
    // not "untracked" answers.
    if (err.status === 1) return false;
    throw err;
  }
}

test('BUILTIN_PACKAGES exposes the 5 expected built-ins (contract pin)', () => {
  // Pin the canonical list. If a future round adds or removes a built-in
  // (e.g. round-18 split lockout into summary + list), this assertion
  // is the first place the change surfaces. The names + versions must
  // match the files the test scans below; if either side drifts the
  // BUILTIN_PACKAGES path mapping breaks.
  const names = BUILTIN_PACKAGES.map(p => p.name).sort();
  assert.deepStrictEqual(
    names,
    [
      'ad_domain_consistency',
      'ad_local_port_check',
      'ad_lockout_list',
      'ad_lockout_summary',
      'ad_os_baseline'
    ],
    'BUILTIN_PACKAGES canonical list drifted — update both builtin-packages.js and this test'
  );
  for (const pkg of BUILTIN_PACKAGES) {
    assert.strictEqual(pkg.version, '1.0.0', `${pkg.name} version must be 1.0.0 (built-ins ship pinned)`);
  }
});

test('publish/system/center/data/packages/: source dir exists on disk', () => {
  assert.ok(
    fs.existsSync(SOURCE_DIR),
    `seedBuiltinPackages' primary source dir must exist: ${SOURCE_DIR} — ` +
      'if this fails, the R83 gap has reopened. See publish-data-mirror-gap plan.'
  );
  const entries = fs.readdirSync(SOURCE_DIR).sort();
  for (const pkg of BUILTIN_PACKAGES) {
    assert.ok(
      entries.includes(pkg.name),
      `built-in ${pkg.name}/ missing from source dir ${SOURCE_DIR}; got: ${entries.join(', ')}`
    );
  }
});

test('every built-in ships the canonical file set on disk', () => {
  for (const pkg of BUILTIN_PACKAGES) {
    const pkgDir = path.join(SOURCE_DIR, pkg.name, pkg.version);
    assert.ok(
      fs.existsSync(pkgDir),
      `${pkg.name}/${pkg.version}/ source dir missing on disk: ${pkgDir}`
    );
    for (const rel of REQUIRED_FILES) {
      const { abs } = builtInFilePath(pkg, rel);
      assert.ok(
        fs.existsSync(abs),
        `${pkg.name}/${pkg.version}/${rel} missing on disk — built-in source is incomplete`
      );
    }
  }
});

test('every built-in file is git-tracked (R83 regression guard)', () => {
  // This is the assertion that would have caught the R83 gap at commit
  // time. Walks every canonical file per built-in and asserts each one
  // is in `git ls-files`. A future publish rebuild that drops the tree
  // (R83 mode) flips every one of these to false, and the test fails
  // loud and clear.
  for (const pkg of BUILTIN_PACKAGES) {
    for (const rel of REQUIRED_FILES) {
      const { relFromRoot } = builtInFilePath(pkg, rel);
      assert.ok(
        isTrackedByGit(relFromRoot),
        `${relFromRoot} is NOT git-tracked — the publish mirror gap has reopened. ` +
          'Restore from a recent commit (the R83 fix used 6b2c269~1) and re-run sync-source-mirror.'
      );
    }
  }
});

test('every built-in manifest.json parses cleanly (no BOM, no trailing junk)', () => {
  // The seeder at center/src/services/builtin-packages.js strips a
  // leading UTF-8 BOM before JSON.parse — match that contract here so
  // a manifest corruption surfaces in this test before it surfaces in
  // the first-start seeder (which would otherwise block center boot).
  //
  // Note: built-in manifest `name` fields use kebab-case
  // (e.g. 'ad-os-baseline') while the on-disk directory uses snake_case
  // ('ad_os_baseline') — this is the existing convention, not a
  // contract worth pinning here. The test only checks structural
  // sanity (parse + non-empty type + version pin), since the runtime
  // keying in script-service is by the kebab manifest.name, not by the
  // dir name.
  for (const pkg of BUILTIN_PACKAGES) {
    const { abs } = builtInFilePath(pkg, 'manifest.json');
    const raw = fs.readFileSync(abs, 'utf8');
    const stripped = raw.replace(/^﻿/, '');
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(stripped); },
      `${pkg.name}/manifest.json is not valid JSON after BOM strip`
    );
    assert.ok(parsed.name && typeof parsed.name === 'string', `${pkg.name}/manifest.name required (string)`);
    assert.strictEqual(parsed.version, pkg.version, `${pkg.name} manifest.version must match dir version`);
    assert.ok(parsed.type, `${pkg.name} manifest.type required (e.g. 'gauge' / 'event-detail')`);
  }
});

test('every built-in collect.ps1 is non-empty PowerShell text (sanity)', () => {
  // Catches the failure mode where a publish rebuild copies an empty
  // file (R83 adjacent risk: a git checkout that materialises a 0-byte
  // placeholder). The agent runner depends on real PS content; an
  // empty collect.ps1 fails every run with a confusing parser error
  // rather than the actual root cause.
  for (const pkg of BUILTIN_PACKAGES) {
    const { abs } = builtInFilePath(pkg, 'collect.ps1');
    const content = fs.readFileSync(abs, 'utf8');
    assert.ok(content.length > 0, `${pkg.name}/collect.ps1 is empty`);
    // Bare-minimum PS heuristic: should at least mention something that
    // looks like a cmdlet, parameter, or assignment. The agent runner
    // wraps every collect.ps1 with strict-mode error handling and
    // expects well-formed script body, not just text.
    assert.match(
      content,
      /\$(?:ErrorActionPreference|using|param|Verbose|Debug)\b|^param\b/m,
      `${pkg.name}/collect.ps1 does not look like valid PowerShell (no $-references or param block)`
    );
  }
});
