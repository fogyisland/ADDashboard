$ErrorActionPreference = 'Stop'

$root  = 'C:\agentInstall'
$srcAgent = Join-Path $root 'agent'
$dst   = 'C:\release\agentInstall'

# 清理旧的 release — 用 .NET Directory.Delete 直接避开 PS 5.1 对路径名 `agent`
# 这种 device-like 名字的奇怪解析 (PS 5.1 把单段名 `agent` 视为保留).
$dstdir = [System.IO.DirectoryInfo]::new($dst)
if ($dstdir.Exists) {
  try { $dstdir.Delete($true) } catch {}
}
[System.IO.Directory]::CreateDirectory($dst) | Out-Null
Write-Host "Release dir: $dst"

# Token comes from a Node helper that reads appsettings.json (stdout only).
# The helper is in scripts/read-agent-token.js — the token never touches disk
# in this script's process or in any temp file.
Write-Host "  PS root=[$root] srcAgent=[$srcAgent]"
$token = & node (Join-Path $PSScriptRoot 'read-agent-token.js') (Join-Path $srcAgent 'appsettings.json') 2>$null
Write-Host "  token loaded: $(if ($token) { 'yes (len=' + $token.Length + ')' } else { 'NO' })"
if (-not $token) {
  throw 'failed to load AGENT_AUTH_TOKEN from appsettings.json'
}

# 1) 顶层 — install / uninstall / start / register 脚本
$topFiles = 'install-agent.ps1', 'uninstall-agent.ps1', 'start.ps1', 'Register-ADDashboardAgent.ps1'
foreach ($f in $topFiles) {
  $from = Join-Path $root $f
  if (Test-Path $from) {
    Copy-Item $from (Join-Path $dst $f)
    Write-Host "  $f"
  } else {
    Write-Host "  [warn] $f not found"
  }
}

# 2) common/ — 公共 PS 模块
Copy-Item -Recurse -Force (Join-Path $root 'common') (Join-Path $dst 'common')
Write-Host "  common/"

# 3) nssm/ — NSSM 二进制
Copy-Item -Recurse -Force (Join-Path $root 'nssm') (Join-Path $dst 'nssm')
Write-Host "  nssm/"

# 4) node/ — Node.js 20 LTS portable
Copy-Item -Recurse -Force (Join-Path $root 'node') (Join-Path $dst 'node')
$nodeSize = (Get-ChildItem -Recurse -File (Join-Path $dst 'node') -ErrorAction SilentlyContinue |
  Measure-Object -Sum Length).Sum / 1MB
Write-Host "  node/ ($('{0:N1}' -f $nodeSize) MB)"

# 5) appsettings.example.json — 参考模板（不含 token）
Write-Host "  before assignment: root=[$root] dst=[$dst]"
$exPath = 'C:\agentInstall\agent\appsettings.example.json'
Write-Host "  after assignment: exPath=[$exPath] len=$(if ($exPath){$exPath.Length}else{0})"
Write-Host "  type: $($exPath.GetType().FullName)"
if ($exPath) {
  if (Test-Path -LiteralPath $exPath) {
    Copy-Item -LiteralPath $exPath (Join-Path $dst 'appsettings.example.json')
    Write-Host "  appsettings.example.json"
  } else {
    Write-Host "  [warn] appsettings.example.json Test-Path returned false"
  }
}

# 6) agent/ — 镜像整个 C:\agentInstall\agent 但排除 node_modules / tests / 诊断脚本
$agentDst = Join-Path $dst 'agent'
Write-Host "  agentDst = [$agentDst]"
$agentDstDir = [System.IO.DirectoryInfo]::new($agentDst)
if ($agentDstDir.Exists) {
  try { $agentDstDir.Delete($true) } catch {}
}

