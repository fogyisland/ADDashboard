# MSI Agent Installer — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows Installer (`.msi`) for the AD Dashboard Agent so that operators can install on a DC or member server with a double-click (GUI dialogs for CenterUrl + AgentToken + AgentType) or with a single `msiexec /i ... /qn CENTERURL=... AGENTTOKEN=... AGENTTYPE=...` command for SCCM/Ansible push. Coexists with the existing `install-agent.ps1` (which stays for WinRM remote install).

**Architecture:** A WiX 5 single-MSI build produces `addashboard-agent-x64-<version>.msi` (~50 MB) containing the full agent runtime: agent.js + src/ + scripts/ + Node.js 20 LTS x64 + node_modules + NSSM + collect-*.ps1. Basic UI dialogs (Welcome → AgentType → CenterConfig → InstallDir → Progress → Exit) drive MSI properties; a deferred managed C# custom action writes `appsettings.json` from those properties, then invokes the bundled `nssm.exe install` to register `ADReplicationAgent` as a Windows service. Service recovery (auto-restart on crash) is configured via `sc.exe failure`, mirroring the existing PS1 installer's behavior. Uninstall uses a rollback custom action to `nssm remove` before MSI deletes files. Silent install supported via MSI properties for unattended deployment. The existing `install-agent.ps1` is retained for WinRM-based remote push (same service name `ADReplicationAgent`; both paths converge on identical service configuration).

**Tech Stack:** WiX 5 Toolset (NuGet MSBuild SDK), C# .NET Framework 4.8 managed custom actions (compatible with Windows Installer's deferred-CA hosting), Node.js 20 LTS x64 (bundled), NSSM 2.24 (bundled), Windows Installer Service (built-in to Windows).

---

## Global Constraints

- **Single self-contained MSI artifact** — the `.msi` must install with zero network access; Node.js binaries + node_modules + NSSM all bundled. (No Burn wrapper; no chained Node MSI prerequisite.)
- **Coexistence with `install-agent.ps1`** — both install paths converge on the same service name `ADReplicationAgent` with identical NSSM configuration. Re-running either after the other must be idempotent (no "service already exists" error). See §Reuse of NSSM Configuration.
- **WiX 5 declarative + C# deferred CA** — WiX 5 (NuGet `WixToolset.Sdk` package) for `.wxs` file/dialog/property definitions; C# DLL with `<CustomAction Id="..." BinaryRef="..." DllEntry="ConfigureAgent" />` deferred actions (`Impersonate="no"`, `Execute="deferred"`) for any operation that requires SYSTEM elevation context.
- **PowerShell 5.1 + pwsh 7+ dual compat** — *no impact on this spec; PowerShell is not used in the MSI build path. PS1 installer (install-agent.ps1) keeps its existing PS 5.1 compat.*
- **NSSM is bundled in BOTH paths** — `publish/nssm/nssm.exe` already committed to repo for the PS1 installer; the MSI bundles its own copy at `<INSTALLDIR>\nssm\nssm.exe`. The two paths never collide (different copies).
- **x64 only, Windows 10 / Server 2016 minimum** — `<Package Platform="x64" InstallerVersion="500" />` and `<Condition Message="...">VersionNT64 >= 600 AND (VersionNT >= 100 OR (VersionNT = 600 AND VersionNT64 >= 600))</Condition>`. No ARM64 or x86 builds.
- **Idempotency** — MSI re-install on existing install → service parameters refreshed (same as `Install-NssmService` PS1 behavior), `appsettings.json` preserved if user selected "preserve" in upgrade dialog, node_modules and node binaries overwritten.
- **Logs always to `C:\addashboard\Logs`** — NSSM `AppStdout`/`AppStderr` paths set by ConfigureAgentAction to `C:\addashboard\Logs\ADReplicationAgent-{stdout,stderr}.log` with 10 MB rotation (`AppRotateBytes=10485760`, `AppRotateFiles=1`, `AppRotateOnline=1`). Same as PS1 installer.
- **No new third-party installers** — NSSM and Node.js binaries are bundled, not downloaded at install time. The only tool the MSI itself needs is `sc.exe` (built into Windows).
- **Existing tests stay green** — center 811/0 + agent 60/60 must remain green. New tests live in `installer/tests/`.
- **Out of scope (explicit non-goals)** — Code signing of the MSI (parked for v2); Bundle/Burn wrapper; MSI major upgrade with cross-version migration of agent settings; automatic Node.js security patch updates (re-bundle on Node CVE requires new MSI); MSI for the center (separate spec if needed); Windows-on-ARM (x64 only).

