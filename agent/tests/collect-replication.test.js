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

// ---------- Task 3: per-partner TCP port probes ----------

test('collect-replication.ps1 declares a Get-PartnerNamingContext function (I-5)', () => {
  // I-5 fix: naming_context VARCHAR(256) overflow protection. The
  // helper truncates the host to 64 chars + 4-byte SHA-256 hex suffix
  // + 17-char `__partner_ports__:` prefix → at most 89 chars, safely
  // under 256. Pester tests in scripts/tests/cover the truncation
  // rules; this assertion pins the helper exists and is wired in.
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /function\s+Get-PartnerNamingContext\b/,
    'expected Get-PartnerNamingContext function definition');
  // Wired at the row-emission site (not a dead helper).
  assert.match(src, /NamingContext\s*=\s*Get-PartnerNamingContext/i,
    'NamingContext assignment must call the sanitizer');
  // Guard against the old interpolation literal sneaking back in.
  assert.doesNotMatch(src, /NamingContext\s*=\s*"__partner_ports__:\$partnerHost"/,
    'raw `__partner_ports__:$partnerHost` interpolation must not exist after I-5 fix');
});

test('collect-replication.ps1 declares a Get-PartnerPortSnapshot function', () => {
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /function\s+Get-PartnerPortSnapshot\b/,
    'expected Get-PartnerPortSnapshot function definition');
});

test('Get-PartnerPortSnapshot accepts ComputerName + Partners and defaults PerProbeTimeoutMs=1500 / MaxPartners=25', () => {
  const src = readFileSync(psPath, 'utf8');
  // Required parameter keys must exist (case-insensitive — PowerShell is).
  assert.match(src, /\[Parameter\(Mandatory\s*=\s*\$true\)\]\s*\[\s*string\s*\]\s*\$ComputerName/);
  // Partners is mandatory but untyped (so $null can be passed); we accept
  // either a typed or just-decorator approach in the regex.
  assert.match(src, /\[Parameter\(Mandatory\s*=\s*\$true\)\][\s\S]{0,80}\$Partners/);
  assert.match(src, /\$PerProbeTimeoutMs\s*=\s*1500/);
  assert.match(src, /\$MaxPartners\s*=\s*25/);
});

test('Get-PartnerPortSnapshot default port set is [135, 445, 50001, 50002, 50003]', () => {
  const src = readFileSync(psPath, 'utf8');
  assert.match(src, /\$script:DefaultPartnerPortSet\s*=\s*@\(\s*135\s*,\s*445\s*,\s*50001\s*,\s*50002\s*,\s*50003\s*\)/,
    'expected the 5-port set exactly');
  // The function's $Ports param must default to that script-scope value.
  assert.match(src, /\[int\[\]\]\s*\$Ports\s*=\s*\$script:DefaultPartnerPortSet/);
});

test('Get-PartnerPortSnapshot wraps each TcpClient probe in try/catch/finally and Close() in finally', () => {
  const src = readFileSync(psPath, 'utf8');
  // Isolate the function body so we don't grep against other blocks.
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // ConnectAsync + Wait(PerProbeTimeoutMs) + the stopwatch.
  assert.match(body, /ConnectAsync\(\s*\$partnerHost\s*,\s*\[int\]\$port\s*\)/);
  assert.match(body, /\$connectTask\.Wait\(\s*\$PerProbeTimeoutMs\s*\)/);
  assert.match(body, /\[System\.Diagnostics\.Stopwatch\]::StartNew\(\)/);
  // try/catch/finally trio.
  assert.match(body, /\btry\s*\{/);
  assert.match(body, /\}\s*catch\s*\{/);
  assert.match(body, /\}\s*finally\s*\{/);
  // finally must Close the socket.
  assert.match(body, /finally\s*\{[\s\S]*?\$client\.Close\(\)[\s\S]*?\}/);
});

test('Get-PartnerPortSnapshot skips self-loop (partnerHost == ComputerName)', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  assert.match(body, /if\s*\(\s*\$partnerHost\s*-eq\s*\$ComputerName\s*\)\s*\{\s*continue\s*\}/,
    'expected self-loop guard');
});

test('Get-PartnerPortSnapshot caps the partner list at MaxPartners via Select-Object -First', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  assert.match(body, /\$Partners\s*\|\s*Select-Object\s+-First\s+\$MaxPartners/,
    'expected Partners | Select-Object -First $MaxPartners cap');
});

test('Get-PartnerPortSnapshot emits a per-partner row with the 15-column INSERT shape (round-18: no LockedCount)', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // 2026-08-26 round-18: LockedCount dropped from the per-partner row.
  // Lockout data ships on its own 15-minute cadence via the
  // ad_lockout_summary package. Replication rows are now 15 columns:
  // (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
  //  naming_context, last_success_time, last_attempt_time, status_code,
  //  error_message, users_count, groups_count, gpos_count, partner_port_status)
  const required = [
    'CollectedAt',
    'AgentId',
    'SourceDc',
    'DestDc',
    'SourceSite',
    'DestSite',
    'NamingContext',
    'LastSuccessTime',
    'LastAttemptTime',
    'StatusCode',
    'ErrorMessage',
    'UsersCount',
    'GroupsCount',
    'GposCount',
    'PartnerPortStatus'
  ];
  for (const k of required) {
    assert.match(body, new RegExp(`${k}\\s*=`),
      `expected ${k} field in the per-partner row hash`);
  }
  // Defense against round-18 regression: LockedCount must NOT be in the
  // per-partner row any more — it belongs to ad_lockout_summary.
  assert.ok(!/\bLockedCount\s*=/.test(body),
    'LockedCount must be removed from Get-PartnerPortSnapshot (round-18 split)');
});

