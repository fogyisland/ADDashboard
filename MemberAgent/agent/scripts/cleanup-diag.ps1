$files = @(
  'analyze-garbled.js',
  'test-encoding.js',
  'verify-fix.js',
  'dump-tail.js',
  'inspect-bad-runs.js',
  'final-utf8-check.js',
  'per-pkg-stdout.js',
  'locate-mojibake.js',
  'hex-line108.js',
  'probe-powershell-encoding.js',
  'test-runner-fix.js',
  'analyze-out.log',
  'verify-fix.log',
  'dump-tail.log',
  'inspect-bad.log',
  'final-utf8.log',
  'per-pkg-stdout.log',
  'locate-mojibake.log',
  'hex-line108.log',
  'probe-ps.log',
  'test-runner-out.log',
  'test-runner-out.json'
)
foreach ($f in $files) {
  $p = Join-Path 'C:\agentInstall\agent\data' $f
  if (Test-Path $p) { Remove-Item $p -Force; Write-Host "removed $p" }
  $p2 = Join-Path 'C:\agentInstall\agent\scripts' $f
  if (Test-Path $p2) { Remove-Item $p2 -Force; Write-Host "removed $p2" }
}