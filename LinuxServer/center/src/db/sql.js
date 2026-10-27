// Central SQL registry. One frozen dictionary per dialect, selected at boot
// by db.dialect. Service code reads db.sql.<domain>.<query> and gets back a
// plain string for the active dialect — never a sub-object.
//
// Placeholders: use `?` only (mysql2 style). The mssql driver wrapper
// rewrites `?` -> `@p1, @p2, ...` at execute() time; service code never
// sees @p1.

// R161.5 (2026-10-26) — MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串。
//   少数 SQL builder 需要**自己**算出一个时间戳并绑进 DATETIME 谓词
//   (healthSummaryWithHeartbeat 的 stale_reachable 下界), 而 driver 层的
//   normalizeParam 只转换 Date 实例、字符串原样透传 ⇒ 绑 ISO 会 ER 1292。
//   MSSQL 侧 datetime2 接受 ISO ⇒ MSSQL 段保持原样 (零行为变化)。
import { toMysqlDatetime } from '../utils/datetime.js';
// R161.10.2 (2026-10-26) — "行数上限" 的唯一整数闸门 (utils/limit.js)。
//   本文件里凡是把上限**内联**进 SQL 的 builder (MSSQL 的 `TOP n`) 都必须
//   过它: 内联出来是 `TOP 12.7` 时 MSSQL 是语法错误; 绑 `LIMIT ?` 时 mysql2
//   的预处理协议也只吃整数 (见 utils/limit.js 文件头的完整说明)。
import { clampRowLimit } from '../utils/limit.js';
import { memberServers } from './sql/member-servers.js';
// R158.X.115 (2026-10-20) — 主机生命周期状态 (退役 / 暂停管控) helper.
//   ad_dcs + ad_member_servers 两张目录表的 decommissioned_at /
//   monitoring_paused_at 两列由 baseline 建表 + 守卫 ALTER 负责, 本 helper
//   同时导出 ONLINE_DC_WHERE / ONLINE_MEMBER_WHERE 过滤谓词 ——
//   所有在线视图消费方从这里 import 拼 SQL, 避免漏网。
//   applyDcUpsertGuard 由本文件在 buildSql() 构造期施加 (见下方 buildSql),
//   退役 DC 的 UPSERT 保护是 SQL 树的一部分, 不是启动期的运行时改写。
import { hostStatus, applyDcUpsertGuard } from './sql/host-status.js';
// R158.74 (2026-10-11) — ad_member_server_ports 业务端口表 (member-server-ports.js).
//   公共表 pattern (R110.A), 跟 ad_member_servers 老表同 family.
//   PK (hostname, port) + FK→ad_member_servers.hostname ON DELETE CASCADE.
import { memberServerPorts } from './sql/member-server-ports.js';
// R158.78 (2026-10-12) — ad_member_eventlog_* 事件日志专表 (member-eventlog.js).
//   跟 R112 DC 端 ad_eventlog_* 平行但独立: 字段用 hostname 不用 dc_name,
//   LEFT JOIN 走 ad_member_servers + ad_sites (member-server 走 site_id).
//   6 helper × 2 dialect (upsertEvent / upsertSummary / latestSummary /
//   queryEvents / purgeOlderThan).
import { memberEventlog } from './sql/member-eventlog.js';
// R158.86 (2026-10-12) — ad_member_os_baseline + ad_member_os_baseline_latest
//   OS baseline 专表 (member-os-baseline.js). 跟 ad_os_baseline (DC) 平行但
//   独立: 5 metric 字段 (cpu_pct / memory_pct / c_used_pct / disk_free_bytes /
//   services_count), hostname 不是 dc_name, FK CASCADE → ad_member_servers.
//   7 helper × 2 dialect (upsertMetrics / upsertMetricsBatch / upsertLatest /
//   latestByHostname / queryByHostname / purgeOlderThan / purgeLatestByStaleServer).
import { memberOsBaseline } from './sql/member-os-baseline.js';
// R158.79 (2026-10-12) — ad_member_heartbeat 心跳专表 (member-heartbeat.js).
//   跟 R158.78 ad_member_eventlog_* + R158.74 ad_member_server_ports 同 precedent.
//   跟 ad_agent_heartbeat (heartbeat namespace) 平行但独立: PK hostname 不是 agent_id,
//   FK CASCADE -> ad_member_servers.hostname. 3 helper × 2 dialect (upsert / membersList /
//   deleteMemberRow), mount 在 heartbeat.{memberUpsert, membersList, deleteMemberRow} 跟
//   heartbeat.{agentsList, dcsList} 3 平行内聚.
import { memberHeartbeat } from './sql/member-heartbeat.js';
// R158.87 (2026-10-12) — ad_feature_flags 公共表 (feature-flags.js).
//   R158.86.5.2 lesson: COALESCE(?, existing) preserve description, 防止 toggle 抹掉
//   admin 配的 description. 3 helper × 2 dialect (listAll / upsertValue / getByKey).
import { featureFlags } from './sql/feature-flags.js';
// R158.87 (2026-10-12) — ad_system_registration 公共表 (system-registration.js).
//   License 录入 + 查重 + 撤销. 4 helper × 2 dialect (getCurrent / activate / findByHash /
//   deactivate). mssql activate 走 OUTPUT inserted.id 拿新行 id (跟 system-alerts insert 同 precedent).
import { systemRegistration } from './sql/system-registration.js';
// R158.88.B (2026-10-13) — ad_agent_upgrade_rollout 公共表 (rollout.js).
//   6 helper × 2 dialect (insert / getById / listActive / listAll / updateStrategy / markCompleted / markAborted).
//   R158.69.3 lesson 3 永远适用: 0 fleet 改, 0 改 R158.48 fleet 端 upgrade-delivery.js.
//   R158.86.6 enumerate 5 维度 lesson 1:1 闭合.
import { rollout } from './sql/rollout.js';
import { serverGroups } from './sql/server-groups.js';
// R158.68 (2026-10-10) — 系统内置告警. 替代 R158.62/63/67 alert 5 套 (alertRules/alertEvents/alertOutbox/alertMetrics/alertPortLatency).
// 5 detector 共享 system_alerts 表, 邮件走 system_alert_outbox (跟报表 outbox 物理隔离).
import { systemAlerts } from './sql/system-alerts.js';
// R158.Suppression (2026-10-15) — 系统告警抑制表 (操作员主动行级暂停告警).
//   跟 system_alerts 同 SQL helper shape (4 helper × 2 dialect), 但语义不同:
//   单表多 kind 复用, UNIQUE INDEX (kind, scope_ref) 做 upsert 主键.
//   engine.js detectReplicationFailed 在 maybeFire 之前 SELECT isSuppressed,
//   命中 → continue, 0 INSERT + 0 邮件 + 0 bump notify. 跨重启持久化, expires_at
//   NULL = 永久 (操作员主动恢复), 操作员点 DELETE 解除. 0 改 system_alerts;
//   0 改 4 个其他 detector; 0 改 email.js / outbox; 0 改 admin UI (UI 端 button
//   挂在 SiteReplicationMatrixAllView 行级位置, 后台 endpoint 通用).
import { systemAlertSuppressions } from './sql/system-alert-suppressions.js';
import { systemAlertOutbox } from './sql/system-alert-outbox.js';
import { reportEmailOutbox } from './sql/report-email-outbox.js';
// R158.100.C (2026-10-14) — AD 操作通知 outbox SQL helper (ad-notify-outbox.js).
//   跟 system-alert-outbox 1:1 平行, 8 列 INSERT shape. ad_command_id 替 alert_id.
//   投递 loop 跨 3 表 UNION (alert + report + ad_notify), capacity 1/3 each.
//   0 改 system_alert_outbox 既有 / 0 改 report_email_outbox 既有.
import { adNotifyOutbox } from './sql/ad-notify-outbox.js';
// R158.AdminEmail (2026-10-15) — License 通知 outbox SQL helper (license-email-outbox.js).
//   跟 ad-notify-outbox 1:1 平行, 8 列 INSERT shape. license_id 替 ad_command_id.
//   投递 loop 跨 4 表 UNION (alert + report + ad_notify + license), capacity 1/4 each.
//   收件人走 system_config.admin_email (新 KV), 0 改 3 张既有 outbox SQL helper.
import { licenseEmailOutbox, licenseExpiryDedup } from './sql/license-email-outbox.js';
// R158.69 (2026-10-10) — EmailConfigView 新页签 "邮件历史" 后端 SQL helper.
// 不建新表 (operator 决策), UNION ALL 查 system_alert_outbox + report_email_outbox.
// purgeAlertOlderThan / purgeReportOlderThan 给 email-history-retention service 用.
import { emailHistory } from './sql/email-history.js';
// R158.100.B (2026-10-14) — EmailConfigView 7th tab "邮件队列" SQL helper.
// 跟 email-history 1:1 平行, 但只查 sent_at IS NULL (未发出). UNION ALL
// 跨 2 表, 加 retry/delete 4 helper (alert/report 各 1). 操作员队列
// 重发不重置 attempt_count, 放弃硬删 (R158.100-fix markExhausted 双层
// 防御已就位, 删后不复活). 0 改 email-history / 0 改 outbox schema.
import { emailQueue } from './sql/email-queue.js';
import { osBaselineTimeseries } from './sql/os-baseline-timeseries.js';
// R158.68 (2026-10-10) — os-baseline 路由 (api/os-baseline) 的 latest-per-agent
// query, 从 R158.62 alertMetrics.listLatestPerAgent 拆出. 跟 osBaselineTimeseries
// 区别: 这个返最近单行 (UI 列表), 那个返 24h 时序 (UI 折线).
import { osBaselineMetrics } from './sql/os-baseline-metrics.js';
import { packageScriptsHistory as packageScriptsHistorySql } from './sql/package-scripts-history.js';
import { forestRegistry } from './sql/forest-registry.js';
// R158.61 (2026-10-10) — daily/weekly email reports. Daily report history +
// per-recipient subscriptions + report-schedule lookups. Tables in
// db/migrations/mssql/1.0.3-baseline.sql. R158.68 report 邮件 outbox
// 迁独立表 report_email_outbox (上面 import), 跟 system_alert_outbox 分开.
import { reportSchedule, reportRun, reportSubscription } from './sql/reports.js';

const VARIANTS = {
  // 2026-10-19 R158.X.99.27 — mysql dialect enabled. appsettings.json pins
  // db.dialect='mssql' on production, but db/migrations/mysql/ 子目录现在
  // 跟 mssql 1:1 平行, 共 18 个 .sql file. R158.X.99.27 ship 9 个 missing
  // sibling (1.0.1/5/8-13/18) + 6 处 driver branch 改子目录 (services/migrations.js).
  // 切 db.dialect='mysql' 必 dry-run + 备份 (24h+72h probe 必, R158.86 锁).
  mysql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC LIMIT 1'
    },
    replication: {
      upsertStatus: `INSERT INTO ad_replication_status (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, partner_port_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at), agent_id = VALUES(agent_id), source_site = VALUES(source_site), dest_site = VALUES(dest_site), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), status_code = VALUES(status_code), error_message = VALUES(error_message), partner_port_status = VALUES(partner_port_status)`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      listRecent: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC LIMIT ?`,
      listBySite: `SELECT source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC LIMIT ?`,
      // R151.3 — single-query both-direction partner count for /api/dcs/summary.
      // Replaces the old single-direction `partnersCount` (OUTBOUND only) —
      // DcCard.vue now shows BOTH inbound (⬇️) and outbound (⬆️) tiles, so
      // the SUM(CASE WHEN …) pattern lets us answer both from one query
      // without doubling the N+1 subquery that already runs once per DC.
      //
      // Direction mapping (matches R144 dashboard + R151.2 endpoint):
      //   inbound  = dest_dc = agent   → "other DCs replicated TO me"
      //   outbound = source_dc = agent → "I replicated to other DCs"
      //
      // Same synthetic-row exclusions as the inbound/outbound partner
      // helpers: __partner_ports__:% (the agent's own probe rows) and
      // __dc_summary__ / META (self-loops / heartbeat) are not real
      // partners and should never inflate the count.
      partnersCountBoth: `SELECT
          SUM(CASE WHEN dest_dc = ? THEN 1 ELSE 0 END)   AS inbound_count,
          SUM(CASE WHEN source_dc = ? THEN 1 ELSE 0 END) AS outbound_count
        FROM ad_replication_status t1
        WHERE t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2
                                  WHERE t2.source_dc = t1.source_dc
                                    AND t2.dest_dc = t1.dest_dc
                                    AND t2.naming_context = t1.naming_context)
          AND (t1.dest_dc = ? OR t1.source_dc = ?)
          AND t1.source_dc <> t1.dest_dc
          AND t1.naming_context NOT LIKE '__partner_ports__:%'
          AND t1.naming_context NOT IN ('__dc_summary__', 'META')
          AND t1.collected_at BETWEEN ? - INTERVAL ? MINUTE AND ? + INTERVAL ? MINUTE`,
      // R158.scanfix-H6 (2026-10-20) — MySQL mirror of mssql's
      // partnersCountBothAll. 一次查全站入/出站伙伴计数, 取代 dcs.js 里
      // 逐 DC 串行 N+1. 语义说明见 MSSQL 分支的完整注释 (时间基准从
      // "各 DC 自己的 collected_at" 改为 "全站最新 collected_at", 方向
      // 映射与合成行排除完全一致). 只差 INTERVAL vs DATEADD.
      partnersCountBothAll: `SELECT src AS dc, SUM(is_in) AS inbound_count, SUM(is_out) AS outbound_count FROM (
          SELECT t1.source_dc AS src, t1.dest_dc AS peer,
                 CAST(0 AS SIGNED) AS is_in,  CAST(1 AS SIGNED) AS is_out
            FROM ad_replication_status t1
           WHERE t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2
                                     WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc
                                       AND t2.naming_context = t1.naming_context)
             AND t1.source_dc <> t1.dest_dc
             AND t1.naming_context NOT LIKE '__partner_ports__:%'
             AND t1.naming_context NOT IN ('__dc_summary__', 'META')
             AND t1.collected_at >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
          UNION ALL
          SELECT t1.dest_dc AS src, t1.source_dc AS peer,
                 CAST(1 AS SIGNED) AS is_in,  CAST(0 AS SIGNED) AS is_out
            FROM ad_replication_status t1
           WHERE t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2
                                     WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc
                                       AND t2.naming_context = t1.naming_context)
             AND t1.source_dc <> t1.dest_dc
             AND t1.naming_context NOT LIKE '__partner_ports__:%'
             AND t1.naming_context NOT IN ('__dc_summary__', 'META')
             AND t1.collected_at >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
      ) u GROUP BY src`,
      // Returns two columns (inbound_count / outbound_count) using SUM(CASE WHEN)
      // so DcCard.vue can show "⬇️ 入站伙伴" + "⬆️ 出战伙伴" without doubling
      // the N+1 partnerCount subquery.
      //
      // Direction mapping (matches R144 dashboard + R151.2 endpoint):
      //   inbound  = dest_dc = agent   → "other DCs replicated TO me"
      //   outbound = source_dc = agent → "I replicated to other DCs"
      //
      // Same synthetic-row exclusions as the inbound/outbound partner
      // helpers: __partner_ports__:% (the agent's own probe rows) and
      // __dc_summary__ / META (self-loops / heartbeat) are not real
      // partners and should never inflate the count.
      //
      // The latest-per-pair subquery is reused verbatim from
      // replicationPartnersByAgent so the count reflects the LAST cycle
      // the agent reported, not historical noise.
      // R158.15-P1 cleanup (2026-10-01) -- partnersCountBoth was previously
      // defined twice in this object literal (L42 and L71) with identical
      // SQL. JS object literals silently overwrite on duplicate keys, so
      // this manifested as no runtime bug, but created a divergence hazard
      // (any future edit to one definition would silently skip the other)
      // and ~30 lines of dead comments. Removed the second occurrence; the
      // first definition above (L42-54) remains the single source of truth.
      // R125 — partner DC list for the calling agent, sourced from
      // ad_replication_status latest-per-(source_dc, dest_dc, naming_context).
      // Filters out synthetic `__partner_ports__:%` rows AND the
      // `__dc_summary__` / `META` self-loops so the agent's TCP probe
      // only iterates genuine replication partners. 30-minute window
      // keeps the list fresh but tolerant of a missed ad_dc_overview
      // cycle. Used by /api/agent/replication-partners (routes/agent.js).
      // The `?` placeholder is dialect-portable — MSSQL driver wrapper
      // rewrites to @p1 at execute() time.
      replicationPartnersByAgent: (agentId) => `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code FROM ad_replication_status t1 WHERE t1.source_dc = ? AND t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.dest_dc`,
      // R151.2 — inbound mirror. agent-side partner-port probe no longer
      // shells out to Get-ADReplicationPartnerMetadata (returns 0 rows on
      // 28/34 agents because the default -Scope Server only sees local
      // site links). The agent now POSTs its own agent_id, and the centre
      // returns the inbound peer DC list — derived from ad_replication_status
      // with dest_dc = agentId (the inbound direction: another DC
      // replicated to me). Same 30-minute freshness window as
      // replicationPartnersByAgent, same synthetic-row exclusions, so the
      // agent-side peer list stays 1:1 with what the dashboard's
      // partner-port-health view shows for the same agent.
      inboundPartnersByAgent: (agentId) => `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code FROM ad_replication_status t1 WHERE t1.dest_dc = ? AND t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.source_dc`,
      // R155.4 — outbound mirror of replicationPartnersByAgent. Source_dc
      // = agent anchor: returns the peer DCs that THIS agent is supposed
      // to TCP-probe OUT to (operator "出战主动探测"). Same 30-min
      // freshness window + synthetic-row exclusions as the inbound
      // mirror so probe lists stay 1:1 with what the dashboard shows
      // for the same agent.  Used by /api/agent/outbound-partners
      // (routes/agent.js R155.4 mirror of R151.2 inbound endpoint).
      // Echo-loop guard: __partner_ports__:% exclusion prevents the
      // outbound probe from reading its own previous-cycle probe rows
      // as new peers (recursive fan-out).
      outboundPartnersByAgent: (agentId) => `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code FROM ad_replication_status t1 WHERE t1.source_dc = ? AND t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.dest_dc`,
      // R158.15 (2026-10-01) -- inbound partner list for
      // ad_replication_status_probe. Reads ad_partner_inbound
      // (R158.14 / R158.11.5 30-day centre warehouse, written by
      // ad_partner_inbound_discover 1.1.5). Semantics: who pushes
      // replication TO this DC (source_dc -> dest_dc). R155.6
      // ad_dc_inbound_partners never shipped as a physical table
      // (R158.4 retired, R157.4 partner-discover renamed inbound
      // -> ad_partner_inbound), so we read the live table.
      // 24h freshness window covers one full refresh cycle + margin.
      // Returns one row per (source_dc, dest_dc); caller dedupes by
      // peer_dc (= source_dc).
      inboundPartnersWarehouseByAgent: (agentId) => `SELECT source_dc AS peer_dc FROM ad_partner_inbound WHERE dest_dc = ? AND collected_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY source_dc ORDER BY source_dc`,
      // R158.15 -- ad_replication_status_probe post-hook INSERT.
      // 12-param bind. Append-only (no ON DUPLICATE KEY UPDATE):
      // every 15-min probe cycle writes one row per (peer, NC).
      // Caller binds: [collectedAt, agentId, sourceDc, destDc,
      //                namingContext, attemptAt, result, statusCode,
      //                durationMs, objectsTransferred, errorCode,
      //                errorMessage].
      insertProbeHistory: `INSERT INTO ad_replication_probe_history (collected_at, agent_id, source_dc, dest_dc, naming_context, attempt_at, result, status_code, duration_ms, objects_transferred, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // R158.X.116.d (2026-10-22) — 删 upsertDcProbeOutbound (R155.4 引入)。
      //   ad_dc_probe_outbound 表已 DROP (migration 038), BUILTIN 包条目已移除
      //   (builtin-packages.js:356), runner 门控 (runner.js:1066) 因
      //   package_scripts 里 0 行而永不为真 → 本 helper 从未被执行到。
      //   留着 = 一段指向已删表的 SQL, 手工注册同名包名就会撞 "表不存在"。
      //   探针包脚本已归档 .backups/packages-ad_dc_probe_outbound-20261022/。
      // R156 — ad_dcs membership lookup for partner-discover write-time
      // validation. Returns the set of all known DC names so partner-
      // discover.js can pre-flight peerDc against it without an EXISTS
      // subquery per row. Companion module-level cache in
      // services/partner-discover.js keeps this Set fresh via 5-min
      // TTL (mirrors dc-partners-refresh.js cadence). No WHERE clause —
      // ad_dcs is expected to stay small (<100 rows) and the operator
      // already cleaned out decommissioned DCs as part of R156.
      //
      // R158.X.115 (2026-10-20) — 上面的 "No WHERE clause" 是**物理删除**时代
      //   的假设。退役标记出现后行永远留着, 若不过滤: 退役 DC 的残留 agent
      //   上报的 peers 会把退役 DC 当成合法 partner 写进 ad_partner_inbound /
      //   outbound, 拓扑上又冒出一条"幽灵边"。
      //   这是**单点修复**: partner-discover / replication-status-probe /
      //   dc-partners-refresh 三个 consumer 共用 getKnownDcSet() 的 5min
      //   cache, 改这一句全部生效 (跟 R158.X.99.34.b UNION ALL 单点修复 1:1
      //   平行)。ad_dcs <100 行, 加两个 IS NULL 判断的开销可忽略。
      //   退役 DC 的历史 partner 数据保留在表里, 只是不再算"当前有效伙伴"。
      knownDcNames: `SELECT dc_name FROM ad_dcs WHERE decommissioned_at IS NULL AND monitoring_paused_at IS NULL`,
      // R156 — UPSERT for ad_partner_inbound physical table (inbound
      // view: source_dc = upstream peer, dest_dc = self). 5-param
      // shape — no status_code / last_success_time / partner_port_status
      // because discover ≠ probe (no port probing, no latency metrics).
      // Caller binds: [collectedAt, agentId, sourceDc, destDc, discoveredAt].
      upsertPartnerInbound: `INSERT INTO ad_partner_inbound (collected_at, agent_id, source_dc, dest_dc, discovered_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at), agent_id = VALUES(agent_id), discovered_at = VALUES(discovered_at)`,
      // R158.10 (2026-10-01) — upsertPartnerOutbound 删除 (operator
      //   decision: outbound partner 不再需要)。ad_partner_outbound
      //   表保留(TRUNCATE 但不 DROP)以备未来回滚,但不再 UPSERT。
      // R156 — pending discover triggers. The cron-scheduler writes
      // package_runs rows with status='pending_trigger' + a JSON
      // payload column (see rpc trigger). Agent poll reads this and
      // runs collect.ps1 on the next sync. After the agent reports
      // back, status flips to 'completed' / 'failed' normally.
      pendingPartnerDiscovers: `SELECT name, started_at FROM package_runs WHERE status = 'pending_trigger' AND started_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY ORDER BY started_at`,
      // R158.64 (2026-10-10) — site-to-site 复制矩阵 for daily/weekly report
      // (reports.js fetchReplicationSection 4.1 bySite 矩阵). GROUP BY
      // (source_site, dest_site) + COUNT/SUM 健康失败. 排除命名上下文以避免
      // 站点矩阵被 partner port 探测 + __dc_summary__ 噪声污染 (跟
      // dashboard.allReplicationLinks sql.js:2751 模式一致):
      //   - '__partner_ports__:%'  — partner port 探针
      //   - '__dc_summary__'        — ad_dc_overview-like 复合 NC
      //   - 'META'                  — forest metadata
      // report 期望站点间 link 数, 不是单条 NC. function-form: periodStart
      // 由 caller 传 (reports.js 用 periodStart = now - 24h, 跟 summarySql
      // 同步), 不是 NOW() 派生. SUM(CASE ...) 跨 dialect 同形.
      //
      // R158.X.116.p (2026-10-23) — 站点名改从 ad_dcs→ad_sites catalog JOIN,
      // 不再读 ad_replication_status.source_site / dest_site 两列。理由:
      // 那两列是 agent 上报的**自由文本提示**, 存的是旧命名体系
      // (KDL-GuiYang / KDL-FL-HubSite), 跟 ad_sites 现行 site_name
      // (康德乐贵阳 / 康德乐枫林) 对不上 —— 2026-08-26 round-21 已在
      // topologyNodes 上确立过同一条原则 (sql.js:1133-1134
      // "catalog is source of truth — agent-reported source_site is a free-text
      // hint and does not match catalog site_name"), 本次是把它补齐到
      // 剩下的消费点。实测 JOIN 覆盖率 100% (178/178 行 dc 都能查到站点,
      // dc_not_found=0), 改 JOIN 0 丢行。
      // WHERE 侧用 IS NOT NULL 收窄 (而不是 INNER JOIN) 保持"查不到站点
      // 的行不进矩阵"的原语义 —— 原版也是 source_site IS NOT NULL 过滤。
      bySiteMatrix: ({ periodStart }) => {
        if (!(periodStart instanceof Date) && typeof periodStart !== 'string') {
          throw new Error('replication.bySiteMatrix: periodStart must be Date or ISO string');
        }
        const sql =
          `SELECT ss.site_name AS source_site, ds.site_name AS dest_site,
                  COUNT(*) AS link_count,
                  SUM(CASE WHEN t.status_code = 0 THEN 1 ELSE 0 END) AS healthy_count,
                  SUM(CASE WHEN t.status_code <> 0 THEN 1 ELSE 0 END) AS failing_count,
                  MAX(t.collected_at) AS last_probe_at
             FROM ad_replication_status t
             LEFT JOIN ad_dcs sd ON sd.dc_name = t.source_dc
             LEFT JOIN ad_sites ss ON ss.site_id = sd.site_id
             LEFT JOIN ad_dcs dd ON dd.dc_name = t.dest_dc
             LEFT JOIN ad_sites ds ON ds.site_id = dd.site_id
            WHERE t.collected_at >= ?
              AND ss.site_name IS NOT NULL
              AND ds.site_name IS NOT NULL
              AND t.naming_context NOT LIKE '\\_\\_%' ESCAPE '\\'
              AND t.naming_context <> 'META'
            GROUP BY ss.site_name, ds.site_name
            ORDER BY ss.site_name ASC, ds.site_name ASC`;
        return { sql, params: [periodStart] };
      },
      // R158.X.99.29.b (2026-10-19) — ad_replication_active_errors 新表.
      // 操作员 directive: "如果有问题则写入这个表, 如果恢复或者复制正常则
      // 会将当前行删除". 1:1 平行 R158.78/R158.86/R158.100 范式.
      //
      // 3 helper 必 mysql + mssql 1:1 平行 (R158.X.99.27 round 2 锁):
      //   - upsertActiveError: 失败时 INSERT/UPDATE (status=1/2 报上来)
      //   - removeActiveError: 成功时 DELETE (status=0 报上来, auto-remove)
      //   - listActiveErrors: 端点 SELECT (1:1 平行老 replicationErrors 3 窗口限)
      //
      // upsertActiveError 9 列 bind: sourceDc, destDc, namingContext, statusCode,
      // lastAttemptTime, firstSeenAt (init = lastAttemptTime), lastReportedAt,
      // reportedCount (init = 1), lastErrorMessage. UNIQUE (source_dc,
      // dest_dc, naming_context) → ON DUPLICATE KEY UPDATE.
      upsertActiveError: `INSERT INTO ad_replication_active_errors
          (source_dc, dest_dc, naming_context, status_code, last_attempt_time,
           first_seen_at, last_reported_at, reported_count, last_error_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
          ON DUPLICATE KEY UPDATE
            status_code = VALUES(status_code),
            last_attempt_time = VALUES(last_attempt_time),
            last_reported_at = VALUES(last_reported_at),
            reported_count = reported_count + 1,
            last_error_message = VALUES(last_error_message)`,
      // removeActiveError 3 列 bind: sourceDc, destDc, namingContext.
      // 成功 status=0 时调, 整条 pair 真从新表消失 (操作员 "auto-remove" 锁).
      removeActiveError: `DELETE FROM ad_replication_active_errors WHERE source_dc = ? AND dest_dc = ? AND naming_context = ?`,
      // listActiveErrors 函数式: hours (24h=24 / 7d=168) 或 null = 全部历史.
      // R158.X.116.p (2026-10-23) — 从 string 改函数式以支持 window=all:
      // 「不带时间下界」必须是 SQL 语法层缺席 (整个 AND 子句不出现), 不能
      // 拿一个极大的 hours 糊弄 —— 那样 30 年后的数据仍会被截断, 且
      // MySQL 的 INTERVAL ? HOUR 在 null 时行为不可控。
      // LIMIT 200 跟老 replicationErrors 端点 1:1 平行, 0 破 UI 200 行 hard cap.
      // duration_ms 用 TIMESTAMPDIFF 算 first_seen_at → last_attempt_time
      // (新表 0 有 last_success_time, 复用 first_seen_at 兜底 R158.X.99.29
      // 老 端点 duration_ms 同形 0 改前端).
      listActiveErrors: (hours) => `SELECT source_dc, dest_dc, naming_context, status_code,
                                last_attempt_time, first_seen_at, last_reported_at,
                                reported_count, last_error_message,
                                CASE WHEN first_seen_at IS NULL OR last_attempt_time IS NULL
                                     THEN NULL
                                     ELSE TIMESTAMPDIFF(MICROSECOND, first_seen_at, last_attempt_time) DIV 1000
                                END AS duration_ms
                           FROM ad_replication_active_errors
                          WHERE status_code > 0
                            ${hours == null ? '' : 'AND last_attempt_time >= UTC_TIMESTAMP() - INTERVAL ? HOUR'}
                          ORDER BY last_attempt_time DESC LIMIT 200`
    },
    dcOverview: {
      upsert: ({ collectedAt, agentId, dcName, siteId, usersCount, computersCount, serversCount, groupsCount, gposCount, partnerPortStatus }) => {
        // R158.52 — COALESCE(?, 0) on every numeric bind. Legacy agents
        // that hadn't synced users/groups/gpos/computers/servers would bind
        // null into these columns, which silently coerced to NULL in the
        // INSERT — then the dashboard tile showed 0 (since NULL coerces
        // to 0 in JS reads), but a future NOT NULL constraint on the
        // schema would break the INSERT. Defending here keeps the row
        // shape consistent regardless of the agent's collection state.
        const sql = `INSERT INTO ad_dc_overview
          (collected_at, agent_id, dc_name, site_id, users_count, computers_count, servers_count, groups_count, gpos_count, partner_port_status)
          VALUES (?, ?, ?, ?, COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), ?)
          ON DUPLICATE KEY UPDATE
            collected_at = VALUES(collected_at),
            agent_id = VALUES(agent_id),
            site_id = VALUES(site_id),
            users_count = COALESCE(VALUES(users_count), users_count),
            computers_count = COALESCE(VALUES(computers_count), computers_count),
            servers_count = COALESCE(VALUES(servers_count), servers_count),
            groups_count = COALESCE(VALUES(groups_count), groups_count),
            gpos_count = COALESCE(VALUES(gpos_count), gpos_count),
            partner_port_status = VALUES(partner_port_status)`;
        return {
          sql,
          params: [
            collectedAt, agentId, dcName, siteId,
            usersCount, computersCount, serversCount, groupsCount, gposCount,
            partnerPortStatus == null ? null : JSON.stringify(partnerPortStatus)
          ]
        };
      },
      latestPerDc: ({ sinceHours = 24 } = {}) => {
        // Latest row per dc_name within window; INNER JOIN against itself keyed
        // on MAX(collected_at). Mirrors latestSummaryPerDc shape that previously
        // served from ad_replication_status.__dc_summary__ rows.
        const sql = `SELECT d.dc_name, d.collected_at, d.site_id,
                            d.users_count, d.computers_count, d.servers_count, d.groups_count, d.gpos_count, d.partner_port_status,
                            s.site_name
                     FROM ad_dc_overview d
                     LEFT JOIN ad_sites s ON s.site_id = d.site_id
                     INNER JOIN (
                       SELECT dc_name, MAX(collected_at) AS max_collected
                       FROM ad_dc_overview
                       WHERE collected_at >= (NOW() - INTERVAL ? HOUR)
                       GROUP BY dc_name
                     ) m ON m.dc_name = d.dc_name AND m.max_collected = d.collected_at
                     ORDER BY d.dc_name`;
        return { sql, params: [sinceHours] };
      },
      // R158.69.x (2026-10-10) — bySite 矩阵走 fleet 心跳真源. 真因:
      //   老 latestPerDc SELECT 列表 (R158.44.7 ship) 没选 last_heartbeat_at,
      //   services/reports.js:279 r.last_heartbeat_at 永远 undefined → reachable
      //   永远 false. 同 latestPerDc 也没选 is_pdc/is_hub → PDC badge 永远 0.
      //   新 helper 接 ad_agent_heartbeat (last_heartbeat_at 真源, 30s cadence,
      //   34/34 OK) + ad_dcs (is_pdc 真源) + ad_sites (is_hub/site_name 真源),
      //   counts 仍走 ad_dc_overview (1.0.3 collect 链路写).
      //   跟老 latestPerDc 100% 兼容 row shape, callers reduce 算法不变.
      // params: { sinceHours = 24, staleMinutes = 5 }
      //
      // R158.X.116 (2026-10-22) — 加 staleMinutes 心跳新鲜度判定.
      //   真因: 老版本只 SELECT last_heartbeat_at, 让调用方 (services/reports.js)
      //   做 `!= null` 判断 —— 而 ad_agent_heartbeat 是 UPSERT 覆盖式快照表
      //   (PK=agent_id, 心跳写入走 ON DUPLICATE KEY UPDATE / MERGE), agent 停机后
      //   行不删除、last_heartbeat_at 保留最后一次值、永不置 NULL.
      //   于是 `!= null` 恒 true, 日报/周报把离线 DC 全显示成「● 正常」.
      //   操作员实例: KDLWHOFADSRV1 离线约 20h, 日报第 4 段仍显示在线,
      //   而第 7 段 (读 system_alerts) 正确列出它「● 离线中」—— 同报告自相矛盾.
      //   修法: SQL 层算 is_online, 阈值 = 最近 staleMinutes 分钟内有心跳.
      //   阈值 5min 跟随 web/src/views/AgentsView.vue:44 (ONLINE_WINDOW_MS),
      //   操作员 2026-10-22 directive: 日报/周报 agent 状态跟随 /agents 页面.
      //   is_online 三值: 1=在线 / 0=离线(有历史心跳但不新鲜) / NULL=从未心跳.
      //   区分 0 与 NULL 才能区分「曾经在线现在掉了」和「从来没上线过」.
      latestPerDcWithHeartbeat: ({ sinceHours = 24, staleMinutes = 5 } = {}) => {
        const sql = `SELECT d.dc_name, d.collected_at, d.site_id,
                            d.users_count, d.computers_count, d.servers_count,
                            d.groups_count, d.gpos_count, d.partner_port_status,
                            s.site_name, s.is_hub,
                            dc.is_pdc,
                            h.last_heartbeat_at AS last_heartbeat_at,
                            CASE
                              WHEN h.last_heartbeat_at IS NULL THEN NULL
                              WHEN h.last_heartbeat_at
                                   >= (UTC_TIMESTAMP(3) - INTERVAL ? MINUTE) THEN 1
                              ELSE 0
                            END AS is_online
                       FROM ad_dc_overview d
                       LEFT JOIN ad_sites s ON s.site_id = d.site_id
                       LEFT JOIN ad_dcs dc ON dc.dc_name = d.dc_name
                       LEFT JOIN ad_agent_heartbeat h ON h.agent_id = d.dc_name
                                                  AND h.agent_id <> '__healthcheck__'
                       INNER JOIN (
                         SELECT dc_name, MAX(collected_at) AS max_collected
                         FROM ad_dc_overview
                         WHERE collected_at >= (UTC_TIMESTAMP(3) - INTERVAL ? HOUR)
                         GROUP BY dc_name
                       ) m ON m.dc_name = d.dc_name AND m.max_collected = d.collected_at
                       ORDER BY d.dc_name`;
        // params 顺序: SQL 里 staleMinutes 的 ? 在子查询 HOUR 的 ? 之前
        return { sql, params: [staleMinutes, sinceHours] };
      },
      // R158.69.x — 6 KPI aggregate (替代 services/reports.js:230-251 inline sumSql).
      //   走同 LEFT JOIN 形, CASE WHEN 算 total/reachable/unreachable/pdc/hub/stale.
      //   老 inline sumSql 直接读 ad_dc_overview.last_heartbeat_at/is_pdc/is_hub, 但
      //   这 3 列 ad_dc_overview 永远 NULL/0 (collect 链路不写), reachable 永远 false.
      //   新 helper 接 ad_agent_heartbeat 真源, reachable 实时准.
      //
      // R158.X.116.b (2026-10-22) — 删掉 `COALESCE(h.last_heartbeat_at, d.last_heartbeat_at)`
      //   里的 d.* fallback (本 helper + latestPerDcWithHeartbeat, 两方言共 16 处).
      //   真因: 上面的注释已论证 ad_dc_overview.last_heartbeat_at "永远 NULL" ——
      //   既然是死列, 拿它当 fallback 没有任何语义收益。**而 MySQL baseline
      //   从未建过这一列**, 于是该 COALESCE 在 MySQL 部署上直接
      //   ER_BAD_FIELD_ERROR: Unknown column 'd.last_heartbeat_at',
      //   炸掉 /api/dcs/summary 与日报/周报 KPI 聚合。
      //   语义不变: LEFT JOIN 未命中时 h.last_heartbeat_at 本身就是 NULL,
      //   与原先 COALESCE(null, null) 同解; 命中时恒等于 h。
      // params: { sinceMs = 0, staleMinutes = 5, windowHours = 0 }
      //
      // R158.X.116 (2026-10-22) — reachable/unreachable 加心跳新鲜度判定.
      //   真因: 老 reachable 是 `IS NOT NULL`, 在 UPSERT 覆盖式心跳表上恒等于
      //   total_dcs、unreachable 恒 0 → 日报 KPI 显示「在线 N / 离线 0」,
      //   即使 N 台全离线. 修法跟 latestPerDcWithHeartbeat 同一阈值.
      //
      // R158.X.116 顺带修 windowHours: 老版本内层子查询无 WHERE, 取全历史
      //   MAX(collected_at), 与 latestPerDcWithHeartbeat 的窗口不一致 →
      //   「KPI totalDcs ≠ 明细行数之和」. 现 windowHours 与明细行对齐.
      //   sinceMs/stale_reachable 保留 (reports.js 仍在用), 语义不变.
      healthSummaryWithHeartbeat: ({ sinceMs = 0, staleMinutes = 5, windowHours = 0 } = {}) => {
        // bind 顺序: staleMinutes → staleMinutes → sinceMs → windowHours
        const sql = `SELECT COUNT(*) AS total_dcs,
                            SUM(CASE WHEN h.last_heartbeat_at IS NOT NULL
                                      AND h.last_heartbeat_at
                                          >= (UTC_TIMESTAMP(3) - INTERVAL ? MINUTE)
                                     THEN 1 ELSE 0 END) AS reachable,
                            SUM(CASE WHEN h.last_heartbeat_at IS NULL
                                      OR h.last_heartbeat_at
                                          < (UTC_TIMESTAMP(3) - INTERVAL ? MINUTE)
                                     THEN 1 ELSE 0 END) AS unreachable,
                            SUM(CASE WHEN COALESCE(dc.is_pdc, 0) = 1 THEN 1 ELSE 0 END) AS pdc_count,
                            SUM(CASE WHEN COALESCE(s.is_hub, 0) = 1 THEN 1 ELSE 0 END) AS hub_count,
                            SUM(CASE WHEN h.last_heartbeat_at IS NOT NULL
                                      AND h.last_heartbeat_at < ? THEN 1 ELSE 0 END) AS stale_reachable
                       FROM ad_dc_overview d
                       LEFT JOIN ad_sites s ON s.site_id = d.site_id
                       LEFT JOIN ad_dcs dc ON dc.dc_name = d.dc_name
                       LEFT JOIN ad_agent_heartbeat h ON h.agent_id = d.dc_name
                                                  AND h.agent_id <> '__healthcheck__'
                       INNER JOIN (
                         SELECT dc_name, MAX(collected_at) AS max_collected
                         FROM ad_dc_overview
                         WHERE collected_at >= (UTC_TIMESTAMP(3) - INTERVAL ? HOUR)
                         GROUP BY dc_name
                       ) m ON m.dc_name = d.dc_name AND m.max_collected = d.collected_at`;
        // R161.5 (2026-10-26) — 第 3 个 bind 落 ad_agent_heartbeat.last_heartbeat_at
        //   (DATETIME NULL, MySQL 基线) ⇒ 必须 MySQL naive 格式。mssql 段保持
        //   ISO (datetime2 接受 ISO ⇒ MSSQL 零行为变化)。
        return { sql, params: [staleMinutes, staleMinutes, toMysqlDatetime(new Date(sinceMs)), windowHours] };
      }
    },
    // R158.47 (2026-10-06) — operator directive "构建一个包, 这个包就是
    //   提取 domain admins enterprise admins 管理员成员". 中心端 MERGE
    //   去重: 每台 DC 都跑 collect.ps1, MERGE ON (domain_dn, group_name,
    //   member_sam) 自动 collapse, 不需 agent 端 PS 自选 PDC. 这种 "多
    //   DC 报告 + 中心 dedup" 是 R110.A 公共表 pattern 的扩展 (公共表
    //   ad_admin_members, manifest 不带 database block).
    adminMembers: {
      upsert: ({ domainDn, groupName, memberSam, memberDn, memberEnabled, collectedAt, dcName, runId, displayName }) => {
        // R158.69.9 (2026-10-11) — dc_name/run_id 不在 ON DUPLICATE KEY UPDATE
        //   SET 列表. 真因: 多 DC 都报同一 admin member 时, 后面 DC 写入会
        //   覆盖 dc_name=VALUES(dc_name), run_id=VALUES(run_id), 丢失"哪个
        //   DC 首次发现" 的 audit 信息. dashboard summary 用 MAX(collected_at)
        //   GROUP BY group_name 拿 member_count 不查 dc_name/run_id, 所以数字
        //   仍正确. 字段只在 INSERT 第一次设 (= 首次发现那个 DC + run).
        // R158.69.10 (2026-10-11) — display_name 列加入. 跟 dc_name/run_id
        //   不同: display_name 算 enrichable 列 (中心 enrich 后填真值), 二次
        //   upsert 应保留最新 enrich (走 ON DUPLICATE KEY UPDATE 覆盖).
        const sql = `INSERT INTO ad_admin_members
          (domain_dn, group_name, member_sam, member_dn, member_enabled, collected_at, dc_name, run_id, display_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            domain_dn = VALUES(domain_dn),
            member_dn = VALUES(member_dn),
            member_enabled = VALUES(member_enabled),
            collected_at = VALUES(collected_at),
            display_name = VALUES(display_name)`;
        return {
          sql,
          params: [domainDn, groupName, memberSam, memberDn, memberEnabled, collectedAt, dcName, runId, displayName ?? null]
        };
      },
      // Summary for overview panel: per-group member count for the LATEST
      // collected_at per (domain_dn, group_name). Multiple DCs may report
      // at different timestamps; the inner MAX subquery picks the freshest
      // window per (domain, group). Caller maps "Domain Admins" / "Enterprise
      // Admins" rows to the 2 headline numbers + computes a distinct-member
      // sam count across both groups.
      summary: () => {
        const sql = `SELECT
           group_name,
           COUNT(*) AS member_count
         FROM ad_admin_members m
         WHERE m.collected_at = (
           SELECT MAX(m2.collected_at) FROM ad_admin_members m2
           WHERE m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name
         )
         GROUP BY group_name`;
        return { sql, params: [] };
      },
      // R158.47.2 (2026-10-06) — L4 fix (R110.A 一致性 hygiene): 把
      // routes/dashboard.js 内联 distinctSql 推进 sql.js 块, 跟 summary()
      // 并列. 跨 group_name 的去重 member_sam 数 (totalMembers 卡片用),
      // 同一句相关子查询只换 group_name IN list + DISTINCT.
      // params: groupNames (N 个 placeholder, N 由 caller 决定).
      distinctSummary: ({ groupNames }) => {
        if (!Array.isArray(groupNames) || groupNames.length === 0) {
          throw new Error('adminMembers.distinctSummary: groupNames required');
        }
        const placeholders = groupNames.map(() => '?').join(',');
        const sql = `SELECT COUNT(DISTINCT m.member_sam) AS distinct_count
           FROM ad_admin_members m
           WHERE m.group_name IN (${placeholders})
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_admin_members m2
               WHERE m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name
             )`;
        return { sql, params: groupNames };
      },
      // R158.69.10 (2026-10-11) — drill-down per-group member list for Dashboard
      //   下钻表格. 直接读 ad_admin_members 表 (已 enrich), 不再 LEFT JOIN
      //   ad_users_snapshot. 沿用 summary() 同 MAX(collected_at) 窗口, 保证
      //   count 一致.
      listByGroup: ({ groupName }) => {
        const sql = `SELECT
             member_sam AS sam,
             COALESCE(display_name, '') AS display_name,
             member_dn AS distinguished_name,
             group_name,
             dc_name,
             collected_at
           FROM ad_admin_members m
           WHERE m.group_name = ?
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_admin_members m2
               WHERE m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name
             )
           ORDER BY m.member_sam`;
        return { sql, params: [groupName] };
      },
      // R158.69.10 — enrich lookup. 仅 sam 限定 (跨域 sam 多行取 MIN 字面值
      //   兜底, 跟 backfill 同语义).
      lookupDisplayName: ({ sam }) => {
        const sql = `SELECT display_name FROM ad_users_snapshot
           WHERE sam = ? AND display_name IS NOT NULL
           ORDER BY display_name`;
        return { sql, params: [sam] };
      }
    },
    // R158.100 (2026-10-13) — member_admin_groups 公共表. Mirror of
    //   adminMembers 1:1 but with hostname/group_name/member_sid PK instead
    //   of domain_dn/group_name/member_sam. 0 FK 强制 (跟 R158.78 ad_member_eventlog
    //   1:1 平行). Public table (R110.A pattern), manifest omits `database` block,
    //   runner.js post-hook 直接 MERGE. 1 wire payload per run → N row (per member
    //   × per group).
    memberAdminGroups: {
      upsert: ({ hostname, groupName, memberSid, memberName, memberClass, principalSource, isEnabled, displayName, collectedAt, runId }) => {
        // R158.69.9 (2026-10-11) — hostname/run_id 不在 ON DUPLICATE KEY UPDATE
        //   SET 列表. 真因: 跨 re-run 时, 后面 run 写入会覆盖 hostname + run_id,
        //   丢失"哪个 run 首次发现"的 audit 信息. dashboard listByHostname 用
        //   MAX(collected_at) 拿最新, 不查 run_id. 字段只在 INSERT 第一次设.
        // R158.69.10 (2026-10-11) — display_name 加入 MERGE UPDATE SET (跟 run_id
        //   不同: display_name 算 enrichable 列, 应保留最新 enrich 值).
        // R158.100 — member_server 端 0 走 ad_users_snapshot enrich, 0 跨域,
        //   collect.ps1 自身 Get-LocalUser.FullName enrich 已够. 中心端不再
        //   enrich.
        const sql = `INSERT INTO ad_member_admin_groups
          (hostname, group_name, member_sid, member_name, member_class, principal_source, is_enabled, display_name, collected_at, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            member_name = VALUES(member_name),
            member_class = VALUES(member_class),
            principal_source = VALUES(principal_source),
            is_enabled = VALUES(is_enabled),
            display_name = VALUES(display_name),
            collected_at = VALUES(collected_at)`;
        return {
          sql,
          params: [hostname, groupName, memberSid, memberName ?? null, memberClass ?? null, principalSource ?? null, isEnabled ?? null, displayName ?? null, collectedAt, runId ?? null]
        };
      },
      // Summary for /memberServer/admins: per-hostname per-group member count for
      // the LATEST collected_at window. Multiple re-runs may report at different
      // timestamps; the inner MAX subquery picks the freshest window per
      // (hostname, group_name). Operator tile uses this.
      summary: () => {
        const sql = `SELECT
           hostname,
           group_name,
           COUNT(*) AS member_count
         FROM ad_member_admin_groups m
         WHERE m.collected_at = (
           SELECT MAX(m2.collected_at) FROM ad_member_admin_groups m2
           WHERE m2.hostname = m.hostname AND m2.group_name = m.group_name
         )
         GROUP BY hostname, group_name`;
        return { sql, params: [] };
      },
      // R158.100 — list all members per hostname for sub-tab main table. Returns
      //   rows in the LATEST collected_at window per (hostname, group_name).
      //   Case-insensitive hostname filter 由 service 层 normalize (R158.99.1 lesson).
      listByHostname: ({ hostname }) => {
        const sql = `SELECT
             hostname,
             group_name,
             member_sid,
             member_name,
             member_class,
             principal_source,
             is_enabled,
             display_name,
             collected_at
           FROM ad_member_admin_groups m
           WHERE m.hostname = ?
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_member_admin_groups m2
               WHERE m2.hostname = m.hostname AND m2.group_name = m.group_name
             )
           ORDER BY m.group_name, m.member_name`;
        return { sql, params: [hostname] };
      },
      // R158.100 — drill-down per (hostname, group_name) member list. Frontend
      //   sub-tab 默认展开用.
      listByGroup: ({ hostname, groupName }) => {
        const sql = `SELECT
             member_sid,
             COALESCE(display_name, '') AS display_name,
             member_name,
             member_class,
             principal_source,
             is_enabled,
             collected_at
           FROM ad_member_admin_groups m
           WHERE m.hostname = ?
             AND m.group_name = ?
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_member_admin_groups m2
               WHERE m2.hostname = m.hostname AND m2.group_name = m.group_name
             )
           ORDER BY m.member_name`;
        return { sql, params: [hostname, groupName] };
      }
    },
    // R158.72 (2026-10-11) — ad_account_change 公共表 (R110.A pattern,
    //   跟 adminMembers 同 model: manifest omits `database` block, 中心端
    //   runner.js post-hook 直接 MERGE. 5 action (created/modified/deleted/
    //   enabled/disabled) × change_date, PK (sam, action, change_date) 自
    //   动 dedup 跨 DC + 跨 re-run). 全 MySQL placeholder `?` 风格, 服务
    //   层 wrap 到 MSSQL 时 driver rewrite @p1,@p2. retention SQL 走
    //   dialect-keyed `deleteOlderThan` (跟 reportRun.deleteOlderThan 同
    //   风格).
    adAccountChange: {
      upsert: ({ sam, displayName, action, createdAt, modifiedAt, changeDate, domainDn, dcName, collectedAt, operatorUser }) => {
        // R158.72.x.4 (2026-10-16) — +1 字段 operator_user (事件 Properties[4]
        //   SubjectUserName, NVARCHAR(128) NULL). MERGE 公共表 dedup key 仍
        //   (sam, action, change_date), operator_user 走 ON DUPLICATE KEY UPDATE
        //   1:1 同步 (跟 modified_at/display_name 1:1 平行).
        const sql = `INSERT INTO ad_account_change
          (sam, display_name, action, created_at, modified_at, change_date, domain_dn, dc_name, collected_at, operator_user)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            display_name = VALUES(display_name),
            modified_at = VALUES(modified_at),
            domain_dn = VALUES(domain_dn),
            collected_at = VALUES(collected_at),
            operator_user = VALUES(operator_user)`;
        return { sql, params: [sam, displayName, action, createdAt, modifiedAt, changeDate, domainDn, dcName, collectedAt, operatorUser] };
      },
      // 30d default trend for dashboard 折线图. GROUP BY (action, change_date)
      // flat 行, caller pivot 成 5 series.
      // R158.111 (2026-10-16) — 加 actions: string[] (5 个 schema 真值
      //   created/modified/deleted/enabled/disabled 白名单 filter, IN-clause).
      //   actions=null 或空数组 → 0 改老行为 (R158.72 caller).
      trendByDay: ({ days, actions = null } = {}) => {
        const VALID_ACTIONS = ['created','modified','deleted','enabled','disabled'];
        const safeActions = Array.isArray(actions) && actions.length > 0
          ? actions.filter((a) => VALID_ACTIONS.includes(a))
          : null;
        const clauses = ['change_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'];
        const params = [days];
        if (safeActions && safeActions.length > 0) {
          clauses.push(`action IN (${safeActions.map(() => '?').join(',')})`);
          params.push(...safeActions);
        }
        const sql = `SELECT action, change_date AS bucket_day, COUNT(*) AS event_count
                 FROM ad_account_change
                 WHERE ${clauses.join(' AND ')}
                 GROUP BY action, change_date
                 ORDER BY change_date ASC, action ASC`;
        return { sql, params };
      },
      // R158.111.a (2026-10-16) — 账户变更 raw event list, 流水不过滤.
      //   跟 lockout.listAll 范式 1:1 平行. sinceHours=NULL = 物理全量
      //   (注意: ad_account_change 用 change_date DATE 列, 不用时间戳,
      //   所以 sinceHours 转 days: sinceHours=168 → days=7, sinceHours=720
      //   → days=30, sinceHours=NULL → days=NULL 物理全量). 0 过滤 (用户
      //   directive "不过滤", 0 action 白名单). ORDER BY change_date DESC,
      //   modified_at DESC, created_at DESC (新→旧). LIMIT/OFFSET 分页.
      //   ad_account_change 字段: sam / display_name / action / change_date /
      //   created_at / modified_at / dc_name / operator_user / dn (8 列, 跟
      //   R158.72.x.4 ship 1:1 平行).
      listAll: ({ sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}) => {
        if (limit < 1 || limit > 500) {
          throw new Error(`adAccountChange.listAll: limit must be in [1,500], got ${limit}`);
        }
        if (offset < 0) {
          throw new Error(`adAccountChange.listAll: offset must be >= 0, got ${offset}`);
        }
        if (sinceHours !== null && (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 720)) {
          // ad_account_change 30d retention, sinceHours cap 720h (30d)
          throw new Error(`adAccountChange.listAll: sinceHours must be null or int in [1,720], got ${sinceHours}`);
        }
        const clauses = [];
        const params = [];
        if (sinceHours !== null) {
          const days = Math.ceil(sinceHours / 24);
          clauses.push('change_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)');
          params.push(days);
        }
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push('(sam LIKE ? OR COALESCE(display_name,\'\') LIKE ?)');
          params.push(search + '%', search + '%');
        }
        params.push(limit, offset);
        const sql =
          `SELECT sam,
                  COALESCE(display_name, '') AS display_name,
                  action,
                  change_date,
                  created_at,
                  modified_at,
                  dc_name,
                  COALESCE(operator_user, '') AS operator_user
             FROM ad_account_change
            ${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY change_date DESC, COALESCE(modified_at, created_at) DESC
            LIMIT ? OFFSET ?`;
        return { sql, params };
      },
      // 当日某 action top-N (日报 / 周报 / AccountChangeDetailView sub-tab).
      // R158.X (2026-10-15) — limit 入参 (默认 50), 不动 call site 已有
      // 传 action 单参的形态 (传过来 = 50, behavior 跟 R158.72 ship 一致).
      dailyTopByAction: ({ action, limit = 50 }) => {
        // R158.17.5 (2026-10-01) precedent — LIMIT 在 MySQL 接受参数化
        // placeholder (跟 MSSQL TOP / FETCH 不同), 这里 limit 走 ? 即可.
        // R158.72.x.4 (2026-10-16) — +1 列 operator_user (跟 6 列 1:1 平行,
        //   AccountChangeDetailView 8 列 "操作人").
        // R158.X.99.20 (2026-10-19) — 「当日」改 **UTC 昨天**
        //   (DATE_SUB(CURDATE(), INTERVAL 1 DAY)). dailyTopByAction 的
        //   语义不是"今天", 而是"agent 每天 06:00 跑的那一批" ——
        //   那些 run 在 UTC 里落在**昨天**, 用 CURDATE() 会取到空集.
        //   跟 builtin-packages.js:548 的 agent 侧口径 1:1 对齐.
        const safeLimit = Math.max(1, Math.min(200000, Number.parseInt(limit, 10) || 50));
        const sql = `SELECT sam, COALESCE(display_name, '') AS display_name,
                 created_at, modified_at, change_date, dc_name, COALESCE(operator_user, '') AS operator_user
                 FROM ad_account_change
                 WHERE action = ? AND change_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
                 ORDER BY COALESCE(modified_at, created_at) DESC
                 LIMIT ?`;
        return { sql, params: [action, safeLimit] };
      },
      // Retention chunked DELETE (跟 reportRun.deleteOlderThan 同 dialect-keyed 风格).
      deleteOlderThan: {
        mysql: `DELETE FROM ad_account_change
                WHERE change_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
                LIMIT 5000`,
        mssql: `DELETE TOP (5000) FROM ad_account_change
                WHERE change_date < DATEADD(DAY, -?, CAST(GETUTCDATE() AS DATE))`
      }
    },
    // single most-recent row per agent_id from any `pkg_<name>.metrics`
    // table. Used by routes/dcs.js to source lockedCount from
    // pkg_ad_lockout_summary.metrics (ad_lockout_summary v2 package —
    // already shipped via R107). Column list is parameterised so the same
    // helper serves other v2 packages that grow later.
    //
    // Same dialect-portable `?` placeholders convention as the rest of the
    // MySQL block. The MSSQL mirror at line ~980 uses OUTER APPLY TOP 1.
    // Parameter order: schemaName first (needed by the SELECT FROM clause),
    // columns array is splatted into the SELECT list as part of the SQL
    // string (not a bind), since column names are validated upstream.
    metricstore: {
      latestPerAgent: ({ schemaName, columns }) => {
        if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
          throw new Error(`metricstore.latestPerAgent: invalid schemaName ${schemaName}`);
        }
        if (!Array.isArray(columns) || columns.length === 0) {
          throw new Error('metricstore.latestPerAgent: columns required');
        }
        // Column whitelist — refuse anything outside the v2 contract.
        const safeColumns = columns.filter(c => /^[a-z][a-z0-9_]*$/.test(c));
        if (safeColumns.length !== columns.length) {
          throw new Error('metricstore.latestPerAgent: invalid column name(s)');
        }
        const colList = ['m.agent_id', 'm.ts', ...safeColumns.map(c => `m.${c}`)].join(', ');
        // MySQL 5.7 portable: (agent_id, ts) IN (subquery) — no window funcs.
        const sql = `SELECT ${colList}
                     FROM \`${schemaName}\`.\`metrics\` m
                     WHERE (m.agent_id, m.ts) IN (
                       SELECT agent_id, MAX(ts) AS max_ts
                       FROM \`${schemaName}\`.\`metrics\`
                       GROUP BY agent_id
                     )`;
        return { sql, params: [] };
      }
    },
    discovery: {
      upsertDc: `INSERT INTO ad_dcs (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE site_hint = VALUES(site_hint), os_version = VALUES(os_version), when_created = VALUES(when_created), is_pdc = VALUES(is_pdc), is_gc = VALUES(is_gc), is_rid_master = VALUES(is_rid_master), is_schema_master = VALUES(is_schema_master), is_domain_naming_master = VALUES(is_domain_naming_master), is_infrastructure_master = VALUES(is_infrastructure_master), discovered_at = UTC_TIMESTAMP(), discovered_by_agent_id = VALUES(discovered_by_agent_id)`
    },
    users: {
      findByUsername: `SELECT u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name, GROUP_CONCAT(rp.permission) AS permissions FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE u.username = ? GROUP BY u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name LIMIT 1`,
      list: 'SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?',
      bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?',
      getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = ?',
      getAuthStatus: 'SELECT token_version, status FROM sys_users WHERE id = ?',
      countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`,
      createAdmin: 'INSERT INTO sys_users (username, password_hash, role_id) VALUES (?, ?, (SELECT id FROM sys_roles WHERE role_name = \'admin\'))',
      count: 'SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = \'admin\'',
      // R158.104 (2026-10-14) — self-service Profile endpoint. Same column
      // shape as findByUsername MINUS password_hash + token_version (the
      // widget must NEVER see those). Class findByUsername precedent
      // (joins sys_roles for role_name; 1:1 mirror for symmetry).
      meProfile: `SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id WHERE u.id = ? LIMIT 1`
    },
    roles: {
      list: `SELECT r.id, r.role_name, GROUP_CONCAT(rp.permission) AS permissions FROM sys_roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id, r.role_name ORDER BY r.id`
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `INSERT INTO system_config (config_key, config_value, updated_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = UTC_TIMESTAMP()`,
      setAgentToken: `INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = UTC_TIMESTAMP()`,
      getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_version')`,
      // R158.102 (2026-10-14) — MCP server token bundle. Four rows
      //   mcp_api_token_current / mcp_api_token_previous / mcp_api_token_rotated_at
      //   / mcp_api_token_version. Mirrors getAgentTokenBundle shape; dialect-
      //   portable so a single SELECT works against both mssql + mysql.
      //   Used by services/mcp-token.js + auth/mcp-token.js middleware.
      getMcpTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_api_token_current', 'mcp_api_token_previous', 'mcp_api_token_rotated_at', 'mcp_api_token_version')`,
      // R158.113 (2026-10-17) — MCP write tools token bundle. Mirrors
      //   mcp_api_token bundle shape exactly. Used by services/mcp-write-token.js
      //   + auth/mcp-write-token.js middleware. 4 KV rows: current / previous /
      //   rotated_at / version. Prefix `mcpw_` distinguishes from `mcp_` (read).
      getMcpWriteTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_write_token_current', 'mcp_write_token_previous', 'mcp_write_token_rotated_at', 'mcp_write_token_version')`,
      // R158.X.99.28.b (2026-10-19) — MCP IP whitelist bundle. Two rows
      //   mcp_ip_whitelist (JSON 数组 string) + mcp_ip_whitelist_enabled ('0'|'1').
      //   Mirrors getMcpTokenBundle shape. dialect-portable 1:1 平行.
      //   Used by auth/mcp-token.js + auth/mcp-write-token.js middleware.
      //   (修: R158.X.99.28 ship 走 db.sql.config.getAll 拉全表 + 客户端 filter
      //   → F1 HIGH performance finding 修.)
      getMcpIpWhitelistBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_ip_whitelist', 'mcp_ip_whitelist_enabled')`,
      // 2026-10-01 R158.13 — parallel to getAgentTokenBundle. Two-row
      // bundle: agent_settings (JSON blob) + agent_settings_version
      // (monotonic int). Read by client-settings.js service.
      getAgentSettingsBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_settings', 'agent_settings_version')`,
      getJwtSecretBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')`,
      audit: {
        write: 'INSERT INTO sys_config_audit (config_key, old_value, new_value, changed_by, change_type) VALUES (?, ?, ?, ?, ?)',
        list: `SELECT a.id, a.config_key, a.old_value, a.new_value, a.changed_by, a.change_type, a.changed_at, u.username AS changed_by_username FROM sys_config_audit a LEFT JOIN sys_users u ON a.changed_by = u.id ORDER BY a.changed_at DESC, a.id DESC LIMIT 20`,
        getById: 'SELECT id, config_key, old_value, new_value, change_type FROM sys_config_audit WHERE id = ?'
      }
    },
    audit: {
      // R161.16 (2026-10-27) — created_at 显式写成 UTC, 不再依赖列默认值。
      //   MySQL 基线: created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      //   ⇒ DEFAULT 取的是**会话时区**的墙钟。R161.10 之前没钉会话时区,
      //     于是"钉之前"的行存的是服务器本地墙钟 (本机 CST +480 分钟),
      //     前端又统一把 naive DATETIME 当 UTC 解读 ⇒ 那批行整体晚 8 小时。
      //   显式 UTC_TIMESTAMP() 让写入不再依赖会话时区 —— 这是根因修复:
      //     即便将来有人漏掉 SET time_zone, 新写入的行依然是真 UTC。
      //   MSSQL 版用 SYSUTCDATETIME() (该基线的 DEFAULT 本来就是 UTC),
      //     两边占位符个数保持一致 (4 个)。
      write: 'INSERT INTO audit_logs (user_id, action, target, payload, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
      // SELECT for paginated listing. The dialect owns both pagination syntax
      // and parameter order: callers pass semantic (size, offset) values.
      list: (where) => ({
        sql: `SELECT a.id, a.user_id AS userId, a.action, a.target, a.payload,
                a.created_at AS createdAt, u.username AS username
         FROM audit_logs a
         LEFT JOIN sys_users u ON a.user_id = u.id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
        listParams: (whereParams, size, offset) => [...whereParams, size, offset]
      }),
      count: `SELECT COUNT(*) AS total FROM audit_logs a`,
      // Placeholder count is built dynamically by the caller so any category
      // (any number of actions) round-trips without losing the bound-param
      // pattern that the mssql driver wrapper expects.
      badge: (actionList) => `SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (${actionList.map(() => '?').join(',')})`,
      // R158.X.99.report (2026-10-21) — 日报/周报「MCP 调用统计」段.
      //   刻意**不**在 SQL 层做 payload JSON 提取 (MSSQL payload 是
      //   NVARCHAR(MAX), 建 JSON 索引代价高, 且 audit purge 后索引碎片多).
      //   口径: 4 个 mcp 调用 action 分组计数 (读成功/读失败/写成功/写失败).
      //   token 生命周期 action (mcp_token_seed/rotate/...) 不计 —— 那是配置
      //   操作不是"调用", 混进来会让日调用数虚高 (一次 rotate 混进 24h 统计
      //   会让操作员误以为有外部调用者).
      //   client_ip 维度在应用层 parse payload (见 services/reports.js 的
      //   fetchMcpSection), 不下推到 SQL.
      //   1:1 平行 mssql 段 countMcpCalls.
      countMcpCalls: `SELECT a.action,
         COUNT(*) AS call_count,
         COUNT(DISTINCT u.username) AS user_count,
         MIN(a.created_at) AS first_at,
         MAX(a.created_at) AS last_at
       FROM audit_logs a
       LEFT JOIN sys_users u ON u.id = a.user_id
       WHERE a.action IN ('mcp.request','mcp.request.failed','mcp.write.request','mcp.write.request.failed')
         AND a.created_at BETWEEN ? AND ?
       GROUP BY a.action`,
      // R158.X.99.report (2026-10-21) — client_ip 维度聚合. 跟 countMcpCalls
      //   分开两条 SQL 的理由: countMcpCalls 是"按 action 分类计数",
      //   这里是"取窗口内最近 N 条原始行, 应用层 parse payload.client_ip".
      //   0 下推 JSON 提取到 SQL (见上条注释).
      //   排序按 created_at DESC —— 应用层按 IP 聚合时只需要"谁在调",
      //   最新 N 条比全窗口更代表当前活跃调用方, 且有界 (防 90 天窗口全扫).
      //   1:1 平行 mssql 段 listRecentMcpCalls.
      listRecentMcpCalls: ({ limit = 500 } = {}) => {
        const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
        return `SELECT a.action, a.payload, a.created_at
                 FROM audit_logs a
                 WHERE a.action IN ('mcp.request','mcp.request.failed','mcp.write.request','mcp.write.request.failed')
                   AND a.created_at BETWEEN ? AND ?
                 ORDER BY a.created_at DESC
                 LIMIT ${lim}`;
      },
      // I4: retention purge. Deletes rows older than the bound date. Both
      // dialects accept DATE_SUB/DATEADD with the same parameter shape
      // (single bound datetime), so the SQL stays portable.
      purge: 'DELETE FROM audit_logs WHERE created_at < ?'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name`,
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      upsert: `INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE region_code = VALUES(region_code), is_hub = VALUES(is_hub), description = VALUES(description)`,
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      // 2026-08-27 round-28.5: surface is_bridgehead so the admin 域控清单
      // can show the bridgehead toggle next to the FSMO role toggles. The
      // bridgehead is an operator-chosen designation (NOT a FSMO role) used
      // by the all-sites replication matrix view to pick a primary DC per
      // site; sites without a marked bridgehead fall back to lex-first dc_name.
      // 2026-08-27 round-29: added dcs.updateFlags helper — same partial-update
      // shape as sites.updatePartial / systemPorts.updatePartial so the route
      // can build the SET list from whatever body keys the operator toggled.
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.is_bridgehead AS isBridgehead, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId, d.forest_domain_id AS forestDomainId, fd.domain_name AS forestDomainName, fd.forest_id AS forestId, d.decommissioned_at AS decommissionedAt, d.monitoring_paused_at AS monitoringPausedAt FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id LEFT JOIN ad_forest_domain fd ON d.forest_domain_id = fd.id ORDER BY d.dc_name`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?',
      updateFlags: (fields) => `UPDATE ad_dcs SET ${fields.join(', ')} WHERE dc_name = ?`,
      // R158.41 (2026-10-03) — DcsCatalogView 行级「域」下拉直接修改 ad_dcs.forest_domain_id.
      // domainId=null/undefined → unbind on server (R158.37.4 风格, 不删除 DC 行).
      setDomain: 'UPDATE ad_dcs SET forest_domain_id = ? WHERE dc_name = ?',
      setDomainUnbind: 'UPDATE ad_dcs SET forest_domain_id = NULL WHERE dc_name = ?',
      // R158.44.1 (2026-10-04) — operator 反馈 "KDLFLOFADSRV1 归属 forestDomainId=2 明显的是错的".
      // ad_dcs.forest_domain_id 指向不存在的 ad_forest_domain.id (孤儿引用, 常见于 R158.42 schema
      // rebase 后旧的 forest/domain 行被 DROP 但 DC 行 FK 未及时清理). LEFT JOIN 找出孤儿 DC, 一键清.
      listOrphanDcs: `SELECT d.dc_name AS dcName, d.forest_domain_id AS orphanDomainId
                       FROM ad_dcs d
                       LEFT JOIN ad_forest_domain fd ON fd.id = d.forest_domain_id
                       WHERE d.forest_domain_id IS NOT NULL AND fd.id IS NULL
                       ORDER BY d.dc_name`,
      // R158.44.1 — 一键清掉全部孤儿 FK. MySQL 多表 UPDATE 语法.
      unbindAllOrphanDcs: `UPDATE ad_dcs d
                           LEFT JOIN ad_forest_domain fd ON fd.id = d.forest_domain_id
                           SET d.forest_domain_id = NULL
                           WHERE d.forest_domain_id IS NOT NULL AND fd.id IS NULL`,
      // MSSQL UPDATE … FROM 语法不同 — 在 routes/admin.js 走 _pick isMssql 分支,
      // 这里复用同一占位符字符串, caller 按 dialect 选. (实际 MSSQL: UPDATE d SET
      // d.forest_domain_id = NULL FROM ad_dcs d LEFT JOIN ad_forest_domain fd
      // ON fd.id = d.forest_domain_id WHERE d.forest_domain_id IS NOT NULL
      // AND fd.id IS NULL)
      // R158.41 (2026-10-03) — TopContextPicker dropdown DC 数据源 (主路径).
      // 直接 ad_dcs WHERE = ? 查询, 不再依赖三段选择 (assignment+domainField+pdc).
      // R158.41 (2026-10-03) — TopContextPicker 4 级 dropdown (🌲 森林 → 🏢 域 → 📍 站点 → 🖥 DC)
      // 需要 site 信息. JOIN ad_sites 一次拿到 siteId/siteName, 前端按 siteId 分组出站点
      // 列表, 默认选第一个 dcCount > 0 的 (R158.41.2 "有资源优先" 思想延伸).
      listByDomain: `SELECT d.dc_name AS dcName, d.is_pdc AS isPdc,
                            s.site_id AS siteId, s.site_name AS siteName,
                            s.is_hub AS isHub
                     FROM ad_dcs d
                     LEFT JOIN ad_sites s ON s.site_id = d.site_id
                     WHERE d.forest_domain_id = ?
                     ORDER BY d.is_pdc DESC, d.dc_name`,
    },
    dashboard: {
      // R158.31.1 — ad_replication_status is append-only (probe 每次跑就 INSERT 一行),
      // 老 SQL `COUNT(*) FROM ad_replication_status` 返回的是累积行数 (现在 217) 而
      // 不是真实链路数。改成 latest-per-(source_dc, dest_dc) + 24h 窗口, 跟 /api/dashboard/summary
      // (dashboard.js:421-456) 的 linkSql 一致。
      //
      // 注意: mysql 与 mssql 两 dialect 各有自己的一份 (mssql 段在本文件
      // 下方), mysql 段用 MySQL 日期函数 (DATE_SUB / UTC_TIMESTAMP), mssql 段
      // 用 DATEADD / SYSUTCDATETIME。
      //
      // R161.5 (2026-10-26) — MySQL 5.7 兼容化. 原写法用 window function
      // (ROW_NUMBER() OVER (PARTITION BY ...)) 取 latest-per-(source,dest),
      // 但 ROW_NUMBER OVER 是 MySQL 8.0.2+ 才有的语法 ⇒ 在操作员真库
      // (MySQL 5.7.44) 上整条 SQL 报 ER_PARSE_ERROR ⇒ /api/dashboard/summary
     // 500. 改成 5.7 通用写法: "同分区内没有更新的行" (NOT EXISTS + id
      // 兜底 tiebreaker) —— 语义与 rn = 1 等价 (每个 (source_dc, dest_dc)
      // 分区恰好保留 1 行, collected_at 相同时取 id 最大的那行)。
      overviewCounts: `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy,
          SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning,
          SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored,
          MAX(latest.collected_at) AS last_update
        FROM (
          SELECT rs.source_dc, rs.dest_dc, rs.status_code, rs.collected_at
          FROM ad_replication_status rs
          WHERE rs.collected_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
            -- R158.X.115 (2026-10-20) — 排除退役/暂停 DC 的复制关系。放在
            --   子查询内 (而非外层) 是有意的: 这样"最新采样"的候选集里根本
            --   不会出现退役 DC 的行, latest-per-(source,dest) 选出的是最新
            --   **在线**采样, 而不是"最新退役采样"。源端/目的端任一退役即排除。
            AND NOT EXISTS (SELECT 1 FROM ad_dcs d1 WHERE d1.dc_name = rs.source_dc AND (d1.decommissioned_at IS NOT NULL OR d1.monitoring_paused_at IS NOT NULL))
            AND NOT EXISTS (SELECT 1 FROM ad_dcs d2 WHERE d2.dc_name = rs.dest_dc AND (d2.decommissioned_at IS NOT NULL OR d2.monitoring_paused_at IS NOT NULL))
            -- R161.5 — 5.7 版 "最新一行" 判定: 同 (source_dc, dest_dc) 分区内
            --   不存在更晚的采样行 (collected_at 相同时用 id 兜底, 保证每个
            --   分区恰好 1 行 —— ROW_NUMBER 的 rn = 1 语义)。
            AND NOT EXISTS (
              SELECT 1 FROM ad_replication_status r2
              WHERE r2.source_dc = rs.source_dc
                AND r2.dest_dc = rs.dest_dc
                AND (r2.collected_at > rs.collected_at
                     OR (r2.collected_at = rs.collected_at AND r2.id > rs.id))
                AND r2.collected_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
                AND NOT EXISTS (SELECT 1 FROM ad_dcs d3 WHERE d3.dc_name = r2.source_dc AND (d3.decommissioned_at IS NOT NULL OR d3.monitoring_paused_at IS NOT NULL))
                AND NOT EXISTS (SELECT 1 FROM ad_dcs d4 WHERE d4.dc_name = r2.dest_dc AND (d4.decommissioned_at IS NOT NULL OR d4.monitoring_paused_at IS NOT NULL))
            )
        ) latest`,
      // R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。
      //   NOT EXISTS (而非 INNER JOIN ad_dcs): agentCount 数的是心跳行, 有些
      //   agent 已上报心跳但还没被 discovery 写进 ad_dcs。INNER JOIN 会把这类
      //   行**静默抹掉**, 让 KPI 掉数; NOT EXISTS 只排除"明确标记为退役"的,
      //   语义精确且不误伤。谓词口径跟 db/sql/host-status.js 的 ONLINE_DC_WHERE
      //   一致 (相关子查询内用裸列名, 0 别名)。
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat ah WHERE ah.last_heartbeat_at IS NOT NULL AND ah.agent_id <> '__healthcheck__' AND ah.agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM ad_dcs d WHERE d.dc_name = ah.agent_id AND (d.decommissioned_at IS NOT NULL OR d.monitoring_paused_at IS NOT NULL))`,
      // siteMatrix 同理: 退役 DC 的复制关系不该再出现在站点间错误矩阵里。
      //   源端或目的端任一退役即排除该行 (退役后这条复制关系已不存在)。
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status rs WHERE (source_site IS NOT NULL AND source_site <> '') AND (dest_site IS NOT NULL AND dest_site <> '') AND NOT EXISTS (SELECT 1 FROM ad_dcs d1 WHERE d1.dc_name = rs.source_dc AND (d1.decommissioned_at IS NOT NULL OR d1.monitoring_paused_at IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM ad_dcs d2 WHERE d2.dc_name = rs.dest_dc AND (d2.decommissioned_at IS NOT NULL OR d2.monitoring_paused_at IS NOT NULL)) GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      // R158.113 (2026-10-17) — site_keyword resolution helpers for MCP write tools.
      //   LLM hands MCP a `site_keyword: string`. The center resolves it via LIKE
      //   on ad_sites.site_name + alias, returning candidate sites. Multi-match is
      //   surfaced as a list so the LLM re-asks; 0-match falls back to the Hub
      //   site (ad_sites.is_hub=1) and picks its PDC (ad_dcs.is_pdc=1, ORDER BY DESC).
      //   0 schema changes — only SELECT against existing ad_sites / ad_dcs tables.
      //   mysql 段 dead-code 镜像用同样 SQL (生产不跑, 1:1 平行保 shape 一致).
      //   ad_sites 从来没有 alias 列 (生产 INFORMATION_SCHEMA 只有 7 列). 老代码写
      //   `OR (alias IS NOT NULL AND alias LIKE ?)` 当守卫是无效的 —— MSSQL 在**解析阶段**
      //   就抛 Invalid column name, 轮不到 IS NOT NULL 求值 (T-SQL 不保证 OR 短路).
      //   该列全库无写入方 (SitesCatalogView 批量导入只维护 siteName/regionCode/
      //   isHub/description), 加了也永远 NULL, 功能增益 0 → 删分支.
      //   ⚠️ params 由 2 个减为 1 个, 调用方 services/ad-command-dispatch.js:34
      //   必须同步 (lesson 13: SQL 改必同步调用方 shape).
      getSiteByKeyword: `SELECT site_id, site_name FROM ad_sites WHERE site_name LIKE ? ORDER BY site_name LIMIT 10`,
      getDcsBySite: `SELECT dc_name, is_pdc FROM ad_dcs WHERE site_id = ? ORDER BY is_pdc DESC`,
      // R158.113 — Hub fallback when LLM omits site_keyword (or keyword has 0
      //   match). Pick the PDC of the hub site (TOP 1, 跟段内 36 处 TOP 范式 1:1 平行).
      //   0 row → caller throws 400 no_hub_site_configured.
      getHubDefaultDc: `SELECT d.dc_name FROM ad_sites s INNER JOIN ad_dcs d ON d.site_id = s.site_id WHERE s.is_hub = 1 ORDER BY d.is_pdc DESC LIMIT 1`,
      // R158.114 (2026-10-17) — MCP operation log list (audit_logs join sys_users).
      //   1:1 平行 mysql 段 (sql.js:921), 业务层 db.dialect 分发. 跟现有
      //   audit.js 5-203 ACTION_CATEGORY 5 个 mcp.* action 全 1:1 复用.
      listMcpOperations: `SELECT a.id, a.action, a.target, a.payload, a.created_at, u.username
                            FROM audit_logs a LEFT JOIN sys_users u ON u.id = a.user_id
                            WHERE a.action IN ('mcp.request','mcp.request.failed','mcp.write.request','mcp.write.request.failed',
                                               'mcp.auth.fail','mcp-write.auth.fail',
                                               'mcp_token_seed','mcp_token_rotate','mcp_token_commit','mcp_token_reveal',
                                               'mcp_write_token_seed','mcp_write_token_rotate','mcp_write_token_commit','mcp_write_token_reveal',
                                               'ad_user_password_reset','ad_user_create','ad_user_enable','ad_user_disable',
                                               'ad_user_unlock','ad_user_delete','ad_group_create',
                                               'ad_command_queued','ad_command_succeeded','ad_command_failed','ad_command_timeout')
                            ORDER BY a.created_at DESC`,
      // 2026-08-26 round-21: /topology used to return every row in
      // ad_replication_status, including stale round-19 leftovers and
      // test/junk rows (*, __tz_test, DC01→"") — operators saw 42 links
      // instead of the 19 the round-20 topology actually emits. The fix:
      // (a) derive site + dc nodes from ad_sites / ad_dcs (catalog is
      // source of truth — agent-reported source_site is a free-text hint
      // and does not match catalog site_name), (b) for links, take the
      // latest row per (source_dc, dest_dc) pair where both are known
      // DCs and source_dc != dest_dc, and (c) drop rows older than 30
      // minutes (UTC) so pairs the daemon stopped emitting — e.g. the
      // round-19 topology pairs that were renamed in round-20 — fall
      // out of the graph. UTC clock is essential: collected_at is in
      // UTC but MySQL NOW() returns session-tz (round-15 UTC cleanup).
      // R158.45 (2026-10-05) — bridgehead field exposed on DC nodes so
      // the topology chart can render the "DC↔Site Link Bridgehead"
      // callout boxes the operator asked for. ad_dcs.is_bridgehead has
      // been collected since R69 (agent ps1) but the topologyNodes SQL
      // never selected it. adAdminApi.listDcs also reads this endpoint
      // — additive, not breaking.
      topologyNodes: `
        SELECT s.site_id       AS site_id,
               s.site_name     AS site_name,
               s.is_hub        AS is_hub,
               d.dc_name       AS dc_name,
               d.is_bridgehead AS is_bridgehead
        FROM ad_sites s
        -- R158.X.115 (2026-10-20) — 退役/暂停管控的 DC 从拓扑图**消失** (不是
        --   灰显)。理由: AD 降级后该 DC 已从复制伙伴中消失, 留在图上正是用户
        --   要解决的噪音问题。
        --   过滤放 **ON 子句** 而非 WHERE —— 这是本改动的关键点: 放 WHERE
        --   会让 LEFT JOIN 退化成 INNER JOIN, 把"该站点下已无在线 DC"的
        --   站点整行干掉, 导致空站点从拓扑图凭空消失。放 ON 里, 站点行保留
        --   (dc_name = NULL), 退役 DC 本身被排除。语义精确。
        LEFT JOIN ad_dcs d ON d.site_id = s.site_id
              AND d.decommissioned_at IS NULL
              AND d.monitoring_paused_at IS NULL
        ORDER BY s.is_hub DESC, s.site_name, d.dc_name
      `,
      topologyLinks: `
        SELECT t1.source_dc, t1.dest_dc, t1.status_code, t1.last_success_time,
               v.probe_state AS probe_state, v.probe_attempt_at AS probe_attempt_at
        FROM ad_replication_status t1
        INNER JOIN ad_dcs sd ON sd.dc_name = t1.source_dc
        INNER JOIN ad_dcs dd ON dd.dc_name = t1.dest_dc
        -- R158.X.99-silent.topology (2026-10-21) — 扩 wire-shape: LEFT JOIN
        -- v_partner_inbound 给前端多带 probe_state (4 档 enum: success/partial/
        -- error/none) + probe_attempt_at. 让前端能把 probeState='none'
        -- (拓扑有, 探针 0 报告) 跟 status_code=2 (复制真挂) 严格分色;
        -- 跟 /matrix/inbound 的 silent 红 1:1 平行 (同数据源, 同语义).
        -- LEFT JOIN 因为 ad_replication_status 是老 30min probe 表, 跟
        -- v_partner_inbound (30 天 discover + 15min probe) 不一定同源 —
        -- 历史上有些 row 在 ad_replication_status 里有, 在 v 里无
        -- (例如 reporter 撤了 agent 但 discovery 表未清理). 反向 (在 v
        -- 无但 ad_replication_status 有) 也可能. v 没匹配 → NULL →
        -- 前端 fallback 用 status_code 2 标红 (已经是 ad_replication_status
        -- 老语义, 30min 没更新也算 stale). v 有匹配 → 用 probe_state.
        LEFT JOIN v_partner_inbound v
          ON v.target_dc = t1.dest_dc AND v.peer_dc = t1.source_dc
        WHERE t1.source_dc <> t1.dest_dc
          AND t1.naming_context NOT IN ('__dc_summary__', 'META')
          AND t1.collected_at = (
            SELECT MAX(t2.collected_at) FROM ad_replication_status t2
            WHERE t2.source_dc = t1.source_dc
              AND t2.dest_dc   = t1.dest_dc
              AND t2.naming_context NOT IN ('__dc_summary__', 'META')
          )
          AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE
          -- R158.X.115 (2026-10-20) — 退役/暂停 DC 的复制边从拓扑图消失。
          --   sd / dd 是上面 INNER JOIN 进来的 ad_dcs 别名, 直接加谓词即可
          --   (INNER JOIN 语义下放 WHERE 不改变 join 行为)。跟 topologyNodes
          --   的过滤口径一致 —— 节点没了, 边也必须跟着没, 否则会留下指向
          --   不存在节点的悬空连线。
          AND sd.decommissioned_at IS NULL AND sd.monitoring_paused_at IS NULL
          AND dd.decommissioned_at IS NULL AND dd.monitoring_paused_at IS NULL
        ORDER BY t1.source_dc, t1.dest_dc
      `,
      // R158.68.5 (2026-10-10) — exclude sentinel META / __dc_summary__ + status_code=-1 probe rows.
      //   See mssql segment for rationale; mirrors sql.js line 70/207/538/959... pattern.
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 AND status_code > 0 AND naming_context NOT IN ('__dc_summary__', 'META') ORDER BY last_attempt_time DESC`,
      // R158.X.116.p (2026-10-23) — errorsRecent: errors 的带时间窗版本.
      //   1:1 平行上面的 errors (同 SELECT 列 / 同 status_code 判定 / 同
      //   META 哨兵排除), 只多一个 last_attempt_time 下界。
      //   **老 errors 保持原样** — feedback-new-endpoint-dont-modify-old
      //   锁: 前台要收窄窗口就换新 helper, 不改老 helper 的语义。
      //   hours=null → 时间下界子句语法层缺席 (全历史)。
      //
      // R158.X.116.p.2 (2026-10-23) — 全量扫描发现的两处遗漏, 一并修:
      //   (a) **补 error_message 列** —— 老 errors 从建立起就 0 SELECT 过这
      //       列, 而前端 ErrorTable.vue 一直在渲染 r.errorMessage, 导致
      //       「报错原文」那格自页面诞生起就是空的。0 报错 0 日志, 纯静默
      //       空列。ErrorTable 侧的字段名已修对 (error_message → errorMessage)
      //       但后端不返回 = 前端改了也没用, 两边必须一起改。
      //   (b) **站点列改 JOIN ad_dcs→ad_sites catalog** —— 与 bySiteMatrix /
      //       topologyNodes 同原则 (sql.js:1133-1134 "catalog is source of
      //       truth — agent-reported source_site is a free-text hint")。
      //       原 SELECT 裸读 source_site/dest_site, 那是 agent 上报的自由
      //       文本, 存旧命名体系 (KDL-GuiYang), 跟 ad_sites 现行 site_name
      //       (康德乐贵阳) 对不上 —— 前台错误页显示的站点名一直是错的。
      //       用 LEFT JOIN 而非 bySiteMatrix 那样的 IS NOT NULL 收窄: 那里
      //       是聚合矩阵 (查不到站点就不该成组), 这里是明细列表 (丢行比显示
      //       空站点更糟), 与 sql.js:1235 的 agents helper 同策略。
      errorsRecent: (hours) => `SELECT source_dc, dest_dc, ss.site_name AS source_site, ds.site_name AS dest_site, naming_context, status_code, last_success_time, last_attempt_time, error_message, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status t LEFT JOIN ad_dcs sd ON sd.dc_name = t.source_dc LEFT JOIN ad_sites ss ON ss.site_id = sd.site_id LEFT JOIN ad_dcs dd ON dd.dc_name = t.dest_dc LEFT JOIN ad_sites ds ON ds.site_id = dd.site_id WHERE status_code <> 0 AND status_code > 0 AND naming_context NOT IN ('__dc_summary__', 'META') ${hours == null ? '' : 'AND last_attempt_time >= UTC_TIMESTAMP() - INTERVAL ? HOUR'} ORDER BY last_attempt_time DESC`,
      // R140 — add siteName/siteHint so /admin/agents can group by site.
      // Mirrors the JOIN pattern used by /api/admin/heartbeat-report/dcs
      // (sql.js heartbeat.dcsList, also a "agents joined to site" surface).
      // LEFT JOIN so agents without a matching ad_dcs row still surface
      // (they get siteName = null → "未分组" bucket on the frontend).
      agents: `SELECT h.agent_id, h.last_heartbeat_at, h.agent_version, h.last_report_at, h.last_report_status, h.pending_queue_size, TIMESTAMPDIFF(SECOND, h.last_heartbeat_at, UTC_TIMESTAMP()) AS seconds_since_heartbeat, s.site_id AS site_id, s.site_name AS site_name, s.region_code AS region_code, d.site_hint AS site_hint FROM ad_agent_heartbeat h LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id LEFT JOIN ad_sites s ON s.site_id = d.site_id WHERE h.agent_id <> '__healthcheck__' AND h.agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM ad_dcs hd WHERE hd.dc_name = h.agent_id AND (hd.decommissioned_at IS NOT NULL OR hd.monitoring_paused_at IS NOT NULL)) ORDER BY h.agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`,
      // 2026-08-27 round-27: all-sites variant for the global replication
      // matrix view. Returns every site hub-first, every DC, and every
      // within/cross replication link (excluding summary + meta + partner-port
      // rows). Mirrors the topologyLinks JOIN pattern (catalog is source of
      // truth, INNER JOIN ad_dcs / ad_sites) plus the 30-min UTC freshness
      // floor and latest-per-pair correlated subquery.
      allSitesOrdered: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites ORDER BY is_hub DESC, region_code, site_name`,
      allDcsBySite: `SELECT d.dc_name, d.site_id, d.os_version, d.when_created, d.is_pdc, d.is_gc, d.is_rid_master, d.is_schema_master, d.is_domain_naming_master, d.is_infrastructure_master, d.is_bridgehead, d.discovered_at, d.discovered_by_agent_id FROM ad_dcs d INNER JOIN ad_sites s ON s.site_id = d.site_id ORDER BY s.site_name, d.dc_name`,
      allReplicationLinks: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_success_time, t1.last_attempt_time, TIMESTAMPDIFF(MINUTE, t1.last_success_time, t1.last_attempt_time) AS duration_minutes FROM ad_replication_status t1 WHERE t1.source_dc <> t1.dest_dc AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context NOT IN ('__dc_summary__', 'META')) AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.source_dc, t1.dest_dc, t1.naming_context`,
      // 2026-08-28 round-46: latest per-partner TCP-port probe. The probe
      // data lands on the `__partner_ports__:<sha>` naming_context rows
      // collected-replication.ps1 emits (R35 surface, brought back in
      // R46 to feed 复制日志监控's port-health view). partner_port_status
      // carries a JSON blob with per-port reachability details (see
      // collect-replication.ps1::Get-PartnerPortSnapshot for the schema).
      // Filter on LIKE '__partner_ports__:%' (NOT IN the explicit values)
      // because the hash suffix makes an equality check impossible.
      // R154.6 — added `t1.collected_at` so the UI can show "执行时间"
      // per partner row. Was previously omitted because portHealth only
      // needed the JSON blob + status; the staleness badge computed a
      // global max across portHealth[].lastAttemptTime, which silently
      // hid per-row staleness. With collected_at exposed, the per-row
      // probeAt column lights up green/yellow/red against the same
      // thresholds the staleness badge uses (5min / 30min).
      latestPartnerPortPerPair: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_attempt_time, t1.collected_at, t1.partner_port_status FROM ad_replication_status t1 WHERE t1.naming_context LIKE '__partner_ports__:%' AND t1.source_dc <> t1.dest_dc AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context LIKE '__partner_ports__:%') AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.source_dc, t1.dest_dc`,
      // R155.3 — replication_inbound VIEW (migration 033). The
      // /replication-log/monitor-inbound endpoint reads FROM this view
      // (operator directive 2026-09-30 "所有的数据写入或者更新到
      // replication_inbound 表或者视图"). Same row shape as
      // ad_replication_status WHERE naming_context LIKE '__partner_ports__:%'
      // — only the partner-port probe slice is exposed. Per-pair latest
      // reduction is re-applied downstream in dashboard.js:1389-1401
      // (the endpoint also passes the 30-min window via the
      // latestPartnerPortPerPair correlated subquery pattern).
      // R158.17.3 (2026-10-01) -- 直读 ad_replication_status 的
      // __partner_ports__:% 端口探测行 (replication_inbound 视图已在
      // R156.5 retired 时被 migration 038 DROP, 但底层物理表
      // ad_replication_status + partner_port_status JSON 列保留,
      // ad_partner_ports_probe 1.0.x 包仍在写). 这是端口延迟数据唯一
      // 物理表. 列形状与原 replication_inbound 视图一致 (source_dc,
      // dest_dc, naming_context, status_code, last_success_time,
      // last_attempt_time, error_message, collected_at, partner_port_status).
      partnerPortInboundView: `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message, collected_at, agent_id, partner_port_status FROM ad_replication_status WHERE source_dc <> dest_dc AND naming_context LIKE '__partner_ports__:%' AND collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY source_dc, dest_dc, collected_at DESC`,
      // R155.4 — reads FROM the new ad_dc_probe_outbound PHYSICAL TABLE
      // (not a view) for the /api/dashboard/partner-port-health/
      // probe-outbound endpoint. No naming_context column; the row shape
      // is otherwise the same as the R155.3 partnerPortInboundView. The
      // 30-min freshness window matches the agent's collection cycle so
      // a missed probe cycle naturally fades off the view. No
      // latest-per-pair reduction here — the table is keyed UNIQUE
      // (source_dc, dest_dc) so each agent writes exactly one row per
      // peer per cycle, and the endpoint re-applies per-pair reduction
      // downstream in dashboard.js (mirrors R155.3 /monitor-inbound
      // path).
      // R156.5 retired — partnerPortOutbound removed (operator directive
      // "复制伙伴端口主动探测 不需要哦去掉"). ad_dc_probe_outbound table
      // dropped by migration 038. Use partnerPortInboundView (read
      // replication_inbound) or latestPartnerPortPerPair (read
      // ad_replication_status directly) instead.
      // R156 — dashboard read for ad_partner_inbound physical table.
      // 30-day window matches the cron cadence (operator: "一个月执行一次
      // 因为这个数据不会经常变化"). No status_code / latency — discover
      // ≠ probe (no port probing, just DC topology).
      partnerInboundDiscover: `SELECT i.source_dc, i.dest_dc, i.agent_id, i.collected_at, i.discovered_at, d.site_id, s.site_name FROM ad_partner_inbound i LEFT JOIN ad_dcs d ON d.dc_name = i.dest_dc LEFT JOIN ad_sites s ON s.site_id = d.site_id WHERE i.source_dc <> i.dest_dc AND i.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY ORDER BY i.source_dc, i.dest_dc, i.collected_at DESC`,
      // within a 15-min window. Powers SiteReplicationMatrixAllView
      // status pill (replaces R158.14 'none' gray placeholder).
      // Worst-of-NCs aggregation: INNER JOIN to MAX(attempt_at) +
      // ORDER BY status_code DESC LIMIT 1 picks the most-severe NC
      // status (error=2 > success=0 > warning=1). Caller binds
      // [sourceDc, destDc, 15].
      latestReplicationProbePerPair: `SELECT h.status_code, h.attempt_at, h.duration_ms, h.objects_transferred, h.error_message FROM ad_replication_probe_history h INNER JOIN (SELECT source_dc, dest_dc, MAX(attempt_at) AS max_attempt FROM ad_replication_probe_history WHERE source_dc = ? AND dest_dc = ? AND attempt_at >= UTC_TIMESTAMP() - INTERVAL ? MINUTE GROUP BY source_dc, dest_dc) m ON m.source_dc = h.source_dc AND m.dest_dc = h.dest_dc AND m.max_attempt = h.attempt_at ORDER BY h.status_code DESC LIMIT 1`,
      // R156 — outbound mirror of partnerInboundDiscover. R158.5 —
      // operator directive 2026-09-30 "将前台的复制伙伴发现入站和 复制伙伴
      // 出战 放到后台，按站点方式呈现". Outbound anchor is source_dc (= self,
      // the DC whose agent ran the discover), so we JOIN source_dc → ad_dcs
      // → ad_sites (mirror of inbound's dest_dc join).
      partnerOutboundDiscover: undefined, // R158.10 — outbound discover API 已下线
      // R155.6 — partners snapshot for warehouse refresh. Reads every
      // latest-per-pair row from ad_replication_status in the 30-min
      // freshness window (same window as R151.2 inbound / R155.4
      // outbound probe endpoints) with the synthetic-row exclusions
      // applied. The dc-partners-refresh service iterates this list
      // and UPSERTs into ad_dc_inbound_partners / ad_dc_outbound_partners
      // using the per-row helpers below. No naming_context column
      // filtering — every naming_context contributes a row to the
      // warehouse (the operator wants to see which replication
      // contexts are healthy, not just the cross-DC adjacency).
      // Caller binds nothing — pure snapshot read.
      partnersSnapshotAll: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_success_time, t1.last_attempt_time, t1.error_message, t1.collected_at FROM ad_replication_status t1 WHERE t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY t1.source_dc, t1.dest_dc, t1.naming_context`,
      // R158.14 (2026-10-01) — 复制状态概览 (复制伙伴状态 全站) 数据源改造.
      // operator decision: /api/dashboard/site-replication-matrix/all 改用
      // v_partner_inbound 视图 (单纯伙伴列表, 无健康度) 作为唯一伙伴清单来源.
      //
      // 视图已 INNER JOIN ad_dcs (target_dc 必须 catalog 已注册) + LEFT JOIN
      // ad_sites (target_site_name / peer_site_name), 30 天窗口跟
      // partnerInboundDiscover (sql.js:432) 同源.
      //
      // 不 SELECT status_code / last_success_time / last_attempt_time /
      // error_message / naming_context — operator 拍板 "无健康度", 后续
      // 15min probe 包落地后再由 endpoint LEFT JOIN ad_replication_status
      // (latest-per-pair NC-level, worst-of-NCs 聚合) 接回 status pill.
      // 详见 db/migrations/041-v-partner-inbound-mysql.sql.
      vPartnerInbound: `SELECT target_dc, peer_dc, collected_at, discovered_at, reporter_agent_id, target_site_id, target_is_bridgehead, target_site_name, peer_site_id, peer_site_name, peer_site_is_hub, probe_state, probe_attempt_at, probe_duration_ms, probe_error_message FROM v_partner_inbound ORDER BY target_dc, peer_dc`,
      // R155.6 — UPSERT one row into ad_dc_inbound_partners. Keyed on
      // UNIQUE(local_dc, peer_dc, naming_context). 7-param bind:
      // [localDc, peerDc, namingContext, statusCode, lastSuccessTime,
      //  lastAttemptTime, errorMessage]. Refreshed_at auto-bumps via
      // ON UPDATE CURRENT_TIMESTAMP. local_dc is the dest side of the
      // (source_dc, dest_dc) replication edge — the inbound perspective
      // for that DC.
      upsertDcInboundPartner: `INSERT INTO ad_dc_inbound_partners (local_dc, peer_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status_code = VALUES(status_code), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), error_message = VALUES(error_message)`,
      // R155.6 — UPSERT one row into ad_dc_outbound_partners. Same
      // 7-param shape as the inbound sibling; local_dc is the source
      // side — the outbound perspective for that DC.
      upsertDcOutboundPartner: `INSERT INTO ad_dc_outbound_partners (local_dc, peer_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status_code = VALUES(status_code), last_success_time = VALUES(last_success_time), last_attempt_time = VALUES(last_attempt_time), error_message = VALUES(error_message)`,
      // 2026-08-28 round-47: replicationLogRecentAttempts helper removed —
      // the 复制伙伴端口健康监控 route no longer embeds attempts[] on each
      // partner row (port-health-only view). Per-pair history for the
      // inline caret in 复制状态概览 still uses replicationLogPerPair
      // below.
      // 2026-08-28 round-45: lazy-fetch per (source_dc, dest_dc) pair for the
      // "最近 10 条" expansion inside 复制状态概览. The 24h window mirrors
      // replicationLogRecentAttempts — operators care about recent state.
      // Index ix_hist_pair_time(source_dc, dest_dc, naming_context, collected_at)
      // covers WHERE+ORDER BY. Caller binds [source, dest, limit].
      replicationLogPerPair: `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, error_message, collected_at FROM ad_replication_history WHERE source_dc = ? AND dest_dc = ? AND collected_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR ORDER BY collected_at DESC LIMIT ?`,
      // R158.17 (2026-10-01) — 复制状态概览展开历史. 数据源切到
      // ad_replication_probe_history (R158.15 15min cadence probe 包写),
      // 仅取 source_dc / dest_dc / attempt_at / result 四列 (源 + 目标 +
      // 上次执行时间 + 结果). 旧 endpoint /pair-history 仍走
      // ad_replication_history (老复制流水, 含 NC/duration/objects/error
      // 6+ 字段), 不删; probe-history 是新口径.
      probeHistoryPerPair: `SELECT source_dc, dest_dc, attempt_at, result FROM ad_replication_probe_history WHERE source_dc = ? AND dest_dc = ? ORDER BY attempt_at DESC LIMIT ? OFFSET 0`,
      // R158.103.2 (2026-10-15) — 复制状态概览 "明细" drawer. 走
      // ad_replication_probe_history 11 字段全明细 (DB 12 列 - 1
      // collected_at, 跟 attempt_at 一致, 0 暴露给前端). 跟
      // probeHistoryPerPair (R158.17, 4 列, limit=10) 是 2 独立 helper,
      // 0 改旧 helper / 0 改旧端点 / 0 改 inline caret 4 列 wire shape.
      // 端点 /probe-history-detail, 默认 limit=50, cap 50 (跟 inline
      // caret cap 一致不升档, R158.86.6 防 abuse). string-form + LIMIT ?
      // bind, 跟 probeHistoryPerPair 同形.
      probeHistoryPerPairDetail: `SELECT source_dc, dest_dc, naming_context, agent_id, attempt_at, result, status_code, duration_ms, objects_transferred, error_code, error_message FROM ad_replication_probe_history WHERE source_dc = ? AND dest_dc = ? ORDER BY attempt_at DESC LIMIT ? OFFSET 0`,
      // R158.103.1 (2026-10-15) — silent reporter 检测, 走
      // ad_replication_probe_history 24h GROUP BY agent_id. caller 在
      // 路由层判定 latest < now-2h → silent. 单条件 latest_attempt_at
      // (不用 total<50 OR 关系, 慢 cadence DC 1h cadence 24/24h 会被
      // 误杀, 跟 "silent 4h" 是不同故障模式, 不混). matrix UI 标红用.
      probeReporterLiveness: `SELECT agent_id, COUNT(*) AS total_24h, MAX(attempt_at) AS latest_attempt FROM ad_replication_probe_history WHERE attempt_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY agent_id`,
      // 2026-09-01 R74: 复制错误 view — list every (source_dc, dest_dc,
      // naming_context) tuple whose LATEST status row is a failure
      // (status_code IN 1, 2). Mirrors the latest-per-pair correlated
      // subquery used by `allReplicationLinks` + `replicationLogPerPair`,
      // but anchored on `last_attempt_time` instead of `collected_at`
      // (a stale-but-failed link should still surface). Window is on
      // `last_attempt_time` so the same row's age drives both the
      // "is it recent enough" decision and the ORDER BY. attempt_count
      // joins from ad_replication_history in the same window so the
      // operator sees how many attempts landed in the visible period.
      // duration_ms = (last_attempt - last_success) in ms — same shape as
      // duration_minutes on allReplicationLinks, just finer-grained.
      // R158.X.99.29 (2026-10-19) — MAX(t2.last_attempt_time) 子查询加同
      // 窗口限制, 1:1 平行 outer WHERE. 真因: 0 必子查询, 11 天前老失败
      // 行通过 7d 窗口 (last_attempt 3 天前 < 7d) 仍显. agent 11 天 0
      // 上报 → 0 新数据 UPSERT 覆盖 → 老行留着. caller 改 [h,h,h]: 子
      // 查询 + history JOIN + outer WHERE 共享同一 cut-off.
      // Caller binds [hours, hours, hours] — three windows so all three
      // time-bound subqueries share the same cut-off (R158.X.99.29).
      replicationErrors: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code,
                              t1.last_success_time, t1.last_attempt_time, t1.error_message,
                              COALESCE(att.cnt, 0) AS attempt_count,
                              CASE WHEN t1.last_success_time IS NULL OR t1.last_attempt_time IS NULL
                                   THEN NULL
                                   ELSE TIMESTAMPDIFF(MICROSECOND, t1.last_success_time, t1.last_attempt_time) DIV 1000
                              END AS duration_ms
                         FROM ad_replication_status t1
                         LEFT JOIN (
                           SELECT source_dc, dest_dc, naming_context, COUNT(*) AS cnt
                           FROM ad_replication_history
                           WHERE collected_at >= UTC_TIMESTAMP() - INTERVAL ? HOUR
                           GROUP BY source_dc, dest_dc, naming_context
                         ) att ON att.source_dc = t1.source_dc
                              AND att.dest_dc = t1.dest_dc
                              AND att.naming_context = t1.naming_context
                         -- R158.X.116.p.2 (2026-10-23): 原为 IN (1, 2), 改为 > 0.
                         --   与 sql.replication.listActiveErrors 收敛单源 —— 后台
                         --   复制错误页的数据源就是那张表, 两处判定不一致会让前台
                         --   (listActiveErrors) 看到错误而后台 (本 helper) 恒空。
                         --   status_code 的实际值域是 Windows 错误码 (实测 1398
                         --   命名空间绑定失败 / 1722 RPC 不可用), IN (1,2) 只认
                         --   port-probe 的 0/1/2 枚举, 把真正的复制错误全漏掉。
                         WHERE t1.status_code > 0
                           AND t1.source_dc <> t1.dest_dc
                           AND t1.naming_context NOT IN ('__dc_summary__', 'META')
                           AND t1.last_attempt_time = (
                             SELECT MAX(t2.last_attempt_time) FROM ad_replication_status t2
                             WHERE t2.source_dc = t1.source_dc
                               AND t2.dest_dc = t1.dest_dc
                               AND t2.naming_context = t1.naming_context
                               AND t2.last_attempt_time >= UTC_TIMESTAMP() - INTERVAL ? HOUR
                           )
                           AND t1.last_attempt_time >= UTC_TIMESTAMP() - INTERVAL ? HOUR
                         ORDER BY t1.last_attempt_time DESC
                         LIMIT 200`
    },
    heartbeat: {
      // 2026-08-24 round-12: report_requested_at added (last col, matching
      // migration `AFTER agent_token_version`). COALESCE on UPDATE means
      // a `null` param preserves the existing column — agents pre-T6 that
      // don't forward the field will not wipe the "report now" request.
      //
      // 2026-10-01 R158.13: client_settings_version added (last col).
      // Parallel to agent_token_version — the centre echoes back
      // clientSettingsVersion in the heartbeat response and tracks which
      // agents have acknowledged the latest patch. NOT NULL DEFAULT 0
      // (migration 040) keeps the 7-param path legal for pre-R158.13
      // centre code that doesn't bind the new param; the driver binds
      // undefined → NULL → column default 0.
      // R158.48 (2026-10-06) — agent auto-update. last_upgrade_event added
      // (11th col). JSON NULL — agent reports its just-completed upgrade
      // event on the FIRST heartbeat post-restart (one-shot, then cleared).
      // NULL preserves existing row when agent doesn't forward the field
      // (COALESCE on the column → existing value retained for pre-R158.48
      // agents that don't yet know about the field).
      // R158.88.C (2026-10-13) — health_score added (12th col, INT NULL).
      //   跟 R158.48 last_upgrade_event 1:1 平行: 老 fleet 0 报 → NULL
      //   (COALESCE preserve), 新 fleet 0.1.7+ 报 0-100. 0 改 agent 端,
      //   等 fleet 升才生效. R158.69.3 lesson 3 永远适用: 0 自动升级.
      upsert: `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, agent_token_version, report_requested_at, client_settings_version, heartbeat_interval_seconds, last_upgrade_event, health_score) VALUES (?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_heartbeat_at = UTC_TIMESTAMP(), agent_version = VALUES(agent_version), last_report_at = VALUES(last_report_at), last_report_status = VALUES(last_report_status), pending_queue_size = VALUES(pending_queue_size), agent_token_version = VALUES(agent_token_version), report_requested_at = COALESCE(VALUES(report_requested_at), report_requested_at), client_settings_version = VALUES(client_settings_version), heartbeat_interval_seconds = VALUES(heartbeat_interval_seconds), last_upgrade_event = COALESCE(VALUES(last_upgrade_event), last_upgrade_event), health_score = COALESCE(VALUES(health_score), health_score)`,
      // 2026-10-01 R158.13: list every agent's last reported
      // client_settings_version so the admin /api/admin/client-settings
      // endpoint can render the "已推送到 X / N 台 Agent" counter.
      // Mirrors tokenDeliveryList above.
      clientSettingsList: `SELECT agent_id, client_settings_version, last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      // 2026-08-21 UX redesign (auto-delivery): list every agent's last
      // reported agent_token_version so the modal can render the
      // "已推送到 X / N 台 Agent" counter. agent_id is the source-of-truth
      // identifier; for AD it's the configured agentId (e.g. DC name),
      // for non-AD it's the hostname (matches the heartbeat payload).
      tokenDeliveryList: `SELECT agent_id, agent_token_version, last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      // 2026-08-26 round-15: source-of-truth switch for the report-status
      // signal. The previous SELECT exposed h.last_report_at /
      // h.last_report_status, which is a self-declared timestamp the agent
      // writes in its heartbeat body. It drifted from reality (a successful
      // replication report could land without the heartbeat column ever
      // being updated, so the operator view showed "未上传" while data was
      // in the DB). We now derive both fields from ad_replication_status:
      //   - rep.last_report_at = MAX(collected_at) over ALL history
      //     (null = agent has NEVER produced a replication row)
      //   - rep.success_count / fail_count / total_count = aggregate over the
      //     1-hour lookback window (matches the operator rule "last
      //     uploaded data must not exceed one hour")
      //   - last_report_status is a CASE derived from the 1-hour threshold
      //     + the failure count: null / success / partial_failure / stale
      // The new fields keep the same column names so the service layer can
      // keep reading row.last_report_at without renaming. report_requested_at
      // stays from the heartbeat row (it's the admin "report now" flag).
      //
      // 2026-08-26 round-15 hot-fix: NOW() → UTC_TIMESTAMP(). The stored
      // values for collected_at are written via toMysqlDatetime() which
      // produces UTC-naive strings (`YYYY-MM-DD HH:MM:SS` derived from
      // the JS Date's UTC components). MySQL's session timezone on the
      // dev box is SYSTEM (CST = UTC+8), so NOW() returns a CST value —
      // comparing that against UTC-stored rows makes every recent row
      // look 8 hours old. UTC_TIMESTAMP() returns the actual UTC clock,
      // matching the storage convention. Same fix on the MSSQL branch
      // (SYSUTCDATETIME is already UTC). The 1-hour rule was meant to
      // be a wall-clock comparison, not a session-timezone comparison.
      //
      // 2026-08-27 round-39: operator directive "在心跳和报告中的报告是
      // 每天 24点 重置成功率". The success-rate counts now reset at
      // midnight UTC (DATE(UTC_TIMESTAMP()) = today 00:00:00). MySQL
      // coerces the DATE to DATETIME 00:00:00 for comparison against
      // collected_at. last_report_status (stale/fresh) keeps its
      // 1-hour threshold because freshness is about "did the agent
      // just report?" — that's a separate signal from "today's tally".
      // latestFailureFor matches the count window so the error message
      // shown is the one that contributed to today's fail_count.
      agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                          rep.last_report_at,
                          CASE
                            WHEN rep.last_report_at IS NULL THEN NULL
                            WHEN rep.last_report_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR THEN
                              CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN 'partial_failure' ELSE 'success' END
                            ELSE 'stale'
                          END AS last_report_status,
                          COALESCE(recent.success_count, 0) AS success_count,
                          COALESCE(recent.fail_count, 0) AS fail_count,
                          COALESCE(recent.total_count, 0) AS total_count,
                          h.pending_queue_size, h.report_requested_at,
                          h.heartbeat_interval_seconds
             FROM ad_agent_heartbeat h
             LEFT JOIN (
               SELECT agent_id, MAX(collected_at) AS last_report_at
               FROM ad_replication_status
               GROUP BY agent_id
             ) rep ON rep.agent_id = h.agent_id
             LEFT JOIN (
               SELECT agent_id,
                      SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                      SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                      COUNT(*) AS total_count
               FROM ad_replication_status
               WHERE collected_at >= DATE(UTC_TIMESTAMP())
               GROUP BY agent_id
             ) recent ON recent.agent_id = h.agent_id
             WHERE h.agent_id <> '__healthcheck__'
             ORDER BY h.agent_id`,
      dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                       rep.last_report_at,
                       CASE
                         WHEN rep.last_report_at IS NULL THEN NULL
                         WHEN rep.last_report_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR THEN
                           CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN 'partial_failure' ELSE 'success' END
                         ELSE 'stale'
                       END AS last_report_status,
                       COALESCE(recent.success_count, 0) AS success_count,
                       COALESCE(recent.fail_count, 0) AS fail_count,
                       COALESCE(recent.total_count, 0) AS total_count,
                       h.pending_queue_size, h.report_requested_at,
                       h.heartbeat_interval_seconds,
                       d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                       s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          LEFT JOIN (
            SELECT agent_id, MAX(collected_at) AS last_report_at
            FROM ad_replication_status
            GROUP BY agent_id
          ) rep ON rep.agent_id = h.agent_id
          LEFT JOIN (
            SELECT agent_id,
                   SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                   COUNT(*) AS total_count
            FROM ad_replication_status
            WHERE collected_at >= DATE(UTC_TIMESTAMP())
            GROUP BY agent_id
          ) recent ON recent.agent_id = h.agent_id
          WHERE h.agent_id <> '__healthcheck__'
            -- R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。与上面的
            --   LEFT JOIN ad_dcs 不冲突: 本查询主键是 h.agent_id (心跳行),
            --   退役 DC 的心跳行本就不该出现在"当前 agent"列表里。跟 sql.js
            --   heartbeat.agents 同口径。
            AND NOT EXISTS (SELECT 1 FROM ad_dcs hd WHERE hd.dc_name = h.agent_id AND (hd.decommissioned_at IS NOT NULL OR hd.monitoring_paused_at IS NOT NULL))
          ORDER BY h.agent_id`,
      // 2026-08-24 round-12: requestReport UPSERT — insert a stub heartbeat
      // row if the agent hasn't checked in yet, or set the column if it
      // has. Caller binds [agentId, requestedAt] (Date or ISO string).
      requestReport: (agentId, requestedAtIso) =>
        `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, report_requested_at)
         VALUES (?, UTC_TIMESTAMP(), ?)
         ON DUPLICATE KEY UPDATE report_requested_at = VALUES(report_requested_at)`,
      // 2026-08-24 round-12 T-fix: clearReportRequest — direct UPDATE that
      // actually sets `report_requested_at = NULL`. The heartbeat UPSERT's
      // COALESCE-preserve path correctly handles "absent" / "value" but
      // cannot express "explicit clear" (a `null` bind would preserve).
      // Round-12 agents ack a "report now" request by forwarding the body
      // field as `null`; this UPDATE overrides the column. Caller binds
      // [agentId].
      clearReportRequest: (agentId) =>
        `UPDATE ad_agent_heartbeat
            SET report_requested_at = NULL
          WHERE agent_id = ?`,
      // 2026-08-24 round-12 T6: read back report_requested_at for a single
      // agent so the heartbeat handler can attach reportRequested: boolean
      // to its response. Narrow projection (single column, single row) so
      // the per-heartbeat cost is trivial. Caller binds [agentId].
      readReportRequestedAt:
        `SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-25: cold-start probe — read existing row's last_heartbeat_at
      // BEFORE this heartbeat's upsert so the route can detect a restart
      // (>5min gap) and wipe any stale report_requested_at that the
      // previous process didn't get to consume. Caller binds [agentId].
      readLastHeartbeatAt:
        `SELECT last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-31 R75: DC-online check at queue time. Returns one row
      // when the agent heartbeated within the last 5 minutes (the
      // "currently online" threshold per spec §2.5), else zero rows.
      // Caller binds [agentId].
      dcOnlineCheck:
        `SELECT last_heartbeat_at FROM ad_agent_heartbeat
          WHERE agent_id = ?
            AND last_heartbeat_at >= UTC_TIMESTAMP() - INTERVAL 5 MINUTE`,
      // 2026-08-28 round-58: cold-start auto-trigger helper. After a delete
      // (or first heartbeat ever), the heartbeat row refills via UPSERT but
      // ad_replication_status stays empty until the natural report cycle
      // runs (15min+). The heartbeat handler uses this COUNT to decide
      // whether to auto-trigger a fresh report-now request so the report
      // table refills within 1-2 minutes instead of 15+. Returns 0 when
      // the table has no rows for this agent (post-delete or new agent).
      // Caller binds [agentId].
      hasAnyReplicationRows: (agentId) =>
        `SELECT COUNT(*) AS cnt FROM ad_replication_status WHERE agent_id = ?`,
      reportSummaryFor: (agentId, sinceIso) =>
        `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
         FROM ad_replication_status s
         INNER JOIN (
           SELECT MAX(collected_at) AS max_collected
           FROM ad_replication_status
           WHERE agent_id = ? AND collected_at >= ?
         ) m ON s.collected_at = m.max_collected AND s.agent_id = ?
         ORDER BY s.source_dc, s.dest_dc`,
      // 2026-08-26 round-15: latest-failed-row lookup for the dashboard's
      // "错误摘要" column. Scoped to the same 1-hour lookback the dashboard
      // already uses for status, so the operator sees the most recent
      // failure within the window that drove `fail_count > 0`. Single
      // row, no params for the timestamp (UTC_TIMESTAMP() is fine here —
      // the service calls this only when fail_count > 0 in the 1-hour
      // window, so the row that comes back is guaranteed to be in that
      // window). Uses UTC_TIMESTAMP() to match the storage convention
      // (collected_at rows are written via toMysqlDatetime with UTC
      // components — see agentsList/dcsList hot-fix comment for details).
      latestFailureFor: (agentId) =>
        // 2026-08-27 round-39: lookup window now matches the count window
        // (today, since midnight UTC) so the error message shown is the
        // one that contributed to today's fail_count — not a stale error
        // from yesterday when today's count is 0.
        `SELECT source_dc, dest_dc, error_message, collected_at
         FROM ad_replication_status
         WHERE agent_id = ? AND status_code <> 0
           AND collected_at >= DATE(UTC_TIMESTAMP())
         ORDER BY collected_at DESC, source_dc, dest_dc
         LIMIT 1`,
      latestReportEntries: (agentId, sinceIso, limit) =>
        // 2026-09-25 R93.11: tighten read-back to match the matrix /all
        // contract — exclude the synthetic META / __dc_summary__ rows
        // collected-replication.ps1 emits when AD module enumeration fails
        // (`source_dc='*' dest_dc='*' naming_context='META'`), and apply
        // the same 30-minute freshness floor the dashboard uses so a
        // stopped agent doesn't keep returning its last cached snapshot
        // indefinitely. The `since` arg stays as a defense-in-depth lower
        // bound (24h lookback) on top of the UTC clock gate.
        `SELECT collected_at, source_dc, dest_dc, source_site, dest_site, naming_context,
                status_code, error_message, last_success_time, last_attempt_time
         FROM ad_replication_status
         WHERE agent_id = ?
           AND naming_context NOT IN ('__dc_summary__', 'META')
           AND collected_at >= UTC_TIMESTAMP() - INTERVAL 30 MINUTE
           AND collected_at = (
             SELECT MAX(collected_at) FROM ad_replication_status
             WHERE agent_id = ? AND collected_at >= ?
               AND naming_context NOT IN ('__dc_summary__', 'META')
           )
         ORDER BY source_dc, dest_dc
         LIMIT ${Number(limit)}`,
      // 2026-08-26 round-19+: heartbeat-table delete buttons. The operator
      // removes a row when a host is decommissioned; cascades through
      // ad_replication_status (both source_dc and dest_dc matches) so the
      // report table doesn't keep orphans referencing the deleted agent.
      // Each DELETE is a single statement with one bind so affectedRows
      // reflects exactly that table's contribution.
      deleteHeartbeatRow: (agentId) =>
        `DELETE FROM ad_agent_heartbeat WHERE agent_id = ?`,
      deleteReplicationBySource: (agentId) =>
        `DELETE FROM ad_replication_status WHERE source_dc = ?`,
      deleteReplicationByDest: (agentId) =>
        `DELETE FROM ad_replication_status WHERE dest_dc = ?`,
      deletePackageRuns: (agentId) =>
        `DELETE FROM package_runs WHERE agent_id = ?`,
      // DC-tab delete — remove the ad_dcs row only. The DC list is a
      // separate surface from the heartbeat table; deleting a DC leaves
      // the heartbeat row intact (a host can stay in the heartbeat view
      // even if it's no longer classified as a DC).
      deleteDcRow: (dcName) =>
        `DELETE FROM ad_dcs WHERE dc_name = ?`,
      // R158.79 (2026-10-12) — MemberServer heartbeat tab. 3 helper
      //   平行 agentsList / dcsList (同 family heartbeat). memberUpsert
      //   走 routes/agent.js:608-614 + 649-655 (跟 touchLastSeen 同
      //   precedent, best-effort try/catch). membersList 跟 dcsList 平行
      //   LEFT JOIN 改 ad_member_servers + ad_sites. deleteMemberRow
      //   单 DELETE (member-server 没 cross-table cascade).
      memberUpsert: memberHeartbeat.mysql.upsert,
      membersList: memberHeartbeat.mysql.membersList,
      deleteMemberRow: memberHeartbeat.mysql.deleteMemberRow
    },
    ports: {
      list: 'SELECT id, port, label, sort_order AS sortOrder FROM system_ports ORDER BY sort_order, port',
      listForAgent: `SELECT sp.port, sp.label, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt
        FROM system_ports sp
        INNER JOIN ad_agent_port_status aps ON aps.port = sp.port AND aps.agent_id = ?
        ORDER BY sp.sort_order, sp.port`,
      create: 'INSERT INTO system_ports (port, label, sort_order) VALUES (?, ?, ?)',
      findByPort: 'SELECT id FROM system_ports WHERE port = ?',
      updatePartial: (fields) => `UPDATE system_ports SET ${fields.join(', ')} WHERE id = ?`,
      delete: 'DELETE FROM system_ports WHERE id = ?'
    },
    portStatus: {
      // Single-row upsert; called in a loop inside a transaction. MySQL flavor.
      upsertOne: `INSERT INTO ad_agent_port_status
        (agent_id, port, ok, latency_ms, last_checked_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ok = VALUES(ok),
          latency_ms = VALUES(latency_ms),
          last_checked_at = VALUES(last_checked_at)`,
      listForAgents: (placeholders) => `SELECT aps.agent_id AS agentId, aps.port, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt,
               sp.label AS label
        FROM ad_agent_port_status aps
        INNER JOIN system_ports sp ON aps.port = sp.port
        WHERE aps.agent_id IN (${placeholders})
        ORDER BY sp.sort_order, sp.port`
    },
    // R66 split: installed_packages -> package_scripts + package_policies.
    // package_scripts holds script content + sha256 + manifest (migration 023).
    // The legacy db.sql.installedPackages SQL string registry was retired in
    // T14 — migration 023 drops the table itself, so no live caller remains.
    packageScripts: {
      upsert: `INSERT INTO package_scripts
        (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          version = VALUES(version),
          script_content = VALUES(script_content),
          script_sha256 = VALUES(script_sha256),
          manifest_json = VALUES(manifest_json),
          source = VALUES(source),
          updated_at = VALUES(updated_at)`,
      list: `SELECT * FROM package_scripts ORDER BY name`,
      get: `SELECT * FROM package_scripts WHERE name = ?`,
      delete: `DELETE FROM package_scripts WHERE name = ?`,
      updateScript: `UPDATE package_scripts SET script_content = ?, script_sha256 = ?, updated_at = ? WHERE name = ?`,
      // T14: JOIN helper for the cross-package agent view. Used by
      // routes/agent-packages.js to replace db.sql.installedPackages.listEnabled.
      // Filter on package_policies.enabled=1 so the agent never sees a
      // disabled package — matches runner.js JOIN_SELECT_MYSQL.
      listEnabledGlobal: `SELECT ps.name, ps.version, ps.script_sha256, ps.manifest_json,
                                 pp.interval_sec, pp.timeout_ms, pp.enabled, pp.params_json,
                                 ps.source, ps.created_at, ps.updated_at
                          FROM package_scripts ps
                          INNER JOIN package_policies pp ON ps.name = pp.name
                          WHERE pp.enabled = 1
                          ORDER BY ps.name`
    },
    // R152 — append-only publish history. Dual-write from script-service
    // installScript / editScript. Reads by name are exposed via
    // GET /api/admin/packages/:name/history. (name, version, script_sha256)
    // UNIQUE makes INSERT IGNORE on MySQL idempotent; on MSSQL we guard
    // with a SELECT first because there's no INSERT IGNORE.
    packageScriptsHistory: {
      insert:      packageScriptsHistorySql.insert,
      existsMssql: packageScriptsHistorySql.existsMssql,
      listByName:  packageScriptsHistorySql.listByName
    },
    // R66 split: package_policies holds execution policy (migration 023).
    // Five ops: upsert (by name) / list / listEnabled / getByName / delete.
    // updatePartial is exposed via the helper in center/src/db/sql/package-policies.js
    // (db.execute is called directly because the SET clause is field-dependent).
    packagePolicies: {
      upsert: `INSERT INTO package_policies
        (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          interval_sec = VALUES(interval_sec),
          timeout_ms = VALUES(timeout_ms),
          enabled = VALUES(enabled),
          params_json = VALUES(params_json),
          scope = VALUES(scope),
          updated_at = VALUES(updated_at)`,
      list: `SELECT * FROM package_policies ORDER BY name`,
      listEnabled: `SELECT * FROM package_policies WHERE enabled = 1 ORDER BY name`,
      getByName: `SELECT * FROM package_policies WHERE name = ?`,
      delete: `DELETE FROM package_policies WHERE name = ?`
    },
    // Drop-failure tracking (migration 013). Records pkg_<name> schemas
    // left behind when DROP SCHEMA fails (FKs, perms, transient DB errors)
    // so admin can manually clean up. T7 writes, T10 reads+deletes,
    // T12 renders.
    orphanSchemas: {
      upsert: `INSERT INTO orphan_schemas (name, last_seen_at, note)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          last_seen_at = VALUES(last_seen_at),
          note = VALUES(note)`,
      list: `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`,
      delete: `DELETE FROM orphan_schemas WHERE name = ?`
    },
    metricGauge: {
      upsertLatest: `INSERT INTO metric_gauge
        (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ts = VALUES(ts),
          value = VALUES(value),
          unit = VALUES(unit),
          threshold_warn = VALUES(threshold_warn),
          threshold_crit = VALUES(threshold_crit)`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_gauge WHERE agent_id = ?`
    },
    metricCounter: {
      upsertLatest: `INSERT INTO metric_counter
        (agent_id, metric_id, ts, value, delta, unit)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ts = VALUES(ts),
          value = VALUES(value),
          delta = VALUES(delta),
          unit = VALUES(unit)`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_counter WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_counter WHERE agent_id = ?`
    },
    metricTimeseries: {
      append: `INSERT INTO metric_timeseries
        (agent_id, metric_id, ts, value, tags_json, unit)
        VALUES (?, ?, ?, ?, ?, ?)`,
      // Range query (agent_id + metric_id required; from/to optional).
      // The caller pushes params in order: [agent_id, metric_id, from?, to?].
      list: (includeRange) => {
        const where = ['agent_id = ?', 'metric_id = ?'];
        if (includeRange?.from) where.push('ts >= ?');
        if (includeRange?.to) where.push('ts <= ?');
        return `SELECT * FROM metric_timeseries WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
      }
    },
    metricStatus: {
      upsertLatest: `INSERT INTO metric_status
        (agent_id, metric_id, ts, status, message)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          ts = VALUES(ts),
          status = VALUES(status),
          message = VALUES(message)`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_status WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_status WHERE agent_id = ?`
    },
    packageRuns: {
      insert: `INSERT INTO package_runs
        (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // listRecent is built dynamically per call (LIMIT is integer-only);
      // see center/src/db/sql/package-runs.js → packageRuns.listRecent.
      // R158.17.6 (2026-10-01) -- /api/dashboard/packages-runs summary aggregation.
      // GROUP BY package_name over a 24h window so a single query returns the
      // success/failure/partial counts + lastRunAt for every package. This was
      // the missing piece when ad_partner_inbound_discover alone consumes
      // 288k rows / 24h -- the previous `listRecent(limit=200)` snapshot was
      // 100% taken by that one package's runs, leaving the other 9 cards
      // with total=0 / no data. handler calls this once + then SELECT TOP 10
      // per package for the recent-runs table.
      //
      // R158.50.7g (2026-10-08) -- success/partial now split by status column.
      // Pre-fix `partial` counted `exit_code IS NULL` (process exit unknown —
      // a separate concept) and `success` counted ANY exit_code=0 row, which
      // masked PS1 partial-failure fingerprints (exit_code=0 + metrics
      // .error_code>0 → status='partial'). After R158.50.6 promoted PS1 stderr
      // headers into the `error` column, every ad_lockout_list run with 0
      // events in the 15-min window was status='failed' yet exit_code=0,
      // which the prior `success = exit_code=0` logic counted as success.
      // Post-fix: success requires BOTH exit_code=0 AND status='success'
      // (or status NULL = legacy), partial = exit_code=0 AND status='partial',
      // failure unchanged (exit_code<>0 — process actually crashed).
      summary24hByName: `SELECT package_name,
                              COUNT(*) AS total,
                              SUM(CASE WHEN exit_code = 0 AND (status = 'success' OR status IS NULL) THEN 1 ELSE 0 END) AS success,
                              SUM(CASE WHEN exit_code = 0 AND status = 'partial' THEN 1 ELSE 0 END) AS partial,
                              SUM(CASE WHEN exit_code IS NOT NULL AND exit_code <> 0 THEN 1 ELSE 0 END) AS failure,
                              MAX(started_at) AS last_run_at
                         FROM package_runs
                        WHERE started_at >= ?
                          AND agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
                        GROUP BY package_name`,
      // R158.99.3 (2026-10-13) — MEMBER-side mirror of summary24hByName.
      // Filter flipped from NOT IN (AD-side, exclude member) to IN
      // (member-side, only include member). Used by
      // /api/dashboard/member-packages-runs (member UI). The agent-side
      // `ad_member_heartbeat` table is the source of truth for which
      // agents are member-servers (R158.74/R158.86 registration path);
      // AD endpoints use NOT IN to keep DC-only views clean, member
      // endpoints use IN to keep member-only views clean. Same package_runs
      // table, two opposite filter directions, two SQL helper names.
      memberSummary24hByName: `SELECT package_name,
                              COUNT(*) AS total,
                              SUM(CASE WHEN exit_code = 0 AND (status = 'success' OR status IS NULL) THEN 1 ELSE 0 END) AS success,
                              SUM(CASE WHEN exit_code = 0 AND status = 'partial' THEN 1 ELSE 0 END) AS partial,
                              SUM(CASE WHEN exit_code IS NOT NULL AND exit_code <> 0 THEN 1 ELSE 0 END) AS failure,
                              MAX(started_at) AS last_run_at
                         FROM package_runs
                        WHERE started_at >= ?
                          AND agent_id IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
                        GROUP BY package_name`,
      // R158.99.3 — recent member-side runs. Same IN filter direction
      // as memberSummary24hByName. MySQL LIMIT <int> at end; the
      // mssql mirror below uses TOP <int> after SELECT per R158.17.6
      // (T-SQL position rule).
      memberRecentByName: (limit, since) => `SELECT * FROM package_runs WHERE package_name = ? AND started_at >= ? AND agent_id IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(1000, parseInt(limit, 10) || 10))}`,
      // 2026-10-20 perf — batched variant. Caller used to call recentByName
      //   N times in a for-loop (one query per package, typically 10–14).
      //   On /api/dashboard/packages-runs the call counted in timeline
      //   mode was 14 round-trips × ~115ms each ≈ 1.6s. Single query now
      //   returns the same shape for all N packages at once. SQL uses
      //   inlined (?, ?, …) placeholders because the drivers do not
      //   natively expand bind arrays.
      //
      // R161.5 (2026-10-26) — MySQL 5.7 兼容化. 原写法是
      //   `WITH ranked AS (... ROW_NUMBER() OVER (PARTITION BY ...))`:
      //   CTE 是 8.0+ 语法, 窗口函数是 8.0.2+ 语法 ⇒ 操作员真库 (5.7.44)
      //   上整条 SQL 报 ER_PARSE_ERROR ⇒ /api/dashboard/packages-runs 500.
      //   5.7 既没有 CTE 也没有 window function ⇒ 改成 "每个包一个带 LIMIT
      //   的派生表, UNION ALL 串起来": 1 次 round-trip 拿完 N 个包 (相对改造
      //   前的 N 次 round-trip 少 N-1 次网络往返), 每个包内部仍是
      //   ORDER BY started_at DESC LIMIT n ⇒ 与原版逐字等价 (同包内按
      //   started_at DESC 取前 n 条, 全局按 package_name 排)。
      //   性能注记: package_runs 只有 (agent_id, package_name, started_at)
      //   索引, 没有 package_name 前导索引 ⇒ 每个子查询是一次过滤扫描。
      //   若日后 package_runs 体量上来, 应补 (package_name, started_at)
      //   索引 —— 但那要走 db/migrations 迁移, 不能手改已冻结的 baseline。
      recentByNames: (names, limit, since) => {
        const n = Array.isArray(names) ? names : [names];
        const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
        const parts = n.map(() =>
          `(SELECT package_name, id, agent_id, started_at, finished_at, exit_code, status
              FROM package_runs
             WHERE package_name = ?
               AND started_at >= ?
               AND agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
             ORDER BY started_at DESC
             LIMIT ${safeLimit})`
        );
        const params = [];
        for (const name of n) params.push(name, since);
        return { sql: parts.join('\nUNION ALL\n'), params };
      },
      memberRecentByNames: (names, limit, since) => {
        const n = Array.isArray(names) ? names : [names];
        const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
        const parts = n.map(() =>
          `(SELECT package_name, id, agent_id, started_at, finished_at, exit_code, status
              FROM package_runs
             WHERE package_name = ?
               AND started_at >= ?
               AND agent_id IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
             ORDER BY started_at DESC
             LIMIT ${safeLimit})`
        );
        const params = [];
        for (const name of n) params.push(name, since);
        return { sql: parts.join('\nUNION ALL\n'), params };
      },
      // R158.19 (2026-10-01) -- package_runs retention purge. Caller resolves
      // cutoffIso (now - retentionDays) in JS so SQL is portable. Hourly cron
      // (createPackageRunsRetentionLoop) reads package_runs_retention_days
      // from system_config so operators can tune retention without restarting.
      // Per audit_retention_days precedent (audit.js): default 10 days, 0 = disabled.
      purgeOlderThan: 'DELETE FROM package_runs WHERE started_at < ?'
    },
    lockout: {
      // R158.31: was `target_user_description` (R139 / R139.1, AD `description`
      // 属性). Operator 2026-10-02 反馈「描述」列实际应为 AD `displayName`
      // (中文姓名 / 展示名). 列名 + wire shape 全栈 rename: DB column
      // target_user_description → target_user_display_name, agent PS1 字段
      // TargetUserDescription → TargetUserDisplayName, Get-ADUser
      // -Properties description → -Properties displayName. service BIND_ORDER
      // 第 7 槽对应同步 (centre/src/services/lockout.js).
      upsertEvent: `INSERT INTO ad_lockout_events
        (occurred_at, collected_at, agent_id, dc_name, event_record_id,
         target_user_name, target_user_display_name,
         subject_user_name, subject_domain, caller_computer_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at)`,
      search: `SELECT occurred_at, dc_name, target_user_name, target_user_display_name,
                      subject_user_name, subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= ?
                  AND (? = '' OR target_user_name = ?)
                  AND (? = '' OR dc_name = ?)
                  AND (? = '' OR caller_computer_name = ?)
                ORDER BY occurred_at ASC
                LIMIT 500`,
      // R131 — latest lockout events list, no per-event filter required.
      // Drives the new /lockout-accounts frontend sidebar page (operator
      // directive 2026-09-27 "在前台增加一个sidebar 菜单，增加一个锁定
      // 账户信息"). Result shape mirrors `search` minus `isSource`:
      // { occurred_at, dc_name, target_user_name, target_user_display_name,
      //   subject_user_name, subject_domain, caller_computer_name }.
      // ORDER BY occurred_at DESC LIMIT N — newest first, just like the
      // table the page renders. R158.31 renamed target_user_description
      // → target_user_display_name so the column matches the AD attribute
      // (`displayName`) the agent now stamps.
      // R158.109.b (2026-10-16) — server-paged 24h list. 加 ? OFFSET ? 走
      // LIMIT ? OFFSET ?, 3rd bind = offset. sinceHours 服务端 pin = 24
      // (跟操作员 directive "列表为24小时窗口期" 1:1, 1 page = 50 行,
      // 1:1 平行 R158.108/109.a 0 改 hourly 旧行为).
      recent: `SELECT occurred_at, dc_name, target_user_name, target_user_display_name,
                      subject_user_name, subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= (NOW() - INTERVAL ? HOUR)
                ORDER BY occurred_at DESC
                LIMIT ? OFFSET ?`,
      // R158.53 (2026-10-08) — 24h hourly event-log trend for the
      // /lockout-accounts line chart. Top-5 by 24h COUNT(*) DESC;
      // ?dc= override → single DC only. Event log source (operator
      // decision post-R158.50.7n: ad_lockout_events is the event log
      // the detail table below the chart also reads). Reuses the
      // failedLogon.hourlyAggregate GROUP BY hour-bucket idiom (line
      // 1201) so bucket boundaries line up across /lockout-accounts
      // and /failed-logon-2h. R158.50.7e SQL 兜底过滤 — target_user_name
      // NOT LIKE '%$' 排除机器账户 (DB 层双保险, 即便老 PS1 1.0.3
      // 还在跑, chart 也不污染).
      trend24h: ({ dc = null, topN = 5 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`lockout.trend24h: topN must be int in [1,20], got ${topN}`);
        }
        if (dc == null) {
          // TOP-N PATH: 先 24h COUNT per agent 排序取 topN, 再 GROUP BY hour.
          //
          // R161.5 (2026-10-26) — MySQL 5.7 兼容化. 原写法是两级 CTE
          // (`WITH top_agents AS (...), hourly AS (...)`); CTE 是 MySQL 8.0+
          // 语法 ⇒ 操作员真库 (5.7.44) 上整条 SQL 报 ER_PARSE_ERROR ⇒
          // /lockout-accounts 的 24h 折线图 500. 5.7 没有 CTE ⇒ top_agents
          // 降级成 FROM 里的派生表 (INNER JOIN), hourly 直接内联成外层的
          // GROUP BY —— 语义与原版逐字等价: 同样的 topN 集合 (同样的
          // ORDER BY COUNT(*) DESC LIMIT n)、同样的 bucket 边界、同样的排序。
          // 占位符顺序不变: 派生表在 FROM 子句里文本位置更靠前 ⇒ params
          // 仍是 [24, topN, 24]。
          const sql =
            `SELECT e.agent_id,
                      DATE_FORMAT(e.occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                      COUNT(*) AS event_count
                 FROM ad_lockout_events e
                 INNER JOIN (
                   SELECT agent_id
                     FROM ad_lockout_events
                    WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                      AND target_user_name NOT LIKE '%$'
                    GROUP BY agent_id
                    ORDER BY COUNT(*) DESC
                    LIMIT ?
                 ) ta ON ta.agent_id = e.agent_id
                WHERE e.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                  AND e.target_user_name NOT LIKE '%$'
                GROUP BY e.agent_id, bucket_start
              ORDER BY e.agent_id ASC, bucket_start ASC`;
          return { sql, params: [24, topN, 24] };
        }
        // SINGLE-DC PATH
        const sql =
          `SELECT agent_id,
                  DATE_FORMAT(occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_lockout_events
            WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
              AND agent_id = ?
              AND target_user_name NOT LIKE '%$'
            GROUP BY agent_id, bucket_start
            ORDER BY bucket_start ASC`;
        return { sql, params: [24, dc] };
      },
      // R158.109.b (2026-10-16) — daily aggregate for /lockout-accounts
      // 7d/全部 toggle. 跟 trend24h 1:1 平行, 改 INTERVAL ? HOUR → DAY,
      // DATE_FORMAT bucket 改 '%Y-%m-%d %H:00:00' → '%Y-%m-%d 00:00:00'.
      // 跟 R158.109.a failedLogon.dailyAggregate (line 1713) + R158.108
      // eventlog.dailyAggregate (line 2072) 范式 1:1 平行. machine account
      // 兜底 (R158.50.7e) 0 改. windowDays ∈ [1, 365] hard cap (跟
      // ad_mgmt_retention_days=0=永久 1:1 平行).
      dailyAggregate: ({ dc = null, topN = 5, windowDays = 7 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`lockout.dailyAggregate: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
          throw new Error(`lockout.dailyAggregate: windowDays must be int in [1,365], got ${windowDays}`);
        }
        if (dc == null) {
          // TOP-N PATH — 跟 trend24h 1:1 平行, bucket 改 DAY + daily DATE_FORMAT
          //
          // R161.5 (2026-10-26) — MySQL 5.7 兼容化, 跟 trend24h 1:1 平行:
          // 两级 CTE (`WITH top_agents ..., daily ...`) → top_agents 降级成
          // 派生表 + daily 内联成外层 GROUP BY。CTE 是 8.0+ 语法, 操作员真库
          // (5.7.44) 会报 ER_PARSE_ERROR。占位符顺序不变 ⇒ params 仍是
          // [windowDays, topN, windowDays]。
          const sql =
            `SELECT e.agent_id,
                      DATE_FORMAT(e.occurred_at, '%Y-%m-%d 00:00:00') AS bucket_start,
                      COUNT(*) AS event_count
                 FROM ad_lockout_events e
                 INNER JOIN (
                   SELECT agent_id
                     FROM ad_lockout_events
                    WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
                      AND target_user_name NOT LIKE '%$'
                    GROUP BY agent_id
                    ORDER BY COUNT(*) DESC
                    LIMIT ?
                 ) ta ON ta.agent_id = e.agent_id
                WHERE e.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
                  AND e.target_user_name NOT LIKE '%$'
                GROUP BY e.agent_id, bucket_start
              ORDER BY e.agent_id ASC, bucket_start ASC`;
          return { sql, params: [windowDays, topN, windowDays] };
        }
        // SINGLE-DC PATH
        const sql =
          `SELECT agent_id,
                  DATE_FORMAT(occurred_at, '%Y-%m-%d 00:00:00') AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_lockout_events
            WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
              AND agent_id = ?
              AND target_user_name NOT LIKE '%$'
            GROUP BY agent_id, bucket_start
            ORDER BY bucket_start ASC`;
        return { sql, params: [windowDays, dc] };
      },
      // R158.X.99.35 (2026-10-20) — lockout chart trendByBucketMinutes
      // (MySQL). 1:1 平行 eventlog.trendByBucketMinutes (sql.js:2570),
      // 唯一区别 GROUP BY agent_id (替 channel, lockout 维度) + 复用
      // trend24h 的 `WITH top_agents AS (...)` topN=5 CTE 范式 (跟
      // sql.js:1773 trend24h MySQL 1:1). bucket 边界走 `occurred_at`
      // 不是 collected_at (操作员 directive "按锁定时间展现" 1:1).
      // 24h 走 5min bucket (288 段), 7d 走 4h bucket (42 段). 全部仍
      // dailyAggregate (R158.109.b 行为 1:1 保留). machine account
      // 兜底 (R158.50.7e) NOT LIKE '%$' 保留. R158.86 probe + R158.111
      // nssm restart 必跑. lesson 123/124 (chart 3-mode 平行 eventlog
      // 范式, GROUP BY 维度差异 → 加新 helper 不复用 channel 那条).
      trendByBucketMinutes: ({ dc = null, topN = 5, hours = 24, bucketMinutes = 5 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`lockout.trendByBucketMinutes: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error(`lockout.trendByBucketMinutes: hours must be int in [1,168], got ${hours}`);
        }
        // R158.X.99.35 — whitelist 跟 eventlog 1:1 (R158.X.99.34 扩 240
        // = 4h bucket for /lockout-accounts 7d bucket4h, 42 段).
        if (!Number.isInteger(bucketMinutes) || ![1, 5, 15, 30, 60, 240].includes(bucketMinutes)) {
          throw new Error(`lockout.trendByBucketMinutes: bucketMinutes must be one of [1,5,15,30,60,240], got ${bucketMinutes}`);
        }
        const secs = bucketMinutes * 60;
        if (dc == null) {
          // TOP-N PATH — 跟 trend24h 1:1 (sql.js:1773), bucket 边界替
          // floor 秒数 inline (因 bucket integer 必 inline 分组常量,
          // hours 走 ? placeholder 单值单 filter). shape 跟
          // dailyAggregate (sql.js:1824) 1:1, 仅 INTERVAL 替 DAY → HOUR.
          //
          // R161.5 (2026-10-26) — MySQL 5.7 兼容化, 跟 trend24h/dailyAggregate
          // 1:1 平行: 两级 CTE (`WITH top_agents ..., bucketed ...`) →
          // top_agents 降级成派生表 + bucketed 内联成外层 GROUP BY。
          // bucket 表达式不变 (FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(...)/s)*s)),
          // 因为它本来就是 GROUP BY 的可重复表达式, 不依赖 CTE。
          const sql =
            `SELECT e.agent_id,
                      FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(e.occurred_at) / ${secs}) * ${secs}) AS bucket_start,
                      COUNT(*) AS event_count
                 FROM ad_lockout_events e
                 INNER JOIN (
                   SELECT agent_id
                     FROM ad_lockout_events
                    WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                      AND target_user_name NOT LIKE '%$'
                    GROUP BY agent_id
                    ORDER BY COUNT(*) DESC
                    LIMIT ?
                 ) ta ON ta.agent_id = e.agent_id
                WHERE e.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                  AND e.target_user_name NOT LIKE '%$'
                GROUP BY e.agent_id, bucket_start
              ORDER BY e.agent_id ASC, bucket_start ASC`;
          return { sql, params: [hours, topN, hours] };
        }
        // SINGLE-DC PATH
        const sql =
          `SELECT agent_id,
                  FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(occurred_at) / ${secs}) * ${secs}) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_lockout_events
            WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
              AND agent_id = ?
              AND target_user_name NOT LIKE '%$'
            GROUP BY agent_id, FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(occurred_at) / ${secs}) * ${secs})
            ORDER BY bucket_start ASC`;
        return { sql, params: [hours, dc] };
      },
      // R158.64 (2026-10-10) — top-N user aggregate for daily/weekly report
      // (reports.js fetchLockoutSection). 跟 failedLogon.topByUserWithDisplay
      // (line 1440) 同 shape, 字段名 lockout_count / last_lockout_at, 同样
      // NOT LIKE '%$' + <> '' 双保险. lockout_events 没有 R158.50.7e 机器账
      // 户问题 (4740 来自 PDC authoritative source, 不会有机器账户 $ 结
      // 尾), 但统一 SQL 防御性不亏.
      topByUserWithDisplay: ({ sinceHours = 24, topN = 50, dcName = null, search = null } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 200) {
          throw new Error(`lockout.topByUserWithDisplay: topN must be int in [1,200], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`lockout.topByUserWithDisplay: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        // R158.111 (2026-10-16) — 加 dcName 可选 filter + search 前缀模糊
        //   搜 sam/display_name (LIKE 'q%' 走索引). 两者都默认 null → 0 改
        //   老行为 (R158.64 reports.js caller).
        const clauses = ['occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)',
                         "target_user_name NOT LIKE '%$'",
                         "target_user_name <> ''"];
        const params = [sinceHours];
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push("(target_user_name LIKE ? OR COALESCE(target_user_display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        // ⚠ LIMIT 属尾部子句, 0 进 WHERE clauses (同 failedLogon.aggregateByDc).
        const sql =
          `SELECT target_user_name AS sam,
                  COALESCE(MAX(target_user_display_name), '') AS display_name,
                  COUNT(*) AS lockout_count,
                  MAX(occurred_at) AS last_lockout_at,
                  COUNT(DISTINCT dc_name) AS dc_count,
                  GROUP_CONCAT(dc_name ORDER BY dc_name SEPARATOR ',') AS dc_name_list
             FROM ad_lockout_events
            WHERE ${clauses.join(' AND ')}
            GROUP BY target_user_name
            ORDER BY lockout_count DESC, sam ASC
            LIMIT ?`;
        params.push(topN);
        return { sql, params };
      },
      // R158.111.a (2026-10-16) — 锁定账户 raw event list, 流水不过滤.
      //   跟 lockout.topByUserWithDisplay (R158.65/R158.111 加 4 参数)
      //   范式 1:1 平行 (4 caller params), 但返 raw row, 0 GROUP BY
      //   0 topN. 0 过滤 machine account `NOT LIKE '%$'` (用户 directive
      //   "不接受数据的筛选, 按照流水显示, 不过滤"). 0 过滤空 sam. 走 ORDER BY
      //   occurred_at DESC (新→旧) + LIMIT/OFFSET 分页.
      //   sinceHours=NULL = 物理全量 (不限定时间窗), sinceHours>0 = 限定
      //   sinceHours 小时内 (跟 topByUserWithDisplay 1:1 平行). 跟 R158.65
      //   cap [1,168] 1:1 平行, 0 改老 helper.
      listAll: ({ sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}) => {
        if (limit < 1 || limit > 500) {
          throw new Error(`lockout.listAll: limit must be in [1,500], got ${limit}`);
        }
        if (offset < 0) {
          throw new Error(`lockout.listAll: offset must be >= 0, got ${offset}`);
        }
        if (sinceHours !== null && (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168)) {
          throw new Error(`lockout.listAll: sinceHours must be null or int in [1,168], got ${sinceHours}`);
        }
        const clauses = [];
        const params = [];
        if (sinceHours !== null) {
          clauses.push('occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)');
          params.push(sinceHours);
        }
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push("(target_user_name LIKE ? OR COALESCE(target_user_display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        // LIMIT/OFFSET 必加在 WHERE 后, bind 顺序最末.
        params.push(limit, offset);
        const sql =
          `SELECT dc_name,
                  target_user_name,
                  COALESCE(target_user_display_name, '') AS target_user_display_name,
                  COALESCE(NULLIF(caller_computer_name, ''), '') AS caller_computer_name,
                  4740 AS event_id,
                  occurred_at
             FROM ad_lockout_events
            ${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY occurred_at DESC
            LIMIT ? OFFSET ?`;
        return { sql, params };
      },
      // R158.1W.3 (2026-10-16) — 账户锁定分布图 (ad_lockout_events, 4740 事件).
      //   1:1 平行 failedLogon.accountWorkstationLinks (sql.js:1995) — 字段映射:
      //     ad_failed_logon_events → ad_lockout_events
      //     workstation_name → caller_computer_name (R158.1W.3 关键差异)
      //     target_user_name → target_user_name (1:1)
      //     dc_name → dc_name (1:1)
      //   1:1 平行 MSSQL 段 lockout.accountWorkstationLinks (sql.js:~4726 紧跟
      //   topByUserWithDisplay 之后). 0 改 schema / 0 改 agent / 0 改 ETL.
      accountWorkstationLinks: ({ sinceHours = 168, minStations = 1, limit = 200 } = {}) => {
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`lockout.accountWorkstationLinks: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        if (!Number.isInteger(minStations) || minStations < 1 || minStations > 50) {
          throw new Error(`lockout.accountWorkstationLinks: minStations must be int in [1,50], got ${minStations}`);
        }
        if (!Number.isInteger(limit) || limit < 10 || limit > 500) {
          throw new Error(`lockout.accountWorkstationLinks: limit must be int in [10,500], got ${limit}`);
        }
        // R161.5 (2026-10-26) — MySQL 5.7 兼容化. 原写法是两级 CTE
        // (`WITH edges AS (...), user_summary AS (...)`); CTE 是 MySQL 8.0+
        // 语法 ⇒ 操作员真库 (5.7.44) 上 ER_PARSE_ERROR.
        //
        // 5.7 没有 CTE ⇒ edges 降级成 FROM 里的派生表。但 edges 被引用了
        // **两次** (外层输出 + user_summary 的输入), 所以它的定义体要出现
        // 两次 —— 用一个 JS 片段常量拼两次, 避免手抄两份漂移 (两份一旦漂移,
        // 外层与内层的 GROUP BY 口径就会不一致 ⇒ 静默错数, 且很难发现)。
        //
        // 另外把 dc_list 那个相关子查询从 edges 内部**提到外层 SELECT**:
        //   · edges 内部的相关子查询引用了分组表达式 (LOWER(target_user_name) /
        //     NULLIF(TRIM(caller_computer_name),'')) 而非分组列本身 ⇒ 在
        //     ONLY_FULL_GROUP_BY (MySQL 5.7/8.0 默认开) 下会被判成
        //     "not in GROUP BY clause" 而报 ER_WRONG_FIELD_WITH_GROUP。
        //     提到外层后, 外层没有 GROUP BY, 这条约束不再适用。
        //   · 语义不变: 分组内的每一行在 LOWER(target_user_name) /
        //     NULLIF(TRIM(caller_computer_name),'') 上取值相同 ⇒ 用分组的
        //     代表行还是用分组的输出列, 相关条件等价。
        //   · 副产物: edges 体内从 2 个占位符降到 1 个 (dc_list 的那个搬到
        //     外层), 两份 edges 共 2 个 + 外层 1 个 + HAVING 1 个 + LIMIT 1 个
        //     = 5 个 ⇒ params 变成 [sinceHours ×3, minStations, limit]。
        const edgesBody = `
             SELECT
               LOWER(e.target_user_name) AS sam,
               NULLIF(TRIM(e.caller_computer_name), '') AS workstation,
               COUNT(*) AS event_count,
               MIN(e.occurred_at) AS first_seen,
               MAX(e.occurred_at) AS last_seen,
               COUNT(DISTINCT e.dc_name) AS dc_count
             FROM ad_lockout_events e
             WHERE e.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
               AND e.target_user_name NOT LIKE '%$'
               AND e.target_user_name <> ''
               AND NULLIF(TRIM(e.caller_computer_name), '') IS NOT NULL
             GROUP BY LOWER(e.target_user_name), NULLIF(TRIM(e.caller_computer_name), '')`;
        const sql =
          `SELECT ed.sam, ed.workstation, ed.event_count,
                  ed.first_seen, ed.last_seen, ed.dc_count,
                  (SELECT GROUP_CONCAT(DISTINCT e3.dc_name ORDER BY e3.dc_name SEPARATOR ',')
                     FROM ad_lockout_events e3
                    WHERE LOWER(e3.target_user_name) = ed.sam
                      AND IFNULL(NULLIF(TRIM(e3.caller_computer_name), ''), '') = IFNULL(ed.workstation, '')
                      AND e3.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)) AS dc_list,
                  s.station_count, s.total_count
             FROM (${edgesBody}
            ) ed
             JOIN (
               SELECT ed2.sam,
                      COUNT(DISTINCT ed2.workstation) AS station_count,
                      SUM(ed2.event_count) AS total_count
                 FROM (${edgesBody}
                ) ed2
                GROUP BY ed2.sam
               HAVING COUNT(DISTINCT ed2.workstation) >= ?
             ) s ON s.sam = ed.sam
            ORDER BY s.station_count DESC, ed.event_count DESC, ed.sam ASC, ed.workstation ASC
            LIMIT ?`;
        return { sql, params: [sinceHours, sinceHours, sinceHours, minStations, limit] };
      }
    },
    // R158.111 (2026-10-16) — 报表中心 read-only helpers (admin-only endpoints
    //   /api/report-center/*). 0 改 3 老 endpoint 既有 caller; 仅供 R158.110
    //   ship 后报表中心 dc-options 等加 filter 的 UI 选项.
    reportCenter: {
      // 活跃 DC 列表 — 给报表中心 3 张报表"按 DC 筛选"下拉用.
      //   ad_dcs 全表本身就是"已发现"集合 (R158.46 ship 写入),
      //   无 is_active 列, schema 仅 site_id / is_pdc / is_gc / ... 元数据.
      //   排序 is_pdc DESC 让 PDC 排首, 跟 ad_dc_overview DcCard 1:1 平行.
      dcOptions: () => {
        const sql =
          `SELECT dc_name, is_pdc, is_gc, is_bridgehead, discovered_at
             FROM ad_dcs
            ORDER BY is_pdc DESC, dc_name ASC`;
        return { sql, params: [] };
      }
    },
    // R158.50 — MySQL counterpart of mssql `failedLogon` block above.
    // 2026-10-19 R158.X.99.27 — mysql dialect enabled, 1:1 平行 mssql block.
    // Production 仍 mssql (appsettings.json:3), mysql path 仅作 future switch 备。
    // db/migrations/mysql/ 19 sibling 真存在 (1.0.0~1.0.19 1:1 平行 mssql)。
    failedLogon: {
      upsertEvent: `INSERT INTO ad_failed_logon_events
        (occurred_at, collected_at, agent_id, dc_name, event_record_id,
         target_user_name, target_user_display_name, target_domain_name,
         target_sid, subject_user_name, subject_domain_name,
         caller_computer_name, ip_address, ip_port, logon_type,
         logon_process_name, auth_package_name, failure_reason,
         status, workstation_name, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE collected_at = VALUES(collected_at)`,
      hourlyAggregate: `SELECT DATE_FORMAT(occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                               COUNT(*) AS event_count
                          FROM ad_failed_logon_events
                         WHERE occurred_at >= (NOW() - INTERVAL ? HOUR)
                           AND target_user_name NOT LIKE '%$'
                         GROUP BY bucket_start
                         ORDER BY bucket_start ASC`,
      // R158.109 (2026-10-16) — daily aggregate 跟 hourlyAggregate 1:1 平行.
      // 7d/全部 toggle 走 daily, 24h 走 hourly (R158.50 行为 0 改). 0 改 schema,
      // 0 改索引依赖. machine account 兜底 NOT LIKE '%$' 保留 (R158.50.7e 双保险).
      // days ∈ [1, 365] 跟 ad_mgmt_retention_days=0=永久 1:1 平行 (SQL 端 hard cap).
      dailyAggregate: ({ days = 7 } = {}) => {
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new Error(`failedLogon.dailyAggregate: days must be int in [1,365], got ${days}`);
        }
        return {
          sql: `SELECT DATE_FORMAT(occurred_at, '%Y-%m-%d') AS bucket_start,
                       COUNT(*) AS event_count
                  FROM ad_failed_logon_events
                 WHERE occurred_at >= (NOW() - INTERVAL ? DAY)
                   AND target_user_name NOT LIKE '%$'
                 GROUP BY bucket_start
                 ORDER BY bucket_start ASC`,
          params: [days]
        };
      },
      // R158.X.99.36 (2026-10-20) — /api/failed-logon/timeseries 24h bucket5m /
      // 7d bucket4h 粒度 (操作员 directive "密码错误监控也按照这种方式进行操作" +
      // "时间是事件触发时间" 1:1 平行 lockout R158.X.99.35 + eventlog
      // R158.X.99.33+.34 范式). 1:1 平行 lockout.trendByBucketMinutes MySQL
      // (sql.js:1871), **唯一区别**: account mode 是 single series global
      // count, 无 GROUP BY 维度 (不 agent_id 不 workstation_name 不 dc_name),
      // 无 `WITH top_agents` CTE (跟 lockout topN=5 不一样). bucketMinutes ∈
      // [1,5,15,30,60,240] whitelist 跟 R158.X.99.34 + R158.X.99.35 1:1.
      // bucket 边界走 `occurred_at` (不 collected_at, 操作员 directive
      // "事件触发时间" 1:1 平行 lockout R158.X.99.35). machine account 兜底
      // NOT LIKE '%$' 保留 (R158.50.7e 双保险). UTC_TIMESTAMP 跟 lockout 1:1.
      // 24h → bucketMinutes=5 (288 段), 7d → bucketMinutes=240 (42 段), 全部
      // 仍 dailyAggregate (R158.109 行为 1:1 保留). 0 改 hourlyAggregate /
      // dailyAggregate / recent / search / by-workstation / by-dc (R158.50.7n
      // "加宽 not replace" 范式). R158.111 nssm restart 必跑 + R158.86 24h
      // probe 必跑. lesson 125/127 (account mode = single series global count;
      // bucket 维度走 occurred_at 事件触发时间).
      trendByBucketMinutes: ({ hours = 24, bucketMinutes = 5 } = {}) => {
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error(`failedLogon.trendByBucketMinutes: hours must be int in [1,168], got ${hours}`);
        }
        // R158.X.99.36 — whitelist 跟 eventlog 1:1 (R158.X.99.34 扩 240 = 4h bucket).
        if (!Number.isInteger(bucketMinutes) || ![1, 5, 15, 30, 60, 240].includes(bucketMinutes)) {
          throw new Error(`failedLogon.trendByBucketMinutes: bucketMinutes must be one of [1,5,15,30,60,240], got ${bucketMinutes}`);
        }
        const secs = bucketMinutes * 60;
        const sql =
          `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(occurred_at) / ${secs}) * ${secs}) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events
            WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
              AND target_user_name NOT LIKE '%$'
            GROUP BY bucket_start
            ORDER BY bucket_start ASC`;
        return { sql, params: [hours] };
      },
      // R158.50.7e (2026-10-07) — 服务端兜底过滤 machine account ($ 结尾).
      // PS1 1.0.4 (即将 deploy) 也在源头 filter; 这个 SQL filter 是双保险,
      // 即便 PS1 还没下发到老 agent,UI 也不会再显示 KDL-XXX$ 行.
      // 防御性: 永远排除 target_user_name LIKE '%$' (Windows SAM 机器账户)
      // ⚠ bind 顺序: MySQL 是 [sinceHours, ..., limit], MSSQL 兄弟 (:5914/:5923)
      // 是 [limit, sinceHours, ...]. MySQL 语法强制 LIMIT 在 SELECT 尾部,
      // MSSQL 的 TOP (?) 必须在最前 —— 两者**无法**在文本上对齐, 所以调用方
      // (failed-logon.js:137 / :213) 必须按 db.dialect 分支传参.
      // 之前调用方固定按 MSSQL 顺序传 → MySQL 侧整体错位:
      //   `INTERVAL 200 HOUR ... LIMIT 24`, 且 search 的 `(? = '' OR dc_name = ?)`
      //   收到 200, 24 → `200 = ''` 恒假 → 静默返回空数组 (不报错).
      recent: `SELECT occurred_at, dc_name, target_user_name, target_user_display_name,
                       target_domain_name, subject_user_name, subject_domain_name,
                       caller_computer_name, ip_address, ip_port, logon_type,
                       logon_process_name, auth_package_name, failure_reason,
                       status, workstation_name
                  FROM ad_failed_logon_events
                 WHERE occurred_at >= (NOW() - INTERVAL ? HOUR)
                   AND target_user_name NOT LIKE '%$'
                 ORDER BY occurred_at DESC
                 LIMIT ?`,
      search: `SELECT occurred_at, dc_name, target_user_name, target_user_display_name,
                       target_domain_name, subject_user_name, subject_domain_name,
                       caller_computer_name, ip_address, ip_port, logon_type,
                       logon_process_name, auth_package_name, failure_reason,
                       status, workstation_name
                  FROM ad_failed_logon_events
                 WHERE occurred_at >= (NOW() - INTERVAL ? HOUR)
                   AND target_user_name NOT LIKE '%$'
                   AND (? = '' OR dc_name = ?)
                   AND (? = '' OR target_user_name = ?)
                   AND (? = '' OR ip_address = ?)
                 ORDER BY occurred_at DESC
                 LIMIT ?`,
      purgeOlderThan: `DELETE FROM ad_failed_logon_events WHERE occurred_at < ?`,
      // R158.55 (2026-10-08) — top-N workstation aggregate for
      // "按锁定服务器归类" toggle on /failed-logon-2h. Same machine-account
      // fail-safe as recent (target_user_name NOT LIKE '%$'). NULL
      // workstation → '(未上报)' via COALESCE so ECharts never sees a
      // literally-empty series name. ORDER BY count DESC + workstation ASC
      // gives a deterministic top-N. Mirrors lockout.trend24h MySQL
      // pattern (sql.js:1194-1237).
      aggregateByWorkstation: ({ sinceHours = 24, topN = 5, dcName = null } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.aggregateByWorkstation: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.aggregateByWorkstation: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        // R158.111 (2026-10-16) — 加 dcName 可选 filter (by=workstation 时
        //   进一步限定某 DC 的 workstation). dcName=null → 0 改老行为.
        const clauses = ['occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)',
                         "target_user_name NOT LIKE '%$'"];
        const params = [sinceHours];
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        // ⚠ LIMIT 属于 ORDER BY 之后的**尾部子句**, 不能进 WHERE 的 clauses 数组
        //   —— `clauses.push('LIMIT ?')` 会生成 `WHERE ... AND LIMIT ?`, 即
        //   ER_PARSE_ERROR. 之前一直是坏的 (reports.js:140 Promise.all 直接把
        //   整条日报链路 reject 掉). params 顺序不变 (topN 仍是最后一个).
        const sql =
          `SELECT COALESCE(workstation_name, '(未上报)') AS workstation_name,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events
            WHERE ${clauses.join(' AND ')}
            GROUP BY workstation_name
            ORDER BY event_count DESC, workstation_name ASC
            LIMIT ?`;
        params.push(topN);
        return { sql, params };
      },
      // R158.55 — hourly bucket trend per workstation. Two-path
      // (top-N default; workstation= override for single series).
      // Mirrors lockout.trend24h MySQL pattern (sql.js:1194-1237) with
      // agent_id → workstation_name swap. hourly COUNT includes warning
      // + error rows (4625 has no severity axis — all rows are password
      // errors).
      trendByWorkstation: ({ windowHours = 24, topN = 5, workstation = null } = {}) => {
        if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
          throw new Error(`failedLogon.trendByWorkstation: windowHours must be int in [1,168], got ${windowHours}`);
        }
        if (workstation) {
          const sql =
            `SELECT COALESCE(workstation_name, '(未上报)') AS workstation_name,
                    DATE_FORMAT(occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                    COUNT(*) AS event_count
               FROM ad_failed_logon_events
              WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                AND target_user_name NOT LIKE '%$'
                AND workstation_name = ?
              GROUP BY workstation_name, bucket_start
              ORDER BY bucket_start ASC`;
          return { sql, params: [windowHours, workstation] };
        }
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.trendByWorkstation: topN must be int in [1,20], got ${topN}`);
        }
        // R161.5 (2026-10-26) — MySQL 5.7 兼容化. `WITH top_ws AS (...)` 是
        // MySQL 8.0+ 的 CTE 语法 ⇒ 操作员真库 (5.7.44) 上 ER_PARSE_ERROR.
        // top_ws 的语义就是"按窗口期内事件数取前 topN 个工作站" ⇒ 本来
        // 就是一个带 LIMIT 的派生表, 直接内联成 JOIN 右侧的派生表即可。
        // 占位符顺序不变 (派生表在 FROM 子句里, 文本位置比外层 WHERE 更靠前)
        // ⇒ params 仍是 [windowHours, topN, windowHours]。
        const sql =
          `SELECT COALESCE(ws.workstation_name, '(未上报)') AS workstation_name,
                  DATE_FORMAT(ws.occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events ws
             JOIN (
               SELECT workstation_name FROM (
                 SELECT COALESCE(workstation_name, '(未上报)') AS workstation_name
                   FROM ad_failed_logon_events
                  WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                    AND target_user_name NOT LIKE '%$'
                  GROUP BY workstation_name
                  ORDER BY COUNT(*) DESC
                  LIMIT ?
               ) AS t
             ) t2 ON COALESCE(ws.workstation_name, '(未上报)') = t2.workstation_name
            WHERE ws.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
              AND ws.target_user_name NOT LIKE '%$'
            GROUP BY ws.workstation_name, bucket_start
            ORDER BY ws.workstation_name ASC, bucket_start ASC`;
        return { sql, params: [windowHours, topN, windowHours] };
      },
      // R158.57 (2026-10-09) — top-N DC aggregate for "按认证 DC" toggle
      // on /failed-logon-2h. dc_name is NOT NULL by agent contract
      // (failedLogon.normalizeEvent fallback chain), but COALESCE to
      // '(未上报)' for pre-1.0.4 historical rows where dcName may have
      // been undefined. Mirrors aggregateByWorkstation shape (line 1297).
      aggregateByDc: ({ sinceHours = 24, topN = 5, dcName = null } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.aggregateByDc: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.aggregateByDc: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        // R158.111 (2026-10-16) — 加 dcName 可选 filter (通常 by=dc 时上层
        //   已限定 1 DC, 该字段保留兜底二次过滤). dcName=null → 0 改老行为.
        const clauses = ['occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)',
                         "target_user_name NOT LIKE '%$'"];
        const params = [sinceHours];
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        // ⚠ 同 aggregateByWorkstation: LIMIT 是尾部子句, 0 放 WHERE clauses.
        const sql =
          `SELECT COALESCE(dc_name, '(未上报)') AS dc_name,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events
            WHERE ${clauses.join(' AND ')}
            GROUP BY dc_name
            ORDER BY event_count DESC, dc_name ASC
            LIMIT ?`;
        params.push(topN);
        return { sql, params };
      },
      // R158.111.a (2026-10-16) — 密码错误 raw event list, 流水不过滤.
      //   跟 lockout.listAll 范式 1:1 平行 (4 caller params). 0 过滤
      //   machine account `NOT LIKE '%$'` (用户 directive "不过滤"). 走
      //   ORDER BY occurred_at DESC + LIMIT/OFFSET 分页. sinceHours=NULL
      //   = 物理全量. 跟 aggregateByWorkstation / aggregateByDc 老 helper
      //   1:1 平行, 0 改. ad_failed_logon_events 字段: workstation_name
      //   (注意: 跟 ad_lockout_events.caller_computer_name 字段名不同,
      //   R158.1W.3 1:1 平行 caller 透明).
      listAll: ({ sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}) => {
        if (limit < 1 || limit > 500) {
          throw new Error(`failedLogon.listAll: limit must be in [1,500], got ${limit}`);
        }
        if (offset < 0) {
          throw new Error(`failedLogon.listAll: offset must be >= 0, got ${offset}`);
        }
        if (sinceHours !== null && (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168)) {
          throw new Error(`failedLogon.listAll: sinceHours must be null or int in [1,168], got ${sinceHours}`);
        }
        const clauses = [];
        const params = [];
        if (sinceHours !== null) {
          clauses.push('occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)');
          params.push(sinceHours);
        }
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push("(target_user_name LIKE ? OR COALESCE(target_user_display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        params.push(limit, offset);
        const sql =
          `SELECT dc_name,
                  target_user_name,
                  COALESCE(target_user_display_name, '') AS target_user_display_name,
                  COALESCE(NULLIF(workstation_name, ''), '') AS workstation_name,
                  4625 AS event_id,
                  occurred_at
             FROM ad_failed_logon_events
            ${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY occurred_at DESC
            LIMIT ? OFFSET ?`;
        return { sql, params };
      },
      // R158.57 — hourly bucket trend per DC (top-N default, dc= override
      // for single series). Mirrors trendByWorkstation structure (line 1321)
      // with workstation_name → dc_name swap.
      trendByDc: ({ windowHours = 24, topN = 5, dc = null } = {}) => {
        if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
          throw new Error(`failedLogon.trendByDc: windowHours must be int in [1,168], got ${windowHours}`);
        }
        if (dc) {
          const sql =
            `SELECT COALESCE(dc_name, '(未上报)') AS dc_name,
                    DATE_FORMAT(occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                    COUNT(*) AS event_count
               FROM ad_failed_logon_events
              WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                AND target_user_name NOT LIKE '%$'
                AND dc_name = ?
              GROUP BY dc_name, bucket_start
              ORDER BY bucket_start ASC`;
          return { sql, params: [windowHours, dc] };
        }
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.trendByDc: topN must be int in [1,20], got ${topN}`);
        }
        // R161.5 (2026-10-26) — MySQL 5.7 兼容化, 跟 trendByWorkstation 1:1
        // 平行: `WITH top_dc AS (...)` 是 8.0+ 的 CTE 语法 ⇒ 5.7 上
        // ER_PARSE_ERROR ⇒ 降级成 JOIN 右侧的派生表。占位符顺序不变 ⇒
        // params 仍是 [windowHours, topN, windowHours]。
        const sql =
          `SELECT COALESCE(ws.dc_name, '(未上报)') AS dc_name,
                  DATE_FORMAT(ws.occurred_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events ws
             JOIN (
               SELECT dc_name FROM (
                 SELECT COALESCE(dc_name, '(未上报)') AS dc_name
                   FROM ad_failed_logon_events
                  WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
                    AND target_user_name NOT LIKE '%$'
                  GROUP BY dc_name
                  ORDER BY COUNT(*) DESC
                  LIMIT ?
               ) AS t
             ) t2 ON COALESCE(ws.dc_name, '(未上报)') = t2.dc_name
            WHERE ws.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
              AND ws.target_user_name NOT LIKE '%$'
            GROUP BY ws.dc_name, bucket_start
            ORDER BY ws.dc_name ASC, bucket_start ASC`;
        return { sql, params: [windowHours, topN, windowHours] };
      },
      // R158.64 (2026-10-10) — top-N user aggregate for /api/admin/reports/
      // preview & run (daily/weekly email). Mirrors aggregateByDc (line 1375)
      // shape with target_user_name → sam, MAX(target_user_display_name) →
      // displayName, MAX(occurred_at) → lastErrorAt, COUNT → errorCount.
      // group_concat(distinct dc_name) → dcNameList (single DC if all errors
      // from one box; comma-list otherwise). target_user_name NOT LIKE '%$'
      // + <> '' 双保险 跟 recent/search 一致. LIMIT 50 (vs aggregateByDc
      // 20 cap) — 报告需要丰富用户列表, 不是 chart top-5.
      topByUserWithDisplay: ({ sinceHours = 24, topN = 50 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 200) {
          throw new Error(`failedLogon.topByUserWithDisplay: topN must be int in [1,200], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.topByUserWithDisplay: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        const sql =
          `SELECT target_user_name AS sam,
                  COALESCE(MAX(target_user_display_name), '') AS display_name,
                  COUNT(*) AS error_count,
                  MAX(occurred_at) AS last_error_at,
                  COUNT(DISTINCT dc_name) AS dc_count,
                  GROUP_CONCAT(dc_name ORDER BY dc_name SEPARATOR ',') AS dc_name_list
             FROM ad_failed_logon_events
            WHERE occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
              AND target_user_name NOT LIKE '%$'
              AND target_user_name <> ''
            GROUP BY target_user_name
            ORDER BY error_count DESC, sam ASC
            LIMIT ?`;
        return { sql, params: [sinceHours, topN] };
      },
      // R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图) MySQL 镜像.
      //   跟 MSSQL accountWorkstationLinks (line ~4773) 1:1 平行, GROUP_CONCAT 替代
      //   STUFF+FOR XML PATH, INTERVAL ? HOUR 替代 DATEADD, LIMIT ? 替代 TOP (?).
      accountWorkstationLinks: ({ sinceHours = 168, minStations = 1, limit = 200 } = {}) => {
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.accountWorkstationLinks: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        if (!Number.isInteger(minStations) || minStations < 1 || minStations > 50) {
          throw new Error(`failedLogon.accountWorkstationLinks: minStations must be int in [1,50], got ${minStations}`);
        }
        if (!Number.isInteger(limit) || limit < 10 || limit > 500) {
          throw new Error(`failedLogon.accountWorkstationLinks: limit must be int in [10,500], got ${limit}`);
        }
        // R161.5 (2026-10-26) — MySQL 5.7 兼容化, 跟 lockout.accountWorkstationLinks
        // 1:1 平行 (那边有完整说明): 两级 CTE → 派生表; edges 被引用两次 ⇒
        // 定义体用一个 JS 片段常量拼两次, 避免两份手抄漂移; dc_list 的相关
        // 子查询从 edges 内部提到外层 SELECT (edges 内的那份引用的是分组
        // 表达式而非分组列 ⇒ ONLY_FULL_GROUP_BY 下会报
        // ER_WRONG_FIELD_WITH_GROUP; 提到外层后外层无 GROUP BY, 约束不适用,
        // 语义不变)。
        // 占位符: 外层 dc_list 1 个 + 两份 edges 各 1 个 + HAVING 1 个 +
        // LIMIT 1 个 = 5 ⇒ params = [sinceHours ×3, minStations, limit]。
        const edgesBody = `
             SELECT
               LOWER(e.target_user_name) AS sam,
               NULLIF(TRIM(e.workstation_name), '') AS workstation,
               COUNT(*) AS event_count,
               MIN(e.occurred_at) AS first_seen,
               MAX(e.occurred_at) AS last_seen,
               COUNT(DISTINCT e.dc_name) AS dc_count
             FROM ad_failed_logon_events e
             WHERE e.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
               AND e.target_user_name NOT LIKE '%$'
               AND e.target_user_name <> ''
               AND NULLIF(TRIM(e.workstation_name), '') IS NOT NULL
             GROUP BY LOWER(e.target_user_name), NULLIF(TRIM(e.workstation_name), '')`;
        const sql =
          `SELECT ed.sam, ed.workstation, ed.event_count,
                  ed.first_seen, ed.last_seen, ed.dc_count,
                  (SELECT GROUP_CONCAT(DISTINCT e3.dc_name ORDER BY e3.dc_name SEPARATOR ',')
                     FROM ad_failed_logon_events e3
                    WHERE LOWER(e3.target_user_name) = ed.sam
                      AND IFNULL(NULLIF(TRIM(e3.workstation_name), ''), '') = IFNULL(ed.workstation, '')
                      AND e3.occurred_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)) AS dc_list,
                  s.station_count, s.total_count
             FROM (${edgesBody}
            ) ed
             JOIN (
               SELECT ed2.sam,
                      COUNT(DISTINCT ed2.workstation) AS station_count,
                      SUM(ed2.event_count) AS total_count
                 FROM (${edgesBody}
                ) ed2
                GROUP BY ed2.sam
               HAVING COUNT(DISTINCT ed2.workstation) >= ?
             ) s ON s.sam = ed.sam
            ORDER BY s.station_count DESC, ed.event_count DESC, ed.sam ASC, ed.workstation ASC
            LIMIT ?`;
        return { sql, params: [sinceHours, sinceHours, sinceHours, minStations, limit] };
      }
    },
    // R112 — ad_eventlog_* public tables. Public-page EventlogView displays
    // warning/error counts per (dc, channel) and drills into specific event
    // rows. Retention 24h — purged by centre-side hourly cron (see
    // center/src/packages/runner.js). Function-form per R93.4 — values
    // include LIMIT/TOP bindings that the static-template idiom cannot.
    eventlog: {
      // upsertEvent — idempotent re-insert by (dc_name, channel, record_id).
      // Synthetic PK is ignored on conflict; we only bump collected_at so
      // re-polls from the same record surface as fresh data.
      upsertEvent: ({ collectedAt, agentId, dcName, channel, severity, eventId, recordId, message, ts, auditFailure = 0 }) => ({
        sql: `INSERT INTO ad_eventlog_events
          (collected_at, agent_id, dc_name, channel, severity, event_id, record_id, message, ts, audit_failure)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            collected_at  = VALUES(collected_at),
            audit_failure = VALUES(audit_failure)`,
        params: [collectedAt, agentId, dcName, channel, severity, eventId, recordId, message, ts, auditFailure]
      }),
      // upsertSummary — counter row keyed by (dc_name, channel, collected_at).
      // Re-running with the same collected_at overwrites the warning/error
      // counts (idempotent). Caller controls collected_at resolution.
      // R154 — audit_failure_count added; same UPSERT-on-key semantics.
      // R158.52 — dropped_count added; nullable for backward compat with
      // pre-1.0.5 summary rows. Pre-1.0.5 agent bundles emit 0 dropped
      // (the column was always 0 in the legacy code path).
      upsertSummary: ({ collectedAt, agentId, dcName, channel, warningCount, errorCount, auditFailureCount = 0, droppedCount = 0 }) => ({
        sql: `INSERT INTO ad_eventlog_summary
          (collected_at, agent_id, dc_name, channel, warning_count, error_count, audit_failure_count, dropped_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            warning_count       = VALUES(warning_count),
            error_count         = VALUES(error_count),
            audit_failure_count = VALUES(audit_failure_count),
            dropped_count       = VALUES(dropped_count)`,
        params: [collectedAt, agentId, dcName, channel, warningCount, errorCount, auditFailureCount, droppedCount]
      }),
      // latestSummary — latest row per (dc_name, channel) within retention
      // window. Drives the EventlogView first paint (the 4-channel counter
      // grid keyed by DC).
      // R142 — add site grouping fields via LEFT JOIN ad_dcs/ad_sites.
      // Mirrors R140 pattern at dashboard.agents: agents without an
      // ad_dcs row still surface, with siteName = null → frontend
      // "未分组" bucket. Wire shape is non-breaking (frontend can
      // ignore the new columns when not yet wired).
      latestSummary: ({ sinceHours = 2 } = {}) => ({
        sql: `SELECT s.dc_name, s.channel, s.warning_count, s.error_count,
                     s.audit_failure_count,
                     -- R158.52 (v1.0.5) — operator directive "零或空 / 都修复":
                     -- surface dropped_count so the EventlogView can flag
                     -- "real activity was X+Y" when the 1000-row per-channel
                     -- limit silently dropped events. Pre-1.0.5 summary rows
                     -- have dropped_count=NULL; COALESCE to 0 so the grid
                     -- always renders a number.
                     COALESCE(s.dropped_count, 0) AS dropped_count,
                     s.collected_at,
                     d.site_hint, ds.site_id, ds.site_name, ds.region_code
                FROM ad_eventlog_summary s
                INNER JOIN (
                  SELECT dc_name, channel, MAX(collected_at) AS max_collected
                  FROM ad_eventlog_summary
                  WHERE collected_at >= (NOW() - INTERVAL ? HOUR)
                  GROUP BY dc_name, channel
                ) m
                  ON m.dc_name = s.dc_name
                 AND m.channel  = s.channel
                 AND m.max_collected = s.collected_at
                LEFT JOIN ad_dcs d ON d.dc_name = s.dc_name
                LEFT JOIN ad_sites ds ON ds.site_id = d.site_id
                ORDER BY s.dc_name, s.channel`,
        params: [sinceHours]
      }),
      // queryEvents — drill-down events for one (dc, channel, severity?).
      // severity is optional; null/empty disables that filter. limit bound
      // as integer param (R93.4 function-form rule — no string interp).
      // R154 — `auditOnly` filters the event row's audit_failure flag;
      // useful for the Security channel drill-down where the operator
      // wants only 4625/4776 events. Default sinceHours is 2 (matches
      // the 2h scan window from collect.ps1 1.0.1).
      queryEvents: ({ dcName, channel, severity = null, sinceHours = 2, limit = 200, auditOnly = false } = {}) => {
        const params = [dcName, channel, sinceHours];
        let sevClause = '';
        if (severity) {
          sevClause = 'AND severity = ?';
          params.push(severity);
        }
        if (auditOnly) {
          sevClause += ' AND audit_failure = 1';
        }
        params.push(limit);
        return {
          sql: `SELECT collected_at, dc_name, channel, severity,
                       event_id, record_id, message, ts, audit_failure
                  FROM ad_eventlog_events
                 WHERE dc_name    = ?
                   AND channel    = ?
                   AND collected_at >= (NOW() - INTERVAL ? HOUR)
                   ${sevClause}
                 ORDER BY ts DESC
                 LIMIT ?`,
          params
        };
      },
      // R158.X (2026-10-15) — 跨 DC 账户管理 event 列表 (Security log
      //   event_id IN (4720, 4722, 4723, 4725, 4726, 4738, 4740))。不走
      //   queryEvents (强制 dcName+channel 单 DC, 跟 AccountChangeDetailView
      //   跨 DC 视图语义不符)。inline 整数列表 (跟 R158.100.B+3 #2 lesson
      //   "mssql npm driver 多行 + N 参 placeholder rewrite 边界 case fail"
      //   避坑 — 永远 0 行 N placeholder, 仅 inline int list)。event_id
      //   是 server-side hardcoded whitelist, 不暴露 SQL injection 表面.
      queryAccountManagementEvents: ({ eventIds, sinceHours = 24, limit = 200 } = {}) => {
        if (!Array.isArray(eventIds) || eventIds.length === 0) {
          throw new Error('eventlog.queryAccountManagementEvents: eventIds required');
        }
        const eventIdList = eventIds.map(id => Number(id)).filter(n => Number.isInteger(n) && n > 0).join(',');
        if (!eventIdList) {
          throw new Error('eventlog.queryAccountManagementEvents: eventIds must be positive integers');
        }
        const safeLimit = Math.max(1, Math.min(200000, Number.parseInt(limit, 10) || 200));
        return {
          sql: `SELECT collected_at, dc_name, channel, severity,
                       event_id, record_id, message, ts, audit_failure
                  FROM ad_eventlog_events
                 WHERE channel    = 'Security'
                   AND event_id   IN (${eventIdList})
                   AND collected_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
                 ORDER BY ts DESC
                 LIMIT ?`,
          params: [sinceHours, safeLimit]
        };
      },
      // purgeOlderThan — centre-side hourly retention sweep.
      // Caller resolves cutoffIso (24h ago in JS) so the SQL stays portable.
      purgeOlderThan: ({ cutoffIso }) => ({
        sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < ?',  params: [cutoffIso] },
        sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < ?',  params: [cutoffIso] }
      }),
      // R158.54 (2026-10-08) — 24h hourly event log trend for /eventlog
      // line chart. 5 channel × 24 hour bucket × COUNT(*). Channel is
      // fixed (System / Application / ADWeb / DFSR / Security) — no topN
      // required. Hourly COUNT includes both warning + error rows (cell
      // color threshold is per-cell drilldown, not chartable at 24h×5ch
      // density). Reuses failedLogon.hourlyAggregate GROUP BY hour bucket
      // idiom (sql.js:1201-1207).
      trend24h: ({ hours = 24 } = {}) => {
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error(`eventlog.trend24h: hours must be int in [1,168], got ${hours}`);
        }
        const sql =
          `SELECT channel,
                  DATE_FORMAT(collected_at, '%Y-%m-%d %H:00:00') AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_eventlog_events
            WHERE collected_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
            GROUP BY channel, bucket_start
            ORDER BY channel ASC, bucket_start ASC`;
        return { sql, params: [hours] };
      },
      // R158.108 (2026-10-16) — daily aggregate for /eventlog 7d/全部
      // toggle. 跟 trend24h 1:1 平行, 0 改 hourly (R158.54).
      // DATE_FORMAT 改 '%Y-%m-%d' 替 '%Y-%m-%d %H:00:00'. days ∈ [1, 365]
      // (365 = 1y hard cap, 跟 ad_mgmt_retention_days=0=永久 1:1 平行,
      // SQL 端 hard cap 防 query 失控). 7d/全部 走 daily bucket, 24h 仍
      // 走 hourly, 2 窗口 0 互扰. 复用 ix_eventlog_collected (collected_at)
      // 索引, 0 schema 改, 0 索引依赖.
      dailyAggregate: ({ days = 7 } = {}) => {
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new Error(`eventlog.dailyAggregate: days must be int in [1,365], got ${days}`);
        }
        const sql =
          `SELECT channel,
                  DATE_FORMAT(collected_at, '%Y-%m-%d') AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_eventlog_events
            WHERE collected_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)
            GROUP BY channel, bucket_start
            ORDER BY channel ASC, bucket_start ASC`;
        return { sql, params: [days] };
      },
      // R158.X.99.33 (2026-10-19) — /eventlog 24h raw-by-ts 5-min bucket.
// bucket 边界 走 `ts` (Windows event TimeGenerated), 跟 collected_at
// (centre UPSERT moment) 区分 — 操作员原意 "真实事件时间分布".
// 1:1 平行 dailyAggregate shape (channel, bucket_start, event_count),
// 0 改 trend24h (R158.54 hourly), 0 改 dailyAggregate (R158.108).
//
// bucket 切分: 5 min (bucketMinutes=5 默认, 288 段/24h × 5 channel
// = 1440 点). bucketMinutes ∈ {1, 5, 15, 30, 60}. 操作员 24h 走
// 5min 默认, 7d/全部 仍 dailyAggregate unchanged.
//
// 注意 ts 列无 leading 索引 (ix_eventlog_collected leading 是
// collected_at). 5min bucket GROUP BY ts floor 全表 scan, ops 已知
// (R158.51 baseline freeze 锁 0 schema 改). ad_eventlog_events 表
// 4h retention sweep 后 体量 bounded, 24h×5ch×288 ≤ ~1440 行不卡.
// MySQL: FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts)/300)*300) 5min floor.
trendByBucketMinutes: ({ hours = 24, bucketMinutes = 5 } = {}) => {
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new Error(`eventlog.trendByBucketMinutes: hours must be int in [1,168], got ${hours}`);
  }
  // R158.X.99.34 — whitelist 扩 240 (4h) for /eventlog 7d bucket4h (42 段).
  if (!Number.isInteger(bucketMinutes) || ![1, 5, 15, 30, 60, 240].includes(bucketMinutes)) {
    throw new Error(`eventlog.trendByBucketMinutes: bucketMinutes must be one of [1,5,15,30,60,240], got ${bucketMinutes}`);
  }
  const secs = bucketMinutes * 60;
  const sql =
    `SELECT channel,
            FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts) / ${secs}) * ${secs}) AS bucket_start,
            COUNT(*) AS event_count
       FROM ad_eventlog_events
      WHERE ts >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
      GROUP BY channel, bucket_start
      ORDER BY channel ASC, bucket_start ASC`;
  return { sql, params: [hours] };
},
      // R158.23 (2026-10-02) — channel-aware purge. Same shape as
      // purgeOlderThan but adds an optional `channel` filter so the
      // Security channel can keep a longer (24h) retention while the
      // other 4 channels stay at 4h. Pass channel=null to mean
      // "everything that ISN'T this channel excluded via WHERE channel
      // IS NULL / != pattern, depending on the requirement". The actual
      // exclusion pattern in MySQL is `channel <> ?` (negation),
      // because the default sweep is for "non-Security" — we pass the
      // channel to exclude via the same `channel` arg.
      //
      // Wait, that misnaming causes confusion. Re-clarifying: this
      // helper takes `channel=null` to mean "sweep all channels" (no
      // filter) and `channel='Security'` to mean "sweep ONLY Security".
      // For the 4h default sweep on the 4 operational channels, the
      // service-level code calls this with channel='NOT-Security' (a
      // marker string the helper translates). See service code for the
      // exact dispatch — we accept both literal 'Security' and the
      // special '__NOT__' marker.
      purgeOlderThanChannel: ({ cutoffIso, channel = null } = {}) => {
        const excludeMode = channel === '__NOT_SECURITY__';
        const includeMode = typeof channel === 'string' && !excludeMode;
        if (includeMode) {
          return {
            sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < ? AND channel = ?',            params: [cutoffIso, channel] },
            sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < ? AND channel = ?',            params: [cutoffIso, channel] }
          };
        }
        if (excludeMode) {
          return {
            sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < ? AND channel <> ?',           params: [cutoffIso, 'Security'] },
            sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < ? AND channel <> ?',           params: [cutoffIso, 'Security'] }
          };
        }
        // No channel filter — purge everything older than cutoff.
        return {
          sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < ?',                              params: [cutoffIso] },
          sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < ?',                              params: [cutoffIso] }
        };
      }
    },
    schemaMigrations: {
      list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
      findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = ?',
      upsert: `INSERT INTO schema_migrations
        (version, description, type, script, checksum, applied_at, execution_ms, applied_by, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          description   = VALUES(description),
          type          = VALUES(type),
          script        = VALUES(script),
          checksum      = VALUES(checksum),
          applied_at    = VALUES(applied_at),
          execution_ms  = VALUES(execution_ms),
          applied_by    = VALUES(applied_by),
          status        = VALUES(status),
          error_message = VALUES(error_message)`,
      deleteFailed: "DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'",
      // 2026-08-28 round-55: refresh stale checksum without re-running SQL.
      // Only updates checksum; status, applied_at, applied_by, execution_ms,
      // error_message all preserved. WHERE guards: must already be applied
      // (refuse to "fix" a pending/failed row's checksum — operator should
      // use mark-applied or reset instead).
      updateChecksum: "UPDATE schema_migrations SET checksum = ? WHERE version = ? AND status = 'applied'"
    },
    // Port self-probe state (migration 012). One row per port_role, upserted
    // at 1 Hz by the probe service. getAll backs /api/probe and the admin
    // monitor panel; upsertRow is the single-row writer.
    probeState: {
      getAll: 'SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role',
      upsertRow: (portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures) =>
        `INSERT INTO probe_state (port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           latency_ms = VALUES(latency_ms),
           last_probe_at = VALUES(last_probe_at),
           last_up_at = VALUES(last_up_at),
           consecutive_failures = VALUES(consecutive_failures)`
    },
    // Existence probes for migration verify markers. Returns one row when the
    // artifact exists, zero rows when it doesn't. Scoped to the connection's
    // own database so a same-named table in another schema can't false-positive.
    probe: {
      table: `SELECT 1 AS ok FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      column: `SELECT 1 AS ok FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
      // information_schema.STATISTICS has one row per (table, index, column)
      // — composite indexes span multiple rows. DISTINCT collapses to one row
      // per index name so a single-hit LIMIT 1 is the right cardinality check.
      index: `SELECT 1 AS ok FROM (
                SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = ? AND INDEX_NAME = ?
               ) AS idx LIMIT 1`
    },
    // Non-AD server management (migration 014). Eight tables total split
    // across five domains so services can scope their reads: member-servers
    // (the inventory), server-groups (groups + memberships + per-host package
    // assignments), system-alerts (5 detector firing log, R158.68),
    // system-alert-outbox (built-in alert email delivery queue, R158.68).
    memberServers: memberServers.mysql,
    // R158.X.115 (2026-10-20) — 主机退役/暂停管控状态机 SQL。
    hostStatus: hostStatus.mysql,
    // R158.74 (2026-10-11) — ad_member_server_ports 业务端口表.
    memberServerPorts: memberServerPorts.mysql,
    // R158.78 (2026-10-12) — ad_member_eventlog_* member-server 事件日志专表.
    memberEventlog: memberEventlog.mysql,
    // R158.86 (2026-10-12) — ad_member_os_baseline* OS baseline 专表.
    memberOsBaseline: memberOsBaseline.mysql,
    serverGroups: serverGroups.mysql,
    systemAlerts: systemAlerts.mysql,
    // R158.Suppression — 系统告警抑制 (操作员行级暂停) helper. 跟 systemAlerts
    //   同注册 idiom (mysql/mssql 双 dialect 各 1 行). 0 改既有 6 行 systemAlerts /
    //   systemAlertOutbox 注册; 0 改 VARIANTS 其它 domain.
    systemAlertSuppressions: systemAlertSuppressions.mysql,
    systemAlertOutbox: systemAlertOutbox.mysql,
    reportEmailOutbox: reportEmailOutbox.mysql,
    // R158.100.C — AD 操作通知 outbox (3rd table in delivery loop UNION).
    adNotifyOutbox: adNotifyOutbox.mysql,
    // R158.AdminEmail — License 通知 outbox (4th table in delivery loop UNION).
    // 跟 ad-notify-outbox.mysql 1:1 平行, 8 列 INSERT shape. 0 改 3 张既有 outbox.
    licenseEmailOutbox: licenseEmailOutbox.mysql,
    // R158.License-expiry — expiry 邮件 catch-up dedup (subject LIKE 查窗内同 kind
    // 已发数). 跟 R158.100.B+3 daily_reports countByKindInWindow 1:1 平行. 0 改 4 张 outbox.
    licenseExpiryDedup: licenseExpiryDedup.mysql,
    // R158.69 (2026-10-10) — 邮件历史 (EmailConfigView 新 tab). 双 dialect
    // helper 注册到 VARIANTS.mysql/mssql, 跟 systemAlerts 同模式.
    emailHistory: emailHistory.mysql,
    // R158.100.B (2026-10-14) — 邮件队列 (7th tab). 同 precedent 1:1 平行.
    emailQueue: emailQueue.mysql,
    // R158.68 — 替代 R158.62 alertMetrics.listLatestPerAgent/getLatest
    osBaselineMetrics: osBaselineMetrics.mysql,
    // R158.29 — per-agent 24h CPU/memory time-series for
    // /api/os-baseline/timeseries (OsBaselineView dual-line chart).
    //
    // **DO NOT register `osBaselineTimeseries.mysql` / `.mssql` (the
    // helper functions) directly as a VARIANTS domain.** buildSql(dialect)
    // assumes each domain is a `{ queryName: sqlString }` dictionary and
    // runs `Object.freeze({ ...queries })`. Spreading a function yields an
    // EMPTY OBJECT (functions have no own enumerable properties), which
    // is the root cause of the R158.29 /api/os-baseline/timeseries 500
    // (`db.sql.osBaselineTimeseries` returned `{}`, then `sqlStr.replace`
    // threw). Instead register the dialect-shaped object directly, so
    // the spread preserves both child entries. The caller picks the
    // matching dialect key by name.
    osBaselineTimeseries: osBaselineTimeseries,
    // system_config key/value lookup used by the upgrade endpoint to track
    // the seed-file checksum (decides first-run vs re-apply vs skip).
    systemConfig: {
      getByKey: 'SELECT config_key, config_value FROM system_config WHERE config_key = ?',
      upsertByKey: `INSERT INTO system_config (config_key, config_value) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`
    },
    // 2026-08-31 R75 — AD user & group management command queue. Center
    // queues an AD command via adminRouter; agent polls + executes PS1 +
    // POSTs the result back. Status flow: queued → running → success |
    // failed | timeout. The claim path is split into claimPick (SELECT
    // queued ids, bound LIMIT) + claim (UPDATE IN (?), bound ids + dc) so
    // two agents polling simultaneously can never claim the same row.
    adAdminCommands: {
      // R158.46b — task_id 列在 queue 时刻写入. 格式: `<TARGET_DC>-<YYYYMMDDHHMMSSmmm>`.
      // service queueCommand() 生成, 4 个 lifecycle audit row payload 同步带.
      insert: `INSERT INTO ad_admin_commands
                 (command_type, target_dc, params_json, status, operator_id, created_at, task_id)
               VALUES (?, ?, ?, 'queued', ?, UTC_TIMESTAMP(), ?)`,
      // claimPick returns queued ids for one dc, oldest first, capped at
      // `limit`. The caller then runs claim() with those ids to atomically
      // flip them to 'running' and claim_at = NOW() — matches the file-push
      // agent-poll "two-step claim" pattern used by other claim flows.
      claimPick: `SELECT id FROM ad_admin_commands
                    WHERE status = 'queued' AND target_dc = ?
                    ORDER BY created_at ASC, id ASC
                    LIMIT ?`,
      // idCount controls the IN-list width. mysql2/promise does NOT
      // auto-expand `IN (?)` against an array param (and neither does
      // tedious on mssql), so the SQL builder expands N `?` placeholders
      // matching the id array length. Caller expands ids + dc as params.
      claim: (idCount) => `UPDATE ad_admin_commands
                              SET status = 'running', claimed_at = UTC_TIMESTAMP()
                            WHERE id IN (${Array(idCount).fill('?').join(',')})
                              AND status = 'queued'
                              AND target_dc = ?`,
      // R158.46b — task_id 列: claimed row payload 也要带 (agent audit + UI).
      loadByIds: (idCount) => `SELECT id, command_type, target_dc, params_json, status,
                                       created_at, claimed_at, task_id
                                  FROM ad_admin_commands
                                 WHERE id IN (${Array(idCount).fill('?').join(',')})`,
      complete: `UPDATE ad_admin_commands
                    SET status = ?, result_json = ?, error_message = ?,
                        duration_ms = ?, completed_at = UTC_TIMESTAMP()
                  WHERE id = ?`,
      listByOperator: `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.status,
                              c.operator_id, u.username AS operator_username,
                              c.created_at, c.claimed_at, c.completed_at,
                              c.duration_ms, c.error_message
                         FROM ad_admin_commands c
                         LEFT JOIN sys_users u ON u.id = c.operator_id
                        WHERE c.operator_id = ?
                        ORDER BY c.created_at DESC, c.id DESC
                        LIMIT ? OFFSET ?`,
      listAll: `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.status,
                       c.operator_id, u.username AS operator_username,
                       c.created_at, c.claimed_at, c.completed_at,
                       c.duration_ms, c.error_message
                  FROM ad_admin_commands c
                  LEFT JOIN sys_users u ON u.id = c.operator_id
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT ? OFFSET ?`,
      listByStatus: `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.status,
                            c.operator_id, u.username AS operator_username,
                            c.created_at, c.claimed_at, c.completed_at,
                            c.duration_ms, c.error_message
                       FROM ad_admin_commands c
                       LEFT JOIN sys_users u ON u.id = c.operator_id
                      WHERE c.status = ?
                      ORDER BY c.created_at DESC, c.id DESC
                      LIMIT ? OFFSET ?`,
      getById: `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.params_json,
                       c.result_json, c.status, c.operator_id,
                       u.username AS operator_username,
                       c.created_at, c.claimed_at, c.completed_at,
                       c.duration_ms, c.error_message
                  FROM ad_admin_commands c
                  LEFT JOIN sys_users u ON u.id = c.operator_id
                 WHERE c.id = ?`,
      // timeout sweeper — UPDATE running rows whose claimed_at is older
      // than `timeoutMs`. Caller binds [timeoutSeconds].
      sweepTimeouts: `UPDATE ad_admin_commands
                         SET status = 'timeout',
                             error_message = 'command exceeded timeout threshold',
                             completed_at = UTC_TIMESTAMP()
                       WHERE status = 'running'
                         AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? SECOND`,
      countAll: `SELECT COUNT(*) AS total FROM ad_admin_commands`,
      countByOperator: `SELECT COUNT(*) AS total FROM ad_admin_commands WHERE operator_id = ?`,
      countByStatus: `SELECT COUNT(*) AS total FROM ad_admin_commands WHERE status = ?`
    },
    // 2026-09-05 R81 — 成员服务器 PowerShell command queue. Same shape as
    // adAdminCommands (R75) but the target column is `hostname` (member
    // server) instead of `target_dc` (DC). Center queues via
    // POST /api/admin/member-commands; agent polls
    // GET /api/agent/member-commands?hostname=X and acks via
    // POST /api/agent/member-commands/:id/result. Status flow:
    // queued → running → success | failed | timeout. The two-step claim
    // pattern (claimPick + claim IN-list) is identical to R75.
    adMemberCommands: {
      insert: `INSERT INTO ad_member_commands
                 (hostname, command_type, params_json, status, operator_id, created_at)
               VALUES (?, ?, ?, 'queued', ?, UTC_TIMESTAMP())`,
      claimPick: `SELECT id FROM ad_member_commands
                    WHERE status = 'queued' AND hostname = ?
                    ORDER BY created_at ASC, id ASC
                    LIMIT ?`,
      claim: (idCount) => `UPDATE ad_member_commands
                              SET status = 'running', claimed_at = UTC_TIMESTAMP()
                            WHERE id IN (${Array(idCount).fill('?').join(',')})
                              AND status = 'queued'
                              AND hostname = ?`,
      loadByIds: (idCount) => `SELECT id, hostname, command_type, params_json, status,
                                       created_at, claimed_at
                                  FROM ad_member_commands
                                 WHERE id IN (${Array(idCount).fill('?').join(',')})`,
      complete: `UPDATE ad_member_commands
                    SET status = ?, result_json = ?, error_message = ?,
                        duration_ms = ?, completed_at = UTC_TIMESTAMP()
                  WHERE id = ?`,
      listByOperator: `SELECT c.id, c.hostname, c.command_type, c.status,
                              c.operator_id, u.username AS operator_username,
                              c.created_at, c.claimed_at, c.completed_at,
                              c.duration_ms, c.error_message
                         FROM ad_member_commands c
                         LEFT JOIN sys_users u ON u.id = c.operator_id
                        WHERE c.operator_id = ?
                        ORDER BY c.created_at DESC, c.id DESC
                        LIMIT ? OFFSET ?`,
      listAll: `SELECT c.id, c.hostname, c.command_type, c.status,
                       c.operator_id, u.username AS operator_username,
                       c.created_at, c.claimed_at, c.completed_at,
                       c.duration_ms, c.error_message
                  FROM ad_member_commands c
                  LEFT JOIN sys_users u ON u.id = c.operator_id
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT ? OFFSET ?`,
      listByStatus: `SELECT c.id, c.hostname, c.command_type, c.status,
                            c.operator_id, u.username AS operator_username,
                            c.created_at, c.claimed_at, c.completed_at,
                            c.duration_ms, c.error_message
                       FROM ad_member_commands c
                       LEFT JOIN sys_users u ON u.id = c.operator_id
                      WHERE c.status = ?
                      ORDER BY c.created_at DESC, c.id DESC
                      LIMIT ? OFFSET ?`,
      listByHost: `SELECT c.id, c.hostname, c.command_type, c.status,
                          c.operator_id, u.username AS operator_username,
                          c.created_at, c.claimed_at, c.completed_at,
                          c.duration_ms, c.error_message
                     FROM ad_member_commands c
                     LEFT JOIN sys_users u ON u.id = c.operator_id
                    WHERE c.hostname = ?
                    ORDER BY c.created_at DESC, c.id DESC
                    LIMIT ? OFFSET ?`,
      getById: `SELECT c.id, c.hostname, c.command_type, c.params_json,
                       c.result_json, c.status, c.operator_id,
                       u.username AS operator_username,
                       c.created_at, c.claimed_at, c.completed_at,
                       c.duration_ms, c.error_message
                  FROM ad_member_commands c
                  LEFT JOIN sys_users u ON u.id = c.operator_id
                 WHERE c.id = ?`,
      // timeout sweeper — UPDATE running rows whose claimed_at is older
      // than `timeoutMs`. Caller binds [timeoutSeconds].
      sweepTimeouts: `UPDATE ad_member_commands
                         SET status = 'timeout',
                             error_message = 'command exceeded timeout threshold',
                             completed_at = UTC_TIMESTAMP()
                       WHERE status = 'running'
                         AND claimed_at < UTC_TIMESTAMP() - INTERVAL ? SECOND`,
      // Rate-limit pre-check: count queued+running rows for this hostname
      // in the last 60 seconds. Caller binds [hostname].
      countRecentForHost: `SELECT COUNT(*) AS n FROM ad_member_commands
                            WHERE hostname = ?
                              AND status IN ('queued', 'running')
                              AND created_at >= UTC_TIMESTAMP() - INTERVAL 1 MINUTE`,
      countAll: `SELECT COUNT(*) AS total FROM ad_member_commands`,
      countByOperator: `SELECT COUNT(*) AS total FROM ad_member_commands WHERE operator_id = ?`,
      countByStatus: `SELECT COUNT(*) AS total FROM ad_member_commands WHERE status = ?`,
      countByHost: `SELECT COUNT(*) AS total FROM ad_member_commands WHERE hostname = ?`
    },
    // R114 — centre→agent remote port probe.
    // Spec: docs/superpowers/specs/2026-09-26-r114-centre-remote-port-probe-design.md §4.2
    // ad_remote_port_probe is the centre-side active-probe result table. Probe
    // results are upserted (one row per (dc_name, port)) by the scheduler in
    // center/src/services/port-probe-scheduler.js. Read paths live in
    // center/src/services/port-status-remote.js.
    remotePortProbe: {
      // Caller binds [probe_at, dc_name, port, ok, latency_ms, error]
      upsertOne: `INSERT INTO ad_remote_port_probe
        (probe_at, dc_name, port, ok, latency_ms, error)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          probe_at = VALUES(probe_at),
          ok = VALUES(ok),
          latency_ms = VALUES(latency_ms),
          error = VALUES(error)`,
      // Caller binds the dcNames array verbatim. INNER JOIN to system_ports
      // keeps the catalogue label co-located with each probe row so the UI
      // doesn't need a second lookup. Order: catalogue sort_order first, then
      // port — matches the catalogue's natural display order.
      listForDcs: (placeholders) => `SELECT rpp.dc_name AS dcName, rpp.port, rpp.ok,
               rpp.latency_ms AS latencyMs, rpp.probe_at AS probeAt, rpp.error,
               sp.label AS label
         FROM ad_remote_port_probe rpp
         INNER JOIN system_ports sp ON rpp.port = sp.port
         WHERE rpp.dc_name IN (${placeholders})
         ORDER BY sp.sort_order, sp.port`,
      // Caller binds the dcNames array verbatim. Returns MAX(probe_at) per dc
      // — the "lastConnectAt" the UI shows in the new "最后连接" column.
      probeAtByDcs: (placeholders) => `SELECT rpp.dc_name AS dcName,
               MAX(rpp.probe_at) AS lastConnectAt
         FROM ad_remote_port_probe rpp
         WHERE rpp.dc_name IN (${placeholders})
         GROUP BY rpp.dc_name`,
      // Target DC list — sourced from ad_dcs (the registered DC registry,
      // same source as ad_dc_overview). Single-target-row-per-dc, sorted.
      dcList: `SELECT DISTINCT dc_name FROM ad_dcs ORDER BY dc_name`
    },
    // R114 — system_settings is a generic KV table for runtime-configurable
    // settings. Cadence override `r114_probe_interval_ms` lives here.
    systemSettings: {
      // Caller binds [setting_key].
      get: `SELECT setting_value FROM system_settings WHERE setting_key = ?`,
      // Caller binds [setting_key, setting_value]. UTC_TIMESTAMP keeps the
      // updated_at aligned with the rest of the centre (UTC convention).
      upsert: `INSERT INTO system_settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE
          setting_value = VALUES(setting_value),
          updated_at = VALUES(updated_at)`
    },
    // R158.35 (2026-10-03) — AD directory LDAP sync. Three snapshot tables
    // (users / groups / OUs) + one runs table. Per-DC UPSERT by composite
    // PK (dc_name, PK2) so a row that already exists gets refreshed in place.
    // Orphan DELETE is composed at runtime (chunked IN-list) — see
    // services/ad-directory-sync.js deleteOrphans().
    directorySync: {
      // Insert a fresh run row at status='running'. Caller binds [dc_name, triggered_by].
      // UTC_TIMESTAMP keeps the started_at aligned with the rest of the centre.
      insertRun: `INSERT INTO ad_directory_sync_runs (dc_name, started_at, status, triggered_by)
                  VALUES (?, UTC_TIMESTAMP(), 'running', ?)`,
      // Finalize a run (success or failed). Caller binds
      // [status, user_count, group_count, ou_count, computer_count, error_message, id].
      // R158.44.7.10 (2026-10-05) — added computer_count (positioned after ou_count).
      finalizeRun: `UPDATE ad_directory_sync_runs
                    SET finished_at = UTC_TIMESTAMP(),
                        status = ?,
                        user_count = ?,
                        group_count = ?,
                        ou_count = ?,
                        computer_count = ?,
                        error_message = ?
                    WHERE id = ?`,
      // UPSERT user snapshot. Caller binds 16 params in PK-ascending order.
      // ON DUPLICATE KEY refreshes every column EXCEPT the PK (domain_name, sam)
      // so a same-domain re-sync overwrites stale fields atomically.
      // R158.36 (2026-10-03) added description + manager_dn + manager_sam
      // (3 columns) so the write path `user_set_manager` and the read path
      // /api/admin/ad-users both expose manager without a follow-up LDAP
      // round-trip.
      upsertUser: `INSERT INTO ad_users_snapshot
                     (domain_name, sam, display_name, distinguished_name, ou_dn,
                      enabled, locked_out, last_logon, when_created,
                      password_last_set, user_account_control,
                      description, manager_dn, manager_sam,
                      snapshot_at, snapshot_run_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE
                     display_name = VALUES(display_name),
                     distinguished_name = VALUES(distinguished_name),
                     ou_dn = VALUES(ou_dn),
                     enabled = VALUES(enabled),
                     locked_out = VALUES(locked_out),
                     last_logon = VALUES(last_logon),
                     when_created = VALUES(when_created),
                     password_last_set = VALUES(password_last_set),
                     user_account_control = VALUES(user_account_control),
                     description = VALUES(description),
                     manager_dn = VALUES(manager_dn),
                     manager_sam = VALUES(manager_sam),
                     snapshot_at = VALUES(snapshot_at),
                     snapshot_run_id = VALUES(snapshot_run_id)`,
      // UPSERT group snapshot. PK (domain_name, name).
      // R158.44.7.7 (2026-10-05) — added ou_dn column.
      upsertGroup: `INSERT INTO ad_groups_snapshot
                      (domain_name, name, sam_account_name, distinguished_name, ou_dn,
                       group_type, group_scope, description, member_count,
                       snapshot_at, snapshot_run_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                      sam_account_name = VALUES(sam_account_name),
                      distinguished_name = VALUES(distinguished_name),
                      ou_dn = VALUES(ou_dn),
                      group_type = VALUES(group_type),
                      group_scope = VALUES(group_scope),
                      description = VALUES(description),
                      member_count = VALUES(member_count),
                      snapshot_at = VALUES(snapshot_at),
                      snapshot_run_id = VALUES(snapshot_run_id)`,
      // UPSERT OU snapshot. PK (domain_name, distinguished_name).
      upsertOu: `INSERT INTO ad_ous_snapshot
                   (domain_name, distinguished_name, name, description,
                    when_created, when_changed, parent_dn,
                    snapshot_at, snapshot_run_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   name = VALUES(name),
                   description = VALUES(description),
                   when_created = VALUES(when_created),
                   when_changed = VALUES(when_changed),
                   parent_dn = VALUES(parent_dn),
                   snapshot_at = VALUES(snapshot_at),
                   snapshot_run_id = VALUES(snapshot_run_id)`,
      // R158.44.7.10 (2026-10-05) — UPSERT computer snapshot. PK (domain_name, sam_account_name).
      // Computer 也有 sAMAccountName (后缀 $), is_server 派生 (UAC bit 0x20000 SERVER_TRUST_ACCOUNT).
      upsertComputer: `INSERT INTO ad_computers_snapshot
                         (domain_name, sam_account_name, cn, name, distinguished_name, ou_dn,
                          enabled, is_server,
                          operating_system, operating_system_version, dns_host_name,
                          last_logon, when_created, when_changed,
                          description, managed_by_dn, managed_by_sam,
                          snapshot_at, snapshot_run_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON DUPLICATE KEY UPDATE
                         cn = VALUES(cn),
                         name = VALUES(name),
                         distinguished_name = VALUES(distinguished_name),
                         ou_dn = VALUES(ou_dn),
                         enabled = VALUES(enabled),
                         is_server = VALUES(is_server),
                         operating_system = VALUES(operating_system),
                         operating_system_version = VALUES(operating_system_version),
                         dns_host_name = VALUES(dns_host_name),
                         last_logon = VALUES(last_logon),
                         when_created = VALUES(when_created),
                         when_changed = VALUES(when_changed),
                         description = VALUES(description),
                         managed_by_dn = VALUES(managed_by_dn),
                         managed_by_sam = VALUES(managed_by_sam),
                         snapshot_at = VALUES(snapshot_at),
                         snapshot_run_id = VALUES(snapshot_run_id)`,
      // R158.60.20 (2026-10-09) — user-group membership rows. PK is
      // (domain_name, user_sam, group_dn). Caller binds
      // [domain_name, user_sam, group_dn, group_name, snapshot_at, run_id].
      upsertUgm: `INSERT INTO ad_user_group_memberships
                     (domain_name, user_sam, group_dn, group_name,
                      snapshot_at, snapshot_run_id)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE
                     group_name = VALUES(group_name),
                     snapshot_at = VALUES(snapshot_at),
                     snapshot_run_id = VALUES(snapshot_run_id)`,
      // Caller binds [domain_name, user_sam].
      listGroupsForUser: `SELECT group_name
                            FROM ad_user_group_memberships
                           WHERE domain_name = ? AND user_sam = ?
                           ORDER BY group_name`,
      // R158.60.22 (2026-10-09) — group members 直查. 跟 listGroupsForUser
      // 对称, 但按 group_name 查 user_sam 列表. Caller binds
      // [domain_name, group_name] (UI 传 group canonical name).
      // 大组 (Domain Users 8000+) 不在 ugm (R158.60.20.2 范围), 但业务组
      // (CDASZ 134 / 销售部-SC 76 等) 全有, UI 「移除成员」候选下拉依赖.
      listMembersForGroup: `SELECT user_sam
                              FROM ad_user_group_memberships
                             WHERE domain_name = ? AND LOWER(group_name) = LOWER(?)
                             ORDER BY user_sam`,
      // List recent runs (most recent first). Caller binds [limit].
      listRuns: `SELECT id, dc_name, started_at, finished_at, status,
                        user_count, group_count, ou_count, error_message, triggered_by
                 FROM ad_directory_sync_runs
                 ORDER BY started_at DESC
                 LIMIT ?`,
      // Most recent successful run. Used by /status for lastRun field.
      latestSuccess: `SELECT id, dc_name, started_at, finished_at, status,
                             user_count, group_count, ou_count, error_message
                      FROM ad_directory_sync_runs
                      WHERE status = 'success'
                      ORDER BY finished_at DESC
                      LIMIT 1`,

      // R158.38 — binding-driven LDAP sync: insertRun/upsert*/finalizeRun/listRuns
      // 各自多 2 个 ? 占位符 forest_id + domain_id. NULL 时 caller 必须走老 SQL (无森林维度).
      // ad-centre-binding.js tick() 路径走这些.
      insertRunWithForest: `INSERT INTO ad_directory_sync_runs (dc_name, started_at, status, triggered_by, forest_id, domain_id)
                            VALUES (?, UTC_TIMESTAMP(), 'running', ?, ?, ?)`,
      finalizeRunWithForest: `UPDATE ad_directory_sync_runs
                              SET finished_at = UTC_TIMESTAMP(),
                                  status = ?,
                                  user_count = ?,
                                  group_count = ?,
                                  ou_count = ?,
                                  computer_count = ?,
                                  error_message = ?
                              WHERE id = ?`,
      // 与 finalizeRun 同形 (7 params, R158.44.7.10 加 computer_count).
      // 当前 caller (tick) 不写回 forest_id/domain_id (runs 行 INSERT 时已带), finalize 路径只更新 counts + status.
      // 如未来要追溯, 加 forest_id = ? 即可; 现版保持轻.
      upsertUserWithForest: `INSERT INTO ad_users_snapshot
                                  (domain_name, sam, display_name, distinguished_name, ou_dn,
                                   enabled, locked_out, last_logon, when_created,
                                   password_last_set, user_account_control,
                                   description, manager_dn, manager_sam,
                                   snapshot_at, snapshot_run_id, forest_id, domain_id)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                ON DUPLICATE KEY UPDATE
                                  display_name = VALUES(display_name),
                                  distinguished_name = VALUES(distinguished_name),
                                  ou_dn = VALUES(ou_dn),
                                  enabled = VALUES(enabled),
                                  locked_out = VALUES(locked_out),
                                  last_logon = VALUES(last_logon),
                                  when_created = VALUES(when_created),
                                  password_last_set = VALUES(password_last_set),
                                  user_account_control = VALUES(user_account_control),
                                  description = VALUES(description),
                                  manager_dn = VALUES(manager_dn),
                                  manager_sam = VALUES(manager_sam),
                                  snapshot_at = VALUES(snapshot_at),
                                  snapshot_run_id = VALUES(snapshot_run_id),
                                  forest_id = VALUES(forest_id),
                                  domain_id = VALUES(domain_id)`,
      upsertGroupWithForest: `INSERT INTO ad_groups_snapshot
                                   (domain_name, name, sam_account_name, distinguished_name, ou_dn,
                                    group_type, group_scope, description, member_count,
                                    snapshot_at, snapshot_run_id, forest_id, domain_id)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE
                                   sam_account_name = VALUES(sam_account_name),
                                   distinguished_name = VALUES(distinguished_name),
                                   ou_dn = VALUES(ou_dn),
                                   group_type = VALUES(group_type),
                                   group_scope = VALUES(group_scope),
                                   description = VALUES(description),
                                   member_count = VALUES(member_count),
                                   snapshot_at = VALUES(snapshot_at),
                                   snapshot_run_id = VALUES(snapshot_run_id),
                                   forest_id = VALUES(forest_id),
                                   domain_id = VALUES(domain_id)`,
      upsertOuWithForest: `INSERT INTO ad_ous_snapshot
                                (domain_name, distinguished_name, name, description,
                                 when_created, when_changed, parent_dn,
                                 snapshot_at, snapshot_run_id, forest_id, domain_id)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                              ON DUPLICATE KEY UPDATE
                                name = VALUES(name),
                                description = VALUES(description),
                                when_created = VALUES(when_created),
                                when_changed = VALUES(when_changed),
                                parent_dn = VALUES(parent_dn),
                                snapshot_at = VALUES(snapshot_at),
                                snapshot_run_id = VALUES(snapshot_run_id),
                                forest_id = VALUES(forest_id),
                                domain_id = VALUES(domain_id)`,
      // R158.44.7.10 (2026-10-05) — UPSERT computer snapshot (with forest_id/domain_id).
      upsertComputerWithForest: `INSERT INTO ad_computers_snapshot
                                     (domain_name, sam_account_name, cn, name, distinguished_name, ou_dn,
                                      enabled, is_server,
                                      operating_system, operating_system_version, dns_host_name,
                                      last_logon, when_created, when_changed,
                                      description, managed_by_dn, managed_by_sam,
                                      snapshot_at, snapshot_run_id, forest_id, domain_id)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                   ON DUPLICATE KEY UPDATE
                                     cn = VALUES(cn),
                                     name = VALUES(name),
                                     distinguished_name = VALUES(distinguished_name),
                                     ou_dn = VALUES(ou_dn),
                                     enabled = VALUES(enabled),
                                     is_server = VALUES(is_server),
                                     operating_system = VALUES(operating_system),
                                     operating_system_version = VALUES(operating_system_version),
                                     dns_host_name = VALUES(dns_host_name),
                                     last_logon = VALUES(last_logon),
                                     when_created = VALUES(when_created),
                                     when_changed = VALUES(when_changed),
                                     description = VALUES(description),
                                     managed_by_dn = VALUES(managed_by_dn),
                                     managed_by_sam = VALUES(managed_by_sam),
                                     snapshot_at = VALUES(snapshot_at),
                                     snapshot_run_id = VALUES(snapshot_run_id),
                                     forest_id = VALUES(forest_id),
                                     domain_id = VALUES(domain_id)`,
      // JOIN forest / domain 取 forest_name / domain_name 让 /api/admin/directory-sync/runs 直接返 wire shape.
      listRunsWithForest: `SELECT r.id, r.dc_name, r.started_at, r.finished_at, r.status,
                                  r.user_count, r.group_count, r.ou_count, r.error_message, r.triggered_by,
                                  r.forest_id, r.domain_id,
                                  f.forest_name, d.domain_name
                           FROM ad_directory_sync_runs r
                           LEFT JOIN ad_forest f ON f.id = r.forest_id
                           LEFT JOIN ad_forest_domain d ON d.id = r.domain_id
                           ORDER BY r.started_at DESC
                           LIMIT ?`
    },
    // R158.37 — AD Forest Registry 物理表 CRUD (4 张表)
    forestRegistry,
    // R158.61 (2026-10-10) — daily/weekly report SQL. reportRun.listRecent
    // is `(limit) =>` so mssql/mysql can interpolate their native top-N
    // syntax (mssql TOP, mysql LIMIT). Params: [kind|null, kind|null, limit].
    reportSchedule,
    reportRun,
    reportSubscription,
    // R158.87 (2026-10-12) — system-settings 域: ad_feature_flags + ad_system_registration.
    featureFlags: featureFlags.mysql,
    systemRegistration: systemRegistration.mysql,
    // R158.88.B (2026-10-13) — rollout 编排 (7 helper, 跟 R158.87 featureFlags
    //   / systemRegistration precedent 1:1 平行). 0 改 fleet 端.
    rollout: rollout.mysql
  },
  mssql: {
    health: {
      ping: 'SELECT 1 AS ok',
      lastHeartbeat: 'SELECT TOP 1 last_heartbeat_at AS last FROM ad_agent_heartbeat ORDER BY last_heartbeat_at DESC'
    },
    replication: {
      upsertStatus: `MERGE INTO ad_replication_status AS t
         USING (SELECT
           CAST(? AS DATETIME2)       AS collected_at,
           CAST(? AS NVARCHAR(64))    AS agent_id,
           CAST(? AS NVARCHAR(128))   AS source_dc,
           CAST(? AS NVARCHAR(128))   AS dest_dc,
           CAST(? AS NVARCHAR(64))    AS source_site,
           CAST(? AS NVARCHAR(64))    AS dest_site,
           CAST(? AS NVARCHAR(128))   AS naming_context,
           CAST(? AS DATETIME2)       AS last_success_time,
           CAST(? AS DATETIME2)       AS last_attempt_time,
           ?                          AS status_code,
           CAST(? AS NVARCHAR(2048))  AS error_message,
           CAST(? AS NVARCHAR(MAX))   AS partner_port_status
         ) AS s
         ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           collected_at = s.collected_at,
           agent_id = s.agent_id,
           source_site = s.source_site,
           dest_site = s.dest_site,
           last_success_time = s.last_success_time,
           last_attempt_time = s.last_attempt_time,
           status_code = s.status_code,
           error_message = s.error_message,
           partner_port_status = s.partner_port_status
         WHEN NOT MATCHED THEN INSERT
           (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context, last_success_time, last_attempt_time, status_code, error_message, partner_port_status)
           VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.source_site, s.dest_site, s.naming_context, s.last_success_time, s.last_attempt_time, s.status_code, s.error_message, s.partner_port_status);`,
      upsertHistory: `INSERT INTO ad_replication_history (collected_at, agent_id, source_dc, dest_dc, naming_context, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, status_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // 2026-09-25 R93.4 — MSSQL TOP does not accept parameter binding (only
      // an integer literal). Until R93.4 the placeholder form `TOP (?)` was
      // bound through sp_executesql and raised error 1060 on every operator
      // request to the 复制状态概览 view. Function-form so the integer is
      // inlined; the MySQL sibling keeps `LIMIT ?` because mysql2 accepts it.
      listRecent: (limit) => `SELECT TOP ${clampRowLimit(limit)} source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status ORDER BY collected_at DESC`,
      listBySite: (limit) => `SELECT TOP ${clampRowLimit(limit)} source_dc, dest_dc, source_site, dest_site, status_code, collected_at FROM ad_replication_status WHERE source_site = ? OR dest_site = ? ORDER BY collected_at DESC`,
      // R151.3 — MSSQL mirror of mysql.replication.partnersCountBoth.
      // SUM(CASE WHEN …) is portable across both dialects; only the time
      // bound is rewritten (`? - INTERVAL ? MINUTE` → `DATEADD(MINUTE, -?, ?)`).
      // See the MySQL sibling for the full rationale.
      partnersCountBoth: `SELECT
          SUM(CASE WHEN dest_dc = ? THEN 1 ELSE 0 END)   AS inbound_count,
          SUM(CASE WHEN source_dc = ? THEN 1 ELSE 0 END) AS outbound_count
        FROM ad_replication_status t1
        WHERE t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2
                                  WHERE t2.source_dc = t1.source_dc
                                    AND t2.dest_dc = t1.dest_dc
                                    AND t2.naming_context = t1.naming_context)
          AND (t1.dest_dc = ? OR t1.source_dc = ?)
          AND t1.source_dc <> t1.dest_dc
          AND t1.naming_context NOT LIKE '__partner_ports__:%'
          AND t1.naming_context NOT IN ('__dc_summary__', 'META')
          AND t1.collected_at BETWEEN DATEADD(MINUTE, -?, ?) AND DATEADD(MINUTE, ?, ?)`,
      // R125 — MSSQL mirror of mysql.replication.replicationPartnersByAgent.
      // Same filter contract (latest-per-pair, exclude __partner_ports__%
      // + __dc_summary__ + META, 30-minute window) but uses DATEADD for
      // the time-bound so the SQL parses on SQL Server (no MySQL
      // INTERVAL syntax). The `?` placeholder is rewritten to @p1 by
      // the mssql driver wrapper at execute() time.
      replicationPartnersByAgent: (agentId) => `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code FROM ad_replication_status t1 WHERE t1.source_dc = ? AND t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.dest_dc`,
      // R158.scanfix-H6 (2026-10-20) — partnersCountBothAll: 一次查全站
      // inbound/outbound 伙伴计数, 取代 /api/dcs/summary 里逐 DC 串行
      // N+1 (旧代码 dcs.js:167-175, 34 台 DC = 34 次串行 round-trip,
      // 实测 611ms).
      //
      // 与 partnersCountBoth 的差异 —— 这才是关键:
      //   partnersCountBoth 每个 DC 用**自己的** collected_at 绑定时间窗
      //   (WHERE t1.collected_at BETWEEN ? - w AND ? + w), 所以每台 DC
      //   的"最近一个采集周期"基准不同, 无法用一条 SQL 统一表达.
      //   partnersCountBothAll 改用**单一全局基准** = MAX(collected_at)
      //   落在 WINDOW_MINUTES 之内的最新一次采集, 全站共用.
      //
      // 语义变化(必须知情): 各 DC 的时间基准从"各自 collected_at"变成
      // "全站最新 collected_at". 对正常部署(agent 采集节奏一致, 各 DC
      // collected_at 相差 < 一个周期)结果完全一致; 若某台 DC 掉线很久,
      // 旧实现会给它按自己的旧时间戳算, 新实现则按全站最新基准算 ——
      // 后者其实更符合"伙伴关系视图"的语义 (不拿一个陈旧快照当现状).
      //
      // 方向映射保持不变:
      //   inbound  = dest_dc   = 该 DC  (别人复制到我)
      //   outbound = source_dc = 该 DC  (我复制到别人)
      //
      // 合成行排除跟旧 helper 完全一致: __partner_ports__:% / __dc_summary__
      // / META + source_dc <> dest_dc 自环守卫.
      //
      // GROUP BY source_dc / dest_dc 各扫一遍, 在 JS 侧合并成每 DC 的
      // 入/出站计数, 避免 UNION ALL + CASE 的重复计.
      partnersCountBothAll: `SELECT src AS dc, SUM(is_in) AS inbound_count, SUM(is_out) AS outbound_count FROM (
          SELECT t1.source_dc AS src, t1.dest_dc AS peer,
                 CAST(0 AS INT) AS is_in,  CAST(1 AS INT) AS is_out
            FROM ad_replication_status t1
           WHERE t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2
                                     WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc
                                       AND t2.naming_context = t1.naming_context)
             AND t1.source_dc <> t1.dest_dc
             AND t1.naming_context NOT LIKE '__partner_ports__:%'
             AND t1.naming_context NOT IN ('__dc_summary__', 'META')
             AND t1.collected_at >= DATEADD(MINUTE, -?, SYSUTCDATETIME())
          UNION ALL
          SELECT t1.dest_dc AS src, t1.source_dc AS peer,
                 CAST(1 AS INT) AS is_in,  CAST(0 AS INT) AS is_out
            FROM ad_replication_status t1
           WHERE t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2
                                     WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc
                                       AND t2.naming_context = t1.naming_context)
             AND t1.source_dc <> t1.dest_dc
             AND t1.naming_context NOT LIKE '__partner_ports__:%'
             AND t1.naming_context NOT IN ('__dc_summary__', 'META')
             AND t1.collected_at >= DATEADD(MINUTE, -?, SYSUTCDATETIME())
      ) u GROUP BY src`,
      // R151.2 — MSSQL inbound mirror of replicationPartnersByAgent.
      // dest_dc = ? finds DCs that replicated TO me (the inbound direction
      // the agent needs to TCP-probe). Same freshness / synthetic-row
      // exclusions as the MySQL sibling above.
      inboundPartnersByAgent: (agentId) => `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code FROM ad_replication_status t1 WHERE t1.dest_dc = ? AND t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.source_dc`,
      // R155.4 — MSSQL mirror of mysql.replication.outboundPartnersByAgent.
      // Same freshness / synthetic-row exclusions / echo-loop guard
      // (see MySQL sibling for full rationale). Just the time-bound
      // is rewritten for SQL Server syntax.
      outboundPartnersByAgent: (agentId) => `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code FROM ad_replication_status t1 WHERE t1.source_dc = ? AND t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = (SELECT MAX(t2.collected_at) FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context) AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.dest_dc`,
      // R158.X.116.d (2026-10-22) — 删 upsertDcProbeOutbound (R155.4 引入)。
      //   与 MySQL 侧同批删除, 理由见上方 MySQL 段的注释 (表已 DROP、门控永假)。
      // R156 — MSSQL mirror of mysql.knownDcNames. See MySQL rationale.
      knownDcNames: `SELECT dc_name FROM ad_dcs WHERE decommissioned_at IS NULL AND monitoring_paused_at IS NULL`,
      // R156 — MSSQL MERGE for ad_partner_inbound. See MySQL sibling.
      // 5-param shape (collectedAt, agentId, sourceDc, destDc,
      // discoveredAt). UNIQUE(source_dc, dest_dc) is the merge key.
      upsertPartnerInbound: `MERGE INTO ad_partner_inbound AS t
         USING (SELECT
           CAST(? AS DATETIME2)       AS collected_at,
           CAST(? AS NVARCHAR(64))    AS agent_id,
           CAST(? AS NVARCHAR(128))   AS source_dc,
           CAST(? AS NVARCHAR(128))   AS dest_dc,
           CAST(? AS DATETIME2)       AS discovered_at
         ) AS s
         ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc
         WHEN MATCHED THEN UPDATE SET
           collected_at = s.collected_at,
           agent_id = s.agent_id,
           discovered_at = s.discovered_at
         WHEN NOT MATCHED THEN INSERT
           (collected_at, agent_id, source_dc, dest_dc, discovered_at)
           VALUES (s.collected_at, s.agent_id, s.source_dc, s.dest_dc, s.discovered_at);`,
      // R158.15 (2026-10-01) -- MSSQL mirror of inboundPartnersWarehouseByAgent.
      // Reads ad_partner_inbound (R158.14 / R158.11.5 warehouse). R155.6
      // ad_dc_inbound_partners was retired and never landed as a physical
      // table; ad_partner_inbound is the live source-of-truth.
      // 24h freshness window. Caller dedupes by peer_dc (= source_dc).
      inboundPartnersWarehouseByAgent: (agentId) => `SELECT source_dc AS peer_dc FROM ad_partner_inbound WHERE dest_dc = ? AND collected_at >= DATEADD(HOUR, -24, SYSUTCDATETIME()) GROUP BY source_dc ORDER BY source_dc`,
      // R158.15 -- MSSQL mirror of insertProbeHistory. Plain INSERT
      // (append-only). 12-param bind matching the MySQL sibling.
      insertProbeHistory: `INSERT INTO ad_replication_probe_history (collected_at, agent_id, source_dc, dest_dc, naming_context, attempt_at, result, status_code, duration_ms, objects_transferred, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // R158.10 (2026-10-01) — MSSQL upsertPartnerOutbound 删除
      //   (operator decision: outbound partner 不再需要)。
      // R156 — MSSQL mirror of pendingPartnerDiscovers. Same cadence
      // window (7 days) so an unconsumed trigger eventually rolls off.
      pendingPartnerDiscovers: `SELECT name, started_at FROM package_runs WHERE status = 'pending_trigger' AND started_at >= DATEADD(DAY, -7, SYSUTCDATETIME()) ORDER BY started_at`,
      // R158.64 (2026-10-10) — MSSQL mirror of MySQL replication.bySiteMatrix
      // (line 176). 同 shape, 同 GROUP BY (source_site, dest_site) + SUM
      // CASE. 排除 '\_\_%' 用 ESCAPE '\\' (MSSQL LIKE 转义反斜杠同 MySQL).
      // function-form: periodStart 由 caller 传 (reports.js periodStart =
      // now - 24h), 不是 SYSUTCDATETIME 派生.
      // R158.X.116.p (2026-10-23) — 站点名改从 ad_dcs→ad_sites catalog JOIN,
      // 不再读 agent 上报的自由文本 source_site/dest_site (旧命名体系
      // KDL-GuiYang vs 现行 site_name 康德乐贵阳)。与 MySQL 版严格 1:1 平行,
      // 理由见 sql.js:1133-1134 topologyNodes 同原则 + 该处注释。
      // ⚠ MSSQL GROUP BY 不能用 SELECT 别名 (line 3748 precedent), 故
      //   GROUP BY 内联 ss.site_name / ds.site_name 完整表达式。
      bySiteMatrix: ({ periodStart }) => {
        if (!(periodStart instanceof Date) && typeof periodStart !== 'string') {
          throw new Error('replication.bySiteMatrix: periodStart must be Date or ISO string');
        }
        const sql =
          `SELECT ss.site_name AS source_site, ds.site_name AS dest_site,
                  COUNT(*) AS link_count,
                  SUM(CASE WHEN t.status_code = 0 THEN 1 ELSE 0 END) AS healthy_count,
                  SUM(CASE WHEN t.status_code <> 0 THEN 1 ELSE 0 END) AS failing_count,
                  MAX(t.collected_at) AS last_probe_at
             FROM ad_replication_status t
             LEFT JOIN ad_dcs sd ON sd.dc_name = t.source_dc
             LEFT JOIN ad_sites ss ON ss.site_id = sd.site_id
             LEFT JOIN ad_dcs dd ON dd.dc_name = t.dest_dc
             LEFT JOIN ad_sites ds ON ds.site_id = dd.site_id
            WHERE t.collected_at >= ?
              AND ss.site_name IS NOT NULL
              AND ds.site_name IS NOT NULL
              AND t.naming_context NOT LIKE '\\_\\_%' ESCAPE '\\'
              AND t.naming_context <> 'META'
            GROUP BY ss.site_name, ds.site_name
            ORDER BY ss.site_name ASC, ds.site_name ASC`;
        return { sql, params: [periodStart] };
      },
      // R158.X.99.29.b (2026-10-19) — ad_replication_active_errors 新表.
      // 操作员 directive: "如果有问题则写入这个表, 如果恢复或者复制正常则
      // 会将当前行删除". 1:1 平行 R158.78/R158.86/R158.100 范式.
      //
      // 3 helper 必 mysql + mssql 1:1 平行 (R158.X.99.27 round 2 锁):
      //   - upsertActiveError: 失败时 INSERT/UPDATE (status=1/2 报上来)
      //   - removeActiveError: 成功时 DELETE (status=0 报上来, auto-remove)
      //   - listActiveErrors: 端点 SELECT (1:1 平行老 replicationErrors 3 窗口限)
      //
      // upsertActiveError 9 列 bind: sourceDc, destDc, namingContext, statusCode,
      // lastAttemptTime, firstSeenAt (init = lastAttemptTime), lastReportedAt,
      // reportedCount (init = 1), lastErrorMessage. MSSQL MERGE pattern
      // (跟 ad_replication_status.upsertStatus 1:1 平行 R93.4/R101 dialect precedent).
      // UNIQUE (source_dc, dest_dc, naming_context) 是 merge key.
      upsertActiveError: `MERGE INTO ad_replication_active_errors AS t
         USING (SELECT
           CAST(? AS NVARCHAR(128))   AS source_dc,
           CAST(? AS NVARCHAR(128))   AS dest_dc,
           CAST(? AS NVARCHAR(128))   AS naming_context,
           ?                          AS status_code,
           CAST(? AS DATETIME2)       AS last_attempt_time,
           CAST(? AS DATETIME2)       AS first_seen_at,
           CAST(? AS DATETIME2)       AS last_reported_at,
           1                          AS reported_count,
           CAST(? AS NVARCHAR(2048))  AS last_error_message
         ) AS s
         ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           status_code = s.status_code,
           last_attempt_time = s.last_attempt_time,
           last_reported_at = s.last_reported_at,
           reported_count = t.reported_count + 1,
           last_error_message = s.last_error_message
         WHEN NOT MATCHED THEN INSERT
           (source_dc, dest_dc, naming_context, status_code, last_attempt_time, first_seen_at, last_reported_at, reported_count, last_error_message)
           VALUES (s.source_dc, s.dest_dc, s.naming_context, s.status_code, s.last_attempt_time, s.first_seen_at, s.last_reported_at, s.reported_count, s.last_error_message);`,
      // removeActiveError 3 列 bind: sourceDc, destDc, namingContext.
      // 成功 status=0 时调, 整条 pair 真从新表消失 (操作员 "auto-remove" 锁).
      // MSSQL DELETE 跟 MySQL 同形, 跨 dialect 通用.
      removeActiveError: `DELETE FROM ad_replication_active_errors WHERE source_dc = ? AND dest_dc = ? AND naming_context = ?`,
      // listActiveErrors 函数式: hours (24h=24 / 7d=168) 或 null = 全部历史.
      // TOP 200 跟老 replicationErrors 端点 1:1 平行, 0 破 UI 200 行 hard cap.
      // R93.4 function-form precedent: MSSQL TOP 不接受 ? bind, 必内联 integer.
      // R158.X.116.p (2026-10-23) — hours=null 时整个时间下界子句缺席 (与
      // MySQL 版同形), 不拿极大值糊弄, 跟 MySQL 方言严格 1:1 平行。
      listActiveErrors: (hours) => `SELECT TOP 200 source_dc, dest_dc, naming_context, status_code,
                                last_attempt_time, first_seen_at, last_reported_at,
                                reported_count, last_error_message,
                                CASE WHEN first_seen_at IS NULL OR last_attempt_time IS NULL
                                     THEN NULL
                                     ELSE DATEDIFF(MILLISECOND, first_seen_at, last_attempt_time)
                                END AS duration_ms
                           FROM ad_replication_active_errors
                          WHERE status_code > 0
                            ${hours == null ? '' : 'AND last_attempt_time >= DATEADD(HOUR, -?, SYSUTCDATETIME())'}
                          ORDER BY last_attempt_time DESC`
    },
    dcOverview: {
      upsert: ({ collectedAt, agentId, dcName, siteId, usersCount, computersCount, serversCount, groupsCount, gposCount, partnerPortStatus }) => {
        // MSSQL MERGE pattern (R93.4 / R101 dialect precedent). ON uq_dc_overview_dc.
        // R158.44.7.8 — operator directive "DC overview 显示用户、电脑、服务器数量"
        // adds computers_count + servers_count columns.
        const sql = `MERGE INTO ad_dc_overview AS t
           USING (SELECT
             CAST(? AS NVARCHAR(128))   AS dc_name,
             CAST(? AS DATETIME2)       AS collected_at,
             CAST(? AS NVARCHAR(64))    AS agent_id,
             ?                          AS site_id,
             ?                          AS users_count,
             ?                          AS computers_count,
             ?                          AS servers_count,
             ?                          AS groups_count,
             ?                          AS gpos_count,
             CAST(? AS NVARCHAR(MAX))   AS partner_port_status
           ) AS s
           ON t.dc_name = s.dc_name
           WHEN MATCHED THEN UPDATE SET
             collected_at = s.collected_at,
             agent_id = s.agent_id,
             site_id = s.site_id,
             users_count = s.users_count,
             computers_count = s.computers_count,
             servers_count = s.servers_count,
             groups_count = s.groups_count,
             gpos_count = s.gpos_count,
             partner_port_status = s.partner_port_status
           WHEN NOT MATCHED THEN INSERT
             (collected_at, agent_id, dc_name, site_id, users_count, computers_count, servers_count, groups_count, gpos_count, partner_port_status)
             VALUES (s.collected_at, s.agent_id, s.dc_name, s.site_id,
                     s.users_count, s.computers_count, s.servers_count, s.groups_count, s.gpos_count, s.partner_port_status);`;
        return {
          sql,
          params: [
            dcName, collectedAt, agentId, siteId,
            usersCount, computersCount, serversCount, groupsCount, gposCount,
            partnerPortStatus == null ? null : JSON.stringify(partnerPortStatus)
          ]
        };
      },
      latestPerDc: ({ sinceHours = 24 } = {}) => {
        // R158.scanfix-H6 (2026-10-20) — CROSS APPLY + TOP 1 → INNER JOIN + MAX.
        //
        // 原形态 (跟 MySQL sibling 已修好的版本对比):
        //     CROSS APPLY (SELECT TOP 1 collected_at FROM ad_dc_overview
        //                    WHERE dc_name = d.dc_name ... ORDER BY collected_at DESC) m
        // 这是"latest-per-dc"的相关子查询 —— 对 ad_dc_overview 的**每一行**
        // 都要跑一次子查询. ad_dc_overview 是 34 台 DC × 15min cadence × 24h
        // ≈ 3,264 行, 于是 3,264 次子查询, 而且 dc_name 上没索引时每次都是
        // 顺序扫.
        //
        // MySQL 分支 (sql.js:401-412) 早就改成了
        //     INNER JOIN (SELECT dc_name, MAX(collected_at) ... GROUP BY dc_name)
        // 一次聚合 + 一次连接. MSSQL 分支漏改 —— 这是本项目里第三次出现
        // 同一形态的方言不对称 (见 member-eventlog.js H1、dashboard.js:378).
        //
        // 新形态与 MySQL 分支 1:1 平行, 仅时间函数不同:
        //     NOW() - INTERVAL ? HOUR              → MySQL
        //     DATEADD(HOUR, -?, CAST(SYSUTCDATETIME() AS DATETIME2))  → MSSQL
        // 保留 CAST(... AS DATETIME2), 因为 ad_dc_overview.collected_at 是
        // DATETIME2 列, 不 CAST 会触发 datetime2 隐式转换歧义.
        //
        // 实测: /api/dcs/summary 611ms → 见 ship 记录.
        const sql = `SELECT d.dc_name, d.collected_at, d.site_id,
                            d.users_count, d.computers_count, d.servers_count, d.groups_count, d.gpos_count, d.partner_port_status,
                            s.site_name
                     FROM ad_dc_overview d
                     LEFT JOIN ad_sites s ON s.site_id = d.site_id
                     INNER JOIN (
                       SELECT dc_name, MAX(collected_at) AS max_collected
                       FROM ad_dc_overview
                       WHERE collected_at >= DATEADD(HOUR, -?, CAST(SYSUTCDATETIME() AS DATETIME2))
                       GROUP BY dc_name
                     ) m ON m.dc_name = d.dc_name AND m.max_collected = d.collected_at
                     ORDER BY d.dc_name`;
        return { sql, params: [sinceHours] };
      },
      // R158.69.x (2026-10-10) — MSSQL mirror of latestPerDcWithHeartbeat.
      //   CROSS APPLY window 保留 (R158.44.7 idiom), ad_dcs 真源走 LEFT JOIN,
      //   ad_agent_heartbeat 真源走 LEFT JOIN, COALESCE fallback 跟 MySQL sibling
      //   一致. 字段全集跟 MySQL sibling 一致.
      // R158.X.116 (2026-10-22) — 加 is_online 三值判定 (1/0/NULL), staleMinutes
      //   阈值参数化 (默认 5, 跟 web/src/views/AgentsView.vue:44 的
      //   ONLINE_WINDOW_MS = 5*60*1000 对齐 —— 操作员 directive: 日报/周报
      //   的 agent 状态跟随 /agents 页面). 修前 reports.js 自己算
      //   `last_heartbeat_at != null`, 而 ad_agent_heartbeat 是 UPSERT 覆盖式
      //   快照表 (行不删 / last_heartbeat_at 永不置 NULL) → 判据恒真, 离线 DC
      //   全部显示「● 正常」. 三值语义: 1=在线 / 0=离线(有历史但不新鲜) /
      //   NULL=从未心跳 —— 区分「曾经在线现在掉了」与「从来没上线过」, 后者
      //   没有离线时长可言.
      latestPerDcWithHeartbeat: ({ sinceHours = 24, staleMinutes = 5 } = {}) => {
        const sql = `SELECT d.dc_name, d.collected_at, d.site_id,
                            d.users_count, d.computers_count, d.servers_count,
                            d.groups_count, d.gpos_count, d.partner_port_status,
                            s.site_name, s.is_hub,
                            dc.is_pdc,
                            h.last_heartbeat_at AS last_heartbeat_at,
                            CASE
                              WHEN h.last_heartbeat_at IS NULL THEN NULL
                              WHEN h.last_heartbeat_at
                                   >= DATEADD(MINUTE, -?, CAST(SYSUTCDATETIME() AS DATETIME2)) THEN 1
                              ELSE 0
                            END AS is_online
                       FROM ad_dc_overview d
                       LEFT JOIN ad_sites s ON s.site_id = d.site_id
                       LEFT JOIN ad_dcs dc ON dc.dc_name = d.dc_name
                       LEFT JOIN ad_agent_heartbeat h ON h.agent_id = d.dc_name
                                                  AND h.agent_id <> '__healthcheck__'
                       CROSS APPLY (
                         SELECT TOP 1 collected_at AS max_collected
                         FROM ad_dc_overview
                         WHERE dc_name = d.dc_name
                           AND collected_at >= DATEADD(HOUR, -?, CAST(SYSUTCDATETIME() AS DATETIME2))
                         ORDER BY collected_at DESC
                       ) m
                       WHERE d.collected_at = m.max_collected
                       ORDER BY d.dc_name`;
        return { sql, params: [staleMinutes, sinceHours] };
      },
      // R158.69.x — MSSQL mirror of healthSummaryWithHeartbeat.
      //   6 KPI aggregate, CROSS APPLY window 跟 sibling 一致.
      // params: { sinceMs = 0 } — periodStart UTC ms; stale_reachable 阈值 = periodStart
      // R158.X.116 (2026-10-22) — reachable/unreachable 改按 staleMinutes 新鲜度
      //   判 (修前只判 IS NOT NULL, UPSERT 快照表上恒 true → unreachable 恒 0).
      //   CROSS APPLY 补 windowHours 窗口 (跟 latestPerDcWithHeartbeat 对齐,
      //   修前 KPI totalDcs 取全历史 MAX(collected_at) ≠ 明细行数之和, 周报
      //   168h 窗口下差得最多).
      healthSummaryWithHeartbeat: ({ sinceMs = 0, staleMinutes = 5, windowHours = 0 } = {}) => {
        const sql = `SELECT COUNT(*) AS total_dcs,
                            SUM(CASE WHEN h.last_heartbeat_at
                                      >= DATEADD(MINUTE, -?, CAST(SYSUTCDATETIME() AS DATETIME2))
                                     THEN 1 ELSE 0 END) AS reachable,
                            SUM(CASE WHEN h.last_heartbeat_at IS NULL
                                      OR h.last_heartbeat_at
                                      < DATEADD(MINUTE, -?, CAST(SYSUTCDATETIME() AS DATETIME2))
                                     THEN 1 ELSE 0 END) AS unreachable,
                            SUM(CASE WHEN COALESCE(dc.is_pdc, 0) = 1 THEN 1 ELSE 0 END) AS pdc_count,
                            SUM(CASE WHEN COALESCE(s.is_hub, 0) = 1 THEN 1 ELSE 0 END) AS hub_count,
                            SUM(CASE WHEN h.last_heartbeat_at IS NOT NULL
                                      AND h.last_heartbeat_at < ? THEN 1 ELSE 0 END) AS stale_reachable
                       FROM ad_dc_overview d
                       LEFT JOIN ad_sites s ON s.site_id = d.site_id
                       LEFT JOIN ad_dcs dc ON dc.dc_name = d.dc_name
                       LEFT JOIN ad_agent_heartbeat h ON h.agent_id = d.dc_name
                                                  AND h.agent_id <> '__healthcheck__'
                       CROSS APPLY (
                         SELECT TOP 1 collected_at AS max_collected
                         FROM ad_dc_overview
                         WHERE dc_name = d.dc_name
                           AND collected_at >= DATEADD(HOUR, -?, CAST(SYSUTCDATETIME() AS DATETIME2))
                         ORDER BY collected_at DESC
                       ) m
                       WHERE d.collected_at = m.max_collected`;
        return {
          sql,
          params: [staleMinutes, staleMinutes, new Date(sinceMs).toISOString(), windowHours]
        };
      }
    },
    // R158.47 — MSSQL mirror of adminMembers (operator "提取 domain admins
    // enterprise admins 管理员成员"). MERGE ON (domain_dn, group_name,
    // member_sam) collapses duplicate reports across DCs at the centre.
    // Same R110.A public-table contract (no pkg_ prefix, manifest omits
    // database block). See MySQL block above for the full rationale.
    //
    // R161.3 (2026-10-25) — ON 子句改用**哈希列** domain_dn_hash.
    //   真因: ad_admin_members.domain_dn 是 NVARCHAR(1024) = 2050 字节, 超过
    //   SQL Server 非聚集索引键上限 1700 ⇒ 这列**进不了任何索引**。唯一键
    //   只能建在 (domain_dn_hash, group_name, member_sam) 上 (hash 是
    //   PERSISTED 计算列, 32 字节)。于是 ON 子句若还比原始 domain_dn,
    //   优化器**没有索引可用** ⇒ 每条 MERGE 全表扫 ⇒ ETL 逐行 upsert 是
    //   O(N²)。实测 (3000 行表 / 300 条 MERGE): 原始列 1872ms vs 哈希列
    //   181ms, 差 10.4 倍; 外推到 3 万行 ≈ 半小时 → 必须改。
    //   源侧用 s.* 包一层再算哈希, 这样**不新增占位符**, 参数顺序不变。
    //   MySQL 侧不用改: ON DUPLICATE KEY UPDATE 靠唯一键自己判定重复,
    //   走的正是 (domain_dn_hash, group_name, member_sam)。
    adminMembers: {
      upsert: ({ domainDn, groupName, memberSam, memberDn, memberEnabled, collectedAt, dcName, runId, displayName }) => {
        const sql = `MERGE INTO ad_admin_members AS t
           USING (SELECT s.*,
                    CONVERT(BINARY(32), HASHBYTES('SHA2_256', s.domain_dn)) AS domain_dn_hash
             FROM (SELECT
               CAST(? AS NVARCHAR(1024)) AS domain_dn,
               CAST(? AS NVARCHAR(64))   AS group_name,
               CAST(? AS NVARCHAR(256))  AS member_sam,
               CAST(? AS NVARCHAR(1024)) AS member_dn,
               ?                          AS member_enabled,
               CAST(? AS DATETIME2)       AS collected_at,
               CAST(? AS NVARCHAR(128))  AS dc_name,
               ?                          AS run_id,
               CAST(? AS NVARCHAR(255))   AS display_name
             ) AS s
           ) AS src
           ON t.domain_dn_hash = src.domain_dn_hash AND t.group_name = src.group_name AND t.member_sam = src.member_sam
           WHEN MATCHED THEN UPDATE SET
             member_dn = src.member_dn,
             member_enabled = src.member_enabled,
             collected_at = src.collected_at,
             display_name = src.display_name
           -- R158.69.9 (2026-10-11) — dc_name/run_id 不在 MERGE UPDATE SET 列表.
           -- 真因: 多 DC 都报同一 admin member 时, 后面 DC 写入会覆盖 dc_name=
           --   s.dc_name, run_id=s.run_id, 丢失"哪个 DC 首次发现"的 audit 信息.
           --   dashboard summary 用 MAX(collected_at) GROUP BY group_name 拿
           --   member_count 不查 dc_name/run_id, 所以数字仍正确. 字段只在
           --   NOT MATCHED INSERT 时设一次 (= 首次发现那个 DC + run).
           -- R158.69.10 (2026-10-11) — display_name 加入 MERGE UPDATE SET
           --   (跟 dc_name/run_id 不同: display_name 算 enrichable 列, 应
           --   保留最新 enrich 值).
           WHEN NOT MATCHED THEN INSERT
             (domain_dn, group_name, member_sam, member_dn, member_enabled, collected_at, dc_name, run_id, display_name)
             VALUES (src.domain_dn, src.group_name, src.member_sam, src.member_dn, src.member_enabled, src.collected_at, src.dc_name, src.run_id, src.display_name);`;
        return {
          sql,
          params: [domainDn, groupName, memberSam, memberDn, memberEnabled, collectedAt, dcName, runId, displayName ?? null]
        };
      },
      summary: () => {
        const sql = `SELECT group_name, COUNT(*) AS member_count
         FROM ad_admin_members m
         WHERE m.collected_at = (
           SELECT MAX(m2.collected_at) FROM ad_admin_members m2
           WHERE m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name
         )
         GROUP BY group_name`;
        return { sql, params: [] };
      },
      // R158.47.2 (2026-10-06) — MSSQL mirror of MySQL distinctSummary above.
      // SQL char-级一致 (MSSQL 关联子查询 + IN-list 字符串字面量合法). 同 L4 hygiene:
      // route 层不再 inline 跨 dialect raw SQL.
      distinctSummary: ({ groupNames }) => {
        if (!Array.isArray(groupNames) || groupNames.length === 0) {
          throw new Error('adminMembers.distinctSummary: groupNames required');
        }
        const placeholders = groupNames.map(() => '?').join(',');
        const sql = `SELECT COUNT(DISTINCT m.member_sam) AS distinct_count
           FROM ad_admin_members m
           WHERE m.group_name IN (${placeholders})
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_admin_members m2
               WHERE m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name
             )`;
        return { sql, params: groupNames };
      },
      // R158.69.10 (2026-10-11) — MSSQL mirror of MySQL listByGroup above.
      //   SQL char-级一致 (MSSQL 关联子查询合法).
      listByGroup: ({ groupName }) => {
        const sql = `SELECT
             member_sam AS sam,
             COALESCE(display_name, '') AS display_name,
             member_dn AS distinguished_name,
             group_name,
             dc_name,
             collected_at
           FROM ad_admin_members m
           WHERE m.group_name = ?
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_admin_members m2
               WHERE m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name
             )
           ORDER BY m.member_sam`;
        return { sql, params: [groupName] };
      },
      // R158.69.10 — MSSQL mirror of lookupDisplayName (TOP 1 + ORDER BY).
      lookupDisplayName: ({ sam }) => {
        const sql = `SELECT TOP 1 display_name FROM ad_users_snapshot
           WHERE sam = ? AND display_name IS NOT NULL
           ORDER BY display_name`;
        return { sql, params: [sam] };
      }
    },
    // R158.100 (2026-10-13) — MSSQL mirror of memberAdminGroups. 跟 MySQL block
    //   char-级一致: MERGE ON (hostname, group_name, member_sid) 自动 dedup.
    //   0 FK 强制. 0 enrich (R158.100 member_server 0 跨域).
    memberAdminGroups: {
      upsert: ({ hostname, groupName, memberSid, memberName, memberClass, principalSource, isEnabled, displayName, collectedAt, runId }) => {
        const sql = `MERGE INTO ad_member_admin_groups AS t
           USING (SELECT
             CAST(? AS NVARCHAR(128)) AS hostname,
             CAST(? AS NVARCHAR(64))  AS group_name,
             CAST(? AS NVARCHAR(128)) AS member_sid,
             CAST(? AS NVARCHAR(256)) AS member_name,
             CAST(? AS NVARCHAR(16))  AS member_class,
             CAST(? AS NVARCHAR(16))  AS principal_source,
             ?                          AS is_enabled,
             CAST(? AS NVARCHAR(256)) AS display_name,
             CAST(? AS DATETIME2)      AS collected_at,
             ?                          AS run_id
           ) AS s
           ON t.hostname = s.hostname AND t.group_name = s.group_name AND t.member_sid = s.member_sid
           WHEN MATCHED THEN UPDATE SET
             member_name = s.member_name,
             member_class = s.member_class,
             principal_source = s.principal_source,
             is_enabled = s.is_enabled,
             display_name = s.display_name,
             collected_at = s.collected_at
           -- R158.69.9 (2026-10-11) — hostname/run_id 不在 MERGE UPDATE SET 列表.
           --   真因: 跨 re-run 时, 后面 run 写入会覆盖 hostname + run_id, 丢失
           --   "哪个 run 首次发现" 的 audit 信息. 字段只在 NOT MATCHED INSERT
           --   时设一次.
           -- R158.100 — display_name 走 collect.ps1 enrich (Get-LocalUser.FullName),
           --   中心端不再 enrich.
           WHEN NOT MATCHED THEN INSERT
             (hostname, group_name, member_sid, member_name, member_class, principal_source, is_enabled, display_name, collected_at, run_id)
             VALUES (s.hostname, s.group_name, s.member_sid, s.member_name, s.member_class, s.principal_source, s.is_enabled, s.display_name, s.collected_at, s.run_id);`;
        return {
          sql,
          params: [hostname, groupName, memberSid, memberName ?? null, memberClass ?? null, principalSource ?? null, isEnabled ?? null, displayName ?? null, collectedAt, runId ?? null]
        };
      },
      summary: () => {
        const sql = `SELECT hostname, group_name, COUNT(*) AS member_count
         FROM ad_member_admin_groups m
         WHERE m.collected_at = (
           SELECT MAX(m2.collected_at) FROM ad_member_admin_groups m2
           WHERE m2.hostname = m.hostname AND m2.group_name = m.group_name
         )
         GROUP BY hostname, group_name`;
        return { sql, params: [] };
      },
      listByHostname: ({ hostname }) => {
        const sql = `SELECT
             hostname,
             group_name,
             member_sid,
             member_name,
             member_class,
             principal_source,
             is_enabled,
             display_name,
             collected_at
           FROM ad_member_admin_groups m
           WHERE m.hostname = ?
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_member_admin_groups m2
               WHERE m2.hostname = m.hostname AND m2.group_name = m.group_name
             )
           ORDER BY m.group_name, m.member_name`;
        return { sql, params: [hostname] };
      },
      listByGroup: ({ hostname, groupName }) => {
        const sql = `SELECT
             member_sid,
             COALESCE(display_name, '') AS display_name,
             member_name,
             member_class,
             principal_source,
             is_enabled,
             collected_at
           FROM ad_member_admin_groups m
           WHERE m.hostname = ?
             AND m.group_name = ?
             AND m.collected_at = (
               SELECT MAX(m2.collected_at) FROM ad_member_admin_groups m2
               WHERE m2.hostname = m.hostname AND m2.group_name = m.group_name
             )
           ORDER BY m.member_name`;
        return { sql, params: [hostname, groupName] };
      }
    },
    // R158.72 (2026-10-11) — MSSQL mirror of ad_accountChange above.
    //   跟 MySQL block char-级一致: MERGE ON (sam, action, change_date)
    //   自动 dedup; trendByDay GROUP BY (action, change_date); dailyTopByAction
    //   TOP 50 (用 OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY); deleteOlderThan
    //   TOP (5000) cap. 全 `?` placeholder, driver rewrite @p1,@p2.
    adAccountChange: {
      upsert: ({ sam, displayName, action, createdAt, modifiedAt, changeDate, domainDn, dcName, collectedAt, operatorUser }) => {
        // R158.72.x.4 (2026-10-16) — +1 字段 operator_user (事件 Properties[4]
        //   SubjectUserName, NVARCHAR(128) NULL). MERGE 公共表 dedup key 仍
        //   (sam, action, change_date), operator_user 走 WHEN MATCHED UPDATE
        //   1:1 同步 (跟 modified_at/display_name 1:1 平行).
        const sql = `MERGE INTO ad_account_change AS t
           USING (SELECT
             CAST(? AS NVARCHAR(256))  AS sam,
             CAST(? AS NVARCHAR(255))  AS display_name,
             CAST(? AS VARCHAR(16))    AS action,
             CAST(? AS DATETIME2)      AS created_at,
             CAST(? AS DATETIME2)      AS modified_at,
             CAST(? AS DATE)           AS change_date,
             CAST(? AS NVARCHAR(1024)) AS domain_dn,
             CAST(? AS NVARCHAR(128))  AS dc_name,
             CAST(? AS DATETIME2)      AS collected_at,
             CAST(? AS NVARCHAR(128))  AS operator_user
           ) AS s
           ON t.sam = s.sam AND t.action = s.action AND t.change_date = s.change_date
           WHEN MATCHED THEN UPDATE SET
             display_name = s.display_name,
             modified_at  = s.modified_at,
             domain_dn    = s.domain_dn,
             collected_at = s.collected_at,
             operator_user = s.operator_user
           WHEN NOT MATCHED THEN INSERT
             (sam, display_name, action, created_at, modified_at, change_date, domain_dn, dc_name, collected_at, operator_user)
             VALUES (s.sam, s.display_name, s.action, s.created_at, s.modified_at, s.change_date, s.domain_dn, s.dc_name, s.collected_at, s.operator_user);`;
        return { sql, params: [sam, displayName, action, createdAt, modifiedAt, changeDate, domainDn, dcName, collectedAt, operatorUser] };
      },
      // R158.111 (2026-10-16) — MSSQL mirror of MySQL trendByDay (R158.111).
      //   加 actions: string[] 白名单 filter, IN-clause 5 schema 真值.
      trendByDay: ({ days, actions = null } = {}) => {
        const VALID_ACTIONS = ['created','modified','deleted','enabled','disabled'];
        const safeActions = Array.isArray(actions) && actions.length > 0
          ? actions.filter((a) => VALID_ACTIONS.includes(a))
          : null;
        const clauses = ['change_date >= DATEADD(DAY, -?, CAST(GETUTCDATE() AS DATE))'];
        const params = [days];
        if (safeActions && safeActions.length > 0) {
          clauses.push(`action IN (${safeActions.map(() => '?').join(',')})`);
          params.push(...safeActions);
        }
        const sql = `SELECT action, change_date AS bucket_day, COUNT(*) AS event_count
                 FROM ad_account_change
                 WHERE ${clauses.join(' AND ')}
                 GROUP BY action, change_date
                 ORDER BY change_date ASC, action ASC`;
        return { sql, params };
      },
      // R158.111.a (2026-10-16) — MSSQL mirror of MySQL adAccountChange.listAll
      // (sql.js:625 紧跟 trendByDay 之后). 0 过滤 (用户 directive). OFFSET/
      // FETCH 跟 R158.65.6 1:1 平行. sinceHours cap 720 (30d, 跟
      // ad_mgmt_retention_days=30 1:1). bind 顺序:
      //   [days if any, dcName if any, searchLike×2 if any, offset, limit]
      listAll: ({ sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}) => {
        if (limit < 1 || limit > 500) {
          throw new Error(`adAccountChange.listAll: limit must be in [1,500], got ${limit}`);
        }
        if (offset < 0) {
          throw new Error(`adAccountChange.listAll: offset must be >= 0, got ${offset}`);
        }
        if (sinceHours !== null && (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 720)) {
          throw new Error(`adAccountChange.listAll: sinceHours must be null or int in [1,720], got ${sinceHours}`);
        }
        const clauses = [];
        const params = [];
        if (sinceHours !== null) {
          const days = Math.ceil(sinceHours / 24);
          clauses.push('a.change_date >= DATEADD(DAY, -?, CAST(GETUTCDATE() AS DATE))');
          params.push(days);
        }
        if (dcName) { clauses.push('a.dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push("(a.sam LIKE ? OR COALESCE(a.display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        params.push(offset, limit);
        const sql =
          `SELECT a.sam,
                  COALESCE(a.display_name, '') AS display_name,
                  a.action,
                  a.change_date,
                  a.created_at,
                  a.modified_at,
                  a.dc_name,
                  COALESCE(a.operator_user, '') AS operator_user
             FROM ad_account_change a
            ${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY a.change_date DESC, COALESCE(a.modified_at, a.created_at) DESC
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`;
        return { sql, params };
      },
      dailyTopByAction: ({ action, limit = 50 }) => {
        // R158.17.5 — MSSQL 不接受参数化 TOP (driver error). 跟 eventlog
        //   mirror 同 precedent: clampInt 整数夹紧 → inline TOP. router 端
        //   通过 clampInt(MIN_LIMIT..MAX_LIMIT) 整数夹紧, server-side resolve.
        // R158.72.x.4 (2026-10-16) — +1 列 operator_user (跟 6 列 1:1 平行,
        //   AccountChangeDetailView 8 列 "操作人").
        // R158.X.99.20 (2026-10-19) — 「当日」改 **UTC 昨天**, 1:1 平行
        //   mysql 段 (DATEADD(DAY, -1, ...) ≡ DATE_SUB(CURDATE(), INTERVAL 1 DAY)).
        const safeLimit = Math.max(1, Math.min(200000, Number.parseInt(limit, 10) || 50));
        const sql = `SELECT TOP ${safeLimit} sam, COALESCE(display_name, '') AS display_name,
                 created_at, modified_at, change_date, dc_name, COALESCE(operator_user, '') AS operator_user
                 FROM ad_account_change
                 WHERE action = CAST(? AS VARCHAR(16))
                   AND change_date = DATEADD(DAY, -1, CAST(GETUTCDATE() AS DATE))
                 ORDER BY COALESCE(modified_at, created_at) DESC`;
        return { sql, params: [action] };
      },
      deleteOlderThan: {
        mysql: `DELETE FROM ad_account_change
                WHERE change_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
                LIMIT 5000`,
        mssql: `DELETE TOP (5000) FROM ad_account_change
                WHERE change_date < DATEADD(DAY, -?, CAST(GETUTCDATE() AS DATE))`
      }
    },
    // R110.B — MSSQL mirror of the generic v2-metric-table latest-per-agent
    // helper. Same shape as the MySQL block: parameterised schemaName +
    // column whitelist, OUTER APPLY TOP 1 idiom (mirrors the consistency
    // block above). Bracketed [schemaName].[metrics] form is MSSQL-canonical.
    metricstore: {
      latestPerAgent: ({ schemaName, columns }) => {
        if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
          throw new Error(`metricstore.latestPerAgent: invalid schemaName ${schemaName}`);
        }
        if (!Array.isArray(columns) || columns.length === 0) {
          throw new Error('metricstore.latestPerAgent: columns required');
        }
        const safeColumns = columns.filter(c => /^[a-z][a-z0-9_]*$/.test(c));
        if (safeColumns.length !== columns.length) {
          throw new Error('metricstore.latestPerAgent: invalid column name(s)');
        }
        const colList = ['m.agent_id', 'm.ts', ...safeColumns.map(c => `m.${c}`)].join(', ');
        // R158.scanfix-H6b (2026-10-20) — OUTER APPLY + TOP 1 → JOIN 派生表.
        //
        // 原形态对 [pkg_*].[metrics] 的**每一行**跑一次子查询取该 agent 的
        // 最新 ts. 这是 metricstore 里被 /api/dcs/summary 调用的那一条
        // (dcs.js:80, LOCKOUT_SCHEMA = pkg_ad_lockout_summary), 实测单条
        // 613ms —— 是 dcs/summary 端点耗时的**全部**来源.
        //
        // MySQL sibling (sql.js:814-820) 早就写对了:
        //     WHERE (m.agent_id, m.ts) IN (SELECT agent_id, MAX(ts) ... GROUP BY agent_id)
        // MSSQL 分支漏改 —— 这是本项目**第四次**同一形态的方言不对称
        // (前三次: os-baseline-metrics.js / member-eventlog.js H1 /
        //  dcOverview.latestPerDc H6).
        //
        // MSSQL 不用 MySQL 的行构造器 (agent_id, ts) IN (...), 改用等价的
        // INNER JOIN + MAX(ts) GROUP BY 派生表 —— 与 os-baseline-metrics.js
        // R158 早前那次重写、以及 dcOverview.latestPerDc 本次重写完全同形,
        // 三处统一到同一个 idiom.
        //
        // 语义等价: OUTER APPLY + TOP 1 与 INNER JOIN + MAX 都取"每 agent
        // 最新一行"; 差别只在 agent 无数据时 OUTER APPLY 会保留外层行(NULL),
        // 而这里 GROUP BY 子查询本身就没有该 agent → 结果同样不含该 agent.
        // 本调用方 (dcs.js lockedByAgent) 本来就按 agent_id 建 Map 后查,
        // 缺失即 0/null, 行为一致.
        const sql = `SELECT ${colList}
                     FROM [${schemaName}].[metrics] m
                     INNER JOIN (
                       SELECT agent_id, MAX(ts) AS max_ts
                       FROM [${schemaName}].[metrics]
                       GROUP BY agent_id
                     ) la ON la.agent_id = m.agent_id AND la.max_ts = m.ts`;
        return { sql, params: [] };
      }
    },
    discovery: {
      // 2026-08-25 Bug C: tedious driver rejects row-constructor params
      // (`USING (VALUES (?, ?, ...))`) when ANY NVARCHAR column is NULL.
      // site_hint and os_version are nullable NVARCHAR(64); when an agent
      // reports a DC and either field is null, the driver throws
      // "Validation failed for parameter 'pN'. Invalid string" before
      // SQL Server sees the query, and the row silently never lands —
      // which is why freshly-installed agents' DCs never appear in the
      // 域控清单 (admin → AD 域控清单). Rewrite to the same
      // `USING (SELECT CAST(? AS TYPE) AS col, ...)` subquery pattern
      // already proven in upsertStatus (line 405). The tedious driver
      // validates NVARCHAR params correctly when each one is bound via
      // its own named CAST in a subquery.
      //
      // Column types match db/schema/mssql/01-tables.sql:78-97:
      //   dc_name NVARCHAR(128) PK, site_hint NVARCHAR(64) NULL,
      //   os_version NVARCHAR(64) NULL, when_created DATETIME2 NULL,
      //   is_* BIT NOT NULL (8 role flags), discovered_at DATETIME2,
      //   discovered_by_agent_id NVARCHAR(64) NULL.
      upsertDc: `MERGE INTO ad_dcs AS t
         USING (SELECT
           CAST(? AS NVARCHAR(128))   AS dc_name,
           CAST(? AS NVARCHAR(64))    AS site_hint,
           CAST(? AS NVARCHAR(64))    AS os_version,
           CAST(? AS DATETIME2)       AS when_created,
           ?                          AS is_pdc,
           ?                          AS is_gc,
           ?                          AS is_rid_master,
           ?                          AS is_schema_master,
           ?                          AS is_domain_naming_master,
           ?                          AS is_infrastructure_master,
           CAST(? AS DATETIME2)       AS discovered_at,
           CAST(? AS NVARCHAR(64))    AS discovered_by_agent_id
         ) AS s
         ON t.dc_name = s.dc_name
         WHEN MATCHED THEN UPDATE SET
           site_hint = s.site_hint,
           os_version = s.os_version,
           when_created = s.when_created,
           is_pdc = s.is_pdc,
           is_gc = s.is_gc,
           is_rid_master = s.is_rid_master,
           is_schema_master = s.is_schema_master,
           is_domain_naming_master = s.is_domain_naming_master,
           is_infrastructure_master = s.is_infrastructure_master,
           discovered_at = SYSUTCDATETIME(),
           discovered_by_agent_id = s.discovered_by_agent_id
         WHEN NOT MATCHED THEN INSERT
           (dc_name, site_hint, os_version, when_created, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id)
           VALUES (s.dc_name, s.site_hint, s.os_version, s.when_created, s.is_pdc, s.is_gc, s.is_rid_master, s.is_schema_master, s.is_domain_naming_master, s.is_infrastructure_master, s.discovered_at, s.discovered_by_agent_id);`
    },
    users: {
      findByUsername: `SELECT TOP 1 u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name, STRING_AGG(rp.permission, ',') AS permissions FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE u.username = ? GROUP BY u.id, u.username, u.password_hash, u.role_id, u.status, u.token_version, r.role_name`,
      list: 'SELECT u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id',
      create: 'INSERT INTO sys_users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)',
      update: 'UPDATE sys_users SET password_hash = COALESCE(?, password_hash), role_id = COALESCE(?, role_id), status = COALESCE(?, status) WHERE id = ?',
      delete: 'DELETE FROM sys_users WHERE id = ?',
      recordLogin: 'UPDATE sys_users SET last_login_at = SYSUTCDATETIME() WHERE id = ?',
      // I1 token_version: must use `?` so the driver wrapper rewrites to @p1
      // and binds via request.input('p1', ...). The MSSQL driver (see
      // drivers/mssql.js:16-28) only rewrites `?` → `@pN` and binds inputs
      // named `pN`; literal `@id` is never declared and raises "Must declare
      // the scalar variable @id" on real MSSQL. Mirrors the MySQL section.
      bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?',
      getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = ?',
      getAuthStatus: 'SELECT token_version, status FROM sys_users WHERE id = ?',
      countAdmins: `SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'`,
      createAdmin: 'INSERT INTO sys_users (username, password_hash, role_id) SELECT ?, ?, id FROM sys_roles WHERE role_name = \'admin\'',
      count: 'SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = \'admin\'',
      // R158.104 (2026-10-14) — self-service Profile endpoint. Same as
      // findByUsername MINUS password_hash + token_version. MSSQL flavour:
      //   · TOP 1 instead of LIMIT 1
      //   · I1 token_version lesson (`?` not `@id`) so the mssql driver
      //     wrapper rewrites to @p1 + binds via request.input('p1', ...).
      meProfile: `SELECT TOP 1 u.id, u.username, u.role_id, u.status, u.last_login_at, u.created_at, r.role_name FROM sys_users u LEFT JOIN sys_roles r ON u.role_id = r.id WHERE u.id = ?`
    },
    roles: {
      list: `SELECT r.id, r.role_name, STRING_AGG(rp.permission, ',') AS permissions FROM sys_roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id, r.role_name ORDER BY r.id`
    },
    config: {
      getAll: 'SELECT config_key, config_value FROM system_config',
      upsert: `MERGE INTO system_config AS t USING (SELECT ? AS config_key, ? AS config_value) AS s ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value, updated_at) VALUES (s.config_key, s.config_value, SYSUTCDATETIME());`,
      setAgentToken: `MERGE INTO system_config AS t USING (SELECT 'agent_token' AS config_key, ? AS config_value) AS s ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);`,
      getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_version')`,
      // R158.102 (2026-10-14) — MCP server token bundle. Four rows
      //   mcp_api_token_current / mcp_api_token_previous / mcp_api_token_rotated_at
      //   / mcp_api_token_version. Mirrors getAgentTokenBundle shape; dialect-
      //   portable so a single SELECT works against both mssql + mysql.
      //   Used by services/mcp-token.js + auth/mcp-token.js middleware.
      getMcpTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_api_token_current', 'mcp_api_token_previous', 'mcp_api_token_rotated_at', 'mcp_api_token_version')`,
      // R158.113 (2026-10-17) — MCP write tools token bundle. Mirrors
      //   mcp_api_token bundle shape exactly. Used by services/mcp-write-token.js
      //   + auth/mcp-write-token.js middleware. 4 KV rows: current / previous /
      //   rotated_at / version. Prefix `mcpw_` distinguishes from `mcp_` (read).
      getMcpWriteTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_write_token_current', 'mcp_write_token_previous', 'mcp_write_token_rotated_at', 'mcp_write_token_version')`,
      // R158.X.99.28.b (2026-10-19) — MCP IP whitelist bundle. Two rows
      //   mcp_ip_whitelist (JSON 数组 string) + mcp_ip_whitelist_enabled ('0'|'1').
      //   Mirrors getMcpTokenBundle shape. dialect-portable 1:1 平行.
      //   Used by auth/mcp-token.js + auth/mcp-write-token.js middleware.
      //   (修: R158.X.99.28 ship 走 db.sql.config.getAll 拉全表 + 客户端 filter
      //   → F1 HIGH performance finding 修.)
      getMcpIpWhitelistBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_ip_whitelist', 'mcp_ip_whitelist_enabled')`,
      // 2026-10-01 R158.13 — parallel to getAgentTokenBundle. Two-row
      // bundle: agent_settings (JSON blob) + agent_settings_version
      // (monotonic int). Read by client-settings.js service.
      getAgentSettingsBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_settings', 'agent_settings_version')`,
      getJwtSecretBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')`,
      audit: {
        write: 'INSERT INTO sys_config_audit (config_key, old_value, new_value, changed_by, change_type) VALUES (?, ?, ?, ?, CAST(? AS VARCHAR(16)))',
        list: `SELECT TOP 20 a.id, a.config_key, a.old_value, a.new_value, a.changed_by, a.change_type, a.changed_at, u.username AS changed_by_username FROM sys_config_audit a LEFT JOIN sys_users u ON a.changed_by = u.id ORDER BY a.changed_at DESC, a.id DESC`,
        getById: 'SELECT id, config_key, old_value, new_value, change_type FROM sys_config_audit WHERE id = ?'
      }
    },
    audit: {
      // R161.16 (2026-10-27) — created_at 显式写成 UTC, 不再依赖列默认值。
      //   MSSQL 基线: created_at DATETIME2 NOT NULL DEFAULT sysutcdatetime()
      //   ⇒ DEFAULT 本来就恒为 UTC; 这里仍然显式写出来, 是为了让两个方言
      //     的写入语义完全一致 (不依赖"某个方言的 DEFAULT 恰好是对的")。
      //   MySQL 版用 UTC_TIMESTAMP() —— 见上面 mysql 块的同款注释 (那才是
      //     真正的缺陷面: CURRENT_TIMESTAMP 取会话时区墙钟)。
      //   两边占位符个数保持一致 (4 个)。
      write: 'INSERT INTO audit_logs (user_id, action, target, payload, created_at) VALUES (?, ?, ?, ?, SYSUTCDATETIME())',
      // SELECT for paginated listing. The dialect owns both pagination syntax
      // and parameter order: callers pass semantic (size, offset) values.
      list: (where) => ({
        sql: `SELECT a.id, a.user_id AS userId, a.action, a.target, a.payload,
                a.created_at AS createdAt, u.username AS username
         FROM audit_logs a
         LEFT JOIN sys_users u ON a.user_id = u.id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        listParams: (whereParams, size, offset) => [...whereParams, offset, size]
      }),
      count: `SELECT COUNT(*) AS total FROM audit_logs a`,
      badge: (actionList) => `SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (${actionList.map(() => '?').join(',')})`,
      // R158.X.99.report (2026-10-21) — 日报/周报「MCP 调用统计」段.
      //   MSSQL mirror, 1:1 平行 mysql 段 countMcpCalls. 语义/口径完全一致
      //   (4 个调用 action, token 生命周期 action 不计, 0 SQL 层 JSON 提取).
      countMcpCalls: `SELECT a.action,
         COUNT(*) AS call_count,
         COUNT(DISTINCT u.username) AS user_count,
         MIN(a.created_at) AS first_at,
         MAX(a.created_at) AS last_at
       FROM audit_logs a
       LEFT JOIN sys_users u ON u.id = a.user_id
       WHERE a.action IN ('mcp.request','mcp.request.failed','mcp.write.request','mcp.write.request.failed')
         AND a.created_at BETWEEN ? AND ?
       GROUP BY a.action`,
      // R158.X.99.report (2026-10-21) — client_ip 维度原始行 (应用层 parse).
      //   MSSQL mirror, 1:1 平行 mysql 段 listRecentMcpCalls, 仅 LIMIT → TOP n.
      listRecentMcpCalls: ({ limit = 500 } = {}) => {
        const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
        return `SELECT TOP ${lim} a.action, a.payload, a.created_at
                 FROM audit_logs a
                 WHERE a.action IN ('mcp.request','mcp.request.failed','mcp.write.request','mcp.write.request.failed')
                   AND a.created_at BETWEEN ? AND ?
                 ORDER BY a.created_at DESC`;
      },
      // I4: retention purge — caller computes the cutoff date in JS
      // (new Date(Date.now() - days * 86400_000)) and binds as a Date param.
      // mssql driver coerces JS Date → DATETIME2 automatically.
      purge: 'DELETE FROM audit_logs WHERE created_at < ?'
    },
    sites: {
      listAll: 'SELECT site, region_code, is_hub FROM ad_sites',
      listCatalog: `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name`,
      findByName: 'SELECT site_id FROM ad_sites WHERE site_name = ?',
      create: 'INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)',
      upsert: `MERGE INTO ad_sites AS t USING (SELECT ? AS site_name, ? AS region_code, ? AS is_hub, ? AS description) AS s ON t.site_name = s.site_name WHEN MATCHED THEN UPDATE SET region_code = s.region_code, is_hub = s.is_hub, description = s.description WHEN NOT MATCHED THEN INSERT (site_name, region_code, is_hub, description) VALUES (s.site_name, s.region_code, s.is_hub, s.description);`,
      update: 'UPDATE ad_sites SET site_name = ?, region_code = ?, is_hub = ?, description = ? WHERE site_id = ?',
      updatePartial: (fields) => `UPDATE ad_sites SET ${fields.join(', ')} WHERE site_id = ?`,
      delete: 'DELETE FROM ad_sites WHERE site_id = ?',
      unbindDcs: 'UPDATE ad_dcs SET site_id = NULL WHERE site_id = ?'
    },
    dcs: {
      // 2026-08-27 round-28.5: surface is_bridgehead so the admin 域控清单
      // can show the bridgehead toggle next to the FSMO role toggles. The
      // bridgehead is an operator-chosen designation (NOT a FSMO role) used
      // by the all-sites replication matrix view to pick a primary DC per
      // site; sites without a marked bridgehead fall back to lex-first dc_name.
      // 2026-08-27 round-29: added dcs.updateFlags helper — same partial-update
      // shape as sites.updatePartial / systemPorts.updatePartial so the route
      // can build the SET list from whatever body keys the operator toggled.
      listCatalog: `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.is_bridgehead AS isBridgehead, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId, d.forest_domain_id AS forestDomainId, fd.domain_name AS forestDomainName, fd.forest_id AS forestId, d.decommissioned_at AS decommissionedAt, d.monitoring_paused_at AS monitoringPausedAt FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id LEFT JOIN ad_forest_domain fd ON d.forest_domain_id = fd.id ORDER BY d.dc_name`,
      assignSite: 'UPDATE ad_dcs SET site_id = ? WHERE dc_name = ?',
      assignSiteUnbind: 'UPDATE ad_dcs SET site_id = NULL WHERE dc_name = ?',
      updateFlags: (fields) => `UPDATE ad_dcs SET ${fields.join(', ')} WHERE dc_name = ?`,
      // R158.41 (2026-10-03) — DcsCatalogView 行级「域」下拉直接修改 ad_dcs.forest_domain_id.
      // domainId=null/undefined → unbind on server (R158.37.4 风格, 不删除 DC 行).
      setDomain: 'UPDATE ad_dcs SET forest_domain_id = ? WHERE dc_name = ?',
      setDomainUnbind: 'UPDATE ad_dcs SET forest_domain_id = NULL WHERE dc_name = ?',
      // R158.44.1 (2026-10-04) — operator 反馈 "KDLFLOFADSRV1 归属 forestDomainId=2 明显的是错的".
      // ad_dcs.forest_domain_id 指向不存在的 ad_forest_domain.id (孤儿引用, 常见于 R158.42 schema
      // rebase 后旧的 forest/domain 行被 DROP 但 DC 行 FK 未及时清理). LEFT JOIN 找出孤儿 DC, 一键清.
      listOrphanDcs: `SELECT d.dc_name AS dcName, d.forest_domain_id AS orphanDomainId
                       FROM ad_dcs d
                       LEFT JOIN ad_forest_domain fd ON fd.id = d.forest_domain_id
                       WHERE d.forest_domain_id IS NOT NULL AND fd.id IS NULL
                       ORDER BY d.dc_name`,
      // R158.44.1 — 一键清掉全部孤儿 FK. MySQL 多表 UPDATE 语法.
      unbindAllOrphanDcs: `UPDATE ad_dcs d
                           LEFT JOIN ad_forest_domain fd ON fd.id = d.forest_domain_id
                           SET d.forest_domain_id = NULL
                           WHERE d.forest_domain_id IS NOT NULL AND fd.id IS NULL`,
      // MSSQL UPDATE … FROM 语法不同 — 在 routes/admin.js 走 _pick isMssql 分支,
      // 这里复用同一占位符字符串, caller 按 dialect 选. (实际 MSSQL: UPDATE d SET
      // d.forest_domain_id = NULL FROM ad_dcs d LEFT JOIN ad_forest_domain fd
      // ON fd.id = d.forest_domain_id WHERE d.forest_domain_id IS NOT NULL
      // AND fd.id IS NULL)
      // R158.41 (2026-10-03) — TopContextPicker dropdown DC 数据源 (主路径).
      // 直接 ad_dcs WHERE = ? 查询, 不再依赖三段选择 (assignment+domainField+pdc).
      // R158.41 (2026-10-03) — TopContextPicker 4 级 dropdown (🌲 森林 → 🏢 域 → 📍 站点 → 🖥 DC)
      // 需要 site 信息. JOIN ad_sites 一次拿到 siteId/siteName, 前端按 siteId 分组出站点
      // 列表, 默认选第一个 dcCount > 0 的 (R158.41.2 "有资源优先" 思想延伸).
      listByDomain: `SELECT d.dc_name AS dcName, d.is_pdc AS isPdc,
                            s.site_id AS siteId, s.site_name AS siteName,
                            s.is_hub AS isHub
                     FROM ad_dcs d
                     LEFT JOIN ad_sites s ON s.site_id = d.site_id
                     WHERE d.forest_domain_id = ?
                     ORDER BY d.is_pdc DESC, d.dc_name`,
    },
    dashboard: {
      // R158.31.1 — ad_replication_status is append-only (probe 每次跑就 INSERT 一行),
      // 老 SQL `COUNT(*) FROM ad_replication_status` 返回的是累积行数 (现在 217) 而
      // 不是真实链路数。改成 latest-per-(source_dc, dest_dc) + 24h 窗口, 跟 /api/dashboard/summary
      // (dashboard.js:421-456) 的 linkSql 一致。
      //
      // 注意: 同一份 SQL 在 mysql/mssql 两 dialect 共用 — 当前都用 MSSQL 写法
      // (DATEADD + SYSUTCDATETIME)。MySQL 8.0+ window function (ROW_NUMBER OVER)
      // 支持, 但 DATEADD/SYSUTCDATETIME 函数名不同。如果将来切回 MySQL dialect,
      // 在 routes/dashboard.js:78-97 加 db.dialect 分发, 或者把此处改成变量
      // 形式 (db.dialect === 'mssql' ? '...' : '...')。
      overviewCounts: `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy,
          SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning,
          SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS errored,
          MAX(latest.collected_at) AS last_update
        FROM (
          SELECT source_dc, dest_dc, status_code, collected_at,
            ROW_NUMBER() OVER (PARTITION BY source_dc, dest_dc ORDER BY collected_at DESC) AS rn
          FROM ad_replication_status rs
          WHERE collected_at >= DATEADD(HOUR, -24, SYSUTCDATETIME())
            -- R158.X.115 (2026-10-20) — 排除退役/暂停 DC 的复制关系。1:1 平行
            --   mysql 段 overviewCounts (放子查询内的理由见该处注释)。
            AND NOT EXISTS (SELECT 1 FROM ad_dcs d1 WHERE d1.dc_name = rs.source_dc AND (d1.decommissioned_at IS NOT NULL OR d1.monitoring_paused_at IS NOT NULL))
            AND NOT EXISTS (SELECT 1 FROM ad_dcs d2 WHERE d2.dc_name = rs.dest_dc AND (d2.decommissioned_at IS NOT NULL OR d2.monitoring_paused_at IS NOT NULL))
        ) latest
        WHERE rn = 1`,
      // R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。
      //   NOT EXISTS (而非 INNER JOIN ad_dcs): agentCount 数的是心跳行, 有些
      //   agent 已上报心跳但还没被 discovery 写进 ad_dcs。INNER JOIN 会把这类
      //   行**静默抹掉**, 让 KPI 掉数; NOT EXISTS 只排除"明确标记为退役"的,
      //   语义精确且不误伤。谓词口径跟 db/sql/host-status.js 的 ONLINE_DC_WHERE
      //   一致 (相关子查询内用裸列名, 0 别名)。
      agentCount: `SELECT COUNT(*) AS agent_count FROM ad_agent_heartbeat ah WHERE ah.last_heartbeat_at IS NOT NULL AND ah.agent_id <> '__healthcheck__' AND ah.agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM ad_dcs d WHERE d.dc_name = ah.agent_id AND (d.decommissioned_at IS NOT NULL OR d.monitoring_paused_at IS NOT NULL))`,
      // siteMatrix 同理: 退役 DC 的复制关系不该再出现在站点间错误矩阵里。
      //   源端或目的端任一退役即排除该行 (退役后这条复制关系已不存在)。
      siteMatrix: `SELECT source_site, dest_site, SUM(CASE WHEN status_code >= 2 THEN 1 ELSE 0 END) AS error_count, SUM(CASE WHEN status_code = 1 THEN 1 ELSE 0 END) AS warning_count, COUNT(*) AS total FROM ad_replication_status rs WHERE (source_site IS NOT NULL AND source_site <> '') AND (dest_site IS NOT NULL AND dest_site <> '') AND NOT EXISTS (SELECT 1 FROM ad_dcs d1 WHERE d1.dc_name = rs.source_dc AND (d1.decommissioned_at IS NOT NULL OR d1.monitoring_paused_at IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM ad_dcs d2 WHERE d2.dc_name = rs.dest_dc AND (d2.decommissioned_at IS NOT NULL OR d2.monitoring_paused_at IS NOT NULL)) GROUP BY source_site, dest_site ORDER BY source_site, dest_site`,
      // R158.113 (2026-10-17) — site_keyword resolution helpers for MCP write tools.
      //   LLM hands MCP a `site_keyword: string`. The center resolves it via LIKE
      //   on ad_sites.site_name + alias, returning candidate sites. Multi-match is
      //   surfaced as a list so the LLM re-asks; 0-match falls back to the Hub
      //   site (ad_sites.is_hub=1) and picks its PDC (ad_dcs.is_pdc=1, ORDER BY DESC).
      //   0 schema changes — only SELECT against existing ad_sites / ad_dcs tables.
      //   mysql 段 dead-code 镜像用同样 SQL (生产不跑, 1:1 平行保 shape 一致).
      //   ad_sites 从来没有 alias 列. 老代码的 `OR (alias IS NOT NULL AND alias LIKE ?)`
      //   守卫无效 —— MSSQL 解析阶段就抛 Invalid column name (lesson 157: 引用不存在的
      //   列前必须查 INFORMATION_SCHEMA; 列存在性守卫对不存在的列不起作用).
      //   该列无写入方, 加了也永远 NULL → 删分支. params 2→1, 调用方同步改.
      getSiteByKeyword: `SELECT TOP 10 site_id, site_name FROM ad_sites WHERE site_name LIKE ? ORDER BY site_name`,
      getDcsBySite: `SELECT dc_name, is_pdc FROM ad_dcs WHERE site_id = ? ORDER BY is_pdc DESC`,
      // R158.113 — Hub fallback when LLM omits site_keyword (or keyword has 0
      //   match). Pick the PDC of the hub site (TOP 1, 跟段内 36 处 TOP 范式 1:1 平行).
      //   0 row → caller throws 400 no_hub_site_configured.
      getHubDefaultDc: `SELECT TOP 1 d.dc_name FROM ad_sites s INNER JOIN ad_dcs d ON d.site_id = s.site_id WHERE s.is_hub = 1 ORDER BY d.is_pdc DESC`,
      // R158.114 (2026-10-17) — MCP operation log list (audit_logs join sys_users).
      //   1:1 平行 mysql 段 (sql.js:921), 业务层 db.dialect 分发. 跟现有
      //   audit.js 5-203 ACTION_CATEGORY 5 个 mcp.* action 全 1:1 复用.
      listMcpOperations: `SELECT TOP 200 a.id, a.action, a.target, a.payload, a.created_at, u.username
                            FROM audit_logs a LEFT JOIN sys_users u ON u.id = a.user_id
                            WHERE a.action IN ('mcp.request','mcp.request.failed','mcp.write.request','mcp.write.request.failed',
                                               'mcp.auth.fail','mcp-write.auth.fail',
                                               'mcp_token_seed','mcp_token_rotate','mcp_token_commit','mcp_token_reveal',
                                               'mcp_write_token_seed','mcp_write_token_rotate','mcp_write_token_commit','mcp_write_token_reveal',
                                               'ad_user_password_reset','ad_user_create','ad_user_enable','ad_user_disable',
                                               'ad_user_unlock','ad_user_delete','ad_group_create',
                                               'ad_command_queued','ad_command_succeeded','ad_command_failed','ad_command_timeout')
                            ORDER BY a.created_at DESC`,
      // 2026-08-26 round-21: /topology used to return every row in
      // ad_replication_status, including stale round-19 leftovers and
      // test/junk rows (*, __tz_test, DC01→"") — operators saw 42 links
      // instead of the 19 the round-20 topology actually emits. The fix:
      // (a) derive site + dc nodes from ad_sites / ad_dcs (catalog is
      // source of truth — agent-reported source_site is a free-text hint
      // and does not match catalog site_name), (b) for links, take the
      // latest row per (source_dc, dest_dc) pair where both are known
      // DCs and source_dc != dest_dc, and (c) drop rows older than 30
      // minutes (UTC) so pairs the daemon stopped emitting — e.g. the
      // round-19 topology pairs that were renamed in round-20 — fall
      // out of the graph. UTC clock is essential: collected_at is in
      // UTC but MySQL NOW() returns session-tz (round-15 UTC cleanup).
      // R158.45 (2026-10-05) — bridgehead field exposed on DC nodes so
      // the topology chart can render the "DC↔Site Link Bridgehead"
      // callout boxes the operator asked for. ad_dcs.is_bridgehead has
      // been collected since R69 (agent ps1) but the topologyNodes SQL
      // never selected it. adAdminApi.listDcs also reads this endpoint
      // — additive, not breaking.
      topologyNodes: `
        SELECT s.site_id       AS site_id,
               s.site_name     AS site_name,
               s.is_hub        AS is_hub,
               d.dc_name       AS dc_name,
               d.is_bridgehead AS is_bridgehead
        FROM ad_sites s
        -- R158.X.115 (2026-10-20) — 退役/暂停管控的 DC 从拓扑图**消失** (不是
        --   灰显)。理由: AD 降级后该 DC 已从复制伙伴中消失, 留在图上正是用户
        --   要解决的噪音问题。
        --   过滤放 **ON 子句** 而非 WHERE —— 这是本改动的关键点: 放 WHERE
        --   会让 LEFT JOIN 退化成 INNER JOIN, 把"该站点下已无在线 DC"的
        --   站点整行干掉, 导致空站点从拓扑图凭空消失。放 ON 里, 站点行保留
        --   (dc_name = NULL), 退役 DC 本身被排除。语义精确。
        LEFT JOIN ad_dcs d ON d.site_id = s.site_id
              AND d.decommissioned_at IS NULL
              AND d.monitoring_paused_at IS NULL
        ORDER BY s.is_hub DESC, s.site_name, d.dc_name
      `,
      topologyLinks: `
        SELECT t1.source_dc, t1.dest_dc, t1.status_code, t1.last_success_time,
               v.probe_state AS probe_state, v.probe_attempt_at AS probe_attempt_at
        FROM ad_replication_status t1
        INNER JOIN ad_dcs sd ON sd.dc_name = t1.source_dc
        INNER JOIN ad_dcs dd ON dd.dc_name = t1.dest_dc
        -- R158.X.99-silent.topology (2026-10-21) — 扩 wire-shape: LEFT JOIN
        -- v_partner_inbound 给前端多带 probe_state (4 档 enum: success/partial/
        -- error/none) + probe_attempt_at. 让前端能把 probeState='none'
        -- (拓扑有, 探针 0 报告) 跟 status_code=2 (复制真挂) 严格分色;
        -- 跟 /matrix/inbound 的 silent 红 1:1 平行 (同数据源, 同语义).
        -- LEFT JOIN 因为 ad_replication_status 是老 30min probe 表, 跟
        -- v_partner_inbound (30 天 discover + 15min probe) 不一定同源 —
        -- 历史上有些 row 在 ad_replication_status 里有, 在 v 里无
        -- (例如 reporter 撤了 agent 但 discovery 表未清理). 反向 (在 v
        -- 无但 ad_replication_status 有) 也可能. v 没匹配 → NULL →
        -- 前端 fallback 用 status_code 2 标红 (已经是 ad_replication_status
        -- 老语义, 30min 没更新也算 stale). v 有匹配 → 用 probe_state.
        LEFT JOIN v_partner_inbound v
          ON v.target_dc = t1.dest_dc AND v.peer_dc = t1.source_dc
        WHERE t1.source_dc <> t1.dest_dc
          AND t1.naming_context NOT IN ('__dc_summary__', 'META')
          AND t1.collected_at = (
            SELECT MAX(t2.collected_at) FROM ad_replication_status t2
            WHERE t2.source_dc = t1.source_dc
              AND t2.dest_dc   = t1.dest_dc
              AND t2.naming_context NOT IN ('__dc_summary__', 'META')
          )
          AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME())
          -- R158.X.115 (2026-10-20) — MSSQL 镜像, 1:1 平行 mysql 段
          --   topologyLinks 的退役 DC 边过滤 (理由见该处注释)。
          AND sd.decommissioned_at IS NULL AND sd.monitoring_paused_at IS NULL
          AND dd.decommissioned_at IS NULL AND dd.monitoring_paused_at IS NULL
        ORDER BY t1.source_dc, t1.dest_dc
      `,
      // R158.68.5 (2026-10-10) — exclude sentinel META / __dc_summary__ + status_code=-1 probe rows.
      //   ad_replication_status has 1 sentinel row (source_dc='*' dest_dc='*' naming_context='META'
      //   status_code=-1) written by the agent SDK self-test. Without these guards, /errors shows
      //   a bogus "参见 Windows 错误码参考" entry (status_code=-1 isn't in the CODES map). Mirrors
      //   the exclude-META pattern used everywhere else in this file (sql.js line 70/207/538/959...).
      errors: `SELECT source_dc, dest_dc, source_site, dest_site, naming_context, status_code, last_success_time, last_attempt_time, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status WHERE status_code <> 0 AND status_code > 0 AND naming_context NOT IN ('__dc_summary__', 'META') ORDER BY last_attempt_time DESC`,
      // R158.X.116.p (2026-10-23) — errorsRecent: errors 的带时间窗版本,
      //   与 MySQL 版严格 1:1 平行 (同 SELECT 列 / 同判定 / 同哨兵排除,
      //   只多一个 last_attempt_time 下界)。老 errors 0 改。
      errorsRecent: (hours) => `SELECT source_dc, dest_dc, ss.site_name AS source_site, ds.site_name AS dest_site, naming_context, status_code, last_success_time, last_attempt_time, error_message, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status t LEFT JOIN ad_dcs sd ON sd.dc_name = t.source_dc LEFT JOIN ad_sites ss ON ss.site_id = sd.site_id LEFT JOIN ad_dcs dd ON dd.dc_name = t.dest_dc LEFT JOIN ad_sites ds ON ds.site_id = dd.site_id WHERE status_code <> 0 AND status_code > 0 AND naming_context NOT IN ('__dc_summary__', 'META') ${hours == null ? '' : 'AND last_attempt_time >= DATEADD(HOUR, -?, SYSUTCDATETIME())'} ORDER BY last_attempt_time DESC`,
      // R140 — add siteName/siteHint so /admin/agents can group by site.
      // Mirrors the JOIN pattern used by /api/admin/heartbeat-report/dcs
      // (sql.js heartbeat.dcsList, also a "agents joined to site" surface).
      // LEFT JOIN so agents without a matching ad_dcs row still surface
      // (they get siteName = null → "未分组" bucket on the frontend).
      agents: `SELECT h.agent_id, h.last_heartbeat_at, h.agent_version, h.last_report_at, h.last_report_status, h.pending_queue_size, CASE WHEN h.last_heartbeat_at IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, h.last_heartbeat_at, SYSUTCDATETIME()) AS float) END AS seconds_since_heartbeat, s.site_id AS site_id, s.site_name AS site_name, s.region_code AS region_code, d.site_hint AS site_hint FROM ad_agent_heartbeat h LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id LEFT JOIN ad_sites s ON s.site_id = d.site_id WHERE h.agent_id <> '__healthcheck__' AND h.agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM ad_dcs hd WHERE hd.dc_name = h.agent_id AND (hd.decommissioned_at IS NOT NULL OR hd.monitoring_paused_at IS NOT NULL)) ORDER BY h.agent_id`,
      siteLookup: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites WHERE site_name = ?`,
      dcsBySite: `SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id FROM ad_dcs WHERE site_id = ? ORDER BY dc_name`,
      dcReplicationLinks: (placeholders) => `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, CASE WHEN last_success_time IS NULL OR last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, last_success_time, last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status WHERE source_dc IN (${placeholders}) AND dest_dc IN (${placeholders}) ORDER BY source_dc, dest_dc, naming_context`,
      refreshSeconds: `SELECT config_value FROM system_config WHERE config_key = 'site_matrix_refresh_seconds'`,
      // 2026-08-27 round-27: all-sites variant for the global replication
      // matrix view. MSSQL mirror of the MySQL helpers above. OUTER APPLY
      // is the SQL Server idiom for the per-pair max-collected_at lookup
      // (matches the latestSummaryPerDc + topologyLinks pattern in this
      // branch). DATETIME2-typed params are JS Dates cast by the driver.
      allSitesOrdered: `SELECT site_id, site_name, region_code, is_hub, description FROM ad_sites ORDER BY is_hub DESC, region_code, site_name`,
      allDcsBySite: `SELECT d.dc_name, d.site_id, d.os_version, d.when_created, d.is_pdc, d.is_gc, d.is_rid_master, d.is_schema_master, d.is_domain_naming_master, d.is_infrastructure_master, d.is_bridgehead, d.discovered_at, d.discovered_by_agent_id FROM ad_dcs d INNER JOIN ad_sites s ON s.site_id = d.site_id ORDER BY s.site_name, d.dc_name`,
      allReplicationLinks: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_success_time, t1.last_attempt_time, CASE WHEN t1.last_success_time IS NULL OR t1.last_attempt_time IS NULL THEN NULL ELSE CAST(DATEDIFF_BIG(SECOND, t1.last_success_time, t1.last_attempt_time) AS float) / 60.0 END AS duration_minutes FROM ad_replication_status t1 OUTER APPLY (SELECT TOP 1 t2.collected_at AS max_collected_at FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context NOT IN ('__dc_summary__', 'META') ORDER BY t2.collected_at DESC) m WHERE t1.source_dc <> t1.dest_dc AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = m.max_collected_at AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.source_dc, t1.dest_dc, t1.naming_context`,
      // 2026-08-28 round-46: MSSQL mirror of latestPartnerPortPerPair.
      // LIKE '__partner_ports__:%' is portable across dialects (round-14
      // confirmed MSSQL handles the wildcard as expected). The TOP 1
      // correlated subquery is the SQL Server idiom that mirrors the
      // MySQL MAX(t2.collected_at) = ... pattern.
      // R154.6 — MSSQL mirror of the same R154.6 change (collected_at surfaced
      // for per-partner "执行时间" UI column; see MySQL sibling for rationale).
      latestPartnerPortPerPair: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_attempt_time, t1.collected_at, t1.partner_port_status FROM ad_replication_status t1 OUTER APPLY (SELECT TOP 1 t2.collected_at AS max_collected_at FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context LIKE '__partner_ports__:%' ORDER BY t2.collected_at DESC) m WHERE t1.naming_context LIKE '__partner_ports__:%' AND t1.source_dc <> t1.dest_dc AND t1.collected_at = m.max_collected_at AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.source_dc, t1.dest_dc`,
      // R155.3 — MSSQL mirror of mysql.partnerPortInboundView. Reads
      // FROM replication_inbound (migration 033) instead of FROM
      // ad_replication_status WHERE naming_context LIKE '__partner_ports__:%'.
      // R158.17.3 (2026-10-01) -- MSSQL: 直读 ad_replication_status (replication_inbound
      // 视图已 DROP), 列保持原 view shape.
      partnerPortInboundView: `SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message, collected_at, agent_id, partner_port_status FROM ad_replication_status WHERE source_dc <> dest_dc AND naming_context LIKE '__partner_ports__:%' AND collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY source_dc, dest_dc, collected_at DESC`,
      // R156.5 retired — partnerPortOutbound removed (operator directive
      // "复制伙伴端口主动探测 不需要哦去掉"). ad_dc_probe_outbound table
      // dropped by migration 038. Use partnerPortInboundView (read
      // replication_inbound) or latestPartnerPortPerPair (read
      // ad_replication_status directly) instead.
      // R156 — MSSQL mirror of partnerInboundDiscover. 30-day window
      // matches the cron cadence (operator directive 2026-09-30).
      partnerInboundDiscover: `SELECT i.source_dc, i.dest_dc, i.agent_id, i.collected_at, i.discovered_at, d.site_id, s.site_name FROM ad_partner_inbound i LEFT JOIN ad_dcs d ON d.dc_name = i.dest_dc LEFT JOIN ad_sites s ON s.site_id = d.site_id WHERE i.source_dc <> i.dest_dc AND i.collected_at >= DATEADD(DAY, -30, SYSUTCDATETIME()) ORDER BY i.source_dc, i.dest_dc, i.collected_at DESC`,
      // R158.10 (2026-10-01) — MSSQL partnerOutboundDiscover 删除
      //   (operator decision: outbound partner 不再需要)。
      partnerOutboundDiscover: undefined,
      // R155.6 — MSSQL mirror of mysql.partnersSnapshotAll. Same shape
      // (latest-per-pair over ad_replication_status, 30-min freshness
      // window, synthetic-row exclusions), rewritten with OUTER APPLY
      // for the per-tuple MAX(collected_at) reduction (R93.4 / R101
      // MSSQL dialect precedent).
      partnersSnapshotAll: `SELECT t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code, t1.last_success_time, t1.last_attempt_time, t1.error_message, t1.collected_at FROM ad_replication_status t1 OUTER APPLY (SELECT TOP 1 t2.collected_at AS max_collected_at FROM ad_replication_status t2 WHERE t2.source_dc = t1.source_dc AND t2.dest_dc = t1.dest_dc AND t2.naming_context = t1.naming_context ORDER BY t2.collected_at DESC) m WHERE t1.source_dc <> t1.dest_dc AND t1.naming_context NOT LIKE '__partner_ports__:%' AND t1.naming_context NOT IN ('__dc_summary__', 'META') AND t1.collected_at = m.max_collected_at AND t1.collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME()) ORDER BY t1.source_dc, t1.dest_dc, t1.naming_context`,
      // R158.14 (2026-10-01) — MSSQL 镜像 of mysql.vPartnerInbound.
      // v_partner_inbound 视图单纯 SELECT — 无 NC 聚合, 无 OUTER APPLY.
      // 详见 db/migrations/mssql/041-v-partner-inbound-mssql.sql.
      // R158.15 — 视图扩展 4 列 probe_state / probe_attempt_at /
      // probe_duration_ms / probe_error_message (LEFT JOIN
      // ad_replication_probe_history 15min 窗口聚合).
      vPartnerInbound: `SELECT target_dc, peer_dc, collected_at, discovered_at, reporter_agent_id, target_site_id, target_is_bridgehead, target_site_name, peer_site_id, peer_site_name, peer_site_is_hub, probe_state, probe_attempt_at, probe_duration_ms, probe_error_message FROM v_partner_inbound ORDER BY target_dc, peer_dc`,
      // R158.15 (2026-10-01) -- MSSQL mirror of latestReplicationProbePerPair.
      // Worst-of-NCs aggregation via OUTER APPLY + TOP 1 + ORDER BY status_code DESC.
      // Caller binds [sourceDc, destDc, 15].
      latestReplicationProbePerPair: `SELECT TOP 1 h.status_code, h.attempt_at, h.duration_ms, h.objects_transferred, h.error_message FROM ad_replication_probe_history h OUTER APPLY (SELECT source_dc, dest_dc, MAX(attempt_at) AS max_attempt FROM ad_replication_probe_history WHERE source_dc = h.source_dc AND dest_dc = h.dest_dc AND attempt_at >= DATEADD(MINUTE, -?, SYSUTCDATETIME()) GROUP BY source_dc, dest_dc) m WHERE h.source_dc = ? AND h.dest_dc = ? AND m.max_attempt = h.attempt_at ORDER BY h.status_code DESC`,
      // R155.6 — MSSQL MERGE for ad_dc_inbound_partners. Same 7-param
      // bind as MySQL sibling: [localDc, peerDc, namingContext,
      //               statusCode, lastSuccessTime, lastAttemptTime,
      //               errorMessage]. ON UNIQUE(local_dc, peer_dc,
      //               naming_context). refresh service iterates one
      //               MERGE per snapshot row.
      upsertDcInboundPartner: `MERGE INTO ad_dc_inbound_partners AS t
         USING (SELECT
           CAST(? AS NVARCHAR(128))   AS local_dc,
           CAST(? AS NVARCHAR(128))   AS peer_dc,
           CAST(? AS NVARCHAR(128))   AS naming_context,
           ?                          AS status_code,
           CAST(? AS DATETIME2)       AS last_success_time,
           CAST(? AS DATETIME2)       AS last_attempt_time,
           CAST(? AS NVARCHAR(2048))  AS error_message
         ) AS s
         ON t.local_dc = s.local_dc AND t.peer_dc = s.peer_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           status_code = s.status_code,
           last_success_time = s.last_success_time,
           last_attempt_time = s.last_attempt_time,
           error_message = s.error_message
         WHEN NOT MATCHED THEN INSERT
           (local_dc, peer_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message)
           VALUES (s.local_dc, s.peer_dc, s.naming_context, s.status_code, s.last_success_time, s.last_attempt_time, s.error_message);`,
      // R155.6 — MSSQL MERGE for ad_dc_outbound_partners. Same shape
      // as the inbound sibling.
      upsertDcOutboundPartner: `MERGE INTO ad_dc_outbound_partners AS t
         USING (SELECT
           CAST(? AS NVARCHAR(128))   AS local_dc,
           CAST(? AS NVARCHAR(128))   AS peer_dc,
           CAST(? AS NVARCHAR(128))   AS naming_context,
           ?                          AS status_code,
           CAST(? AS DATETIME2)       AS last_success_time,
           CAST(? AS DATETIME2)       AS last_attempt_time,
           CAST(? AS NVARCHAR(2048))  AS error_message
         ) AS s
         ON t.local_dc = s.local_dc AND t.peer_dc = s.peer_dc AND t.naming_context = s.naming_context
         WHEN MATCHED THEN UPDATE SET
           status_code = s.status_code,
           last_success_time = s.last_success_time,
           last_attempt_time = s.last_attempt_time,
           error_message = s.error_message
         WHEN NOT MATCHED THEN INSERT
           (local_dc, peer_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message)
           VALUES (s.local_dc, s.peer_dc, s.naming_context, s.status_code, s.last_success_time, s.last_attempt_time, s.error_message);`,
      // 2026-08-28 round-47: replicationLogRecentAttempts helper removed —
      // the 复制伙伴端口健康监控 route no longer embeds attempts[] on each
      // partner row (port-health-only view). Per-pair history for the
      // inline caret in 复制状态概览 still uses replicationLogPerPair
      // below.
      // 2026-09-25 R93.4 — MSSQL TOP does not accept parameter binding
      // (only an integer literal). Function-form so the limit is inlined;
      // the MySQL sibling keeps `LIMIT ?` because mysql2 accepts it. The
      // tedious driver does NOT auto-rewrite `TOP (?)` — that's a stale
      // comment from R45; the value is interpolated by the JS builder.
      // Caller binds [source, dest] only (limit is embedded in the SQL).
      replicationLogPerPair: (limit) => `SELECT TOP ${Math.max(1, Math.min(500, Number(limit) || 100))} source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time, attempt_duration_ms, objects_transferred, error_message, collected_at FROM ad_replication_history WHERE source_dc = ? AND dest_dc = ? AND collected_at >= DATEADD(HOUR, -24, SYSUTCDATETIME()) ORDER BY collected_at DESC`,
      // R158.17 (2026-10-01) — 复制状态概览展开历史 MSSQL mirror.
      // 走 TOP N (limit inlined, 不支持 LIMIT + bind). 数据源 ad_replication_probe_history.
      probeHistoryPerPair: (limit) => `SELECT TOP ${Math.max(1, Math.min(50, Number(limit) || 10))} source_dc, dest_dc, attempt_at, result FROM ad_replication_probe_history WHERE source_dc = ? AND dest_dc = ? ORDER BY attempt_at DESC`,
      // R158.103.2 (2026-10-15) — 复制状态概览 "明细" drawer, mssql mirror.
      // 跟 mysql section probeHistoryPerPairDetail 1:1 平行. function-form
      // (limit) =>, TOP N (limit inlined, 不支持 LIMIT + bind), default 50,
      // cap 50 跟 inline caret 同不升档.
      probeHistoryPerPairDetail: (limit) => `SELECT TOP ${Math.max(1, Math.min(50, Number(limit) || 50))} source_dc, dest_dc, naming_context, agent_id, attempt_at, result, status_code, duration_ms, objects_transferred, error_code, error_message FROM ad_replication_probe_history WHERE source_dc = ? AND dest_dc = ? ORDER BY attempt_at DESC`,
      // R158.103.1 (2026-10-15) — silent reporter 检测, mssql mirror.
      // 跟 mysql section probeReporterLiveness 1:1 平行. SYSUTCDATETIME()
      // 替代 UTC_TIMESTAMP() - INTERVAL 24 HOUR. matrix UI 标红用.
      probeReporterLiveness: `SELECT agent_id, COUNT(*) AS total_24h, MAX(attempt_at) AS latest_attempt FROM ad_replication_probe_history WHERE attempt_at >= DATEADD(HOUR, -24, SYSUTCDATETIME()) GROUP BY agent_id`,
      // 2026-09-01 R74: 复制错误 view — MSSQL mirror of the MySQL helper
      // above. OUTER APPLY drives the per-tuple history count instead of
      // the LEFT JOIN + GROUP BY form (cleaner on SQL Server — avoids
      // the GROUP BY expansion over the cross join). TOP 200 is a hard
      // literal since the spec caps the view at 200 rows; the window
      // (hours) is the only bound param, passed three times.
      // R158.X.99.29 (2026-10-19) — MAX(t2.last_attempt_time) 子查询加
      // 同窗口限制, 1:1 平行 outer WHERE. 真因: 11 天前老失败行通过 7d
      // 窗口仍显. caller 改 [h,h,h] 三处 share 同 cut-off.
      replicationErrors: `SELECT TOP 200 t1.source_dc, t1.dest_dc, t1.naming_context, t1.status_code,
                                 t1.last_success_time, t1.last_attempt_time, t1.error_message,
                                 COALESCE(att.cnt, 0) AS attempt_count,
                                 CASE WHEN t1.last_success_time IS NULL OR t1.last_attempt_time IS NULL
                                      THEN NULL
                                      ELSE CAST(DATEDIFF_BIG(MILLISECOND, t1.last_success_time, t1.last_attempt_time) AS BIGINT)
                                 END AS duration_ms
                            FROM ad_replication_status t1
                            OUTER APPLY (
                              SELECT COUNT(*) AS cnt
                              FROM ad_replication_history h
                              WHERE h.source_dc = t1.source_dc
                                AND h.dest_dc = t1.dest_dc
                                AND h.naming_context = t1.naming_context
                                AND h.collected_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                            ) att
                            -- R158.X.116.p.2 (2026-10-23): 原为 IN (1, 2), 改为 > 0, 1:1 平行
                            --   MySQL 版 (sql.js:1446)。与 listActiveErrors 收敛
                            --   单源 —— status_code 实际值域是 Windows 错误码,
                            --   IN (1,2) 只认 port-probe 的 0/1/2 枚举。
                            WHERE t1.status_code > 0
                              AND t1.source_dc <> t1.dest_dc
                              AND t1.naming_context NOT IN ('__dc_summary__', 'META')
                              AND t1.last_attempt_time = (
                                SELECT MAX(t2.last_attempt_time) FROM ad_replication_status t2
                                WHERE t2.source_dc = t1.source_dc
                                  AND t2.dest_dc = t1.dest_dc
                                  AND t2.naming_context = t1.naming_context
                                  AND t2.last_attempt_time >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                              )
                              AND t1.last_attempt_time >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                            ORDER BY t1.last_attempt_time DESC`
    },
    heartbeat: {
      // 2026-08-24 round-12: report_requested_at added (last col). ISNULL
      // on WHEN MATCHED UPDATE means a `null` param preserves the existing
      // column — agents pre-T6 that don't forward the field will not wipe
      // the "report now" request.
      //
      // 2026-08-25: date params (`last_report_at`, `report_requested_at`)
      // wrapped with `CAST(? AS DATETIME2)`. Without the cast, tedious
      // binds the JS Date / ISO string with an inferred type (varchar or
      // nvarchar), and MSSQL then throws "Conversion failed when
      // converting date and/or time from character string" (error 241) on
      // the assignment to the datetime2 column. Same fix pattern as
      // ad_replication_status.upsertStatus (Bug B, ad8745a).
      // R158.48 (2026-10-06) — agent auto-update. last_upgrade_event added
      // (11th col). NVARCHAR(MAX) NULL — ISNULL on WHEN MATCHED preserves
      // existing value when agent doesn't forward the field (pre-R158.48
      // agents ignore the body param; bind undefined → NULL).
      // R158.88.C (2026-10-13) — health_score added (12th col, INT NULL).
      //   跟 R158.48 last_upgrade_event 1:1 平行. ISNULL on WHEN MATCHED
      //   preserve 老 fleet NULL → 0 抹, 新 fleet 0.1.7+ 报 0-100.
      //   R158.69.3 lesson 3 永远适用: 0 自动升级.
      upsert: `MERGE INTO ad_agent_heartbeat AS t USING (SELECT
         ? AS agent_id,
         ? AS agent_version,
         CAST(? AS DATETIME2) AS last_report_at,
         ? AS last_report_status,
         ? AS pending_queue_size,
         ? AS agent_token_version,
         CAST(? AS DATETIME2) AS report_requested_at,
         ? AS client_settings_version,
         ? AS heartbeat_interval_seconds,
         ? AS last_upgrade_event,
         ? AS health_score
       ) AS s ON t.agent_id = s.agent_id WHEN MATCHED THEN UPDATE SET last_heartbeat_at = SYSUTCDATETIME(), agent_version = s.agent_version, last_report_at = s.last_report_at, last_report_status = s.last_report_status, pending_queue_size = s.pending_queue_size, agent_token_version = s.agent_token_version, report_requested_at = ISNULL(s.report_requested_at, t.report_requested_at), client_settings_version = s.client_settings_version, heartbeat_interval_seconds = s.heartbeat_interval_seconds, last_upgrade_event = ISNULL(s.last_upgrade_event, t.last_upgrade_event), health_score = ISNULL(s.health_score, t.health_score) WHEN NOT MATCHED THEN INSERT (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size, agent_token_version, report_requested_at, client_settings_version, heartbeat_interval_seconds, last_upgrade_event, health_score) VALUES (s.agent_id, SYSUTCDATETIME(), s.agent_version, s.last_report_at, s.last_report_status, s.pending_queue_size, s.agent_token_version, s.report_requested_at, s.client_settings_version, s.heartbeat_interval_seconds, s.last_upgrade_event, s.health_score);`,
      // 2026-08-21 UX redesign (auto-delivery): same shape as the MySQL
      // variant — see the comment above.
      tokenDeliveryList: `SELECT agent_id, agent_token_version, last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      // 2026-10-01 R158.13: mirror MySQL sibling — list every agent's
      // last reported client_settings_version for the admin push counter.
      clientSettingsList: `SELECT agent_id, client_settings_version, last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id <> '__healthcheck__' ORDER BY agent_id`,
      // 2026-08-26 round-15: source-of-truth switch for the report-status
      // signal. Mirrors the MySQL branch — derive last_report_at /
// last_report_status from ad_replication_status instead of the
// self-declared heartbeat columns. MSSQL uses DATEADD/SYSUTCDATETIME()
// instead of NOW()/INTERVAL.
      agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                          rep.last_report_at,
                          CASE
                            WHEN rep.last_report_at IS NULL THEN NULL
                            WHEN rep.last_report_at >= DATEADD(HOUR, -1, SYSUTCDATETIME()) THEN
                              CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN CAST('partial_failure' AS VARCHAR(32)) ELSE CAST('success' AS VARCHAR(32)) END
                            ELSE CAST('stale' AS VARCHAR(32))
                          END AS last_report_status,
                          COALESCE(recent.success_count, 0) AS success_count,
                          COALESCE(recent.fail_count, 0) AS fail_count,
                          COALESCE(recent.total_count, 0) AS total_count,
                          h.pending_queue_size, h.report_requested_at,
                          h.heartbeat_interval_seconds
             FROM ad_agent_heartbeat h
             LEFT JOIN (
               SELECT agent_id, MAX(collected_at) AS last_report_at
               FROM ad_replication_status
               GROUP BY agent_id
             ) rep ON rep.agent_id = h.agent_id
             LEFT JOIN (
               SELECT agent_id,
                      SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                      SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                      COUNT(*) AS total_count
               FROM ad_replication_status
               WHERE collected_at >= CAST(SYSUTCDATETIME() AS DATE)
               GROUP BY agent_id
             ) recent ON recent.agent_id = h.agent_id
             WHERE h.agent_id <> '__healthcheck__'
             ORDER BY h.agent_id`,
      dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at,
                       rep.last_report_at,
                       CASE
                         WHEN rep.last_report_at IS NULL THEN NULL
                         WHEN rep.last_report_at >= DATEADD(HOUR, -1, SYSUTCDATETIME()) THEN
                           CASE WHEN COALESCE(recent.fail_count, 0) > 0 THEN CAST('partial_failure' AS VARCHAR(32)) ELSE CAST('success' AS VARCHAR(32)) END
                         ELSE CAST('stale' AS VARCHAR(32))
                       END AS last_report_status,
                       COALESCE(recent.success_count, 0) AS success_count,
                       COALESCE(recent.fail_count, 0) AS fail_count,
                       COALESCE(recent.total_count, 0) AS total_count,
                       h.pending_queue_size, h.report_requested_at,
                       h.heartbeat_interval_seconds,
                       d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                       s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          LEFT JOIN (
            SELECT agent_id, MAX(collected_at) AS last_report_at
            FROM ad_replication_status
            GROUP BY agent_id
          ) rep ON rep.agent_id = h.agent_id
          LEFT JOIN (
            SELECT agent_id,
                   SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS success_count,
                   SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS fail_count,
                   COUNT(*) AS total_count
            FROM ad_replication_status
            WHERE collected_at >= CAST(SYSUTCDATETIME() AS DATE)
            GROUP BY agent_id
          ) recent ON recent.agent_id = h.agent_id
          WHERE h.agent_id <> '__healthcheck__'
            -- R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。与上面的
            --   LEFT JOIN ad_dcs 不冲突: 本查询主键是 h.agent_id (心跳行),
            --   退役 DC 的心跳行本就不该出现在"当前 agent"列表里。跟 sql.js
            --   heartbeat.agents 同口径。
            AND NOT EXISTS (SELECT 1 FROM ad_dcs hd WHERE hd.dc_name = h.agent_id AND (hd.decommissioned_at IS NOT NULL OR hd.monitoring_paused_at IS NOT NULL))
          ORDER BY h.agent_id`,
      // 2026-08-24 round-12: requestReport MERGE — insert a stub heartbeat
      // row if the agent hasn't checked in yet, or set the column if it
      // has. Caller binds [agentId, requestedAt] (Date).
      //
      // 2026-08-25: `report_requested_at` wrapped with `CAST(? AS DATETIME2)`
      // for the same reason as upsert above — bound JS Date without cast
      // hits error 241.
      requestReport: (agentId, requestedAtIso) =>
        `MERGE INTO ad_agent_heartbeat AS t
         USING (SELECT ? AS agent_id, CAST(? AS DATETIME2) AS report_requested_at) AS s
         ON t.agent_id = s.agent_id
         WHEN NOT MATCHED THEN
           INSERT (agent_id, last_heartbeat_at, report_requested_at)
           VALUES (s.agent_id, SYSUTCDATETIME(), s.report_requested_at)
         WHEN MATCHED THEN
           UPDATE SET report_requested_at = s.report_requested_at;`,
      // 2026-08-24 round-12 T-fix: clearReportRequest — direct UPDATE that
      // actually sets `report_requested_at = NULL`. Same rationale as the
      // MySQL variant: heartbeat MERGE's ISNULL-preserve path cannot
      // express "explicit clear". Caller binds [agentId].
      //
      // 2026-08-25: uses `?` not the unbound `@p_agent_id` literal — the
      // mssql driver remaps `?` to `@p1, @p2, …` but a hand-written
      // `@p_agent_id` is never bound, so MSSQL would throw "Must declare
      // scalar variable". Fix is identical in shape to the MySQL variant.
      clearReportRequest: (agentId) =>
        `UPDATE ad_agent_heartbeat
            SET report_requested_at = NULL
          WHERE agent_id = ?`,
      // 2026-08-24 round-12 T6: read back report_requested_at for a single
      // agent so the heartbeat handler can attach reportRequested: boolean
      // to its response. Same shape as the MySQL variant (single column,
      // single row). Caller binds [agentId].
      readReportRequestedAt:
        `SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-25: cold-start probe — read existing row's last_heartbeat_at
      // BEFORE this heartbeat's upsert so the route can detect a restart
      // (>5min gap) and wipe any stale report_requested_at that the
      // previous process didn't get to consume. Caller binds [agentId].
      readLastHeartbeatAt:
        `SELECT last_heartbeat_at FROM ad_agent_heartbeat WHERE agent_id = ?`,
      // 2026-08-31 R75: DC-online check at queue time. MSSQL mirror.
      // Uses DATEADD(MINUTE, -5, SYSUTCDATETIME()) instead of UTC_TIMESTAMP()
      // - INTERVAL 5 MINUTE. Caller binds [agentId].
      dcOnlineCheck:
        `SELECT last_heartbeat_at FROM ad_agent_heartbeat
          WHERE agent_id = CAST(? AS NVARCHAR(128))
            AND last_heartbeat_at >= DATEADD(MINUTE, -5, SYSUTCDATETIME())`,
      // 2026-08-28 round-58: cold-start auto-trigger helper — MSSQL mirror.
      // Same intent as the MySQL variant: COUNT(*) over ad_replication_status
      // for the agent so the heartbeat handler can decide whether to
      // auto-trigger a fresh report-now request after a delete + resurrect
      // (or first heartbeat ever). Returns 0 when the table has no rows
      // for this agent. The CAST(? AS NVARCHAR(64)) matches the column
      // type — without the cast the driver sends NVARCHAR(MAX) which
      // silently mismatches the agent_id index. Caller binds [agentId].
      hasAnyReplicationRows: (agentId) =>
        `SELECT COUNT(*) AS cnt FROM ad_replication_status WHERE agent_id = CAST(? AS NVARCHAR(64))`,
      reportSummaryFor: (agentId, sinceIso) =>
        `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
         FROM ad_replication_status s
         INNER JOIN (
           SELECT TOP 1 collected_at AS max_collected
           FROM ad_replication_status
           WHERE agent_id = CAST(? AS NVARCHAR(64)) AND collected_at >= CAST(? AS DATETIME2)
           ORDER BY collected_at DESC
         ) m ON s.collected_at = m.max_collected AND s.agent_id = CAST(? AS NVARCHAR(64))
         ORDER BY s.source_dc, s.dest_dc`,
      // 2026-08-26 round-15: latest-failed-row lookup. Mirrors the MySQL
      // variant — scoped to the 1-hour window, single row, ordered by
      // collected_at DESC. MSSQL uses TOP 1 + DATEADD/SYSUTCDATETIME().
      //
      // 2026-08-27 round-39: lookup window is "today" (since midnight UTC)
      // to match the count window so the displayed error is one that
      // contributed to today's fail_count.
      latestFailureFor: (agentId) =>
        `SELECT TOP 1 source_dc, dest_dc, error_message, collected_at
         FROM ad_replication_status
         WHERE agent_id = CAST(? AS NVARCHAR(64)) AND status_code <> 0
           AND collected_at >= CAST(SYSUTCDATETIME() AS DATE)
         ORDER BY collected_at DESC, source_dc, dest_dc`,
      latestReportEntries: (agentId, sinceIso, limit) =>
        // 2026-09-25 R93.11: tighten read-back to match the matrix /all
        // contract — see MySQL latestReportEntries comment. Same META +
        // __dc_summary__ exclusion + 30-minute freshness floor (via
        // DATEADD(MINUTE, -30, SYSUTCDATETIME())) applied here.
        `SELECT collected_at, source_dc, dest_dc, source_site, dest_site, naming_context,
                 status_code, error_message, last_success_time, last_attempt_time
         FROM ad_replication_status
         WHERE agent_id = CAST(? AS NVARCHAR(64))
           AND naming_context NOT IN ('__dc_summary__', 'META')
           AND collected_at >= DATEADD(MINUTE, -30, SYSUTCDATETIME())
           AND collected_at = (
             SELECT TOP 1 collected_at FROM ad_replication_status
             WHERE agent_id = CAST(? AS NVARCHAR(64)) AND collected_at >= CAST(? AS DATETIME2)
               AND naming_context NOT IN ('__dc_summary__', 'META')
             ORDER BY collected_at DESC
           )
         ORDER BY source_dc, dest_dc`,
      // 2026-08-26 round-19+: heartbeat-table delete buttons — MSSQL
      // variant. Each DELETE binds the agent_id with CAST(? AS NVARCHAR(64))
      // to match the row's column type (agent_id is NVARCHAR(64)) — without
      // the cast the driver sends NVARCHAR(MAX) which silently mismatches
      // the index and the WHERE never matches. Identical shape to MySQL.
      deleteHeartbeatRow: (agentId) =>
        `DELETE FROM ad_agent_heartbeat WHERE agent_id = CAST(? AS NVARCHAR(64))`,
      deleteReplicationBySource: (agentId) =>
        `DELETE FROM ad_replication_status WHERE source_dc = CAST(? AS NVARCHAR(64))`,
      deleteReplicationByDest: (agentId) =>
        `DELETE FROM ad_replication_status WHERE dest_dc = CAST(? AS NVARCHAR(64))`,
      deletePackageRuns: (agentId) =>
        `DELETE FROM package_runs WHERE agent_id = CAST(? AS NVARCHAR(64))`,
      deleteDcRow: (dcName) =>
        `DELETE FROM ad_dcs WHERE dc_name = CAST(? AS NVARCHAR(128))`,
      // R158.79 (2026-10-12) — MemberServer heartbeat tab. 3 helper
      //   MSSQL 平行 mysql, 跟 agentsList / dcsList 同 family 内聚.
      memberUpsert: memberHeartbeat.mssql.upsert,
      membersList: memberHeartbeat.mssql.membersList,
      deleteMemberRow: memberHeartbeat.mssql.deleteMemberRow
    },
    ports: {
      list: 'SELECT id, port, label, sort_order AS sortOrder FROM system_ports ORDER BY sort_order, port',
      listForAgent: `SELECT sp.port, sp.label, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt
        FROM system_ports sp
        INNER JOIN ad_agent_port_status aps ON aps.port = sp.port AND aps.agent_id = ?
        ORDER BY sp.sort_order, sp.port`,
      create: 'INSERT INTO system_ports (port, label, sort_order) VALUES (?, ?, ?)',
      findByPort: 'SELECT id FROM system_ports WHERE port = ?',
      updatePartial: (fields) => `UPDATE system_ports SET ${fields.join(', ')} WHERE id = ?`,
      delete: 'DELETE FROM system_ports WHERE id = ?'
    },
    portStatus: {
      // MSSQL uses MERGE for atomic upsert (no native ON DUPLICATE KEY).
      // Uses ? placeholders — db.execute remaps ? -> @pN for MSSQL.
      upsertOne: `MERGE INTO ad_agent_port_status AS t
        USING (SELECT CAST(? AS VARCHAR(64)) AS agent_id, ? AS port, ? AS ok, ? AS latency_ms, ? AS last_checked_at) AS s
        ON t.agent_id = s.agent_id AND t.port = s.port
        WHEN MATCHED THEN UPDATE SET t.ok = s.ok, t.latency_ms = s.latency_ms, t.last_checked_at = s.last_checked_at
        WHEN NOT MATCHED THEN INSERT (agent_id, port, ok, latency_ms, last_checked_at) VALUES (s.agent_id, s.port, s.ok, s.latency_ms, s.last_checked_at);`,
      listForAgents: (placeholders) => `SELECT aps.agent_id AS agentId, aps.port, aps.ok, aps.latency_ms AS latencyMs, aps.last_checked_at AS lastCheckedAt,
               sp.label AS label
        FROM ad_agent_port_status aps
        INNER JOIN system_ports sp ON aps.port = sp.port
        WHERE aps.agent_id IN (${placeholders})
        ORDER BY sp.sort_order, sp.port`
    },
    // R66 split: installed_packages -> package_scripts + package_policies.
    // package_scripts holds script content + sha256 + manifest (migration 023).
    // The legacy db.sql.installedPackages SQL string registry was retired in
    // T14 — migration 023 drops the table itself, so no live caller remains.
    packageScripts: {
      upsert: `MERGE INTO package_scripts AS t
        USING (SELECT
          ? AS name, ? AS version, ? AS script_content, ? AS script_sha256,
          ? AS manifest_json, ? AS source, ? AS created_at, ? AS updated_at
        ) AS s
        ON t.name = s.name
        WHEN MATCHED THEN UPDATE SET
          version = s.version,
          script_content = s.script_content,
          script_sha256 = s.script_sha256,
          manifest_json = s.manifest_json,
          source = s.source,
          updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT
          (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
          VALUES
          (s.name, s.version, s.script_content, s.script_sha256,
           s.manifest_json, s.source, s.created_at, s.updated_at);`,
      list: `SELECT * FROM package_scripts ORDER BY name`,
      get: `SELECT * FROM package_scripts WHERE name = ?`,
      delete: `DELETE FROM package_scripts WHERE name = ?`,
      updateScript: `UPDATE package_scripts SET script_content = ?, script_sha256 = ?, updated_at = ? WHERE name = ?`,
      // T14: JOIN helper for the cross-package agent view. Same SQL as
      // the MySQL helper — `?` placeholders are dialect-portable via the
      // mssql driver wrapper. Mirrors runner.js JOIN_SELECT_MSSQL.
      listEnabledGlobal: `SELECT ps.name, ps.version, ps.script_sha256, ps.manifest_json,
                                 pp.interval_sec, pp.timeout_ms, pp.enabled, pp.params_json,
                                 ps.source, ps.created_at, ps.updated_at
                          FROM package_scripts ps
                          INNER JOIN package_policies pp ON ps.name = pp.name
                          WHERE pp.enabled = 1
                          ORDER BY ps.name`
    },
    // R152 — append-only publish history. Dual-write from script-service
    // installScript / editScript. Reads by name are exposed via
    // GET /api/admin/packages/:name/history. (name, version, script_sha256)
    // UNIQUE makes INSERT IGNORE on MySQL idempotent; on MSSQL we guard
    // with a SELECT first because there's no INSERT IGNORE.
    packageScriptsHistory: {
      insert:      packageScriptsHistorySql.insert,
      existsMssql: packageScriptsHistorySql.existsMssql,
      listByName:  packageScriptsHistorySql.listByName
    },
    // R66 split: package_policies holds execution policy (migration 023).
    // Five ops: upsert (by name) / list / listEnabled / getByName / delete.
    // updatePartial is exposed via the helper in center/src/db/sql/package-policies.js
    // (db.execute is called directly because the SET clause is field-dependent).
    packagePolicies: {
      upsert: `MERGE INTO package_policies AS t
        USING (SELECT
          ? AS name, ? AS interval_sec, ? AS timeout_ms, ? AS enabled,
          ? AS params_json, ? AS scope, ? AS created_at, ? AS updated_at
        ) AS s
        ON t.name = s.name
        WHEN MATCHED THEN UPDATE SET
          interval_sec = s.interval_sec,
          timeout_ms = s.timeout_ms,
          enabled = s.enabled,
          params_json = s.params_json,
          scope = s.scope,
          updated_at = s.updated_at
        WHEN NOT MATCHED THEN INSERT
          (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
          VALUES
          (s.name, s.interval_sec, s.timeout_ms, s.enabled, s.params_json,
           s.scope, s.created_at, s.updated_at);`,
      list: `SELECT * FROM package_policies ORDER BY name`,
      listEnabled: `SELECT * FROM package_policies WHERE enabled = 1 ORDER BY name`,
      getByName: `SELECT * FROM package_policies WHERE name = ?`,
      delete: `DELETE FROM package_policies WHERE name = ?`
    },
    // Drop-failure tracking (migration 013). See mysql counterpart.
    orphanSchemas: {
      upsert: `MERGE INTO orphan_schemas AS t
        USING (SELECT ? AS name, ? AS last_seen_at, ? AS note) AS s
        ON t.name = s.name
        WHEN MATCHED THEN UPDATE SET
          last_seen_at = s.last_seen_at,
          note = s.note
        WHEN NOT MATCHED THEN INSERT (name, last_seen_at, note)
          VALUES (s.name, s.last_seen_at, s.note);`,
      list: `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`,
      delete: `DELETE FROM orphan_schemas WHERE name = ?`
    },
    metricGauge: {
      upsertLatest: `MERGE INTO metric_gauge AS t
        USING (SELECT
          ? AS agent_id, ? AS metric_id, ? AS ts, ? AS value, ? AS unit,
          ? AS threshold_warn, ? AS threshold_crit
        ) AS s
        ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
        WHEN MATCHED THEN UPDATE SET
          ts = s.ts,
          value = s.value,
          unit = s.unit,
          threshold_warn = s.threshold_warn,
          threshold_crit = s.threshold_crit
        WHEN NOT MATCHED THEN INSERT
          (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
          VALUES (s.agent_id, s.metric_id, s.ts, s.value, s.unit, s.threshold_warn, s.threshold_crit);`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_gauge WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_gauge WHERE agent_id = ?`
    },
    metricCounter: {
      upsertLatest: `MERGE INTO metric_counter AS t
        USING (SELECT
          ? AS agent_id, ? AS metric_id, ? AS ts, ? AS value, ? AS delta, ? AS unit
        ) AS s
        ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
        WHEN MATCHED THEN UPDATE SET
          ts = s.ts,
          value = s.value,
          delta = s.delta,
          unit = s.unit
        WHEN NOT MATCHED THEN INSERT
          (agent_id, metric_id, ts, value, delta, unit)
          VALUES (s.agent_id, s.metric_id, s.ts, s.value, s.delta, s.unit);`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_counter WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_counter WHERE agent_id = ?`
    },
    metricTimeseries: {
      append: `INSERT INTO metric_timeseries
        (agent_id, metric_id, ts, value, tags_json, unit)
        VALUES (?, ?, ?, ?, ?, ?)`,
      list: (includeRange) => {
        const where = ['agent_id = ?', 'metric_id = ?'];
        if (includeRange?.from) where.push('ts >= ?');
        if (includeRange?.to) where.push('ts <= ?');
        return `SELECT * FROM metric_timeseries WHERE ${where.join(' AND ')} ORDER BY ts ASC`;
      }
    },
    metricStatus: {
      upsertLatest: `MERGE INTO metric_status AS t
        USING (SELECT
          ? AS agent_id, ? AS metric_id, ? AS ts, ? AS status, ? AS message
        ) AS s
        ON t.agent_id = s.agent_id AND t.metric_id = s.metric_id
        WHEN MATCHED THEN UPDATE SET
          ts = s.ts,
          status = s.status,
          message = s.message
        WHEN NOT MATCHED THEN INSERT
          (agent_id, metric_id, ts, status, message)
          VALUES (s.agent_id, s.metric_id, s.ts, s.status, s.message);`,
      listByAgent: (metricIdPlaceholder) =>
        metricIdPlaceholder
          ? `SELECT * FROM metric_status WHERE agent_id = ? AND metric_id = ?`
          : `SELECT * FROM metric_status WHERE agent_id = ?`
    },
    packageRuns: {
      insert: `INSERT INTO package_runs
        (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      // listRecent is built dynamically per call; mssql uses TOP <n> not LIMIT.
      // R158.17.6 (2026-10-01) -- MSSQL mirror of summary24hByName. Same
      // semantics as the MySQL sibling. Handler calls once over a 24h
      // window then per-package TOP 10 for the recent-runs table. Before
      // this fix, listRecent(limit=200) was 100% consumed by
      // ad_partner_inbound_discover (~288k rows / 24h).
      //
      // R158.50.7g (2026-10-08) -- success/partial split by status column.
      // See the mysql mirror above for the full rationale. MSSQL uses
      // ANSI SQL `IS NULL` (works the same as MySQL), no need for ISNULL().
      summary24hByName: `SELECT package_name,
                              COUNT(*) AS total,
                              SUM(CASE WHEN exit_code = 0 AND (status = 'success' OR status IS NULL) THEN 1 ELSE 0 END) AS success,
                              SUM(CASE WHEN exit_code = 0 AND status = 'partial' THEN 1 ELSE 0 END) AS partial,
                              SUM(CASE WHEN exit_code IS NOT NULL AND exit_code <> 0 THEN 1 ELSE 0 END) AS failure,
                              MAX(started_at) AS last_run_at
                         FROM package_runs
                        WHERE started_at >= ?
                          AND agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
                        GROUP BY package_name`,
      // R158.99.3 (2026-10-13) — MEMBER-side mirror (mssql). Same IN vs
      // NOT IN flip as the mysql sibling above.
      memberSummary24hByName: `SELECT package_name,
                              COUNT(*) AS total,
                              SUM(CASE WHEN exit_code = 0 AND (status = 'success' OR status IS NULL) THEN 1 ELSE 0 END) AS success,
                              SUM(CASE WHEN exit_code = 0 AND status = 'partial' THEN 1 ELSE 0 END) AS partial,
                              SUM(CASE WHEN exit_code IS NOT NULL AND exit_code <> 0 THEN 1 ELSE 0 END) AS failure,
                              MAX(started_at) AS last_run_at
                         FROM package_runs
                        WHERE started_at >= ?
                          AND agent_id IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
                        GROUP BY package_name`,
      // R158.99.3 — recent member-side runs (mssql). TOP <int> after SELECT.
      memberRecentByName: (limit, since) => `SELECT TOP ${Math.max(1, Math.min(1000, parseInt(limit, 10) || 10))} * FROM package_runs WHERE package_name = ? AND started_at >= ? AND agent_id IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) ORDER BY started_at DESC`,
      // 2026-10-20 perf — MSSQL mirror of MySQL recentByNames / memberRecentByNames.
      //   Same CTE + ROW_NUMBER() pattern; both dialects (MSSQL 2017+/MySQL 8.0+)
      //   support window functions identically. Replaces 14 round-trips in
      //   /api/dashboard/packages-runs timeline mode (~1.6s) with one
      //   (~80–120ms).
      recentByNames: (names, limit, since) => {
        const n = Array.isArray(names) ? names : [names];
        const placeholders = n.map(() => '?').join(', ');
        const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
        const sql = `WITH ranked AS (
            SELECT package_name, id, agent_id, started_at, finished_at, exit_code, status,
                   ROW_NUMBER() OVER (PARTITION BY package_name ORDER BY started_at DESC) AS rn
              FROM package_runs
             WHERE package_name IN (${placeholders})
               AND started_at >= ?
               AND agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
        ) SELECT * FROM ranked WHERE rn <= ${safeLimit} ORDER BY package_name, rn`;
        return { sql, params: [...n, since] };
      },
      memberRecentByNames: (names, limit, since) => {
        const n = Array.isArray(names) ? names : [names];
        const placeholders = n.map(() => '?').join(', ');
        const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
        const sql = `WITH ranked AS (
            SELECT package_name, id, agent_id, started_at, finished_at, exit_code, status,
                   ROW_NUMBER() OVER (PARTITION BY package_name ORDER BY started_at DESC) AS rn
              FROM package_runs
             WHERE package_name IN (${placeholders})
               AND started_at >= ?
               AND agent_id IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)
        ) SELECT * FROM ranked WHERE rn <= ${safeLimit} ORDER BY package_name, rn`;
        return { sql, params: [...n, since] };
      },
      // R158.19 (2026-10-01) -- MSSQL mirror of packageRuns.purgeOlderThan.
      // Identical SQL to MySQL — bound parameter is a JS Date, driver wrapper
      // translates to DATETIME2 on the wire.
      purgeOlderThan: 'DELETE FROM package_runs WHERE started_at < ?'
    },
    lockout: {
      // R158.31: was target_user_description (R139 / R139.1). Operator
      // 2026-10-02 反馈列语义应为 AD `displayName`. 列名 + wire shape 全栈
      // rename, CAST(? AS VARCHAR(512)) 长度沿用 (displayName 通常 <100,
      // 512 是 common-denominator). BIND_ORDER alignment with
      // centre/src/services/lockout.js is critical.
      upsertEvent: `MERGE INTO ad_lockout_events AS t
        USING (SELECT
          ? AS occurred_at, ? AS collected_at, CAST(? AS VARCHAR(64)) AS agent_id, CAST(? AS VARCHAR(128)) AS dc_name, ? AS event_record_id,
          CAST(? AS VARCHAR(256)) AS target_user_name, CAST(? AS VARCHAR(512)) AS target_user_display_name,
          CAST(? AS VARCHAR(256)) AS subject_user_name, CAST(? AS VARCHAR(256)) AS subject_domain, CAST(? AS VARCHAR(256)) AS caller_computer_name
        ) AS s
        ON t.dc_name = s.dc_name AND t.event_record_id = s.event_record_id
        WHEN MATCHED THEN UPDATE SET collected_at = s.collected_at
        WHEN NOT MATCHED THEN INSERT
          (occurred_at, collected_at, agent_id, dc_name, event_record_id,
           target_user_name, target_user_display_name,
           subject_user_name, subject_domain, caller_computer_name)
          VALUES
          (s.occurred_at, s.collected_at, s.agent_id, s.dc_name, s.event_record_id,
           s.target_user_name, s.target_user_display_name,
           s.subject_user_name, s.subject_domain, s.caller_computer_name);`,
      search: `SELECT TOP 500 occurred_at, dc_name, target_user_name, target_user_display_name,
                      subject_user_name, subject_domain, caller_computer_name
                 FROM ad_lockout_events
                WHERE occurred_at >= ?
                  AND (CAST(? AS VARCHAR(256)) = '' OR target_user_name = CAST(? AS VARCHAR(256)))
                  AND (CAST(? AS VARCHAR(128)) = '' OR dc_name = CAST(? AS VARCHAR(128)))
                  AND (CAST(? AS VARCHAR(256)) = '' OR caller_computer_name = CAST(? AS VARCHAR(256)))
                ORDER BY occurred_at ASC`,
      // R131 — MSSQL counterpart of lockout.recent (MySQL block above).
      // Bound LIMIT via TOP (?) per R93.4 / R101 dialect precedent (MSSQL
      // needs TOP before the column list, NOT a numeric literal). Bound
      // HOUR window via DATEADD(HOUR, -?, GETUTCDATE()) to match the
      // MySQL NOW() - INTERVAL ? HOUR semantics. R158.31 renamed
      // target_user_description → target_user_display_name (10th bind slot
      // in upsert; SELECT here).
      // R158.109.b (2026-10-16) — server-paged 24h list. OFFSET (? / ?) ROWS
      // 替 LIMIT/TOP. sinceHours 服务端 pin = 24 (跟 MySQL 1:1 平行). 跟
      // R158.X account-change detail OFFSET 范式 1:1 平行 (mssql 模板).
      recent: (offset = 0, limit = 50) => {
        if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
          throw new Error(`lockout.recent (mssql): offset must be int in [0,10000], got ${offset}`);
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new Error(`lockout.recent (mssql): limit must be int in [1,200], got ${limit}`);
        }
        return {
          sql: `SELECT occurred_at, dc_name, target_user_name, target_user_display_name,
                       subject_user_name, subject_domain, caller_computer_name
                  FROM ad_lockout_events
                 WHERE occurred_at >= DATEADD(HOUR, -?, GETUTCDATE())
                 ORDER BY occurred_at DESC
                 OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
          params: [24, offset, limit]
        };
      },
      // R158.53 (2026-10-08) — 24h hourly event-log trend for the
      // /lockout-accounts line chart. Top-5 by 24h COUNT(*) DESC;
      // ?dc= override → single DC only. Event log source (operator
      // decision post-R158.50.7n: ad_lockout_events is the event log
      // the detail table below the chart also reads — keeping chart
      // and table in the same data source avoids the gauge-vs-event
      // confusion R158.50.7n flagged). Reuses the failedLogon.hourlyAggregate
      // GROUP BY hour-bucket idiom (line 3169) so bucket boundaries line
      // up across /lockout-accounts and /failed-logon-2h. SYSUTCDATETIME()
      // (not GETUTCDATE()) for UTC precision (R101 precedent).
      // R158.50.7e SQL 兜底过滤 — target_user_name NOT LIKE '%$' 排除机器
      // 账户 (DB 层双保险, 即便老 PS1 1.0.3 还在跑, chart 也不污染).
      trend24h: ({ dc = null, topN = 5 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`lockout.trend24h: topN must be int in [1,20], got ${topN}`);
        }
        if (dc == null) {
          // TOP-N PATH: 先 24h COUNT per agent 排序取 topN, 再 GROUP BY hour.
          const sql =
            `WITH top_agents AS (
               SELECT TOP (?) agent_id
                 FROM ad_lockout_events
                WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                  AND target_user_name NOT LIKE '%$'
                GROUP BY agent_id
                ORDER BY COUNT(*) DESC
             ),
             hourly AS (
               SELECT e.agent_id,
                      DATEADD(HOUR, DATEDIFF(HOUR, 0, e.occurred_at), 0) AS bucket_start,
                      COUNT(*) AS event_count
                 FROM ad_lockout_events e
                 INNER JOIN top_agents ta ON ta.agent_id = e.agent_id
                WHERE e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                  AND e.target_user_name NOT LIKE '%$'
                GROUP BY e.agent_id, DATEADD(HOUR, DATEDIFF(HOUR, 0, e.occurred_at), 0)
             )
             SELECT agent_id, bucket_start, event_count
               FROM hourly
              ORDER BY agent_id ASC, bucket_start ASC`;
          return { sql, params: [topN, 24, 24] };
        }
        // SINGLE-DC PATH
        const sql =
          `SELECT agent_id,
                  DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_lockout_events
            WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
              AND agent_id = CAST(? AS VARCHAR(64))
              AND target_user_name NOT LIKE '%$'
            GROUP BY agent_id, DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0)
            ORDER BY bucket_start ASC`;
        return { sql, params: [24, dc] };
      },
      // R158.109.b (2026-10-16) — MSSQL mirror of lockout.dailyAggregate
      // (MySQL line 1660-1707). 跟 trend24h 1:1 平行, 改 DATEADD(HOUR...)
      // → DATEADD(DAY...), DATEADD(HOUR, -?, SYSUTCDATETIME()) → DATEADD(DAY, -?, ...).
      // machine account 兜底 (R158.50.7e) 0 改. windowDays ∈ [1, 365] hard cap.
      dailyAggregate: ({ dc = null, topN = 5, windowDays = 7 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`lockout.dailyAggregate: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) {
          throw new Error(`lockout.dailyAggregate: windowDays must be int in [1,365], got ${windowDays}`);
        }
        if (dc == null) {
          // TOP-N PATH — 跟 trend24h 1:1 平行, bucket 改 DAY + daily DATEADD
          const sql =
            `WITH top_agents AS (
               SELECT TOP (?) agent_id
                 FROM ad_lockout_events
                WHERE occurred_at >= DATEADD(DAY, -?, SYSUTCDATETIME())
                  AND target_user_name NOT LIKE '%$'
                GROUP BY agent_id
                ORDER BY COUNT(*) DESC
             ),
             daily AS (
               SELECT e.agent_id,
                      DATEADD(DAY, DATEDIFF(DAY, 0, e.occurred_at), 0) AS bucket_start,
                      COUNT(*) AS event_count
                 FROM ad_lockout_events e
                 INNER JOIN top_agents ta ON ta.agent_id = e.agent_id
                WHERE e.occurred_at >= DATEADD(DAY, -?, SYSUTCDATETIME())
                  AND e.target_user_name NOT LIKE '%$'
                GROUP BY e.agent_id, DATEADD(DAY, DATEDIFF(DAY, 0, e.occurred_at), 0)
             )
             SELECT agent_id, bucket_start, event_count
               FROM daily
              ORDER BY agent_id ASC, bucket_start ASC`;
          return { sql, params: [topN, windowDays, windowDays] };
        }
        // SINGLE-DC PATH
        const sql =
          `SELECT agent_id,
                  DATEADD(DAY, DATEDIFF(DAY, 0, occurred_at), 0) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_lockout_events
            WHERE occurred_at >= DATEADD(DAY, -?, SYSUTCDATETIME())
              AND agent_id = CAST(? AS VARCHAR(64))
              AND target_user_name NOT LIKE '%$'
            GROUP BY agent_id, DATEADD(DAY, DATEDIFF(DAY, 0, occurred_at), 0)
            ORDER BY bucket_start ASC`;
        return { sql, params: [windowDays, dc] };
      },
      // R158.X.99.35 (2026-10-20) — lockout chart trendByBucketMinutes
      // (MSSQL). 1:1 平行 MySQL sibling (上面) + eventlog.trendByBucketMinutes
      // MSSQL (sql.js:5773). DATEADD(MINUTE, (DATEDIFF(MINUTE,
      // '20000101', occurred_at) / bucketMinutes) * bucketMinutes,
      // '20000101') 是 MSSQL 经典 no-leading-index floor idiom (no
      // leading index on occurred_at, ops 已知 R158.51 baseline freeze
      // 0 schema 改). GROUP BY agent_id (替 channel). bucketMinutes
      // inline (≠参数化, 因 bucket integer 必 SQL-side floor). hours
      // 走 `?` placeholder (R93.4 function-form). 复用 trend24h MSSQL
      // (sql.js:4909) `WITH top_agents AS (SELECT TOP (?) agent_id …)`
      // topN=5 CTE 范式. 0 改 dailyAggregate / trend24h (既有 caller 0
      // 破). R158.111 nssm restart 必跑 + R158.86 24h probe 必跑.
      trendByBucketMinutes: ({ dc = null, topN = 5, hours = 24, bucketMinutes = 5 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`lockout.trendByBucketMinutes: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error(`lockout.trendByBucketMinutes: hours must be int in [1,168], got ${hours}`);
        }
        // R158.X.99.35 — whitelist 跟 eventlog 1:1 (1, 5, 15, 30, 60, 240).
        if (!Number.isInteger(bucketMinutes) || ![1, 5, 15, 30, 60, 240].includes(bucketMinutes)) {
          throw new Error(`lockout.trendByBucketMinutes: bucketMinutes must be one of [1,5,15,30,60,240], got ${bucketMinutes}`);
        }
        // bucket floor expression (MSSQL idiom, inline ${bucketMinutes})
        const bucketExpr = `DATEADD(MINUTE, (DATEDIFF(MINUTE, '20000101', occurred_at) / ${bucketMinutes}) * ${bucketMinutes}, '20000101')`;
        if (dc == null) {
          // TOP-N PATH — 跟 trend24h MSSQL (sql.js:4916) 1:1 平行, bucket
          // 边界替 HOUR bucket → 分钟级 bucket (5min/4h).
          const sql =
            `WITH top_agents AS (
               SELECT TOP (?) agent_id
                 FROM ad_lockout_events
                WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                  AND target_user_name NOT LIKE '%$'
                GROUP BY agent_id
                ORDER BY COUNT(*) DESC
             ),
             bucketed AS (
               SELECT e.agent_id,
                      ${bucketExpr} AS bucket_start,
                      COUNT(*) AS event_count
                 FROM ad_lockout_events e
                 INNER JOIN top_agents ta ON ta.agent_id = e.agent_id
                WHERE e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                  AND e.target_user_name NOT LIKE '%$'
                GROUP BY e.agent_id, ${bucketExpr}
             )
             SELECT agent_id, bucket_start, event_count
               FROM bucketed
              ORDER BY agent_id ASC, bucket_start ASC`;
          return { sql, params: [topN, hours, hours] };
        }
        // SINGLE-DC PATH
        const sql =
          `SELECT agent_id,
                  ${bucketExpr} AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_lockout_events
            WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
              AND agent_id = CAST(? AS VARCHAR(64))
              AND target_user_name NOT LIKE '%$'
            GROUP BY agent_id, ${bucketExpr}
            ORDER BY bucket_start ASC`;
        return { sql, params: [hours, dc] };
      },
      // R158.64 (2026-10-10) — MSSQL mirror of MySQL lockout.topByUserWithDisplay
      // (line 1245). 字段名 lockout_count / last_lockout_at, STRING_AGG 取代
      // GROUP_CONCAT. 跟 failedLogon.topByUserWithDisplay (line 3740) 同 shape.
      // R158.65.3 (2026-10-10) — 去掉 STRING_AGG DISTINCT, sp_executesql
      //   包装下报 "Incorrect syntax near ','" (R158.65.6 实测). 单行 dc_name
      //   唯一 (R158.65.7) 不用 DISTINCT 二次过滤.
      // R158.65.4 (2026-10-10) — CAST NVARCHAR(MAX) 解除 STRING_AGG 默认
      //   VARCHAR(8000) 字节限制 (R158.65.8 实测 liubijun 跨多 DC 聚合超
      //   8000 bytes 报 "result exceeded the limit").
      topByUserWithDisplay: ({ sinceHours = 24, topN = 50, dcName = null, search = null } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 200) {
          throw new Error(`lockout.topByUserWithDisplay: topN must be int in [1,200], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`lockout.topByUserWithDisplay: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        // R158.65.5 (2026-10-10) — 弃用 STRING_AGG, 改 STUFF+FOR XML PATH.
        //   原因: STRING_AGG 默认 VARCHAR(8000), 跨多 DC 聚合超 8000 bytes
        //   即报 "result exceeded the limit", CAST NVARCHAR(MAX) 也不解
        //   (R158.65.8 实测). STUFF+FOR XML PATH 是 MSSQL 经典 unlimited-
        //   length 字符串聚合范式 (XML 序列化绕过 VARCHAR(8000) in-row 限制).
        //   实测 liubijun 跨 4 DC 5-字符串 完美 (R158.65.10).
        // R158.111 (2026-10-16) — 加 dcName 可选 filter (subquery 同步过滤,
        //   保证 dc_name_list 不含其他 DC) + search 前缀 LIKE 'q%' (走索引).
        //   都默认 null → 0 改老行为 (R158.64 reports.js caller).
        const subClauses = ['e2.target_user_name = e.target_user_name',
                            'e2.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())'];
        const outerClauses = ['e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())',
                              "e.target_user_name NOT LIKE '%$'",
                              "e.target_user_name <> ''"];
        const params = [];
        params.push(topN);
        // subquery bind order: sinceHours, [dcName if any]
        params.push(sinceHours);
        if (dcName) { subClauses.push('e2.dc_name = ?'); params.push(dcName); }
        // outer bind order: sinceHours, [dcName if any], [searchLike×2 if any]
        params.push(sinceHours);
        if (dcName) { outerClauses.push('e.dc_name = ?'); params.push(dcName); }
        if (search) {
          outerClauses.push("(e.target_user_name LIKE ? OR COALESCE(e.target_user_display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        const sql =
          `SELECT TOP (?)
             e.target_user_name AS sam,
             COALESCE(MAX(e.target_user_display_name), '') AS display_name,
             COUNT(*) AS lockout_count,
             MAX(e.occurred_at) AS last_lockout_at,
             COUNT(DISTINCT e.dc_name) AS dc_count,
             STUFF((SELECT ',' + dc_name
                      FROM (SELECT DISTINCT dc_name
                              FROM ad_lockout_events e2
                             WHERE ${subClauses.join(' AND ')}) dcs
                     ORDER BY dc_name
                       FOR XML PATH('')), 1, 1, '') AS dc_name_list
           FROM ad_lockout_events e
           WHERE ${outerClauses.join(' AND ')}
           GROUP BY e.target_user_name
           ORDER BY lockout_count DESC, sam ASC`;
        // R158.111 — bind 顺序: [topN, subquerySinceHours, [subqueryDcName],
        //   outerSinceHours, [outerDcName], [searchLike, searchLike]]
        return { sql, params };
      },
      // R158.111.a (2026-10-16) — MSSQL mirror of MySQL lockout.listAll
      // (sql.js:1770 紧跟 topByUserWithDisplay 之后). 返 raw row (0 GROUP BY
      // 0 topN), 物理全量 (sinceHours=NULL) 或 sinceHours∈[1,168] 限定时间窗.
      // 0 过滤 machine account `NOT LIKE '%$'` (用户 directive "不过滤").
      // 0 过滤空 sam. ORDER BY occurred_at DESC + OFFSET/FETCH (T-SQL 范式,
      // 跟 R158.65.6 1:1 平行, 0 改 schema / 0 改 agent). bind 顺序:
      //   [sinceHours if any, dcName if any, searchLike×2 if any, limit, offset]
      listAll: ({ sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}) => {
        if (limit < 1 || limit > 500) {
          throw new Error(`lockout.listAll: limit must be in [1,500], got ${limit}`);
        }
        if (offset < 0) {
          throw new Error(`lockout.listAll: offset must be >= 0, got ${offset}`);
        }
        if (sinceHours !== null && (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168)) {
          throw new Error(`lockout.listAll: sinceHours must be null or int in [1,168], got ${sinceHours}`);
        }
        const clauses = [];
        const params = [];
        if (sinceHours !== null) {
          clauses.push('e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())');
          params.push(sinceHours);
        }
        if (dcName) { clauses.push('e.dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push("(e.target_user_name LIKE ? OR COALESCE(e.target_user_display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        // MSSQL bind 顺序: OFFSET ?, FETCH NEXT ? — 跟 MySQL 的 LIMIT ?, OFFSET ?
        // 相反 (跟 failedLogon.listAll mssql 1:1 平行, R158.111.a 修).
        params.push(offset, limit);
        const sql =
          `SELECT e.dc_name,
                  e.target_user_name,
                  COALESCE(e.target_user_display_name, '') AS target_user_display_name,
                  COALESCE(NULLIF(e.caller_computer_name, ''), '') AS caller_computer_name,
                  4740 AS event_id,
                  e.occurred_at
             FROM ad_lockout_events e
            ${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY e.occurred_at DESC
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`;
        return { sql, params };
      },
      // R158.1W.3 (2026-10-16) — MSSQL mirror of MySQL lockout.accountWorkstationLinks
      // (sql.js:1749 紧跟 topByUserWithDisplay 之后). 字段映射 1:1 跟
      // failedLogon.accountWorkstationLinks MSSQL (sql.js:4832+) 平行, 但
      // ad_failed_logon_events → ad_lockout_events, workstation_name →
      // caller_computer_name. STUFF+FOR XML PATH 取代 GROUP_CONCAT
      // (R158.65.5 范式, VARCHAR(8000) 限制解). 0 改 schema / 0 改 agent.
      accountWorkstationLinks: ({ sinceHours = 168, minStations = 1, limit = 200 } = {}) => {
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`lockout.accountWorkstationLinks: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        if (!Number.isInteger(minStations) || minStations < 1 || minStations > 50) {
          throw new Error(`lockout.accountWorkstationLinks: minStations must be int in [1,50], got ${minStations}`);
        }
        if (!Number.isInteger(limit) || limit < 10 || limit > 500) {
          throw new Error(`lockout.accountWorkstationLinks: limit must be int in [10,500], got ${limit}`);
        }
        const sql =
          `WITH edges AS (
             SELECT
               LOWER(e.target_user_name) AS sam,
               NULLIF(LTRIM(RTRIM(e.caller_computer_name)), '') AS workstation,
               COUNT(*) AS event_count,
               MIN(e.occurred_at) AS first_seen,
               MAX(e.occurred_at) AS last_seen,
               COUNT(DISTINCT e.dc_name) AS dc_count,
               STUFF((SELECT ',' + dc_name
                        FROM (SELECT DISTINCT dc_name
                                FROM ad_lockout_events e2
                               WHERE LOWER(e2.target_user_name) = LOWER(e.target_user_name)
                                 AND ISNULL(NULLIF(LTRIM(RTRIM(e2.caller_computer_name)), ''), '') =
                                     ISNULL(NULLIF(LTRIM(RTRIM(e.caller_computer_name)), ''), '')
                                 AND e2.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())) dcs
                       ORDER BY dc_name
                         FOR XML PATH('')), 1, 1, '') AS dc_list
             FROM ad_lockout_events e
             WHERE e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
               AND e.target_user_name NOT LIKE '%$'
               AND e.target_user_name <> ''
               AND NULLIF(LTRIM(RTRIM(e.caller_computer_name)), '') IS NOT NULL
             GROUP BY LOWER(e.target_user_name),
                      NULLIF(LTRIM(RTRIM(e.caller_computer_name)), '')
           ),
           user_summary AS (
             SELECT sam,
                    COUNT(DISTINCT workstation) AS station_count,
                    SUM(event_count) AS total_count
               FROM edges
              GROUP BY sam
             HAVING COUNT(DISTINCT workstation) >= ?
           )
           SELECT e.sam, e.workstation, e.event_count,
                  e.first_seen, e.last_seen, e.dc_count, e.dc_list,
                  s.station_count, s.total_count
             FROM edges e
             JOIN user_summary s ON s.sam = e.sam
             ORDER BY s.station_count DESC, e.event_count DESC, e.sam ASC, e.workstation ASC
             OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY`;
        return { sql, params: [sinceHours, sinceHours, minStations, limit] };
      }
    },
    // R158.111 (2026-10-16) — 报表中心 read-only helpers (admin-only endpoints
        //   /api/report-center/*). MSSQL mirror of MySQL reportCenter block.
    reportCenter: {
      // 活跃 DC 列表 — MySQL reportCenter.dcOptions 的 MSSQL 镜像.
      dcOptions: () => {
        const sql =
          `SELECT dc_name, is_pdc, is_gc, is_bridgehead, discovered_at
             FROM ad_dcs
            ORDER BY is_pdc DESC, dc_name ASC`;
        return { sql, params: [] };
      }
    },
    // R158.50 (2026-10-06) — ad_failed_logon_events public table.
    // 4625 collector (Security log) for /failed-logon-2h dashboard.
    // Same R110.A / R158.47 public-table contract: manifest omits
    // database block, runner.js post-hook writes here directly via
    // MERGE. 17 fields (vs lockout 10) — string-form is still readable
    // here since each MERGE column is one CAST line. Bind order must
    // stay aligned with src/services/failed-logon.js:upsertEvent.
    failedLogon: {
      upsertEvent: `MERGE INTO ad_failed_logon_events AS t
        USING (SELECT
          CAST(? AS DATETIME2)      AS occurred_at,
          CAST(? AS DATETIME2)      AS collected_at,
          CAST(? AS NVARCHAR(256))  AS agent_id,
          CAST(? AS NVARCHAR(256))  AS dc_name,
          CAST(? AS BIGINT)         AS event_record_id,
          CAST(? AS NVARCHAR(256))  AS target_user_name,
          CAST(? AS NVARCHAR(256))  AS target_user_display_name,
          CAST(? AS NVARCHAR(256))  AS target_domain_name,
          CAST(? AS NVARCHAR(256))  AS target_sid,
          CAST(? AS NVARCHAR(256))  AS subject_user_name,
          CAST(? AS NVARCHAR(256))  AS subject_domain_name,
          CAST(? AS NVARCHAR(256))  AS caller_computer_name,
          CAST(? AS NVARCHAR(64))   AS ip_address,
          CAST(? AS NVARCHAR(16))   AS ip_port,
          CAST(? AS INT)            AS logon_type,
          CAST(? AS NVARCHAR(64))   AS logon_process_name,
          CAST(? AS NVARCHAR(64))   AS auth_package_name,
          CAST(? AS NVARCHAR(64))   AS failure_reason,
          CAST(? AS NVARCHAR(64))   AS status,
          CAST(? AS NVARCHAR(256))  AS workstation_name,
          CAST(? AS INT)            AS error_code
        ) AS s
        ON t.dc_name = s.dc_name AND t.event_record_id = s.event_record_id
        WHEN MATCHED THEN UPDATE SET
          collected_at      = s.collected_at,
          target_user_display_name = s.target_user_display_name,
          caller_computer_name     = s.caller_computer_name,
          ip_address               = s.ip_address,
          ip_port                  = s.ip_port,
          logon_type               = s.logon_type,
          logon_process_name       = s.logon_process_name,
          auth_package_name        = s.auth_package_name,
          failure_reason           = s.failure_reason,
          status                   = s.status,
          workstation_name         = s.workstation_name,
          error_code               = s.error_code
        WHEN NOT MATCHED THEN INSERT
          (occurred_at, collected_at, agent_id, dc_name, event_record_id,
           target_user_name, target_user_display_name, target_domain_name,
           target_sid, subject_user_name, subject_domain_name,
           caller_computer_name, ip_address, ip_port, logon_type,
           logon_process_name, auth_package_name, failure_reason,
           status, workstation_name, error_code)
          VALUES
          (s.occurred_at, s.collected_at, s.agent_id, s.dc_name, s.event_record_id,
           s.target_user_name, s.target_user_display_name, s.target_domain_name,
           s.target_sid, s.subject_user_name, s.subject_domain_name,
           s.caller_computer_name, s.ip_address, s.ip_port, s.logon_type,
           s.logon_process_name, s.auth_package_name, s.failure_reason,
           s.status, s.workstation_name, s.error_code);`,
      // /failed-logon-2h dashboard 折线图 hourly bucket. sinceHours=24 → 24 行,
      // sinceHours=168 → 168 行. DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0)
      // 把 occurred_at floor 到整点 UTC (MSSQL idiom).
      hourlyAggregate: `SELECT DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0) AS bucket_start,
                               COUNT(*) AS event_count
                          FROM ad_failed_logon_events
                         WHERE occurred_at >= DATEADD(HOUR, -?, GETUTCDATE())
                           AND target_user_name NOT LIKE '%$'
                         GROUP BY DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0)
                         ORDER BY bucket_start ASC`,
      // R158.109 (2026-10-16) — MSSQL mirror of failedLogon.dailyAggregate.
      // 跟 hourly 用 DATEADD(HOUR, ...) 1:1 平行, daily 改 DATEADD(DAY, ...).
      // machine account 兜底 NOT LIKE '%$' 保留 (R158.50.7e).
      dailyAggregate: ({ days = 7 } = {}) => {
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new Error(`failedLogon.dailyAggregate: days must be int in [1,365], got ${days}`);
        }
        return {
          sql: `SELECT DATEADD(DAY, DATEDIFF(DAY, 0, occurred_at), 0) AS bucket_start,
                       COUNT(*) AS event_count
                  FROM ad_failed_logon_events
                 WHERE occurred_at >= DATEADD(DAY, -?, GETUTCDATE())
                   AND target_user_name NOT LIKE '%$'
                 GROUP BY DATEADD(DAY, DATEDIFF(DAY, 0, occurred_at), 0)
                 ORDER BY bucket_start ASC`,
          params: [days]
        };
      },
      // R158.X.99.36 (2026-10-20) — MSSQL mirror of failedLogon.trendByBucketMinutes
      // MySQL (上面). DATEADD(MINUTE, (DATEDIFF(MINUTE, '20000101',
      // occurred_at) / bucketMinutes) * bucketMinutes, '20000101') 是 MSSQL
      // 经典 no-leading-index floor idiom (no leading index on occurred_at,
      // ops 已知 R158.51 baseline freeze 0 schema 改). 1:1 平行 eventlog
      // trendByBucketMinutes MSSQL (sql.js:5901) + lockout.trendByBucketMinutes
      // MSSQL (sql.js:5069), **唯一区别**: 0 GROUP BY 维度 (account mode =
      // single series global count). bucketMinutes inline (≠参数化, 因 bucket
      // integer 必 SQL-side floor). hours 走 ? placeholder (R93.4 function-form).
      // machine account 兜底 NOT LIKE '%$' 保留 (R158.50.7e). bucket 边界走
      // `occurred_at` (不 collected_at, 操作员 directive "事件触发时间" 1:1
      // 平行 lockout R158.X.99.35). SYSUTCDATETIME 跟 lockout 1:1. 0 改
      // hourlyAggregate / dailyAggregate (既有 caller 0 破, R158.50.7n 锁).
      // R158.111 nssm restart 必跑 + R158.86 24h probe 必跑. lesson 125/127.
      trendByBucketMinutes: ({ hours = 24, bucketMinutes = 5 } = {}) => {
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error(`failedLogon.trendByBucketMinutes: hours must be int in [1,168], got ${hours}`);
        }
        if (!Number.isInteger(bucketMinutes) || ![1, 5, 15, 30, 60, 240].includes(bucketMinutes)) {
          throw new Error(`failedLogon.trendByBucketMinutes: bucketMinutes must be one of [1,5,15,30,60,240], got ${bucketMinutes}`);
        }
        const bucketExpr = `DATEADD(MINUTE, (DATEDIFF(MINUTE, '20000101', occurred_at) / ${bucketMinutes}) * ${bucketMinutes}, '20000101')`;
        const sql =
          `SELECT ${bucketExpr} AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events
            WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
              AND target_user_name NOT LIKE '%$'
            GROUP BY ${bucketExpr}
            ORDER BY bucket_start ASC`;
        return { sql, params: [hours] };
      },
      // R158.50.7e (2026-10-07) — 服务端兜底过滤 machine account (MSSQL).
      // PS1 1.0.4 + SQL 双保险; 即便 PS1 还没下发到 0.1.1 老 agent,UI 也不
      // 显示 KDL-XXX$ 行. 防御性: target_user_name LIKE '%$' 永远排除.
      recent: `SELECT TOP (?) occurred_at, dc_name, target_user_name, target_user_display_name,
                       target_domain_name, subject_user_name, subject_domain_name,
                       caller_computer_name, ip_address, ip_port, logon_type,
                       logon_process_name, auth_package_name, failure_reason,
                       status, workstation_name
                  FROM ad_failed_logon_events
                 WHERE occurred_at >= DATEADD(HOUR, -?, GETUTCDATE())
                   AND target_user_name NOT LIKE '%$'
                 ORDER BY occurred_at DESC`,
      search: `SELECT TOP (?) occurred_at, dc_name, target_user_name, target_user_display_name,
                       target_domain_name, subject_user_name, subject_domain_name,
                       caller_computer_name, ip_address, ip_port, logon_type,
                       logon_process_name, auth_package_name, failure_reason,
                       status, workstation_name
                  FROM ad_failed_logon_events
                 WHERE occurred_at >= DATEADD(HOUR, -?, GETUTCDATE())
                   AND target_user_name NOT LIKE '%$'
                   AND (CAST(? AS NVARCHAR(128)) = '' OR dc_name = CAST(? AS NVARCHAR(128)))
                   AND (CAST(? AS NVARCHAR(256)) = '' OR target_user_name = CAST(? AS NVARCHAR(256)))
                   AND (CAST(? AS NVARCHAR(64))  = '' OR ip_address = CAST(? AS NVARCHAR(64)))
                 ORDER BY occurred_at DESC`,
      // 168h retention sweep (centre-side hourly cron).
      purgeOlderThan: `DELETE FROM ad_failed_logon_events WHERE occurred_at < ?`,
      // R158.55 (2026-10-08) — top-N workstation aggregate (MSSQL
      // mirror of MySQL helper). SELECT TOP (?) replaces LIMIT,
      // DATEADD(HOUR, DATEDIFF(HOUR, 0, ts), 0) replaces DATE_FORMAT.
      aggregateByWorkstation: ({ sinceHours = 24, topN = 5, dcName = null } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.aggregateByWorkstation: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.aggregateByWorkstation: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        // R158.111 (2026-10-16) — MSSQL mirror of MySQL aggregateByWorkstation.
        //   加 dcName 可选 filter.
        const clauses = ['occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())',
                         "target_user_name NOT LIKE '%$'"];
        const params = [sinceHours];
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        const sql =
          `SELECT TOP (?)
             COALESCE(workstation_name, '(未上报)') AS workstation_name,
             COUNT(*) AS event_count
           FROM ad_failed_logon_events
           WHERE ${clauses.join(' AND ')}
           GROUP BY COALESCE(workstation_name, '(未上报)')
           ORDER BY event_count DESC, workstation_name ASC`;
        return { sql, params: [topN, ...params] };
      },
      // R158.55 — hourly bucket trend per workstation (MSSQL mirror).
      // Mirrors lockout.trend24h MSSQL pattern (sql.js:3192-3234) with
      // agent_id → workstation_name swap. Two-path (top-N default;
      // workstation= override for single series).
      trendByWorkstation: ({ windowHours = 24, topN = 5, workstation = null } = {}) => {
        if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
          throw new Error(`failedLogon.trendByWorkstation: windowHours must be int in [1,168], got ${windowHours}`);
        }
        if (workstation) {
          const sql =
            `SELECT COALESCE(workstation_name, '(未上报)') AS workstation_name,
                    DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0) AS bucket_start,
                    COUNT(*) AS event_count
               FROM ad_failed_logon_events
              WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                AND target_user_name NOT LIKE '%$'
                AND workstation_name = ?
              GROUP BY COALESCE(workstation_name, '(未上报)'),
                       DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0)
              ORDER BY bucket_start ASC`;
          return { sql, params: [windowHours, workstation] };
        }
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.trendByWorkstation: topN must be int in [1,20], got ${topN}`);
        }
        const sql =
          `WITH top_ws AS (
             SELECT TOP (?) COALESCE(workstation_name, '(未上报)') AS workstation_name
               FROM ad_failed_logon_events
              WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                AND target_user_name NOT LIKE '%$'
              GROUP BY COALESCE(workstation_name, '(未上报)')
              ORDER BY COUNT(*) DESC
           )
           SELECT COALESCE(ws.workstation_name, '(未上报)') AS workstation_name,
                  DATEADD(HOUR, DATEDIFF(HOUR, 0, ws.occurred_at), 0) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events ws
             JOIN top_ws t ON COALESCE(ws.workstation_name, '(未上报)') = t.workstation_name
            WHERE ws.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
              AND ws.target_user_name NOT LIKE '%$'
            GROUP BY COALESCE(ws.workstation_name, '(未上报)'),
                     DATEADD(HOUR, DATEDIFF(HOUR, 0, ws.occurred_at), 0)
            ORDER BY workstation_name ASC, bucket_start ASC`;
        return { sql, params: [topN, windowHours, windowHours] };
      },
      // R158.57 (2026-10-09) — top-N DC aggregate (MSSQL mirror of
      // MySQL helper, line 1297). SELECT TOP (?) replaces LIMIT,
      // SYSUTCDATETIME() replaces UTC_TIMESTAMP(). dc_name NOT NULL
      // by agent contract; COALESCE for pre-1.0.4 historical rows.
      aggregateByDc: ({ sinceHours = 24, topN = 5, dcName = null } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.aggregateByDc: topN must be int in [1,20], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.aggregateByDc: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        // R158.111 (2026-10-16) — MSSQL mirror of MySQL aggregateByDc. 加 dcName 可选.
        const clauses = ['occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())',
                         "target_user_name NOT LIKE '%$'"];
        const params = [sinceHours];
        if (dcName) { clauses.push('dc_name = ?'); params.push(dcName); }
        const sql =
          `SELECT TOP (?)
             COALESCE(dc_name, '(未上报)') AS dc_name,
             COUNT(*) AS event_count
           FROM ad_failed_logon_events
           WHERE ${clauses.join(' AND ')}
           GROUP BY COALESCE(dc_name, '(未上报)')
           ORDER BY event_count DESC, dc_name ASC`;
        return { sql, params: [topN, ...params] };
      },
      // R158.111.a (2026-10-16) — MSSQL mirror of MySQL failedLogon.listAll
      // (sql.js:2065 紧跟 aggregateByDc 之后). 0 过滤 machine account
      // `NOT LIKE '%$'` (用户 directive "不过滤"). OFFSET/FETCH 跟 R158.65.6
      // 1:1 平行, 0 改 schema. bind 顺序:
      //   [sinceHours if any, dcName if any, searchLike×2 if any, offset, limit]
      listAll: ({ sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}) => {
        if (limit < 1 || limit > 500) {
          throw new Error(`failedLogon.listAll: limit must be in [1,500], got ${limit}`);
        }
        if (offset < 0) {
          throw new Error(`failedLogon.listAll: offset must be >= 0, got ${offset}`);
        }
        if (sinceHours !== null && (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168)) {
          throw new Error(`failedLogon.listAll: sinceHours must be null or int in [1,168], got ${sinceHours}`);
        }
        const clauses = [];
        const params = [];
        if (sinceHours !== null) {
          clauses.push('e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())');
          params.push(sinceHours);
        }
        if (dcName) { clauses.push('e.dc_name = ?'); params.push(dcName); }
        if (search) {
          clauses.push("(e.target_user_name LIKE ? OR COALESCE(e.target_user_display_name,'') LIKE ?)");
          params.push(search + '%', search + '%');
        }
        params.push(offset, limit);
        const sql =
          `SELECT e.dc_name,
                  e.target_user_name,
                  COALESCE(e.target_user_display_name, '') AS target_user_display_name,
                  COALESCE(NULLIF(e.workstation_name, ''), '') AS workstation_name,
                  4625 AS event_id,
                  e.occurred_at
             FROM ad_failed_logon_events e
            ${clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : ''}
            ORDER BY e.occurred_at DESC
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`;
        return { sql, params };
      },
      // R158.57 — hourly bucket trend per DC (MSSQL mirror, line 3431).
      // Two-path (top-N default; dc= override for single series). CTE
      // structure mirrors trendByWorkstation with workstation_name →
      // dc_name swap.
      trendByDc: ({ windowHours = 24, topN = 5, dc = null } = {}) => {
        if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
          throw new Error(`failedLogon.trendByDc: windowHours must be int in [1,168], got ${windowHours}`);
        }
        if (dc) {
          const sql =
            `SELECT COALESCE(dc_name, '(未上报)') AS dc_name,
                    DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0) AS bucket_start,
                    COUNT(*) AS event_count
               FROM ad_failed_logon_events
              WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                AND target_user_name NOT LIKE '%$'
                AND dc_name = ?
              GROUP BY COALESCE(dc_name, '(未上报)'),
                       DATEADD(HOUR, DATEDIFF(HOUR, 0, occurred_at), 0)
              ORDER BY bucket_start ASC`;
          return { sql, params: [windowHours, dc] };
        }
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) {
          throw new Error(`failedLogon.trendByDc: topN must be int in [1,20], got ${topN}`);
        }
        const sql =
          `WITH top_dc AS (
             SELECT TOP (?) COALESCE(dc_name, '(未上报)') AS dc_name
               FROM ad_failed_logon_events
              WHERE occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                AND target_user_name NOT LIKE '%$'
              GROUP BY COALESCE(dc_name, '(未上报)')
              ORDER BY COUNT(*) DESC
           )
           SELECT COALESCE(ws.dc_name, '(未上报)') AS dc_name,
                  DATEADD(HOUR, DATEDIFF(HOUR, 0, ws.occurred_at), 0) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_failed_logon_events ws
             JOIN top_dc t ON COALESCE(ws.dc_name, '(未上报)') = t.dc_name
            WHERE ws.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
              AND ws.target_user_name NOT LIKE '%$'
            GROUP BY COALESCE(ws.dc_name, '(未上报)'),
                     DATEADD(HOUR, DATEDIFF(HOUR, 0, ws.occurred_at), 0)
            ORDER BY dc_name ASC, bucket_start ASC`;
        return { sql, params: [topN, windowHours, windowHours] };
      },
      // R158.64 (2026-10-10) — MSSQL mirror of MySQL failedLogon.topByUserWithDisplay
      // (line 1440). SELECT TOP (?) + DATEADD/SYSUTCDATETIME 范式同 aggregateByDc
      // (line 3585). MSSQL 没有 GROUP_CONCAT — 用 STRING_AGG (SQL Server 2017+,
      // 1.0.0 baseline 要求 MSSQL 2019, 完全兼容). 同 shape, dcNameList 是
      // 跨多 DC 时的 comma-joined 显示 (跟 MySQL GROUP_CONCAT 等价).
      // R158.65.3 (2026-10-10) — 去掉 STRING_AGG DISTINCT, sp_executesql
      //   包装下报 "Incorrect syntax near ','" (R158.65.6 实测). 单行 dc_name
      //   唯一 (R158.65.7) 不用 DISTINCT 二次过滤.
      // R158.65.4 (2026-10-10) — CAST NVARCHAR(MAX) 解除 STRING_AGG 默认
      //   VARCHAR(8000) 字节限制 (R158.65.8 实测 liubijun 跨多 DC 聚合超
      //   8000 bytes 报 "result exceeded the limit").
      // R158.65.5 (2026-10-10) — CAST NVARCHAR(MAX) 不解 STRING_AGG 自身
      //   VARCHAR(8000) 限制 (R158.65.9 实测, 即便 cast 仍 8000 截断). 改用
      //   STUFF + FOR XML PATH 范式 (MSSQL 经典 unlimited-length 字符串聚合,
      //   R158.65.10 实测 liubijun 跨 4 DC 5-字符串 OK).
      topByUserWithDisplay: ({ sinceHours = 24, topN = 50 } = {}) => {
        if (!Number.isInteger(topN) || topN < 1 || topN > 200) {
          throw new Error(`failedLogon.topByUserWithDisplay: topN must be int in [1,200], got ${topN}`);
        }
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.topByUserWithDisplay: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        const sql =
          `SELECT TOP (?)
             e.target_user_name AS sam,
             COALESCE(MAX(e.target_user_display_name), '') AS display_name,
             COUNT(*) AS error_count,
             MAX(e.occurred_at) AS last_error_at,
             COUNT(DISTINCT e.dc_name) AS dc_count,
             STUFF((SELECT ',' + dc_name
                      FROM (SELECT DISTINCT dc_name
                              FROM ad_failed_logon_events e2
                             WHERE e2.target_user_name = e.target_user_name
                               AND e2.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())) dcs
                     ORDER BY dc_name
                       FOR XML PATH('')), 1, 1, '') AS dc_name_list
           FROM ad_failed_logon_events e
           WHERE e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
             AND e.target_user_name NOT LIKE '%$'
             AND e.target_user_name <> ''
           GROUP BY e.target_user_name
           ORDER BY error_count DESC, sam ASC`;
        // R158.65.5 — 3 个 ? 占位: topN, subquery sinceHours, outer sinceHours.
        return { sql, params: [topN, sinceHours, sinceHours] };
      },
      // R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图, graph/force + sankey).
      //   输出 {nodes, links} envelope 供 ECharts graph + sankey 复用, 1:1 平行
      //   TopologyView.vue:27,35 数据形状. 机器账户兜底 NOT LIKE '%$' 跟
      //   topByUserWithDisplay 1:1 平行 (R158.50.7e). workstation_name NULL/空串
      //   走 NULLIF(LTRIM(RTRIM(...)),'') 排除 (R158.55.7 兜底 precedent).
      //   HAVING COUNT(DISTINCT workstation) >= @minStations 强 filter, 1 user
      //   登 N 个不同工作站 = "账户在多工作站登录" 评估维度.
      accountWorkstationLinks: ({ sinceHours = 168, minStations = 1, limit = 200 } = {}) => {
        if (!Number.isInteger(sinceHours) || sinceHours < 1 || sinceHours > 168) {
          throw new Error(`failedLogon.accountWorkstationLinks: sinceHours must be int in [1,168], got ${sinceHours}`);
        }
        if (!Number.isInteger(minStations) || minStations < 1 || minStations > 50) {
          throw new Error(`failedLogon.accountWorkstationLinks: minStations must be int in [1,50], got ${minStations}`);
        }
        if (!Number.isInteger(limit) || limit < 10 || limit > 500) {
          throw new Error(`failedLogon.accountWorkstationLinks: limit must be int in [10,500], got ${limit}`);
        }
        const sql =
          `WITH edges AS (
             SELECT
               LOWER(e.target_user_name) AS sam,
               NULLIF(LTRIM(RTRIM(e.workstation_name)), '') AS workstation,
               COUNT(*) AS event_count,
               MIN(e.occurred_at) AS first_seen,
               MAX(e.occurred_at) AS last_seen,
               COUNT(DISTINCT e.dc_name) AS dc_count,
               STUFF((SELECT ',' + d.dc_name
                        FROM (SELECT DISTINCT dc_name
                                FROM ad_failed_logon_events e2
                               WHERE LOWER(e2.target_user_name) = LOWER(e.target_user_name)
                                 AND ISNULL(NULLIF(LTRIM(RTRIM(e2.workstation_name)), ''), '') =
                                     ISNULL(NULLIF(LTRIM(RTRIM(e.workstation_name)), ''), '')
                                 AND e2.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())) d
                       ORDER BY d.dc_name
                         FOR XML PATH('')), 1, 1, '') AS dc_list
             FROM ad_failed_logon_events e
             WHERE e.occurred_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
               AND e.target_user_name NOT LIKE '%$'
               AND e.target_user_name <> ''
               AND NULLIF(LTRIM(RTRIM(e.workstation_name)), '') IS NOT NULL
             GROUP BY LOWER(e.target_user_name), NULLIF(LTRIM(RTRIM(e.workstation_name)), '')
           ),
           user_summary AS (
             SELECT sam,
                    COUNT(DISTINCT workstation) AS station_count,
                    SUM(event_count) AS total_count
             FROM edges
             GROUP BY sam
             HAVING COUNT(DISTINCT workstation) >= ?
           )
           SELECT TOP (?) e.sam, e.workstation, e.event_count,
                  e.first_seen, e.last_seen, e.dc_count, e.dc_list,
                  s.station_count, s.total_count
             FROM edges e
             JOIN user_summary s ON s.sam = e.sam
             ORDER BY s.station_count DESC, e.event_count DESC, e.sam ASC, e.workstation ASC`;
        // 4 个 ? 占位: dc_list subquery sinceHours, edges sinceHours, minStations, limit.
        return { sql, params: [sinceHours, sinceHours, minStations, limit] };
      }
    },
    // R112 — ad_eventlog_* public tables. Public-page EventlogView displays
    // warning/error counts per (dc, channel) and drills into specific event
    // rows. Retention 24h — purged by centre-side hourly cron (see
    // center/src/packages/runner.js). Function-form per R93.4 — values
    // include LIMIT/TOP bindings that the static-template idiom cannot.
    // MSSQL: MERGE for upsert, CROSS APPLY for latest-per-group, TOP (?) for
    // bound limit (R93.4 / R101 dialect precedent).
    eventlog: {
      upsertEvent: ({ collectedAt, agentId, dcName, channel, severity, eventId, recordId, message, ts, auditFailure = 0 }) => ({
        sql: `MERGE INTO ad_eventlog_events AS t
          USING (SELECT
            CAST(? AS DATETIME2)     AS collected_at,
            CAST(? AS VARCHAR(64))   AS agent_id,
            CAST(? AS VARCHAR(128))  AS dc_name,
            CAST(? AS VARCHAR(32))   AS channel,
            CAST(? AS VARCHAR(16))   AS severity,
            CAST(? AS INT)           AS event_id,
            CAST(? AS BIGINT)        AS record_id,
            CAST(? AS NVARCHAR(MAX)) AS message,
            CAST(? AS DATETIME2)     AS ts,
            CAST(? AS BIT)           AS audit_failure
          ) AS s
          ON t.dc_name = s.dc_name AND t.channel = s.channel AND t.record_id = s.record_id
          WHEN MATCHED THEN UPDATE SET
            collected_at  = s.collected_at,
            audit_failure = s.audit_failure
          WHEN NOT MATCHED THEN INSERT
            (collected_at, agent_id, dc_name, channel, severity, event_id, record_id, message, ts, audit_failure)
            VALUES
            (s.collected_at, s.agent_id, s.dc_name, s.channel, s.severity,
             s.event_id, s.record_id, s.message, s.ts, s.audit_failure);`,
        params: [collectedAt, agentId, dcName, channel, severity, eventId, recordId, message, ts, auditFailure]
      }),
      upsertSummary: ({ collectedAt, agentId, dcName, channel, warningCount, errorCount, auditFailureCount = 0, droppedCount = 0 }) => ({
        sql: `MERGE INTO ad_eventlog_summary AS t
          USING (SELECT
            CAST(? AS DATETIME2)    AS collected_at,
            CAST(? AS VARCHAR(64))  AS agent_id,
            CAST(? AS VARCHAR(128)) AS dc_name,
            CAST(? AS VARCHAR(32))  AS channel,
            CAST(? AS INT)          AS warning_count,
            CAST(? AS INT)          AS error_count,
            CAST(? AS INT)          AS audit_failure_count,
            CAST(? AS INT)          AS dropped_count
          ) AS s
          ON t.dc_name = s.dc_name AND t.channel = s.channel AND t.collected_at = s.collected_at
          WHEN MATCHED THEN UPDATE SET
            warning_count       = s.warning_count,
            error_count         = s.error_count,
            audit_failure_count = s.audit_failure_count,
            dropped_count       = s.dropped_count
          WHEN NOT MATCHED THEN INSERT
            (collected_at, agent_id, dc_name, channel, warning_count, error_count, audit_failure_count, dropped_count)
            VALUES
            (s.collected_at, s.agent_id, s.dc_name, s.channel, s.warning_count, s.error_count, s.audit_failure_count, s.dropped_count);`,
        params: [collectedAt, agentId, dcName, channel, warningCount, errorCount, auditFailureCount, droppedCount]
      }),
      latestSummary: ({ sinceHours = 2 } = {}) => ({
        // R142 — site grouping fields via LEFT JOIN ad_dcs/ad_sites.
        // Mirrors R140 dashboard.agents pattern (sql.js MSSQL agents).
        // Single LEFT JOIN + WHERE-correlated TOP-1 subquery is
        // preferred over the prior CROSS APPLY + WHERE form because
        // it's a smaller diff and the subquery only references s.*
        // (no aggregation). SQL Server requires repeating the ?
        // placeholder for each occurrence; the mssql driver wrapper
        // rewrites them to @p1, @p2 in order.
        // R154 — audit_failure_count added to the SELECT list.
        // R158.52 (v1.0.5) — dropped_count surfaced for "real activity
        // was X+Y" diagnostic banner; COALESCE(NULL,0) so pre-1.0.5 rows
        // render as 0 instead of blank cells.
        sql: `SELECT s.dc_name, s.channel, s.warning_count, s.error_count,
                     s.audit_failure_count,
                     COALESCE(s.dropped_count, 0) AS dropped_count,
                     s.collected_at,
                     d.site_hint, ds.site_id, ds.site_name, ds.region_code
                FROM ad_eventlog_summary s
                LEFT JOIN ad_dcs d ON d.dc_name = s.dc_name
                LEFT JOIN ad_sites ds ON ds.site_id = d.site_id
                WHERE s.collected_at >= (DATEADD(HOUR, -?, SYSUTCDATETIME()))
                  AND s.collected_at = (
                    SELECT TOP 1 s2.collected_at
                    FROM ad_eventlog_summary s2
                    WHERE s2.dc_name = s.dc_name
                      AND s2.channel = s.channel
                      AND s2.collected_at >= (DATEADD(HOUR, -?, SYSUTCDATETIME()))
                    ORDER BY s2.collected_at DESC
                  )
                ORDER BY s.dc_name, s.channel`,
        params: [sinceHours, sinceHours]
      }),
      queryEvents: ({ dcName, channel, severity = null, sinceHours = 2, limit = 200, auditOnly = false } = {}) => {
        const params = [dcName, channel, sinceHours];
        let sevClause = '';
        if (severity) {
          sevClause = 'AND severity = CAST(? AS VARCHAR(16))';
          params.push(severity);
        }
        if (auditOnly) {
          sevClause += ' AND audit_failure = CAST(1 AS BIT)';
        }
        // R158.17.5 (2026-10-01) — MSSQL 不接受参数化 TOP / FETCH 子句
        // (driver error "The number of rows provided for a TOP or FETCH
        // clauses row count parameter must be an integer"). 把 limit
        // 当作 inline integer 拼到 SQL, 不暴露给 SQL injection 因为
        // router 已经用 clampInt(MIN_LIMIT..MAX_LIMIT) 整数夹紧, 而且
        // 这个值不是 user string 而是 server-side resolve 出来的.
        const safeLimit = Math.max(1, Math.min(200000, Number.parseInt(limit, 10) || 200));
        return {
          sql: `SELECT TOP ${safeLimit} collected_at, dc_name, channel, severity,
                       event_id, record_id, message, ts, audit_failure
                  FROM ad_eventlog_events
                 WHERE dc_name    = CAST(? AS VARCHAR(128))
                   AND channel    = CAST(? AS VARCHAR(32))
                   AND collected_at >= (DATEADD(HOUR, -?, SYSUTCDATETIME()))
                   ${sevClause}
                 ORDER BY ts DESC`,
          params
        };
      },
      // R158.X (2026-10-15) — MSSQL mirror of eventlog.queryAccountManagementEvents.
      //   跟 MySQL block char-级一致: 跨 DC, channel='Security', event_id IN
      //   inline int list (R158.100.B+3 #2 lesson 避坑, 0 N placeholder rewrite).
      //   limit 走 inline TOP 整数 (R158.17.5 precedent) — driver error 边界
      //   case, 0 参数化 TOP. eventIds 是 server-side hardcoded whitelist
      //   (router 端白名单限定), 不暴露 SQL injection 表面.
      queryAccountManagementEvents: ({ eventIds, sinceHours = 24, limit = 200 } = {}) => {
        if (!Array.isArray(eventIds) || eventIds.length === 0) {
          throw new Error('eventlog.queryAccountManagementEvents: eventIds required');
        }
        const eventIdList = eventIds.map(id => Number(id)).filter(n => Number.isInteger(n) && n > 0).join(',');
        if (!eventIdList) {
          throw new Error('eventlog.queryAccountManagementEvents: eventIds must be positive integers');
        }
        const safeLimit = Math.max(1, Math.min(200000, Number.parseInt(limit, 10) || 200));
        return {
          sql: `SELECT TOP ${safeLimit} collected_at, dc_name, channel, severity,
                       event_id, record_id, message, ts, audit_failure
                  FROM ad_eventlog_events
                 WHERE channel    = CAST('Security' AS VARCHAR(32))
                   AND event_id   IN (${eventIdList})
                   AND collected_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
                 ORDER BY ts DESC`,
          params: [sinceHours]
        };
      },
      purgeOlderThan: ({ cutoffIso }) => ({
        sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < CAST(? AS DATETIME2)',  params: [cutoffIso] },
        sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < CAST(? AS DATETIME2)',  params: [cutoffIso] }
      }),
      // R158.54 (2026-10-08) — MSSQL mirror of eventlog.trend24h.
      // SYSUTCDATETIME() not GETUTCDATE() (R101 UTC precision precedent).
      // DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0) floors to hour
      // bucket — same idiom as lockout.trend24h MSSQL (sql.js:3171+).
      trend24h: ({ hours = 24 } = {}) => {
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
          throw new Error(`eventlog.trend24h: hours must be int in [1,168], got ${hours}`);
        }
        const sql =
          `SELECT channel,
                  DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_eventlog_events
            WHERE collected_at >= DATEADD(HOUR, -?, SYSUTCDATETIME())
            GROUP BY channel, DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0)
            ORDER BY channel ASC, bucket_start ASC`;
        return { sql, params: [hours] };
      },
      // R158.108 (2026-10-16) — MSSQL mirror of eventlog.dailyAggregate.
      // 跟 hourly DATEADD(HOUR, DATEDIFF(HOUR, 0, collected_at), 0) 1:1 平行,
      // daily 改 DATEADD(DAY, DATEDIFF(DAY, 0, collected_at), 0) floor to day.
      // 0 改 trend24h, 0 改 schema, 0 改索引依赖.
      dailyAggregate: ({ days = 7 } = {}) => {
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          throw new Error(`eventlog.dailyAggregate: days must be int in [1,365], got ${days}`);
        }
        const sql =
          `SELECT channel,
                  DATEADD(DAY, DATEDIFF(DAY, 0, collected_at), 0) AS bucket_start,
                  COUNT(*) AS event_count
             FROM ad_eventlog_events
            WHERE collected_at >= DATEADD(DAY, -?, SYSUTCDATETIME())
            GROUP BY channel, DATEADD(DAY, DATEDIFF(DAY, 0, collected_at), 0)
            ORDER BY channel ASC, bucket_start ASC`;
        return { sql, params: [days] };
      },
      // R158.X.99.33 (2026-10-19) — MSSQL mirror of eventlog.trendByBucketMinutes.
// 同 MySQL: bucket 边界走 `ts` (Windows TimeGenerated), 1:1 平行 dailyAggregate
// shape. bucketMinutes ∈ {1, 5, 15, 30, 60}, 操作员 24h 5min 默认.
// MSSQL floor idiom: DATEADD(MINUTE, (DATEDIFF(MINUTE, '20000101', ts) / ?) * ?, '20000101').
trendByBucketMinutes: ({ hours = 24, bucketMinutes = 5 } = {}) => {
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new Error(`eventlog.trendByBucketMinutes: hours must be int in [1,168], got ${hours}`);
  }
  // R158.X.99.34 — whitelist 扩 240 (4h) for /eventlog 7d bucket4h (42 段).
  if (!Number.isInteger(bucketMinutes) || ![1, 5, 15, 30, 60, 240].includes(bucketMinutes)) {
    throw new Error(`eventlog.trendByBucketMinutes: bucketMinutes must be one of [1,5,15,30,60,240], got ${bucketMinutes}`);
  }
  const sql =
    `SELECT channel,
            DATEADD(MINUTE, (DATEDIFF(MINUTE, '20000101', ts) / ${bucketMinutes}) * ${bucketMinutes}, '20000101') AS bucket_start,
            COUNT(*) AS event_count
       FROM ad_eventlog_events
      WHERE ts >= DATEADD(HOUR, -?, SYSUTCDATETIME())
      GROUP BY channel, DATEADD(MINUTE, (DATEDIFF(MINUTE, '20000101', ts) / ${bucketMinutes}) * ${bucketMinutes}, '20000101')
      ORDER BY channel ASC, bucket_start ASC`;
  return { sql, params: [hours] };
},
      // R158.23 (2026-10-02) — channel-aware purge for Security 24h vs
      // other channels 4h. Same `__NOT_SECURITY__` marker as the MySQL
      // helper for the exclusion sweep.
      purgeOlderThanChannel: ({ cutoffIso, channel = null } = {}) => {
        const excludeMode = channel === '__NOT_SECURITY__';
        const includeMode = typeof channel === 'string' && !excludeMode;
        if (includeMode) {
          return {
            sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < CAST(? AS DATETIME2) AND channel = CAST(? AS VARCHAR(32))',  params: [cutoffIso, channel] },
            sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < CAST(? AS DATETIME2) AND channel = CAST(? AS VARCHAR(32))',  params: [cutoffIso, channel] }
          };
        }
        if (excludeMode) {
          return {
            sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < CAST(? AS DATETIME2) AND channel <> CAST(? AS VARCHAR(32))', params: [cutoffIso, 'Security'] },
            sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < CAST(? AS DATETIME2) AND channel <> CAST(? AS VARCHAR(32))', params: [cutoffIso, 'Security'] }
          };
        }
        return {
          sqlEvents:  { sql: 'DELETE FROM ad_eventlog_events  WHERE collected_at < CAST(? AS DATETIME2)',  params: [cutoffIso] },
          sqlSummary: { sql: 'DELETE FROM ad_eventlog_summary WHERE collected_at < CAST(? AS DATETIME2)',  params: [cutoffIso] }
        };
      }
    },
    schemaMigrations: {
      list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
      findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = CAST(? AS VARCHAR(32))',
      upsert: `MERGE INTO schema_migrations AS t
        USING (SELECT
          CAST(? AS VARCHAR(32)) AS version, CAST(? AS VARCHAR(255)) AS description, CAST(? AS VARCHAR(16)) AS type, CAST(? AS VARCHAR(255)) AS script, ? AS checksum,
          ? AS applied_at, ? AS execution_ms, CAST(? AS VARCHAR(64)) AS applied_by, CAST(? AS VARCHAR(16)) AS status, ? AS error_message
        ) AS s
        ON t.version = s.version
        WHEN MATCHED THEN UPDATE SET
          description   = s.description,
          type          = s.type,
          script        = s.script,
          checksum      = s.checksum,
          applied_at    = s.applied_at,
          execution_ms  = s.execution_ms,
          applied_by    = s.applied_by,
          status        = s.status,
          error_message = s.error_message
        WHEN NOT MATCHED THEN INSERT
          (version, description, type, script, checksum, applied_at, execution_ms, applied_by, status, error_message)
          VALUES
          (s.version, s.description, s.type, s.script, s.checksum, s.applied_at, s.execution_ms, s.applied_by, s.status, s.error_message);`,
      deleteFailed: "DELETE FROM schema_migrations WHERE version = CAST(? AS VARCHAR(32)) AND status = 'failed'",
      // 2026-08-28 round-55: refresh stale checksum without re-running SQL.
      // MSSQL needs CAST(?) on the new value because checksum is VARCHAR(64)
      // and the @pN rewriter passes through whatever the driver is given;
      // we still keep the explicit cast for clarity & safety.
      updateChecksum: "UPDATE schema_migrations SET checksum = CAST(? AS VARCHAR(64)) WHERE version = CAST(? AS VARCHAR(32)) AND status = 'applied'"
    },
    // Port self-probe state (migration 012). MSSQL uses MERGE for atomic
    // upsert (no native ON DUPLICATE KEY). Uses ? placeholders — db.execute
    // remaps ? -> @pN for MSSQL.
    probeState: {
      getAll: 'SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role',
      upsertRow: (portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures) =>
        `MERGE INTO probe_state AS t
         USING (SELECT CAST(? AS VARCHAR(16)) AS port_role, CAST(? AS VARCHAR(16)) AS status, ? AS latency_ms, ? AS last_probe_at, ? AS last_up_at, ? AS consecutive_failures) AS s
         ON t.port_role = s.port_role
         WHEN MATCHED THEN UPDATE SET
           status = s.status,
           latency_ms = s.latency_ms,
           last_probe_at = s.last_probe_at,
           last_up_at = s.last_up_at,
           consecutive_failures = s.consecutive_failures
         WHEN NOT MATCHED THEN INSERT (port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures)
           VALUES (s.port_role, s.status, s.latency_ms, s.last_probe_at, s.last_up_at, s.consecutive_failures);`
    },
    // Existence probes for migration verify markers. Returns one row when the
    // artifact exists, zero rows when it doesn't. INFORMATION_SCHEMA views are
    // already scoped to the connection's current database in MSSQL.
    probe: {
      table: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?`,
      column: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`,
      // sys.indexes joined with sys.tables; filter out heaps (type = 0) and
      // hypothetical indexes so a query for `<table>.<name>` only matches
      // real, user-visible indexes. MSSQL is case-insensitive by default for
      // identifier collation, so no LOWER/UPPER wrapping is needed.
      index: `SELECT TOP 1 1 AS ok
                FROM sys.indexes i
                JOIN sys.tables t ON i.object_id = t.object_id
               WHERE t.name = ? AND i.name = ?
                 AND i.is_hypothetical = 0 AND i.type > 0`
    },
    // Non-AD server management (migration 014). See mysql counterpart.
    memberServers: memberServers.mssql,
    // R158.X.115 (2026-10-20) — 主机退役/暂停管控状态机 SQL。见 mysql 侧注释。
    hostStatus: hostStatus.mssql,
    // R158.74 (2026-10-11) — ad_member_server_ports 业务端口表.
    memberServerPorts: memberServerPorts.mssql,
    // R158.78 (2026-10-12) — ad_member_eventlog_* member-server 事件日志专表.
    memberEventlog: memberEventlog.mssql,
    // R158.86 (2026-10-12) — ad_member_os_baseline* OS baseline 专表.
    memberOsBaseline: memberOsBaseline.mssql,
    serverGroups: serverGroups.mssql,
    systemAlerts: systemAlerts.mssql,
    // R158.Suppression — mssql 版抑制 helper 注册 (跟 mysql 版 1:1 平行).
    systemAlertSuppressions: systemAlertSuppressions.mssql,
    systemAlertOutbox: systemAlertOutbox.mssql,
    reportEmailOutbox: reportEmailOutbox.mssql,
    // R158.100.C — AD 操作通知 outbox (3rd table in delivery loop UNION).
    adNotifyOutbox: adNotifyOutbox.mssql,
    // R158.AdminEmail — License 通知 outbox (4th table in delivery loop UNION).
    // 跟 ad-notify-outbox.mssql 1:1 平行, 8 列 INSERT shape. 0 改 3 张既有 outbox.
    licenseEmailOutbox: licenseEmailOutbox.mssql,
    // R158.License-expiry — expiry 邮件 catch-up dedup (subject LIKE 查窗内同 kind
    // 已发数). 跟 R158.100.B+3 daily_reports countByKindInWindow 1:1 平行. 0 改 4 张 outbox.
    licenseExpiryDedup: licenseExpiryDedup.mssql,
    // R158.69 (2026-10-10) — 邮件历史 (EmailConfigView 新 tab). 双 dialect
    // helper 注册到 VARIANTS.mysql/mssql, 跟 systemAlerts 同模式.
    emailHistory: emailHistory.mssql,
    // R158.100.B (2026-10-14) — 邮件队列 (7th tab). 同 precedent 1:1 平行.
    emailQueue: emailQueue.mssql,
    // R158.68 — 替代 R158.62 alertMetrics.listLatestPerAgent/getLatest
    osBaselineMetrics: osBaselineMetrics.mssql,
    // R158.29 — see mysql counterpart above. Register the full
    // {mysql, mssql} dictionary (NOT `osBaselineTimeseries.mssql` —
    // buildSql's spread would clobber it back to `{}`). Caller picks the
    // active dialect key by name.
    osBaselineTimeseries: osBaselineTimeseries,
    // system_config key/value lookup — MSSQL uses MERGE for upsert (matches
    // other MSSQL patterns here). CAST(? AS VARCHAR(64)) aligns the param
    // type with the PK column.
    systemConfig: {
      getByKey: 'SELECT config_key, config_value FROM system_config WHERE config_key = CAST(? AS VARCHAR(64))',
      upsertByKey: `MERGE INTO system_config AS t USING (SELECT CAST(? AS VARCHAR(64)) AS config_key, ? AS config_value) AS s
        ON t.config_key = s.config_key
        WHEN MATCHED THEN UPDATE SET config_value = s.config_value
        WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);`
    },
    // 2026-08-31 R75 — AD admin commands. Same shape as the mysql
    // counterpart. JSON columns are NVARCHAR(MAX) — the service layer
    // JSON.stringify's on write and JSON.parse's on read (matches the
    // file-push convention). MERGE not needed here (insert + UPDATEs only).
    // The IN-list claim pattern is implemented by composing multiple
    // `id = ?` clauses (caller expands `ids` into placeholders) — matches
    // how ad.sql.audit.badge handles dynamic IN-lists.
    adAdminCommands: {
      // R158.46b — task_id 列在 queue 时刻写入. 格式: `<TARGET_DC>-<YYYYMMDDHHMMSSmmm>`.
      insert: `INSERT INTO ad_admin_commands
                 (command_type, target_dc, params_json, status, operator_id, created_at, task_id)
               VALUES (?, ?, CAST(? AS NVARCHAR(MAX)), 'queued', ?, CAST(SYSUTCDATETIME() AS DATETIME2), ?)`,
      // 2026-09-25 R93.4 — MSSQL TOP does NOT accept parameter binding
      // (only an integer literal is valid inside TOP). Until R93.4 the
      // placeholder form `TOP (?)` was bound through sp_executesql, which
      // raises 1060 "The number of rows provided for a TOP or FETCH clauses
      // row count parameter must be an integer" on every agent poll from
      // KDLFLOFADSRV2 (MSSQL center). MySQL keeps `LIMIT ?` because mysql2
      // accepts integer params there. The service layer
      // (services/ad-admin-commands.js:claimForAgent) calls this as a
      // function on MSSQL and as a plain string on MySQL — same call site
      // after safeLimit is clamped to [1, 100].
      claimPick: (limit) => `SELECT TOP ${Math.max(1, Math.min(100, Number(limit) || 5))} id FROM ad_admin_commands
                    WHERE status = CAST('queued' AS NVARCHAR(16))
                      AND target_dc = CAST(? AS NVARCHAR(128))
                    ORDER BY created_at ASC, id ASC`,
      claim: (idCount) => `UPDATE ad_admin_commands
                               SET status = CAST('running' AS NVARCHAR(16)),
                                   claimed_at = CAST(SYSUTCDATETIME() AS DATETIME2)
                             WHERE id IN (${Array(idCount).fill('?').join(',')})
                               AND status = CAST('queued' AS NVARCHAR(16))
                               AND target_dc = CAST(? AS NVARCHAR(128))`,
      // R158.46b — task_id 列: claimed row payload 也要带 (agent audit + UI).
      loadByIds: (idCount) => `SELECT id, command_type, target_dc, params_json, status,
                                       created_at, claimed_at, task_id
                                  FROM ad_admin_commands
                                 WHERE id IN (${Array(idCount).fill('?').join(',')})`,
      complete: `UPDATE ad_admin_commands
                    SET status = CAST(? AS NVARCHAR(16)),
                        result_json = CAST(? AS NVARCHAR(MAX)),
                        error_message = CAST(? AS NVARCHAR(2000)),
                        duration_ms = ?,
                        completed_at = CAST(SYSUTCDATETIME() AS DATETIME2)
                  WHERE id = ?`,
      // R158.56.2 (2026-10-08) — 改用 OFFSET/FETCH NEXT (MSSQL 2012+) 替
      // TOP+OFFSET. 原 R93.4 写法用 TOP N inline + OFFSET ? ROWS, MSSQL
      // 禁止同 query 同时用 TOP+OFFSET (server 10741). 之前没炸因为
      // operator 没刷新 /admin/ad-management-log view. R158.56 改
      // c.task_id SELECT 后 centre 重启 + diag 调 list endpoint 触发.
      //
      // OFFSET ? ROWS FETCH NEXT ? ROWS ONLY: OFFSET 跳 N 行, FETCH 取 M 行.
      // MSSQL 2012+ 标准分页. OFFSET + FETCH 都接受 integer bound param.
      // service 传 [whereParams, offset, size] (size FIRST bound param, offset LAST)
      // 跟原契约相反, 但 service 层已经在 R93.4 注释里写明 "size is FIRST
      // bound param, offset is last". MySQL 保持 LIMIT ? OFFSET ? 不变.
      listByOperator: (size) => `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.status,
                                  c.operator_id, u.username AS operator_username,
                                  c.created_at, c.claimed_at, c.completed_at,
                                  c.duration_ms, c.error_message
                             FROM ad_admin_commands c
                             LEFT JOIN sys_users u ON u.id = c.operator_id
                            WHERE c.operator_id = ?
                            ORDER BY c.created_at DESC, c.id DESC
                            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
      listAll: (size) => `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.status,
                              c.operator_id, u.username AS operator_username,
                              c.created_at, c.claimed_at, c.completed_at,
                              c.duration_ms, c.error_message
                         FROM ad_admin_commands c
                         LEFT JOIN sys_users u ON u.id = c.operator_id
                        ORDER BY c.created_at DESC, c.id DESC
                        OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
      listByStatus: (size) => `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.status,
                                c.operator_id, u.username AS operator_username,
                                c.created_at, c.claimed_at, c.completed_at,
                                c.duration_ms, c.error_message
                           FROM ad_admin_commands c
                           LEFT JOIN sys_users u ON u.id = c.operator_id
                          WHERE c.status = CAST(? AS NVARCHAR(16))
                          ORDER BY c.created_at DESC, c.id DESC
                          OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
      getById: `SELECT c.id, c.task_id, c.command_type, c.target_dc, c.params_json,
                       c.result_json, c.status, c.operator_id,
                       u.username AS operator_username,
                       c.created_at, c.claimed_at, c.completed_at,
                       c.duration_ms, c.error_message
                  FROM ad_admin_commands c
                  LEFT JOIN sys_users u ON u.id = c.operator_id
                 WHERE c.id = ?`,
      sweepTimeouts: `UPDATE ad_admin_commands
                         SET status = CAST('timeout' AS NVARCHAR(16)),
                             error_message = CAST('command exceeded timeout threshold' AS NVARCHAR(2000)),
                             completed_at = CAST(SYSUTCDATETIME() AS DATETIME2)
                       WHERE status = CAST('running' AS NVARCHAR(16))
                         AND claimed_at < DATEADD(SECOND, -?, CAST(SYSUTCDATETIME() AS DATETIME2))`,
      countAll: `SELECT COUNT(*) AS total FROM ad_admin_commands`,
      countByOperator: `SELECT COUNT(*) AS total FROM ad_admin_commands WHERE operator_id = ?`,
      countByStatus: `SELECT COUNT(*) AS total FROM ad_admin_commands WHERE status = CAST(? AS NVARCHAR(16))`
    },
    // 2026-09-05 R81 — 成员服务器 PowerShell command queue. MSSQL mirror of
    // the mysql block above. NVARCHAR(MAX) for JSON columns; SYSUTCDATETIME()
    // for UTC clock; IN-list claim pattern via ? placeholders; TOP (?) for
    // pagination (size is FIRST bound param, OFFSET is last).
    adMemberCommands: {
      insert: `INSERT INTO ad_member_commands
                 (hostname, command_type, params_json, status, operator_id, created_at)
               VALUES (CAST(? AS NVARCHAR(128)), ?, CAST(? AS NVARCHAR(MAX)), 'queued', ?, CAST(SYSUTCDATETIME() AS DATETIME2))`,
      // 2026-09-25 R93.4 — MSSQL TOP does not accept parameter binding;
      // see adAdminCommands.claimPick comment for the full root cause.
      // claimPick becomes a function so the integer limit is inlined; the
      // MySQL sibling below keeps `LIMIT ?` because mysql2 accepts it.
      claimPick: (limit) => `SELECT TOP ${Math.max(1, Math.min(100, Number(limit) || 5))} id FROM ad_member_commands
                    WHERE status = CAST('queued' AS NVARCHAR(16))
                      AND hostname = CAST(? AS NVARCHAR(128))
                    ORDER BY created_at ASC, id ASC`,
      claim: (idCount) => `UPDATE ad_member_commands
                               SET status = CAST('running' AS NVARCHAR(16)),
                                   claimed_at = CAST(SYSUTCDATETIME() AS DATETIME2)
                             WHERE id IN (${Array(idCount).fill('?').join(',')})
                               AND status = CAST('queued' AS NVARCHAR(16))
                               AND hostname = CAST(? AS NVARCHAR(128))`,
      loadByIds: (idCount) => `SELECT id, hostname, command_type, params_json, status,
                                       created_at, claimed_at
                                  FROM ad_member_commands
                                 WHERE id IN (${Array(idCount).fill('?').join(',')})`,
      complete: `UPDATE ad_member_commands
                    SET status = CAST(? AS NVARCHAR(16)),
                        result_json = CAST(? AS NVARCHAR(MAX)),
                        error_message = CAST(? AS NVARCHAR(2000)),
                        duration_ms = ?,
                        completed_at = CAST(SYSUTCDATETIME() AS DATETIME2)
                  WHERE id = ?`,
      // 2026-09-25 R93.4 — MSSQL TOP does not accept parameter binding (only an
      // integer literal). Function-form so the limit is inlined.
      //
      // 2026-10-20 FIX (R158 verification) — the previous revision of these four
      // helpers emitted `SELECT TOP <n> ... ORDER BY ... OFFSET ? ROWS`. That is
      // rejected by MSSQL with error 10741: "A TOP can not be used in the same
      // query or sub-query as a OFFSET." The old comment assumed the only
      // limitation was TOP-vs-parameter-binding and that OFFSET bound fine —
      // true in isolation, but TOP and OFFSET are mutually exclusive paging
      // mechanisms in T-SQL. Result: GET /api/admin/member-commands returned
      // 500 on every call (all four list helpers were affected).
      //
      // Fix: drop TOP entirely and page with `OFFSET ? ROWS FETCH NEXT n ROWS
      // ONLY`, which is the canonical T-SQL pagination form. FETCH NEXT must
      // be inlined as an integer literal for the same reason TOP was. The
      // MySQL siblings keep `LIMIT ? OFFSET ?` — mysql2 accepts bound
      // integers in both positions. Caller dispatch is unchanged:
      // services/member-commands.js:listCommands passes `Number(size)` on
      // MSSQL and skips it on MySQL; OFFSET is always bound.
      listByOperator: (size) => `SELECT c.id, c.hostname, c.command_type, c.status,
                                  c.operator_id, u.username AS operator_username,
                                  c.created_at, c.claimed_at, c.completed_at,
                                  c.duration_ms, c.error_message
                             FROM ad_member_commands c
                             LEFT JOIN sys_users u ON u.id = c.operator_id
                            WHERE c.operator_id = ?
                            ORDER BY c.created_at DESC, c.id DESC
                            OFFSET ? ROWS FETCH NEXT ${Math.max(1, Math.min(200, Number(size) || 20))} ROWS ONLY`,
      listAll: (size) => `SELECT c.id, c.hostname, c.command_type, c.status,
                              c.operator_id, u.username AS operator_username,
                              c.created_at, c.claimed_at, c.completed_at,
                              c.duration_ms, c.error_message
                         FROM ad_member_commands c
                         LEFT JOIN sys_users u ON u.id = c.operator_id
                        ORDER BY c.created_at DESC, c.id DESC
                        OFFSET ? ROWS FETCH NEXT ${Math.max(1, Math.min(200, Number(size) || 20))} ROWS ONLY`,
      listByStatus: (size) => `SELECT c.id, c.hostname, c.command_type, c.status,
                                c.operator_id, u.username AS operator_username,
                                c.created_at, c.claimed_at, c.completed_at,
                                c.duration_ms, c.error_message
                           FROM ad_member_commands c
                           LEFT JOIN sys_users u ON u.id = c.operator_id
                          WHERE c.status = CAST(? AS NVARCHAR(16))
                          ORDER BY c.created_at DESC, c.id DESC
                          OFFSET ? ROWS FETCH NEXT ${Math.max(1, Math.min(200, Number(size) || 20))} ROWS ONLY`,
      listByHost: (size) => `SELECT c.id, c.hostname, c.command_type, c.status,
                              c.operator_id, u.username AS operator_username,
                              c.created_at, c.claimed_at, c.completed_at,
                              c.duration_ms, c.error_message
                         FROM ad_member_commands c
                         LEFT JOIN sys_users u ON u.id = c.operator_id
                        WHERE c.hostname = CAST(? AS NVARCHAR(128))
                        ORDER BY c.created_at DESC, c.id DESC
                        OFFSET ? ROWS FETCH NEXT ${Math.max(1, Math.min(200, Number(size) || 20))} ROWS ONLY`,
      getById: `SELECT c.id, c.hostname, c.command_type, c.params_json,
                       c.result_json, c.status, c.operator_id,
                       u.username AS operator_username,
                       c.created_at, c.claimed_at, c.completed_at,
                       c.duration_ms, c.error_message
                  FROM ad_member_commands c
                  LEFT JOIN sys_users u ON u.id = c.operator_id
                 WHERE c.id = ?`,
      sweepTimeouts: `UPDATE ad_member_commands
                         SET status = CAST('timeout' AS NVARCHAR(16)),
                             error_message = CAST('command exceeded timeout threshold' AS NVARCHAR(2000)),
                             completed_at = CAST(SYSUTCDATETIME() AS DATETIME2)
                       WHERE status = CAST('running' AS NVARCHAR(16))
                         AND claimed_at < DATEADD(SECOND, -?, CAST(SYSUTCDATETIME() AS DATETIME2))`,
      countRecentForHost: `SELECT COUNT(*) AS n FROM ad_member_commands
                            WHERE hostname = CAST(? AS NVARCHAR(128))
                              AND status IN (CAST('queued' AS NVARCHAR(16)), CAST('running' AS NVARCHAR(16)))
                              AND created_at >= DATEADD(MINUTE, -1, SYSUTCDATETIME())`,
      countAll: `SELECT COUNT(*) AS total FROM ad_member_commands`,
      countByOperator: `SELECT COUNT(*) AS total FROM ad_member_commands WHERE operator_id = ?`,
      countByStatus: `SELECT COUNT(*) AS total FROM ad_member_commands WHERE status = CAST(? AS NVARCHAR(16))`,
      countByHost: `SELECT COUNT(*) AS total FROM ad_member_commands WHERE hostname = CAST(? AS NVARCHAR(128))`
    },
    // R114 — centre→agent remote port probe (MSSQL mirror).
    // Spec: docs/superpowers/specs/2026-09-26-r114-centre-remote-port-probe-design.md §4.2
    remotePortProbe: {
      // MERGE pattern (R93.4 / R101 dialect precedent). ON uq_remote_probe_dc_port.
      upsertOne: `MERGE INTO ad_remote_port_probe AS t
         USING (SELECT
           CAST(? AS DATETIME2)       AS probe_at,
           CAST(? AS NVARCHAR(128))   AS dc_name,
           ?                          AS port,
           ?                          AS ok,
           ?                          AS latency_ms,
           CAST(? AS NVARCHAR(255))   AS error
         ) AS s
         ON t.dc_name = s.dc_name AND t.port = s.port
         WHEN MATCHED THEN UPDATE SET
           probe_at = s.probe_at,
           ok = s.ok,
           latency_ms = s.latency_ms,
           error = s.error
         WHEN NOT MATCHED THEN INSERT
           (probe_at, dc_name, port, ok, latency_ms, error)
           VALUES (s.probe_at, s.dc_name, s.port, s.ok, s.latency_ms, s.error);`,
      listForDcs: (placeholders) => `SELECT rpp.dc_name AS dcName, rpp.port, rpp.ok,
               rpp.latency_ms AS latencyMs, rpp.probe_at AS probeAt, rpp.error,
               sp.label AS label
         FROM ad_remote_port_probe rpp
         INNER JOIN system_ports sp ON rpp.port = sp.port
         WHERE rpp.dc_name IN (${placeholders})
         ORDER BY sp.sort_order, sp.port`,
      // MAX aggregate in MSSQL is the same as MySQL; no TOP 1 needed because
      // GROUP BY returns one row per dc.
      probeAtByDcs: (placeholders) => `SELECT rpp.dc_name AS dcName,
               MAX(rpp.probe_at) AS lastConnectAt
         FROM ad_remote_port_probe rpp
         WHERE rpp.dc_name IN (${placeholders})
         GROUP BY rpp.dc_name`,
      dcList: `SELECT DISTINCT dc_name FROM ad_dcs ORDER BY dc_name`
    },
    // R114 — system_settings KV (MSSQL mirror).
    systemSettings: {
      get: `SELECT setting_value FROM system_settings WHERE setting_key = CAST(? AS NVARCHAR(64))`,
      upsert: `MERGE INTO system_settings AS t
         USING (SELECT
           CAST(? AS NVARCHAR(64))    AS setting_key,
           CAST(? AS NVARCHAR(255))   AS setting_value,
           CAST(SYSUTCDATETIME() AS DATETIME2) AS updated_at
         ) AS s
         ON t.setting_key = s.setting_key
         WHEN MATCHED THEN UPDATE SET
           setting_value = s.setting_value,
           updated_at = s.updated_at
         WHEN NOT MATCHED THEN INSERT
           (setting_key, setting_value, updated_at)
           VALUES (s.setting_key, s.setting_value, s.updated_at);`
    },
    // R158.35 (2026-10-03) — AD directory LDAP sync (MSSQL mirror). MSSQL
    // has no ON DUPLICATE KEY UPDATE so we use MERGE for the per-row
    // upsert. SCOPE_IDENTITY() returns the just-inserted id; OR the row
    // is updated via WHEN MATCHED. Both branches return via the same SQL
    // statement so caller treats them as a black box. Orphan DELETE is
    // composed at runtime (chunked IN-list) — see services/ad-directory-sync.js.
    directorySync: {
      // Insert a fresh run row. MSSQL IDENTITY + SCOPE_IDENTITY lets the
      // caller fetch the new id without a follow-up SELECT. Caller binds
      // [dc_name, triggered_by].
      insertRun: `INSERT INTO ad_directory_sync_runs (dc_name, started_at, status, triggered_by)
                  VALUES (CAST(? AS NVARCHAR(128)),
                          CAST(SYSUTCDATETIME() AS DATETIME2),
                          CAST('running' AS NVARCHAR(16)),
                          CAST(? AS NVARCHAR(16)));
                  SELECT SCOPE_IDENTITY() AS id;`,
      // Finalize a run. Caller binds [status, user_count, group_count,
      // ou_count, computer_count, error_message, id].
      // R158.44.7.10 (2026-10-05) — added computer_count (positioned after ou_count).
      finalizeRun: `UPDATE ad_directory_sync_runs
                    SET finished_at = CAST(SYSUTCDATETIME() AS DATETIME2),
                        status = CAST(? AS NVARCHAR(16)),
                        user_count = ?,
                        group_count = ?,
                        ou_count = ?,
                        computer_count = ?,
                        error_message = CAST(? AS NVARCHAR(2000))
                    WHERE id = ?`,
      // UPSERT user snapshot via MERGE (per-row; v1 cadence is 4h so the
      // round-trip count is acceptable). Caller binds 16 params.
      // R158.36 (2026-10-03) added description + manager_dn + manager_sam.
      upsertUser: `MERGE INTO ad_users_snapshot AS tgt
                   USING (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                 CAST(? AS NVARCHAR(256)) AS sam,
                                 CAST(? AS NVARCHAR(512)) AS display_name,
                                 CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                 CAST(? AS NVARCHAR(1024)) AS ou_dn,
                                 CAST(? AS BIT) AS enabled,
                                 CAST(? AS BIT) AS locked_out,
                                 CAST(? AS DATETIME2) AS last_logon,
                                 CAST(? AS DATETIME2) AS when_created,
                                 CAST(? AS DATETIME2) AS password_last_set,
                                 CAST(? AS INT) AS user_account_control,
                                 CAST(? AS NVARCHAR(1024)) AS description,
                                 CAST(? AS NVARCHAR(1024)) AS manager_dn,
                                 CAST(? AS NVARCHAR(256)) AS manager_sam,
                                 CAST(? AS DATETIME2) AS snapshot_at,
                                 CAST(? AS BIGINT) AS snapshot_run_id) AS src
                   ON (tgt.domain_name = src.domain_name AND tgt.sam = src.sam)
                   WHEN MATCHED THEN UPDATE SET
                     display_name = src.display_name,
                     distinguished_name = src.distinguished_name,
                     ou_dn = src.ou_dn,
                     enabled = src.enabled,
                     locked_out = src.locked_out,
                     last_logon = src.last_logon,
                     when_created = src.when_created,
                     password_last_set = src.password_last_set,
                     user_account_control = src.user_account_control,
                     description = src.description,
                     manager_dn = src.manager_dn,
                     manager_sam = src.manager_sam,
                     snapshot_at = src.snapshot_at,
                     snapshot_run_id = src.snapshot_run_id
                   WHEN NOT MATCHED THEN
                     INSERT (domain_name, sam, display_name, distinguished_name, ou_dn,
                             enabled, locked_out, last_logon, when_created,
                             password_last_set, user_account_control,
                             description, manager_dn, manager_sam,
                             snapshot_at, snapshot_run_id)
                     VALUES (src.domain_name, src.sam, src.display_name, src.distinguished_name, src.ou_dn,
                             src.enabled, src.locked_out, src.last_logon, src.when_created,
                             src.password_last_set, src.user_account_control,
                             src.description, src.manager_dn, src.manager_sam,
                             src.snapshot_at, src.snapshot_run_id);`,
      // UPSERT group snapshot. PK (domain_name, name). 11 params.
      // R158.44.7.7 (2026-10-05) — added ou_dn column.
      upsertGroup: `MERGE INTO ad_groups_snapshot AS tgt
                    USING (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                  CAST(? AS NVARCHAR(256)) AS name,
                                  CAST(? AS NVARCHAR(256)) AS sam_account_name,
                                  CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                  CAST(? AS NVARCHAR(1024)) AS ou_dn,
                                  CAST(? AS INT) AS group_type,
                                  CAST(? AS NVARCHAR(16)) AS group_scope,
                                  CAST(? AS NVARCHAR(2048)) AS description,
                                  CAST(? AS INT) AS member_count,
                                  CAST(? AS DATETIME2) AS snapshot_at,
                                  CAST(? AS BIGINT) AS snapshot_run_id) AS src
                    ON (tgt.domain_name = src.domain_name AND tgt.name = src.name)
                    WHEN MATCHED THEN UPDATE SET
                      sam_account_name = src.sam_account_name,
                      distinguished_name = src.distinguished_name,
                      ou_dn = src.ou_dn,
                      group_type = src.group_type,
                      group_scope = src.group_scope,
                      description = src.description,
                      member_count = src.member_count,
                      snapshot_at = src.snapshot_at,
                      snapshot_run_id = src.snapshot_run_id
                    WHEN NOT MATCHED THEN
                      INSERT (domain_name, name, sam_account_name, distinguished_name, ou_dn,
                              group_type, group_scope, description, member_count,
                              snapshot_at, snapshot_run_id)
                      VALUES (src.domain_name, src.name, src.sam_account_name, src.distinguished_name, src.ou_dn,
                              src.group_type, src.group_scope, src.description, src.member_count,
                              src.snapshot_at, src.snapshot_run_id);`,
      // R161.3 (2026-10-25) — ON 子句改用哈希列. 真因: distinguished_name 是
      //   NVARCHAR(1024) = 2050 字节, 超过 SQL Server 任何索引键上限
      //   (聚集主键 900 / 非聚集 1700), 且**没有前缀索引**可用 ⇒ 基线把
      //   唯一键搬到 DB 侧计算列 distinguished_name_hash (BINARY(32), PERSISTED)。
      //   若 MERGE 的 ON 子句还比原始长列 ⇒ 无索引可用 ⇒ 每条 MERGE 全表扫
      //   ⇒ 逐行 ETL 是 O(N²)。实测 (3000 行表 / 300 条 MERGE): 原始列
      //   1872ms vs 哈希列 181ms, 差 10.4 倍 ⇒ 必须改。
      //   源侧用 s.* 包一层再算哈希, 这样**不新增占位符**, 参数顺序不变。
      //   MySQL 侧不用改: ON DUPLICATE KEY UPDATE 靠唯一键自己判定重复。
      // UPSERT OU snapshot. 9 params.
      upsertOu: `MERGE INTO ad_ous_snapshot AS tgt
                 USING (SELECT s.*,
                               CONVERT(BINARY(32), HASHBYTES('SHA2_256', s.distinguished_name)) AS distinguished_name_hash
                        FROM (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                     CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                     CAST(? AS NVARCHAR(256)) AS name,
                                     CAST(? AS NVARCHAR(2048)) AS description,
                                     CAST(? AS DATETIME2) AS when_created,
                                     CAST(? AS DATETIME2) AS when_changed,
                                     CAST(? AS NVARCHAR(1024)) AS parent_dn,
                                     CAST(? AS DATETIME2) AS snapshot_at,
                                     CAST(? AS BIGINT) AS snapshot_run_id) AS s
                 ) AS src
                 ON (tgt.domain_name = src.domain_name AND tgt.distinguished_name_hash = src.distinguished_name_hash)
                 WHEN MATCHED THEN UPDATE SET
                   name = src.name,
                   description = src.description,
                   when_created = src.when_created,
                   when_changed = src.when_changed,
                   parent_dn = src.parent_dn,
                   snapshot_at = src.snapshot_at,
                   snapshot_run_id = src.snapshot_run_id
                 WHEN NOT MATCHED THEN
                   INSERT (domain_name, distinguished_name, name, description,
                           when_created, when_changed, parent_dn,
                           snapshot_at, snapshot_run_id)
                   VALUES (src.domain_name, src.distinguished_name, src.name, src.description,
                           src.when_created, src.when_changed, src.parent_dn,
                           src.snapshot_at, src.snapshot_run_id);`,
      // R158.44.7.10 (2026-10-05) — UPSERT computer snapshot via MERGE.
      // PK (domain_name, sam_account_name). 19 params.
      upsertComputer: `MERGE INTO ad_computers_snapshot AS tgt
                       USING (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                     CAST(? AS NVARCHAR(256)) AS sam_account_name,
                                     CAST(? AS NVARCHAR(256)) AS cn,
                                     CAST(? AS NVARCHAR(256)) AS name,
                                     CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                     CAST(? AS NVARCHAR(1024)) AS ou_dn,
                                     ? AS enabled,
                                     ? AS is_server,
                                     CAST(? AS NVARCHAR(512)) AS operating_system,
                                     CAST(? AS NVARCHAR(128)) AS operating_system_version,
                                     CAST(? AS NVARCHAR(256)) AS dns_host_name,
                                     CAST(? AS DATETIME2) AS last_logon,
                                     CAST(? AS DATETIME2) AS when_created,
                                     CAST(? AS DATETIME2) AS when_changed,
                                     CAST(? AS NVARCHAR(1024)) AS description,
                                     CAST(? AS NVARCHAR(256)) AS managed_by_dn,
                                     CAST(? AS NVARCHAR(256)) AS managed_by_sam,
                                     CAST(? AS DATETIME2) AS snapshot_at,
                                     CAST(? AS BIGINT) AS snapshot_run_id) AS src
                       ON (tgt.domain_name = src.domain_name AND tgt.sam_account_name = src.sam_account_name)
                       WHEN MATCHED THEN UPDATE SET
                         cn = src.cn,
                         name = src.name,
                         distinguished_name = src.distinguished_name,
                         ou_dn = src.ou_dn,
                         enabled = src.enabled,
                         is_server = src.is_server,
                         operating_system = src.operating_system,
                         operating_system_version = src.operating_system_version,
                         dns_host_name = src.dns_host_name,
                         last_logon = src.last_logon,
                         when_created = src.when_created,
                         when_changed = src.when_changed,
                         description = src.description,
                         managed_by_dn = src.managed_by_dn,
                         managed_by_sam = src.managed_by_sam,
                         snapshot_at = src.snapshot_at,
                         snapshot_run_id = src.snapshot_run_id
                       WHEN NOT MATCHED THEN
                         INSERT (domain_name, sam_account_name, cn, name, distinguished_name, ou_dn,
                                 enabled, is_server,
                                 operating_system, operating_system_version, dns_host_name,
                                 last_logon, when_created, when_changed,
                                 description, managed_by_dn, managed_by_sam,
                                 snapshot_at, snapshot_run_id)
                         VALUES (src.domain_name, src.sam_account_name, src.cn, src.name, src.distinguished_name, src.ou_dn,
                                 src.enabled, src.is_server,
                                 src.operating_system, src.operating_system_version, src.dns_host_name,
                                 src.last_logon, src.when_created, src.when_changed,
                                 src.description, src.managed_by_dn, src.managed_by_sam,
                                 src.snapshot_at, src.snapshot_run_id);`,
      // R158.60.20 (2026-10-09) — user-group memberships. MSSQL MERGE.
      // R161.3 (2026-10-25) — ON 子句改用哈希列 group_dn_hash. 真因:
      //   group_dn 是 NVARCHAR(1024) = 2050 字节, 超过 SQL Server 任何索引键
      //   上限, 且没有前缀索引 ⇒ 基线把唯一键搬到 DB 侧计算列 group_dn_hash
      //   (BINARY(32), PERSISTED)。ON 子句若还比原始长列 ⇒ 无索引可用 ⇒
      //   每条 MERGE 全表扫 ⇒ 逐行 ETL 是 O(N²)。实测差 10.4 倍 ⇒ 必须改。
      //   源侧用 s.* 包一层再算哈希, **不新增占位符**, 参数顺序不变。
      upsertUgm: `MERGE INTO ad_user_group_memberships AS tgt
                  USING (SELECT s.*,
                                CONVERT(BINARY(32), HASHBYTES('SHA2_256', s.group_dn)) AS group_dn_hash
                       FROM (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                     CAST(? AS NVARCHAR(256)) AS user_sam,
                                     CAST(? AS NVARCHAR(1024)) AS group_dn,
                                     CAST(? AS NVARCHAR(256)) AS group_name,
                                     CAST(? AS DATETIME2) AS snapshot_at,
                                     CAST(? AS BIGINT) AS snapshot_run_id) AS s
                  ) AS src
                     ON (tgt.domain_name = src.domain_name
                         AND tgt.user_sam = src.user_sam
                         AND tgt.group_dn_hash = src.group_dn_hash)
                  WHEN MATCHED THEN UPDATE SET
                     group_name = src.group_name,
                     snapshot_at = src.snapshot_at,
                     snapshot_run_id = src.snapshot_run_id
                  WHEN NOT MATCHED THEN
                     INSERT (domain_name, user_sam, group_dn, group_name,
                             snapshot_at, snapshot_run_id)
                     VALUES (src.domain_name, src.user_sam, src.group_dn, src.group_name,
                             src.snapshot_at, src.snapshot_run_id);`,
      listGroupsForUser: `SELECT group_name
                            FROM ad_user_group_memberships
                           WHERE domain_name = ? AND user_sam = ?
                           ORDER BY group_name`,
      // R158.60.22 (2026-10-09) — group members. Caller binds
      // [domain_name, group_name].
      listMembersForGroup: `SELECT user_sam
                              FROM ad_user_group_memberships
                             WHERE domain_name = ? AND LOWER(group_name) = LOWER(?)
                             ORDER BY user_sam`,
      // List recent runs. MSSQL uses OFFSET/FETCH (TOP can't take a
      // parameter directly without dynamic SQL). Caller binds [limit].
      listRuns: `SELECT id, dc_name, started_at, finished_at, status,
                        user_count, group_count, ou_count, error_message, triggered_by
                 FROM ad_directory_sync_runs
                 ORDER BY started_at DESC
                 OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY`,
      // Most recent successful run.
      latestSuccess: `SELECT TOP 1 id, dc_name, started_at, finished_at, status,
                              user_count, group_count, ou_count, error_message
                      FROM ad_directory_sync_runs
                      WHERE status = CAST('success' AS NVARCHAR(16))
                      ORDER BY finished_at DESC`,

      // R158.38 — binding-driven LDAP sync: MSSQL 版本. insertRun 多
      // forest_id + domain_id 占位符; MERGE 加 src.forest_id/domain_id.
      // finalizeRun 与 mysql 版同形 (8 params); listRunsWithForest 用 LEFT JOIN
      // forest / domain 取语义化字段.
      insertRunWithForest: `INSERT INTO ad_directory_sync_runs (dc_name, started_at, status, triggered_by, forest_id, domain_id)
                            VALUES (CAST(? AS NVARCHAR(128)),
                                    CAST(SYSUTCDATETIME() AS DATETIME2),
                                    CAST('running' AS NVARCHAR(16)),
                                    CAST(? AS NVARCHAR(16)),
                                    CAST(? AS BIGINT),
                                    CAST(? AS BIGINT));
                            SELECT SCOPE_IDENTITY() AS id;`,
      finalizeRunWithForest: `UPDATE ad_directory_sync_runs
                              SET finished_at = CAST(SYSUTCDATETIME() AS DATETIME2),
                                  status = CAST(? AS NVARCHAR(16)),
                                  user_count = ?,
                                  group_count = ?,
                                  ou_count = ?,
                                  computer_count = ?,
                                  error_message = CAST(? AS NVARCHAR(2000))
                              WHERE id = ?`,
      upsertUserWithForest: `MERGE INTO ad_users_snapshot AS tgt
                             USING (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                           CAST(? AS NVARCHAR(256)) AS sam,
                                           CAST(? AS NVARCHAR(512)) AS display_name,
                                           CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                           CAST(? AS NVARCHAR(1024)) AS ou_dn,
                                           CAST(? AS BIT) AS enabled,
                                           CAST(? AS BIT) AS locked_out,
                                           CAST(? AS DATETIME2) AS last_logon,
                                           CAST(? AS DATETIME2) AS when_created,
                                           CAST(? AS DATETIME2) AS password_last_set,
                                           CAST(? AS INT) AS user_account_control,
                                           CAST(? AS NVARCHAR(1024)) AS description,
                                           CAST(? AS NVARCHAR(1024)) AS manager_dn,
                                           CAST(? AS NVARCHAR(256)) AS manager_sam,
                                           CAST(? AS DATETIME2) AS snapshot_at,
                                           CAST(? AS BIGINT) AS snapshot_run_id,
                                           CAST(? AS BIGINT) AS forest_id,
                                           CAST(? AS BIGINT) AS domain_id) AS src
                             ON (tgt.domain_name = src.domain_name AND tgt.sam = src.sam)
                             WHEN MATCHED THEN UPDATE SET
                               display_name = src.display_name,
                               distinguished_name = src.distinguished_name,
                               ou_dn = src.ou_dn,
                               enabled = src.enabled,
                               locked_out = src.locked_out,
                               last_logon = src.last_logon,
                               when_created = src.when_created,
                               password_last_set = src.password_last_set,
                               user_account_control = src.user_account_control,
                               description = src.description,
                               manager_dn = src.manager_dn,
                               manager_sam = src.manager_sam,
                               snapshot_at = src.snapshot_at,
                               snapshot_run_id = src.snapshot_run_id,
                               forest_id = src.forest_id,
                               domain_id = src.domain_id
                             WHEN NOT MATCHED THEN
                               INSERT (domain_name, sam, display_name, distinguished_name, ou_dn,
                                       enabled, locked_out, last_logon, when_created,
                                       password_last_set, user_account_control,
                                       description, manager_dn, manager_sam,
                                       snapshot_at, snapshot_run_id, forest_id, domain_id)
                               VALUES (src.domain_name, src.sam, src.display_name, src.distinguished_name, src.ou_dn,
                                       src.enabled, src.locked_out, src.last_logon, src.when_created,
                                       src.password_last_set, src.user_account_control,
                                       src.description, src.manager_dn, src.manager_sam,
                                       src.snapshot_at, src.snapshot_run_id, src.forest_id, src.domain_id);`,
      upsertGroupWithForest: `MERGE INTO ad_groups_snapshot AS tgt
                              USING (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                            CAST(? AS NVARCHAR(256)) AS name,
                                            CAST(? AS NVARCHAR(256)) AS sam_account_name,
                                            CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                            CAST(? AS NVARCHAR(1024)) AS ou_dn,
                                            CAST(? AS INT) AS group_type,
                                            CAST(? AS NVARCHAR(16)) AS group_scope,
                                            CAST(? AS NVARCHAR(2048)) AS description,
                                            CAST(? AS INT) AS member_count,
                                            CAST(? AS DATETIME2) AS snapshot_at,
                                            CAST(? AS BIGINT) AS snapshot_run_id,
                                            CAST(? AS BIGINT) AS forest_id,
                                            CAST(? AS BIGINT) AS domain_id) AS src
                              ON (tgt.domain_name = src.domain_name AND tgt.name = src.name)
                              WHEN MATCHED THEN UPDATE SET
                                sam_account_name = src.sam_account_name,
                                distinguished_name = src.distinguished_name,
                                ou_dn = src.ou_dn,
                                group_type = src.group_type,
                                group_scope = src.group_scope,
                                description = src.description,
                                member_count = src.member_count,
                                snapshot_at = src.snapshot_at,
                                snapshot_run_id = src.snapshot_run_id,
                                forest_id = src.forest_id,
                                domain_id = src.domain_id
                              WHEN NOT MATCHED THEN
                                INSERT (domain_name, name, sam_account_name, distinguished_name, ou_dn,
                                        group_type, group_scope, description, member_count,
                                        snapshot_at, snapshot_run_id, forest_id, domain_id)
                                VALUES (src.domain_name, src.name, src.sam_account_name, src.distinguished_name, src.ou_dn,
                                        src.group_type, src.group_scope, src.description, src.member_count,
                                        src.snapshot_at, src.snapshot_run_id, src.forest_id, src.domain_id);`,
      // R161.3 (2026-10-25) — ON 子句改用哈希列 (同 upsertOu 的理由):
      //   distinguished_name 是 NVARCHAR(1024) = 2050 字节, 进不了任何索引键,
      //   SQL Server 又没有前缀索引 ⇒ 唯一键在 DB 侧计算列
      //   distinguished_name_hash 上。ON 子句比原始长列 ⇒ 每条 MERGE 全表扫
      //   ⇒ 逐行 ETL O(N²)。源侧 s.* 包一层算哈希, 不新增占位符。
      upsertOuWithForest: `MERGE INTO ad_ous_snapshot AS tgt
                           USING (SELECT s.*,
                                         CONVERT(BINARY(32), HASHBYTES('SHA2_256', s.distinguished_name)) AS distinguished_name_hash
                                  FROM (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                               CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                               CAST(? AS NVARCHAR(256)) AS name,
                                               CAST(? AS NVARCHAR(2048)) AS description,
                                               CAST(? AS DATETIME2) AS when_created,
                                               CAST(? AS DATETIME2) AS when_changed,
                                               CAST(? AS NVARCHAR(1024)) AS parent_dn,
                                               CAST(? AS DATETIME2) AS snapshot_at,
                                               CAST(? AS BIGINT) AS snapshot_run_id,
                                               CAST(? AS BIGINT) AS forest_id,
                                               CAST(? AS BIGINT) AS domain_id) AS s
                           ) AS src
                           ON (tgt.domain_name = src.domain_name AND tgt.distinguished_name_hash = src.distinguished_name_hash)
                           WHEN MATCHED THEN UPDATE SET
                               name = src.name,
                               description = src.description,
                               when_created = src.when_created,
                               when_changed = src.when_changed,
                               parent_dn = src.parent_dn,
                               snapshot_at = src.snapshot_at,
                               snapshot_run_id = src.snapshot_run_id,
                               forest_id = src.forest_id,
                               domain_id = src.domain_id
                           WHEN NOT MATCHED THEN
                             INSERT (domain_name, distinguished_name, name, description,
                                     when_created, when_changed, parent_dn,
                                     snapshot_at, snapshot_run_id, forest_id, domain_id)
                             VALUES (src.domain_name, src.distinguished_name, src.name, src.description,
                                     src.when_created, src.when_changed, src.parent_dn,
                                     src.snapshot_at, src.snapshot_run_id, src.forest_id, src.domain_id);`,
      listRunsWithForest: `SELECT r.id, r.dc_name, r.started_at, r.finished_at, r.status,
                                  r.user_count, r.group_count, r.ou_count, r.error_message, r.triggered_by,
                                  r.forest_id, r.domain_id,
                                  f.forest_name, d.domain_name
                           FROM ad_directory_sync_runs r
                           LEFT JOIN ad_forest f ON f.id = r.forest_id
                           LEFT JOIN ad_forest_domain d ON d.id = r.domain_id
                           ORDER BY r.started_at DESC
                           OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY`,
      // R158.44.7.10 (2026-10-05) — UPSERT computer snapshot (with forest_id/domain_id). 21 params.
      upsertComputerWithForest: `MERGE INTO ad_computers_snapshot AS tgt
                                 USING (SELECT CAST(? AS NVARCHAR(128)) AS domain_name,
                                               CAST(? AS NVARCHAR(256)) AS sam_account_name,
                                               CAST(? AS NVARCHAR(256)) AS cn,
                                               CAST(? AS NVARCHAR(256)) AS name,
                                               CAST(? AS NVARCHAR(1024)) AS distinguished_name,
                                               CAST(? AS NVARCHAR(1024)) AS ou_dn,
                                               ? AS enabled,
                                               ? AS is_server,
                                               CAST(? AS NVARCHAR(512)) AS operating_system,
                                               CAST(? AS NVARCHAR(128)) AS operating_system_version,
                                               CAST(? AS NVARCHAR(256)) AS dns_host_name,
                                               CAST(? AS DATETIME2) AS last_logon,
                                               CAST(? AS DATETIME2) AS when_created,
                                               CAST(? AS DATETIME2) AS when_changed,
                                               CAST(? AS NVARCHAR(1024)) AS description,
                                               CAST(? AS NVARCHAR(256)) AS managed_by_dn,
                                               CAST(? AS NVARCHAR(256)) AS managed_by_sam,
                                               CAST(? AS DATETIME2) AS snapshot_at,
                                               CAST(? AS BIGINT) AS snapshot_run_id,
                                               CAST(? AS BIGINT) AS forest_id,
                                               CAST(? AS BIGINT) AS domain_id) AS src
                                 ON (tgt.domain_name = src.domain_name AND tgt.sam_account_name = src.sam_account_name)
                                 WHEN MATCHED THEN UPDATE SET
                                   cn = src.cn,
                                   name = src.name,
                                   distinguished_name = src.distinguished_name,
                                   ou_dn = src.ou_dn,
                                   enabled = src.enabled,
                                   is_server = src.is_server,
                                   operating_system = src.operating_system,
                                   operating_system_version = src.operating_system_version,
                                   dns_host_name = src.dns_host_name,
                                   last_logon = src.last_logon,
                                   when_created = src.when_created,
                                   when_changed = src.when_changed,
                                   description = src.description,
                                   managed_by_dn = src.managed_by_dn,
                                   managed_by_sam = src.managed_by_sam,
                                   snapshot_at = src.snapshot_at,
                                   snapshot_run_id = src.snapshot_run_id,
                                   forest_id = src.forest_id,
                                   domain_id = src.domain_id
                                 WHEN NOT MATCHED THEN
                                   INSERT (domain_name, sam_account_name, cn, name, distinguished_name, ou_dn,
                                           enabled, is_server,
                                           operating_system, operating_system_version, dns_host_name,
                                           last_logon, when_created, when_changed,
                                           description, managed_by_dn, managed_by_sam,
                                           snapshot_at, snapshot_run_id, forest_id, domain_id)
                                   VALUES (src.domain_name, src.sam_account_name, src.cn, src.name, src.distinguished_name, src.ou_dn,
                                           src.enabled, src.is_server,
                                           src.operating_system, src.operating_system_version, src.dns_host_name,
                                           src.last_logon, src.when_created, src.when_changed,
                                           src.description, src.managed_by_dn, src.managed_by_sam,
                                           src.snapshot_at, src.snapshot_run_id, src.forest_id, src.domain_id);`
    },
    // R158.37 — AD Forest Registry 物理表 CRUD (4 张表)
    forestRegistry,
    // R158.61 — see mysql block above for param shape notes.
    reportSchedule,
    reportRun,
    reportSubscription,
    // R158.87 (2026-10-12) — system-settings 域: ad_feature_flags + ad_system_registration.
    featureFlags: featureFlags.mssql,
    systemRegistration: systemRegistration.mssql,
    // R158.88.B (2026-10-13) — rollout 编排 (7 helper). 0 改 fleet 端.
    rollout: rollout.mssql
  }
};

export function buildSql(dialect) {
  const variants = VARIANTS[dialect];
  if (!variants) throw new Error(`unknown dialect: ${dialect}`);
  // R158.X.115-fix (2026-10-23) — ad_dcs 的退役保护必须在这里打, 不能在
  //   运行时改已冻结的树。
  //
  //   原来的做法 (services/host-status-migrator.js) 是启动后拿 db.sql 回来
  //   再赋值 dc.upsertDc = applyDcUpsertGuard(...) —— 但 buildSql 对每个
  //   domain 都 Object.freeze 了, ESM 严格模式下这行必然抛
  //   "Cannot assign to read only property 'upsertDc'", 被 migrator 的
  //   try/catch 吞成一条 warn。也就是说 R158.X.115「退役 DC 不被 discovery
  //   复活」的保护**从来没有真正生效过**, 而线上只有一条 warn 日志, 0 告警。
  //
  //   改成构造期打补丁: 纯函数 applyDcUpsertGuard 在 freeze 之前作用于
  //   VARIANTS 的原始副本, 保护进入 SQL 树本身, 不依赖调用顺序, 也不再
  //   需要启动期的运行时改写。buildSql 的 freeze 契约保持不变。
  const out = {};
  for (const [domain, queries] of Object.entries(variants)) {
    const copy = { ...queries };
    if (domain === 'discovery' && typeof copy.upsertDc === 'string') {
      copy.upsertDc = applyDcUpsertGuard(copy.upsertDc, dialect);
    }
    out[domain] = Object.freeze(copy);
  }
  return Object.freeze(out);
}

export const SUPPORTED_DIALECTS = Object.keys(VARIANTS);