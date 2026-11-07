param([string]$AgentRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)))
# R161.33 (2026-11-07) — 路径参数化: 旧版写死 C:gentInstallgent\{data,scripts},
# 换 install root 部署后清理脚本会删错地方 (或删不到)。默认从脚本自身位置
# 推导 (<AgentRoot>gent\scripts\cleanup-diag.ps1 的上两级 = <AgentRoot>gent),
# 可用 -AgentRoot 显式覆盖。
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
  $p = Join-Path (Join-Path $AgentRoot 'data') $f
  if (Test-Path $p) { Remove-Item $p -Force; Write-Host "removed $p" }
  $p2 = Join-Path (Join-Path $AgentRoot 'scripts') $f
  if (Test-Path $p2) { Remove-Item $p2 -Force; Write-Host "removed $p2" }
}
