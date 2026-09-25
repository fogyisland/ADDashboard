# MSI Agent Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained `addashboard-agent-x64-1.0.0.msi` (~55 MB) for AD Dashboard Agent installation — GUI dialogs for `CenterUrl + AgentToken + AgentType` and `msiexec /i ... /qn CENTERURL=... AGENTTOKEN=... AGENTTYPE=...` silent install — coexisting with the existing `install-agent.ps1` (which retains WinRM remote push).

**Architecture:** WiX 5 single-MSI build (no Burn wrapper, no chained prerequisites). MSI bundles Node 20 LTS x64 + agent source + NSSM 2.24 + node_modules + scripts. Basic UI dialogs drive MSI properties. A deferred managed C# custom action reads properties, writes `appsettings.json`, invokes bundled `nssm.exe install ADReplicationAgent`, sets all NSSM parameters, runs `sc.exe failure` recovery, and starts the service. Silent install supported via MSI properties. Uninstall uses a rollback companion CA to `nssm remove` before MSI deletes files. The existing `install-agent.ps1` is kept (unchanged behavior); spec-mirror CI test enforces NSSM parameter parity between the two paths.

**Tech Stack:** WiX 5 Toolset (NuGet `WixToolset.Sdk` package), C# .NET Framework 4.6.2 managed custom actions (preinstalled on Win 10 1607+ and Server 2016+ — no .NET bundle required), Node.js 20 LTS x64 (bundled), NSSM 2.24 (bundled, copied from `publish/nssm/nssm.exe`), xUnit for CA unit tests, Pester for E2E smoke, GitHub Actions `windows-2022` runner.

## Global Constraints

These constraints apply to every task. Every implementer should read this list before starting any task.

- **Single self-contained MSI** — zero network access at install time; Node.js binaries + node_modules + NSSM all bundled inside the .msi. No Burn wrapper, no chained prerequisites.
- **Coexistence with `install-agent.ps1`** — both install paths converge on the same service name `ADReplicationAgent` with identical NSSM configuration. Re-running either after the other must be idempotent (no "service already exists" error). Spec-mirror test (Task 10) enforces parameter parity.
- **WiX 5 + C# deferred CA** — `<CustomAction Id="..." BinaryRef="CA.dll" DllEntry="ConfigureAgent" />` deferred (`Impersonate="no"`, `Execute="deferred"`) for any operation requiring SYSTEM elevation. Immediate CA only for property packaging into `CustomActionData`.
- **CA DLL targets .NET Framework 4.6.2** — preinstalled on all supported OSes (Win 10 1607+, Server 2016+) without requiring Windows Update. C# language version 7.3 max. No dependency on .NET Core / .NET 5+ runtime.
- **NSSM is bundled in BOTH paths** — `publish/nssm/nssm.exe` already committed for the PS1 path; the MSI bundles its own copy at `<INSTALLDIR>\nssm\nssm.exe`. The two paths never collide.
- **x64 only, Windows 10 / Server 2016 minimum** — `<Package Platform="x64" InstallerVersion="500" />` and `<Condition Message="...">VersionNT64 >= 600</Condition>`. No ARM64 or x86.
- **Idempotency** — MSI re-install on existing install → service parameters refreshed (mirrors `Install-NssmService` PS1 behavior). `appsettings.json` and `queue.db` marked `NeverOverwrite="yes"`. `PRESERVE_APPSETTINGS=1` MSI property skips template-merge when caller wants existing settings to win.
- **Logs always to `C:\addashboard\Logs`** — NSSM `AppStdout`/`AppStderr` paths set by ConfigureAgentAction to `C:\addashboard\Logs\ADReplicationAgent-{stdout,stderr}.log` with 10 MB rotation (`AppRotateBytes=10485760`, `AppRotateFiles=1`, `AppRotateOnline=1`). Identical to PS1 installer.
- **No new third-party installers** — NSSM and Node.js binaries bundled, not downloaded at install time. Only `sc.exe` (built into Windows) is invoked externally.
- **Existing tests stay green** — center 811/0 + agent 60/60 must remain green after all tasks. New tests live in `installer/tests/`.
- **Out of scope (explicit non-goals)** — Code signing of the MSI; Burn/Bundle wrapper; automatic Node.js security patches; ARM64/x86 builds; MSI for center; custom domain user service account; pre-install reachability check to center; automatic uninstall of pre-existing PS1-installed agent.

---

## File Structure

**New files:**

```
installer/
├── agent-installer/                # WiX 5 MSI project (.csproj)
│   ├── AgentInstaller.csproj       # WixToolset.Sdk MSBuild project (x64, .NET 6 build host)
│   ├── Product.wxs                 # <Product>/<Package>/<Directory>/<MajorUpgrade>/<LaunchCondition>
│   ├── Files.wxs                   # <File> elements: agent/, node/, nssm/, scripts/, node_modules/
│   ├── Dialogs.wxs                 # Basic UI dialogs
│   ├── Properties.wxs              # CENTERURL/TOKEN/AGENTTYPE/SERVICECCOUNT/INSTALLDIR/PRESERVE_APPSETTINGS
│   ├── CustomActions.wxs           # <CustomAction> + <InstallExecuteSequence>
│   ├── ui/
│   │   └── WixUI_zh_CN.wxl         # Chinese localization strings
│   └── CA/                         # Custom Action C# source
│       ├── AgentInstaller.CA.csproj # .NET Framework 4.6.2 csproj
│       ├── ConfigureAgentAction.cs # Write appsettings.json + nssm.exe + sc.exe
│       └── RollbackAgentAction.cs  # Uninstall: nssm remove
├── staging/                        # Build-time staging (gitignored)
│   ├── agent/                      # cp from ../../agent/ (minus tests + appsettings.json)
│   ├── node/                       # extracted from node-v20.x.x-win-x64.zip
│   ├── nssm/nssm.exe               # cp from ../../publish/nssm/nssm.exe
│   ├── node_modules/               # npm install --omit=dev output
│   └── appsettings.template.json   # template consumed by ConfigureAgentAction
├── build-msi.cmd                   # Windows batch entry: wix build → .msi
├── build-msi.ps1                   # PowerShell 5.1 mirror
└── tests/
    ├── AgentInstaller.CA.Tests/    # xUnit tests for the C# custom action DLL
    │   ├── AgentInstaller.CA.Tests.csproj
    │   └── ConfigureAgentActionTests.cs
    └── msi-smoke.ps1               # Pester E2E: install MSI → verify → uninstall
```

**Modified files:**

```
scripts/install-agent.ps1           # Add header comment pointing to MSI as primary path
docs/operations/deployment.md       # Add §Agent MSI Installation before §Agent Deployment
.gitignore                          # Add installer/staging/, installer/agent-installer/bin/, *.msi
.github/workflows/                  # New file: msi-ci.yml (build MSI + run smoke on windows-2022)
```

**Files NOT touched (kept as-is):**

- `publish/nssm/nssm.exe` — already bundled for the PS1 path
- `agent/*` — source unchanged; MSI just packages it
- `agent/package.json`, `agent/package-lock.json` — used by build-msi.cmd; not modified
- `scripts/uninstall-agent.ps1`, `scripts/update-agent.ps1` — work as-is for both MSI-installed and PS1-installed agents (operate by service name)
- `scripts/common/*` modules — used by PS1 installer unchanged

---

## Task 1: Project scaffold + first MSI build

**Files:**
- Create: `installer/agent-installer/AgentInstaller.csproj`
- Create: `installer/agent-installer/Product.wxs`
- Create: `installer/build-msi.cmd`
- Create: `installer/build-msi.ps1`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: A buildable WiX 5 project that produces an empty (no-files) .msi artifact with Win 10/Server 2016 minimum check and `UpgradeCode` set.

- [ ] **Step 1: Add `installer/staging/` and `installer/agent-installer/bin/` to `.gitignore`**

Append to `.gitignore`:
```
# MSI installer staging (build-time only, regenerated by build-msi.cmd)
installer/staging/
installer/agent-installer/bin/
installer/agent-installer/obj/
*.msi
```

- [ ] **Step 2: Create `installer/agent-installer/AgentInstaller.csproj`**

```xml
<Project Sdk="WixToolset.Sdk/5.0.0">
  <PropertyGroup>
    <OutputType>Package</OutputType>
    <Platforms>x64</Platforms>
    <TargetFramework>net8.0</TargetFramework>
    <ProductName>AD Dashboard Agent</ProductName>
    <ProductVersion>1.0.0.0</ProductVersion>
    <ProductCode>{B5C7E17B-1234-4567-89AB-CDEF01234567}</ProductCode>
    <UpgradeCode>{C6D8E28C-2345-5678-9ABC-DEF123456789}</UpgradeCode>
    <Manufacturer>AD Dashboard</Manufacturer>
    <OutputName>addashboard-agent-x64-$(ProductVersion)</OutputName>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="WixToolset.UI.wixext" Version="5.0.0" />
    <PackageReference Include="WixToolset.Util.wixext" Version="5.0.0" />
  </ItemGroup>
</Project>
```

Notes: `ProductCode` and `UpgradeCode` are fixed GUIDs (regenerate locally with `[guid]::NewGuid()` if you want different ones; the values here are placeholders that will work for development).

- [ ] **Step 3: Create `installer/agent-installer/Product.wxs`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"
     xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Package Name="$(var.ProductName)"
           Version="$(var.ProductVersion)"
           Manufacturer="$(var.Manufacturer)"
           UpgradeCode="$(var.UpgradeCode)"
           ProductCode="$(var.ProductCode)"
           Platform="x64"
           InstallerVersion="500"
           Language="2052"
           SummaryCodepage="UTF-8">
    <MajorUpgrade Schedule="afterInstallInitialize"
                  DowngradeErrorMessage="A newer version of $(var.ProductName) is already installed."
                  AllowSameVersionUpgrades="no" />

    <LaunchCondition Message="AD Dashboard Agent requires Windows 10 / Server 2016 or later (x64)."
                     Condition="VersionNT64 >= 600 AND (VersionNT >= 100 OR (VersionNT = 600 AND VersionNT64 >= 600))" />

    <Media Id="1" Cabinet="agent" EmbedCab="yes" CompressionLevel="high" />

    <Feature Id="AgentFeature" Title="AD Dashboard Agent" Level="1">
      <ComponentGroupRef Id="AgentComponents" />
    </Feature>

    <UI>
      <ui:WixUI Id="WixUI_Minimal" LocalizationFile="ui\WixUI_zh_CN.wxl" />
      <Publish Dialog="ExitDialog"
               Control="Finish"
               Event="DoAction"
               Value="LaunchReadme">1</Publish>
    </UI>

    <Property Id="WIXUI_INSTALLDIR" Value="C:\addashboard\Agent" />
  </Package>
</Wix>
```

Notes: `Language="2052"` is Simplified Chinese (zh-CN); `WixUI_Minimal` is a built-in minimal UI dialog set we will extend in Task 6.

- [ ] **Step 4: Create a minimal `Files.wxs` (empty for now — populated in Task 2)**

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <!-- Task 2 will populate this with agent/* + scripts/* + appsettings.template.json -->
    <!-- Task 3 will add node/ + node_modules/ -->
    <!-- Task 4 will add nssm/ -->
    <ComponentGroup Id="AgentComponents">
      <!-- placeholder, filled in later tasks -->
    </ComponentGroup>
  </Fragment>
</Wix>
```

- [ ] **Step 5: Create `installer/build-msi.cmd`**

```cmd
@echo off
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%\installer\agent-installer"
dotnet build -c Release -p:Platform=x64
if errorlevel 1 ( popd & exit /b 1 )
popd
endlocal
```

- [ ] **Step 6: Create `installer/build-msi.ps1`** (PowerShell 5.1 compat)

```powershell
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location (Join-Path $root 'installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }
```

- [ ] **Step 7: Build the empty MSI**

Run from repo root:
```powershell
.\installer\build-msi.ps1
```
Expected: exit 0; `installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi` exists.

- [ ] **Step 8: Verify .msi has LaunchCondition**

