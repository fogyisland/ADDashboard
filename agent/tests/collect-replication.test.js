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
  // and use the four canonical AD cmdlets.
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
  assert.match(src, /Search-ADAccount\s+-LockedOut\s+-Server\s+\$ComputerName/,
    'expected Search-ADAccount -LockedOut -Server $ComputerName call');
});

test('collect-replication.ps1 wraps each counter query in try/catch', () => {
  const src = readFileSync(psPath, 'utf8');
  // Count the Get-AD* / Search-ADAccount / Get-GPO invocations and the
  // try/catch blocks around them — must be at least 4 of each.
  const counterCalls = (src.match(/(Get-ADUser|Get-ADGroup|Get-GPO|Search-ADAccount)/g) || []).length;
  const tryBlocks = (src.match(/^\s*try\s*\{/gm) || []).length;
  assert.ok(counterCalls >= 4, `expected >=4 counter cmdlet calls, got ${counterCalls}`);
  assert.ok(tryBlocks >= 4, `expected >=4 try blocks for fault isolation, got ${tryBlocks}`);
});
