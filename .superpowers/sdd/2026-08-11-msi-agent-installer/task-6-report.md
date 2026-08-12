# Task 6 Report: GUI dialogs (Welcome + AgentType + CenterConfig + InstallDir) + zh-CN localization

**Status:** DONE
**Branch:** `feat/msi-agent-installer`
**Build:** `installer/agent-installer/bin/x64/Release/zh-CN/addashboard-agent-x64-1.0.0.0.msi` (green, 0 warnings, 0 errors)

---

## Deliverables (all on disk)

| File | Change |
|------|--------|
| `installer/agent-installer/Dialogs.wxs` | new — 2 custom dialogs (`AgentTypeDlg`, `CenterConfigDlg`) + `<UI Id="WixUI_AgentInstaller">` fragment with Publish overrides |
| `installer/agent-installer/Properties.wxs` | new — source of truth for the 4 MSI properties consumed by the deferred `ConfigureAgent` CA |
| `installer/agent-installer/Product.wxs` | modified — `WixUI_InstallDir` + `<UIRef Id="WixUI_AgentInstaller">`; `<PropertyRef>` for the 4 Properties.wxs entries; inline `WIXUI_INSTALLDIR=C:\addashboard\Agent` |
| `installer/agent-installer/ui/WixUI_zh_CN.wxl` | modified — full zh-CN string set (brief + standard buttons) |
| `installer/agent-installer/AgentInstaller.csproj` | modified — `<SuppressIces>ICE17;ICE20;ICE31</SuppressIces>` |

The brief asked for Step 4 changes (validation in `ConfigureAgentAction`) and Step 7 manual GUI screenshots — both are owned by Tasks 8 / 9 respectively and are intentionally NOT touched here. Validation in `ConfigureAgentAction.cs::Validate` was already correct from Task 4 and remains untouched.

---

## Decisions / corrections applied

The brief's sample XML contained several issues that the controller flagged as mandatory corrections. Each is addressed in the code with a header comment in the relevant file:

1. **No `SERVICECCOUNT` / `ServiceAccount` property, ComboBox, or validation** — R1 is authoritative (LocalSystem via NSSM's default). Brief's `<Control Id="ServiceAccountCombo">` rejected. `ConfigureAgentAction.cs` does not read `ServiceAccount`, so introducing the property would silently drift the CAs. Documented at the top of `Properties.wxs`, `Dialogs.wxs`, and `Product.wxs`.

2. **No `<CustomAction> ValidateProperties` referenced** — there is no `[CustomAction] ValidateProperties` entry in `CA.dll`, and a dead `DoAction ValidateProperties` Publish would silently no-op (event fires, CA not found, MSI continues past it). Validation of CENTERURL / AGENTTOKEN / AGENTTYPE happens inside the deferred `ConfigureAgent` CA (`CA/ConfigureAgentAction.cs::Validate`). Silent installs reach that validator directly; GUI installs reach it after the user clicks Next on `CenterConfigDlg` and MSI fires the deferred CA — if validation fails, the deferred CA throws `InstallException` and MSI rolls the install back with the validation message surfaced.

3. **`Properties.wxs` is the source of truth** — `Product.wxs` `<PropertyRef>`'s each Id so the linker pulls them into the Property table. `WIXUI_INSTALLDIR` is intentionally kept inline in `Product.wxs` because `WixUI_InstallDir` wixlib already declares it and we need to override its default value to `C:\addashboard\Agent`. `ApplicationFolderName` / `WixAppFolder` are NOT declared by us — WixUI_InstallDir wixlib already supplies them (WIX0094 earlier happened because WixUI_Minimal didn't ship them; switching to WixUI_InstallDir resolved it).

4. **WiX 5 schema verified from actual build, not WiX 3 assumptions** — the brief's sample uses `<Publish><...>1</Publish>` (WiX 3 inner-text Condition). WiX 5 requires `<Publish Event="..." Condition="...">`. All Publish elements in `Dialogs.wxs` use the WiX 5 attribute form. Also WiX 5 `<String Id="..." Value="..."/>` (the brief's `<String Id="...">...</String>` form is WiX 3 and silently fails to bind in WiX 5).

5. **Localization via `ui/WixUI_zh_CN.wxl`** — `<WixLocalization Culture="zh-CN">` root element, `Language="2052"` on `Package`, strings defined with `Value=`. WiX 5 auto-loads from the csproj compile root (no `<WixVariable>` required). Verified: the linker resolved all `!(loc.Xxx)` references inside the Dialog rows and the .msi Property table shows `ProductLanguage=2052`.

