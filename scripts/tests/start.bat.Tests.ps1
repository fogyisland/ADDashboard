BeforeAll {
  $scriptPath = "$PSScriptRoot/../start.bat"
  $content     = Get-Content -LiteralPath $scriptPath -Raw
}

Describe 'start.bat' {
  It 'exists at scripts/start.bat (operator-facing entry for the green package)' {
    Test-Path $scriptPath | Should -BeTrue `
      'start.bat must exist — it is the recommended operator-facing entry (no PowerShell execution-policy friction).'
  }

  It 'invokes upgrade-agent.ps1 via powershell.exe (delegation, no logic duplication)' {
    # The .bat wrapper MUST defer all install/update logic to upgrade-agent.ps1.
    # If start.bat ever grows shell-side logic, the agent's contract is split
    # across two files and Read-Host prompts in the PS1 won't run.
    $content | Should -Match 'powershell\.exe' `
      'start.bat must invoke powershell.exe to run the PS1 script.'
    $content | Should -Match '-File\s+"\x25~dp0upgrade-agent\.ps1"' `
      'start.bat must target "%~dp0upgrade-agent.ps1" (script-relative path; works regardless of cwd). Double quotes are required — single quotes are literal in .bat and would prevent %~dp0 expansion.'
    $content | Should -Match '%\*' `
      'start.bat must forward all arguments (%*) to upgrade-agent.ps1 — operators need to pass -ComputerName/-CenterUrl/-AgentToken.'
  }

  It 'sets -ExecutionPolicy Bypass for the child process (avoids Restricted default)' {
    # PS 5.1 on Windows Server defaults to Restricted. Without Bypass the
    # upgrade-agent.ps1 invocation fails before any code runs. The wrapper
    # exists precisely to hide this from operators.
    $content | Should -Match '-ExecutionPolicy\s+Bypass' `
      'start.bat must pass -ExecutionPolicy Bypass so PS1 runs under default-Restricted policy.'
    $content | Should -Match '-NoProfile' `
      'start.bat must pass -NoProfile for clean startup (no profile.ps1 side effects).'
  }

  It 'propagates the PowerShell exit code (not swallowed)' {
    # If upgrade-agent.ps1 exits 1, the .bat must also exit 1 so callers
    # (WinRM Invoke-Command, scheduled tasks, scripts) can detect failure.
    # Using `exit /b %ERRORLEVEL%` after the powershell call is the standard
    # pattern; `exit` without /b would close the cmd shell itself.
    $content | Should -Match 'exit\s+/b\s+%ERRORLEVEL%' `
      'start.bat must exit /b %ERRORLEVEL% so the PS1 exit code reaches the caller (not swallowed).'
  }
}