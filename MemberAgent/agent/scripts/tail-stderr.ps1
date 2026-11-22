param([string]$AgentRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)))
# R161.33 (2026-11-07) — 路径参数化: 旧版写死 C:gentInstallgent\Logs\...,
# 换 install root 部署后诊断脚本直接读不到日志。默认从脚本自身位置推导
# (<AgentRoot>gent\scripts	ail-stderr.ps1 的上两级 = <AgentRoot>gent),
# 可用 -AgentRoot 显式覆盖。
$logPath = Join-Path (Join-Path $AgentRoot 'Logs') 'memberServiceAgent-stderr.log'
if (-not (Test-Path $logPath)) {
  Write-Host "stderr log not found: $logPath"
  exit 1
}
Get-Content $logPath -Tail 50 | ForEach-Object { $_.Substring(0, [Math]::Min(300, $_.Length)) }
