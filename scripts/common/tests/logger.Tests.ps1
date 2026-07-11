BeforeAll {
  Import-Module "$PSScriptRoot/../Logger.psm1" -Force
  # Logger writes to C:\ProgramData\ADDashboard\Logs\install.log on import.
  # We just verify the last line(s) in that file after each call.
  $logDir = 'C:\ProgramData\ADDashboard\Logs'
  $script:LogFile = Join-Path $logDir 'install.log'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
}

Describe 'Write-Log' {
  It 'appends a formatted line with timestamp, level, and message' {
    $marker = "logger-test-{0}" -f ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Log 'INFO' $marker
    $content = Get-Content $script:LogFile -Raw
    $content | Should -Match "\[INFO\] $marker"
  }
}

Describe 'Write-Step' {
  It 'writes [STEP] level' {
    $marker = "step-{0}" -f ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Step $marker
    $content = Get-Content $script:LogFile -Raw
    $content | Should -Match "\[STEP\] $marker"
  }
}

Describe 'Write-Info' {
  It 'writes [INFO] level' {
    $marker = "info-{0}" -f ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Info $marker
    $content = Get-Content $script:LogFile -Raw
    $content | Should -Match "\[INFO\] $marker"
  }
}

Describe 'Write-Ok' {
  It 'writes [OK] level' {
    $marker = "ok-{0}" -f ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Ok $marker
    $content = Get-Content $script:LogFile -Raw
    $content | Should -Match "\[OK\] $marker"
  }
}
