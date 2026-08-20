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

// ---------- Task 3: per-partner TCP port probes ----------

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

test('Get-PartnerPortSnapshot emits a per-partner row with the 16-column INSERT shape', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  // All 16 keys required by the row shape (see R1 in the SDD ledger).
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
    'LockedCount',
    'PartnerPortStatus'
  ];
  for (const k of required) {
    assert.match(body, new RegExp(`${k}\\s*=`),
      `expected ${k} field in the per-partner row hash`);
  }
});

test('Get-PartnerPortSnapshot naming context embeds the partner host (R2)', () => {
  const src = readFileSync(psPath, 'utf8');
  const fnMatch = src.match(/function\s+Get-PartnerPortSnapshot[\s\S]+?\n\}/);
  assert.ok(fnMatch, 'expected to find the Get-PartnerPortSnapshot function body');
  const body = fnMatch[0];
  assert.match(body, /NamingContext\s*=\s*"__partner_ports__:\$partnerHost"/,
    'expected R2 naming context "__partner_ports__:<partner>"');
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
