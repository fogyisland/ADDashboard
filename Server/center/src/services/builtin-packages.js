// seedBuiltinPackages — copies bundled built-in packages from the
// publish/ directory into the runtime data/ tree on first normal-mode
// start AND registers them via the script-service (package_scripts +
// package_policies tables) so the agent's /api/agent/packages endpoint
// serves them. The center and agent share a single
// data/packages/<name>/<version>/ layout (see center/src/packages/
// installer.js — same path used for downloaded + cached packages), so
// seeding the built-in here makes the runner/router code path completely
// uniform across all install sources.
//
// Idempotency:
//   - File copy: skipped when <dataDir>/<name>/<version>/manifest.json
//     already exists. Operator can delete that file to force a re-seed.
//   - DB registration (R66): pre-check via packageScripts.get(db, name)
//     before calling installScript — skips the script INSERT when the
//     script row already exists. setPolicy({enabled:true}) always fires
//     to re-apply the built-in enable contract (see below). Re-running
//     recovers the round-12 runAllNow count:0 bug — installs that pre-date
//     the DB-registration step left files on disk but no DB row, so the
//     agent sync returned [] and runAllNow() always emitted `count: 0`.
//   - DDL apply: re-runs on every call when `db` is provided, with the
//     same idempotency strategy as installer.upgradePackage — read
//     pkg_<name>.schema_migrations, skip filenames already recorded,
//     then apply the rest. CREATE TABLE IF NOT EXISTS on the
//     per-package SQL files makes the second-run path itself safe even
//     if the schema_migrations row is missing (e.g. the operator
//     dropped the table). Round-13 fix: pre-fix seeder never applied
//     DDL, so metricstore v2 INSERT failed with "Table
//     'pkg_<name>.metrics' doesn't exist" forever.
//
// Audit: emits three actions on first install (upload_script + set_policy
// from script-service internals, plus seed_builtin_<name> from the
// seeder itself), and just set_policy + seed_builtin_<name> on
// subsequent restarts (idempotent skips for the script INSERT). The
// seeder's own seed_builtin_<name> audit fires only on the first file
// copy (not on idempotent re-runs), target='packages', payload=
// {name,version}. Best-effort: writeAudit failures don't block startup
// (matches writeAudit's own best-effort contract).
//
// Built-in enable contract: registered with enabled=true. Operator-driven
// disable via UI does not persist across restarts — the seeder re-enables
// on every normal-mode start via setPolicy({enabled:true}). That's the
// documented built-in contract: built-ins are center-managed, like
// system packages. If you want to keep a built-in permanently disabled,
// delete <InstallPath>/data/packages/<name>/ before restart and the
// seeder will copy + re-enable it; future admin work will add a
// per-package "sticky disabled" flag.
//
// Source dir layout (bundled in publish/center/data/packages/):
//   <name>/<version>/manifest.json
//   <name>/<version>/collect.ps1
//   <name>/<version>/migrations/<dialect>/*.sql  (e.g. 001_initial.sql)
//   <name>/<version>/content.sha256
//
// Dialect resolution for migrations (mirrors installer.installPackage):
//   mysql → migrations/*.sql (top-level only, NOT migrations/mssql/)
//   mssql → migrations/mssql/*.sql if present, else migrations/*.sql
// The mysql/mssql split exists because the two dialects have
// syntactically different DDL (e.g. JSON vs NVARCHAR(MAX) +
// ISJSON CHECK) and the seeder must run the right file or the apply
// crashes with parse errors.
//
// Called from center/server.js IIFE before buildServerApps() in normal
// mode only (init mode has no data/packages consumers).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ensureSchema,
  createSchemaMigrationsTable,
  applyMigrations,
  markMigrationsApplied,
  listAppliedMigrations,
  schemaExists
} from '../packages/ddl-apply.js';
import { installScript, setPolicy, recordPublish } from '../packages/script-service.js';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';

// R157.6 — package-specific script filename resolver. Most builtin packages
// use the conventional `collect.ps1`, but operator can rename a package's
// PowerShell entry point in data/packages/<name>/<version>/<filename> for
// self-documentation (e.g. R157.6 ad_partner_inbound_discover →
// collect_inbound_partner.ps1). The manifest.json `agent.script` field
// must match the on-disk filename exactly — that field is what
// package-runner.js writes to the agent's local cache after a
// syncFromCenter pull.
//
// Default to `collect.ps1` so existing packages keep working without
// any change. Add an entry here only when a package genuinely wants a
// non-conventional name.
const SCRIPT_FILENAME_OVERRIDES = {
  ad_partner_inbound_discover:  'collect_inbound_partner.ps1'
  // R158.10 (2026-10-01) — ad_partner_outbound_discover 包下线,
  //   脚本名映射一并删除。
};

function scriptFilenameFor(name) {
  return SCRIPT_FILENAME_OVERRIDES[name] || 'collect.ps1';
}

