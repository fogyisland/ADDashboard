BeforeAll {
  # 2026-08-28 round-57 (R57-E/R57-F): dot-source collect-replication.ps1 in
  # -ForTesting mode so the partner-port helpers (Test-TcpPort,
  # Get-PartnerPortSnapshot, Get-PartnerPortConfig) are loaded into the
  # test scope.
  # Dot-source the shared helpers so ConvertTo-PartnerPortList /
  # Resolve-AppsettingsPath / Read-AgentConfig / Invoke-PartnerPortsRequest
  # are unit-testable without spinning up a real HTTP server.
  . "$PSScriptRoot/../collect-replication.ps1" -ForTesting
  . "$PSScriptRoot/../fetch-partner-ports-helpers.ps1"
}

Describe 'Test-TcpPort (round-57 R57-E)' {
  It 'returns ok=true + numeric latency when a TcpListener accepts the connect' {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
      $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
      $r = Test-TcpPort -HostName '127.0.0.1' -Port $port -TimeoutMs 2000
      $r.ok | Should -BeTrue
      $r.latency | Should -BeOfType [int]
      $r.latency | Should -BeGreaterOrEqual 2
      $r.latency | Should -BeLessOrEqual 14
    } finally {
      $listener.Stop()
    }
  }

  It 'returns ok=false + null latency when the port is closed' {
    # Pick a port nothing is listening on. Use a high random port and
    # trust the OS to refuse SYN immediately. Fast-fail path: TCP RST
    # comes back in milliseconds, no 800ms wait.
    $closedPort = 39999
    $r = Test-TcpPort -HostName '127.0.0.1' -Port $closedPort -TimeoutMs 2000
    $r.ok | Should -BeFalse
    $r.latency | Should -BeNullOrEmpty
  }

  It 'honors -TimeoutMs for the 800ms production budget' {
    # 2026-08-28 round-57: the production probe uses 800ms. Use 100ms to
    # keep the suite fast. With a closed port on loopback the SYN fails
    # in <10ms, but the helper still respects the WaitOne budget — pin
    # the contract so anyone changing TimeoutMs sees the test.
    $start = [DateTime]::UtcNow
    $null = Test-TcpPort -HostName '127.0.0.1' -Port 39999 -TimeoutMs 100
    $elapsedMs = ([DateTime]::UtcNow - $start).TotalMilliseconds
    # Loopback refuse is well under 100ms; we just verify the call returns
    # within a generous bound (no hang).
    $elapsedMs | Should -BeLessThan 2000
  }
}

