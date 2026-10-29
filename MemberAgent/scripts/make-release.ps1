# R161.23 (2026-10-29) — 成员血统的发布脚本。
#
# 旧版是 AD/DC 发布脚本的**逐字拷贝**, 有三处缺陷在成员服务器上会直接把包打坏:
#
#   1) $root 写死 'C:\agentInstall' ⇒ 在成员机上打出来的是 **AD 那棵树**
#      (AD collector + ADReplicationAgent 服务名) —— 血统直接错。
#   2) **没有拷 dashboard/** ⇒ 打包出来的 agent/agent.js 的静态 import
#      `import { startDashboard } from '../dashboard/server.js'` 解析不到
#      ⇒ 启动第一秒 ERR_MODULE_NOT_FOUND ⇒ NSSM 崩溃重启循环
#      (R121 / R123 / R124 那一族现场故障的形态)。
#   3) **没有拷 version.inf** ⇒ Register-ADDashboardAgent.ps1 直接抛
#      "version.inf missing or [components] version key unset"。
#      (LogRetention.ps1 / start-dashboard.ps1 同理。)
#
# 根目录改成参数: 默认走成员血统的安装根 (与 agent/DEPLOY.md 一致),
# 操作员可以按现场实际路径覆盖。
#
# ★★ param() 必须是脚本的**第一条语句** (前面只允许注释) ——
#   PowerShell 只把出现在首位的 param 块当参数块; 如果它前面有可执行
#   语句 (例如 $ErrorActionPreference = 'Stop'), 整块 param 会被当成
#   普通命令去解析 ⇒ "赋值表达式无效" 的语法错误 ⇒ 脚本连跑都跑不起来。
param(
  [string]$root = 'C:\NoADagentInstall',
  [string]$dst  = 'C:\release\NoADagentInstall'
)

$ErrorActionPreference = 'Stop'
$srcAgent = Join-Path $root 'agent'

# ── 血统守卫 (R161.23) ─────────────────────────────────────────────────────
# 与 R161.22 的代理端守卫同源: 中心只认 lineage:'noad' 的包, 代理也只认,
# 发布脚本是第三个必须认血统的环节 —— 否则一个手滑就会把 AD/DC 的树
# 打包成"成员绿色包"发出去, 而现场要等到 agent 启动崩溃才发现。
$manifestPath = Join-Path $srcAgent 'build-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "build-manifest.json not found under '$srcAgent' — cannot verify the lineage of the tree being packaged."
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.lineage -ne 'noad') {
  throw ("refusing to build a MEMBER release from a non-noad bundle " +
         "(build-manifest.json lineage='$($manifest.lineage)'). " +
         "The member package must ship the non-AD lineage only.")
}
Write-Host "  lineage check: OK (lineage='$($manifest.lineage)', version='$($manifest.version)')"

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
#
# R161.23: version.inf / LogRetention.ps1 / start-dashboard.ps1 之前**不在**
# 这个列表里 ⇒ 打包出来的包缺单一版本源 (Register-ADDashboardAgent.ps1 会
# 直接抛 "version.inf missing")、缺日志保留脚本、缺 dashboard 启动脚本。
$topFiles = 'install-agent.ps1', 'uninstall-agent.ps1', 'start.ps1', 'Register-ADDashboardAgent.ps1',
             'LogRetention.ps1', 'start-dashboard.ps1', 'version.inf'
foreach ($f in $topFiles) {
  $from = Join-Path $root $f
  if (Test-Path $from) {
    Copy-Item $from (Join-Path $dst $f)
    Write-Host "  $f"
  } else {
    Write-Host "  [warn] $f not found"
  }
}

# 1b) dashboard/ — ★ 必需, 不是可选。
# agent/agent.js 有一句**静态** import:
#     import { startDashboard } from '../dashboard/server.js';
# 它在包根的 dashboard/ 下。发布布局是 <dst>/agent/agent.js ⇒ 解析到
# <dst>/dashboard/server.js。少拷这个目录 ⇒ 目标机装完之后 agent 在启动
# 第一秒 ERR_MODULE_NOT_FOUND ⇒ NSSM 拉起 → 再崩 ⇒ 崩溃重启循环,
# 而安装脚本会报"安装成功"。所以这里**缺了就中止发布**, 不只是 warn。
$dashboardSrc = Join-Path $root 'dashboard'
if (-not (Test-Path -LiteralPath $dashboardSrc)) {
  throw ("dashboard/ not found under '$root' — the packaged agent/agent.js statically imports " +
         "'../dashboard/server.js' and would die with ERR_MODULE_NOT_FOUND at boot. " +
         "Refusing to publish a package that cannot start.")
}
Copy-Item -Recurse -Force $dashboardSrc (Join-Path $dst 'dashboard')
Write-Host "  dashboard/"

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
  # R161.23 — manual-trigger.js / trigger-all-packages-once.js **不再剔除**。
  #   这两个是成员服务器上的**运维工具**(手动回补一次包 / 把所有包跑一遍),
  #   源树 Server\noadagent\scripts\ 里就有, 自动升级通道 (只发 .js) 也照发;
  #   唯独绿色包把它们剔掉 ⇒ 绿色包装出来的成员机上没有这两个工具,
  #   自动升级过的机器上却有 ⇒ 同一个操作在不同装法下结果不一样。
  #   剔掉的只是它们的**运行时产物** (results.json / *.log)。
  'scripts\manual-trigger-results.json','scripts\manual-trigger*.log',
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
  'scripts\manual-trigger-results.json',
  'scripts\manual-trigger-run.log','scripts\manual-trigger-v2.log',
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

# 7) README - 从绿色包根目录复制, 不再内嵌一份拷贝。
#
# R161.23: 旧版在这里内嵌了一份 README 文本。成员包那份是 **AD/DC** 的逐字拷贝
# (标题 「AD Replication Agent - Release Package」, 安装命令带 「-AgentType ad」),
# 而脚本打的是成员血统的包 => 发出去的包里写着另一条血统的安装步骤, 照着做的人
# 会去装 AD/DC 采集器。内嵌拷贝还必然与绿色包根目录的真 README 漂移。
# 正确做法: 复制 $root\README.md, 缺失时明确告警而不是静默发一份错的。
$readmeSrc = Join-Path $root 'README.md'
if (Test-Path -LiteralPath $readmeSrc) {
  Copy-Item -LiteralPath $readmeSrc (Join-Path $dst 'README.md') -Force
  Write-Host "  README.md (copied from bundle root)"
} else {
  Write-Host "  [warn] README.md not found under $root - release package will have no README."
}

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