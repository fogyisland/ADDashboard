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