test('Get-PartnerPortSnapshot naming context embeds the partner host (R2)', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // I-5: naming context is built via the Get-PartnerNamingContext sanitizer
  // (truncate to 64 chars + 4-byte SHA-256 hex suffix), not raw
  // `"__partner_ports__:$partnerHost"` interpolation. Pin the helper is
  // wired in — the actual truncation logic is tested in the Pester
  // suite (scripts/tests/collect-replication.test.ps1).
  assert.match(body, /NamingContext\s*=\s*Get-PartnerNamingContext/i,
    'expected NamingContext to be set via Get-PartnerNamingContext helper');
});

test('Get-PartnerPortSnapshot partner_port_status JSON includes checked_at + per-port reachable/latency/error', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // The payload should embed `checked_at` + `ports` map keyed by port number.
  assert.match(body, /checked_at\s*=\s*\$nowIso/);
  assert.match(body, /ports\s*=\s*\$portMap/);
  // Port map values are hashtables with reachable / latencyMs / error.
  assert.match(body, /portMap\[\[string\]\$r\.port\]\s*=\s*@\{[\s\S]*?reachable\s*=\s*\$r\.reachable/);
  assert.match(body, /latencyMs\s*=\s*\$r\.latencyMs/);
  assert.match(body, /error\s*=\s*\$r\.error/);
});

test('Get-ReplicationSnapshot invokes Get-PartnerPortSnapshot with the partner list', () => {
  const src = readFileSync(psPath, 'utf8');
  // The call must be inside Get-ReplicationSnapshot and forward $partners
  // (the local list from Get-ADReplicationPartnerMetadata).
  assert.match(src, /Get-PartnerPortSnapshot\s+`?\s*\n?\s*-ComputerName\s+\$ComputerName/);
  // Must pass the partner list through to Get-PartnerPortSnapshot.
  const snippetMatches = src.match(/Get-PartnerPortSnapshot[\s\S]{0,400}?\}/);
  assert.ok(snippetMatches, 'expected to find Get-PartnerPortSnapshot invocation');
  const snippet = snippetMatches[0];
  assert.match(snippet, /-Partners\s+\$partners/);
  // Forward $snapshot.Site so per-partner rows carry the local site's site name.
  assert.match(snippet, /-Site\s+\$snapshot\.Site/);
});

// ---------- Task 3 fix round 2: CollectedAt forwarded to partner-port row ----------

test('Get-PartnerPortSnapshot declares an optional -CollectedAt parameter (mirror the -Site pattern)', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // Must declare a [string] [AllowNull()] $CollectedAt = $null parameter, matching
  // the [AllowNull()] [string] $Site pattern above it.
  assert.match(body, /\[Parameter\(\)\][\s\S]{0,60}\[AllowNull\(\)\][\s\S]{0,40}\[string\]\s*\$CollectedAt\s*=\s*\$null/,
    'expected -CollectedAt parameter declared with [Parameter()] [AllowNull()] [string] $CollectedAt = $null');
});

test('partner-port LastSuccessTime/LastAttemptTime default to $nowIso when -CollectedAt is omitted (back-compat)', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // When the caller doesn't pass -CollectedAt (e.g. a test or older invoker),
  // the row must still get a timestamp — falling back to $nowIso is the
  // back-compat contract (otherwise existing tests / one-off callers break).
  // We check that the LAST two assignments in the row use the
  // `$(if ($CollectedAt) { $CollectedAt } else { $nowIso })` form, which
  // collapses to $nowIso whenever $CollectedAt is $null/empty.
  assert.match(body, /LastSuccessTime\s*=\s*\$\(if\s*\(\s*\$CollectedAt\s*\)\s*\{\s*\$CollectedAt\s*\}\s*else\s*\{\s*\$nowIso\s*\}\s*\)/,
    'expected LastSuccessTime to fall back to $nowIso when $CollectedAt is not provided');
  assert.match(body, /LastAttemptTime\s*=\s*\$\(if\s*\(\s*\$CollectedAt\s*\)\s*\{\s*\$CollectedAt\s*\}\s*else\s*\{\s*\$nowIso\s*\}\s*\)/,
    'expected LastAttemptTime to fall back to $nowIso when $CollectedAt is not provided');
});

test('Get-ReplicationSnapshot passes -CollectedAt $snapshot.CollectedAt to Get-PartnerPortSnapshot', () => {
  const src = readFileSync(psPath, 'utf8');
  // The fix-round-2 ruling: brief specified $snapshot.CollectedAt for the
  // partner-port row's last_success_time / last_attempt_time. The call site
  // must forward $snapshot.CollectedAt to Get-PartnerPortSnapshot so the row
  // gets the snapshot's timestamp instead of a fresh $nowIso captured inside
  // the function (which would drift by microseconds and break brief-adherence).
  const snippetMatches = src.match(/Get-PartnerPortSnapshot[\s\S]{0,400}?\}/);
  assert.ok(snippetMatches, 'expected to find Get-PartnerPortSnapshot invocation');
  const snippet = snippetMatches[0];
  assert.match(snippet, /-CollectedAt\s+\$snapshot\.CollectedAt/,
    'expected call site to forward -CollectedAt $snapshot.CollectedAt');
});