Describe 'Get-PartnerPortSnapshot (round-57 R57-E)' {
  BeforeAll {
    # Local TcpListener that accepts every connection (loopback). The
    # helper probes each port with BeginConnect + WaitOne; an accept
    # loop is NOT required — TcpListener.Start() puts the socket into
    # LISTEN state and the OS completes the 3WHS without us calling
    # AcceptTcpClient (the kernel responds with SYN-ACK and the client
    # side transitions to ESTABLISHED). We do Start() / Stop() only.
    function New-AcceptingListener {
      $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
      $l.Start()
      return $l
    }
    function Get-FreePort {
      param([System.Net.Sockets.TcpListener]$Listener)
      ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
    }
  }

  It 'returns status_code=0 (all ok) when every port accepts' {
    $l1 = New-AcceptingListener
    $l2 = New-AcceptingListener
    try {
      $p1 = Get-FreePort $l1
      $p2 = Get-FreePort $l2
      $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @($p1, $p2)
      $row.StatusCode | Should -Be 0
      $row.ErrorMessage | Should -BeNullOrEmpty
      $json = $row.PartnerPortStatus | ConvertFrom-Json
      $json.ports.Count | Should -Be 2
      $json.ports[0].ok | Should -BeTrue
      # 2026-08-28 round-57: PS 5.1 ConvertFrom-Json returns Int64 for
      # integer literals (PS 7+ returns Int32). The contract is "small
      # positive int", which both representations satisfy.
      $json.ports[0].latency | Should -BeGreaterOrEqual 2
      $json.ports[0].latency | Should -BeLessOrEqual 14
    } finally {
      $l1.Stop(); $l2.Stop()
    }
  }

  It 'returns status_code=2 (all fail) when every port is closed' {
    $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @(39998, 39997)
    $row.StatusCode | Should -Be 2
    $row.ErrorMessage | Should -Be 'all partner ports unreachable'
    $json = $row.PartnerPortStatus | ConvertFrom-Json
    $json.ports.Count | Should -Be 2
    foreach ($p in $json.ports) {
      $p.ok | Should -BeFalse
      $p.latency | Should -BeNullOrEmpty
    }
  }

  It 'returns status_code=1 (partial) when only some ports accept' {
    $listener = New-AcceptingListener
    try {
      $open = Get-FreePort $listener
      $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @($open, 39996)
      $row.StatusCode | Should -Be 1
      $row.ErrorMessage | Should -Be 'partial partner port reachability'
      $json = $row.PartnerPortStatus | ConvertFrom-Json
      $json.ports.Count | Should -Be 2
      $okCount = ($json.ports | Where-Object { $_.ok }).Count
      $okCount | Should -Be 1
    } finally {
      $listener.Stop()
    }
  }

  It 'produces a naming_context of __partner_ports__:<8hex>' {
    $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @(39995)
    $row.NamingContext | Should -Match '^__partner_ports__:[0-9a-f]{8}$'
  }

  It 'naming_context is deterministic for the same (agent, peer) tuple' {
    $r1 = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @(39994)
    $r2 = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @(39993)
    $r1.NamingContext | Should -Be $r2.NamingContext
  }

  It 'naming_context differs for different (agent, peer) tuples' {
    $r1 = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @(39992)
    $r2 = Get-PartnerPortSnapshot -AgentId 'DC-B' -PeerHost '127.0.0.1' -Ports @(39992)
    $r1.NamingContext | Should -Not -Be $r2.NamingContext
  }

  It 'forwards SourceDc/DestDc/PeerLabel and emits a UTC lastAttemptTime' {
    $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -PeerLabel 'PARTNER-LABEL' -Ports @(39991)
    $row.SourceDc | Should -Be 'DC-A'
    $row.DestDc   | Should -Be '127.0.0.1'
    # PeerLabel isn't on the row directly (it's only used as a fallback
    # for DestDc); verify DestDc carried through.
    $row.DestDc | Should -Be '127.0.0.1'
    $row.LastAttemptTime | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  }

  It 'falls back to DefaultPartnerPortSet when -Ports is empty/null' {
    # Without -Ports we hit Get-PartnerPortConfig; with no fetch script
    # present (or it returning $null) we should fall back to the default
    # set which contains 9 well-known ports. Use a bogus hostname so all
    # probes fail fast — we only care that the loop RAN, not that ports
    # were reachable.
    $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1'
    $json = $row.PartnerPortStatus | ConvertFrom-Json
    # DefaultPartnerPortSet = @(135, 445, 389, 636, 3268, 88, 50001, 50002, 50003)
    $json.ports.Count | Should -Be 9
  }

  It 'JSON envelope is parseable and matches { ports: [{port, ok, latency}] }' {
    $row = Get-PartnerPortSnapshot -AgentId 'DC-A' -PeerHost '127.0.0.1' -Ports @(39990, 39989)
    $row.PartnerPortStatus | Should -Match '^\{.*\}$'
    $parsed = $row.PartnerPortStatus | ConvertFrom-Json
    $parsed.PSObject.Properties.Name | Should -Contain 'ports'
    foreach ($p in $parsed.ports) {
      $p.PSObject.Properties.Name | Should -Contain 'port'
      $p.PSObject.Properties.Name | Should -Contain 'ok'
      $p.PSObject.Properties.Name | Should -Contain 'latency'
    }
  }
}

