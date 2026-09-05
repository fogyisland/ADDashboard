Get-Process node -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.Id)).CommandLine
  if ($cmd -match 'server\.js') {
    Stop-Process -Id $_.Id -Force
    Write-Host ('killed PID ' + $_.Id + ': ' + $cmd)
  }
}
