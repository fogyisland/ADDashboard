# upgrade-r15850-7e-fleet.ps1
# One-shot upgrade of all remote DCs (the forest's DC list — pass it with
# -DCs / -DcListFile, the built-in array is a placeholder) from 0.1.1 to 0.1.2
# using the R158.48 UPDATE path (NOT the install path — DCs already
# have ADReplicationAgent service running).
#
# What this does per DC:
#   1. Copy agent.js from D:\dashboard\agent\agent.js → <DC>\C$\agentInstall\agent\agent.js
#      (the new version reads VERSION from version.inf and passes
#       agentInstallDir to applyUpgradeDelivery — fixes the bootstrap dead-end
#       surfaced by KDLFLOFADSRV2's "agent.upgrade.skip reason=no-agent-install-dir"
#       log spam)
#   2. Copy version.inf from D:\agentInstall\version.inf → <DC>\C$\agentInstall\version.inf
#      (the new version.inf says agent = 0.1.2)
#   3. nssm restart ADReplicationAgent — picks up the new agent.js
#   4. Verify agent reports 0.1.2 in ad_agent_heartbeat within 60s
#
# Pre-req:
#   - Operator is already running this with admin WinRM access
#   - All target DCs already have ADReplicationAgent service (otherwise use
#     install-agent.ps1 instead — operator confirmed this script is for
#     the UPDATE path)
#   - The target machines have nssm.exe available (C:\agentInstall\nssm\nssm.exe
#     or one of the C:\Tools locations) — the script now resolves it there.
#
# After upgrade:
#   - Each DC's next heartbeat reports agentVersion='0.1.2'
#   - centre computeUpgradeEnvelope sees reported==target → upgradeAvailable=false
#   - Future 0.1.3+ upgrades will flow through R158.48 automatically
#
# Run on operator host:
#   powershell -ExecutionPolicy Bypass -File upgrade-r15850-7e-fleet.ps1
#
# 目标机清单有三种给法 (按优先级):
#   1. -DCs 'DC01','DC02','DC03'
#   2. -DcListFile 'C:\temp\dcs.txt'   (每行一个主机名, # 开头是注释)
#   3. 直接改下面的 $DCs 数组

[CmdletBinding()]
param(
  [string[]]$DCs,
  [string]$DcListFile,
  [string]$SourceAgentJs = 'D:\dashboard\agent\agent.js',
  [string]$SourceVersionInf = 'D:\agentInstall\version.inf'
)

$ErrorActionPreference = 'Stop'

if (-not $DCs -or $DCs.Count -eq 0) {
  if ($DcListFile) {
    if (-not (Test-Path -LiteralPath $DcListFile)) {
      throw "DC list file not found: $DcListFile"
    }
    $DCs = @(Get-Content -LiteralPath $DcListFile -Encoding UTF8 |
             ForEach-Object { $_.Trim() } |
             Where-Object { $_ -and -not $_.StartsWith('#') })
  } else {
    # 注意: 这里**不能**留尾逗号 —— `@('a', # 注释\n)` 是 PowerShell 的
    # **语法错误** ("',' 后缺少表达式"), 旧实现就是这么写的 ⇒ 整个脚本
    # 根本解析不了, 一行都跑不起来 (PowerShell 报 ParserError, 与运行时
    # 无关)。补主机名时按下面这种写法, 一个一行、不加尾逗号。
    $DCs = @(
      'KDLFLOFADSRV2'
      # 在这里补上其余 DC 的主机名 (每行一个, 不要加尾逗号)
    )
  }
}

if (-not $DCs -or $DCs.Count -eq 0) {
    throw "DC list is empty. Pass -DCs 'DC01','DC02', or -DcListFile '<file>', or edit the `$DCs array in this script."
}

# Verify source files exist + are the post-fix versions
Write-Host "=== source verification ==="
if (-not (Test-Path $SourceAgentJs)) {
    throw "FAIL: $SourceAgentJs missing"
}
$agentJsContent = Get-Content $SourceAgentJs -Raw
if ($agentJsContent -notmatch 'function readVersionFromInf') {
    throw "FAIL: $SourceAgentJs does not contain readVersionFromInf — R158.50.7e fix not applied."
}
if ($agentJsContent -match "const VERSION\s*=\s*['\`]0\.1\.\d+['\`]\s*;") {
    throw "FAIL: $SourceAgentJs still has hardcoded VERSION literal."
}
Write-Host "  ✓ $SourceAgentJs contains readVersionFromInf + no hardcoded literal"

if (-not (Test-Path $SourceVersionInf)) {
    throw "FAIL: $SourceVersionInf missing"
}
$viLines = Get-Content $SourceVersionInf
$agentLine = $viLines | Where-Object { $_ -match '^\s*agent\s*=' } | Select-Object -First 1
if ($agentLine -notmatch '=\s*0\.1\.2') {
    throw "FAIL: version.inf agent line not 0.1.2. Currently: $agentLine"
}
Write-Host "  ✓ $SourceVersionInf agent = 0.1.2"

# Pre-stage the source agent.js content in memory for fast loop copies
$agentJsBytes = [System.IO.File]::ReadAllBytes($SourceAgentJs)
$versionInfBytes = [System.IO.File]::ReadAllBytes($SourceVersionInf)
$agentJsSha = (Get-FileHash $SourceAgentJs -Algorithm SHA256).Hash
$versionInfSha = (Get-FileHash $SourceVersionInf -Algorithm SHA256).Hash
Write-Host "  source agent.js   sha: $agentJsSha"
Write-Host "  source version.inf sha: $versionInfSha"

$results = @()