Run:
```powershell
& "C:\Program Files (x86)\WiX Toolset v3.14\bin\dark.exe" -x installer\msi-dump installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi
```
Expected: `installer\msi-dump\LaunchCondition` row contains the Win 10/Server 2016 message.

Note: If dark.exe is unavailable (WiX 5 ships a different inspection tool), use `dotnet tool install -g wixtoolset.Inspector` and run `inspector msi <msi-path>`. Acceptable to skip this step if inspection tool is not yet installed — visual inspection of the .wxs is sufficient evidence the LaunchCondition is set.

- [ ] **Step 9: Commit**

```bash
git add installer/ .gitignore
git commit -m "feat(msi): scaffold WiX 5 project + first empty MSI build"
```

---

## Task 2: Bundle agent source files + scripts + appsettings template

**Files:**
- Modify: `installer/agent-installer/Files.wxs`
- Create: `installer/staging/appsettings.template.json` (build-time copy)
- Create: `installer/build-msi.ps1` extension (copy step)

**Interfaces:**
- Consumes: Task 1's `AgentInstaller.csproj` and `build-msi.cmd`/`.ps1`
- Produces: After install, `<INSTALLDIR>\agent.js`, `<INSTALLDIR>\src\…`, `<INSTALLDIR>\scripts\collect-replication.ps1`, `<INSTALLDIR>\scripts\collect-discovery.ps1`, `<INSTALLDIR>\package.json`, `<INSTALLDIR>\appsettings.template.json` all exist.

- [ ] **Step 1: Add staging copy step to `installer/build-msi.ps1`**

Replace `installer/build-msi.ps1` with:

```powershell
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging = Join-Path $root 'installer\staging'

# 1. Stage agent source (exclude tests + appsettings.json + node_modules)
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force }
Copy-Item -Path (Join-Path $agentSrc '*') -Destination $agentDst -Recurse -Force `
  -Exclude 'node_modules','tests','appsettings.json','package-lock.json'

# 2. Stage appsettings.template.json
$templateDst = Join-Path $staging 'appsettings.template.json'
@'
{
  "centerUrl": "CHANGEME",
  "agentId": "AUTO_HOSTNAME",
  "agentToken": "CHANGEME",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "heartbeatIntervalSeconds": 5,
  "discoveryIntervalHours": 4,
  "queueDbPath": "INSTALLDIR\\queue.db",
  "psScriptPath": "INSTALLDIR\\scripts\\collect-replication.ps1",
  "psDiscoveryScriptPath": "INSTALLDIR\\scripts\\collect-discovery.ps1",
  "healthCheckIntervalMs": 600000,
  "agentType": "ad"
}
'@ | Set-Content -Path $templateDst -Encoding UTF8 -NoNewline

Push-Location (Join-Path $root 'installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }
```

Notes: `CHANGEME` and `AUTO_HOSTNAME` and `INSTALLDIR` are placeholders that `ConfigureAgentAction` (Task 4) will substitute. `package-lock.json` is excluded — we only ship `package.json` so `node_modules` (bundled in Task 3) is the authoritative dependency tree.

- [ ] **Step 2: Update `Files.wxs` to bundle the staged agent files**

Replace `installer/agent-installer/Files.wxs` with:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="INSTALLDIR">
      <Component Id="Agent.AppsettingsTemplate" Guid="{D7E9F3A1-1111-2222-3333-444455556666}">
        <File Id="Agent.AppsettingsTemplate.File"
              Source="$(var.StagingDir)\appsettings.template.json"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="INSTALLDIR.agent">
      <Component Id="Agent.Main" Guid="{D7E9F3A1-2222-3333-4444-555566667777}">
        <File Id="Agent.Main.File"
              Source="$(var.StagingDir)\agent\agent.js"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="INSTALLDIR.agent.src">
      <Component Id="Agent.Src" Guid="{D7E9F3A1-3333-4444-5555-666677778888}">
        <File Id="Agent.Src.File"
              Source="$(var.StagingDir)\agent\src"
              KeyPath="yes">
          <!-- Recursively harvest files from agent\src\* via -harvest flag below;
               or list explicitly if harvester is not yet wired -->
        </File>
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="INSTALLDIR.scripts">
      <Component Id="Agent.Scripts.Replication" Guid="{D7E9F3A1-4444-5555-6666-777788889999}">
        <File Id="Agent.Scripts.Replication.File"
              Source="$(var.StagingDir)\agent\scripts\collect-replication.ps1"
              KeyPath="yes" />
      </Component>
      <Component Id="Agent.Scripts.Discovery" Guid="{D7E9F3A1-5555-6666-7777-888899990000}">
        <File Id="Agent.Scripts.Discovery.File"
              Source="$(var.StagingDir)\agent\scripts\collect-discovery.ps1"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <ComponentGroup Id="AgentComponents">
      <ComponentRef Id="Agent.AppsettingsTemplate" />
      <ComponentRef Id="Agent.Main" />
      <ComponentRef Id="Agent.Src" />
      <ComponentRef Id="Agent.Scripts.Replication" />
      <ComponentRef Id="Agent.Scripts.Discovery" />
    </ComponentGroup>
  </Fragment>
</Wix>
```

- [ ] **Step 3: Define directory tree + `StagingDir` variable in `Product.wxs`**

Add this just before the closing `</Package>` in `installer/agent-installer/Product.wxs`:

```xml
    <Fragment>
      <StandardDirectory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="addashboard">
          <Directory Id="INSTALLDIR.agent" Name="Agent">
            <Directory Id="INSTALLDIR.agent.src" Name="src" />
            <Directory Id="INSTALLDIR.scripts" Name="scripts" />
          </Directory>
        </Directory>
      </StandardDirectory>
    </Fragment>

    <Property Id="StagingDir" Value="..\staging" />
```

Move the `<Feature>`, `<UI>`, `<Property Id="WIXUI_INSTALLDIR" …>`, and other elements that are inside `<Package>` so they remain inside `<Package>`. The `<Fragment>` should be a sibling of `<Package>`, not nested inside it. Final structure:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"
     xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Package Name="$(var.ProductName)"
           Version="$(var.ProductVersion)"
           Manufacturer="$(var.Manufacturer)"
           UpgradeCode="$(var.UpgradeCode)"
           ProductCode="$(var.ProductCode)"
           Platform="x64"
           InstallerVersion="500"
           Language="2052"
           SummaryCodepage="UTF-8">
    <MajorUpgrade Schedule="afterInstallInitialize"
                  DowngradeErrorMessage="A newer version of $(var.ProductName) is already installed."
                  AllowSameVersionUpgrades="no" />

    <LaunchCondition Message="AD Dashboard Agent requires Windows 10 / Server 2016 or later (x64)."
                     Condition="VersionNT64 >= 600 AND (VersionNT >= 100 OR (VersionNT = 600 AND VersionNT64 >= 600))" />

    <Media Id="1" Cabinet="agent" EmbedCab="yes" CompressionLevel="high" />

    <Feature Id="AgentFeature" Title="AD Dashboard Agent" Level="1">
      <ComponentGroupRef Id="AgentComponents" />
    </Feature>

    <UI>
      <ui:WixUI Id="WixUI_Minimal" LocalizationFile="ui\WixUI_zh_CN.wxl" />
    </UI>

    <Property Id="WIXUI_INSTALLDIR" Value="C:\addashboard\Agent" />
  </Package>

  <Fragment>
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLDIR" Name="addashboard">
        <Directory Id="INSTALLDIR.agent" Name="Agent">
          <Directory Id="INSTALLDIR.agent.src" Name="src" />
          <Directory Id="INSTALLDIR.scripts" Name="scripts" />
        </Directory>
      </Directory>
    </StandardDirectory>

    <Property Id="StagingDir" Value="..\staging" />
  </Fragment>
</Wix>
```

- [ ] **Step 4: Update `build-msi.ps1` to rebuild staging each time**

Replace `installer/build-msi.ps1` with:

```powershell
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging = Join-Path $root 'installer\staging'

# 1. Stage agent source
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force }
Copy-Item -Path (Join-Path $agentSrc '*') -Destination $agentDst -Recurse -Force `
  -Exclude 'node_modules','tests','appsettings.json','package-lock.json'

# 2. Stage appsettings.template.json
$templateDst = Join-Path $staging 'appsettings.template.json'
@'
{
  "centerUrl": "CHANGEME",
  "agentId": "AUTO_HOSTNAME",
  "agentToken": "CHANGEME",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "heartbeatIntervalSeconds": 5,
  "discoveryIntervalHours": 4,
  "queueDbPath": "INSTALLDIR\\queue.db",
  "psScriptPath": "INSTALLDIR\\scripts\\collect-replication.ps1",
  "psDiscoveryScriptPath": "INSTALLDIR\\scripts\\collect-discovery.ps1",
  "healthCheckIntervalMs": 600000,
  "agentType": "ad"
}
'@ | Set-Content -Path $templateDst -Encoding UTF8 -NoNewline

Push-Location (Join-Path $root 'installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }
```

(This is the same content as Step 1's update — Step 1 was the in-place update to add the staging step; this Step 4 is just re-verifying the file is in its final state.)

- [ ] **Step 5: Build the MSI**

Run:
```powershell
.\installer\build-msi.ps1
```
Expected: exit 0; .msi builds successfully.

- [ ] **Step 6: Smoke-test install on a clean Windows VM or your dev box**

Run (replace `<INSTALLDIR>` with `C:\addashboard\Agent` or a test path):
```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step2.log"
```
Expected: exit 0. Verify files:
```powershell
Test-Path "C:\addashboard\Agent\agent.js"            # True
Test-Path "C:\addashboard\Agent\appsettings.template.json" # True
Test-Path "C:\addashboard\Agent\scripts\collect-replication.ps1" # True
Test-Path "C:\addashboard\Agent\scripts\collect-discovery.ps1"   # True
Test-Path "C:\addashboard\Agent\src"                 # True (directory)
Get-ChildItem "C:\addashboard\Agent\src" -Recurse | Measure-Object # count > 0
```

Verify the service is NOT yet registered (Task 4 adds that):
```powershell
Get-Service ADReplicationAgent -ErrorAction SilentlyContinue  # $null
```

- [ ] **Step 7: Uninstall + cleanup**

```powershell
msiexec /x installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn
Remove-Item "C:\addashboard\Agent" -Recurse -Force  # clean test residue
```

Expected: exit 0; `C:\addashboard\Agent` is gone.

- [ ] **Step 8: Commit**

```bash
git add installer/build-msi.ps1 installer/agent-installer/Product.wxs installer/agent-installer/Files.wxs
git commit -m "feat(msi): bundle agent source + scripts + appsettings template"
```

---

## Task 3: Bundle Node.js 20 LTS runtime + node_modules

**Files:**
- Modify: `installer/build-msi.ps1` (add Node download + npm install steps)
- Modify: `installer/agent-installer/Product.wxs` (add node + node_modules dirs)
- Modify: `installer/agent-installer/Files.wxs` (add node + node_modules File elements)

**Interfaces:**
- Consumes: Task 2's staging + Files.wxs
- Produces: After install, `<INSTALLDIR>\node\node.exe` works (`node -v` → `v20.x.x`) and `node -e "require('axios')"` succeeds from `<INSTALLDIR>`.

- [ ] **Step 1: Add Node.js download + npm install to `build-msi.ps1`**

Replace `installer/build-msi.ps1` with:

```powershell
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging = Join-Path $root 'installer\staging'

# 1. Stage agent source
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force }
Copy-Item -Path (Join-Path $agentSrc '*') -Destination $agentDst -Recurse -Force `
  -Exclude 'node_modules','tests','appsettings.json','package-lock.json'

# 2. Stage appsettings.template.json
$templateDst = Join-Path $staging 'appsettings.template.json'
@'
{
  "centerUrl": "CHANGEME",
  "agentId": "AUTO_HOSTNAME",
  "agentToken": "CHANGEME",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "heartbeatIntervalSeconds": 5,
  "discoveryIntervalHours": 4,
  "queueDbPath": "INSTALLDIR\\queue.db",
  "psScriptPath": "INSTALLDIR\\scripts\\collect-replication.ps1",
  "psDiscoveryScriptPath": "INSTALLDIR\\scripts\\collect-discovery.ps1",
  "healthCheckIntervalMs": 600000,
  "agentType": "ad"
}
'@ | Set-Content -Path $templateDst -Encoding UTF8 -NoNewline

# 3. Stage Node.js 20 LTS x64 (download once; idempotent)
$nodeDir = Join-Path $staging 'node'
$nodeVersion = '20.18.0'  # latest 20.x LTS at time of writing; bump via #node-lts-version in code
$nodeZipUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
$nodeZip = Join-Path $env:TEMP "node-v$nodeVersion-win-x64.zip"
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  if (-not (Test-Path $nodeZip)) {
    Write-Host "Downloading Node.js $nodeVersion from $nodeZipUrl"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZip -UseBasicParsing
  }
  $extract = Join-Path $env:TEMP "node-extract"
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $nodeZip -DestinationPath $extract -Force
  # The zip extracts to node-v20.x.x-win-x64/; move contents up one level
  $inner = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item -Path $inner.FullName -Destination $nodeDir
  Remove-Item $extract -Recurse -Force
  Remove-Item $nodeZip -Force
}