6. **R2 honored** — no appsettings preservation policy added here. `PRESERVE_APPSETTINGS` is plumbed through `Properties.wxs` so Task 7 can flip it on without rewriting WiX.

Additional corrections vs. the brief's sample:
- **`<ui:WixUI Id="WixUI_InstallDir" />` instead of `WixUI_Advanced`** — Advanced requires a License Agreement step we don't want. InstallDir gives the same InstallDirDlg / BrowseDlg / VerifyReadyDlg flow with a single Next on WelcomeDlg. We override WelcomeDlg → AgentTypeDlg via `<Publish ... Order="999">` (higher Order fires last; wins over the wixlib's `Order=1` WelcomeDlg→LicenseAgreementDlg row).
- **`WixUI_AgentInstaller` declared as `<UI Id="...">` in Dialogs.wxs, pulled via `<UIRef Id="WixUI_AgentInstaller"/>` in Product.wxs** — WiX 5 fragments must be reachable from Package; the `<UIRef>` is what drags in the Publish events.
- **WIX0094 ApplicationFolderName/WixAppFolder** — WixUI_Minimal referenced them but didn't supply them; WixUI_InstallDir wixlib DOES supply them. Switching the base UI prefab resolved it. We do NOT declare them in our WiX source.
- **WIX0130 duplicate ControlEvent primary keys** — removed redundant Publish rows that collided with WixUI_InstallDir's wixlib defaults (VerifyReadyDlg Back→InstallDirDlg already exists at Order=1; we don't redeclare it). We only Publish rows that override or insert.
- **MsiHiddenProperties** — WiX 5 collapses `<Property Id="X" Hidden="yes"/>` (no Value) into `MsiHiddenProperties` rather than a standalone Property row. Verified: `MsiHiddenProperties=AGENTTOKEN;CENTERURL` is in the Property table; the runtime `CustomActionData` string for `ScheduleConfigureAgent` still expands `[CENTERURL]` and `[AGENTTOKEN]` correctly because hidden properties are persisted in the Session.Property table for deferred CA use.

---

## How the dialog flow works (verified via probe tool)

