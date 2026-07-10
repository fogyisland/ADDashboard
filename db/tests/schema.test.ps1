Describe "Database schema" {
  BeforeAll {
    $script:server = $env:TEST_SQL_SERVER
    if (-not $script:server) { $script:server = "localhost" }
    $script:db = "AD_Monitoring_Test_$([Guid]::NewGuid().ToString('N'))"
    $script:cs = "Server=$script:server;Database=master;Integrated Security=SSPI;TrustServerCertificate=True"
  }

  It "creates all required tables" {
    $tables = @(
      'ad_replication_status','ad_replication_history','ad_agent_heartbeat',
      'ad_sites','ad_dcs','system_config','sys_users','sys_roles','audit_logs'
    )
    $result = Invoke-Sqlcmd -ConnectionString $script:cs -Query "
      IF DB_ID('$script:db') IS NULL CREATE DATABASE $script:db;
      USE $script:db;
      "
    $appCs = "Server=$script:server;Database=$script:db;Integrated Security=SSPI;TrustServerCertificate=True"
    Get-Content "$PSScriptRoot/../schema/01-tables.sql" |
      ForEach-Object { $_ -replace 'AD_Monitoring', $script:db } |
      Out-File -Encoding UTF8 "$PSScriptRoot/_01-tables-test.sql"
    Invoke-Sqlcmd -ConnectionString $appCs -InputFile "$PSScriptRoot/_01-tables-test.sql"
    foreach ($t in $tables) {
      $r = Invoke-Sqlcmd -ConnectionString $appCs -Query "SELECT OBJECT_ID('$t') AS id"
      $r.id | Should -Not -BeNullOrEmpty -Because "table $t must exist"
    }
  }

  AfterAll {
    if ($script:db) {
      try { Invoke-Sqlcmd -ConnectionString $script:cs -Query "DROP DATABASE IF EXISTS $script:db" -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item "$PSScriptRoot/_01-tables-test.sql" -ErrorAction SilentlyContinue
  }
}