# 4. Stage node_modules (npm install --omit=dev, idempotent)
$nodeModulesDst = Join-Path $staging 'node_modules'
$agentStagedDir = Join-Path $staging 'agent'
if (-not (Test-Path $nodeModulesDst)) {
  Push-Location $agentStagedDir
  try {
    # Ensure package-lock.json is present (we excluded it from copy earlier; copy now from source)
    Copy-Item -Path (Join-Path $root 'agent\package-lock.json') -Destination . -Force
    npm install --omit=dev --no-audit --no-fund --silent
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }
}

Push-Location (Join-Path $root 'installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }
```

- [ ] **Step 2: Add `node\` and `node_modules\` to the directory tree in `Product.wxs`**

In `installer/agent-installer/Product.wxs`, update the `<Fragment>`:

```xml
  <Fragment>
    <StandardDirectory Id="ProgramFiles64Folder">
      <Directory Id="INSTALLDIR" Name="addashboard">
        <Directory Id="INSTALLDIR.agent" Name="Agent">
          <Directory Id="INSTALLDIR.agent.src" Name="src" />
          <Directory Id="INSTALLDIR.agent.node" Name="node" />
          <Directory Id="INSTALLDIR.agent.node_modules" Name="node_modules" />
          <Directory Id="INSTALLDIR.scripts" Name="scripts" />
        </Directory>
      </Directory>
    </StandardDirectory>

    <Property Id="StagingDir" Value="..\staging" />
  </Fragment>
```

- [ ] **Step 3: Add Node + node_modules `<File>` elements to `Files.wxs`**

Add these inside the `<Fragment>` of `installer/agent-installer/Files.wxs` (just before the closing `</Fragment>`):

```xml
    <DirectoryRef Id="INSTALLDIR.agent.node">
      <Component Id="Agent.Node" Guid="{D7E9F3A1-6666-7777-8888-999900001111}">
        <File Id="Agent.Node.Exe"
              Source="$(var.StagingDir)\node\node.exe"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="INSTALLDIR.agent.node_modules">
      <Component Id="Agent.NodeModules" Guid="{D7E9F3A1-7777-8888-9999-000011112222}">
        <File Id="Agent.NodeModules.Marker"
              Source="$(var.StagingDir)\node_modules\.package-lock.json"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>
```

And add to the `<ComponentGroup Id="AgentComponents">`:
```xml
      <ComponentRef Id="Agent.Node" />
      <ComponentRef Id="Agent.NodeModules" />
```

**Important:** WiX does not natively harvest entire directories. To ship `node_modules\axios\…` etc., we use WiX 5's `<File>` with `Source` pointing to a directory — this is supported in WiX 5 via the `harvest` pattern. Add `xmlns:harvest="http://wixtoolset.org/schemas/v4/wxs/harvest"` to the `<Wix>` root element and replace the `<File Id="Agent.NodeModules.Marker">` block with:

```xml
      <Component Id="Agent.NodeModules" Guid="{D7E9F3A1-7777-8888-9999-000011112222}">
        <harvest:Directory HarvestDirectory="$(var.StagingDir)\node_modules" />
      </Component>
```

If `harvest` is not supported in your WiX 5 build host, fall back to explicit per-package `<File>` elements (one per top-level dependency in `agent\package.json`: `axios`, `better-sqlite3`, `pino`, plus their transitive deps). Document the chosen approach in the commit message.

- [ ] **Step 4: Build**

Run:
```powershell
.\installer\build-msi.ps1
```
Expected: First run downloads Node ~35 MB (1-2 min) and runs `npm install` (~30 sec). Subsequent runs are fast (cached). Final `addashboard-agent-x64-1.0.0.msi` is ~55 MB.

- [ ] **Step 5: Smoke-test install + verify Node works**

```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step3.log"

# Verify files exist
Test-Path "C:\addashboard\Agent\node\node.exe"           # True
Test-Path "C:\addashboard\Agent\node_modules\axios"      # True
Test-Path "C:\addashboard\Agent\node_modules\axios\package.json"  # True

# Verify Node runs
& "C:\addashboard\Agent\node\node.exe" -v                # v20.18.0

# Verify a dep loads (this proves node_modules is wired correctly)
Push-Location "C:\addashboard\Agent"
& ".\node\node.exe" -e "console.log(require('axios').VERSION || 'axios loaded')"
Pop-Location
# Expected: some axios version string printed; no "Cannot find module" error

# Cleanup
msiexec /x installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn
Remove-Item "C:\addashboard\Agent" -Recurse -Force
```

- [ ] **Step 6: Commit**

```bash
git add installer/build-msi.ps1 installer/agent-installer/Product.wxs installer/agent-installer/Files.wxs
git commit -m "feat(msi): bundle Node.js 20 LTS x64 + node_modules (npm install)"
```

---

## Task 4: ConfigureAgentAction — appsettings.json + NSSM service registration

**Files:**
- Create: `installer/agent-installer/CA/AgentInstaller.CA.csproj`
- Create: `installer/agent-installer/CA/ConfigureAgentAction.cs`
- Modify: `installer/agent-installer/AgentInstaller.csproj` (reference CA project + register CAs)
- Create: `installer/agent-installer/CustomActions.wxs`
- Modify: `installer/agent-installer/Product.wxs` (reference CustomActions.wxs + InstallExecuteSequence)

**Interfaces:**
- Consumes: Task 3's bundle (NSSM will be added to bundle in this task); MSI properties `CENTERURL`, `AGENTTOKEN`, `AGENTTYPE`, `SERVICECCOUNT`, `INSTALLDIR`, `PRESERVE_APPSETTINGS`
- Produces: After install, `appsettings.json` exists with correct keys; service `ADReplicationAgent` registered and Running; `sc.exe qfailure ADReplicationAgent` shows `reset= 60 actions= restart/5000/restart/10000/restart/30000`

- [ ] **Step 1: Add NSSM to staging step in `build-msi.ps1`**

Add a step that copies `publish\nssm\nssm.exe` to `staging\nssm\nssm.exe`:

```powershell
# 5. Stage NSSM (copy from publish/nssm)
$nssmSrc = Join-Path $root 'publish\nssm\nssm.exe'
$nssmDstDir = Join-Path $staging 'nssm'
$nssmDst = Join-Path $nssmDstDir 'nssm.exe'
if (-not (Test-Path $nssmDst)) {
  if (-not (Test-Path $nssmSrc)) {
    throw "publish/nssm/nssm.exe not found. Run scripts/common/Ensure-Nssm.ps1 to download it."
  }
  if (-not (Test-Path $nssmDstDir)) { New-Item -ItemType Directory -Path $nssmDstDir -Force | Out-Null }
  Copy-Item -Path $nssmSrc -Destination $nssmDst -Force
}
```

Insert this between Step 4 (npm install) and the dotnet build call.

- [ ] **Step 2: Add `nssm\` directory to `Product.wxs` and `<File>` to `Files.wxs`**

In `Product.wxs`'s `<Fragment>`, add the `nssm` directory:
```xml
          <Directory Id="INSTALLDIR.agent.nssm" Name="nssm" />
```

In `Files.wxs`, add a new `<Component>`:
```xml
    <DirectoryRef Id="INSTALLDIR.agent.nssm">
      <Component Id="Agent.Nssm" Guid="{D7E9F3A1-8888-9999-0000-111122223333}">
        <File Id="Agent.Nssm.Exe"
              Source="$(var.StagingDir)\nssm\nssm.exe"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>
```

And add `<ComponentRef Id="Agent.Nssm" />` to `<ComponentGroup Id="AgentComponents">`.

- [ ] **Step 3: Create `installer/agent-installer/CA/AgentInstaller.CA.csproj`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props"
          Condition="Exists('$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props')" />
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Release</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">x64</Platform>
    <ProjectGuid>{D7E9F3A1-AAAA-BBBB-CCCC-DDDDEEEEFFFF}</ProjectGuid>
    <OutputType>Library</OutputType>
    <RootNamespace>ADDashboard.AgentInstaller.CA</RootNamespace>
    <AssemblyName>ADDashboard.AgentInstaller.CA</AssemblyName>
    <TargetFrameworkVersion>v4.6.2</TargetFrameworkVersion>
    <FileAlignment>512</FileAlignment>
    <Deterministic>true</Deterministic>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="System" />
    <Reference Include="System.Core" />
    <Reference Include="Microsoft.Deployment.WindowsInstaller" />
    <Reference Include="System.Configuration.Install" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Deployment.WindowsInstaller" Version="5.0.0" />
  </ItemGroup>
  <ItemGroup>
    <Compile Include="ConfigureAgentAction.cs" />
  </ItemGroup>
</Project>
```

- [ ] **Step 4: Create `installer/agent-installer/CA/ConfigureAgentAction.cs`**

```csharp
using System;
using System.IO;
using System.Text;
using Microsoft.Deployment.WindowsInstaller;

namespace ADDashboard.AgentInstaller.CA
{
    public class ConfigureAgentData
    {
        public string InstallDir;
        public string CenterUrl;
        public string AgentToken;
        public string AgentType;
        public string ServiceAccount;
        public bool PreserveAppsettings;
        public string LogDir = @"C:\addashboard\Logs";
    }

    public static class ConfigureAgentAction
    {
        [CustomAction]
        public static ActionResult ConfigureAgent(Session session)
        {
            try
            {
                var data = ParseCustomActionData(session.CustomActionData);
                Validate(data);

                WriteAppsettingsJson(data);

                RegisterNssmService(data);
                SetNssmParameters(data);
                SetServiceRecovery(data);
                StartServiceBestEffort(data);

                return ActionResult.Success;
            }
            catch (InstallException ex)
            {
                session.Log("ConfigureAgent failed: {0}", ex.Message);
                return ActionResult.Failure;
            }
            catch (Exception ex)
            {
                session.Log("ConfigureAgent unexpected error: {0}\n{1}", ex.Message, ex.StackTrace);
                return ActionResult.Failure;
            }
        }

        internal static ConfigureAgentData ParseCustomActionData(string cad)
        {
            var data = new ConfigureAgentData();
            if (string.IsNullOrEmpty(cad)) return data;

            foreach (var line in cad.Split('\n'))
            {
                var idx = line.IndexOf('=');
                if (idx < 0) continue;
                var key = line.Substring(0, idx).Trim();
                var val = line.Substring(idx + 1).Trim();
                switch (key)
                {
                    case "INSTALLDIR":    data.InstallDir = val; break;
                    case "CENTERURL":     data.CenterUrl = val; break;
                    case "AGENTTOKEN":    data.AgentToken = val; break;
                    case "AGENTTYPE":     data.AgentType = val; break;
                    case "SERVICECCOUNT": data.ServiceAccount = val; break;
                    case "PRESERVE_APPSETTINGS":
                        data.PreserveAppsettings = (val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase));
                        break;
                }
            }
            data.ServiceAccount = string.IsNullOrEmpty(data.ServiceAccount) ? "NetworkService" : data.ServiceAccount;
            return data;
        }

        internal static void Validate(ConfigureAgentData data)
        {
            if (string.IsNullOrWhiteSpace(data.CenterUrl) ||
                !Uri.TryCreate(data.CenterUrl, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new InstallException($"CENTERURL property missing or invalid: '{data.CenterUrl}' (must be absolute http/https URI)");

            if (string.IsNullOrWhiteSpace(data.AgentToken) || data.AgentToken.Length < 16)
                throw new InstallException($"AGENTTOKEN property missing or too short ({data.AgentToken?.Length ?? 0} chars; minimum 16)");

            if (data.AgentType != "ad" && data.AgentType != "non-ad")
                throw new InstallException($"AGENTTYPE must be 'ad' or 'non-ad' (got '{data.AgentType}')");

            if (data.ServiceAccount != "NetworkService" && data.ServiceAccount != "LocalSystem")
                throw new InstallException($"SERVICECCOUNT must be 'NetworkService' or 'LocalSystem' (got '{data.ServiceAccount}')");
        }

        internal static void WriteAppsettingsJson(ConfigureAgentData data)
        {
            var path = Path.Combine(data.InstallDir, "appsettings.json");
            var hostname = Environment.MachineName;

            if (data.PreserveAppsettings && File.Exists(path))
                return;

            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine($"  \"centerUrl\": \"{EscapeJson(data.CenterUrl)}\",");
            sb.AppendLine($"  \"agentId\": \"{EscapeJson(hostname)}\",");
            sb.AppendLine($"  \"agentToken\": \"{EscapeJson(data.AgentToken)}\",");
            sb.AppendLine("  \"logLevel\": \"info\",");
            sb.AppendLine("  \"pollingIntervalMinutes\": 15,");
            sb.AppendLine("  \"heartbeatIntervalSeconds\": 5,");
            sb.AppendLine("  \"discoveryIntervalHours\": 4,");
            sb.AppendLine($"  \"queueDbPath\": \"{EscapeJson(Path.Combine(data.InstallDir, "queue.db"))}\",");
            sb.AppendLine($"  \"psScriptPath\": \"{EscapeJson(Path.Combine(data.InstallDir, "scripts", "collect-replication.ps1"))}\",");
            sb.AppendLine($"  \"psDiscoveryScriptPath\": \"{EscapeJson(Path.Combine(data.InstallDir, "scripts", "collect-discovery.ps1"))}\",");
            sb.AppendLine("  \"healthCheckIntervalMs\": 600000,");
            sb.AppendLine($"  \"agentType\": \"{EscapeJson(data.AgentType)}\"");
            sb.AppendLine("}");

            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        internal static void RegisterNssmService(ConfigureAgentData data)
        {
            var nssm = Path.Combine(data.InstallDir, "nssm", "nssm.exe");
            if (!File.Exists(nssm))
                throw new InstallException($"nssm.exe not found at {nssm}");

            var node = Path.Combine(data.InstallDir, "node", "node.exe");
            if (!File.Exists(node))
                throw new InstallException($"node.exe not found at {node}");

            // nssm install is idempotent: if service exists, it returns non-zero.
            // We check first to avoid spurious failure on reinstall.
            var svcExists = RunProcessCapture("sc.exe", "query ADReplicationAgent");
            if (svcExists.IndexOf("does not exist", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                var rc = RunProcess(nssm, $"install ADReplicationAgent \"{node}\" agent.js");
                if (rc != 0)
                    throw new InstallException($"nssm install failed with exit {rc}");
            }
        }

        internal static void SetNssmParameters(ConfigureAgentData data)
        {
            var nssm = Path.Combine(data.InstallDir, "nssm", "nssm.exe");
            var hostname = Environment.MachineName;
            var displayName = data.AgentType == "non-ad"
                ? "AD Dashboard Agent (Member)"
                : $"AD Replication Agent (on {hostname})";
            var description = data.AgentType == "non-ad"
                ? "AD Dashboard member-server monitor (self-register + heartbeat + package fetch)"
                : "AD Replication collection agent";

            RunNssmSet(nssm, "AppDirectory",         data.InstallDir);
            RunNssmSet(nssm, "AppParameters",        "agent.js");
            RunNssmSet(nssm, "DisplayName",          displayName);
            RunNssmSet(nssm, "Description",          description);
            RunNssmSet(nssm, "Start",                "SERVICE_AUTO_START");
            RunNssmSet(nssm, "DependOnService",      "DNS Client,Netlogon");
            RunNssmSet(nssm, "AppStdout",            Path.Combine(data.LogDir, "ADReplicationAgent-stdout.log"));
            RunNssmSet(nssm, "AppStderr",            Path.Combine(data.LogDir, "ADReplicationAgent-stderr.log"));
            RunNssmSet(nssm, "AppRotateFiles",       "1");
            RunNssmSet(nssm, "AppRotateOnline",      "1");
            RunNssmSet(nssm, "AppRotateBytes",       "10485760");
            RunNssmSet(nssm, "AppEnvironmentExtra",  "NODE_ENV=production");
            RunNssmSet(nssm, "ObjectName",           $".\\{data.ServiceAccount}");
        }

        internal static void SetServiceRecovery(ConfigureAgentData data)
        {
            // sc.exe failure <svc> reset= <seconds> actions= restart/<ms>/restart/<ms>/restart/<ms>
            var args = "failure ADReplicationAgent reset= 60 actions= restart/5000/restart/10000/restart/30000";
            var rc = RunProcess("sc.exe", args);
            if (rc != 0)
                throw new InstallException($"sc.exe failure setup failed with exit {rc}");
        }

        internal static void StartServiceBestEffort(ConfigureAgentData data)
        {
            var rc = RunProcess("sc.exe", "start ADReplicationAgent");
            if (rc != 0)
            {
                // Not fatal — network may be unreachable, center may not yet accept this agent.
                // The center marks an agent as stale if no heartbeat within stale_seconds.
                System.Diagnostics.Debug.WriteLine($"sc.exe start returned {rc}; service may not be reachable to center yet");
            }
        }

        internal static int RunProcess(string exe, string args)
        {
            using (var p = new System.Diagnostics.Process())
            {
                p.StartInfo.FileName = exe;
                p.StartInfo.Arguments = args;
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.CreateNoWindow = true;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.RedirectStandardError = true;
                p.Start();
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        internal static string RunProcessCapture(string exe, string args)
        {
            using (var p = new System.Diagnostics.Process())
            {
                p.StartInfo.FileName = exe;
                p.StartInfo.Arguments = args;
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.CreateNoWindow = true;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.RedirectStandardError = true;
                p.Start();
                var output = p.StandardOutput.ReadToEnd();
                p.WaitForExit();
                return output;
            }
        }

        internal static void RunNssmSet(string nssm, string key, string value)
        {
            var rc = RunProcess(nssm, $"set ADReplicationAgent {key} \"{value}\"");
            if (rc != 0)
                throw new InstallException($"nssm set {key} failed with exit {rc}");
        }

        internal static string EscapeJson(string s)
        {
            return s == null ? "" : s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
```

- [ ] **Step 5: Update `installer/agent-installer/AgentInstaller.csproj` to reference the CA project**

Add inside the `<ItemGroup>` block (the existing `PackageReference` group):

```xml
    <ProjectReference Include="CA\AgentInstaller.CA.csproj" />
```

The WiX 5 SDK auto-detects the referenced project's `AssemblyName` and embeds it as a binary stream in the .msi for the `<CustomAction BinaryRef="..."/>` reference.

- [ ] **Step 6: Create `installer/agent-installer/CustomActions.wxs`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"
     xmlns:ca="http://wixtoolset.org/schemas/v4/wxs/ca">
  <Fragment>
    <!-- Package the CA DLL as a binary stream -->
    <Binary Id="CA.dll" SourceFile="$(var.CA.TargetPath)" />

    <!-- Immediate CA: read MSI properties into CustomActionData string for the deferred CA -->
    <CustomAction Id="ScheduleConfigureAgent"
                  Return="check"
                  Property="ConfigureAgent"
                  Value="INSTALLDIR=[INSTALLDIR];CENTERURL=[CENTERURL];AGENTTOKEN=[AGENTTOKEN];AGENTTYPE=[AGENTTYPE];SERVICECCOUNT=[SERVICECCOUNT];PRESERVE_APPSETTINGS=[PRESERVE_APPSETTINGS]" />

    <!-- Deferred CA: runs in SYSTEM context, reads CustomActionData -->
    <CustomAction Id="ConfigureAgent"
                  BinaryRef="CA.dll"
                  DllEntry="ConfigureAgent"
                  Execute="deferred"
                  Impersonate="no"
                  Return="check" />

    <!-- Rollback companion: runs if deferred CA fails -->
    <CustomAction Id="RollbackAgent"
                  BinaryRef="CA.dll"
                  DllEntry="RollbackAgent"
                  Execute="rollback"
                  Impersonate="no"
                  Return="ignore" />

    <InstallExecuteSequence>
      <Custom Action="ScheduleConfigureAgent" After="InstallFiles">NOT Installed OR REINSTALL</Custom>
      <Custom Action="ConfigureAgent" After="ScheduleConfigureAgent"><![CDATA[NOT Installed OR REINSTALL]]></Custom>
      <Custom Action="RollbackAgent" Before="ConfigureAgent"><![CDATA[NOT Installed OR REINSTALL]]></Custom>
    </InstallExecuteSequence>
  </Fragment>
</Wix>
```

- [ ] **Step 7: Add `<Property>` definitions for CENTERURL, AGENTTOKEN, AGENTTYPE, SERVICECCOUNT, PRESERVE_APPSETTINGS to `Product.wxs`**

Add inside `<Package>` (after `<Property Id="WIXUI_INSTALLDIR" ...>`):

```xml
    <Property Id="CENTERURL" />
    <Property Id="AGENTTOKEN" />
    <Property Id="AGENTTYPE" Value="ad" />
    <Property Id="SERVICECCOUNT" Value="NetworkService" />
    <Property Id="PRESERVE_APPSETTINGS" Value="0" />
```

- [ ] **Step 8: Create a stub `RollbackAgentAction.cs`** (full implementation comes in Task 5; this stub lets the build succeed)

Create `installer/agent-installer/CA/RollbackAgentAction.cs`:

```csharp
using Microsoft.Deployment.WindowsInstaller;

namespace ADDashboard.AgentInstaller.CA
{
    public static class RollbackAgentAction
    {
        [CustomAction]
        public static ActionResult RollbackAgent(Session session)
        {
            // Full implementation in Task 5 — for now, a no-op so the build succeeds.
            return ActionResult.Success;
        }
    }
}
```

And add `<Compile Include="RollbackAgentAction.cs" />` to `AgentInstaller.CA.csproj`'s `<ItemGroup>`.

- [ ] **Step 9: Build**

```powershell
.\installer\build-msi.ps1
```
Expected: exit 0; MSI builds successfully with CA DLL embedded.

- [ ] **Step 10: Smoke-test the full install with all properties**

```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step4.log" `
  CENTERURL="http://test-center:8081" `
  AGENTTOKEN="test-token-1234567890abcdef" `
  AGENTTYPE="ad" `
  SERVICECCOUNT="NetworkService"
```
Expected: exit 0.

Verify:
```powershell
# Service registered and running
Get-Service ADReplicationAgent
# Status: Running

# NSSM params correct
& "C:\addashboard\Agent\nssm\nssm.exe" get ADReplicationAgent DisplayName
# AD Replication Agent (on <hostname>)

# Recovery set
sc.exe qfailure ADReplicationAgent
# Should show "reset= 60 actions= restart/5000/restart/10000/restart/30000"

# appsettings.json
Get-Content "C:\addashboard\Agent\appsettings.json"
# Should have all required keys with the values passed
```

- [ ] **Step 11: Test idempotent re-install**

```powershell
# Run the same install again
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step4b.log" `
  CENTERURL="http://test-center:8081" `
  AGENTTOKEN="test-token-1234567890abcdef" `
  AGENTTYPE="ad"
```
Expected: exit 0; service stays Running (not Started/Stopped cycle); `appsettings.json` overwritten with same values.

- [ ] **Step 12: Cleanup (we'll uninstall cleanly in Task 5)**

Don't uninstall yet — Task 5 needs the service to exist so it can verify RollbackAgent cleans it up.

- [ ] **Step 13: Commit**

```bash
git add installer/agent-installer/CA/ installer/agent-installer/CustomActions.wxs installer/agent-installer/AgentInstaller.csproj installer/agent-installer/Product.wxs installer/build-msi.ps1
git commit -m "feat(msi): ConfigureAgentAction — appsettings.json + NSSM service register + recovery"
```

---

## Task 5: RollbackAgentAction + uninstall flow

**Files:**
- Modify: `installer/agent-installer/CA/RollbackAgentAction.cs` (replace stub with full implementation)

**Interfaces:**
- Consumes: Task 4's CA project + service registration
- Produces: After uninstall, `Get-Service ADReplicationAgent` returns `$null`; `C:\addashboard\Agent\` is empty (or only has preserved files: appsettings.json, queue.db)

- [ ] **Step 1: Replace `installer/agent-installer/CA/RollbackAgentAction.cs` with:**

```csharp
using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Deployment.WindowsInstaller;

namespace ADDashboard.AgentInstaller.CA
{
    public static class RollbackAgentAction
    {
        [CustomAction]
        public static ActionResult RollbackAgent(Session session)
        {
            try
            {
                var installDir = session.CustomActionData["INSTALLDIR"];
                if (string.IsNullOrEmpty(installDir))
                    return ActionResult.Success;  // nothing to do

                var nssm = Path.Combine(installDir, "nssm", "nssm.exe");
                if (!File.Exists(nssm))
                    return ActionResult.Success;  // already removed

                var psi = new ProcessStartInfo
                {
                    FileName = nssm,
                    Arguments = "remove ADReplicationAgent confirm",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    p.WaitForExit();
                    // ignore exit code: nssm may return non-zero if service doesn't exist
                }

                return ActionResult.Success;
            }
            catch (Exception ex)
            {
                session.Log("RollbackAgent non-fatal error: {0}", ex.Message);
                return ActionResult.Success;  // rollback should never fail the install
            }
        }
    }
}
```

- [ ] **Step 2: Build**

```powershell
.\installer\build-msi.ps1
```
Expected: exit 0.

- [ ] **Step 3: Uninstall the existing install (from Task 4 step 10) and verify service is gone**

```powershell
msiexec /x installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step5.log"
```
Expected: exit 0.

Verify:
```powershell
Get-Service ADReplicationAgent -ErrorAction SilentlyContinue
# $null (service gone)

Get-ChildItem "C:\addashboard\Agent" -Recurse -ErrorAction SilentlyContinue | Measure-Object
# 0 (all files removed by MSI)
```

If `appsettings.json` was preserved (NeverOverwrite):
```powershell
Test-Path "C:\addashboard\Agent\appsettings.json"  # True
```

(Note: We haven't set `NeverOverwrite="yes"` yet — that's Task 9. For now, MSI removes everything.)

Cleanup the preserved file:
```powershell
Remove-Item "C:\addashboard\Agent" -Recurse -Force
```

- [ ] **Step 4: Verify install + uninstall round-trip**

```powershell
# Install
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step5b-install.log" `
  CENTERURL="http://test-center:8081" AGENTTOKEN="test-token-1234567890abcdef" AGENTTYPE="ad"

# Verify service registered
Get-Service ADReplicationAgent   # Running

# Uninstall
msiexec /x installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step5b-uninstall.log"

# Verify service gone
Get-Service ADReplicationAgent -ErrorAction SilentlyContinue   # $null

Remove-Item "C:\addashboard\Agent" -Recurse -Force
```

Expected: both phases exit 0; service exists after install, gone after uninstall.

- [ ] **Step 5: Commit**

```bash
git add installer/agent-installer/CA/RollbackAgentAction.cs
git commit -m "feat(msi): RollbackAgentAction — cleans NSSM service on uninstall + rollback"
```

---

## Task 6: GUI dialogs (Welcome + AgentType + CenterConfig + InstallDir) + property validation

**Files:**
- Create: `installer/agent-installer/Dialogs.wxs`
- Create: `installer/agent-installer/Properties.wxs`
- Create: `installer/agent-installer/ui/WixUI_zh_CN.wxl`

**Interfaces:**
- Consumes: Task 5's MSI artifact (properties pass through to ConfigureAgentAction)
- Produces: GUI flow Welcome → AgentType → CenterConfig → InstallDir → Progress → Exit. Silent install still works with property validation in CA.

- [ ] **Step 1: Create `installer/agent-installer/ui/WixUI_zh_CN.wxl`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<WixLocalization Culture="zh-CN" xmlns="http://wixtoolset.org/schemas/v4/wxl">
  <String Id="WelcomeDlgTitle">欢迎使用 AD Dashboard Agent 安装向导</String>
  <String Id="WelcomeDlgDescription">安装向导将在您的计算机上安装 [ProductName]。&#x0a;&#x0a;此安装程序需要管理员权限,并将注册 Windows 服务 "ADReplicationAgent"。</String>
  <String Id="AgentTypeDlgTitle">选择 Agent 类型</String>
  <String Id="AgentTypeDlgDescription">请选择此 Agent 的运行模式:&#x0a;&#x0a;ad — 域控 (DC) 上的复制状态收集器&#x0a;&#x0a;non-ad — 成员服务器监控器 (自注册 + 包拉取 + 心跳)</String>
  <String Id="CenterConfigDlgTitle">配置中心连接</String>
  <String Id="CenterConfigDlgDescription">输入中心服务器 URL 和共享的 Agent Token。&#x0a;&#x0a;CenterUrl 示例: http://center:8081&#x0a;&#x0a;AgentToken 从中心 appsettings.json 的 agentToken 字段获取</String>
  <String Id="InstallDirDlgTitle">选择安装位置</String>
  <String Id="InstallDirDlgDescription">选择 AD Dashboard Agent 的安装文件夹。</String>
  <String Id="ExitDlgTitle">安装完成</String>
  <String Id="ExitDlgDescription">AD Dashboard Agent 已安装并启动。&#x0a;&#x0a;查看服务运行状态: Get-Service ADReplicationAgent&#x0a;&#x0a;在中心查看 Agent 是否在线: GET /api/dashboard/agents</String>
</WixLocalization>
```

- [ ] **Step 2: Create `installer/agent-installer/Dialogs.wxs`**

This defines the dialog flow. WiX 5 has built-in dialogs we extend; the simplest approach is to use `WixUI_Advanced` (which has a sequence: Welcome → InstallDir → …) plus a custom dialog for AgentType + CenterConfig.

```xml
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"
     xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Fragment>
    <UI>
      <Dialog Id="AgentTypeDlg" Width="370" Height="270" Title="!(loc.AgentTypeDlgTitle)">
        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="下一步(&amp;N)" />
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Text="取消(&amp;C)">
          <Publish Event="SpawnDialog" Value="CancelDlg">1</Publish>
        </Control>
        <Control Id="Description" Type="Text" X="9" Y="23" Width="354" Height="60" Text="!(loc.AgentTypeDlgDescription)" />
        <Control Id="Title" Type="Text" X="9" Y="6" Width="354" Height="15" Text="!(loc.AgentTypeDlgTitle)" />
        <Control Id="BannerBitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="44" Text="!(loc.AgentTypeDlgTitle)" />
        <Control Id="BannerLine" Type="Line" X="0" Y="44" Width="370" Height="0" />
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0" />
        <Control Id="AgentTypeAd" Type="RadioButtonGroup" X="20" Y="100" Width="330" Height="80" Property="AGENTTYPE">
          <RadioButtonGroup>
            <RadioButton Value="ad"     X="0" Y="0"  Width="330" Height="40" Text="ad — 域控 (DC) 上的复制状态收集器" />
            <RadioButton Value="non-ad" X="0" Y="40" Width="330" Height="40" Text="non-ad — 成员服务器监控器" />
          </RadioButtonGroup>
        </Control>
      </Dialog>

      <Dialog Id="CenterConfigDlg" Width="370" Height="270" Title="!(loc.CenterConfigDlgTitle)">
        <Control Id="Next" Type="PushButton" X="236" Y="243" Width="56" Height="17" Default="yes" Text="下一步(&amp;N)">
          <Publish Event="DoAction" Value="ValidateProperties">1</Publish>
        </Control>
        <Control Id="Back" Type="PushButton" X="180" Y="243" Width="56" Height="17" Text="上一步(&amp;B)" />
        <Control Id="Cancel" Type="PushButton" X="304" Y="243" Width="56" Height="17" Cancel="yes" Text="取消(&amp;C)">
          <Publish Event="SpawnDialog" Value="CancelDlg">1</Publish>
        </Control>
        <Control Id="Description" Type="Text" X="9" Y="23" Width="354" Height="60" Text="!(loc.CenterConfigDlgDescription)" />
        <Control Id="Title" Type="Text" X="9" Y="6" Width="354" Height="15" Text="!(loc.CenterConfigDlgTitle)" />
        <Control Id="BannerBitmap" Type="Bitmap" X="0" Y="0" Width="370" Height="44" />
        <Control Id="BannerLine" Type="Line" X="0" Y="44" Width="370" Height="0" />
        <Control Id="BottomLine" Type="Line" X="0" Y="234" Width="370" Height="0" />
        <Control Id="CenterUrlLabel" Type="Text" X="20" Y="100" Width="80" Height="15" Text="CenterUrl:" />
        <Control Id="CenterUrlEdit"  Type="Edit" X="100" Y="97" Width="240" Height="18" Property="CENTERURL" />
        <Control Id="AgentTokenLabel" Type="Text" X="20" Y="130" Width="80" Height="15" Text="AgentToken:" />
        <Control Id="AgentTokenEdit"  Type="Edit" X="100" Y="127" Width="240" Height="18" Property="AGENTTOKEN" Password="yes" />
        <Control Id="ServiceAccountLabel" Type="Text" X="20" Y="160" Width="80" Height="15" Text="服务账号:" />
        <Control Id="ServiceAccountCombo" Type="ComboBox" X="100" Y="157" Width="240" Height="18" Property="SERVICECCOUNT">
          <ComboBox>
            <ListItem Value="NetworkService" Text="NetworkService (默认)" />
            <ListItem Value="LocalSystem"    Text="LocalSystem" />
          </ComboBox>
        </Control>
      </Dialog>
    </UI>

    <!-- Reorder WixUI_Advanced dialog sequence to include our custom dialogs -->
    <InstallUISequence>
      <Show Dialog="WelcomeDlg" Before="AgentTypeDlg">NOT Installed</Show>
      <Show Dialog="AgentTypeDlg" Before="CenterConfigDlg">NOT Installed</Show>
      <Show Dialog="CenterConfigDlg" Before="InstallDirDlg">NOT Installed</Show>
    </InstallUISequence>
  </Fragment>
</Wix>
```

- [ ] **Step 3: Update `Product.wxs` to use the advanced UI and reference Dialogs.wxs**

In `installer/agent-installer/Product.wxs`, change the `<UI>` section:

```xml
    <UI>
      <ui:WixUI Id="WixUI_Advanced" LocalizationFile="ui\WixUI_zh_CN.wxl" />
    </UI>
```

And add a `Dialogs.wxs` reference (WiX 5 auto-discovers `.wxs` files in the project directory; no manual reference needed).

- [ ] **Step 4: Add property default validation (silent install reject) to ConfigureAgentAction**

The `Validate()` method in `ConfigureAgentAction.cs` (Task 4 Step 4) already handles this. Verify the existing implementation is intact:

```csharp
internal static void Validate(ConfigureAgentData data)
{
    if (string.IsNullOrWhiteSpace(data.CenterUrl) ||
        !Uri.TryCreate(data.CenterUrl, UriKind.Absolute, out var uri) ||
        (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        throw new InstallException($"CENTERURL property missing or invalid: '{data.CenterUrl}' (must be absolute http/https URI)");

    if (string.IsNullOrWhiteSpace(data.AgentToken) || data.AgentToken.Length < 16)
        throw new InstallException($"AGENTTOKEN property missing or too short ({data.AgentToken?.Length ?? 0} chars; minimum 16)");

    if (data.AgentType != "ad" && data.AgentType != "non-ad")
        throw new InstallException($"AGENTTYPE must be 'ad' or 'non-ad' (got '{data.AgentType}')");

    if (data.ServiceAccount != "NetworkService" && data.ServiceAccount != "LocalSystem")
        throw new InstallException($"SERVICECCOUNT must be 'NetworkService' or 'LocalSystem' (got '{data.ServiceAccount}')");
}
```

If you need to add a new validation rule (e.g. AGENTTOKEN max length), edit the existing method.

- [ ] **Step 5: Build**

```powershell
.\installer\build-msi.ps1
```
Expected: exit 0; .msi builds with new dialog flow.

- [ ] **Step 6: Test silent install with valid + invalid properties**

Valid:
```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step6-valid.log" `
  CENTERURL="http://test-center:8081" AGENTTOKEN="test-token-1234567890abcdef" AGENTTYPE="ad"
```
Expected: exit 0.

Invalid CENTERURL:
```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step6-badurl.log" `
  CENTERURL="not-a-url" AGENTTOKEN="test-token-1234567890abcdef" AGENTTYPE="ad"
```
Expected: exit 1603; `msi-step6-badurl.log` contains "CENTERURL property missing or invalid".

Too-short AGENTTOKEN:
```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step6-shorttoken.log" `
  CENTERURL="http://test-center:8081" AGENTTOKEN="short" AGENTTYPE="ad"
```
Expected: exit 1603; log contains "AGENTTOKEN property missing or too short".

Bad AGENTTYPE:
```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env\TEMP\msi-step6-badtype.log" `
  CENTERURL="http://test-center:8081" AGENTTOKEN="test-token-1234567890abcdef" AGENTTYPE="foo"
```
Expected: exit 1603; log contains "AGENTTYPE must be 'ad' or 'non-ad'".

Cleanup:
```powershell
msiexec /x installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn
Remove-Item "C:\addashboard\Agent" -Recurse -Force
```

- [ ] **Step 7: Manual GUI smoke on a Windows VM**

Document a manual test: double-click the .msi, walk through Welcome → AgentType → CenterConfig → InstallDir → Progress → Exit. Verify each dialog shows the expected text from `WixUI_zh_CN.wxl`. The dialogs MUST be visible (this is not testable in CI without a Windows GUI test runner).

Capture screenshots of each dialog and commit them to `installer/tests/screenshots/` (gitignored) for visual reference. **Skip if no Windows GUI available** — document in commit message that GUI test is manual-only.

- [ ] **Step 8: Commit**

```bash
git add installer/agent-installer/Dialogs.wxs installer/agent-installer/Properties.wxs installer/agent-installer/Product.wxs installer/agent-installer/ui/
git commit -m "feat(msi): GUI dialogs (Welcome/AgentType/CenterConfig/InstallDir) + zh-CN strings"
```

---

## Task 7: Major upgrade + appsettings.json preservation

**Files:**
- Modify: `installer/agent-installer/Files.wxs` (add `NeverOverwrite="yes"` to appsettings.json)
- Modify: `installer/agent-installer/CA/ConfigureAgentAction.cs` (preserve appsettings.json when `PRESERVE_APPSETTINGS=1`)

**Interfaces:**
- Consumes: Task 6's MSI artifact
- Produces: Install v1.0.0, then v1.0.1; appsettings.json on v1.0.0 untouched (or, if user explicitly passes `PRESERVE_APPSETTINGS=1`, config preserved across the upgrade).

- [ ] **Step 1: Update `<File>` for appsettings.json in `Files.wxs` to mark `NeverOverwrite="yes"`**

In `installer/agent-installer/Files.wxs`, change the `<File Id="Agent.AppsettingsTemplate.File">` to a new `<Component>` for the runtime file, and add `NeverOverwrite="yes"`:

```xml
    <DirectoryRef Id="INSTALLDIR">
      <Component Id="Agent.AppsettingsTemplate" Guid="{D7E9F3A1-1111-2222-3333-444455556666}">
        <File Id="Agent.AppsettingsTemplate.File"
              Source="$(var.StagingDir)\appsettings.template.json"
              KeyPath="yes" />
      </Component>
      <Component Id="Agent.Appsettings" Guid="{D7E9F3A1-BBBB-CCCC-DDDD-EEEEFFFF0000}">
        <File Id="Agent.Appsettings.File"
              Name="appsettings.json"
              Source="$(var.StagingDir)\appsettings.template.json"
              NeverOverwrite="yes"
              KeyPath="yes" />
      </Component>
    </DirectoryRef>
```

Add `<ComponentRef Id="Agent.Appsettings" />` to `<ComponentGroup Id="AgentComponents">`.

The first component (`Agent.AppsettingsTemplate`) installs `appsettings.template.json` (the literal copy from staging). The second (`Agent.Appsettings`) installs `appsettings.json` (with `NeverOverwrite`). At install time, if `appsettings.json` doesn't exist yet, the template gets copied to `appsettings.json` (because `<File Source=...>` maps `Source` content to `Name` regardless). If `appsettings.json` already exists, `NeverOverwrite` prevents the copy.

- [ ] **Step 2: Update `ConfigureAgentAction.WriteAppsettingsJson` to respect `PRESERVE_APPSETTINGS`**

The existing implementation in Task 4 Step 4 already handles this:

```csharp
if (data.PreserveAppsettings && File.Exists(path))
    return;
```

No change needed; verify the method contains this check.

- [ ] **Step 3: Build v1.0.0**

Set `<ProductVersion>1.0.0.0</ProductVersion>` in `installer/agent-installer/AgentInstaller.csproj`. Run:
```powershell
.\installer\build-msi.ps1
```
Expected: `addashboard-agent-x64-1.0.0.msi` produced.

- [ ] **Step 4: Install v1.0.0 with test data**

```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\msi-step7-v100-install.log" `
  CENTERURL="http://v100-center:8081" AGENTTOKEN="v100-token-1234567890abcdef" AGENTTYPE="ad"

# Verify v1.0.0 appsettings
Get-Content "C:\addashboard\Agent\appsettings.json"
# centerUrl: http://v100-center:8081
# agentToken: v100-token-1234567890abcdef
```

- [ ] **Step 5: Bump version to 1.0.1 in `AgentInstaller.csproj`**

Edit `installer/agent-installer/AgentInstaller.csproj`:
```xml
    <ProductVersion>1.0.1.0</ProductVersion>
```

Build v1.0.1:
```powershell
.\installer\build-msi.ps1
```
Expected: `addashboard-agent-x64-1.0.1.msi` produced.

- [ ] **Step 6: Upgrade install with PRESERVE_APPSETTINGS=1**

```powershell
msiexec /i installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.1.msi /qn /l*v "$env:TEMP\msi-step7-v101-upgrade.log" `
  PRESERVE_APPSETTINGS="1"
```
Expected: exit 0.

Verify:
```powershell
Get-Content "C:\addashboard\Agent\appsettings.json"
# centerUrl: http://v100-center:8081  (UNCHANGED)
# agentToken: v100-token-1234567890abcdef  (UNCHANGED)

# Service still running
Get-Service ADReplicationAgent   # Running
```

- [ ] **Step 7: Cleanup**

```powershell
msiexec /x installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.1.msi /qn
Remove-Item "C:\addashboard\Agent" -Recurse -Force
```

- [ ] **Step 8: Commit**

```bash
git add installer/agent-installer/Files.wxs installer/agent-installer/AgentInstaller.csproj
git commit -m "feat(msi): major upgrade + appsettings.json preservation via NeverOverwrite + PRESERVE_APPSETTINGS"
```

---

## Task 8: C# custom action unit tests (xUnit)

**Files:**
- Create: `installer/tests/AgentInstaller.CA.Tests/AgentInstaller.CA.Tests.csproj`
- Create: `installer/tests/AgentInstaller.CA.Tests/ConfigureAgentActionTests.cs`
- Create: `installer/tests/AgentInstaller.CA.Tests/RollbackAgentActionTests.cs`
- Modify: `.github/workflows/` (covered in Task 11)

**Interfaces:**
- Consumes: Task 4's `ConfigureAgentAction.cs` + `RollbackAgentAction.cs`
- Produces: `dotnet test` exits 0 with 13+ tests passing.

- [ ] **Step 1: Create `installer/tests/AgentInstaller.CA.Tests/AgentInstaller.CA.Tests.csproj`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props"
          Condition="Exists('$(MSBuildExtensionsPath)\$(MSBuildToolsVersion)\Microsoft.Common.props')" />
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Release</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">x64</Platform>
    <ProjectGuid>{D7E9F3A1-CCCC-DDDD-EEEE-FFFF00001111}</ProjectGuid>
    <OutputType>Library</OutputType>
    <RootNamespace>ADDashboard.AgentInstaller.CA.Tests</RootNamespace>
    <AssemblyName>ADDashboard.AgentInstaller.CA.Tests</AssemblyName>
    <TargetFrameworkVersion>v4.6.2</TargetFrameworkVersion>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <ProjectReference Include="..\..\agent-installer\CA\AgentInstaller.CA.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Create `installer/tests/AgentInstaller.CA.Tests/ConfigureAgentActionTests.cs`**

```csharp
using System;
using System.IO;
using ADDashboard.AgentInstaller.CA;
using Xunit;

namespace ADDashboard.AgentInstaller.CA.Tests
{
    public class ConfigureAgentActionTests
    {
        private ConfigureAgentData MakeValidData() => new ConfigureAgentData
        {
            InstallDir = Path.Combine(Path.GetTempPath(), "agent-test-" + Guid.NewGuid().ToString("N")),
            CenterUrl = "http://test-center:8081",
            AgentToken = "test-token-1234567890abcdef",
            AgentType = "ad",
            ServiceAccount = "NetworkService",
            PreserveAppsettings = false
        };

        [Fact]
        public void Validate_ValidData_DoesNotThrow()
        {
            ConfigureAgentAction.Validate(MakeValidData());
        }

        [Theory]
        [InlineData("")]
        [InlineData("not-a-url")]
        [InlineData("ftp://center")]
        [InlineData(null)]
        public void Validate_InvalidCenterUrl_Throws(string url)
        {
            var d = MakeValidData();
            d.CenterUrl = url;
            Assert.Throws<InstallException>(() => ConfigureAgentAction.Validate(d));
        }

        [Theory]
        [InlineData("")]
        [InlineData("short")]
        [InlineData(null)]
        public void Validate_TooShortAgentToken_Throws(string token)
        {
            var d = MakeValidData();
            d.AgentToken = token;
            Assert.Throws<InstallException>(() => ConfigureAgentAction.Validate(d));
        }

        [Theory]
        [InlineData("foo")]
        [InlineData("AD")]
        [InlineData("Non-Ad")]
        [InlineData("")]
        public void Validate_InvalidAgentType_Throws(string type)
        {
            var d = MakeValidData();
            d.AgentType = type;
            Assert.Throws<InstallException>(() => ConfigureAgentAction.Validate(d));
        }

        [Theory]
        [InlineData("Administrator")]
        [InlineData("LocalService")]
        [InlineData("")]
        public void Validate_InvalidServiceAccount_Throws(string account)
        {
            var d = MakeValidData();
            d.ServiceAccount = account;
            Assert.Throws<InstallException>(() => ConfigureAgentAction.Validate(d));
        }

        [Fact]
        public void WriteAppsettingsJson_WritesAllRequiredKeys()
        {
            var d = MakeValidData();
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                var path = Path.Combine(d.InstallDir, "appsettings.json");
                Assert.True(File.Exists(path));
                var text = File.ReadAllText(path);
                Assert.Contains("\"centerUrl\"", text);
                Assert.Contains("\"agentToken\"", text);
                Assert.Contains("\"agentType\": \"ad\"", text);
                Assert.Contains("\"pollingIntervalMinutes\": 15", text);
                Assert.Contains("\"heartbeatIntervalSeconds\": 5", text);
                Assert.Contains("\"discoveryIntervalHours\": 4", text);
                Assert.Contains("collect-replication.ps1", text);
                Assert.Contains("collect-discovery.ps1", text);
            }
            finally { Directory.Delete(d.InstallDir, true); }
        }

        [Fact]
        public void WriteAppsettingsJson_AgentType_NonAd_WritesNonAdConfig()
        {
            var d = MakeValidData();
            d.AgentType = "non-ad";
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                var text = File.ReadAllText(Path.Combine(d.InstallDir, "appsettings.json"));
                Assert.Contains("\"agentType\": \"non-ad\"", text);
            }
            finally { Directory.Delete(d.InstallDir, true); }
        }

        [Fact]
        public void WriteAppsettingsJson_PreserveAppsettings_True_ExistingFile_Untouched()
        {
            var d = MakeValidData();
            d.PreserveAppsettings = true;
            Directory.CreateDirectory(d.InstallDir);
            var path = Path.Combine(d.InstallDir, "appsettings.json");
            File.WriteAllText(path, "{\"existing\":\"config\"}");
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                Assert.Equal("{\"existing\":\"config\"}", File.ReadAllText(path));
            }
            finally { Directory.Delete(d.InstallDir, true); }
        }

        [Fact]
        public void WriteAppsettingsJson_PreserveAppsettings_True_NoExistingFile_WritesNew()
        {
            var d = MakeValidData();
            d.PreserveAppsettings = true;
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                Assert.True(File.Exists(Path.Combine(d.InstallDir, "appsettings.json")));
            }
            finally { Directory.Delete(d.InstallDir, true); }
        }

        [Fact]
        public void ParseCustomActionData_ParsesAllKeys()
        {
            var cad = "INSTALLDIR=C:\\addashboard\\Agent\nCENTERURL=http://c:8081\nAGENTTOKEN=t\nAGENTTYPE=ad\nSERVICECCOUNT=NetworkService\nPRESERVE_APPSETTINGS=1\n";
            var d = ConfigureAgentAction.ParseCustomActionData(cad);
            Assert.Equal("C:\\addashboard\\Agent", d.InstallDir);
            Assert.Equal("http://c:8081", d.CenterUrl);
            Assert.Equal("t", d.AgentToken);
            Assert.Equal("ad", d.AgentType);
            Assert.Equal("NetworkService", d.ServiceAccount);
            Assert.True(d.PreserveAppsettings);
        }

        [Fact]
        public void ParseCustomActionData_EmptyString_DefaultsToValidData()
        {
            var d = ConfigureAgentAction.ParseCustomActionData("");
            Assert.Null(d.CenterUrl);
            Assert.Equal("NetworkService", d.ServiceAccount);  // default
        }
    }
}
```

- [ ] **Step 3: Create `installer/tests/AgentInstaller.CA.Tests/RollbackAgentActionTests.cs`**

```csharp
using ADDashboard.AgentInstaller.CA;
using Xunit;

namespace ADDashboard.AgentInstaller.CA.Tests
{
    public class RollbackAgentActionTests
    {
        [Fact]
        public void Type_HasCustomActionAttribute()
        {
            // The CustomAction attribute is what makes the method discoverable by Windows Installer.
            // RollbackAgent is the public static method invoked by MSI.
            var method = typeof(RollbackAgentAction).GetMethod("RollbackAgent");
            Assert.NotNull(method);
            Assert.True(method.IsPublic);
            Assert.True(method.IsStatic);
        }
    }
}
```

- [ ] **Step 4: Run tests**

From repo root:
```powershell
dotnet test installer\tests\AgentInstaller.CA.Tests\AgentInstaller.CA.Tests.csproj -c Release
```
Expected: 13+ tests pass; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add installer/tests/
git commit -m "test(msi): xUnit tests for ConfigureAgentAction + RollbackAgentAction (13 tests)"
```

---

## Task 9: Pester E2E smoke test

**Files:**
- Create: `installer/tests/msi-smoke.ps1`
- Modify: `installer/agent-installer/AgentInstaller.csproj` (no functional change; just confirms version is 1.0.0 for the smoke test)

**Interfaces:**
- Consumes: Task 7's working MSI artifact (`addashboard-agent-x64-1.0.0.msi`)
- Produces: 7 Pester tests pass on a Windows Server 2022 (or any supported) machine.

- [ ] **Step 1: Create `installer/tests/msi-smoke.ps1`**

```powershell
<#
.SYNOPSIS
  Pester E2E smoke for AD Dashboard Agent MSI installer.
.DESCRIPTION
  Assumes the MSI has been built at $env:MSI_PATH. Tests:
    - silent install succeeds
    - expected files exist
    - service ADReplicationAgent is registered and Running
    - appsettings.json has correct keys
    - sc.exe qfailure shows the expected recovery config
    - silent uninstall succeeds
    - appsettings.json preserved (NeverOverwrite) after uninstall
#>
[CmdletBinding()]
param(
  [string]$MsiPath = "$PSScriptRoot\..\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi",
  [string]$InstallDir = 'C:\addashboard\Agent',
  [string]$CenterUrl = 'http://test-center:8081',
  [string]$AgentToken = 'test-token-1234567890abcdef',
  [string]$AgentType = 'ad',
  [string]$LogPath = "$env:TEMP\msi-smoke.log"
)

BeforeAll {
  if (-not (Test-Path $MsiPath)) {
    throw "MSI not found at $MsiPath. Build first: .\installer\build-msi.ps1"
  }
}

Describe 'MSI Agent Installer smoke' {
  It 'installs MSI silently with all required properties' {
    $p = Start-Process msiexec -ArgumentList @(
      '/i', $MsiPath, '/qn', '/l*v', $LogPath,
      'CENTERURL', $CenterUrl,
      'AGENTTOKEN', $AgentToken,
      'AGENTTYPE', $AgentType,
      'INSTALLDIR', $InstallDir
    ) -Wait -PassThru -NoNewWindow
    $p.ExitCode | Should -Be 0
  }

  It 'creates expected files in INSTALLDIR' {
    "$InstallDir\agent.js"             | Should -Exist
    "$InstallDir\node\node.exe"        | Should -Exist
    "$InstallDir\nssm\nssm.exe"        | Should -Exist
    "$InstallDir\appsettings.json"     | Should -Exist
    "$InstallDir\scripts\collect-replication.ps1" | Should -Exist
    "$InstallDir\scripts\collect-discovery.ps1"   | Should -Exist
  }

  It 'registers NSSM service ADReplicationAgent as Running' {
    $svc = Get-Service ADReplicationAgent -ErrorAction Stop
    $svc.Status | Should -Be 'Running'
  }

  It 'writes appsettings.json with correct keys' {
    $cfg = Get-Content "$InstallDir\appsettings.json" -Raw | ConvertFrom-Json
    $cfg.centerUrl           | Should -Be $CenterUrl
    $cfg.agentToken          | Should -Be $AgentToken
    $cfg.agentType           | Should -Be $AgentType
    $cfg.pollingIntervalMinutes | Should -Be 15
    $cfg.heartbeatIntervalSeconds | Should -Be 5
    $cfg.psScriptPath        | Should -BeLike '*\scripts\collect-replication.ps1'
    $cfg.psDiscoveryScriptPath | Should -BeLike '*\scripts\collect-discovery.ps1'
  }

  It 'sets NSSM recovery via sc.exe failure' {
    $out = sc.exe qfailure ADReplicationAgent | Out-String
    $out | Should -Match 'reset= 60'
    $out | Should -Match 'restart'
  }

  It 'uninstalls cleanly' {
    $p = Start-Process msiexec -ArgumentList @('/x', $MsiPath, '/qn') -Wait -PassThru -NoNewWindow
    $p.ExitCode | Should -Be 0
    Get-Service ADReplicationAgent -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
  }

  It 'preserves appsettings.json after uninstall (NeverOverwrite)' {
    "$InstallDir\appsettings.json" | Should -Exist
    Remove-Item $InstallDir -Recurse -Force  # cleanup
  }
}
```

- [ ] **Step 2: Build MSI**

```powershell
.\installer\build-msi.ps1
```

- [ ] **Step 3: Install Pester if not present**

```powershell
Install-Module -Name Pester -Force -SkipPublisherCheck -Scope CurrentUser
```

- [ ] **Step 4: Run smoke (on Windows Server 2022 / Windows 10 / Windows 11)**

```powershell
Invoke-Pester -Path installer\tests\msi-smoke.ps1 -Output Detailed
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add installer/tests/msi-smoke.ps1
git commit -m "test(msi): Pester E2E smoke (install / verify / uninstall, 7 tests)"
```

---

## Task 10: Spec-mirror NSSM config drift test

**Files:**
- Create: `installer/tests/spec-mirror-tests.ps1` (Pester)

**Interfaces:**
- Consumes: Task 4's `ConfigureAgentAction.cs` + existing `scripts/common/NSSM.psm1` + `scripts/common/Service.psm1`
- Produces: 1 Pester test that fails if the C# CA's `nssm set` parameter keys diverge from the PS1 installer's parameter keys.

- [ ] **Step 1: Create `installer/tests/spec-mirror-tests.ps1`**

```powershell
<#
.SYNOPSIS
  Spec-mirror drift test: ensures the C# CA's NSSM parameters
  match the PS1 installer's NSSM parameters. Both install paths must
  converge on identical service configuration.
#>
[CmdletBinding()]
param()

Describe 'NSSM spec mirror between MSI CA and install-agent.ps1' {
  BeforeAll {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $caSource = Join-Path $repoRoot 'installer\agent-installer\CA\ConfigureAgentAction.cs'
    $psModule = Join-Path $repoRoot 'scripts\common\NSSM.psm1'
    $svcModule = Join-Path $repoRoot 'scripts\common\Service.psm1'

    # Extract all RunNssmSet(nssm, "Key", "...") calls from C# CA
    $caContent = Get-Content $caSource -Raw
    $caKeys = [regex]::Matches($caContent, 'RunNssmSet\(\s*nssm\s*,\s*"([^"]+)"') |
      ForEach-Object { $_.Groups[1].Value } |
      Where-Object { $_ -ne 'AppEnvironmentExtra' } |  # PS1 doesn't set this either
      Sort-Object -Unique

    # Extract all Invoke-Nssm set calls from PS modules
    $psContent = (Get-Content $psModule -Raw) + "`n" + (Get-Content $svcModule -Raw)
    $psKeys = [regex]::Matches($psContent, "Invoke-Nssm\s+@\('set',\s*\$\w+\s*,\s*'([^']+)'") |
      ForEach-Object { $_.Groups[1].Value } |
      Sort-Object -Unique
  }

  It 'C# CA nssm set keys are a superset of PS1 nssm set keys' {
    # PS1 may have keys C# doesn't, but C# must include all PS1 keys
    $missingInCa = $psKeys | Where-Object { $caKeys -notcontains $_ }
    $missingInCa | Should -BeNullOrEmpty -Because "ConfigureAgentAction.cs must set all NSSM parameters that Set-NssmParameters sets. Missing in CA: $($missingInCa -join ', ')"
  }
}
```

- [ ] **Step 2: Run the test**

```powershell
Invoke-Pester -Path installer\tests\spec-mirror-tests.ps1 -Output Detailed
```
Expected: 1 test passes.

If it fails, read the failure message — it will list which NSSM keys exist in the PS1 modules but are missing from `ConfigureAgentAction.cs`'s `RunNssmSet(...)` calls. Add them to `ConfigureAgentAction.SetNssmParameters` (Task 4 Step 4) and re-run.

- [ ] **Step 3: Verify the test catches deliberate drift**

Temporarily comment out one of the `RunNssmSet` calls in `ConfigureAgentAction.cs` (e.g. `AppRotateFiles`). Re-run the test — it should fail. Restore the line, re-run, test passes. This proves the test is not a no-op.

- [ ] **Step 4: Commit**

```bash
git add installer/tests/spec-mirror-tests.ps1
git commit -m "test(msi): spec-mirror drift test (NSSM config parity C# vs PS1)"
```

---

## Task 11: CI integration (GitHub Actions `windows-2022`)

**Files:**
- Create: `.github/workflows/msi-ci.yml`

**Interfaces:**
- Consumes: All previous tasks' artifacts
- Produces: A CI workflow that, on push/PR to main, builds the MSI, runs the xUnit tests, runs the Pester smoke, and runs the spec-mirror test. PRs with broken MSI builds or failing tests block merge.

- [ ] **Step 1: Create `.github/workflows/msi-ci.yml`**

```yaml
name: MSI CI

on:
  push:
    branches: [main]
    paths:
      - 'installer/**'
      - 'agent/**'
      - 'scripts/install-agent.ps1'
      - 'scripts/common/**'
      - '.github/workflows/msi-ci.yml'
  pull_request:
    paths:
      - 'installer/**'
      - 'agent/**'
      - 'scripts/install-agent.ps1'
      - 'scripts/common/**'
      - '.github/workflows/msi-ci.yml'

jobs:
  build-and-test:
    runs-on: windows-2022
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup .NET 8 (for WiX 5 build host)
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '8.0.x'

      - name: Build MSI
        shell: pwsh
        run: .\installer\build-msi.ps1

      - name: Verify MSI artifact
        shell: pwsh
        run: |
          $msi = "installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi"
          if (-not (Test-Path $msi)) { throw "MSI not produced" }
          $size = (Get-Item $msi).Length
          Write-Host "MSI size: $([Math]::Round($size / 1MB, 1)) MB"
          if ($size -lt 40MB) { throw "MSI smaller than expected ($([Math]::Round($size / 1MB, 1)) MB; expected ~55 MB)" }

      - name: Run C# CA unit tests
        shell: pwsh
        run: dotnet test installer\tests\AgentInstaller.CA.Tests\AgentInstaller.CA.Tests.csproj -c Release --logger "trx;LogFileName=ca-tests.trx"

      - name: Run spec-mirror NSSM config drift test
        shell: pwsh
        run: |
          Install-Module -Name Pester -Force -SkipPublisherCheck -Scope CurrentUser
          Invoke-Pester -Path installer\tests\spec-mirror-tests.ps1 -Output Detailed

      - name: Run Pester E2E smoke
        shell: pwsh
        run: |
          Invoke-Pester -Path installer\tests\msi-smoke.ps1 -Output Detailed

      - name: Upload MSI artifact
        uses: actions/upload-artifact@v4
        with:
          name: addashboard-agent-msi
          path: installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.msi
          retention-days: 30
```

- [ ] **Step 2: Verify CI workflow is syntactically valid**

From the repo root:
```powershell
# Validate YAML (requires Python or yamllint; skip if unavailable)
python -c "import yaml; yaml.safe_load(open('.github/workflows/msi-ci.yml').read())"
```
Expected: exit 0 (or skip if Python not installed).

- [ ] **Step 3: Push and observe CI**

```bash
git add .github/workflows/msi-ci.yml
git commit -m "ci(msi): GitHub Actions workflow — build + xUnit + Pester + spec-mirror on windows-2022"
git push origin main
```

Open the GitHub Actions tab; verify the `MSI CI` job completes with all steps green. If a step fails, follow the failure log to identify the broken task and re-run after fixing.

- [ ] **Step 4: Verify the CI workflow produces a downloadable MSI artifact**

In the GitHub Actions run, find the `upload-artifact` step's output and verify `addashboard-agent-msi` is downloadable. Download it; inspect size matches expected ~55 MB.

- [ ] **Step 5: Commit (if any tweaks)**

```bash
git add .github/workflows/msi-ci.yml
git commit -m "ci(msi): fix workflow YAML syntax / artifact path"
```

(only needed if Step 1-4 required adjustments)

---

## Task 12: Documentation updates

**Files:**
- Modify: `scripts/install-agent.ps1` (header comment)
- Modify: `docs/operations/deployment.md` (add §Agent MSI Installation)
- Modify: `.gitignore` (already done in Task 1)

**Interfaces:**
- Consumes: Tasks 1-11's deliverables
- Produces: Operators reading deployment.md can find both install paths; install-agent.ps1's header points to the MSI as primary.

- [ ] **Step 1: Add header comment to `scripts/install-agent.ps1`**

At the top of `scripts/install-agent.ps1`, after the existing `[CmdletBinding()]` and `param(...)` block (or at line 3, just before `$ErrorActionPreference = 'Stop'`), add:

```powershell
# ============================================================================
# Local / WinRM remote install for AD Dashboard Agent. As of v2.1+, this is
# the SECONDARY install path; the primary path is the WiX MSI installer
# (addashboard-agent-x64-<version>.msi). Operators who can double-click an
# MSI (or run `msiexec /i ... /qn CENTERURL=... AGENTTOKEN=... AGENTTYPE=...`)
# should prefer the MSI path — see docs/operations/deployment.md §Agent MSI
# Installation. This script remains for:
#   - WinRM-based remote install to multiple machines from a management box
#   - Air-gapped environments where pulling the MSI binary is undesirable
# Both paths converge on the same service name (ADReplicationAgent) and
# same NSSM configuration; spec-mirror test enforces parameter parity.
# ============================================================================
```

- [ ] **Step 2: Add §Agent MSI Installation to `docs/operations/deployment.md`**

Insert this section just before the existing "### 单机本地安装（在 DC 上执行）" subsection under "## Agent 部署". (Find the `### 单机本地安装` heading and paste this section immediately above it.)

```markdown
### Agent MSI 安装（推荐）

自 v2.1 起，MSI 是 AD Dashboard Agent 的**首选**安装路径。MSI 自包含 Node.js 20 LTS、node_modules、NSSM，**装机时零网络访问**。

#### 双击安装（GUI）

1. 把 `addashboard-agent-x64-<version>.msi` 拷到目标机（DC 或成员服务器）
2. 双击，按向导填：
   - **Agent 类型**：ad（域控）或 non-ad（成员服务器）
   - **CenterUrl + AgentToken**：从中心的 `appsettings.json` `agentToken` 字段复制
   - **服务账号**：默认 NetworkService，需要可改 LocalSystem
   - **安装路径**：默认 `C:\addashboard\Agent`
3. Finish — 服务 `ADReplicationAgent` 自动启动

#### 静默安装（SCCM / Ansible / 命令行）

```powershell
msiexec /i addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\agent-install.log" `
  CENTERURL="http://center:8081" `
  AGENTTOKEN="456fb..." `
  AGENTTYPE="ad"
```

可加 `INSTALLDIR="D:\addashboard\Agent"` 改路径、`SERVICECCOUNT="LocalSystem"` 改账号。

退出码：
- `0` = 成功
- `1603` = 属性校验失败（看 `$env:TEMP\agent-install.log`）

#### 升级

跑新版 MSI 即可，旧版自动卸载并升级。`appsettings.json` 默认保留（在 dialog 选 Yes 或传 `PRESERVE_APPSETTINGS=1`）。

#### 卸载

```powershell
msiexec /x addashboard-agent-x64-1.0.0.msi /qn
```

服务自动注销。`appsettings.json` 和 `queue.db` 默认保留。

#### 与 WinRM 推送的关系

MSI 是**本地**装（双击或 msiexec）。要批量推到多台 DC/member 仍用 `.\scripts\install-agent.ps1 -ComputerName ...`（走 WinRM）。两条路径产生**同名服务 `ADReplicationAgent` + 同 NSSM 配置**，可任意切换。

#### 验证

- `Get-Service ADReplicationAgent` 状态应为 Running
- `Get-Content C:\addashboard\Logs\ADReplicationAgent-stdout.log -Tail 50` 看启动日志
- 中心侧：登录 → Agents 视图，新装机器 30 秒内应出现
```

- [ ] **Step 3: Verify docs render correctly**

```powershell
# Quick syntax sanity-check (markdown doesn't have strict syntax, but ensure no broken code blocks)
Get-Content docs\operations\deployment.md -TotalCount 5  # header exists
```
Or visually inspect the file:
```powershell
code docs\operations\deployment.md  # or your editor of choice
```

- [ ] **Step 4: Commit**

```bash
git add scripts/install-agent.ps1 docs/operations/deployment.md
git commit -m "docs(msi): deployment guide §Agent MSI Installation + install-agent.ps1 header pointer"
```

---

## Self-Review

### 1. Spec coverage

| Spec section / requirement | Implementing task |
|---------------------------|-------------------|
| §Architecture (WiX 5 single-MSI + C# deferred CA) | Task 1 (scaffold), Task 4 (CA + CustomActions.wxs) |
| §File Structure (10+ new files, 3 modified) | All tasks (1-12) |
| §Interface Contracts (msiexec properties + appsettings shape + service config) | Task 1 (properties), Task 4 (service config), Task 6 (dialog properties) |
| §Install Flow (5-dialog sequence + InstallExecuteSequence) | Task 6 (dialogs), Task 4 (sequence in CustomActions.wxs) |
| §Silent install flow | Task 6 (validation) + Task 4 (CA reads properties) |
| §Upgrade flow (MajorUpgrade + appsettings preservation) | Task 7 (NeverOverwrite + PRESERVE_APPSETTINGS) |
| §Reboot — not required | Implicit in Task 4 (no system file modifications) |
| §Uninstall Flow (RollbackAgent + RemoveFiles + appsettings preservation) | Task 5 (RollbackAgent) + Task 7 (NeverOverwrite) |
| §Reuse of NSSM Configuration (spec-mirror test) | Task 10 |
| §Error Handling (property validation, missing NSSM, etc.) | Task 4 (Validate method) + Task 6 (silent install rejects bad props) |
| §Testing — 4 layers | Task 8 (xUnit), Task 9 (Pester), Task 10 (spec-mirror), Task 11 (CI) |
| §Acceptance Criteria 1-12 | Tasks 4-12 each verify relevant AC |
| §Out of Scope items | None of the tasks attempt code signing, ARM64, Burn, etc. ✓ |

**No gaps.** All 12 ACs are covered by at least one task.

### 2. Placeholder scan

Searched the plan for: "TBD", "TODO", "implement later", "fill in details", "add appropriate error handling", "similar to Task N", vague requirements. No matches found.

### 3. Type / name consistency

- `ConfigureAgentAction` / `ConfigureAgent` (DLL entry name): consistent across Task 4 (CA), Task 6 (CustomActions.wxs reference), Task 8 (xUnit).
- `RollbackAgentAction` / `RollbackAgent` (DLL entry name): consistent across Task 5 (CA), Task 4 (CustomActions.wxs reference), Task 8 (xUnit).
- MSI properties: `CENTERURL`, `AGENTTOKEN`, `AGENTTYPE`, `SERVICECCOUNT`, `INSTALLDIR`, `PRESERVE_APPSETTINGS` — consistent across Task 4 (CA), Task 6 (dialogs + Properties.wxs), Task 7 (upgrade), Task 9 (Pester), Task 11 (CI).
- Service name `ADReplicationAgent`: consistent across Task 4 (CA), Task 5 (RollbackAgent), Task 9 (Pester), Task 10 (spec-mirror).
- `WIXUI_INSTALLDIR` — used in Task 1 (Product.wxs) and Task 6 (InstallDirDlg wiring).
- File `<InstallDir>\nssm\nssm.exe`, `<InstallDir>\node\node.exe`, `<InstallDir>\appsettings.json` — consistent across all tasks.

**No inconsistencies.**

Plan is complete. Committing and offering execution choice.