---

## Architecture

```
┌─────────────────────────── MSI artifact (~50 MB) ──────────────────────────┐
│  addashboard-agent-x64-1.0.0.msi                                          │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │ Embedded files (extracted to INSTALLDIR at install time):          │   │
│  │   agent/* (agent.js + src/*.js + scripts/*.ps1)                   │   │
│  │   node/   (Node 20 LTS x64 binaries, ~35 MB)                      │   │
│  │   nssm/nssm.exe                                                  │   │
│  │   appsettings.template.json                                       │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│  ┌────────────────── Custom Action DLL (managed C#) ──────────────────┐   │
│  │   • Read MSI properties (CENTERURL, TOKEN, AGENTTYPE,            │   │
│  │     SERVICECCOUNT) into INSTALLDIR\appsettings.json              │   │
│  │   • Run INSTALLDIR\nssm\nssm.exe install ADReplicationAgent      │   │
│  │     "<INSTALLDIR>\node\node.exe" "agent.js"                       │   │
│  │   • Set NSSM params (AppDirectory, AppParameters, DependOnService,│   │
│  │     DisplayName, Description, AppStdout/Stderr, Rotate=10MB)      │   │
│  │   • Run sc.exe failure ADReplicationAgent reset= 60 actions=…    │   │
│  │   • Start-Service ADReplicationAgent                              │   │
│  └────────────────────────────────────────────────────────────────────┘   │
│  ┌───────────────────────── UI Dialog (Basic UI) ───────────────────────┐   │
│  │   WelcomeDialog → AgentTypeDialog (radio ad / non-ad)            │   │
│  │   → CenterConfigDialog (CenterUrl textbox + AgentToken textbox)  │   │
│  │   → InstallDirDialog (default C:\addashboard\Agent, Browse...)  │   │
│  │   → ProgressDialog → ExitDialog                                 │   │
│  └────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

**Target paths (default, changeable in InstallDirDialog):**

```
C:\addashboard\
├── Agent\                  # INSTALLDIR
│   ├── agent.js
│   ├── src\…
│   ├── scripts\collect-replication.ps1
│   ├── scripts\collect-discovery.ps1
│   ├── appsettings.json     # written by ConfigureAgentAction
│   ├── node\                # bundled Node 20 LTS
│   │   └── node.exe (+ node.dll, etc.)
│   ├── nssm\nssm.exe
│   ├── node_modules\        # bundled (built by build-msi.cmd via npm install)
│   └── package.json
└── Logs\
    ├── ADReplicationAgent-stdout.log (10 MB rotation)
    └── ADReplicationAgent-stderr.log
```

**Two install paths coexist:**

| Path | Entry | When |
|------|-------|------|
| MSI GUI / silent | `addashboard-agent-x64-1.0.0.msi` (double-click or `msiexec /i`) | Local manual install |
| WinRM remote push | `.\scripts\install-agent.ps1 -ComputerName <list>` | Operator on management box pushing to N DCs |

Both register the same Windows service name `ADReplicationAgent`. Both write to `C:\addashboard\Agent\appsettings.json` with the same shape. Re-running one after the other is safe (PS1 already idempotent; MSI is idempotent by design — see §Idempotency).

---

## File Structure

**New files:**

```
installer/
├── agent-installer/                # WiX 5 MSI project (independent .csproj)
│   ├── AgentInstaller.csproj       # WixToolset.Sdk MSBuild project
│   ├── Product.wxs                 # <Product> / <Package> / <Directory> top-level
│   ├── Files.wxs                   # <File> elements: agent/, node/, nssm/, scripts/
│   ├── Dialogs.wxs                 # Basic UI dialogs (Welcome/AgentType/CenterConfig/InstallDir)
│   ├── CustomActions.wxs           # <CustomAction> refs + <InstallExecuteSequence>
│   ├── Properties.wxs              # CENTERURL / TOKEN / AGENTTYPE / SERVICECCOUNT defs
│   ├── ui/                         # WiX 5 UI extension (default .wxl + custom dialog bitmaps)
│   │   ├── WixUI_zh_CN.wxl         # Chinese localization (matches existing UI lang)
│   │   └── dialog-banners/         # bmp bitmaps for welcome/exit dialogs
│   └── CA/                         # Custom Action C# source
│       ├── ConfigureAgentAction.cs # Write appsettings.json + invoke nssm.exe + sc.exe
│       ├── RollbackAgentAction.cs  # Uninstall: nssm remove ADReplicationAgent confirm
│       └── AgentInstaller.CA.csproj # Separate .NET Framework 4.8 csproj for the DLL
├── build-msi.cmd                   # Build entry: npm install → wix build → outputs .msi
├── build-msi.ps1                   # PowerShell mirror (PS 5.1 compat)
└── tests/
    ├── AgentInstaller.CA.Tests/    # xUnit tests for the C# custom action DLL
    │   ├── AgentInstaller.CA.Tests.csproj
    │   └── ConfigureAgentActionTests.cs
    └── msi-smoke.ps1               # Pester E2E: install MSI → verify → uninstall
