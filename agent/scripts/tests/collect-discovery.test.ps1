BeforeAll {
  . "$PSScriptRoot/../collect-discovery.ps1" -ForTesting
}

Describe 'Get-LocalDcSnapshot' {
  It 'returns an object with all required properties' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    $obj.PSObject.Properties.Name | Should -Contain 'Name'
    $obj.PSObject.Properties.Name | Should -Contain 'SiteHint'
    $obj.PSObject.Properties.Name | Should -Contain 'OsVersion'
    $obj.PSObject.Properties.Name | Should -Contain 'WhenCreated'
    $obj.PSObject.Properties.Name | Should -Contain 'IsPdc'
    $obj.PSObject.Properties.Name | Should -Contain 'IsGc'
    $obj.PSObject.Properties.Name | Should -Contain 'IsRidMaster'
    $obj.PSObject.Properties.Name | Should -Contain 'IsSchemaMaster'
    $obj.PSObject.Properties.Name | Should -Contain 'IsDomainNamingMaster'
    $obj.PSObject.Properties.Name | Should -Contain 'IsInfrastructureMaster'
  }

  It 'returns Name matching input ComputerName' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    $obj.Name | Should -Be $env:COMPUTERNAME
  }

  It 'returns WhenCreated in UTC ISO 8601 or null' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    if ($null -ne $obj.WhenCreated) {
      $obj.WhenCreated | Should -Match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
    }
  }

  It 'returns boolean values for Is* fields' {
    $obj = Get-LocalDcSnapshot -ComputerName $env:COMPUTERNAME
    $obj.IsPdc                    | Should -BeOfType [bool]
    $obj.IsGc                     | Should -BeOfType [bool]
    $obj.IsRidMaster              | Should -BeOfType [bool]
    $obj.IsSchemaMaster           | Should -BeOfType [bool]
    $obj.IsDomainNamingMaster     | Should -BeOfType [bool]
    $obj.IsInfrastructureMaster   | Should -BeOfType [bool]
  }
}
