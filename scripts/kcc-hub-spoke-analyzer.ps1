# ============================================================================
# kcc-hub-spoke-analyzer.ps1 — AD 复制拓扑 Hub-Spoke 合规分析器
#
# 用途 (R68):
#   大型 AD 环境 (40 DC / 20 站点) 需要 Hub-Spoke 分层复制架构。本脚本
#   只读分析当前 AD 拓扑,输出三份报告:
#     1. 当前拓扑摘要 — sites / site links / cross-site 链路数
#     2. Site-link cost 推荐表 — 对每个 site link 输出当前/推荐 cost + 原因
#     3. Hub-Spoke 合规报告 — 标记"Spoke → Spoke"意外链路 (KCC 拉的穿透型)
#
#   本脚本**只读**,不修改 AD。Operator 确认报告后,由单独的 mutation 脚本
#   或 AD 管理控制台手动应用变更。
#
# 运行方式:
#   pwsh -File scripts/kcc-hub-spoke-analyzer.ps1
#   pwsh -File scripts/kcc-hub-spoke-analyzer.ps1 -OutputPath logs/hub-spoke-report.md
#   pwsh -File scripts/kcc-hub-spoke-analyzer.ps1 -WhatIf          # 仅打印命令不执行
#
# 依赖:
#   - RSAT ActiveDirectory PowerShell 模块 (域控或带 RSAT 的管理工作站)
#   - Domain Admin 或等效读取权限
#
# PowerShell 5.1 + pwsh 7+ 兼容。
# ============================================================================

[CmdletBinding()]
param(
  # 报告输出文件路径。默认 logs/hub-spoke-report-<timestamp>.md
  [string]$OutputPath,

  # Hub 站点名称数组(显式指定 Hub,跳过自动推断)。如: -HubSites @('核心站点','灾备站点')
  [string[]]$HubSites,

  # Spoke site link cost 目标值(默认 1000,KCC 会避开)
  [int]$SpokeToSpokeCost = 1000,

  # Spoke → Hub 就近 cost 目标值(默认 50,让 KCC 优先走)
  [int]$SpokeToHubCost = 50,

  # 跨区 Hub-Hub cost(默认 300)
  [int]$CrossRegionHubCost = 300,

  # 同区域 Hub-Hub cost(默认 100)
  [int]$SameRegionHubCost = 100,

  # 仅打印将要执行的命令,实际不查询 AD
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

# ---- 检查 ActiveDirectory 模块 ----
if (-not $WhatIf) {
  if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
    throw "ActiveDirectory PowerShell 模块未安装。请在域控或带 RSAT 的管理工作站上运行。"
  }
  Import-Module ActiveDirectory -ErrorAction Stop
}

