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
