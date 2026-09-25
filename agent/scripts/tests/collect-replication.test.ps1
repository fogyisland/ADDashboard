BeforeAll {
  . "$PSScriptRoot/../collect-replication.ps1" -ForTesting
  # 2026-10-?? R93.6: PS 5.1 forbids both `$script:` and `$Global:`
  # qualifiers inside a dot-sourced .ps1 file (parser only accepts them
  # in module scope). Park shared state at the host scope via
  # Set-Variable -Scope Global, then have the mocks read it back with
  # Get-Variable -Scope Global. BeforeEach below resets to a clean
  # default so one Describe's leftovers never bleed into the next.
  Set-Variable -Name 'R93.6SourceSite'    -Value 'Default-Site' -Scope Global
  Set-Variable -Name 'R93.6PartnerInputs' -Value @()            -Scope Global
}

Describe 'Get-ReplicationSnapshot' {
  It 'returns CollectedAt in UTC ISO 8601' {
    $s = Get-ReplicationSnapshot -ComputerName $env:COMPUTERNAME
    $s.CollectedAt | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$'
  }

  It 'returns AgentId matching the local hostname' {
    $s = Get-ReplicationSnapshot -ComputerName $env:COMPUTERNAME
    $s.AgentId | Should -Be $env:COMPUTERNAME
  }

  It 'returns a snapshot object with required properties' {
    $s = Get-ReplicationSnapshot -ComputerName 'TEST-DC'
    $s.PSObject.Properties.Name | Should -Contain 'CollectedAt'
    $s.PSObject.Properties.Name | Should -Contain 'AgentId'
    $s.PSObject.Properties.Name | Should -Contain 'Site'
    $s.PSObject.Properties.Name | Should -Contain 'Entries'
  }
}

Describe 'ConvertTo-UtcIso' {
  It 'returns $null for $null input' {
    ConvertTo-UtcIso -Value $null | Should -BeNullOrEmpty
  }

  It 'converts a DateTime to UTC ISO 8601' {
    $dt = [DateTime]'2026-07-11T10:00:00'
    ConvertTo-UtcIso -Value $dt | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$'
  }

  It 'parses a parseable string into UTC ISO 8601' {
    $s = '2026-07-11T10:00:00'
    ConvertTo-UtcIso -Value $s | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$'
  }
}

Describe 'ConvertTo-SnapshotJson' {
  It 'produces compressed JSON for a snapshot' {
    $s = Get-ReplicationSnapshot -ComputerName 'TEST-DC'
    $json = ConvertTo-SnapshotJson -Snapshot $s
    $json | Should -Match '"CollectedAt"'
    $json | Should -Match '"AgentId":"TEST-DC"'
  }
}