$xd = @(
  'node_modules',
  'tests',
  'Logs',
  '.git'
)
# Exclude paths are relative to src root. Subdirectory files need explicit prefix
# so /XF globs only match within the literal parent directory.
$xf = @(
  'appsettings.json',
  'appsettings.*.json',
  '*.log','*.bak',
  'scripts\probe-*.js','scripts\probe-*.log','scripts\probe-*.out.txt',
  'scripts\debug-collect.js',
  'scripts\debug-collect-ps1.ps1',
  'scripts\test-collect-with-env.ps1',
  'scripts\extract-*.js','scripts\extract-*.txt',
  'scripts\download-spa.js','scripts\spa-bundle.js','scripts\spa-paths.txt','scripts\spa-context.txt',
  'scripts\pp-*.txt','scripts\pkgruns-*.txt',
  'scripts\list-today.ps1',
  'scripts\list-centre-routes.js',
  'scripts\git-init-commit.ps1',
  'scripts\make-release.ps1',
  'scripts\read-agent-token.js',
  'scripts\manual-trigger.js','scripts\manual-trigger-results.json','scripts\manual-trigger*.log',
  'scripts\trigger-all-packages-once.js',
  'scripts\run-partner-probe.js','scripts\run-partner-probe.log',
  'scripts\submit-partner-probe.js','scripts\submit-partner-probe.log',
  'scripts\submit-partner-probe-v2.js',
  'scripts\probe-repadmin.ps1',
  'data\partner-probe-submit.json',
  'data\report-queue.json',
  'data\verify-out.log',
  'data\eventlog_stderr.log','data\eventlog_stdout.log',
  'data\domain_consistency_*.log',
  'data\probe-pkg-list.out.txt','data\probe-pp-api.out.txt','data\probe-pp-health.out.txt',
  'data\appsettings-mock-agent.json'
)

# 包缓存的 current.json (每次启动从 centre 拉)
$xd += 'data\packages'
# current.json 单独保留目录但剔除动态文件
$xf += 'data\packages\ad_os_baseline\current.json'
$xf += 'data\packages\ad_lockout_list\current.json'
$xf += 'data\packages\ad_dc_overview\current.json'
$xf += 'data\packages\ad_eventlog_collector\current.json'
$xf += 'data\packages\ad_lockout_summary\current.json'
$xf += 'data\packages\ad_partner_ports_probe\current.json'
$xf += 'data\packages\ad_domain_consistency\current.json'
# R93.11 调试残留
$xf += 'data\packages\ad_partner_ports_probe\1.0.0\collect-wrapper.ps1'
$xf += 'data\packages\ad_partner_ports_probe\1.0.0\hmac-helpers.ps1'

# 注意: data\packages\*\current.json 被 $xd='data\packages' 完全排除整个目录
# 如果想保留 manifest + scripts/ 但排除 current.json, 用单个 /XF 更精细 — 上面反过来
# 修正: 不再 /XD 'data\packages', 改为 /XF data\packages\*\current.json
$xd = $xd | Where-Object { $_ -ne 'data\packages' }

$xdArgs = ($xd | ForEach-Object { '/XD'; $_ }) -join ' '
$xfArgs = ($xf | ForEach-Object { '/XF'; $_ }) -join ' '

# /E 递归, 不删除目标侧多余文件 (避免覆盖上层 token 扫描结果 — 反正我们刚清空)
$cmdline = "robocopy `"$srcAgent`" `"$agentDst`" /E /R:0 /W:0 /NFL /NDL /NP /NJH /NJS $xdArgs $xfArgs"
Write-Host "  cmdline len: $($cmdline.Length) chars, $xf.Count XF, $xd.Count XD"
cmd /c $cmdline | Out-Null
$rc = $LASTEXITCODE
# robocopy 退出码: 0=无变化, 1=复制成功, 2=extra files detected, 3=copy+extra — 都算成功
if ($rc -ge 8) {
  throw "robocopy failed with exit code $rc"
}
Write-Host "  agent/ mirrored (robocopy rc=$rc)"

