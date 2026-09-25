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

  # 2026-09-25 R93.6.1 followup: New-StubLinkPartner is shared between the
  # R93.6 partner-entry Describe and the new self-site recovery Describe.
  # Pester 6 + PS 5.1 BeforeAll scope is per-Describe, so the helper was
  # previously invisible outside its host Describe. Hoisting it here at
  # the file-level BeforeAll makes it visible to every Describe in this
  # file.
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

  # 2026-09-25 R93.6.1 followup: hoist the AD cmdlet shims to file-level
  # BeforeAll so every Describe in this file can use them. Pester 6 +
  # PS 5.1 BeforeAll scope is per-Describe, so the shims that were
  # previously installed inside the R93.6 partner-entry Describe were
  # invisible to the new self-site recovery Describe — its mocks
  # silently fell through to the real (absent) cmdlets, which threw
  # "ActiveDirectory module not available" and emitted a META entry
  # before reaching the recovery block.
  #
  # Pattern (matches R93.6 shim — same Set-Item Function: trick):
  #   Get-ADReplicationPartnerMetadata reads R93.6PartnerInputs
  #   Get-ADDomainController reads R93.6SourceSite
  #   Get-Module always returns 1.0.0 so the AD-availability guard
  #     precondition at collect-replication.ps1:549 passes
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
    # 2026-09-25 R93.6.1: shims (Get-ADReplicationPartnerMetadata,
    # Get-ADDomainController, Get-Module) are hoisted to the file-level
    # BeforeAll so the R93.6.1 self-site recovery Describe below can
    # use them too. PS 5.1 + Pester 6 BeforeAll scope is per-Describe,
    # so any shim installed here would be invisible outside this
    # Describe. See file-level BeforeAll for the actual Set-Item
    # registration.
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

  It 'DestSite falls back to $null when PartnerSiteName is empty AND source site is unknown AND DN has no site (R93.6.1 contract: defensive null)' {
    Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
    Set-Variable -Name 'R93.6PartnerInputs' -Value @(
      (New-StubLinkPartner -Partner 'DC-BJ-02.contoso.com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
    ) -Scope Global
    $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
    # DN shape is just a hostname here, not the canonical CN=Servers,CN=<Site>,CN=Sites
    # shape — Tier 3 has nothing to extract, so the row lands as $null. Centre's
    # siteMatrix double guard will filter it out, but the row is still emitted
    # for audit and other downstream consumers that don't gate on site.
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

  # 2026-09-25 R93.6.1 (复制状态概览 partner visibility followup):
  # KDLFLOFADSRV2 R93.6 推送后 operator 报复制状态概览仍然没有复制伙伴。
  # R93.6 siteMatrix 双 guard `IS NOT NULL AND <> ''` 把空字符串过滤掉,
  # 所以 siteMatrix 返回 0 行, UI 空白。
  #
  # R93.6 fallback 链只覆盖两条: PartnerSiteName (AD module) + $snapshot.Site
  # (collector -Site 参数 / AD site lookup). 两条都 $null 时 destSite 留空。
  # R93.6.1 加 Tier 3: 用 regex `(?i)CN=Servers,CN=([^,]+),CN=Sites` 从
  # sourceDc DN 抽 site name (e.g., KDL-BeiJing, KDL-ShangHaiCheDun).
  Describe 'Get-ReplicationSnapshot partner entry (R93.6.1 DN site parse)' {

    It 'Tier 1 wins: PartnerSiteName trumps DN parse and source site' {
      Set-Variable -Name 'R93.6SourceSite' -Value 'Source-Site' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=DC-BJ-02,CN=Servers,CN=KDL-BeiJing,CN=Sites,DC=contoso,DC=com' -PartnerSiteName 'AD-Module-Site' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Entries[0].DestSite | Should -Be 'AD-Module-Site'
    }

    It 'Tier 2 wins: $snapshot.Site trumps DN parse when PartnerSiteName is empty' {
      Set-Variable -Name 'R93.6SourceSite' -Value 'Source-Site' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=DC-BJ-02,CN=Servers,CN=KDL-BeiJing,CN=Sites,DC=contoso,DC=com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Entries[0].DestSite | Should -Be 'Source-Site'
    }

    It 'Tier 3 wins: DN parse when PartnerSiteName empty AND source site null (KDLFLOFADSRV2 case)' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Entries[0].DestSite | Should -Be 'KDL-BeiJing'
    }

    It 'Tier 3 also populates SourceSite when source site unknown (R93.6.1 followup)' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-ShangHaiCheDun,CN=Sites,CN=Configuration,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      # SourceSite falls back to the same DN parse so siteMatrix's source_site
      # half of the double guard doesn't filter the row out.
      $snap.Entries[0].SourceSite | Should -Be 'KDL-ShangHaiCheDun'
      $snap.Entries[0].DestSite   | Should -Be 'KDL-ShangHaiCheDun'
    }

    It 'Tier 3 returns $null when DN does not match canonical CN=Servers,CN=*,CN=Sites shape' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        # Bare hostname with no DN markers — extract helper's regex misses,
        # destSite stays $null as defensive contract.
        (New-StubLinkPartner -Partner 'rogue-dc-name.contoso.com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Entries[0].DestSite | Should -BeNullOrEmpty
    }

    It 'Tier 3 returns $null when DN has the wrong segment order (CN=Sites,CN=Servers,...)' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        # Sites/Segments swapped — canonical AD shape is CN=Servers,CN=<Site>,CN=Sites
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=DC-X,CN=Sites,CN=KDL-BeiJing,CN=Servers,DC=contoso,DC=com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Entries[0].DestSite | Should -BeNullOrEmpty
    }

    It 'Tier 3 tolerates whitespace around CN= separators (real AD strings sometimes have spaces)' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=DC-X, CN=Servers, CN=KDL-ChenDu , CN=Sites , DC=contoso,DC=com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Entries[0].DestSite | Should -Be 'KDL-ChenDu'
    }

    # 2026-09-25 R93.8 — Tier 3 must fire when $snapshot.Site is the EMPTY
    # STRING `""`, not just $null. R93.6.1's `($null -ne $snapshot.Site)`
    # guard evaluated TRUE for `""`, so Tier 2 short-circuited with an empty
    # value and Tier 3 never ran. Operator's KDLFLOFADSRV2 真机 data showed
    # exactly this — every partner row had sourceSite="" destSite="" because
    # $snapshot.Site was `""` on the Get-ADDomainController fallback path.
    It 'Tier 3 wins: DN parse when $snapshot.Site is the empty string "" (R93.8 — KDLFLOFADSRV2 case)' {
      Set-Variable -Name 'R93.6SourceSite' -Value '' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-BeiJing,CN=Sites,CN=Configuration,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'KDLFLOFADSRV2'
      $snap.Entries[0].DestSite   | Should -Be 'KDL-BeiJing'
      $snap.Entries[0].SourceSite | Should -Be 'KDL-BeiJing'
    }

    It 'Tier 2 wins when $snapshot.Site is a non-empty string (regression guard: must not regress to Tier 3 when Tier 2 has data)' {
      Set-Variable -Name 'R93.6SourceSite' -Value 'Source-Site' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=DC-X,CN=Servers,CN=KDL-BeiJing,CN=Sites,DC=contoso,DC=com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      # Tier 2 must still win when AD module provided a real site — Tier 3 is
      # only a defensive fallback for the "" / $null case.
      $snap.Entries[0].DestSite   | Should -Be 'Source-Site'
      $snap.Entries[0].SourceSite | Should -Be 'Source-Site'
    }
  }

  # 2026-09-25 R93.6.1 followup — 当前站点自身的 site 也要能反推。
  # 用户反馈: "也需要能够获取当前站点的site 啊"。
  # When AD lookup 全失败 (line 569-589 都抛) AND collector -Site param
  # 没传, $snapshot.Site 是 $null。 之前 R93.6.1 Tier 3 只修了 partner 行
  # 的 SourceSite / DestSite, 但 snapshot 自身 Site 字段 + __dc_summary__
  # 行的 SourceSite 仍然空。 Resolve-SelfSiteFromPartners helper 在
  # partner loop 跑完后 reverse-map partner DN list, 把第一个 parseable
  # site 当 self site。
  Describe 'Resolve-SelfSiteFromPartners (R93.6.1 self-site recovery)' {

    It 'returns the first parseable site from a partner list with one canonical DN' {
      $partners = @(
        [PSCustomObject]@{ Partner = 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,DC=kdl,DC=local'; PartnerServer = 'KDLFLOFADSRV2' }
      )
      Resolve-SelfSiteFromPartners -Partners $partners | Should -Be 'KDL-FL-HubSite'
    }

    It 'returns $null for $null partner list (defensive)' {
      Resolve-SelfSiteFromPartners -Partners $null | Should -BeNullOrEmpty
    }

    It 'returns $null for empty partner list (defensive)' {
      Resolve-SelfSiteFromPartners -Partners @() | Should -BeNullOrEmpty
    }

    It 'returns $null when no partner DN matches the canonical CN=Servers,CN=*,CN=Sites shape' {
      $partners = @(
        [PSCustomObject]@{ Partner = 'bare-hostname.contoso.com'; PartnerServer = 'bare-hostname' },
        [PSCustomObject]@{ Partner = 'another-bad-shape'; PartnerServer = 'another-bad' }
      )
      Resolve-SelfSiteFromPartners -Partners $partners | Should -BeNullOrEmpty
    }

    It 'skips unparseable partners and returns the first parseable one' {
      $partners = @(
        [PSCustomObject]@{ Partner = 'bare-hostname.contoso.com'; PartnerServer = 'a' },
        [PSCustomObject]@{ Partner = 'CN=NTDS Settings,CN=KDL-X,CN=Servers,CN=KDL-ChenDu,CN=Sites,DC=kdl,DC=local'; PartnerServer = 'b' },
        [PSCustomObject]@{ Partner = 'CN=NTDS Settings,CN=KDL-Y,CN=Servers,CN=KDL-BeiJing,CN=Sites,DC=kdl,DC=local'; PartnerServer = 'c' }
      )
      Resolve-SelfSiteFromPartners -Partners $partners | Should -Be 'KDL-ChenDu'
    }
  }

  Describe 'Get-ReplicationSnapshot self-site recovery (R93.6.1)' {

    It 'snapshot.Site recovers from partner list when AD lookup yields $null (KDLFLOFADSRV2 case)' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'KDLFLOFADSRV2'
      $snap.Site | Should -Be 'KDL-FL-HubSite'
    }

    It '__dc_summary__ entry inherits the recovered snapshot.Site' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'KDLFLOFADSRV2'
      # The summary entry is appended to Entries last, after the partner loop
      # and after the self-site recovery. Filter to the dc_summary row.
      $summary = $snap.Entries | Where-Object { $_.NamingContext -eq '__dc_summary__' } | Select-Object -First 1
      $summary.SourceSite | Should -Be 'KDL-FL-HubSite'
    }

    It 'snapshot.Site stays $null when AD lookup AND partner list both fail' {
      Set-Variable -Name 'R93.6SourceSite' -Value $null -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'bare-hostname.contoso.com' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      $snap.Site | Should -BeNullOrEmpty
    }

    It 'AD lookup wins over partner-list recovery when AD lookup succeeded (no surprise overwrite)' {
      Set-Variable -Name 'R93.6SourceSite' -Value 'AD-Module-Resolved-Site' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDL-X,CN=Servers,CN=KDL-ChenDu,CN=Sites,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'DC-BJ-01'
      # AD module gave us a site — partner list should NOT overwrite it.
      $snap.Site | Should -Be 'AD-Module-Resolved-Site'
    }

    # 2026-09-25 R93.8 — self-site recovery must also fire when
    # $snapshot.Site is the EMPTY STRING `""`. R93.6.1's `($null -eq
    # $snapshot.Site)` was FALSE for `""`, so the recovery block was
    # skipped and the dc_summary entry inherited an empty SourceSite.
    # KDLFLOFADSRV2 真机 data: 8 partner rows + 1 dc_summary row, all with
    # sourceSite="" and destSite="" / null — the recovery should have
    # populated KDL-FL-HubSite from the partner DN list.
    It 'snapshot.Site recovers from partner list when AD lookup yields the empty string "" (R93.8)' {
      Set-Variable -Name 'R93.6SourceSite' -Value '' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'KDLFLOFADSRV2'
      $snap.Site | Should -Be 'KDL-FL-HubSite'
    }

    It '__dc_summary__ entry inherits recovered snapshot.Site when $snapshot.Site starts as "" (R93.8)' {
      Set-Variable -Name 'R93.6SourceSite' -Value '' -Scope Global
      Set-Variable -Name 'R93.6PartnerInputs' -Value @(
        (New-StubLinkPartner -Partner 'CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,CN=Sites,CN=Configuration,DC=kdl,DC=local' -PartnerSiteName '' -NamingContext 'DC=contoso,DC=com')
      ) -Scope Global
      $snap = Get-ReplicationSnapshot -ComputerName 'KDLFLOFADSRV2'
      $summary = $snap.Entries | Where-Object { $_.NamingContext -eq '__dc_summary__' } | Select-Object -First 1
      $summary.SourceSite | Should -Be 'KDL-FL-HubSite'
    }
  }