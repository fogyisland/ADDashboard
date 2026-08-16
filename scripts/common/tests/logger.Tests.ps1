BeforeAll {
  Import-Module "$PSScriptRoot/../Logger.psm1" -Force
  # Logger.psm1's default $Script:LogDir resolves relative to the module's own
  # $PSScriptRoot (scripts/common/), going up 2 levels to the repo root. From
  # the test's location (scripts/common/tests/) we need to go up 3 levels to
  # reach the same repo root and find install.log.
  $logDir = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent | Join-Path -ChildPath 'Logs'
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