# phase 2: post-mirror cleanup via .NET File.Move (avoids /XF glob pitfalls on long command lines)
$junk = Join-Path $dst ("_junk_" + (Get-Random))
[System.IO.Directory]::CreateDirectory($junk) | Out-Null
$debugFiles = @(
  # scripts/ debug
  'scripts\probe-8080-signed.js','scripts\probe-all-ports.js',
  'scripts\probe-centre-admin.js','scripts\probe-centre-db.js',
  'scripts\probe-centre-r938.js','scripts\probe-centre.js',
  'scripts\probe-partner-api.js','scripts\probe-partner-ports.js',
  'scripts\probe-partners-only.js','scripts\probe-pkg-list.js',
  'scripts\probe-pp-api.js','scripts\probe-pp-health.js',
  'scripts\probe-pp-page.js','scripts\probe-routes-with-host.js',
  'scripts\debug-collect.js','scripts\debug-collect-ps1.ps1',
  'scripts\test-collect-with-env.ps1',
  'scripts\extract-pkg-render.js','scripts\extract-pkgruns.js',
  'scripts\extract-pp-consumer.js','scripts\extract-pp-fetch.js',
  'scripts\extract-pp-render.js','scripts\extract-spa-paths.js',
  'scripts\download-spa.js','scripts\spa-bundle.js',
  'scripts\spa-paths.txt','scripts\spa-context.txt',
  'scripts\pp-consumer.txt','scripts\pp-fetch.txt',
  'scripts\pp-render.txt','scripts\pkgruns-consumer.txt',
  'scripts\list-today.ps1','scripts\list-centre-routes.js',
  'scripts\git-init-commit.ps1','scripts\make-release.ps1',
  'scripts\read-agent-token.js',
  'scripts\manual-trigger.js','scripts\manual-trigger-results.json',
  'scripts\manual-trigger-run.log','scripts\manual-trigger-v2.log',
  'scripts\trigger-all-packages-once.js',
  'scripts\run-partner-probe.js','scripts\run-partner-probe.log',
  'scripts\submit-partner-probe.js','scripts\submit-partner-probe.log',
  'scripts\submit-partner-probe-v2.js','scripts\probe-repadmin.ps1',
  # data/ root debug
  'data\partner-probe-submit.json','data\report-queue.json','data\verify-out.log',
  'data\eventlog_stderr.log','data\eventlog_stdout.log',
  'data\domain_consistency_stderr.log','data\domain_consistency_stdout.log',
  'data\list-centre-routes.log',
  'data\probe-pkg-list.out.txt','data\probe-pp-api.out.txt','data\probe-pp-health.out.txt',
  'data\appsettings-mock-agent.json','data\appsettings.json',
  # data/packages/<pkg>/current.json
  'data\packages\ad_dc_overview\current.json',
  'data\packages\ad_domain_consistency\current.json',
  'data\packages\ad_eventlog_collector\current.json',
  'data\packages\ad_lockout_list\current.json',
  'data\packages\ad_lockout_summary\current.json',
  'data\packages\ad_os_baseline\current.json',
  'data\packages\ad_partner_ports_probe\current.json',
  'data\packages\ad_partner_ports_probe\1.0.0\collect-wrapper.ps1',
  'data\packages\ad_partner_ports_probe\1.0.0\hmac-helpers.ps1'
)
$moved = 0
foreach ($rel in $debugFiles) {
  $src = Join-Path $agentDst $rel
  if (Test-Path $src) {
    $dir = Split-Path $rel -Parent
    $name = Split-Path $rel -Leaf
    $dest = Join-Path $junk ($dir.Replace('\','_') + '_' + $name)
    try { [System.IO.File]::Move($src, $dest); $moved++ }
    catch { Write-Host "  [move-err] $rel : $($_.Exception.Message)" }
  }
}
Write-Host "  phase2 cleanup: moved $moved debug files to $junk"

# appsettings.json — replace with example template (no real token)
$exPath = Join-Path $srcAgent 'appsettings.example.json'
if (Test-Path $exPath) {
  [System.IO.File]::Copy($exPath, (Join-Path $agentDst 'appsettings.json'), $true)
  Write-Host "  appsettings.json replaced with example template"
}
Write-Host "  agent/ mirrored (robocopy rc=$rc)"

# 7) README
$readme = @'
# AD Replication Agent — Release Package

完整的 agent 客户端安装包. 直接拿走放到目标机器 `C:\agentInstall\`, 运行:

```powershell
cd C:\release\agentInstall
.\install-agent.ps1 -ComputerName . -CenterUrl "http://your-centre:8080" -AgentToken "<token>" -AgentType ad
```

## 目录布局

```
agentInstall\
  install-agent.ps1         WinRM/本地安装入口
  uninstall-agent.ps1       卸载入口
  start.ps1                 调试用启动 (前台运行)
  Register-ADDashboardAgent.ps1   NSSM install / sc recovery 统一入口
  appsettings.example.json   配置模板 (不含 token)
  common\                   Logger/Service/NSSM 公共模块
  nssm\                     NSSM 二进制 (win32)
  node\                     Node.js 20 LTS portable
  agent\                    实际安装目标 — install-agent 把它 staging 到 <InstallPath>\
    src\                    ESM JS 源码 (R93.5 / R93.7 / package-runner env)
    scripts\                PowerShell 脚本
    data\packages\          7 个 collect.ps1 包
    package.json
```

## 安装流程

1. 拷贝整个目录到目标机 `C:\agentInstall\`
2. `cd C:\agentInstall`
3. `.\install-agent.ps1 -ComputerName . -CenterUrl <url> -AgentToken <token> -AgentType ad`
4. install-agent 会:
   - 拷贝 agent\ 内容到 InstallPath
   - 拷贝 node\ 到 InstallPath\node\
   - `npm install --omit=dev` 重建 node_modules
   - 写 appsettings.json
   - NSSM install ADReplicationAgent + 12 参数设置
   - sc.exe failure recovery
   - Start-Service

## R93.x changelog

R93.5 — packages-report 端口错位 (8080 → 8082)
R93.7 — reschedule() 改为 set-difference (KEEP/UPDATE/ADD/REMOVE)
        不再无差别 clearInterval 重建, 老 timer 时间累计保留
        900s / 3600s 包 (ad_lockout_list / ad_domain_consistency 等) 现在按 cadence 正常 fire

package-runner.js — env 字段透传给 spawn 的 PowerShell
        collect.ps1 读 $env:CENTER_URL 后能正常 POST 8081 拿 peers

## 已知问题

- ad_partner_ports_probe 在 LocalSystem 下 collect.ps1 拿不到 peers
  - 中期 fix: package-manager.js.runOne() 调 _runPackageScript 时透传 env
'@
$readme | Out-File -FilePath (Join-Path $dst 'README.md') -Encoding utf8

# 8) .gitignore (复制一份方便后续 git init)
Copy-Item (Join-Path $srcAgent '.gitignore') (Join-Path $dst '.gitignore') -Force

# 9) ⛔ 安全门: 扫描 token
Write-Host "`n=== scanning for token leak ==="
$leak = @()
Get-ChildItem -Recurse -File -Path $dst -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Length -gt 10MB) { return }
  try {
    $content = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
    if ($content -and $content.Contains($token)) {
      $leak += $_.FullName.Substring($dst.Length + 1)
    }
  } catch {}
}
if ($leak.Count -gt 0) {
  Write-Host "!! TOKEN LEAK in:"
  $leak | ForEach-Object { Write-Host "  $_" }
  try { ([System.IO.DirectoryInfo]::new($dst)).Delete($true) } catch {}
  exit 1
} else {
  Write-Host "[OK] no token leak"
}

# 10) 总结
Write-Host "`n=== release summary ==="
$totalSize = (Get-ChildItem -Recurse -File $dst | Measure-Object -Sum Length).Sum / 1MB
$fileCount = (Get-ChildItem -Recurse -File $dst | Measure-Object).Count
Write-Host ("  path: {0}" -f $dst)
Write-Host ("  files: {0}" -f $fileCount)
Write-Host ("  size: {0:N1} MB" -f $totalSize)

Write-Host "`n=== top-level layout ==="
Get-ChildItem $dst -Force | Select-Object Name, Mode | Format-Table | Out-String | Write-Host