# ---- 输出路径 ----
if (-not $OutputPath) {
  $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutputPath = Join-Path (Join-Path $PSScriptRoot '..\logs') "hub-spoke-report-$ts.md"
}
$logDir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $logDir)) {
  if ($WhatIf) {
    Write-Host "[WhatIf] Would create log dir: $logDir"
  } else {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
}

# ---- 函数: 计算 site link 类型 ----
#
# 给定一个 site link,根据 sites 是否包含 Hub,判断它是:
#   - 'hub-hub'        Hub 与 Hub 之间的链路
#   - 'spoke-hub'      Spoke 与 Hub 之间的链路
#   - 'spoke-spoke'    两个 Spoke 之间的链路 (违反 Hub-Spoke 模型)
#   - 'unknown'        无法判断 (例如站点未在 ad_sites 中标记 Hub)
function Get-LinkType {
  param(
    [Parameter(Mandatory)][string]$SiteA,
    [Parameter(Mandatory)][string]$SiteB,
    [Parameter(Mandatory)][hashtable]$HubSet
  )
  $aIsHub = $HubSet.ContainsKey($SiteA)
  $bIsHub = $HubSet.ContainsKey($SiteB)
  if ($aIsHub -and $bIsHub) { return 'hub-hub' }
  if ($aIsHub -or $bIsHub) { return 'spoke-hub' }
  return 'spoke-spoke'
}

# ---- 函数: 推荐的 site link cost ----
function Get-RecommendedCost {
  param(
    [Parameter(Mandatory)][string]$LinkType,
    [int]$SpokeToSpokeCost = 1000,
    [int]$SpokeToHubCost = 50,
    [int]$CrossRegionHubCost = 300,
    [int]$SameRegionHubCost = 100
  )
  switch ($LinkType) {
    'spoke-spoke' { return $SpokeToSpokeCost }
    'spoke-hub'   { return $SpokeToHubCost }
    'hub-hub'     { return $SameRegionHubCost }  # 默认同区域;跨区由 caller 覆盖
    default       { return 100 }
  }
}

# ---- 收集 AD 数据 ----
Write-Host "[analyzer] 收集 AD 拓扑数据..." -ForegroundColor Cyan

if ($WhatIf) {
  Write-Host "[WhatIf] Would run: Get-ADReplicationSite -Filter *"
  Write-Host "[WhatIf] Would run: Get-ADReplicationSiteLink -Filter *"
  Write-Host "[WhatIf] Would run: Get-ADReplicationSubnet -Filter *"
  $sites = @()
  $siteLinks = @()
  $subnets = @()
} else {
  $sites = @(Get-ADReplicationSite -Filter * -ErrorAction Stop)
  $siteLinks = @(Get-ADReplicationSiteLink -Filter * -ErrorAction Stop)
  $subnets = @(Get-ADReplicationSubnet -Filter * -ErrorAction Stop)
}

Write-Host "  sites:    $($sites.Count)"
Write-Host "  links:    $($siteLinks.Count)"
Write-Host "  subnets:  $($subnets.Count)"

# ---- 推断 Hub 集合 ----
#
# 如果用户没显式指定 Hub,启发式:
#   - 站点名包含"核心"/"Hub"/"Center"/"DC"/"主" → 视为 Hub
#   - 否则视为 Spoke
#   - 这只是 fallback,operator 应在 ad_sites 表中显式 is_hub=1 维护
$hubSet = @{}
if ($HubSites) {
  foreach ($h in $HubSites) { $hubSet[$h] = $true }
  Write-Host "  hubs (explicit): $($HubSites -join ', ')"
} else {
  $hubPattern = '^(核心|Hub|Center|主|DR|BC)'
  foreach ($s in $sites) {
    $name = $s.Name
    if ($name -match $hubPattern) {
      $hubSet[$name] = $true
      Write-Host "  inferred hub: $name"
    }
  }
  if ($hubSet.Count -eq 0) {
    Write-Warning "未推断出 Hub。请用 -HubSites 显式指定,或在 ad_sites.is_hub 中标记。"
  }
}
Write-Host "  total hubs: $($hubSet.Count)"
Write-Host "  total spokes: $($sites.Count - $hubSet.Count)"

# ---- 生成报告 ----
$report = New-Object System.Text.StringBuilder

[void]$report.AppendLine("# Hub-Spoke 合规分析报告")
[void]$report.AppendLine()
[void]$report.AppendLine("- **生成时间**: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
[void]$report.AppendLine("- **站点总数**: $($sites.Count)")
[void]$report.AppendLine("- **Hub 数**: $($hubSet.Count)")
[void]$report.AppendLine("- **Spoke 数**: $($sites.Count - $hubSet.Count)")
[void]$report.AppendLine("- **Site link 总数**: $($siteLinks.Count)")
[void]$report.AppendLine()

# === 1. 当前拓扑摘要 ===
[void]$report.AppendLine("## 1. 当前拓扑摘要")
[void]$report.AppendLine()
[void]$report.AppendLine("| 站点 | 类型 | 子网数 |")
[void]$report.AppendLine("|------|------|--------|")

$subnetCountBySite = @{}
foreach ($sn in $subnets) {
  $siteName = $sn.Site
  if (-not $subnetCountBySite.ContainsKey($siteName)) { $subnetCountBySite[$siteName] = 0 }
  $subnetCountBySite[$siteName]++
}
foreach ($s in ($sites | Sort-Object Name)) {
  $type = if ($hubSet.ContainsKey($s.Name)) { '🔵 Hub' } else { '⚪ Spoke' }
  $count = if ($subnetCountBySite.ContainsKey($s.Name)) { $subnetCountBySite[$s.Name] } else { 0 }
  [void]$report.AppendLine("| $($s.Name) | $type | $count |")
}
[void]$report.AppendLine()

# === 2. Site-link cost 推荐表 ===
[void]$report.AppendLine("## 2. Site-link cost 推荐")
[void]$report.AppendLine()
[void]$report.AppendLine("| Link | 类型 | 当前 cost | 推荐 cost | 差距 | 备注 |")
[void]$report.AppendLine("|------|------|----------|----------|------|------|")

# 统计每种 link 类型
$linkTypeCount = @{ 'hub-hub' = 0; 'spoke-hub' = 0; 'spoke-spoke' = 0; 'unknown' = 0 }
$violations = @()

foreach ($sl in ($siteLinks | Sort-Object Name)) {
  $a = $sl.SitesAllowed[0]  # sites in this link (2-element array)
  $b = $sl.SitesAllowed[1]
  $linkType = Get-LinkType -SiteA $a -SiteB $b -HubSet $hubSet
  $linkTypeCount[$linkType]++
  $recommendedCost = Get-RecommendedCost -LinkType $linkType `
    -SpokeToSpokeCost $SpokeToSpokeCost `
    -SpokeToHubCost $SpokeToHubCost `
    -CrossRegionHubCost $CrossRegionHubCost `
    -SameRegionHubCost $SameRegionHubCost
  $currentCost = $sl.Cost
  $delta = $recommendedCost - $currentCost
  $deltaStr = if ($delta -gt 0) { "+$delta" } else { "$delta" }
  $remark = switch ($linkType) {
    'spoke-spoke' { '⚠️ **违规** — Spoke 不应直连' }
    'spoke-hub'   { '✅ 标准 Spoke→Hub 链路' }
    'hub-hub'     { '✅ 核心层链路' }
    default       { '⚠️ 未识别' }
  }
  [void]$report.AppendLine("| $a ↔ $b | $linkType | $currentCost | $recommendedCost | $deltaStr | $remark |")

  if ($linkType -eq 'spoke-spoke') {
    $violations += [PSCustomObject]@{
      Link = "$a ↔ $b"
      CurrentCost = $currentCost
      Issue = 'Spoke 不应直连 — 这是 KCC 自动拉的穿透型链路'
    }
  }
}
[void]$report.AppendLine()

# === 3. Hub-Spoke 合规报告 ===
[void]$report.AppendLine("## 3. Hub-Spoke 合规报告")
[void]$report.AppendLine()
[void]$report.AppendLine("| 链路类型 | 数量 | 期望 | 状态 |")
[void]$report.AppendLine("|---------|------|------|------|")
[void]$report.AppendLine("| Hub ↔ Hub | $($linkTypeCount['hub-hub']) | 全互联或主备 | $(if ($linkTypeCount['hub-hub'] -ge 1) { '✅' } else { '⚠️ 至少 1 条' }) |")
[void]$report.AppendLine("| Spoke → Hub | $($linkTypeCount['spoke-hub']) | 每个 Spoke 至少 1 条 | $(if ($linkTypeCount['spoke-hub'] -ge ($sites.Count - $hubSet.Count)) { '✅' } else { '⚠️ 有 Spoke 未连 Hub' }) |")
[void]$report.AppendLine("| Spoke ↔ Spoke | $($linkTypeCount['spoke-spoke']) | **应为 0** | $(if ($linkTypeCount['spoke-spoke'] -eq 0) { '✅' } else { "❌ $violations.Count 条违规" }) |")
[void]$report.AppendLine()

if ($violations.Count -gt 0) {
  [void]$report.AppendLine("### 违规明细")
  [void]$report.AppendLine()
  [void]$report.AppendLine("| 链路 | 当前 cost | 问题 |")
  [void]$report.AppendLine("|------|----------|------|")
  foreach ($v in $violations) {
    [void]$report.AppendLine("| $($v.Link) | $($v.CurrentCost) | $($v.Issue) |")
  }
  [void]$report.AppendLine()
  [void]$report.AppendLine("**建议操作**: 把这些违规 link 的 cost 调到 $SpokeToSpokeCost (或更高),KCC 会主动避开。")
  [void]$report.AppendLine()
}

# === 4. KCC 行为清单 ===
[void]$report.AppendLine("## 4. KCC 行为清单")
[void]$report.AppendLine()
[void]$report.AppendLine("按推荐架构:")
[void]$report.AppendLine()
[void]$report.AppendLine("- **Hub 站点**: 启用 KCC (默认),作为 ISTG 候选,负责跨区拓扑计算")
[void]$report.AppendLine("- **Spoke 站点**: 禁用 KCC (`Disable-KccOnSite`),由 Hub 的 ISTG 统一规划")
[void]$report.AppendLine()
[void]$report.AppendLine("查看某站点的 KCC 状态:")
[void]$report.AppendLine('```powershell')
[void]$report.AppendLine('Get-ADObject -Identity "CN=NTDS Settings,CN=<DC>,CN=Servers,CN=<Site>,CN=Sites,CN=Configuration,DC=..." -Properties options')
[void]$report.AppendLine('# 如果 options 包含 1 (bit 0),KCC 被禁用')
[void]$report.AppendLine('```')
[void]$report.AppendLine()

# === 写入文件 + 控制台输出 ===
$reportText = $report.ToString()

if ($WhatIf) {
  Write-Host "[WhatIf] Would write report to: $OutputPath"
  Write-Host "[WhatIf] Report length: $($reportText.Length) chars"
  Write-Host "----- WhatIf preview (first 50 lines) -----"
  ($reportText -split "`n" | Select-Object -First 50) | ForEach-Object { Write-Host $_ }
} else {
  $reportText | Out-File -FilePath $OutputPath -Encoding utf8NoBOM -Force
  Write-Host "[analyzer] 报告已写入: $OutputPath" -ForegroundColor Green
  Write-Host ""
  Write-Host "===== 摘要 =====" -ForegroundColor Yellow
  Write-Host "  Hub 数:    $($hubSet.Count)"
  Write-Host "  Spoke 数:  $($sites.Count - $hubSet.Count)"
  Write-Host "  Hub-Hub 链路: $($linkTypeCount['hub-hub'])"
  Write-Host "  Spoke-Hub 链路: $($linkTypeCount['spoke-hub'])"
  Write-Host "  Spoke-Spoke 违规: $($linkTypeCount['spoke-spoke'])"
  if ($linkTypeCount['spoke-spoke'] -gt 0) {
    Write-Warning "发现 $($linkTypeCount['spoke-spoke']) 条 Spoke-Spoke 违规链路。详见报告。"
  }
}

Write-Host "[analyzer] 完成。"
exit 0
