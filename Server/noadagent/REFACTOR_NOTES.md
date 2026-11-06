# REFACTOR_NOTES — R158.75 (2026-10-11)

> **This bundle is the NoAD-only member-server agent. It is a fork of `D:\dashboard\agent\` (AD fleet upgrade source) with every AD-only artefact removed.**

## Why this bundle exists

operator directive R158.75: "针对 noad 的 agent 的功能进行删减, 将 AD 的功能去掉" ("remove AD functionality from the noad agent"), followed by "改 agent 端, 服务器端先不动" ("modify agent only, leave server unchanged").

The two-fold constraint — modify agent, leave centre unchanged — combined with the centre-side upgrade envelope's source-of-truth being `<repoRoot>/agent/` (which feeds AD fleet 34 DC) led to the fork decision: **build a separate sibling tree** rather than edit the shared repo. See decision matrix in the plan file.

## What was removed

### AD-only PowerShell (12 files)
- `collect-replication.ps1` (41 KB) — Get-ADReplication* / DC replication collector
- `collect-discovery.ps1` — AD forest discovery
- `ad-ad-account-quickfix.ps1`, `ad-ad-groups-write.ps1`, `ad-ad-object-move.ps1`, `ad-ad-ou-create.ps1`, `ad-ad-users-write.ps1` — write-side AD object dispatchers
- `ad-admin-groups.ps1`, `ad-admin-users.ps1` — read-side admin queries
- `fetch-partner-ports.ps1`, `fetch-partner-ports-helpers.ps1` — replication-partner probe
- `probe-repadmin.ps1` — DC health probe

### AD-only JavaScript (12 modules)
- `src/ad-commands-drainer.js` — AD ad-commands queue drainer
- `src/dispatchers/ad-admin.js` (17.7 KB) — ad-admin dispatcher (PS1 invoker)
- `src/discovery.js` — AD forest discovery loop
- `src/scheduler.js` — DC collection scheduler (drives collect-replication)
- `src/package-manager.js` (37.7 KB) — AD package install/sync/run class
- `src/package-manager.js.r937.bak` (orphan backup) — auto-deleted with the live copy
- `src/healthcheck.js` — DC AD module/domain health probes (also dead after scheduler removal)
- `src/agent-filters.js` (inlined into `non-ad-scheduler.js`)
- `src/collector.js` — only AD-DC collector invoker
- `src/port-config-fetcher.js` — AD-only port list fetch
- `src/local-queue.js` — sqlite outbox (AD scheduler only)
- `src/last-collect-writer.js` — AD collect snapshot writer (no callers)

### Top-level agent.js refactor
- 1241 lines → 540 lines
- Deleted: entire `runAdRuntime()` function (666 lines) + AGENT_TYPE branch + AGENT_TYPE constant
- Deleted: 11 import lines (AD-coupled modules + `node:http`/`node:https`/`node:url` for AD-only `agentHttpGetBinary`)
- Replaced: import section header comment, boot block comment, R91.2 osInfo comment, port-scanning comment
- **Result**: only `runNonAdRuntime` remains; the boot path is a single `await runNonAdRuntime({ config, logger })`.

### heartbeat-callbacks.js
- Removed `drainAdCommands` parameter + `Promise.allSettled` slot (only `drainFilePush` + `drainMemberCommands` remain).

### config.js
- `agentType` default flipped `'ad'` → `'non-ad'` (this bundle is the non-AD runtime).
- `psScriptPath` default flipped to `C:\\NoADagentInstall\\agent\\scripts\\collect.ps1`.
- Both changes preserve the field as forward-compat metadata; the discriminator branch is gone, so the field is no longer consulted.

### non-ad-scheduler.js
- `shouldRunPackageForNonAd` predicate inlined from the deleted `agent-filters.js`.

## What was NOT changed

- `D:\dashboard\agent\` — the AD fleet upgrade source. **Untouched.** Centre continues to ship `0.1.4` (build-manifest.json) to the 34 AD hosts at `KDL*ADSRV*`. Their heartbeat / discovery / replication collection is unaffected by this refactor.
- `D:\dashboard\center\` — entire server tree. **Untouched.** All AD endpoints (`/api/agent/commands`, `/api/agent/discover`, `/api/agent/report`, `/api/agent/ports`) remain reachable from the AD fleet.
- `D:\agentInstall\*` — AD fleet install paths. **Untouched.**
- Schema: 1.0.6 baseline (R158.51 frozen). 0 ALTER issued.

## Centre-side dependencies (operator shipped earlier)

This bundle relies entirely on already-existing centre-side code:

- `POST /api/admin/member-servers/self-register` — `src/routes/member-servers.js:346` (shipped in earlier R-series). Idempotent upsert into `ad_member_servers` with `discovered_via='self-register'`, `agent_type='non-ad'`.
- `GET /api/admin/agent/packages-for-host` — per-host filtered package manifest.
- `POST /api/admin/agent/packages/report` — package run result sink.
- `POST /api/agent/heartbeat` — common heartbeat, agent includes `agentType: 'non-ad'` in the payload.
- `GET /api/agent/upgrade` — auto-upgrade envelope (centre will offer 0.1.5-noad to noad hosts in future if/when the centre's `agent-upgrade-source.js` is updated to include this tree; **not** in this ship).

## Verification (operator)

```powershell
# 1. Syntax check all modified JS
cd D:\dashboard\noadagent
node --check agent.js
node --check src\config.js
node --check src\heartbeat-callbacks.js
node --check src\non-ad-scheduler.js
node --check src\reporter.js
node --check src\file-push-drainer.js
node --check src\member-commands-drainer.js
node --check src\dispatchers\member-commands.js

# 2. Import dry-run (timeout 8s; expects "ERR_MODULE_NOT_FOUND" absent)
node -e "import('./agent.js').catch(e => { console.error('IMPORT ERR:', e.message); process.exit(1); })" 2>&1 | Select-String "ERR_MODULE"

# 3. AD-reference residue grep (must return zero)
grep -r "Get-AD\|ActiveDirectory\|RSAT-AD" D:\dashboard\noadagent\src D:\dashboard\noadagent\agent.js
```

## Rollback procedure (if ship fails)

1. Stop the agent: `nssm stop ADDashboardAgent`
2. Restore from operator-side backup:
   ```powershell
   $stamp = Get-Date -Format 'yyyy-MM-dd'
   if (Test-Path D:\NoADagentInstall\agent.bak.$stamp) {
     Copy-Item -Recurse -Force D:\NoADagentInstall\agent.bak.$stamp\* D:\NoADagentInstall\agent\
   }
   ```
3. `nssm start ADDashboardAgent`
4. The D:\dashboard\agent\ tree is untouched, so the AD fleet upgrade path remains intact regardless of this ship outcome.

## Follow-up (not in this ship)

- notadagent bundle version management — current `build-manifest.json` declares `0.1.5-noad` with `lineage: "noad"`. Decide later whether to bump independently or stay under the same numeric track as the AD fleet.
- centre-side `agent-upgrade-source.js` — not updated in this ship (server-side untouched). Future R-series may add a multi-lineage upgrade source so the centre can ship 0.1.5-noad to noad hosts; until then, operator manually copies the bundle to install sites.
- `D:\dashboard\agent\` repo remains the AD fleet upgrade source. **Do not unify** without a future R-series that explicitly handles the two lineages.