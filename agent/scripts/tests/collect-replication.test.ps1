BeforeAll {
  . "$PSScriptRoot/../collect-replication.ps1" -ForTesting
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

Describe 'Get-PartnerNamingContext (I-5 naming_context VARCHAR(256) overflow guard)' {
  It 'returns $null for empty input' {
    Get-PartnerNamingContext -partnerHost '' | Should -BeNullOrEmpty
  }

  It 'returns "__partner_ports__:<host>" verbatim for short hosts' {
    $ctx = Get-PartnerNamingContext -partnerHost 'dc-1.example.com'
    # 64-char host + underscore + 8-char hash + 17-char prefix = at most 90 chars
    $ctx | Should -Match '^__partner_ports__:dc-1\.example\.com_[0-9a-f]{8}$'
    $ctx.Length | Should -BeLessOrEqual 90
  }

  It 'truncates hosts longer than 64 chars and appends a hash suffix' {
    $longHost = ('a' * 200) + '.example.com'
    $ctx = Get-PartnerNamingContext -partnerHost $longHost
    # 64 truncated chars + '_' + 8-char hash + 17-char prefix = 90 chars
    $ctx.Length | Should -Be 90
    $ctx | Should -Match '^__partner_ports__:a{64}_[0-9a-f]{8}$'
  }

  It 'produces distinct hashes for distinct hosts that share a 64-char prefix' {
    $prefix = 'b' * 64
    $h1 = Get-PartnerNamingContext -partnerHost $prefix
    $h2 = Get-PartnerNamingContext -partnerHost ($prefix + 'XXX-DIFFERENT')
    $h1 | Should -Not -Be $h2
  }

  It 'never exceeds naming_context VARCHAR(256) even for pathological inputs' {
    # IPv6 literal — far longer than any sane FQDN
    $ipv6 = '[2001:db8:85a3::8a2e:370:7334]:389'
    $ctx = Get-PartnerNamingContext -partnerHost $ipv6
    $ctx.Length | Should -BeLessOrEqual 256
    # Also pin a 253-char FQDN (the DNS max).
    $maxFqdn = ('c' * 240) + '.example.com'
    $ctx2 = Get-PartnerNamingContext -partnerHost $maxFqdn
    $ctx2.Length | Should -BeLessOrEqual 256
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
    # counter / port-probe columns stay null on history rows
    $r[0].UsersCount       | Should -BeNullOrEmpty
    $r[0].PartnerPortStatus | Should -BeNullOrEmpty
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