```

**Modified files:**

```
scripts/install-agent.ps1           # Add comment header pointing to MSI as primary path;
                                    # behavior unchanged (WinRM remote still works)
docs/operations/deployment.md       # Add §Agent MSI Installation before §Agent Deployment
.gitignore                          # Add installer/agent-installer/bin/, *.msi
.github/workflows/release.yml       # (optional) Add job that builds MSI artifact on tag push
```

**Files NOT touched (kept as-is):**

- `publish/nssm/nssm.exe` — already bundled for the PS1 path; MSI bundles its own copy at `<INSTALLDIR>\nssm\nssm.exe`
- `agent/*` — source unchanged; MSI just packages it
- `agent/package.json`, `agent/package-lock.json` — used by `build-msi.cmd` to pre-populate `node_modules/`; not modified
- `scripts/uninstall-agent.ps1`, `scripts/update-agent.ps1` — work as-is for both MSI-installed and PS1-installed agents (operate by service name)
- Existing Pester tests in `scripts/tests/` — not affected

---

## Interface Contracts

### MSI Public Surface (msiexec command-line)

```text
msiexec /i addashboard-agent-x64-1.0.0.msi [/qn | /qb] [/l*v "<log>"]
         [CENTERURL="http(s)://center:8081"]
         [AGENTTOKEN="<token-from-center-appsettings>"]
         [AGENTTYPE="ad"|"non-ad"]
         [SERVICECCOUNT="NetworkService"|"LocalSystem"]
         [INSTALLDIR="<path>"]
         [PRESERVE_APPSETTINGS="1"]
```

| Property | Required? | Default | Notes |
|----------|-----------|---------|-------|
| `CENTERURL` | yes (silent) | (none — GUI dialog required) | URL must parse as absolute http/https URI |
| `AGENTTOKEN` | yes (silent) | (none) | Min length 16 chars; matches center's `appsettings.json` `agentToken` |
| `AGENTTYPE` | yes (silent) | (none) | `ad` or `non-ad` |
| `SERVICECCOUNT` | no | `NetworkService` | Only `NetworkService` or `LocalSystem` accepted (no custom domain user in v1) |
| `INSTALLDIR` | no | `C:\addashboard\Agent` | Path must be absolute and writable |
| `PRESERVE_APPSETTINGS` | no | `0` | Set to `1` to skip appsettings.json rewrite (for upgrade scenarios) |
| `/l*v` log path | no | `%TEMP%\msi*.log` | Verbose log; ops paste this for debugging |

**Silent install validation:** `ConfigureAgentAction` validates all properties at entry and throws `InstallException` with a descriptive message on any violation. Exit code 1603 on property validation failure.

### ConfigureAgentAction (Deferred C# CA)

**Inputs (read from MSI CustomActionData via `session.CustomActionData`):**

```csharp
// MSI CustomActionData is a string of "KEY=VALUE\0KEY=VALUE" pairs
// Passed from immediate CA that reads session["CENTERURL"] etc.
public class ConfigureAgentData {
  public string InstallDir;       // INSTALLDIR
  public string CenterUrl;        // CENTERURL
  public string AgentToken;       // AGENTTOKEN
  public string AgentType;        // AGENTTYPE ("ad" or "non-ad")
  public string ServiceAccount;   // SERVICECCOUNT ("NetworkService" or "LocalSystem")
  public bool   PreserveAppsettings; // PRESERVE_APPSETTINGS
  public string LogDir;           // always "C:\addashboard\Logs"
}
```

**Behavior:**

1. Validate `CenterUrl` (Uri.TryCreate, absolute, http/https), `AgentToken` (length ≥ 16), `AgentType` (enum), `ServiceAccount` (enum). On failure throw `InstallException(message)` (MSI maps to exit 1603 + log).
2. If `PreserveAppsettings=false` AND existing `appsettings.json` not present: write fresh file from template + properties.
3. If `PreserveAppsettings=true` OR existing `appsettings.json` present: read existing; if `CenterUrl` or `AgentToken` properties differ, log warning and overwrite (operator chose to update by passing new properties to MSI).
4. Invoke `<INSTALLDIR>\nssm\nssm.exe install ADReplicationAgent "<INSTALLDIR>\node\node.exe" "agent.js"`. Throw if NSSM returns non-zero.
5. Set NSSM parameters via `nssm.exe set ADReplicationAgent <Key> <Value>`:
   - `AppDirectory = <INSTALLDIR>`
   - `AppParameters = agent.js`
   - `DisplayName` = `"AD Replication Agent (on <hostname>)"` for `ad`; `"AD Dashboard Agent (Member)"` for `non-ad`
   - `Description` = `"AD Replication collection agent"` for `ad`; `"AD Dashboard member-server monitor (self-register + heartbeat + package fetch)"` for `non-ad`
   - `Start = SERVICE_AUTO_START`
   - `DependOnService = DNS Client,Netlogon`
   - `AppStdout = <LogDir>\ADReplicationAgent-stdout.log`
   - `AppStderr = <LogDir>\ADReplicationAgent-stderr.log`
   - `AppRotateFiles = 1`
   - `AppRotateOnline = 1`
   - `AppRotateBytes = 10485760`
   - `AppEnvironmentExtra = NODE_ENV=production`
6. Invoke `sc.exe failure ADReplicationAgent reset= 60 actions= restart/5000/restart/10000/restart/30000`. Throw on non-zero exit.
7. Invoke `Start-Service ADReplicationAgent` (PowerShell via inproc, or `sc.exe start ADReplicationAgent`). Don't throw on failure — log warning so MSI proceeds (network unreachability at install time should not block MSI success).

**Rollback companion (RollbackAgentAction):** runs `nssm.exe remove ADReplicationAgent confirm`. Idempotent — no-op if service doesn't exist.

### Appsettings.json shape (matches PS1 installer output exactly)

```json
{
  "centerUrl": "http://center:8081",
  "agentId": "<hostname-from-Environment.MachineName>",
  "agentToken": "456fb...",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "heartbeatIntervalSeconds": 5,
  "discoveryIntervalHours": 4,
  "queueDbPath": "C:\\addashboard\\Agent\\queue.db",
  "psScriptPath": "C:\\addashboard\\Agent\\scripts\\collect-replication.ps1",
  "psDiscoveryScriptPath": "C:\\addashboard\\Agent\\scripts\\collect-discovery.ps1",
  "healthCheckIntervalMs": 600000,
  "agentType": "ad"
}
```

Identical to what `install-agent.ps1` writes today — agents are interchangeable regardless of install path.

### Service registration contract (matches PS1 installer exactly)

| Property | Value |
|----------|-------|
| Service Name | `ADReplicationAgent` |
| Display Name (ad) | `AD Replication Agent (on <hostname>)` |
| Display Name (non-ad) | `AD Dashboard Agent (Member)` |
| Service Account | `NetworkService` (default) or `LocalSystem` (override) |
| Start Type | `SERVICE_AUTO_START` |
| Dependencies | `DNS Client`, `Netlogon` |
| Application | `<INSTALLDIR>\node\node.exe` |
| App Parameters | `agent.js` |
| App Directory | `<INSTALLDIR>` |
| Log Rotation | 10 MB × 1 file (stdout + stderr) |
| Recovery | `sc.exe failure reset= 60 actions= restart/5000/restart/10000/restart/30000` |
| Env extra | `NODE_ENV=production` |

---

## Install Flow

### GUI flow (double-click MSI)

```
msiexec.exe → WelcomeDlg → AgentTypeDlg → CenterConfigDlg → InstallDirDlg
            → ProgressDlg (CA: ConfigureAgentAction deferred)
            → ExitDlg
```

**Per-dialog validation:**

| Dialog | Input | Validation |
|--------|-------|------------|
| Welcome | Next | (none) |
| AgentType | Radio `ad` / `non-ad` | Required |
| CenterConfig | TextBox `CenterUrl` + TextBox `AgentToken` | URL absolute http/https; Token ≥16 chars |
| InstallDir | Default `C:\addashboard\Agent` | Absolute path; parent exists; writable |
| Progress | (none) | Shows CA output via MSI progress messages |
| Exit | Finish | Shows "verify at center /api/dashboard/agents" link |

### InstallExecuteSequence

```
1. AppSearch                        (Windows Installer standard)
2. LaunchConditions                 (check Win 10/Server 2016 minimum)
3. ValidateProductID
4. RemoveExistingProducts           (MajorUpgrade detection — see §Upgrade Flow)
5. StopServices                     (if upgrading; stops ADReplicationAgent)
6. CostFinalize
7. InstallFiles                     (WiX extracts agent/, node/, nssm/, scripts/, node_modules/ → INSTALLDIR)
8. ScheduleConfigureAgentAction     (immediate CA passes properties as CustomActionData)
9. ConfigureAgentAction             ← deferred CA (Impersonate="no", runs in SYSTEM context)
   - Writes appsettings.json
   - Invokes nssm.exe install + set
   - Invokes sc.exe failure
   - Start-Service (best-effort)
10. PublishProduct
11. InstallFinalize
```

**Critical:** ConfigureAgentAction MUST be deferred (after InstallFiles; runs in SYSTEM context with `Impersonate="no"`). Immediate CA in SYSTEM context cannot reliably write to `INSTALLDIR` or invoke NSSM.

### Silent flow

```powershell
msiexec /i addashboard-agent-x64-1.0.0.msi /qn `
  /l*v "$env:TEMP\agent-install.log" `
  CENTERURL="http://center:8081" `
  AGENTTOKEN="456fb65363e048da99b83cc415f826d5" `
  AGENTTYPE="ad" `
  INSTALLDIR="D:\addashboard\Agent" `
  SERVICECCOUNT="NetworkService"
```

All dialogs skipped. ConfigureAgentAction still runs (reads MSI properties from session). Exit codes:
- 0 = success
- 1603 = InstallException (property validation failed, NSSM/sc.exe failed)
- 1602 = command-line parse error
- 1641 = reboot required (shouldn't happen — see §Reboot)

### Upgrade flow (Major Upgrade)

- `<Product Version="1.0.0.0" UpgradeCode="{FIXED-GUID-001}">` — UpgradeCode fixed forever; ProductVersion bumped on each release.
- `<MajorUpgrade Schedule="afterInstallInitialize" DowngradeErrorMessage="..." AllowSameVersionUpgrades="no" />` — detects existing product and uninstalls before installing new.
- On upgrade: existing service `StopServices`'d → old files `RemoveFile`'d → new files `InstallFiles`'d → `ConfigureAgentAction` runs → service re-registered and started.
- `appsettings.json` preservation: dialog detects existing file and prompts "preserve current CenterUrl/AgentToken?" → sets `PRESERVE_APPSETTINGS=1` if user selects Yes. If file `<File Source="appsettings.json" NeverOverwrite="yes" />` (WiX never overwrites on re-install), the CA reads existing values when `PRESERVE_APPSETTINGS=1` and skips the template-merge.
- `queue.db`, `appsettings.json` marked `NeverOverwrite="yes"` to survive both re-install and uninstall scenarios.

### Reboot

**Not required.** MSI does not modify system PATH, system registry HKLM critical keys, or shared system files. Install completes without reboot request.

---

## Uninstall Flow

### User-initiated uninstall (`Add/Remove Programs` or `msiexec /x`)

```
msiexec /x addashboard-agent-x64-1.0.0.msi [/qn] [/l*v "<log>"]
```

**InstallExecuteSequence (uninstall order):**

```
1. StopServices              (Windows Installer stops ADReplicationAgent)
2. ScheduleRollbackAgentAction (immediate CA — passes INSTALLDIR)
3. RollbackAgentAction       ← deferred CA (Impersonate="no", SYSTEM context)
                              - nssm.exe remove ADReplicationAgent confirm
                                (idempotent — no-op if service already gone)
4. RemoveRegistryValues
5. RemoveFiles                (deletes agent/, node/, nssm/, scripts/;
                                PRESERVES appsettings.json + queue.db if NeverOverwrite)
6. RemoveFolders
```

### File preservation policy

| File | Install behavior | Uninstall behavior |
|------|------------------|-------------------|
| `agent.js`, `src/*`, `scripts/*` | Overwrite | Delete |
| `node/*`, `nssm/*` | Overwrite | Delete |
| `node_modules/*` | Overwrite | Delete |
| `appsettings.json` | `NeverOverwrite="yes"` — install skips if exists | **Preserved** unless user passes `/remove REMOVE_APPSETTINGS=1` |
| `queue.db` | `NeverOverwrite="yes"` | **Preserved** for re-install |

### Rollback (install failed mid-way)

`RollbackAgentAction` registered as rollback companion to `ConfigureAgentAction`. If any deferred CA throws, MSI automatically rolls back; the rollback action runs `nssm.exe remove ADReplicationAgent confirm` to clean up any half-registered service. Files are restored by MSI to pre-install state.

### Silent uninstall

```powershell
msiexec /x addashboard-agent-x64-1.0.0.msi /qn /l*v "$env:TEMP\agent-uninstall.log"
```

Exit codes: 0 = success; 1603 = failed (typically StopServices timeout); 1602 = command-line parse error.

---

## Error Handling

### Install-time errors

| Failure point | Symptom | Handling |
|---------------|---------|----------|
| Node binary corrupted (embedded file bad) | `InstallFiles` fails | MSI rollback → all files removed, no service created |
| NSSM missing or broken in MSI | ConfigureAgentAction throws after InstallFiles | MSI rollback → RollbackAgentAction cleans; files restored |
| Invalid `CENTERURL` (URL parse fail) | Dialog validation blocks Next; silent install → CA throws | Exit 1603 + log "CENTERURL property missing or invalid" |
| `AGENTTOKEN` too short (<16) | Dialog validation; silent install → CA throws | Same: Exit 1603 + log |
| `AGENTTYPE` not `ad` or `non-ad` | Dialog validation; silent → CA throws | Same: Exit 1603 + log |
| `INSTALLDIR` not writable | MSI standard error dialog | Standard MSI error UX |
| Service name already exists from another MSI install | NSSM install fails | RollbackAgentAction cleans → MSI rollback; log explains |
| Agent starts but center rejects token (401) | Service starts; NSSM logs 401 in stdout | **No MSI rollback** (network problem not MSI's responsibility); ExitDlg links to "verify at center /api/dashboard/agents" |

**Key decision:** MSI only guarantees "installed and service is running". Verifying the center accepts the agent is a runtime concern (the center marks an agent as stale if no heartbeat within `heartbeat_stale_seconds`; existing behavior, unchanged by this spec).

### Uninstall-time errors

| Failure point | Symptom | Handling |
|---------------|---------|----------|
| Service won't stop (process hung) | `StopServices` times out (default 30s) | MSI reports error but continues removing files; orphaned service will fail to start next boot → SCM auto-cleans |
| `nssm.exe` missing (externally deleted) | RollbackAgentAction fails | **Not fatal** — service may not exist; log warning; continue |
| `INSTALLDIR` missing (externally rm'd) | RemoveFiles fails | MSI warning; continues with registry cleanup |
| Custom `LocalSystem` account removed from system | sc.exe failure during recovery setup | Log warning; recovery config best-effort |

### Silent-install fast-fail property validation

```csharp
// ConfigureAgentAction entry-point — throws InstallException on any violation
if (string.IsNullOrWhiteSpace(centerUrl) || !Uri.TryCreate(centerUrl, UriKind.Absolute, out var uri)
    || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
  throw new InstallException($"CENTERURL property missing or invalid: '{centerUrl}' (must be absolute http/https URI)");

if (string.IsNullOrWhiteSpace(agentToken) || agentToken.Length < 16)
  throw new InstallException($"AGENTTOKEN property missing or too short ({agentToken?.Length ?? 0} chars; minimum 16)");

if (agentType != "ad" && agentType != "non-ad")
  throw new InstallException($"AGENTTYPE must be 'ad' or 'non-ad' (got '{agentType}')");

if (serviceAccount != "NetworkService" && serviceAccount != "LocalSystem")
  throw new InstallException($"SERVICECCOUNT must be 'NetworkService' or 'LocalSystem' (got '{serviceAccount}')");
```

One bad property → exit 1603 with descriptive log message; operator/SCCM debugs from the log file.

---

## Reuse of NSSM Configuration

The MSI installer mirrors `install-agent.ps1`'s `Install-NssmService` + `Set-NssmParameters` + `Set-ServiceRecovery` block (from `scripts/common/NSSM.psm1` and `scripts/common/Service.psm1`). Service name, NSSM parameters, and `sc.exe failure` recovery must be byte-identical between the two paths so operators can swap install methods without surprises.

**Spec-mirror check (CI assertion):** A unit test parses both the C# `ConfigureAgentAction` source and `scripts/common/NSSM.psm1` + `Service.psm1`, extracting all `nssm set ... <Key> <Value>` and `sc.exe failure ...` invocations, and asserts the two sets are equal. Failure of this test blocks PR merge — guarantees drift detection.

---

## Testing

Three-layer test pyramid (matches the project's existing verification-before-completion discipline per `feedback_*` memory rules).

### Layer 1: Build sanity (`build-msi.cmd`)

- Run `wix build Product.wxs` → expect exit 0 + `bin/addashboard-agent-x64-1.0.0.msi` exists
- Use WiX `dark.exe` (or `msiinfo.exe`) to dump the .msi into tables; assert:
  - `File` table contains `agent.js`, `node.exe`, `nssm.exe`, `package.json`, `node_modules\...` (≥1 entry)
  - `Property` table contains `CENTERURL`, `AGENTTOKEN`, `AGENTTYPE`, `SERVICECCOUNT`, `INSTALLDIR`, `PRESERVE_APPSETTINGS`
  - `CustomAction` table contains `ConfigureAgentAction`, `RollbackAgentAction`
  - `LaunchCondition` contains the Win 10/Server 2016 minimum check
  - `Upgrade` table has fixed `UpgradeCode`
- **CI:** GitHub Actions `windows-2022` runner, job `msi-build-sanity`

### Layer 2: Custom Action unit tests (.NET xUnit)

`installer/tests/AgentInstaller.CA.Tests/` project. Direct unit tests on the static methods exposed by `ConfigureAgentAction.cs` (the MSI calls these via reflection; tests call them directly with mock session objects):

| Test | Assertion |
|------|-----------|
| `Writes appsettings.json with all required keys` | File exists, JSON contains centerUrl/agentToken/agentType/agentId/psScriptPath |
| `agentType=non-ad → DisplayName contains 'Member'` | (mock NSSM call, assert argv) |
| `agentType=ad → DisplayName contains '<hostname>'` | Same |
| `agentType=ad → Description = 'AD Replication collection agent'` | Same |
| `agentType=non-ad → Description contains 'member-server'` | Same |
| `Invalid CENTERURL → throws InstallException` | |
| `Too-short AGENTTOKEN → throws InstallException` | |
| `AGENTTYPE='foo' → throws InstallException` | |
| `SERVICECCOUNT='LocalSystem' → nssm set ... AppEnvironmentExtra updated` | |
| `NSSM.exe missing → throws with descriptive msg` | |
| `Start-Service fails → log warning, don't throw` | (verify exit code 0 still possible) |
| `PRESERVE_APPSETTINGS=1 + existing appsettings.json → file untouched` | |
| `PRESERVE_APPSETTINGS=1 + no existing file → writes fresh from template` | |
| `RollbackAgentAction → invokes 'nssm remove ADReplicationAgent confirm'` | (mock, assert argv) |

**Run via:** `dotnet test installer/tests/AgentInstaller.CA.Tests/` in CI.

### Layer 3: E2E smoke (Pester + Windows Server 2022)

`installer/tests/msi-smoke.ps1` Pester tests. Runs on GitHub Actions `windows-2022` runner (has GUI, msiexec, can install services; no real AD DC needed — center is mocked via `Invoke-WebRequest` to a stub HTTP server in the test).

```powershell
Describe "MSI Agent Installer smoke" {
  BeforeAll {
    $msiPath = "$env:RUNNER_TEMP\addashboard-agent-x64-1.0.0.msi"
    $logPath = "$env:RUNNER_TEMP\msi-install.log"
    $INSTALLDIR = "C:\addashboard\Agent"
  }

  It "installs MSI silently" {
    $p = Start-Process msiexec -ArgumentList @(
      '/i', $msiPath, '/qn', '/l*v', $logPath,
      'CENTERURL=http://test-center:8081',
      'AGENTTOKEN=test-token-1234567890',
      'AGENTTYPE=ad'
    ) -Wait -PassThru
    $p.ExitCode | Should -Be 0
  }
  It "creates expected files" {
    "$INSTALLDIR\agent.js" | Should -Exist
    "$INSTALLDIR\node\node.exe" | Should -Exist
    "$INSTALLDIR\nssm\nssm.exe" | Should -Exist
    "$INSTALLDIR\appsettings.json" | Should -Exist
  }
  It "registers NSSM service ADReplicationAgent as Running" {
    $svc = Get-Service ADReplicationAgent -ErrorAction Stop
    $svc.Status | Should -Be 'Running'
  }
  It "writes appsettings.json with correct keys" {
    $cfg = Get-Content "$INSTALLDIR\appsettings.json" -Raw | ConvertFrom-Json
    $cfg.centerUrl   | Should -Be 'http://test-center:8081'
    $cfg.agentToken  | Should -Be 'test-token-1234567890'
    $cfg.agentType   | Should -Be 'ad'
    $cfg.psScriptPath | Should -BeLike '*\scripts\collect-replication.ps1'
  }
  It "sets NSSM recovery via sc.exe failure" {
    $out = sc.exe qfailure ADReplicationAgent | Out-String
    $out | Should -Match 'reset= 60'
    $out | Should -Match 'restart'
  }
  It "uninstalls cleanly" {
    $p = Start-Process msiexec -ArgumentList @('/x', $msiPath, '/qn') -Wait -PassThru
    $p.ExitCode | Should -Be 0
    Get-Service ADReplicationAgent -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
  }
  It "preserves appsettings.json after uninstall (NeverOverwrite)" {
    "$INSTALLDIR\appsettings.json" | Should -Exist
  }
}
```

### Layer 4: Documentation-only manual smoke (not in CI)

`docs/operations/deployment.md` §Agent MSI Installation includes a checklist for human verification on a real DC:
- GUI flow: Welcome → AgentType `ad` → CenterConfig with real center URL/token → InstallDir default → Finish
- Silent flow: `msiexec /i ... /qn ...` with real properties
- Upgrade: install v1.0.0, then install v1.0.1, verify service restarted and appsettings preserved
- Uninstall: verify service gone, files removed, appsettings preserved

OS matrix for manual verification (not in CI):
- Windows Server 2016 x64, Server 2019 x64, Server 2022 x64, Win 10 21H2+, Win 11

---

## Acceptance Criteria

1. **Build:** `installer\build-msi.cmd` (or `.ps1`) produces `installer\bin\addashboard-agent-x64-<version>.msi` (~50 MB) with exit code 0.
2. **GUI install:** Double-click MSI → 5-dialog flow → service `ADReplicationAgent` appears in services.msc as Running within 30s.
3. **Silent install:** `msiexec /i ... /qn CENTERURL=... AGENTTOKEN=... AGENTTYPE=...` exits 0; same service Running.
4. **Invalid properties:** `msiexec /i ... /qn AGENTTOKEN=tooshort` exits 1603 + log explains AGENTTOKEN.
5. **Files:** `<INSTALLDIR>\agent.js`, `<INSTALLDIR>\node\node.exe`, `<INSTALLDIR>\nssm\nssm.exe`, `<INSTALLDIR>\appsettings.json` all exist after install.
6. **appsettings.json:** Contains all keys that `install-agent.ps1` writes today (see §Appsettings.json shape).
7. **Service parity:** NSSM `nssm get ADReplicationAgent` output from MSI install == `nssm get ADReplicationAgent` from PS1 install (verified by spec-mirror test in §Reuse of NSSM Configuration).
8. **Recovery:** `sc.exe qfailure ADReplicationAgent` shows `reset= 60 actions= restart/5000/restart/10000/restart/30000`.
9. **Upgrade:** Install v1.0.0, then v1.0.1 — service restarts; `appsettings.json` preserved (if user chose preserve); exit 0.
10. **Uninstall:** `msiexec /x ... /qn` exits 0; service gone; `appsettings.json` + `queue.db` preserved.
11. **CI:** `installer\tests\msi-smoke.ps1` Pester suite green on `windows-2022` runner; `dotnet test` for C# CA tests green.
12. **No regression:** center 811/0 + agent 60/60 still pass after MSI files added (none of the new files affect existing test paths).

---

## Out of Scope (v1)

- **Code signing** — `.msi` shipped unsigned; ops will see "Unknown publisher" SmartScreen warning. Requires EV code signing cert. Parked for v2.
- **Bundle/Burn wrapper** — single MSI only; no `setup.exe` bootstrapper.
- **Major upgrade with config migration** — upgrade replaces files; user must re-enter CenterUrl/AgentToken in dialog unless they pass them on cmdline.
- **Automatic Node.js security patches** — re-bundle Node 20 LTS into a new MSI on CVE.
- **ARM64** — x64 only.
- **Custom domain user service account** — NetworkService/LocalSystem only in v1.
- **MSI for center** — agent only; center still uses `install-center.ps1`.
- **GUI localization** — Chinese (zh-CN) only in v1; English locale uses default WiX strings.
- **Pre-install validation of agent reachability to center** — not done at MSI time; runtime concern.
- **Automatic uninstall of pre-existing agent from PS1 path** — both paths coexist; MSI does NOT uninstall the agent if it was installed by PS1. Operator choice.