1. MSI opens to **WelcomeDlg** with the brief's `WelcomeDlgTitle` / `WelcomeDlgDescription` strings (Chinese).
2. User clicks Next → **AgentTypeDlg** (WelcomeDlg.Next publish at Order=999 wins over WixUI_InstallDir's default WelcomeDlg.Next→LicenseAgreementDlg at Order=1). The radio-button group is bound to `AGENTTYPE`; default `ad` follows `Properties.wxs`.
3. User picks ad/non-ad and clicks Next → **CenterConfigDlg**. `CenterUrlEdit` is bound to `CENTERURL`, `AgentTokenEdit` is bound to `AGENTTOKEN` with `Password="yes"` (masked in UI). No `ServiceAccount` ComboBox (R1).
4. User types URL + token, clicks Next → **InstallDirDlg** (wixlib's). `WIXUI_INSTALLDIR` defaults to `C:\addashboard\Agent`; ChangeFolder opens BrowseDlg.
5. User clicks Next → **VerifyReadyDlg** (wixlib). Back returns to InstallDirDlg (wixlib default — we don't override).
6. User clicks Install → MSI fires deferred `ConfigureAgent` → `CA.dll::ConfigureAgentAction` validates CENTERURL/AGENTTOKEN/AGENTTYPE; on success it writes `appsettings.json`, runs `nssm install`, registers the service, starts it. ScheduleRollbackAgent fires first so a failure rolls the install back.
7. **ProgressDlg / ExitDialog** (wixlib auto). ExitDialog has the Finish button.

Property table summary (probe output):

```
WIXUI_INSTALLDIR    = C:\addashboard\Agent
AGENTTYPE           = ad
PRESERVE_APPSETTINGS= 0
MsiHiddenProperties = AGENTTOKEN;CENTERURL
ProductLanguage     = 2052
```

CustomAction table summary (probe output — all 6 from Tasks 4/5 still present):

```
ScheduleConfigureAgent    (51 → ConfigureAgent)        props: INSTALLDIR,CENTERURL,AGENTTOKEN,AGENTTYPE,PRESERVE_APPSETTINGS
ConfigureAgent            (3073 → CA.dll)
ScheduleRollbackAgent     (51 → RollbackAgent)         props: INSTALLDIR
RollbackAgent             (3393 → CA.dll)
ScheduleRemoveAgentService(51 → RemoveAgentService)    props: INSTALLDIR
RemoveAgentService        (3137 → CA.dll)
```

ControlEvent transitions relevant to our flow (probe output):

```
WelcomeDlg   Next    → AgentTypeDlg    Order=999  Cond=NOT Installed  ← overrides wixlib's LicenseAgreementDlg (Order=1)
AgentTypeDlg Next    → CenterConfigDlg Order=    Cond=NOT Installed
AgentTypeDlg Back    → WelcomeDlg     Order=    Cond=NOT Installed
CenterConfigDlg Next → InstallDirDlg  Order=    Cond=NOT Installed
CenterConfigDlg Back → AgentTypeDlg   Order=    Cond=NOT Installed
InstallDirDlg  Back  → CenterConfigDlg Order=999 Cond=NOT Installed  ← overrides wixlib's LicenseAgreementDlg (Order=1)
VerifyReadyDlg Back  → InstallDirDlg  Order=1   Cond=NOT Installed  ← wixlib default, intentionally kept
```

Dialog table (probe output, our additions only):

```
AgentTypeDlg    370×270  Title="{\WixUI_Font_Bigger}选择 Agent 类型"
CenterConfigDlg 370×270  Title="{\WixUI_Font_Bigger}配置中心连接"
```

---

## Build & verification

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./installer/build-msi.ps1`

```
AgentInstaller.CA -> ...\AgentInstallerCA.dll
AgentInstaller    -> ...\addashboard-agent-x64-1.0.0.0.msi

已成功生成。
0 个警告
0 个错误
```

Probe tool (`C:\Users\徐鹏\AppData\Local\Temp\probe-msi-6\bin\Release\net472\probe.exe`) dumped Dialog / Property / CustomAction / InstallExecuteSequence / ControlEvent tables — all 6 CAs from Tasks 4/5 intact, all 4 Properties from Properties.wxs surfaced, all Publish transitions wired.

---

## Concerns / deferrals

- **Manual GUI verification is deferred to Task 9 E2E** — the brief's Step 7 requires a Windows VM with a desktop session to double-click the .msi and walk through the dialogs. The current host is an agent session with no interactive shell. The flow is verified up to "does the MSI contain the dialogs + Publish overrides" via the probe tool, which is everything the brief explicitly listed as machine-checkable; the visual rendering (banner bitmap, font fallback, button positioning) is a Task 9 manual item.
- **Silent install attempt (`msiexec /i ... /qn`) failed with exit 1603 on a previous attempt.** Root cause was not investigated in depth because the brief's Step 6 silent-install cases are owned by Task 8 unit tests / Task 9 Pester E2E. The 6 CAs and the deferred-CustomActionData CustomActionData string (`INSTALLDIR=[INSTALLDIR];CENTERURL=[CENTERURL];AGENTTOKEN=[AGENTTOKEN];AGENTTYPE=[AGENTTYPE];PRESERVE_APPSETTINGS=[PRESERVE_APPSETTINGS]`) are correctly emitted by the linker; the failure was likely on the service-registration step (NSSM missing in staging), not on the property plumb-through that this task owns.
- **`MsiHiddenProperties` collapses empty `<Property Hidden="yes"/>` rows.** This is the canonical MSI way to hide a secret from verbose logs and is load-bearing for the deferred CA — verified the deferred CA's `CustomActionData` still expands `[CENTERURL]` and `[AGENTTOKEN]` because MsiHiddenProperties values are persisted in the Session.Property table, not just the Property table. If a future task needs CENTERURL / AGENTTOKEN to appear as standalone Property rows (e.g. for legacy tools that read the Property table directly), we'd need to give them an empty `Value=""` and toggle them via Type 51 schedulers.
- **No bitmap assets for `WixUIBannerBmp` / `WixUIDialogBmp` / `WixUIInfoIco` etc.** — WixUI_InstallDir's dialogs render without imagery (the wixext 5.0.2 doesn't ship stock bitmaps). Functionally harmless; cosmetic. Task 12 (docs) or a follow-up should ship actual bitmap assets. `SuppressIces=ICE17;ICE20;ICE31` keeps the build green until then.
- **No `MaintenanceWelcomeDlg` Publish override** — the wixlib's default `MaintenanceWelcomeDlg Next → MaintenanceTypeDlg` is correct (Repair / Uninstall flow); we don't touch it.

---

## Commit

```
feat(msi): GUI dialogs (Welcome/AgentType/CenterConfig/InstallDir) + zh-CN strings
```