Describe 'BuildReplicationHistoryRows (round-42 复制日志监控)' {
  BeforeAll {
    # Build a minimal ADReplicationPartnerMetadata-like object with a
    # PSObject.Add-Member trick so PSObject.Properties['_ResultHistory']
    # resolves correctly — see collect-replication.ps1
    # ::BuildReplicationHistoryRows which reads via that path.
    function New-StubPartner {
      param(
        [string]$Partner,
        [string]$NamingContext,
        [object[]]$ResultHistory = @()
      )
      $obj = [PSCustomObject]@{ Partner = $Partner; NamingContext = $NamingContext }
      if ($ResultHistory.Count -gt 0) {
        $obj | Add-Member -NotePropertyName _ResultHistory -NotePropertyValue $ResultHistory
      }
      return $obj
    }

    function New-StubOp {
      param(
        [int]$Status,
        [int]$Error,
        [datetime]$Time,
        [int]$AttemptNumber = 0
      )
      [PSCustomObject]@{
        Status = $Status
        Error = $Error
        Time = $Time
        AttemptNumber = $AttemptNumber
      }
    }
  }

  It 'returns empty array for null Partner (defensive)' {
    $r = BuildReplicationHistoryRows -Partner $null -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com'
    @($r).Count | Should -Be 0
  }

  It 'returns empty array when partner lacks _ResultHistory (older AD module)' {
    # No Add-Member → _ResultHistory not present
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com'
    $r = BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com'
    @($r).Count | Should -Be 0
  }

  It 'returns empty array when _ResultHistory is empty' {
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @()
    $r = BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com'
    @($r).Count | Should -Be 0
  }

  It 'emits one row per _ResultHistory operation' {
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @(
      (New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z')),
      (New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:05:00Z')),
      (New-StubOp -Status 2 -Error 1908 -Time ([datetime]'2026-08-27T10:10:00Z'))
    )
    $r = BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com'
    @($r).Count | Should -Be 3
  }

  It 'success row: StatusCode=0, ErrorMessage=$null, both timestamps set' {
    $op = New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z') -AttemptNumber 7
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @($op)
    $r = @(BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r.Count | Should -Be 1
    $r[0].StatusCode       | Should -Be 0
    $r[0].ErrorMessage     | Should -BeNullOrEmpty
    $r[0].LastSuccessTime  | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
    $r[0].LastAttemptTime  | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
    # counter columns stay null on history rows (round-45: PartnerPortStatus gone)
    $r[0].UsersCount       | Should -BeNullOrEmpty
    $r[0].AttemptDurationMs | Should -BeNullOrEmpty
    $r[0].ObjectsTransferred | Should -BeNullOrEmpty
  }

  It 'failure row: StatusCode!=0, ErrorMessage="error <code>", LastSuccessTime=$null' {
    $op = New-StubOp -Status 2 -Error 1908 -Time ([datetime]'2026-08-27T10:10:00Z') -AttemptNumber 42
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @($op)
    $r = @(BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r[0].StatusCode      | Should -Be 2
    $r[0].ErrorMessage    | Should -Be 'error 1908'
    $r[0].LastSuccessTime | Should -BeNullOrEmpty
    $r[0].LastAttemptTime | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
  }

  It 'naming_context is "__history__:<hash>" synthetic prefix' {
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @(
      (New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z'))
    )
    $r = @(BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r[0].NamingContext | Should -Match '^__history__:[0-9a-f]{8}$'
  }

  It 'RealNamingContext carries the link NC so centre can rebind after strip' {
    $linkNc = 'CN=Configuration,DC=contoso,DC=com'
    $p = New-StubPartner -Partner 'DC-B' -NamingContext $linkNc -ResultHistory @(
      (New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z'))
    )
    $r = @(BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext $linkNc)
    $r[0].RealNamingContext | Should -Be $linkNc
  }

  It 'SourceDc/DestDc match the link direction (us → peer)' {
    $p = New-StubPartner -Partner 'DC-BJ-02.contoso.com' -NamingContext 'DC=contoso,DC=com' -ResultHistory @(
      (New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z'))
    )
    $r = @(BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-BJ-01' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r[0].SourceDc | Should -Be 'DC-BJ-01'
    $r[0].DestDc   | Should -Be 'DC-BJ-02.contoso.com'
    $r[0].SourceSite | Should -Be 'BJ'
  }

  It 'caps rows at MaxAttempts (default 10)' {
    $ops = @(1..15 | ForEach-Object {
      New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z').AddMinutes($_)
    })
    $p = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory $ops
    $r = @(BuildReplicationHistoryRows -Partner $p -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r.Count | Should -Be 10
  }

  It 'history naming_context hash is deterministic for the same input' {
    $op = New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z') -AttemptNumber 3
    $p1 = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @($op)
    $p2 = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @($op)
    $r1 = @(BuildReplicationHistoryRows -Partner $p1 -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r2 = @(BuildReplicationHistoryRows -Partner $p2 -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r1[0].NamingContext | Should -Be $r2[0].NamingContext
  }

  It 'history naming_context hash differs across distinct naming_contexts' {
    $op = New-StubOp -Status 0 -Error 0 -Time ([datetime]'2026-08-27T10:00:00Z') -AttemptNumber 1
    $p1 = New-StubPartner -Partner 'DC-B' -NamingContext 'DC=contoso,DC=com' -ResultHistory @($op)
    $p2 = New-StubPartner -Partner 'DC-B' -NamingContext 'CN=Configuration,DC=contoso,DC=com' -ResultHistory @($op)
    $r1 = @(BuildReplicationHistoryRows -Partner $p1 -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'DC=contoso,DC=com')
    $r2 = @(BuildReplicationHistoryRows -Partner $p2 -ComputerName 'DC-A' -Site 'BJ' -RealNamingContext 'CN=Configuration,DC=contoso,DC=com')
    $r1[0].NamingContext | Should -Not -Be $r2[0].NamingContext
  }
}

Describe 'Get-ReplicationSnapshot partner entry (R93.6 复制伙伴可见性)' {
  BeforeAll {
    # 2026-10-?? R93.6: PS 5.1 Pester 6 — `Mock -CommandName` cannot mock
    # cmdlets that aren't loaded on the test machine (no ActiveDirectory
    # module on dev boxes). We register shims via Set-Item on the
    # Function: PSDrive so the dot-sourced script under test resolves
    # them via the SessionState's function lookup chain. This is the
    # only Pester-6-on-PS5.1-compatible way to swap out calls to cmdlets
    # that may be absent from the runtime — Mock WithModuleViaReflection
    # would also work but requires the cmdlet to exist on disk.
    #
    # Also mocks Get-Module so the ActiveDirectory-availability
    # precondition at collect-replication.ps1:549 passes. Without this,
    # the script throws "ActiveDirectory module not available" and emits
    # a META entry — the partner mock below never fires.
    Set-Item -Path 'Function:Get-ADReplicationPartnerMetadata' -Value {
      param([string]$Target)
      $inputs = Get-Variable -Name 'R93.6PartnerInputs' -Scope Global -ErrorAction SilentlyContinue
      if ($null -eq $inputs) { return @() }
      return ,$inputs.Value
    }
    Set-Item -Path 'Function:Get-ADDomainController' -Value {
      param([string]$Identity, [string]$Filter)
      $site = Get-Variable -Name 'R93.6SourceSite' -Scope Global -ErrorAction SilentlyContinue
      $siteValue = $null
      if ($null -ne $site) { $siteValue = $site.Value }
      return [PSCustomObject]@{ SiteObjectName = $siteValue; HostName = $Identity }
    }
    Set-Item -Path 'Function:Get-Module' -Value {
      param([string]$Name, [switch]$ListAvailable)
      return [PSCustomObject]@{ Name = $Name; Version = [Version]'1.0.0' }
    }

    function New-StubLinkPartner {
      param(
        [string]$Partner,
        [string]$PartnerSiteName = '',
        [string]$NamingContext = 'DC=contoso,DC=com',
        [int]$LastReplicationResult = 0
      )
      [PSCustomObject]@{
        Partner                = $Partner
        PartnerSiteName        = $PartnerSiteName
        NamingContext          = $NamingContext
        LastReplicationResult  = $LastReplicationResult
        LastReplicationSuccess = (Get-Date).ToUniversalTime().AddMinutes(-1)
        LastReplicationAttempt = (Get-Date).ToUniversalTime()
      }
    }
  }

  BeforeEach {
    Set-Variable -Name 'R93.6SourceSite'    -Value 'Default-Site' -Scope Global
    Set-Variable -Name 'R93.6PartnerInputs' -Value @()            -Scope Global
  }

  It 'DestSite is populated from PartnerSiteName when AD module exposes it' {
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -PartnerSiteName 'BJ' -NamingContext 'DC=contoso,DC=com')
    ) -Scope Global
    $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    $snap.Entries[0].DestSite | Should -Be 'BJ'
  }

  It 'DestSite falls back to $null when PartnerSiteName is empty AND source site is unknown' {
    Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
    ) -Scope Global
    $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    $snap.Entries[0].DestSite | Should -BeNullOrEmpty
  }

  It 'DestSite falls back to source site when partner has no site link bridge' {
    Set-Variable -Name 'R93.6SourceSite' -Value 'BJ' -Scope Global
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
    ) -Scope Global
    $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    # Co-located partner — bucket under source site so the row has a
    # non-empty label for siteMatrix grouping.
    $snap.Entries[0].DestSite | Should -Be 'BJ'
  }

  It 'NamingContext is replaced with __partner_naming__:<sha> when AD reports empty' {
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -NamingContext '')
    ) -Scope Global
    $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    $snap.Entries[0].NamingContext | Should -Match '^__partner_naming__:[0-9a-f]{8}$'
  }

  It 'NamingContext preserves the AD-reported DN when present (no fallback)' {
    $nc = 'CN=Configuration,DC=contoso,DC=com'
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -NamingContext $nc)
    ) -Scope Global
    $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    $snap.Entries[0].NamingContext | Should -Be $nc
  }

  It '__partner_naming__:<sha> is deterministic per (sourceDc, partner, idx) tuple' {
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -NamingContext ''),
      (New-StubLinkPartner -Partner 'DC-BJ-03.contoso.com' -NamingContext '')
    ) -Scope Global
    $snap1 = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    $snap2 = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    # Two distinct partners → two distinct hashes (UNIQUE KEY on
    # (source_dc, dest_dc, naming_context) must not collide).
    $snap1.Entries[0].NamingContext | Should -Not -Be $snap1.Entries[1].NamingContext
    # And the hash is deterministic across invocations.
    $snap2.Entries[0].NamingContext | Should -Be $snap1.Entries[0].NamingContext
    $snap2.Entries[1].NamingContext | Should -Be $snap1.Entries[1].NamingContext
  }
}