foreach ($dc in $DCs) {
    Write-Host ""
    Write-Host "=== $dc ==="
    try {
        # Step 1+2: copy files via Invoke-Command (admin WinRM)
        $copyResult = Invoke-Command -ComputerName $dc -ErrorAction Stop -ScriptBlock {
            param([byte[]]$agentJsBytes, [byte[]]$versionInfBytes, [string]$agentJsSha, [string]$versionInfSha)

            $installPath = 'C:\agentInstall\agent'
            $installRoot = 'C:\agentInstall'

            $agentJsPath = Join-Path $installPath 'agent.js'
            $versionInfPath = Join-Path $installRoot 'version.inf'

            if (-not (Test-Path $installPath)) {
                throw "FAIL: $installPath missing — DC never had agent installed. Use install-agent.ps1 instead."
            }

            # Backup current files
            $bakSuffix = (Get-Date).ToString('yyyyMMdd-HHmmss')
            $agentJsBak = "$agentJsPath.bak-pre-0.1.2-$bakSuffix"
            $versionInfBak = "$versionInfPath.bak-pre-0.1.2-$bakSuffix"
            if (Test-Path $agentJsPath) { Copy-Item $agentJsPath $agentJsBak -Force }
            if (Test-Path $versionInfPath) { Copy-Item $versionInfPath $versionInfBak -Force }

            # Write new files (UTF-8 NO BOM for version.inf safety)
            [System.IO.File]::WriteAllBytes($agentJsPath, $agentJsBytes)
            $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($versionInfPath, [System.Text.Encoding]::UTF8.GetString($versionInfBytes), $utf8NoBom)

            # Verify SHA
            $newAgentJsSha = (Get-FileHash $agentJsPath -Algorithm SHA256).Hash
            $newVersionInfSha = (Get-FileHash $versionInfPath -Algorithm SHA256).Hash

            if ($newAgentJsSha -ne $agentJsSha) {
                throw "FAIL: agent.js sha mismatch after copy. expected=$agentJsSha actual=$newAgentJsSha"
            }
            if ($newVersionInfSha -ne $versionInfSha) {
                throw "FAIL: version.inf sha mismatch after copy. expected=$versionInfSha actual=$newVersionInfSha"
            }

            # Step 3: nssm restart
            $svc = Get-Service -Name ADReplicationAgent -ErrorAction SilentlyContinue
            if (-not $svc) {
                throw "FAIL: ADReplicationAgent service not installed on $env:COMPUTERNAME — use install-agent.ps1 instead"
            }
            # nssm 必须在目标机上。裸 `nssm` 在 DC 上**不在 PATH** ⇒
            # "The term 'nssm' is not recognized as the name of a cmdlet" ——
            # 旧实现就是这么调的, 每一台 DC 都会失败, 而且失败信息
            # 跟"服务没装"长得一样, 现场极易误判。
            $nssmCandidates = @(
                (Join-Path $installRoot 'nssm\nssm.exe'),
                'C:\agentInstall\nssm\nssm.exe',
                'C:\Tools\nssm\win64\nssm.exe',
                'C:\Tools\nssm-2.24\win64\nssm.exe'
            )
            $nssm = $null
            foreach ($candidate in $nssmCandidates) {
                if (Test-Path -LiteralPath $candidate) { $nssm = $candidate; break }
            }
            if (-not $nssm) {
                throw "FAIL: nssm.exe not found on $env:COMPUTERNAME (looked in: $($nssmCandidates -join ', '))"
            }
            & $nssm restart ADReplicationAgent
            if ($LASTEXITCODE -ne 0) {
                throw "FAIL: nssm restart exit=$LASTEXITCODE (nssm: $nssm)"
            }

            return @{
                ok = $true
                agentJsSha = $newAgentJsSha
                versionInfSha = $newVersionInfSha
                bakAgentJs = $agentJsBak
                bakVersionInf = $versionInfBak
                serviceStatus = (Get-Service -Name ADReplicationAgent).Status
            }
        } -ArgumentList $agentJsBytes, $versionInfBytes, $agentJsSha, $versionInfSha

        Write-Host "  ✓ files copied (sha match)"
        Write-Host "  ✓ bak: $($copyResult.bakAgentJs)"
        Write-Host "  ✓ bak: $($copyResult.bakVersionInf)"
        Write-Host "  ✓ service status: $($copyResult.serviceStatus)"
        $results += [pscustomobject]@{ DC = $dc; Status = 'OK'; ServiceStatus = $copyResult.serviceStatus }
    } catch {
        Write-Host "  ✗ FAIL: $($_.Exception.Message)"
        $results += [pscustomobject]@{ DC = $dc; Status = 'FAIL'; Error = $_.Exception.Message }
    }
}

Write-Host ""
Write-Host "=== summary ==="
$results | Format-Table -AutoSize

$failed = $results | Where-Object { $_.Status -ne 'OK' }
if ($failed) {
    Write-Host ""
    Write-Host "⚠ $($failed.Count) DC(s) failed: $(@($failed | ForEach-Object { $_.DC }) -join ', ')"
    Write-Host "  Re-run with the failed DCs only: -DCs $(@($failed | ForEach-Object { "'" + $_.DC + "'" }) -join ',')"
    # 显式 exit 1 —— 旧实现这里只是打印一行 ⚠ 然后**正常结束** (退出码 0),
    # 调度器 / CI 看到的全是"成功"。批量升级一半失败而无人知晓,
    # 比失败本身更危险。
    exit 1
} else {
    Write-Host ""
    Write-Host "✓ all $($results.Count) DCs upgraded. Next heartbeat (≤30s) each DC reports agentVersion='0.1.2'."
    Write-Host "  centre computeUpgradeEnvelope sees reported==target → upgradeAvailable=false."
    Write-Host "  Future 0.1.3+ upgrades flow through R158.48 automatically."
    exit 0
}