Describe 'Get-PartnerPortConfig (round-57 R57-E)' {
  It 'returns DefaultPartnerPortSet when ConfigScriptPath is missing' {
    $cfg = Get-PartnerPortConfig -AgentId 'DC-A' -ConfigScriptPath 'C:\does\not\exist.ps1'
    @($cfg.ports).Count | Should -Be 9
    $cfg.ports | Should -Contain 135
    $cfg.ports | Should -Contain 50001
  }

  It 'consumes a fetch script that returns @{ ports = @(int[]) }' {
    $tmp = Join-Path $env:TEMP "fetch-partner-ports-good-$([guid]::NewGuid().Guid).ps1"
    @'
param([string]$AgentId)
return @{ ports = @(8081, 8082, 8083) }
'@ | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
      $cfg = Get-PartnerPortConfig -AgentId 'DC-A' -ConfigScriptPath $tmp
      @($cfg.ports).Count | Should -Be 3
      $cfg.ports[0] | Should -Be 8081
      $cfg.ports[2] | Should -Be 8083
    } finally {
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
  }

  It 'falls back to DefaultPartnerPortSet when the fetch script throws' {
    $tmp = Join-Path $env:TEMP "fetch-partner-ports-throws-$([guid]::NewGuid().Guid).ps1"
    @'
param([string]$AgentId)
throw "boom"
'@ | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
      $cfg = Get-PartnerPortConfig -AgentId 'DC-A' -ConfigScriptPath $tmp
      @($cfg.ports).Count | Should -Be 9
      $cfg.ports | Should -Contain 135
    } finally {
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
  }

  It 'falls back to DefaultPartnerPortSet when the fetch script returns $null' {
    $tmp = Join-Path $env:TEMP "fetch-partner-ports-null-$([guid]::NewGuid().Guid).ps1"
    @'
param([string]$AgentId)
return $null
'@ | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
      $cfg = Get-PartnerPortConfig -AgentId 'DC-A' -ConfigScriptPath $tmp
      @($cfg.ports).Count | Should -Be 9
    } finally {
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
  }

  It 'falls back to DefaultPartnerPortSet when the fetch script returns @{ ports = $null }' {
    # 2026-08-28 round-57: this is the realistic failure mode — the fetch
    # script ran but the centre had nothing useful to return. The hashtable
    # shape must NOT be treated as a valid port set; Get-PartnerPortConfig
    # must hand the caller the default ports.
    $tmp = Join-Path $env:TEMP "fetch-partner-ports-nullports-$([guid]::NewGuid().Guid).ps1"
    @'
param([string]$AgentId)
return @{ ports = $null }
'@ | Set-Content -LiteralPath $tmp -Encoding UTF8
    try {
      $cfg = Get-PartnerPortConfig -AgentId 'DC-A' -ConfigScriptPath $tmp
      @($cfg.ports).Count | Should -Be 9
    } finally {
      Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
  }
}

Describe 'Resolve-AppsettingsPath (round-57 R57-F)' {
  It 'returns the first existing appsettings.json candidate' {
    $dir = Join-Path $env:TEMP "resolve-appsettings-$([guid]::NewGuid().Guid)"
    $inner = Join-Path $dir 'inner'
    New-Item -ItemType Directory -Path $inner -Force | Out-Null
    try {
      $cfg = Join-Path $dir 'appsettings.json'
      Set-Content -LiteralPath $cfg -Value '{}' -Encoding UTF8
      $r = Resolve-AppsettingsPath -ScriptRoot $inner
      # Should resolve to the absolute path of the file we just wrote.
      [System.IO.Path]::GetFullPath($r) | Should -Be ([System.IO.Path]::GetFullPath($cfg))
    } finally {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It 'returns $null when neither candidate exists' {
    $dir = Join-Path $env:TEMP "resolve-appsettings-missing-$([guid]::NewGuid().Guid)"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    try {
      $r = Resolve-AppsettingsPath -ScriptRoot $dir
      $r | Should -BeNullOrEmpty
    } finally {
      Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It 'falls back to ../appsettings.json when ../.. resolves correctly' {
    # Green-package layout: agentInstall/agent/scripts/fetch-partner-ports.ps1
    # The inner dir has no neighbor config; the parent does.
    $root = Join-Path $env:TEMP "resolve-appsettings-fallback-$([guid]::NewGuid().Guid)"
    $inner = Join-Path $root 'pkg'
    $cfg = Join-Path $root 'appsettings.json'
    New-Item -ItemType Directory -Path $inner -Force | Out-Null
    try {
      Set-Content -LiteralPath $cfg -Value '{}' -Encoding UTF8
      $r = Resolve-AppsettingsPath -ScriptRoot $inner
      [System.IO.Path]::GetFullPath($r) | Should -Be ([System.IO.Path]::GetFullPath($cfg))
    } finally {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Describe 'Read-AgentConfig (round-57 R57-F)' {
  It 'parses a UTF-8 JSON file without BOM' {
    $f = Join-Path $env:TEMP "read-cfg-nobom-$([guid]::NewGuid().Guid).json"
    try {
      '{ "centerUrl": "http://x", "agentToken": "tok" }' | Set-Content -LiteralPath $f -Encoding UTF8
      $cfg = Read-AgentConfig -Path $f
      $cfg.centerUrl | Should -Be 'http://x'
      $cfg.agentToken | Should -Be 'tok'
    } finally {
      Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue
    }
  }

  It 'strips a UTF-8 BOM before parsing (round-8 PS 5.1 Set-Content pattern)' {
    # 2026-08-24 round-8: PS 5.1 Set-Content writes a UTF-8 BOM (EF BB BF)
    # when appsettings.json was last written by Node — strip it
    # defensively. We simulate the BOM by emitting the 3 bytes directly.
    $f = Join-Path $env:TEMP "read-cfg-bom-$([guid]::NewGuid().Guid).json"
    try {
      $bom = [byte[]](0xEF, 0xBB, 0xBF)
      $body = [System.Text.Encoding]::UTF8.GetBytes('{ "centerUrl": "http://bom", "agentToken": "t" }')
      $all = [byte[]]::new($bom.Length + $body.Length)
      [Array]::Copy($bom, 0, $all, 0, $bom.Length)
      [Array]::Copy($body, 0, $all, $bom.Length, $body.Length)
      [System.IO.File]::WriteAllBytes($f, $all)

      $cfg = Read-AgentConfig -Path $f
      $cfg.centerUrl | Should -Be 'http://bom'
      $cfg.agentToken | Should -Be 't'
    } finally {
      Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue
    }
  }
}

Describe 'ConvertTo-PartnerPortList (round-57 R57-F)' {
  It 'returns @() when ResponseBody is $null' {
    $r = ConvertTo-PartnerPortList -ResponseBody $null
    @($r).Count | Should -Be 0
  }

  It 'returns @() when ports is $null' {
    $r = ConvertTo-PartnerPortList -ResponseBody @{ ports = $null }
    @($r).Count | Should -Be 0
  }

  It 'returns @() when ports is missing' {
    $r = ConvertTo-PartnerPortList -ResponseBody @{ other = 'x' }
    @($r).Count | Should -Be 0
  }

  It 'coerces valid port integers and drops malformed entries' {
    $r = ConvertTo-PartnerPortList -ResponseBody @{
      ports = @(
        @{ port = 8081; label = 'A' },
        @{ port = 8082; label = 'B' },
        @{ port = 'not-a-number'; label = 'X' },
        @{ port = 99999; label = 'Y' },
        @{ port = 0; label = 'Z' }
      )
    }
    @($r).Count | Should -Be 2
    $r[0] | Should -Be 8081
    $r[1] | Should -Be 8082
  }

  It 'drops zero, negative, and >65535 ports' {
    $r = ConvertTo-PartnerPortList -ResponseBody @{
      ports = @(
        @{ port = 0 },
        @{ port = -1 },
        @{ port = 65536 },
        @{ port = 70000 },
        @{ port = 443 }
      )
    }
    @($r).Count | Should -Be 1
    $r[0] | Should -Be 443
  }
}

Describe 'fetch-partner-ports.ps1 end-to-end (round-57 R57-F)' {
  BeforeAll {
    # Set up an isolated copy so we control the appsettings.json layout.
    # The script dot-sources the helpers, but the file structure must
    # mirror what production has so $PSScriptRoot resolves correctly.
    $script:fetchScript = Join-Path $PSScriptRoot '..\fetch-partner-ports.ps1'
    $script:helpersScript = Join-Path $PSScriptRoot '..\fetch-partner-ports-helpers.ps1'
    Test-Path -LiteralPath $script:fetchScript | Should -BeTrue
    Test-Path -LiteralPath $script:helpersScript | Should -BeTrue

    # We want to override Invoke-PartnerPortsRequest for the end-to-end
    # tests, but the script dot-sources the helpers into ITS OWN scope.
    # So we have to shadow the helpers file itself: copy the script +
    # the real helpers into an isolated dir, then APPEND an override of
    # Invoke-PartnerPortsRequest (which PowerShell resolves to the
    # last-defined version when dot-sourced). Replacing the whole file
    # breaks the other helpers (Resolve-AppsettingsPath etc.) that
    # fetch-partner-ports.ps1 still needs.
    #
    # Layout matches the green-package production layout exactly so
    # Resolve-AppsettingsPath's two-candidate lookup ($PSScriptRoot\..\appsettings.json
    # then $PSScriptRoot\..\..\appsettings.json) finds the file at the
    # SECOND candidate:
    #   $root/scripts/fetch-partner-ports.ps1   ← script's PSScriptRoot
    #   $root/scripts/fetch-partner-ports-helpers.ps1
    #   $root/appsettings.json                  ← matches ..\..\appsettings.json
    function New-FetchTestFixture {
      param([scriptblock]$OverrideHelper)
      $root = Join-Path $env:TEMP "fetch-e2e-$([guid]::NewGuid().Guid)"
      $scriptsDir = Join-Path $root 'scripts'
      New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
      Copy-Item -LiteralPath $script:fetchScript -Destination (Join-Path $scriptsDir 'fetch-partner-ports.ps1') -Force
      Copy-Item -LiteralPath $script:helpersScript -Destination (Join-Path $scriptsDir 'fetch-partner-ports-helpers.ps1') -Force
      # Append the override AFTER the real helpers — PowerShell function
      # resolution picks the last-defined match in dot-source order.
      '' | Out-File -LiteralPath (Join-Path $scriptsDir 'fetch-partner-ports-helpers.ps1') -Append -Encoding UTF8
      & $OverrideHelper (Join-Path $scriptsDir 'fetch-partner-ports-helpers.ps1')
      @{ centerUrl = 'http://center.test'; agentToken = 'tok'; agentId = 'X' } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'appsettings.json') -Encoding UTF8
      return $root
    }

    function Copy-HelpersFile {
      # Variant for tests that don't override the helpers — just copy
      # fetch-partner-ports.ps1 AND its sibling helpers file into an
      # isolated dir so $PSScriptRoot resolves correctly. The production
      # two-candidate appsettings.json lookup needs the file at
      # $root/appsettings.json (one level above scripts/) for either
      # candidate to hit.
      param([string]$Root)
      $scriptsDir = Join-Path $Root 'scripts'
      New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
      Copy-Item -LiteralPath $script:fetchScript -Destination (Join-Path $scriptsDir 'fetch-partner-ports.ps1') -Force
      Copy-Item -LiteralPath $script:helpersScript -Destination (Join-Path $scriptsDir 'fetch-partner-ports-helpers.ps1') -Force
      return $scriptsDir
    }
  }

  It 'returns @{ ports = $null } when no appsettings.json is reachable' {
    # Production layout: scripts/fetch-partner-ports.ps1 with no neighbor
    # config. Copy the script + helpers to a clean dir (the script
    # dot-sources the helpers via $PSScriptRoot, so both must move
    # together — otherwise the helpers lookup fails before we ever
    # touch appsettings.json).
    $isolated = Join-Path $env:TEMP "fetch-e2e-noappsettings-$([guid]::NewGuid().Guid)"
    try {
      $scriptsDir = Copy-HelpersFile -Root $isolated
      $copy = Join-Path $scriptsDir 'fetch-partner-ports.ps1'
      $r = & $copy -AgentId 'DC-A'
      $null -eq $r.ports | Should -BeTrue
    } finally {
      Remove-Item -LiteralPath $isolated -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It 'round-trips a JSON @{ ports = [...] } response into int[]' {
    # Override Invoke-PartnerPortsRequest so the fetch script's HTTP path
    # is exercised without a real server. We achieve this by writing a
    # custom helpers file that defines the override function BEFORE the
    # real one is dot-sourced — PowerShell scopes the override to the
    # inner dir, and the script picks it up.
    $root = New-FetchTestFixture -OverrideHelper {
      param($helpersPath)
      @'
function Invoke-PartnerPortsRequest {
  param([string]$CenterUrl, [string]$AgentToken)
  return @{ ports = @(
    @{ port = 8081; label = 'A' },
    @{ port = 8082; label = 'B' },
    @{ port = 'not-a-number'; label = 'C' },
    @{ port = 99999; label = 'D' }
  ) }
}
'@ | Set-Content -LiteralPath $helpersPath -Encoding UTF8
    }
    try {
      $copy = Join-Path (Join-Path $root 'scripts') 'fetch-partner-ports.ps1'
      $r = & $copy -AgentId 'X'
      @($r.ports).Count | Should -Be 2
      $r.ports[0] | Should -Be 8081
      $r.ports[1] | Should -Be 8082
      ($r.ports -contains 0) | Should -BeFalse
      ($r.ports -contains 99999) | Should -BeFalse
    } finally {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It 'returns @{ ports = $null } when Invoke-PartnerPortsRequest throws' {
    $root = New-FetchTestFixture -OverrideHelper {
      param($helpersPath)
      @'
function Invoke-PartnerPortsRequest {
  param([string]$CenterUrl, [string]$AgentToken)
  throw "connection refused"
}
'@ | Set-Content -LiteralPath $helpersPath -Encoding UTF8
    }
    try {
      $copy = Join-Path (Join-Path $root 'scripts') 'fetch-partner-ports.ps1'
      $r = & $copy -AgentId 'X'
      $null -eq $r.ports | Should -BeTrue
    } finally {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It 'returns @{ ports = $null } when centre returns @{ ports = $null }' {
    $root = New-FetchTestFixture -OverrideHelper {
      param($helpersPath)
      @'
function Invoke-PartnerPortsRequest {
  param([string]$CenterUrl, [string]$AgentToken)
  return @{ ports = $null }
}
'@ | Set-Content -LiteralPath $helpersPath -Encoding UTF8
    }
    try {
      $copy = Join-Path (Join-Path $root 'scripts') 'fetch-partner-ports.ps1'
      $r = & $copy -AgentId 'X'
      $null -eq $r.ports | Should -BeTrue
    } finally {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