// R157.4 — local SHA-256 helper. Mirrors the one in
// src/packages/installer.js (used by installScript) so the auto-upgrade
// path persists a script_sha256 value that matches what installScript
// would have computed. Without this the agents see a sha mismatch on
// the next syncFromCenter and fall back to the cached local script.
function hashContent(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// R158.86.5 (2026-10-12) — package_policies.scope 拆细白名单. 18 包
//   (DC 16 + member 2). 不用 18 个 manifest.json agent.type 推断 (ad_os_baseline
//   1.0.7 manifest.agent.type='non-ad' 错例, R158.56c 时代遗留), 中心端
//   invariant 强. 18 包全列出来 operator 一眼看, 比改 manifest 稳.
const SCOPE_OVERRIDE = {
  // DC-only 16 包 (跟 ad_member_* member 公共表 mode 平行但独立)
  'ad_os_baseline':              'agent_type:ad',
  'ad_replication_status_probe': 'agent_type:ad',
  'ad_account_change':           'agent_type:ad',
  'ad_dc_overview':              'agent_type:ad',
  'ad_dc_probe_inbound':         'agent_type:ad',
  // R158.X.116.d (2026-10-22) — 删 'ad_dc_probe_outbound' 白名单残留。
  //   该包已从 BUILTIN_PACKAGES 移除 (见下方 :356 的 R156.5 说明), 本条目
  //   对它永不生效 (SCOPE_OVERRIDE 只被已注册包查找)。
  'ad_eventlog_collector':       'agent_type:ad',
  'ad_failed_logon_collector':   'agent_type:ad',
  'ad_lockout_list':             'agent_type:ad',
  'ad_lockout_summary':          'agent_type:ad',
  'ad_admin_members':            'agent_type:ad',
  'ad_partner_inbound_discover': 'agent_type:ad',
  'ad_partner_ports_probe':      'agent_type:ad',
  'ad_ad_account_quickfix':      'agent_type:ad',
  'ad_ad_users_write':           'agent_type:ad',
  'ad_ad_groups_write':          'agent_type:ad',
  // member-only 3 包 (公共表 mode, FK ad_member_servers 防 AD host 误写)
  'member_os_baseline_collector': 'agent_type:non-ad',
  'member_eventlog_collector':    'agent_type:non-ad',
  // R158.100 (2026-10-13) - member-server 本地管理员组成员 (BUILTIN\Administrators +
  //   Remote Desktop Users + Power Users). Get-LocalGroupMember (0 AD RSAT).
  //   24h cadence, MERGE dedup on (hostname, group_name, member_sid).
  'member_admin_groups':          'agent_type:non-ad'
};

export const BUILTIN_PACKAGES = [
  // R136 — all 7 collect.ps1 files now set
  // [Console]::OutputEncoding = UTF8 to keep Chinese text in .NET
  // exception messages + Get-WinEvent localized strings from being
  // transcoded through the system ANSI codepage (CN Windows = CP936/
  // GB18030). Bumped to 1.0.1 per operator directive 2026-09-28
  // "每次有修改都会自动增加 0.1" so DC agents running version-based
  // incremental sync re-pull the script on the next cycle.
  // R142 — bump ad_os_baseline 1.0.1 -> 1.0.2. Earlier 1.0.1 used
  // `ForEach-Object { @{ $_.letter = $_.free_bytes } } | ConvertTo-Json`
  // which PS5.1 serializes as an array of single-key hashtables
  // ([{"C:":...},{"D:":...}]); the front-end parseDiskPair walks
  // Object.entries and ends up with numeric keys 0/1/2 instead of
  // "C:"/"D:", so multi-disk machines render N/A and operators see
  // "only the system disk" reflected. 1.0.2 accumulates into a real
  // hashtable before ConvertTo-Json so the wire shape is the expected
  // {"C:":...,"D:":...}. Schema unchanged — zero migration cost,
  // next agent pull-and-rerun auto-fixes the fleet view.
  // R147 — bump ad_os_baseline 1.0.2 -> 1.0.3. Adds 5 hardware-identity
  // + per-drive columns (bios_info / cpu_brand / mem_total_bytes / disks
  // / c_used_pct) and corresponding migrations/002_os_baseline_extra_
  // fields.sql files. DriveType=3 filter ensures the per-drive `disks`
  // list excludes CD / network / RAM / virtual disks (operator directive
  // "上报磁盘大小，非硬盘不要上报"). Schema is a superset of 1.0.2 — the
  // ALTER migration is idempotent via INFORMATION_SCHEMA / sys.columns
  // guards so existing rows keep working (new fields NULL until the
  // agent re-runs).
  // R158.30 — bump ad_os_baseline 1.0.3 -> 1.0.4. Adds 3 new JSON columns
  // (system_info / network_info / memory_modules) + extends 2 existing JSON
  // fields (bios_info gains serial_number; disks[] elements gain
  // model+bus_type for C: only). 3 new ALTER migration 003_os_baseline_
  // r158_30_fields.sql files (MySQL ADD COLUMN IF NOT EXISTS, MSSQL
  // sys.columns guards + ISJSON CHECK). Front-end label rename only
  // ("磁盘已使用" -> "C 盘已使用") — back-end / SQL / DB column unchanged.
  // Schema is a superset of 1.0.3 — old agent rows get NULL on the 3
  // new columns until they re-run the 1.0.4 PS1 (intervalSec=60).
  // R158.50.7j (v1.0.6) — operator 报 "win_event_filterxml: 找不到任何与
  // 指定的选择条件匹配的事件" 是误报. 真因 PS5.1 Get-WinEvent -FilterXml
  // -ErrorAction Stop 在 0 命中抛 EventLogQueryException zh-CN. 跟
  // ad_lockout_list 1.0.5 (R158.50.7h) + ad_eventlog_collector 1.0.6
  // (R158.50.7i) 同款 pattern. fix -ErrorAction Stop -> SilentlyContinue
  // + 3 case 分支 (idle / channel-not-enabled 不存在 / real-fault).
  // case 1 idle 不进 $lastErrorMessage, status=success 绿. case 3 真故障
  // 走 R158.50.6 链路, status=partial 黄. Wire shape 不变.
  // minVersion 0.1.2 (R158.50.6 agent runner reads parsed.error).
  // R158.56c (v1.0.7) — centre manifest backfill. R158.50.7j ship 把 PS1
  // 1.0.5→1.0.6 重命名 wire 字段 (R158.30 时代 cpu_brand/network_info →
  // cpu/ips + 加 motherboard), 但 centre manifest 1.0.6 只改了 description
  // + version, metricSchema 仍是 1.0.4 旧 keys → 5h+ 全 fleet
  // metricstore.ingest.failed "unknown keys: motherboard,ips,cpu".
  // 1.0.7 = 1.0.6 PS1 一字不差 + centre 1.0.7 manifest 加 3 个新 JSON
  // key 到 metricSchema + 004 migration 加 3 列. R157.4 seeder 检测
  // version mismatch 自动 upsert + apply 004. PS1 sha 跟 1.0.6 完全相同
  // → 5min sync 不下发新 PS1, 只下发新 manifest.json.
  // R158.72.x.18 (2026-10-17) — bump ad_os_baseline 1.0.7 → 1.0.8.
  //   ship reason: 5 包 ship 删 manifest.agent.cronExpr (跟 R158.72.x.13
  //   ship 误设 1:1 平行闭合). 1.0.7 PS1 一字不差 + manifest 删 cronExpr
  //   + intervalSec 60→900 (跟 4 锁包 1:1 平行 R158.72.x.17 directive).
  //   5min sync 不下发新 PS1, 只下新 manifest.json. R157.4 seeder 检测
  //   version mismatch 自动 upsert.
  // R161.5 (2026-10-26) — bump ad_os_baseline 1.0.8 → 1.0.9. 两个缺陷:
  //   ① 1.0.8 的 manifest.name 写成连字符 (ad-os-baseline) ⇒ validateManifest
  //      抛 INVALID_MANIFEST ⇒ seeder 在 installScript 之前就跳过 ⇒ 该包从未
  //      注册 ⇒ pkg_ad_os_baseline schema 从未创建 ⇒ GET /api/os-baseline
  //      500 (操作员报 "OS 基线结果不对").
  //   ② 建表迁移 migrations/001_initial.sql 在历史 bump 中丢失 (每个版本
  //      目录只带自己那一条增量迁移) ⇒ 表从来没被建出来过. 1.0.9 补回
  //      001 (MySQL 5.7 兼容的单条 CREATE TABLE, 19 列一次给全).
  //   PS1 内容与 1.0.8 一字不差 (只 bump 版本 + 补建表迁移) ⇒ agent sync
  //   拿到的 collect.ps1 sha 不变.
  { name: 'ad_os_baseline', version: '1.0.9' },
  // 2026-08-26 round-18: split lockout out of collect-replication.ps1
  // (which used to include LockedCount in __dc_summary__ and a
  // LockoutEvents field on the snapshot). The user wants lockout data
  // on its own 15-minute cadence, independent of the replication cycle,
  // so a DC with broken replication still surfaces its lockout trend
  // and lockout events. Two packages: a count gauge + an event-detail
  // JSON column. Both ship as built-ins.
  // R158.72.x.18 (2026-10-17) — bump ad_lockout_summary 1.0.3 → 1.0.4.
  //   ship reason: 5 包 ship 删 manifest.agent.cronExpr (跟 R158.72.x.13
  //   ship 误设 1:1 平行闭合, 走 R158.72.x.7 builtin-packages.js 同步修
  //   范式). 1.0.3 PS1 一字不差, manifest 删 cronExpr. 5min sync 不下
  //   新 PS1, 只下新 manifest.json.
  { name: 'ad_lockout_summary', version: '1.0.4' },
  // R158.49 (2026-10-06) — callerComputerName fix. 4740 EventData does
  // not contain CallerComputerName (Microsoft's documented schema only
  // has Subject/Target fields), so the 1.0.1 lookup returned empty for
  // every event and the operator saw "—" on every row. 1.0.2 parses the
  // rendered event Message ("Caller Computer Name: workstation01") with
  // EN + zh-CN regex, falling back to SubjectUserName when both fail.
  // Operator must `nssm restart agent` on each DC after this lands so
  // the next 15-min collect cycle ships real workstation names.
  // R158.49.1 (2026-10-07) — callerComputerName regex `(?ms).+?\s*$`
  // includes `-` (hostnames like DL-08001-D, KDLFL-OFADSRV1,
  // SRV-DC01-PROD). Pre-1.0.4 `[^\r\n\-]+` excluded `-` and matched
  // `DL` for `DL-08001-D`. Bumped to 1.0.3 so all agents pull the new
  // regex on next sync.
  // R158.50.7f (2026-10-08) — bump 1.0.4 → 1.0.5. Fix PS5.1
  // `Get-WinEvent -ErrorAction Stop` 0-hit EventLogQueryException
  // (zh-CN: "找不到任何与指定的选择条件匹配的事件。") being treated
  // as a real failure. 1.0.5 uses -ErrorAction SilentlyContinue +
  // `@($raw).Count -eq 0` so the normal "no lockouts in 15min window"
  // idle state is reported as `events=@(), error_code=0,
  // lastErrorMessage=null` (status='success' per R158.50.7g). Real
  // ProviderMetadata failures cause `$raw=$null` and route to the catch
  // block (preserves R158.50.6 error_code=1 path). stderr emits a
  // diagnostic "[ad_lockout_list 1.0.5] no 4740 events in 15min window
  // on <DC> — normal idle state" so the operator can see "this DC is
  // healthy, just no lockouts" instead of an error code block.
  // R158.50.7l (2026-10-08) — bump 1.0.5 → 1.0.6. Fix
  // displayName=null. 1.0.5 R158.50.7e used
  // Get-UserDisplayNameCached -Domain $TargetDomainName assuming the
  // EventData field is an AD domain FQDN. Verified on KDLFLOFADSRV2
  // (2026-10-08): TargetDomainName='BJ-L-PF27GZN7' == CallerComputerName,
  // not 'SPHKDL' the AD domain. Get-ADUser -Server <workstation> throws
  // "unable to contact server" and returns null. 1.0.6 reverts to the
  // R139.1 default-Get-ADUser idiom (no -Server, queries the current
  // user logon domain = local AD domain on a DC), which works for 99%
  // of 4740 lockouts. Cache key simplified to SAM only; null lookups
  // are NOT cached (R158.50.7e lesson — caching null locked the bad
  // state for 24h). Operator confirmed "之前可以显示，现在显示不了"
  // (was working in R139.1 era, broken since R158.31 LDAP switch).
  // R158.72.x.18 (2026-10-17) — bump ad_lockout_list 1.0.6 → 1.0.7.
  //   ship reason: 5 包 ship 删 manifest.agent.cronExpr 闭合. 1.0.6 PS1
  //   一字不差, manifest 删 cronExpr. 5min sync 不下新 PS1.
  { name: 'ad_lockout_list', version: '1.0.7' },
  // R110.A — ad_dc_overview replaces the __dc_summary__ self-loop
  // piggyback on ad_replication_status. Manifest omits the `database`
  // block (公共表 by design), so the v2 metricstore path is bypassed;
  // data lands in the public ad_dc_overview table via the runner.js
  // post-hook (center/src/packages/runner.js:dc-overview etl block).
  { name: 'ad_dc_overview', version: '1.0.3' },
  // R112 — ad_eventlog_collector backs the public EventlogView (no-auth
  // login-page panel). Manifest omits the `database` block (公共表 by
  // design), so the v2 metricstore path is bypassed; data lands in the
  // public ad_eventlog_events + ad_eventlog_summary tables via the
  // runner.js post-hook. 24h retention is enforced by a centre-side
  // hourly sweep (createEventlogRetentionLoop, wired in server.js).
  // R158.31 (2026-10-02) — bump 1.0.1 -> 1.0.3. Two fixes squashed:
  //   - R158.23 (v1.0.2) added 4625/4776 severity=error fix + mock
  //     fallback audit_failure flag, but the bump in builtin-packages.js
  //     was MISSED (left at 1.0.1). Operator observed the audit-failure
  //     and severity fixes not landing across the fleet — root cause was
  //     the agent bundle keeping 1.0.1 forever. This line forces the
  //     1.0.3 publish path so v1.0.2's fixes actually flow to the agents.
  //   - R158.31 (v1.0.3) lifts intervalSec 900 -> 7200 to match the
  //     SCAN_HOURS=2 in collect.ps1. Pre-fix the agent re-ran the 2h
  //     scan every 15 min, so the dashboard.js overview SUM(error_count)
  //     / SUM(warning_count) over a 24h window summed 96 rows per
  //     (dc, channel) instead of 1 — operator observed OverviewPanel
  //     numbers inflated ~96× vs the real per-DC counts. Cadence now
  //     matches the scan window: one summary row per 2h window.
  // R158.52 (v1.0.5) — wire shape adds `dropped_count` column on each
  // per-channel summary row. Pre-fix the 1000-row per-channel limit
  // silently dropped events and the centre's summary count was wrong;
  // now the agent reports how many rows the limit dropped so the centre
  // can flag "real activity was X+Y". 6 other R158.52 collectors
  // (ad_dc_overview, ad_admin_members, ad_os_baseline,
  // ad_lockout_summary, ad_dc_probe_inbound, ad_partner_inbound_discover)
  // absorbed their fault-tolerance hardening in-place without a wire
  // change but still got version bumps to force SHA refresh across the
  // fleet (SilentlyContinue -> Continue + accumulated $lastErrorMessage
  // surfaced as payload.error). ad_partner_ports_probe was bumped to
  // 1.0.4 too (NOT in BUILTIN_PACKAGES — superseded by ad_dc_probe_inbound
  // at R155.3 — but agent still runs it from cached current.json so it
  // needs the version bump for SHA drift detection). ad_eventlog_collector
  // is the only R158.52 collector with a wire-shape change.
  // R158.50.7i (2026-10-08) — bump 1.0.5 → 1.0.6. Fix 5-channel
  // Get-WinEvent catch-as-error anti-pattern. PS5.1 -FilterXml
  // -ErrorAction Stop throws 3 kinds of exceptions which 1.0.5 lumped
  // into $lastErrorMessages → payload.error → runner partial misfire:
  //   Case 1 — 0 hits idle ("找不到任何与指定的选择条件匹配的事件。")
  //   Case 2 — channel not enabled ("在 localhost 计算机上没有与
  //            'AD Web Services'匹配的事件日志。" — DC 没启用这个 role)
  //   Case 3 — real failure (ProviderMetadata crash / log 损坏 / ACL)
  // 1.0.6 uses -ErrorAction SilentlyContinue + @($records).Count + null
  // check + zh-CN/en-US message regex to branch:
  //   Case 1 + Case 2 → $lastErrorMessages empty → status='success'
  //                      (R158.50.7g); summary row count=0 仍写,
  //                      /eventlog 公共页 5 列一致 render.
  //   Case 3 → $lastErrorMessages.Add → status='partial'
  //            (R158.50.6 链路保留).
  // Wire shape 不变. intervalSec 7200 (R158.31 cadence = SCAN_HOURS*60*60)
  // 不变. minVersion 0.1.2 不变 (R158.50.6 agent runner reads parsed.error).
  // R158.50.7i-fix (2026-10-08, +5h after first ship) — operator 8:30
  // restart 拉新 PS1 跑出 status=partial, error=
  // 'ps1: channel Application: 找不到任何与指定的选择条件匹配的事件。
  // ; channel ADWeb: 在 localhost 计算机上没有与"AD Web Services"匹配
  // 的事件日志。; channel DFSR: ...' (zh-CN, member DC 实际错误).
  // 真因 1.0.6 catch  regex  'is not found on this computer|does
  // not exist|...|ChannelMatchingException'  en-US pattern, zh-CN
  // ' 在.+没有与.+'  ( U+201C/U+201D)  match
  // →  case 2 zh-CN channel-not-enabled  case 3
  // real-fault branch →  $lastErrorMessages → status=partial.
  // fix: case 2 regex  zh-CN pattern
  // '在.+没有与.+匹配的事件日志',  zh-CN/en-US 都识别.
  // sha256: 81f3...0895 → 1911...17c1 (8275 bytes).
  { name: 'ad_eventlog_collector', version: '1.0.7' },
  // R155.3 — rename ad_partner_ports_probe -> ad_dc_probe_inbound.
  // Operator 2026-09-30 corrected the label semantics: the single
  // probe pipeline writes row (source_dc=agent, dest_dc=peer) which
  // the dashboard can render in TWO operator views by swapping the
  // anchor (source_dc vs dest_dc). 15-min cadence, 公共表 contract (no
  // `database` block), row lands in ad_replication_status with
  // naming_context='__partner_ports__:<hash>'.
  //
  // R155.4 — operator then redirected: "算了，既然有 outbound 那么我们就
  // 增加一个 probe-outbound 的 脚本，写入 prob_outbound 的数据，这样
  // 避免数据错误". The earlier "NOT a separate package" stance is
  // retracted. ad_dc_probe_outbound IS a separate package that writes
  // to a separate physical table (ad_dc_probe_outbound, migration 034)
  // so the inbound vs outbound probe rows never collide and the
  // /api/dashboard/partner-port-health/probe-outbound endpoint can
  // render an operator-facing "主动探测出战" view sourced from a
  // dedicated table. Peer list source: GET /api/agent/outbound-partners
  // (R155.4 mirror of R151.2 inbound endpoint), which mirrors the
  // /api/agent/inbound-partners fetch but anchored on source_dc=self
  // with the same __partner_ports__:% echo-loop guard. Same 15-min
  // cadence + 公共表 contract (no `database` block in manifest).
  // R158.72.x.18 (2026-10-17) — bump ad_dc_probe_inbound 1.0.1 → 1.0.2.
  //   ship reason: 5 包 ship 删 manifest.agent.cronExpr 闭合. 1.0.1 PS1
  //   一字不差, manifest 删 cronExpr. 5min sync 不下新 PS1.
  { name: 'ad_dc_probe_inbound', version: '1.0.2' },
  // R156.5 retired — ad_dc_probe_outbound BUILTIN entry removed
  // (operator directive "复制伙伴端口主动探测 不需要哦去掉"). The
  // ad_dc_probe_outbound package (R155.4) wrote to a dedicated
  // physical table consumed only by the now-removed
  // /api/dashboard/partner-port-health/probe-outbound endpoint. The
  // table is dropped by migration 038. ad_dc_probe_inbound (R155.3)
  // STAYS — the /monitor-inbound + /monitor-outbound routes still
  // depend on its writes (via ad_replication_status naming_context
  // = '__partner_ports__:<hash>').
  // R157.4 — partner-discover packages. Cadence: 5 min via BOTH the
  // agent intervalSec clock (300s in manifest.json) AND the centre cron
  // (also 5min, wake-up insurance for stalled agents). Operator
  // directive 2026-09-30 30: "复制伙伴增加则写入,复制伙伴少了则删除"
  // — agent now sources peers directly from Get-ADReplicationPartnerMetadata
  // (no more circular centre-endpoint dependency). Centre post-hook
  // (src/services/partner-discover.js) reconciles by UPSERTing newly-
  // seen (sourceDc, destDc) pairs and DELETing rows that disappeared
  // from the agent's view. WRITE-TIME ad_dcs membership validation
  // enforced (operator directive: source_dc / dest_dc must exist in
  // ad_dcs, otherwise silent skip). discover ≠ probe: no TCP-port
  // probing, just DC topology. Wire shape:
  //   { metrics: { peers: [{ destDc }] } }
  // Version bumped 1.1.3 → 1.1.4 (R158.11.4, 2026-10-01). Operator
  // fix: 1.1.0..1.1.3 embedded Chinese (zh-CN) comments + Chinese
  // strings inside Write-Warning calls. The PowerShell 5.1 host on
  // each agent reads scripts with the system codepage (zh-CN =
  // CP936 / GB18030) while the dev box writes UTF-8 no-BOM, causing
  // the script to silently fail to parse — ErrorAction Stop throws,
  // catch handler fires, peers=[] exit 0. v1.1.4 strips every
  // non-ASCII character so the file is 7-bit-clean ASCII. Behaviour
  // on RSAT-equipped DC is identical to v1.1.3 (parses the partner
  // DC name from the CN= segment of $p.Partner).
  { name: 'ad_partner_inbound_discover',  version: '1.1.6' },
  // R158.15.3 (2026-10-01) -- ad_replication_status_probe 1.0.2 -> 1.0.3.
  // Re-publish under a fresh version to force a deterministic cache refresh
  // on every agent. 1.0.2's cmdlet pivot was correct on disk + DB, but
  // 23 of 34 agents kept reporting the old "Get-ADReplicationFailure
  // -Partner" error -- agent's current.json said 1.0.2 yet on-disk
  // collect.ps1 still held the pre-pivot 1.0.0 text. Bumping version +
  // adding a version-fingerprint Write-Warning line at the top of the
  // script makes stale-cache detection trivial and forces every agent's
  // PackageManager.syncFromCenter to write a fresh collect.ps1 (it keys
  // its cache sub-directory on pkg.version). Script body otherwise
  // identical to 1.0.2 -- same Get-ADReplicationPartnerMetadata pivot +
  // same success/error/partial classification rule.
  //
  // R158.17.1 (2026-10-01) -- 1.0.3 manifest.json intervalSec 900 -> 600
  // (15min cadence -> 10min cadence). Reason: 视图 v_partner_inbound 用
  // 15min 滑动窗口判 probe_state, cadence 等于窗口大小时边缘 probe 行
  // 落不进窗口 → 显示 probe_state=none 闪烁。cadence=10min 保证每个 pair
  // 至少 1 行 attempt_at 落在窗口内 (R158.17.1 实战验证: cadence=15min
  // 时 FLO2 入站 8 个 peer 有 4 个被窗口切到 none)。DB package_policies
  // 同步 UPDATE interval_sec=600, 不需重打包, agent syncFromCenter 下次
  // 触发即可生效 (R158.13 + R158.12 节流模式)。
  { name: 'ad_replication_status_probe', version: '1.0.3' },
  // R158.46b (2026-10-07) — 4 个 ADUC 写动作包 (ad_ad_*) 不在
  //   BUILTIN_PACKAGES 注册. 真因: 它们 manifest.type=command (跟
  //   VALID_TYPES=['gauge','counter','status','timeseries'] 不匹配),
  //   installScript 抛 "invalid type: command" 后整个 BUILTIN_PACKAGES
  //   循环 abort, 后面的 ad_admin_members / ad_failed_logon_collector
  //   永远 seed 不进 DB. agent dispatcher pickScript 通过 `fromPackage`
  //   字段识别包路径 ('<agentDataDir>/cache/<pkgName>/<version>/collect.ps1'),
  //   **不依赖** 中心 DB installed_packages, 是 static script lookup.
  //   之前在 BUILTIN_PACKAGES 是 R158.46 注释错误, 现撤回. R180.
  //   R158.46b operator "AD 管理日志其实需要加入到 Sidebar 中" → AD 管理
  //   日志入口独立顶级 view, 4 个 ad_ad_* dispatcher 不动.
  // (已删除以下 4 行: ad_ad_ou_create / ad_ad_object_move /
  //  ad_ad_object_delete / ad_ad_account_quickfix)
  // R158.56c (2026-10-08) — 重新注册 3 个 ADUC 写动作包. R158.46b 当时移除它们
  // 时假设 "static script lookup 不依赖 DB", 但 PackageManager.syncFromCenter
  // 走的 GET /api/agent/packages 只返 package_scripts 表里的包, 这 3 个包不在表里
  // → agent sync 链路拿不到 → <dataDir>/packages/<pkg>/<ver>/collect.ps1 在所有 34
  // DC 上从未生成 → ou_create / object_move / object_delete 命令永远 ENOENT.
  // 重新加入 + 配 script-service.js VALID_TYPES='command' 白名单.
  // agent 端 reschedule 加 type='command' 过滤 (见 package-manager.js), 包不入
  // 定时器, 仅供 R75 dispatcher pickScript 走 fromPackage 路径.
  //
  // R158.56c-d (2026-10-09) — ad_ad_object_delete 整体下线 (operator
  // directive). 现只 2 个 ADUC 写动作包 (ou_create + object_move). 见
  // 上面 R158.56c-d 注释块.
  //
  // **跟其他 builtin collector 性质完全不同** — 这 3 个是 on-demand 命令
  // 载体 (operator 在 /admin/daily-ops 提交 → 中心入 ad_admin_commands
  // → targetDc agent poll 拉到 → ad-admin dispatcher pickScript 走 fromPackage
  // → 临时 spawn PS1 argv), 不是 scheduled collector (其他 9 个 builtin
  // 都是 setInterval 周期跑). 三处强制保证:
  //   (a) manifest.type = "command"
  //   (b) manifest.agent 没有 intervalSec 字段 (PackageManager.reschedule
  //       line 322 'missing intervalSec' warn + skip 兜底)
  //   (c) PackageManager.reschedule line 321 'type=command continue' 显式 skip
  // 任何一处失效另外两处兜住, 不会每 3600s 自动跑无参 PS1.
  //
  // **不优化只 targetDc sync**: 当前 34 DC 全 sync 这 3 个包 (总计 ~30KB
  // disk overhead) 是 R158.56c 的 design tradeoff. 想要 on-demand sync
  // 到 targetDc 需要改 R75 dispatcher 端 (收到 ad_command 时才 fetch
  // 中心仓脚本), 是 R158.56d 范围. ship 时权衡: 先修 ENOENT 阻断, 再做
  // bandwidth 优化.
  //
  // R158.60.10-final-rollback (2026-10-09) — ad_ad_ou_create + ad_ad_object_move
  // 整体下线. operator directive "agent 自己手动推好了, 中心库删了". DB
  // DELETE package_scripts + package_policies 4 行 (R60.10 跟 R60.10-final
  // 两次 ship 撤回综合). package_scripts_history 保留 (R152 append-only).
  // agent 端走静态 PS1 fallback (R75 pickScript 走 agent/scripts/ 路径,
  // 不依赖中心仓). BUILTIN_PACKAGES 数组同步删 (否则 seed 每次启动 mkdir
  // 1.0.0 → ENOENT → 留空目录, 还会锁住 RD).
  // 恢复: git history 复原 PS1/manifest/content.sha256 + 此处 2 行反注释 +
  // registerScript(name='ad_ad_ou_create'/'ad_ad_object_move', version='1.0.0').
  // R158.56c-d (2026-10-09) — ad_ad_object_delete 整体下线. operator directive
  // "这个包不在需要, 从中心数据库删除". 已 DELETE package_scripts +
  // package_policies 2 行 (sha 150355ec1f0102f5, 2026-10-08 22:53 装入,
  // 2026-10-09 09:10 删除). package_scripts_history 1 行保留 (R152
  // append-only). 33 DC agent 下次 5min syncFromCenter 见 enabled=0 / 缺
  // package_scripts 行 → 自动 unlink 本地 collect.ps1 副本 (R158.10
  // partner_outbound_discover 注释的 enabled=0 → uninstall 机制).
  // 4 处防御 (admin.js whitelist / ad-admin.js PACKAGE_COMMAND_MAP /
  // ad-admin-commands.js validators / audit-classifier.js 分类) 同步清.
  // 未来恢复需要从 git history 复原 PS1/manifest/content.sha256 + 4 处
  // 反注释 + registerScript(name='ad_ad_object_delete', version='1.0.0').
  // R158.47 (2026-10-06) — operator directive "构建一个包, 这个包就是提取
  //   domain admins enterprise admins 管理员成员, 这个包只需要在一台 DC
  //   执行即可. 最终放在 ad dashboard 界面的概览中".  Single-DC constraint
  //   implemented centre-side: every DC runs collect.ps1, the centre
  //   post-hook does MERGE ON (domain_dn, group_name, member_sam) so
  //   duplicate reports collapse automatically — no agent-side PDC
  //   selection needed.  Same architectural pattern as ad_dc_overview
  //   (R110.A): public table (ad_admin_members), manifest omits the
  //   `database` block, data lands via runner.js post-hook. intervalSec
  //   = 86400 (one day) — admin group membership changes are infrequent
  //   and operator wants daily cadence not per-hour.
  // R158.72.x.15 (2026-10-17) — ad_admin_members 1.0.1 → 1.0.2. 操作员 directive
  //   锁 "定义2点触发" = 切 daily 2:00 + Jitter 0~30min per-DC, 1:1 平行 R158.72.x.13
  //   6 包范式 (ad_account_change / ad_lockout_summary / ad_lockout_list /
  //   ad_failed_logon_collector / ad_dc_probe_inbound / ad_os_baseline) 跟
  //   R158.72.x.14 ad_eventlog_collector 范式.  0 引新 endpoint / 0 改
  //   shouldFire 5-field 解析器 / 0 改 fireTriggers 13 列 / 0 改 agent
  //   binary (0.1.7 已吃 cronExpr 路径). 真因: 11:02 R158.clear-all 完 9.5h
  //   ad_admin_members 公共表 0 row (R158.95 ship 配 intervalSec=86400 范式,
  //   AD agent 端 setInterval 24h 0 fire 跟 R158.X.99.10 aac 1:1 平行 bug,
  //   但 aac 是 1ms 连续 fire, aam 是 0 fire). R158.72.x.13 ship 6 包切
  //   cronExpr 范式时漏了 ad_admin_members, 走 manifest.agent.cronExpr +
  //   agent 0.1.7 setTimeout 24h 1 拍 治本.
  { name: 'ad_admin_members', version: '1.0.2' },
  // R158.72 (2026-10-11) — ad_account_change. 24h cadence (intervalSec
  //   =86400), 5 种动作 (created/modified/deleted/enabled/disabled). 公共表
  //   ad_account_change via runner.js post-hook (R110.A pattern, 跟 ad_admin_members
  //   同模式). Single-DC 语义由中心端 MERGE ON (sam, action, change_date)
  //   dedup 实现. agent 不主动 ship (operator "永远不主动升级 agent 版本"
  //   R158.56d), agent 0.1.3 fleet 拉到新 manifest 后自动跑新包 (跟
  // R158.72.x (2026-10-14) — bump 1.0.0 → 1.0.1. 5 actions 互斥修复
  //   (modified + enabled 双重 row bug). Get-ADReplicationAttributeMetadata
  //   (no -Server, 本 DC 视图) 读 userAccountControl.LastOriginatingChangeTime
  //   命中 today_00:00 才算 enabled/disabled, 否则只算 modified. 不动 SQL /
  //   不动 schema / 不动前端 / 不改 cadence (intervalSec=86400).
  // R158.72.x.1 (2026-10-15) — 修 collect.ps1 双 bug: 加 -Server $server (本机
  //   DC) 绕开 auto-discovery (NSSM context fail); _.Name → _.AttributeName
  //   (LDAP display name). version 仍 1.0.1, sha256 变, file-push 重推 fleet.
  //   dry-run on 1 AD DC verify enabled/disabled 区间 5-30.
  // R158.72.x.2 (2026-10-16) — fleet 24h 607/607 partial 修: line 67-72
  //   `Import-Module ActiveDirectory` 加 inner try/catch (PS 5.1 NSSM context
  //   触 implicit AD: PSDrive mount → DC locator 防火墙拦 → 抛 "目录服务连接
  //   不可用" → 整段 try 块 abort); line 181 Get-ADObject -IncludeDeletedObjects
  //   加 -Server $server 跟 line 139 1:1 平行. version 仍 1.0.1, sha256 再变,
  //   file-push 重推 fleet. ship 后 1h+24h+72h 必 3 次 partial ratio verify ≥80%
  //   否则 revert (R158.72.x.1 漏 "24h 后 AD 状态变" 维度, R158.72.x.2 补).
  // R158.72.x.3 (2026-10-16) — 操作员 directive "我们后续用别的方式执行,
  //   现在不停的执行导致AD出问题". DELETE package_scripts + package_policies
  //   2 表 + 5 段 pending_trigger → status='cancelled'. 0 改 agent binary
  //   (R158.69.3 0 fleet auto-upgrade), 0 改 fleet 33 DC R158.72.x.1 1.0.1
  //   bundle cache. ship 后 1min 0 新增段 verify pass.
  // R158.72.x.4 (2026-10-16) — 改走 Get-WinEvent Security 日志路径:
  //   5 events ID 1:1 映射 (4720/4722/4725/4738/4767 → created/enabled/
  //   disabled/modified/unlocked), 0 依赖 Import-Module ActiveDirectory
  //   (NSSM context 友好, 0 触 AD: PSDrive mount). +1 字段 operator_user
  //   (事件 Properties[4] SubjectUserName 操作人). 中心端:
  //   (a) 公共表 schema 改: ALTER TABLE ad_account_change ADD operator_user
  //   NVARCHAR(128) NULL; (b) sql.js adAccountChange.upsert 2 dialect 加
  //   operator_user 字段 + dailyTopByAction 1:1 返; (c) account-change.js
  //   normalizeEntry 1:1 接受 operator_user; (d) routes/dashboard.js
  //   account-change-trend 1:1 返 operator_user; (e) AccountChangeDetailView
  //   7 → 8 列加 "操作人" 列. 操作员必先配 (0 改中心端):
  //   (1) 域控 auditpol /set /subcategory:"User Account Management" /success:enable;
  //   (2) agent run-as account 加进 DC 本地 "Event Log Readers" 组.
  //   操作员 directive "0 dry-run 中心端 0 装回 1.0.2 直接 ship" (0 dry-run
  //   = 跟 R158.72.x 1:1 平行 24h 100% partial 风险已知), ship 后 1h+24h+72h
  //   必 3 次 partial ratio verify ≥80% 否则 revert 到 R158.72.x.3 硬删状态.
  // R158.X.99 (2026-10-21) — bump 1.0.11 → 1.0.12, 修「每天必写 0 条」逻辑错误.
  //   操作员 directive "应该是查询前一天 0:0:0 到 23:59:59 的数据, 因为从
  //   0 点到两点数据肯定是 0". 真因: cronExpr='0 2 * * *' 每天 02:00 跑, 但
  //   collect.ps1 的 StartTime 写的是 CST today 00:00 → 窗口只有 0~2 点, 该
  //   时段几乎 0 条账户管理事件 → 每日必写 0 条 = 前端「显示没有任何账户创建」
  //   (每日必现, 非偶发). 修: 窗口改昨天 00:00~今天 00:00 UTC (显式加 EndTime
  //   闭上界, 否则会混入今天 0~2 点), 时区基准 CST→UTC 跟中心端 SQL 对齐.
  //   中心端同步改 dailyTopByAction 2 dialect 的「当日」→ UTC 昨天
  //   (MSSQL DATEADD(DAY,-1,GETUTCDATE()) / MySQL DATE_SUB(CURDATE(),1 DAY)).
  //   0 改 cadence (intervalSec=86400 + cronExpr='0 2 * * *' 保持) / 0 改 schema
  //   / 0 改 wire shape / 0 改前端. 走 R158.72.x.8 同 .ps1 改 version 走
  //   builtin-seed-upgrade 的范式, 但因 .ps1 内容实质变更故新起 1.0.12 目录
  //   (file-push 按 version 目录分发, 同目录改文件有 agent 缓存不取的风险).
  { name: 'ad_account_change', version: '1.0.12' },
  // R158.50 (2026-10-06) — operator directive "在前台增加一个功能,统计
  //   密码错误次数,同时在包中新建一个统计2小时内的输错密码的账户、
  //   displayname、认证DC、IP地址 用来写入数据库后,在前台dashboard
  //   增加一个显示24小时或者7天错误次数走向的图". 15min cadence (intervalSec
  //   =900, R158.53 operator 改 30min→5min→15min, 1.0.6 验证 R158.50.7e
  //   链路真生效 8min/run, 5min cadence 给 fleet 压力过大, 15min 与
  //   ad_lockout_list 15min 对齐), 4625 event, 公共表 pivot
  //   (ad_failed_logon_events), centre post-hook MERGE. 与 ad_eventlog_collector
  //   1.0.3 双写 (后者 channel=
  //   Security raw message, 本包结构化字段 dashboard 用). 命名跟
  //   ad_eventlog_collector 同族, cadence 在 description 体现。
  // R158.50.7d (2026-10-07) — bump 1.0.2 → 1.0.3. Fix [xml] param type-coercion
  //   bug in Get-EventDataField / Get-EventDataInt helpers (lines 122-135).
  //   PS5.1 LanguagePrimitives.ConvertTo doesn't auto-wrap XmlElement →
  //   XmlDocument on param binding (unlike return-value casts), so the
  //   old `param([xml]$Ed, ...)` threw on the first 4625 in the window →
  //   outer try/catch → $errorCode |= 1 + events=[] + ETL upserted=0. New
  //   param is `[Parameter()]` (no type), accepting both XmlDocument and
  //   XmlElement. See data/packages/ad_failed_logon_collector/1.0.3/collect.ps1.
  // R158.50.7e (2026-10-07) — bump 1.0.3 → 1.0.4. Two operator-requested
  //   fixes after the 1.0.3 first-collect cycle produced 8 real 4625 events
  //   (KDLWGQWHADSRV1, bdm × 6 + KDL-WGQSS-SH$ × 2):
  //     1. Filter machine-account 4625 events (TargetUserName ending in '$')
  //        so the /failed-logon-2h per-user pivot only shows real user
  //        attacks (computer-account NTLM probes are not password attacks).
  //        Skipped count is logged to stderr for ops visibility.
  //     2. DisplayName lookup uses TargetDomainName (was $env:COMPUTERNAME).
  //        Pre-1.0.4 Get-ADUser against the local SAM could not resolve
  //        cross-domain users, so target_user_display_name came back NULL
  //        for every cross-domain 4625. 1.0.4 passes the event's
  //        TargetDomainName so LDAP targets the right domain.
  // R158.50.7l (2026-10-08) — bump 1.0.4 → 1.0.5. Fix displayName=null.
  // 1.0.4 R158.50.7e Get-UserDisplayNameCached -Domain $TargetDomainName
  // assumed EventData TargetDomainName is an AD domain FQDN. Verified on
  // KDLFLOFADSRV2 (2026-10-08): TargetDomainName='BJ-L-PF27GZN7' ==
  // CallerComputerName, not 'SPHKDL' the AD domain. Get-ADUser -Server
  // <workstation> throws "unable to contact server" and returns null.
  // DB evidence on 4625: target_user_display_name populated with "184132"
  // (a number — operator flagged as broken). 1.0.5 reverts to the R139.1
  // default-Get-ADUser idiom (no -Server, queries the current user
  // logon domain = local AD domain on a DC), which works for 99% of
  // 4625 lockouts. Cache key simplified to SAM only; null lookups are
  // NOT cached (R158.50.7e lesson — caching null locked the bad state
  // for 24h). Machine-account filter still in effect.
  // R158.58 (2026-10-09) — bump 1.0.7 → 1.0.8. operator /failed-logon-2h
  // 反馈 'PS1 收 30min 但 cadence 15min → 50% overlap 拉两次'. ship 选
  // '1.0.8 改 PS1 window 1800s → 900s 对齐 intervalSec' (中心端改, 不升
  // agent). collect.ps1 sha256+size 变, 33 DC 5min syncTimer 拉新 PS1 +
  // manifest, package-manager.js:355 检 hash 变化自动 reschedule. PS1 内容
  // 仅改 1 行 (line 211 AddSeconds(-1800) → -900) + 头注释 R158.58 block,
  // PS5.1 parser-verify 必跑 (R158.50.7k audit).
  // R158.72.x.18 (2026-10-17) — bump ad_failed_logon_collector 1.0.8 → 1.0.9.
  //   ship reason: 5 包 ship 删 manifest.agent.cronExpr 闭合. 1.0.8 PS1
  //   一字不差, manifest 删 cronExpr. 5min sync 不下新 PS1.
  { name: 'ad_failed_logon_collector', version: '1.0.9' },
  // R158.86 (2026-10-12) — ad_member_port_latency 1.0.0 RETIRED.
  //   Operator directive: "AD_member_prt_lantency 这个包删除 因为没有
  //   这个需求". Thorough deletion: this BUILTIN_PACKAGES entry removed,
  //   system-alert-engine.js detectPortLatencyHigh detector + runDetector
  //   call + kindLabel entry removed, data/packages/ad_member_port_latency
  //   directory deleted. Manual cleanup (operator): package_scripts row,
  //   package_policies row, pkg_ad_member_port_latency schema DROP —
  //   sqlcmd scripts documented in diag/r158-86-port-latency-cleanup.md.
  //   system_config.system_alert_port_latency_ms field kept (orphan cfg;
  //   would be needed by any future detector restart).
  //
  // R158.46 (2026-10-06) — 17 个 user_/group_ 命令不走 collect 包, 走 agent
  //   静态脚本路径 agent/scripts/ad-admin-users.ps1 + ad-admin-groups.ps1.
  //   这 2 个 PS1 是新增 (之前物理不存在), dispatcher pickScript 通过
  //   commandType prefix (`user_` → users.ps1, `group_` → groups.ps1) 找.
  //   部署时跟 agent.js 一起 checkout 即可, 不需中心 BUILTIN_PACKAGES 列表.
  //
  // R158.60.10-rollback (2026-10-09) — 4 个 ad_ad_* 包 (ad_ad_ou_create,
  //   ad_ad_object_move, ad_ad_users_write, ad_ad_groups_write) 整体
  //   下线 (operator directive "将这四个包不要放在这里了, 也不要注册了,
  //   放在agentinstall里面, 我自己手动推好了"). 走 agent bundle 内嵌
  //   静态 PS1 (ou_create / object_move 走 ad_ad_ou_create.ps1 之类静态
  //   副本, user_/group_ 走 ad-admin-{users,groups}.ps1). R158.46 + R158.56c-d
  //   ship 时的 2 行 BUILTIN_PACKAGES 注册 + R158.60.10 isOnDemand 修法
  //   全部回滚. centre 端不再 publish 这 4 个包, syncFromCenter 不会拉到
  //   cache, dispatch path 全走 agent bundle 内嵌脚本.
  // R158.10 (2026-10-01) — operator decision: outbound partner 不再需要,
  //   ad_partner_outbound_discover 包整体下线 (seeder 不会再注册,
  //   centre cron-scheduler 不会再 fire, agent 端 syncFromCenter 见
  //   enabled=0 → uninstall 本地副本)。仅保留 inbound discover。

  // R158.78 (2026-10-12) — member_eventlog_collector 1.0.0
  //   first member-lineage package, public-table mode.
  { name: 'member_eventlog_collector', version: '1.0.0' },
  // R158.100 (2026-10-13) — member_admin_groups 1.0.0. Mirror of
  //   ad_admin_members 1.0.1 (R158.47/R158.52) but for member-server
  //   local-group membership: Get-LocalGroupMember in collect.ps1 instead
  //   of Get-ADGroupMember. Public-table mode (no manifest.database block),
  //   runner.js post-hook MERGE dedup on (hostname, group_name, member_sid).
  //   24h cadence (跟 ad_admin_members 1:1, admin 变更不频繁). SCOPE_OVERRIDE
  //   挂 'agent_type:non-ad' (R158.86.5 强 invariant). 0 AD RSAT 0 FK 强制.
  { name: 'member_admin_groups', version: '1.0.0' },
  // R158.86 (2026-10-12) — first member-only lineage package.
  //   Public-table mode (no manifest.database block), data lands in
  //   ad_member_os_baseline / ad_member_os_baseline_latest. Replaces
  //   ad_os_baseline's role on the /memberServer/packages tab.
  // R158.86.4 (2026-10-12) — 1.0.0 → 1.0.1: 扩 19 字段 (跟 ad_os_baseline
  //   1.0.7 metricSchema 平行, 加 cpu_brand/bios_info/motherboard/system_info/
  //   mem_total_bytes/disks[]/services/events[]/memory_modules[]/network_info/
  //   cpu/ips[] 14 字段). 1.0.0 ship 时精简到 5 字段, operator 反馈
  //   "os baseline 少了很多内容, 例如品牌, 磁盘品牌和分区的内容".
  //   R157.4 seeder 检测 version mismatch 自动 upsert 1.0.1.
  { name: 'member_os_baseline_collector', version: '1.0.1' }
];

// Returns the list of migration files to apply for a given package +
// dialect. Dialect resolution mirrors installer.installPackage: mssql
// prefers migrations/mssql/*.sql and falls back to migrations/*.sql;
// mysql takes migrations/*.sql only (never the mssql subfolder — those
// files reference [pkg_<name>].<table> which is valid MSSQL but breaks
// mysql's parser). Files are returned in lexicographic order so
// 001_initial.sql runs before 002_*.sql.
function resolveMigrationFiles({ pkgDir, dialect }) {
  // Dialect resolution: mssql prefers migrations/mssql/*.sql and only
  // falls back to migrations/*.sql when no MSSQL-specific files exist.
  // Including both when both exist (the pre-fix behavior) caused every
  // migration file to be applied twice under MSSQL: the MSSQL one and the
  // MySQL-shaped one (same filename, different content), producing duplicate
  // CREATE TABLE statements + duplicate schema_migrations INSERTs. mysql
  // always uses migrations/*.sql only — never the mssql/ subfolder, which
  // uses bracketed identifiers that the MySQL parser rejects.
  if (dialect === 'mssql') {
    const mssqlDir = path.join(pkgDir, 'migrations', 'mssql');
    if (fs.existsSync(mssqlDir)) {
      const mssqlFiles = fs.readdirSync(mssqlDir).filter(f => f.endsWith('.sql')).sort();
      if (mssqlFiles.length > 0) {
        return mssqlFiles.map(filename => ({
          filename,
          content: fs.readFileSync(path.join(mssqlDir, filename), 'utf8')
        }));
      }
    }
    const fallbackDir = path.join(pkgDir, 'migrations');
    if (fs.existsSync(fallbackDir)) {
      const files = fs.readdirSync(fallbackDir).filter(f => f.endsWith('.sql')).sort();
      return files.map(filename => ({
        filename,
        content: fs.readFileSync(path.join(fallbackDir, filename), 'utf8')
      }));
    }
    return [];
  }
  // mysql: only top-level migrations/, skip any mssql/ subfolder.
  const dir = path.join(pkgDir, 'migrations');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  return files.map(filename => ({
    filename,
    content: fs.readFileSync(path.join(dir, filename), 'utf8')
  }));
}

export async function seedBuiltinPackages({ dataDir, sourceDir, writeAudit, db, logger }) {
  if (!dataDir) throw new Error('seedBuiltinPackages: dataDir required');
  if (!sourceDir) throw new Error('seedBuiltinPackages: sourceDir required');
  // R161.5 (2026-10-26) — 失败必须落 pino 文件日志.
  // 历史缺陷: per-package catch 只 console.warn, 而 center 的 pino stdout
  // 是空的 (日志只进 center/Logs/center.<date>.<n>.log) ⇒ 操作员在日志里
  // 永远看不到"哪个包 seed 失败、为什么失败". 5 个包因此静默掉了半年.
  // 现在: 生产路径 (server.js) 一定传 logger ⇒ warn/error 落文件日志;
  // logger 缺席时 (单测/一次性脚本) 退到 console, **不静默**.
  const log = logger || {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
  };

  for (const pkg of BUILTIN_PACKAGES) {
    // R158.50.7i-fix (2026-10-08) — per-package try/catch. The original
    // loop was fail-fast: any throw (e.g. "no migration files for
    // ad_os_baseline" on a bumped version's dataDir copy) propagated up
    // to server.js's top-level try/catch, which only logged a warn. The
    // result: the first failing package aborted the loop and every
    // subsequent package in BUILTIN_PACKAGES (5-10 more, depending on
    // which bump we're shipping) silently never reached installScript
    // / setPolicy. With per-package isolation, one bad bump doesn't
    // strand the rest. We log the failure as a warn (loud enough for
    // operators to spot in /api/agent/packages) but keep iterating.
    try {
    const target = path.join(dataDir, pkg.name, pkg.version);
    fs.mkdirSync(target, { recursive: true });
    // Idempotency guard for file copy: skip if manifest.json already present.
    const manifestPath = path.join(target, 'manifest.json');
    const src = path.join(sourceDir, pkg.name, pkg.version);
    const needsCopy = !fs.existsSync(manifestPath);
    if (needsCopy) {
      if (!fs.existsSync(src)) {
        // Source missing is a hard error for the bundled layout — if the
        // publish/ mirror is broken, we want this to surface loudly. The
        // operator can recover by re-running the mirror script (scripts/
        // mirror-and-zip.ps1) and restarting.
        throw new Error(`seedBuiltinPackages: source not found: ${src}`);
      }
      copyDirSync(src, target);
    }
    if (!fs.existsSync(manifestPath)) {
      // copyDirSync 在 src === dst 时是 no-op (同路径保护, 见函数末尾) ⇒
      // manifest.json 仍可能不存在. 显式报出来, 不要让后面的
      // readFileSync 抛一个看不出上下文的 ENOENT.
      throw new Error(`seedBuiltinPackages: manifest.json missing for ${pkg.name} ${pkg.version}: ${manifestPath}`);
    }

    // ── R161.5 (2026-10-26) manifest 身份自愈 ───────────────────────
    // 历史缺陷: 5 个包的 manifest.json 里 name 写成连字符形式
    // (ad-os-baseline), 与包目录名 / DB 名 (ad_os_baseline) 不一致 ⇒
    // script-service.validateManifest 抛 INVALID_MANIFEST ⇒ seeder 在
    // installScript 之前就把整个包跳过 ⇒ 包从未注册 ⇒ pkg_* schema 从未
    // 创建 ⇒ GET /api/os-baseline 500. 而这个失败是**静默**的 (per-package
    // catch 只 console.warn, pino stdout 为空) ⇒ 操作员完全看不到.
    //
    // 现在: 磁盘上的 manifest 存在但 (a) JSON 解析失败 或 (b) name 不等于
    // 包名 ⇒ 用内置源里的 manifest.json 覆盖修复, 并落 warn 日志.
    // 只动 manifest.json —— operator 可能在 dataDir 里改过脚本/迁移文件,
    // 那些一律不覆盖.
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    // Defensive BOM strip — packaged manifest.json files from a Windows
    // build pipeline occasionally carry a UTF-8 BOM, which JSON.parse
    // rejects. Same defensive pattern as installer.js for zip-extracted
    // manifests.
    let manifest = null;
    let manifestParseError = null;
    try {
      manifest = JSON.parse(manifestRaw.replace(/^﻿/, ''));
    } catch (parseErr) {
      manifestParseError = parseErr;
    }
    if (!manifest || manifest.name !== pkg.name) {
      const srcManifest = path.join(src, 'manifest.json');
      if (!fs.existsSync(srcManifest)) {
        throw new Error(
          `seedBuiltinPackages: manifest for ${pkg.name} ${pkg.version} is invalid ` +
          `(parsed=${manifest ? JSON.stringify(manifest.name) : 'null'}, ` +
          `parseError=${manifestParseError ? manifestParseError.message : 'n/a'}) ` +
          `and there is no bundled source manifest to repair from: ${srcManifest}`
        );
      }
      if (path.resolve(srcManifest) === path.resolve(manifestPath)) {
        // 源与目标是同一份文件 (server.js 的 dataDir = cwd + '/data/packages'
        // 在 cwd=Server/center 时就等于 sourceDir) ⇒ 无从自愈, 直接报错
        // (下游 installScript 会再抛一次 INVALID_MANIFEST, 但这里的消息
        //  能直接指出"磁盘上的 manifest.json 身份不对").
        throw new Error(
          `seedBuiltinPackages: manifest.name mismatch for ${pkg.name} ${pkg.version}: ` +
          `manifest.name=${manifest ? JSON.stringify(manifest.name) : 'null'} ` +
          `(expected ${pkg.name}); source and target are the same file, cannot self-repair`
        );
      }
      fs.copyFileSync(srcManifest, manifestPath);
      log.warn(
        {
          pkg: pkg.name,
          version: pkg.version,
          foundName: manifest ? manifest.name : null,
          parseError: manifestParseError ? manifestParseError.message : null
        },
        'seedBuiltinPackages: repaired invalid manifest from bundled source'
      );
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
    }

    // R157.8 — read the script file ONCE per package (code review M5).
    // Pre-fix, the four if/else-if branches each independently called
    // fs.readFileSync on the same path — 11 packages × 3-4 reads =
    // ~40 synchronous IO syscalls per boot. Cache both raw content and
    // sha here; every branch below uses these two values.
    const scriptFilename = scriptFilenameFor(pkg.name);
    const scriptPath = path.join(target, scriptFilename);
    if (!fs.existsSync(scriptPath)) {
      // R161.5 — 脚本文件缺失自愈. 历史缺陷: ad_admin_members/1.0.2 的
      // collect.ps1 丢了 ⇒ 下面的 readFileSync 抛 ENOENT ⇒ 整包跳过 ⇒
      // 该包从未注册. 从内置源补回缺失的脚本文件 (只补缺失的, 不覆盖
      // operator 改过的版本).
      const srcScript = path.join(src, scriptFilename);
      if (fs.existsSync(srcScript) && path.resolve(srcScript) !== path.resolve(scriptPath)) {
        fs.copyFileSync(srcScript, scriptPath);
        log.warn(
          { pkg: pkg.name, version: pkg.version, script: scriptFilename },
          'seedBuiltinPackages: restored missing script file from bundled source'
        );
      } else {
        throw new Error(
          `seedBuiltinPackages: script file missing for ${pkg.name} ${pkg.version}: ${scriptPath}`
        );
      }
    }
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    const scriptSha256 = hashContent(scriptContent);

    // R66 DB registration: when db is provided, write through
    // script-service.installScript + setPolicy (V1 two-table path).
    // installScript seeds the script as DISABLED (its default), then
    // setPolicy flips enabled=true — the audit log captures both actions.
    //
    // Idempotency: pre-check via packageScripts.get; skip installScript
    // when the script row already exists, then always re-apply
    // enabled=true. The enabled=true re-apply is the built-in enable
    // contract — operator-driven disable via UI does not persist across
    // restarts. Runs on every normal-mode restart, which is what fixes
    // round-12 runAllNow count:0 — pre-fix installs seeded files but
    // never wrote the row, so /api/agent/packages returned [] and
    // runAllNow() logged `count: 0`.
    if (db) {
      const existing = await packageScripts.get(db, pkg.name);
      // R157.8 — setPolicy should only fire when the policy values
      // actually changed (code review M3). Pre-fix, setPolicy ran
      // unconditionally on every boot — 11 packages × daily restart
      // = 11 redundant UPDATE package_policies + 11 set_policy audit
      // rows per boot. Now we compare the stored policy values to the
      // bundled manifest; only fire setPolicy on mismatch.
      // Note: packageScripts.get returns the script row, NOT the policy
      // row — package_policies lives in a separate table. We need a
      // second lookup for the existing policy to compare. The two reads
      // are independent (Promise.all safe).
      // R158.60.10 (2026-10-09) — on-demand packages
      //   (manifest.type='command', e.g. ad_ad_groups_write) write
      //   intervalSec=0 to package_policies. That's the
      //   schedule-suppression signal agent/package-manager.js:316-319
      //   understands as "skip setInterval but keep the row in the
      //   cache for R75 dispatchAdCommand pickScript". The bundled
      //   manifest for these packages intentionally has no
      //   agent.intervalSec (on-demand design — see R158.40 + R158.56c).
      //   Pre-fix, the `?? 3600` fallback silently coerced on-demand
      //   packages to 1-hour schedules, and they ran hourly forever
      //   (ad_ad_groups_write hit 4 runs at 02:30/03:30/04:30/05:30 UTC
      //   on 2026-10-09 before this fix shipped).
      // R158.72.x.13 (2026-10-17) — 第 3 idiom (cronExpr=2:00 daily).
      //   操作员 directive 字面 "另外支持每天启动时间定义 2:00:00 + agent
      //   端 cron 字段 + 中心端 cron fire 0 双 fire". 走 R158.60.10 双 idiom
      //   1:1 平行扩展: 若 manifest.agent.cronExpr 存在 → wantInterval=0
      //   (走 R158.60.10 on-demand skip 范式 1:1 平行, 中心端 cron = 唯一
      //   fire 源, agent 端 0.1.1 走 setTimeout nextFire 1 拍/天 0 setInterval),
      //   0 cronExpr 走原 wantInterval 范式. 0 引新 wrapper, 复用 R158.60.10
      //   intervalSec=0 on-demand skip signal 1:1 平行 (R158.69.3 锁 agent
      //   0.1.1 已吃 intervalSec=0 idiom 0 必改 binary 走 setTimeout 路径).
      //   跟 R158.72.x.5 / .x.7 / .x.11 / .x.12 1:1 平行 (中心端限制
      //   schedule 0 必破 1:1 平行 R158.License 操作员 directive).
      const isOnDemand = manifest.type === 'command';
      const wantCronExpr = manifest.agent?.cronExpr || null;
      const wantInterval = isOnDemand
        ? 0
        : (wantCronExpr ? 0 : (manifest.agent?.intervalSec ?? 3600));
      const wantTimeout  = manifest.agent?.timeoutMs ?? 30000;
      const wantEnabled  = true;
      // R158.86.5 — package_policies.scope 拆细: 白名单 SCOPE_OVERRIDE
      //   18 包显式给, 未列 (e.g. ad_ad_ou_create 等 on-demand command
      //   包不在 BUILTIN_PACKAGES) 走 'global' 默认 (跟 R158.60.10
      //   on-demand 不冲突 — 走 ad_admin_commands 单独 lifecycle).
      const wantScope = SCOPE_OVERRIDE[pkg.name] || 'global';
      const existingPolicy = existing ? await packagePolicies.getByName(db, pkg.name) : null;
      // R158.72.x.13 (2026-10-17) — policyChanged 加 cron_expr check.
      //   1:1 平行 intervalSec check (existing.cron_expr ?? null) !==
      //   (wantCronExpr ?? null). null vs null = 0 change, null vs '0 2
      //   * * *' = change, '0 2 * * *' vs null = change. 0 cronExpr 必
      //   撤 (走 R158.72.x.11 self-interval anchor 范式, agent 0.1.0
      //   setInterval intervalSec=86400 24h 1 拍 0 中心端 cron fire).
      //   跟 R158.72.x.5 .x.7 .x.11 .x.12 1:1 平行 (seeder 写新 cron_expr
      //   字段, 0 引新 wrapper).
      const policyChanged = !existing
        || !existingPolicy
        || Number(existingPolicy.intervalSec ?? -1) !== Number(wantInterval)
        || Number(existingPolicy.timeoutMs ?? -1)  !== Number(wantTimeout)
        || Number(existingPolicy.enabled === true ? 1 : 0) !== Number(wantEnabled)
        || (existingPolicy.scope ?? 'global') !== wantScope
        || (existingPolicy.cron_expr ?? null) !== (wantCronExpr ?? null);
      if (!existing) {
        // R130 — pass the raw manifest.json (including the `database`
        // block) into installScript so the script row's manifest_json
        // column preserves the v2 metricstore keys. Pre-fix, installScript
        // built a stub from the individual params and dropped everything
        // except name/version/type/description/agent.type — the `database`
        // block was lost, metricstore fell back to the v1 path, and
        // packages like ad_lockout_summary never wrote to their
        // `pkg_<name>.metrics` table. Frontend DcCard.vue lockedCount
        // field showed '—' forever as a result. After this fix the next
        // ad_lockout_summary run lands a real row in
        // pkg_ad_lockout_summary.metrics and /api/dcs/summary returns a
        // real lockedCount.
        await installScript({
          db, writeAudit,
          name: pkg.name,
          content: scriptContent,
          type: manifest.type || 'gauge',
          agentType: manifest.agent?.type || 'ad',
          description: manifest.description || '',
          intervalSec: wantInterval,
          timeoutMs: wantTimeout,
          source: 'builtin-seed',
          manifest,
          scope: wantScope
        });
      } else if (existing.version !== pkg.version) {
        // R157.4 — auto-upgrade on version mismatch. When the bundled
        // manifest.json has a higher version than what's installed in
        // package_scripts (e.g. partner-discover 1.0.0 → 1.1.0), we
        // overwrite the script row with the new content + manifest.
        // This is the bootstrap path that lets a centre upgrade propagate
        // to all agents on their next syncFromCenter without operator
        // intervention. We don't change package_policies here — setPolicy
        // below re-applies enabled=true but the new intervalSec/timeoutMs
        // need their own re-apply (also below). The audit entry captures
        // the version bump so dashboards show "auto-upgraded on YYYY-MM-DD".
        await packageScripts.upsert(db, {
          name: pkg.name,
          version: pkg.version,
          scriptContent,
          scriptSha256,
          manifest,
          source: 'builtin-seed-upgrade'
        });
        // R158.60.9 (2026-10-09) — append a history row so /admin/packages
        // version history shows the version bump. recordPublish is
        // best-effort (script-service.js:101-105 catch + swallow errors,
        // so the operator-visible seeder path never breaks). Pre-fix
        // builtin version bumps (e.g. ad_failed_logon_collector 1.0.0 →
        // 1.0.8) wrote 0 history rows, leaving the operator seeing just
        // 1.0.0 in the fold-out. Forward-fix (operator-selected): let
        // future bumps accumulate, intermediate versions stay unknown.
        await recordPublish({
          name: pkg.name, version: pkg.version, scriptSha256,
          manifest, source: 'builtin-seed-upgrade'
        });
        writeAudit?.({
          action: 'upgrade_builtin_package',
          target: 'packages',
          payload: { name: pkg.name, fromVersion: existing.version, toVersion: pkg.version }
        });
      } else if (
        // R157.6 — content OR metadata drift detection. The seeder
        // bumps package_scripts when EITHER:
        //   (a) the on-disk file's sha256 differs from what's stored
        //       (operator edited the script content), OR
        //   (b) the manifest_json metadata differs — most importantly
        //       `agent.script` (operator renamed the PowerShell entry
        //       point, e.g. collect.ps1 → collect_inbound_partner.ps1).
        // Pre-R157.6 the seeder only checked (a). A pure rename of the
        // script file leaves the content bytes intact, so the sha stays
        // the same and the seeder silently kept the stale manifest_json
        // (agent.script = "collect.ps1") forever — agent pulled the
        // OLD filename from manifest and broke at write time.
        //
        // R157.8 — drop the scriptSha256 truthy guard (code review M4).
        // Pre-fix: rows where script_sha256 is NULL (legacy data) skipped
        // the entire drift detection — manifest metadata never refreshed.
        // Post-fix: detect drift even when stored sha is null. We
        // compute the on-disk sha once (scriptSha256 above) and compare
        // it case-insensitively against whatever's stored (null becomes
        // "always mismatch" via String(null).toLowerCase() === "null"
        // !== real sha, so the branch fires on first boot after the fix
        // and never again — idempotent).
        (existing.scriptSha256?.toLowerCase?.() ?? '') !== scriptSha256.toLowerCase()
         || existing.manifest?.agent?.script !== manifest?.agent?.script
      ) {
        const reason = (existing.scriptSha256?.toLowerCase?.() ?? '') !== scriptSha256.toLowerCase()
          ? 'content_sha_mismatch'
          : 'manifest_metadata_mismatch';
        // R157.8 — R157.6-DEBUG console.error removed (code review L3).
        // The audit row already carries oldScript/newScript — operators
        // can see drift there without stderr noise.
        await packageScripts.upsert(db, {
          name: pkg.name,
          version: pkg.version,
          scriptContent,
          scriptSha256,
          manifest,
          source: 'builtin-seed-content-refresh'
        });
        // R158.60.9 (2026-10-09) — content refresh is also a publish event.
        // version + sha may equal the prior row if the operator just
        // renamed the PS1 entry point (manifest.agent.script drift
        // without sha change). The UNIQUE (name, version, sha) index
        // rejects dup, so recordPublish is effectively a no-op there —
        // but for sha-changing content edits, it adds the new history
        // row that was previously missing.
        await recordPublish({
          name: pkg.name, version: pkg.version, scriptSha256,
          manifest, source: 'builtin-seed-content-refresh'
        });
        writeAudit?.({
          action: 'refresh_builtin_package_content',
          target: 'packages',
          payload: {
            name: pkg.name,
            version: pkg.version,
            filename: scriptFilename,
            reason,
            oldScript: existing.manifest?.agent?.script ?? null,
            newScript: manifest?.agent?.script ?? null,
            oldSha16: (existing.scriptSha256 ?? '').slice(0, 16),
            newSha16: scriptSha256.slice(0, 16)
          }
        });
      } else if (!existing.manifest?.database && manifest.database) {
        // R130 — backfill: the script row exists from a pre-R130 install
        // and is missing the `database` block in its stored manifest_json.
        // Patch the manifest_json directly via packageScripts.upsert (it's
        // an UPSERT keyed on name, so we just overwrite with the full
        // raw manifest). This path fires on the first restart after the
        // fix ships; once all builtin rows carry the `database` block the
        // condition is permanently false and this branch becomes a true
        // no-op. We don't touch scriptContent/scriptSha256 so no audit
        // noise beyond the seed_builtin_<name> action the seeder already
        // emits. Best-effort: a backfill failure is logged but does not
        // block startup — the next restart will retry.
        try {
          await packageScripts.upsert(db, {
            name: pkg.name,
            version: existing.version,
            scriptContent: existing.scriptContent,
            scriptSha256: existing.scriptSha256,
            manifest,
            source: existing.source
          });
          writeAudit?.({
            action: 'backfill_manifest_database_block',
            target: 'packages',
            payload: { name: pkg.name, schemaName: manifest.database.schemaName }
          });
        } catch (e) {
          // Best-effort: log it so the operator can see the drift; the next
          // restart will retry the backfill.
          // R161.5 — 改走 pino (log), 不再是 console.error (stdout 为空,
          // 操作员在日志文件里看不到).
          log.error(
            { pkg: pkg.name, version: pkg.version, err: e?.message || String(e) },
            'seedBuiltinPackages: failed to backfill manifest.database'
          );
        }
      }
      // R157.8 — setPolicy ONLY when policy values differ (code review
      // M3). Pre-fix: unconditional setPolicy({enabled:true, intervalSec,
      // timeoutMs}) on every normal-mode restart wrote 11 redundant
      // UPDATE package_policies + 11 set_policy audit rows per boot,
      // drowning real operator actions. Now: skip setPolicy when the
      // stored policy already matches the bundled manifest's policy —
      // most restarts hit this no-op fast path.
      if (policyChanged) {
        // R158.60.10 (2026-10-09) — on-demand packages
        //   (manifest.type='command', e.g. ad_ad_groups_write /
        //   ad_ad_users_write / ad_ad_ou_create / ad_ad_object_move)
        //   write intervalSec=0 to package_policies as the
        //   schedule-suppression signal. agent/package-manager.js:316-319
        //   already understands `!intervalSec || intervalSec <= 0` as
        //   "skip setInterval" — the row stays in the agent cache so R75
        //   dispatchAdCommand's pickScript.fromPackage lookup still finds
        //   the package's collect.ps1, but no periodic timer ever fires.
        //
        //   Bypass setPolicy's `5..86400` validation here. setPolicy is
        //   the operator-facing API guard (rejects typos like
        //   intervalSec=0.5 or 0 from /api/admin/packages), but the
        //   seeder is the trusted centre-side path that *defines* the
        //   on-demand contract — it must be able to write 0. Direct
        //   packagePolicies.updatePartial hits the DB with the same
        //   column shape but no JS validation, and we still emit a
        //   set_policy audit row so the policy history stays uniform.
        await packagePolicies.updatePartial(db, pkg.name, {
          enabled: wantEnabled,
          intervalSec: wantInterval,
          timeoutMs: wantTimeout,
          scope: wantScope,
          // R158.72.x.13 (2026-10-17) — +cron_expr 字段 (R158.72.x.13 ALTER
          //   ADD cron_expr VARCHAR(64) NULL 1:1 平行 1 次性). wantCronExpr
          //   null 走 setPolicy 透传 NULL (走 R158.72.x.11 self-interval
          //   anchor 范式 0 中心端 cron fire, agent 端 0.1.0 setInterval
          //   24h 1 拍), wantCronExpr = '0 2 * * *' 走中心端 cron fire
          //   (R158.72.x.13 ship 闭合 范式). updatePartial 0 必改, 透传
          //   column shape 跟 R158.60.10 intervalSec 1:1 平行.
          // R158.72.x.14 (2026-10-17) — updatePartial.allowed 驼峰 (line 137
          //   cronExpr), 改 'cron_expr' (下划线) 会静默跳过, 走 '0 2 * * *'
          //   0 写入, agent 端 setInterval(0) = 连续 fire (R158.X.99.10
          //   aac 1:1 平行). 改驼峰 'cronExpr'.
          cronExpr: wantCronExpr
        });
        if (writeAudit) {
          await writeAudit({
            action: 'set_policy',
            target: 'packages',
            // R158.72.x.13 (2026-10-17) — fields 数组加 cron_expr 1 项.
            //   跟 R158.72.x.5 / .x.7 / .x.11 / .x.12 1:1 平行 (audit 字段
            //   必 跟 写字段 一致 0 漂移). 0 引新 audit action / 0 引新
            //   payload shape.
            payload: { name: pkg.name, fields: ['enabled', 'intervalSec', 'timeoutMs', 'scope', 'cron_expr'], source: 'builtin-seed-bypass' }
          });
        }
      }
    }

    // Round-13 fix: DDL apply. After script row exists, run the package
    // migrations so metricstore v2 INSERT has a target table.
    // Idempotent: schema_migrations tracks applied filenames, and the
    // per-package SQL files are CREATE TABLE IF NOT EXISTS so a missing
    // schema_migrations row still produces a safe second apply (the table
    // already exists → CREATE TABLE IF NOT EXISTS is a no-op, but we
    // still INSERT into schema_migrations so the next restart is fully
    // a no-op). Best-effort: a DDL failure here must throw so server.js
    // surfaces it in the boot log — silently swallowing leaves the
    // package in the broken "files exist, row exists, table missing"
    // state we just fixed.
    if (db && manifest.database) {
      const schemaName = manifest.database.schemaName;
      if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
        throw new Error(`seedBuiltinPackages: invalid schemaName in manifest for ${pkg.name}: ${schemaName}`);
      }
      const files = resolveMigrationFiles({ pkgDir: target, dialect: db.dialect });
      // R158.50.7i-fix (2026-10-08) — silent skip when the bundled
      // migrations/ directory is missing. The original guard (round-12
      // fail-loud) was right for first install on a clean DB, but
      // breaks down on every subsequent restart once a package is
      // bumped in-place: the on-disk dataDir/<name>/<version>/ directory
      // only has the files we explicitly copied (PS1 + manifest.json),
      // and the migrations/ subdir was created by the prior version's
      // copy. schema_migrations in pkg_<name> is the real source of
      // truth — if it tracks 002 + 003 already, the package is fully
      // applied and we just installScript / setPolicy without re-applying.
      // Pre-fix, the round-12 throw aborted the entire BUILTIN_PACKAGES
      // loop (top-level try/catch in server.js caught it, so subsequent
      // packages like ad_lockout_list 1.0.6 / ad_eventlog_collector
      // 1.0.6 / ad_failed_logon_collector 1.0.5 NEVER got
      // installScript'd — package_scripts table stuck on the pre-bump
      // version, agent bundles never re-pulled, operator's R158.50.7l
      // / R158.50.7i fixes were dead-on-arrival).
      //
      // Round-12 fix preserved on first install: resolveMigrationFiles
      // also returns [] when the schema has never been created, but the
      // createSchemaMigrationsTable + listAppliedMigrations path below
      // is itself idempotent (no-op on existing tables) and
      // applyMigrations gates on `toApply.length > 0`, so the schema
      // bootstrap is preserved. The lesson is: "missing files on disk
      // is not a hard error — the DB is the real source of truth".
      if (!files.length) {
        // best-effort: log so the operator can spot the layout drift
        // but DO NOT throw. continue to installScript below.
        // R161.5 — 落 pino (log), 操作员在 center 日志文件里能直接看到
        // "哪个包没有迁移文件" —— 这正是"表没被建出来"的第一现场.
        log.warn(
          { pkg: pkg.name, version: pkg.version, dialect: db.dialect },
          'seedBuiltinPackages: no migration files on disk; relying on schema_migrations'
        );
      }
      // Skip already-applied filenames so a restart is a true no-op for
      // the migration block (parallel to installer.upgradePackage).
      // Pass dialect through so MSSQL gets bracketed identifiers (round-14).
      //
      // Round-14 fix: previously listAppliedMigrations ran BEFORE
      // ensureSchema/createSchemaMigrationsTable, which on a fresh DB
      // crashed with "Invalid object name 'pkg_<name>.schema_migrations'"
      // (MSSQL) or "Table doesn't exist" (MySQL). The table we need to
      // query must exist before we query it. Both ensureSchema and
      // createSchemaMigrationsTable are themselves idempotent, so re-running
      // them here is a no-op on restart and the only-order-that-works on
      // first boot.
      if (!(await schemaExists(db, schemaName, db.dialect))) {
        await ensureSchema(db, schemaName, db.dialect);
      }
      await createSchemaMigrationsTable(db, schemaName, db.dialect);
      const applied = await listAppliedMigrations(db, schemaName, db.dialect);
      const appliedSet = new Set(applied.map(r => r.filename));
      const toApply = files.filter(f => !appliedSet.has(f.filename));
      if (toApply.length) {
        // skipSandbox: built-in packages are reviewed in-tree, never
        // uploaded by an external author. The sandbox's current rules
        // reject MSSQL control-flow patterns and `SELECT 1 FROM
        // sys.tables` guards that legitimate built-in MSSQL migrations
        // need. The installer path keeps the sandbox on — that's the
        // untrusted-upload boundary.
        await applyMigrations(db, { schemaName, dialect: db.dialect, files: toApply, skipSandbox: true });
        await markMigrationsApplied(db, {
          schemaName,
          version: pkg.version,
          filenames: toApply.map(f => f.filename)
        });
      }
    }

    if (needsCopy && writeAudit) {
      // Hyphens → underscores to fit the audit action key style used
      // elsewhere (e.g. seed_listen_port). Best-effort: any thrown error
      // is swallowed by writeAudit itself; we don't await-catch here to
      // stay aligned with the documented audit contract.
      await writeAudit({
        action: `seed_builtin_${pkg.name.replace(/[^a-z0-9_]/gi, '_')}`,
        target: 'packages',
        payload: { name: pkg.name, version: pkg.version }
      });
    }
    } catch (perPkgErr) {
      // R158.50.7i-fix — keep iterating. One package's failure must
      // not strand the rest of BUILTIN_PACKAGES.
      // R161.5 (2026-10-26) — 落 pino 文件日志. 之前只 console.warn, 而
      // center 的 stdout 是空的 ⇒ 操作员在日志里看不到任何失败原因 ⇒
      // 5 个包因为 manifest.name 连字符被静默丢掉半年都没人发现.
      log.error(
        {
          pkg: pkg.name,
          version: pkg.version,
          err: perPkgErr?.message || String(perPkgErr),
          code: perPkgErr?.code || null
        },
        'seedBuiltinPackages: package seed failed'
      );
    }
  }
}

function copyDirSync(src, dst) {
  // R161.5 (2026-10-26) — 同路径保护. server.js 的 dataDir 是
  // `process.cwd() + '/data/packages'`, 而 sourceDir 在 cwd=Server/center
  // 时恰好就是 `Server/center/data/packages` ⇒ src === dst. 原来的实现
  // 会走 fs.copyFileSync(同一路径): Windows 抛 EINVAL, POSIX 上会把
  // 文件截断成空 ⇒ 源包被自己毁掉. 直接 no-op.
  if (path.resolve(src) === path.resolve(dst)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}