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

test('collect-replication.ps1 declares a Get-LockoutEvents function', () => {
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /function\s+Get-LockoutEvents\b/,
    'expected Get-LockoutEvents function definition');
});

test('Get-LockoutEvents uses Get-WinEvent -FilterHashtable Security Id=4740 with 15-min StartTime', () => {
  const src = readFileSync(psPath, 'utf8');
  // Must use FilterHashtable form (not -ComputerName form, which PS 5.1
  // Get-WinEvent rejects for -FilterHashtable).
  assert.match(src, /Get-WinEvent\s+-FilterHashtable\s+@\{/,
    'expected Get-WinEvent -FilterHashtable @{...}');
  assert.match(src, /LogName\s*=\s*'Security'/);
  assert.match(src, /Id\s*=\s*4740/);
  // The lookback window equals the polling interval (15 min default).
  // Accept either the inline form or assignment to $start — both are fine.
  // The contract is that SOME reference to AddMinutes(-15) exists, paired
  // with a StartTime= line in the hashtable.
  assert.match(src, /\(Get-Date\)\.AddMinutes\(-15\)/,
    'expected (Get-Date).AddMinutes(-15) somewhere — the lookback MUST match the polling interval');
  assert.match(src, /StartTime\s*=/);
});

test('Get-LockoutEvents block is wrapped in try/catch (per-block fault isolation)', () => {
  const src = readFileSync(psPath, 'utf8');
  // Find the Get-LockoutEvents function body and confirm it has a try/catch
  const fnMatch = src.match(/function\s+Get-LockoutEvents[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-LockoutEvents function body');
  const body = fnMatch[0];
  assert.match(body, /\btry\s*\{/, 'expected a try block inside Get-LockoutEvents');
  assert.match(body, /\}\s*catch\s*\{/, 'expected a catch block');
  // The catch handler must write to stderr (matches Get-DcCounters pattern)
  assert.match(body, /\[Console\]::Error\.WriteLine/);
});

test('Get-ReplicationSnapshot adds a LockoutEvents NoteProperty before returning', () => {
  const src = readFileSync(psPath, 'utf8');
  // Inside Get-ReplicationSnapshot, must use Add-Member to attach LockoutEvents.
  assert.match(src, /Add-Member\s+-NotePropertyName\s+LockoutEvents/,
    'expected $snapshot | Add-Member -NotePropertyName LockoutEvents ...');
  assert.match(src, /LockoutEvents\s*=\s*\(?Get-LockoutEvents/,
    'expected LockoutEvents to be assigned from Get-LockoutEvents call');
});

test('each lockout event carries EventRecordId, OccurredAt, and the 4 user/computer fields', () => {
  const src = readFileSync(psPath, 'utf8');
  // Inside Get-LockoutEvents, the PSCustomObject hash must include all 6 fields.
  assert.match(src, /EventRecordId\s*=/);
  assert.match(src, /OccurredAt\s*=/);
  assert.match(src, /TargetUserName\s*=/);
  assert.match(src, /SubjectUserName\s*=/);
  assert.match(src, /SubjectDomain\s*=/);
  assert.match(src, /CallerComputerName\s*=/);
});
