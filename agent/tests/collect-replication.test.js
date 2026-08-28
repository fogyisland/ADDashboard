import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const psPath = join(__dirname, '../scripts/collect-replication.ps1');

test('collect-replication.ps1 declares a Get-DcCounters function', () => {
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /function\s+Get-DcCounters\b/,
    'expected Get-DcCounters function definition');
});

test('collect-replication.ps1 emits a __dc_summary__ entry inside Get-ReplicationSnapshot', () => {
  const src = readFileSync(psPath, 'utf8');
  // The summary entry must be inside the snapshot build (not a stand-alone block)
  // and use the three remaining AD cmdlets (LockedCount moved to its own
  // ad_lockout_summary package in round-18).
  assert.match(src, /NamingContext\s*=\s*'__dc_summary__'/,
    "expected NamingContext = '__dc_summary__'");
  // NB: the brief's step-1 regexes said `-Server $dc`, but the step-3
  // implementation (the code we actually ship) passes `-Server $ComputerName`,
  // which is the function's own parameter. `$dc` is NOT in scope inside
  // Get-DcCounters — under PowerShell's dynamic scoping it would silently
  // resolve to the caller's `$dc`, a Get-ADDomainController *object* (and
  // unset entirely when site lookup fails). Asserting on $ComputerName.
  assert.match(src, /Get-ADUser\s+-Filter\s+\*\s+-Server\s+\$ComputerName/,
    'expected Get-ADUser -Filter * -Server $ComputerName call');
  assert.match(src, /Get-ADGroup\s+-Filter\s+\*\s+-Server\s+\$ComputerName/,
    'expected Get-ADGroup -Filter * -Server $ComputerName call');
  assert.match(src, /Get-GPO\b/,
    'expected Get-GPO call');
  // 2026-08-26 round-18: Search-ADAccount -LockedOut left the replication
  // snapshot. The summary's LockedCount column moved to the new
  // ad_lockout_summary package (see tests/lockout-summary-collect.test.js).
  assert.ok(!/Search-ADAccount\s+-LockedOut/.test(src),
    'Search-ADAccount -LockedOut must NOT be called from collect-replication.ps1 — moved to ad_lockout_summary package');
});

test('collect-replication.ps1 wraps each counter query in try/catch', () => {
  const src = readFileSync(psPath, 'utf8');
  // 3 AD counters now (round-18 dropped Search-ADAccount -LockedOut).
  const counterCalls = (src.match(/(Get-ADUser|Get-ADGroup|Get-GPO)/g) || []).length;
  const tryBlocks = (src.match(/^\s*try\s*\{/gm) || []).length;
  assert.ok(counterCalls >= 3, `expected >=3 counter cmdlet calls, got ${counterCalls}`);
  assert.ok(tryBlocks >= 3, `expected >=3 try blocks for fault isolation, got ${tryBlocks}`);
});

test('collect-replication.ps1 no longer carries LockoutEvents or Get-LockoutEvents (round-18)', () => {
  // 2026-08-26 round-18: lockout data ships via the ad_lockout_list package
  // on a 15-minute cadence. The replication snapshot must NOT carry
  // LockoutEvents anymore — keep this script focused on replication.
  const src = readFileSync(psPath, 'utf8');
  assert.ok(!/function\s+Get-LockoutEvents\b/.test(src),
    'Get-LockoutEvents function must be removed from collect-replication.ps1');
  assert.ok(!/Add-Member\s+-NotePropertyName\s+LockoutEvents/.test(src),
    'LockoutEvents NoteProperty must not be added to the snapshot');
  assert.ok(!/LockoutEvents\s*=\s*\(?Get-LockoutEvents/.test(src),
    'LockoutEvents must not be sourced from Get-LockoutEvents in this script');
});

// 2026-08-28 round-45: all partner-port tests deleted (R35 port monitoring
// surface removed end-to-end). Get-PartnerPortSnapshot / Get-PartnerPortConfig /
// Get-PartnerNamingContext are gone — no more per-partner TCP port probes, no
// `__partner_ports__:%` rows emitted. Failure status now travels through the
// replication link's statusCode + errorMessage directly.
