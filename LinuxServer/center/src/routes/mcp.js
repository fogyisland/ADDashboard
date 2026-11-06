// R158.102 (2026-10-14) — MCP (Model Context Protocol) Streamable HTTP
// server. Mounted on web app (port 8080) at /mcp. 0 改 userAuth / agentToken,
// 0 改 60+ 既有端点的 wire shape.
//
// 12 read-only tools 1:1 包装既有 service / inline router logic. 0 必新加
// SQL helper — 跟 R158.86.6 #5 "1 view 1 endpoint 1:1 verify" lesson 一致:
// MCP tool 跟既有 endpoint 共享 1:1 SQL helper 链, 0 重复造, 0 抽 generic
// helper.
//
// 12 tools (全 read-only):
//   1. get_overview          → db.sql.dashboard.overviewCounts + agentCount
//   2. get_problem_agents    → inline 1:1 抄 routes/dashboard.js:776 body
//   3. query_eventlog        → services/eventlog.js queryEvents
//   4. eventlog_trend24h     → services/eventlog.js trend24h
//   5. query_failed_logon    → services/failed-logon.js recent
//   6. heartbeat_report      → services/heartbeat-report.js listAgents
//   7. system_alerts_recent  → inline 1:1 抄 routes/system-alerts.js:69 body
//   8. member_eventlog_trend24h → services/member-eventlog.js trend24h
//   9. query_ad_users        → inline 1:1 抄 routes/admin.js ad-users 端点
//  10. query_ad_groups       → inline 1:1 抄 routes/admin.js ad-groups 端点
//  11. query_ad_ous          → inline 1:1 抄 routes/admin.js ad-ous 端点
//  12. query_ad_computers    → inline 1:1 抄 routes/admin.js ad-computers 端点
//
// #9~12 (4 个 AD 目录工具) 都过 sync 开关闸门 resolveDomainSyncState():
// 查的是"目录同步 cron 已经写进库的东西", 同步关了的域其快照是冻结的旧值 ——
// 此时返回空 + syncEnabled=false + message, 而不是把陈旧数据当现状给出去,
// 更不能让调用方误以为"该域没有用户".
//
// Auth: mcpToken middleware 早于本 router apply. Per-call audit 必写.
// 30s tool timeout. JSON-RPC 2.0 错误格式, 0 暴露 stack trace.
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { writeAudit } from '../services/audit.js';
import { _clientIp } from '../auth/mcp-token.js';
// R161.6 (2026-10-26) — flag 判定语义抽到公共函数 (与 mcp-write.js /
//   report-center.js / 前端 web/src/lib/featureFlag.js 同一份定义)。
import { readFeatureFlag } from '../utils/featureFlag.js';

// Lazy-loaded service / SQL. 用 dynamic import 避免 0 必提前确认 path —
// 服务模块 side-effect 必是 idempotent 0 启动副作用 (跟 R158.78 member-eventlog
// precedent 1:1 平行).
let _svcEventlog = null;
let _svcFailedLogon = null;
let _svcHeartbeatReport = null;
let _svcMemberEventlog = null;
async function loadServices() {
  if (!_svcEventlog) _svcEventlog = await import('../services/eventlog.js');
  if (!_svcFailedLogon) _svcFailedLogon = await import('../services/failed-logon.js');
  if (!_svcHeartbeatReport) _svcHeartbeatReport = await import('../services/heartbeat-report.js');
  if (!_svcMemberEventlog) _svcMemberEventlog = await import('../services/member-eventlog.js');
  return { _svcEventlog, _svcFailedLogon, _svcHeartbeatReport, _svcMemberEventlog };
}

const TOOL_TIMEOUT_MS = 30_000;

// JSON-RPC 2.0 error code conventions (跟 SDK ErrorCode 对齐).
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_INVALID_PARAMS = -32602;

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    t.unref?.();
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

// 1:1 包装既有 service / router logic, 返 MCP CallToolResult shape
// ({content: [{type: 'text', text}], structuredContent, isError}). 0 暴露
// stack trace — 错误返 isError=true + text only.
function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true
  };
}

// ---- 8 tool handlers ------------------------------------------------------
// Each handler is an async (args, { logger, auditExtra }) → { content, ... }.
// They DO NOT throw — they always return an MCP result. The router wraps
// with timeout + audit; tool-level errors come back as isError=true so the
// AI Agent sees a normal response, not a JSON-RPC -32603 envelope.

async function handleGetOverview(db, _args, { logger, auditExtra }) {
  const { rows: counts } = await db.query(db.sql.dashboard.overviewCounts);
  const { rows: agents } = await db.query(db.sql.dashboard.agentCount);
  const c = counts[0] || {};
  const a = agents[0] || {};
  const lastUpdateRaw = c.last_update;
  const lastUpdate = lastUpdateRaw instanceof Date
    ? lastUpdateRaw.toISOString()
    : (lastUpdateRaw ? new Date(lastUpdateRaw).toISOString() : null);
  return {
    totalLinks: Number(c.total)   || 0,
    healthy:    Number(c.healthy) || 0,
    warning:    Number(c.warning) || 0,
    error:      Number(c.errored) || 0,
    lastUpdate,
    agentCount: Number(a.agent_count) || 0
  };
}

async function handleGetProblemAgents(db, _args, { logger }) {
  // 1:1 抄 routes/dashboard.js:776-878 body (R158.86.6 #5 第 16 次 1:1 verify:
  // MCP tool ↔ 既 dashboardRouter 共享 hub DC set + threshold logic 0 改).
  const hubList = await db.query(`SELECT site_id, site_name FROM ad_sites WHERE is_hub = 1`);
  const hubRows = Array.isArray(hubList) ? hubList : (hubList.rows || []);
  const hubIds = hubRows.map(r => r.site_id).filter(v => v != null);
  if (hubIds.length === 0) return { ts: new Date().toISOString(), items: [] };
  const placeholders = hubIds.map(() => '?').join(',');
  const dcResult = await db.query(`SELECT dc_name, site_id FROM ad_dcs WHERE site_id IN (${placeholders})`, hubIds);
  const dcRows = Array.isArray(dcResult) ? dcResult : (dcResult.rows || []);
  const dcSiteMap = new Map(dcRows.map(r => [r.dc_name, r.site_id]));
  const dcNames = Array.from(dcSiteMap.keys());
  if (dcNames.length === 0) return { ts: new Date().toISOString(), items: [] };

  const dcPlaceholders = dcNames.map(() => '?').join(',');
  // 2026-10-20 perf (R158 verification) — the MSSQL branch carried the same
  // CROSS APPLY (SELECT TOP 1 ...) idiom, with the `agent_id IN (...)` filter
  // placed AFTER the APPLY so it couldn't be pushed down. On
  // pkg_ad_os_baseline.metrics (HEAP, no secondary index, ~870k rows) that
  // cost ~15s per call. Rewritten to aggregate-then-join so the IN-list
  // prunes during the single sequential pass. Mirrors the MySQL sibling's
  // shape and the fix applied to routes/dashboard.js:problem-agents.
  const latestSql = db.dialect === 'mssql'
    ? `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct, m.disk_free, m.disk_total, m.c_used_pct
       FROM pkg_ad_os_baseline.metrics m
       INNER JOIN (SELECT agent_id, MAX(ts) AS ts
                     FROM pkg_ad_os_baseline.metrics
                    WHERE agent_id IN (${dcPlaceholders})
                    GROUP BY agent_id) latest
              ON m.agent_id = latest.agent_id AND m.ts = latest.ts`
    : `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct, m.disk_free, m.disk_total, m.c_used_pct
       FROM pkg_ad_os_baseline.metrics m
       WHERE (m.agent_id, m.ts) IN (SELECT agent_id, MAX(ts) FROM pkg_ad_os_baseline.metrics GROUP BY agent_id)
         AND m.agent_id IN (${dcPlaceholders})`;
  const latest = await db.query(latestSql, dcNames);
  const latestRows = Array.isArray(latest) ? latest : (latest.rows || []);

  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();
  const items = [];
  for (const r of latestRows) {
    const tsMs = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
    if (!Number.isFinite(tsMs) || (now - tsMs) > TWO_HOURS) continue;
    const cpu = Number(r.cpu_pct);
    const mem = Number(r.memory_pct);
    const c = Number(r.c_used_pct);
    let worstDisk = null;
    try {
      const freeMap  = typeof r.disk_free  === 'string' ? JSON.parse(r.disk_free)  : (r.disk_free  || {});
      const totalMap = typeof r.disk_total === 'string' ? JSON.parse(r.disk_total) : (r.disk_total || {});
      let worst = 0;
      for (const drive of Object.keys(totalMap || {})) {
        const tot = Number(totalMap[drive]);
        const fre = Number(freeMap?.[drive]);
        if (Number.isFinite(tot) && tot > 0 && Number.isFinite(fre) && fre >= 0) {
          const used = 100 * (1 - fre / tot);
          if (used > worst) worst = used;
        }
      }
      worstDisk = worst;
    } catch {}
    const cpuHigh = Number.isFinite(cpu) && cpu >= 95;
    const memHigh = Number.isFinite(mem) && mem >= 95;
    const diskHigh = worstDisk !== null && worstDisk >= 80;
    const cpuMid = Number.isFinite(cpu) && cpu >= 80 && cpu < 95;
    const memMid = Number.isFinite(mem) && mem >= 80 && mem < 95;
    const diskMid = worstDisk !== null && worstDisk >= 50 && worstDisk < 80;
    const isCritical = cpuHigh || memHigh || diskHigh;
    const isWarning  = cpuMid  || memMid  || diskMid;
    if (!isCritical && !isWarning) continue;
    const drivers = [];
    if (cpuHigh || cpuMid)  drivers.push('cpu');
    if (memHigh || memMid)  drivers.push('mem');
    if (diskHigh || diskMid) drivers.push('disk');
    if (Number.isFinite(c) && c >= 50) drivers.push('c');
    const siteId = dcSiteMap.get(r.agent_id) || null;
    const siteName = hubRows.find(h => h.site_id === siteId)?.site_name || null;
    items.push({
      agentId: r.agent_id,
      siteId, siteName,
      status: isCritical ? 'critical' : 'warning',
      cpuPct: Number.isFinite(cpu) ? Math.round(cpu * 10) / 10 : null,
      memPct: Number.isFinite(mem) ? Math.round(mem * 10) / 10 : null,
      cUsedPct: Number.isFinite(c) ? Math.round(c * 10) / 10 : null,
      diskUsedPct: worstDisk !== null ? Math.round(worstDisk * 10) / 10 : null,
      drivers,
      ts: new Date(tsMs).toISOString()
    });
  }
  const severityRank = (item) => {
    const m = Math.max(
      item.cpuPct || 0,
      item.memPct || 0,
      item.diskUsedPct || 0,
      item.cUsedPct || 0
    );
    return item.status === 'critical' ? 10_000 + m : m;
  };
  items.sort((a, b) => severityRank(b) - severityRank(a));
  return { ts: new Date().toISOString(), items };
}

async function handleQueryEventlog(db, args, { logger, _svcEventlog }) {
  // 1:1 wrap services/eventlog.js queryEvents. 0 改 service 内部.
  return _svcEventlog.queryEvents(db, {
    dcName: args.dcName,
    channel: args.channel,
    severity: args.severity ?? null,
    sinceHours: args.sinceHours ?? 2,
    limit: args.limit ?? 200,
    auditOnly: args.auditOnly ?? false
  });
}

async function handleEventlogTrend24h(db, args, { logger, _svcEventlog }) {
  // 1:1 wrap services/eventlog.js trend24h. router 硬编 TREND_HOURS=24.
  return _svcEventlog.trend24h(db, { hours: 24 }, logger);
}

async function handleQueryFailedLogon(db, args, { logger, _svcFailedLogon }) {
  // 1:1 wrap services/failed-logon.js recent.
  return _svcFailedLogon.recent(db, {
    sinceHours: args.sinceHours ?? 24,
    limit: args.limit ?? 100
  }, logger);
}

async function handleHeartbeatReport(db, _args, { logger, _svcHeartbeatReport }) {
  // 1:1 wrap services/heartbeat-report.js heartbeatReportService.listAgents.
  return _svcHeartbeatReport.heartbeatReportService.listAgents(db);
}

async function handleSystemAlertsRecent(db, args, { logger }) {
  // 1:1 抄 routes/system-alerts.js:69-82 body. 0 改 router.
  const kind = (typeof args.kind === 'string' && args.kind.trim()) ? args.kind.trim() : null;
  const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
  const fn = db.sql.systemAlerts.listRecent;
  const sqlText = typeof fn === 'function' ? fn({ kind, limit }) : fn;
  const params = typeof fn === 'function' ? [] : (kind ? [kind] : []);
  const { rows } = await db.query(sqlText, params);
  return { items: rows, count: rows.length };
}

async function handleMemberEventlogTrend24h(db, args, { logger, _svcMemberEventlog }) {
  // 1:1 wrap services/member-eventlog.js trend24h. R158.101 平行.
  return _svcMemberEventlog.memberEventlogService.trend24h(db, { hours: 24 }, logger);
}

// ---- AD 目录对象查询 (tool 9~12) ---------------------------------------------
// 1:1 抄 routes/admin.js 的 4 个 ad-* 快照端点 (users/groups/ous/computers),
// 0 改 admin.js, 0 新建 service. SQL / 参数顺序 / 分页方言分叉全部对齐 admin.js.
//
// 关键差异 (有意为之, 已在 tool description 里告知调用方):
//   1. limit 上限 500 (不是 admin.js 的 50000) —— withTimeout 是 **per-HTTP
//      request** 30s (mcp.js:518), 不是 per-tool. 大域拉全量会撞超时.
//   2. 每次必返 snapshotAt + snapshotRunId —— 快照是 30min cadence 的定时同步
//      结果, 不带新鲜度的话调用方会把陈旧数据当现状 (R158.85 同款静默 stale 坑).
//   3. domain 必填 —— 不替调用方猜域.
//   4. 域未启用同步 (ad_forest_domain.sync_enabled=0) → 直接返回结构化提示,
//      不查快照表. cron tick 本来就跳过 disabled 域 (forest-registry.js:112),
//      其快照是冻结的旧值; 返空 + snapshotAt=null 会让调用方误以为"该域没有用户".
//      区分 3 种态: 未注册该域 / 注册了但同步关闭 / 同步正常但表确实为空.

// 同步开关判定. 返回 { known, enabled }:
//   known=false → 该 domain 不在 ad_forest_domain 里 (从未配置过同步)
//   enabled=0   → 配置了但 cron 不再同步它 (快照冻结)
// 查询不可用时 (表缺失等) 走 known=true, enabled=true —— 不因为开关判定失败
// 就把可用数据挡掉.
async function resolveDomainSyncState(db, domainName) {
  try {
    // R161.20 — 方言分叉。`SELECT TOP 1` 是 T-SQL 语法, MySQL 直接报 1064;
    //   而下面那个 catch 把错误吞成 {known:true, enabled:true} ⇒ 在 MySQL 上
    //   "该域已关闭同步" 这条分支**永远走不到**(调用方拿到的是"同步正常"的
    //   假象)。与 routes/admin.js 手动触发路径、directory-sync-loop.js 的
    //   _pickDcForDomain 同模式 (isMssql ? TOP 1 : LIMIT 1)。
    const sql = db.dialect === 'mssql'
      ? `SELECT TOP 1 sync_enabled FROM ad_forest_domain WHERE LOWER(domain_name) = LOWER(?)`
      : `SELECT sync_enabled FROM ad_forest_domain WHERE LOWER(domain_name) = LOWER(?) LIMIT 1`;
    const { rows } = await db.query(sql, [domainName]);
    if (!rows || rows.length === 0) return { known: false, enabled: false };
    return { known: true, enabled: rows[0].sync_enabled == null ? true : Boolean(Number(rows[0].sync_enabled)) };
  } catch (e) {
    return { known: true, enabled: true };
  }
}

// BIT 列归一: MSSQL 驱动对 BIT 可能返 true/false 也可能返 0/1, 统一成 bool|null.
function bitOrNull(v) {
  if (v === null || v === undefined) return null;
  return Boolean(Number(v));
}

// admin.js:3914 的 OU 子树匹配, 1:1 照抄 (含 ESCAPE 转义). baseDN 两侧逗号做
// 边界, 防兄弟 OU (`OU=NBxxx`) 误撞 `OU=NB`.
function ouDnSubtree(ouDn) {
  return ouDn ? `%,${ouDn.replace(/[\\%_]/g, ch => '\\' + ch)},%` : null;
}

// 三段式共享: list + total + snapshotAt (admin.js 既有 Promise.all 结构).
// filterCols 为空 = 不加 filter 条件 (调用方据此跳过), 非空 = 每列一个 ? 占位.
// 注意 mssql 分页参数顺序是 [offset, limit], mysql 是 [limit, offset] —— 别写反
// (sql.js:4873 同款 swap 坑).
async function querySnapshotTable(db, { table, orderBy, domainName, filter, filterCols, ouDn, limit, offset, mapRow, entity }) {
  // 同步开关前置: 未启用的域不查快照 (其数据是冻结的 cron 停止前的旧值).
  const sync = await resolveDomainSyncState(db, domainName);
  if (!sync.enabled) {
    return {
      items: [],
      count: 0,
      total: 0,
      snapshotAt: null,
      snapshotRunId: null,
      syncEnabled: false,
      domainKnown: sync.known,
      message: sync.known
        ? `AD directory sync is NOT enabled for domain "${domainName}". No data has been collected — enable sync for this domain in AD forest settings before querying ${entity}.`
        : `Domain "${domainName}" is not registered in the AD forest registry, so no directory snapshot exists for it. Query a registered domain (e.g. "sphkdl.shaphar.net") or add this domain first.`
    };
  }
  const isMssql = db.dialect === 'mssql';
  const filterPct = `%${filter || ''}%`;
  const filterClause = filterCols.length
    ? ` AND (${filterCols.map(c => `${c} LIKE ?`).join(' OR ')})`
    : '';
  const whereOu = ouDn ? ` AND (ou_dn = ? OR (',' + ou_dn + ',') LIKE ? ESCAPE '\\')` : '';
  const substr = ouDn ? ouDnSubtree(ouDn) : null;

  const listSql = isMssql
    ? `SELECT * FROM ${table}
        WHERE domain_name = ?${filterClause}${whereOu}
        ORDER BY ${orderBy}
        OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
    : `SELECT * FROM ${table}
        WHERE domain_name = ?${filterClause}${whereOu}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`;

  const baseParams = [domainName, ...filterCols.map(() => filterPct)];
  const listParams = isMssql
    ? [...baseParams, ...(ouDn ? [ouDn, substr] : []), offset, limit]
    : [...baseParams, ...(ouDn ? [ouDn, substr] : []), limit, offset];
  const totalSql = `SELECT COUNT(*) AS total FROM ${table} WHERE domain_name = ?${whereOu}`;
  const totalParams = ouDn ? [domainName, ouDn, substr] : [domainName];

  const [{ rows: list }, { rows: totalRows }, { rows: snapRows }] = await Promise.all([
    db.query(listSql, listParams),
    db.query(totalSql, totalParams),
    db.query(`SELECT MAX(snapshot_at) AS snapshot_at, MAX(snapshot_run_id) AS snapshot_run_id
                FROM ${table} WHERE domain_name = ?`, [domainName])
  ]);

  const snap = snapRows[0] || {};
  return {
    items: (list || []).map(mapRow),
    count: (list || []).length,
    total: Number(totalRows[0]?.total ?? 0),
    syncEnabled: true,
    // snapshotAt/snapshotRunId = 数据新鲜度. null = 该域从未成功同步过 (或表空),
    // 调用方据此判断 "空结果" 是真没有 还是 快照还没来.
    snapshotAt: snap.snapshot_at || null,
    snapshotRunId: snap.snapshot_run_id == null ? null : Number(snap.snapshot_run_id)
  };
}

async function handleQueryAdUsers(db, args) {
  const domainName = String(args.domain || '').trim();
  const filter = String(args.filter || '').trim();
  const ouDn = String(args.ouDn || '').trim();
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
  const offset = Math.max(0, Number(args.offset) || 0);
  const enabledOnly = args.enabledOnly === true;

  const res = await querySnapshotTable(db, {
    table: 'ad_users_snapshot',
    orderBy: 'sam',
    domainName,
    filter,
    entity: 'users',
    filterCols: filter ? ['sam', 'display_name'] : [],
    ouDn, limit, offset,
    mapRow: r => ({
      sam: r.sam,
      displayName: r.display_name,
      distinguishedName: r.distinguished_name,
      ouDn: r.ou_dn,
      enabled: bitOrNull(r.enabled),
      lockedOut: bitOrNull(r.locked_out),
      lastLogon: r.last_logon,
      whenCreated: r.when_created,
      passwordLastSet: r.password_last_set,
      description: r.description,
      managerSam: r.manager_sam
    })
  });
  if (enabledOnly) {
    res.items = res.items.filter(u => u.enabled === true);
    res.count = res.items.length;
  }
  return res;
}

async function handleQueryAdGroups(db, args) {
  const domainName = String(args.domain || '').trim();
  const filter = String(args.filter || '').trim();
  const ouDn = String(args.ouDn || '').trim();
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
  const offset = Math.max(0, Number(args.offset) || 0);

  return querySnapshotTable(db, {
    table: 'ad_groups_snapshot',
    orderBy: 'name',
    domainName,
    filter,
    entity: 'groups',
    filterCols: filter ? ['name', 'sam_account_name'] : [],
    ouDn, limit, offset,
    mapRow: r => ({
      name: r.name,
      samAccountName: r.sam_account_name,
      distinguishedName: r.distinguished_name,
      ouDn: r.ou_dn,
      groupType: r.group_type == null ? null : Number(r.group_type),
      groupScope: r.group_scope,
      description: r.description,
      memberCount: r.member_count == null ? null : Number(r.member_count)
    })
  });
}

async function handleQueryAdOus(db, args) {
  const domainName = String(args.domain || '').trim();
  // 同步开关前置 —— 跟 querySnapshotTable 同款 (OU 不分页, 故不走那个 helper).
  const sync = await resolveDomainSyncState(db, domainName);
  if (!sync.enabled) {
    return {
      items: [], count: 0, total: 0, snapshotAt: null, snapshotRunId: null,
      syncEnabled: false, domainKnown: sync.known,
      message: sync.known
        ? `AD directory sync is NOT enabled for domain "${domainName}". No data has been collected — enable sync for this domain in AD forest settings before querying OUs.`
        : `Domain "${domainName}" is not registered in the AD forest registry, so no directory snapshot exists for it. Query a registered domain (e.g. "sphkdl.shaphar.net") or add this domain first.`
    };
  }
  // OU 只有 55 行 (生产实测), 不分页 —— 跟 admin.js ad-ous 端点 1:1.
  const [{ rows: list }, { rows: snapRows }] = await Promise.all([
    db.query(`SELECT * FROM ad_ous_snapshot WHERE domain_name = ? ORDER BY distinguished_name`, [domainName]),
    db.query(`SELECT MAX(snapshot_at) AS snapshot_at, MAX(snapshot_run_id) AS snapshot_run_id
                FROM ad_ous_snapshot WHERE domain_name = ?`, [domainName])
  ]);
  const snap = snapRows[0] || {};
  const items = (list || []).map(r => ({
    distinguishedName: r.distinguished_name,
    name: r.name,
    description: r.description,
    whenCreated: r.when_created,
    whenChanged: r.when_changed,
    // parentDn = 上级 OU 的完整 DN. 只有这一个层级字段, 没有 path/depth.
    // 子树关系由调用方按 parentDn 逐级拼 (或传 ouDn 给上面 3 个工具做子树过滤).
    parentDn: r.parent_dn
  }));
  return {
    items,
    count: items.length,
    total: items.length,
    syncEnabled: true,
    snapshotAt: snap.snapshot_at || null,
    snapshotRunId: snap.snapshot_run_id == null ? null : Number(snap.snapshot_run_id)
  };
}

async function handleQueryAdComputers(db, args) {
  const domainName = String(args.domain || '').trim();
  const filter = String(args.filter || '').trim();
  const ouDn = String(args.ouDn || '').trim();
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
  const offset = Math.max(0, Number(args.offset) || 0);

  return querySnapshotTable(db, {
    table: 'ad_computers_snapshot',
    orderBy: 'sam_account_name',
    domainName,
    filter,
    entity: 'computers',
    filterCols: filter ? ['sam_account_name', 'cn', 'name'] : [],
    ouDn, limit, offset,
    mapRow: r => ({
      samAccountName: r.sam_account_name,
      cn: r.cn,
      name: r.name,
      distinguishedName: r.distinguished_name,
      ouDn: r.ou_dn,
      enabled: bitOrNull(r.enabled),
      isServer: bitOrNull(r.is_server),
      operatingSystem: r.operating_system,
      dnsHostName: r.dns_host_name,
      lastLogon: r.last_logon,
      description: r.description
    })
  });
}

// ---- Tool registration ----------------------------------------------------
function buildServer({ db, logger }) {
  const server = new McpServer(
    { name: 'dashboard-center', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // 1
  server.tool(
    'get_overview',
    'Get the dashboard overview: total replication links, healthy/warning/error counts, last update timestamp, and total agent count.',
    {},
    async () => {
      const payload = await handleGetOverview(db, {}, { logger });
      return textResult(payload);
    }
  );

  // 2
  server.tool(
    'get_problem_agents',
    'List hub-site agents with warning or critical status (cpu/mem/disk thresholds: 95% critical / 80% warning, disk 80%/50%, c 50%). Sorted critical first by max driver severity.',
    {},
    async () => {
      const payload = await handleGetProblemAgents(db, {}, { logger });
      return textResult(payload);
    }
  );

  // 3
  server.tool(
    'query_eventlog',
    'Query Windows event log entries for a DC, filterable by channel and severity. Returns raw rows: collectedAt, dcName, channel, severity, eventId, recordId, message, ts, auditFailure.',
    {
      dcName: z.string().describe('DC name (ad_dcs.dc_name), e.g. "KDLCDWHADSRV1"'),
      channel: z.string().describe('Windows event log channel: System / Application / Security / Setup / ForwardedEvents'),
      severity: z.enum(['Critical', 'Error', 'Warning', 'Information']).optional()
        .describe('Filter by severity level (optional)'),
      sinceHours: z.number().int().min(1).max(168).optional()
        .describe('Lookback window in hours (1-168, default 2)'),
      limit: z.number().int().min(1).max(500).optional()
        .describe('Max rows to return (1-500, default 200)'),
      auditOnly: z.boolean().optional()
        .describe('If true, only return audit failures (default false)')
    },
    async (args) => {
      const { _svcEventlog } = await loadServices();
      const rows = await handleQueryEventlog(db, args, { logger, _svcEventlog });
      return textResult({ items: rows, count: rows.length });
    }
  );

  // 4
  server.tool(
    'eventlog_trend24h',
    '24-hour event count trend across all Windows event log channels (System / Application / Security / Setup / ForwardedEvents). Returns [{channel, bucketStart, eventCount}].',
    {},
    async () => {
      const { _svcEventlog } = await loadServices();
      const items = await handleEventlogTrend24h(db, {}, { logger, _svcEventlog });
      return textResult({ items, count: items.length });
    }
  );

  // 5
  server.tool(
    'query_failed_logon',
    'Recent failed logon events across all DCs. Returns snake_case rows shaped to {occurredAt, dcName, targetUserName, targetUserDisplayName, targetDomainName, subjectUserName, subjectDomainName, callerComputerName, ipAddress, ipPort, logonType, logonProcessName, authPackageName, failureReason, status, workstationName}.',
    {
      sinceHours: z.number().int().min(1).max(168).optional()
        .describe('Lookback window in hours (1-168, default 24)'),
      limit: z.number().int().min(1).max(500).optional()
        .describe('Max rows to return (1-500, default 100)')
    },
    async (args) => {
      const { _svcFailedLogon } = await loadServices();
      const rows = await handleQueryFailedLogon(db, args, { logger, _svcFailedLogon });
      return textResult({ items: rows, count: rows.length });
    }
  );

  // 6
  server.tool(
    'heartbeat_report',
    'Per-agent heartbeat + report status: agentId, agentVersion, lastHeartbeatAt, lastReportAt, lastReportStatus, pendingQueueSize, heartbeatIntervalSeconds, reportSummary. Plus heartbeatStaleSeconds / heartbeatDefaultIntervalSeconds fleet config.',
    {},
    async () => {
      const { _svcHeartbeatReport } = await loadServices();
      const payload = await handleHeartbeatReport(db, {}, { logger, _svcHeartbeatReport });
      return textResult(payload);
    }
  );

  // 7
  server.tool(
    'system_alerts_recent',
    'Recent system alerts (firing + recovered + acked). Returns {items: rows, count}. Filterable by kind (e.g. heartbeat_offline / replication_failure / port_latency / disk_free / failed_logon_24h).',
    {
      kind: z.string().optional().describe('Filter by alert kind (optional)'),
      limit: z.number().int().min(1).max(500).optional()
        .describe('Max rows to return (1-500, default 100)')
    },
    async (args) => {
      const payload = await handleSystemAlertsRecent(db, args, { logger });
      return textResult(payload);
    }
  );

  // 8
  server.tool(
    'member_eventlog_trend24h',
    '24-hour event count trend for the non-AD member-server fleet (3 channels). R158.101 parallel to eventlog_trend24h.',
    {},
    async () => {
      const { _svcMemberEventlog } = await loadServices();
      const items = await handleMemberEventlogTrend24h(db, {}, { logger, _svcMemberEventlog });
      return textResult({ items, count: items.length });
    }
  );

  // 9
  server.tool(
    'query_ad_users',
    'Search AD users in a domain directory snapshot. Filter matches BOTH sAMAccountName AND displayName, so a human name like "张三" also matches Chinese display names. Returns {items, count, total, snapshotAt, snapshotRunId} where each item is {sam, displayName, distinguishedName, ouDn, enabled, lockedOut, lastLogon, whenCreated, passwordLastSet, description, managerSam}. IMPORTANT: snapshotAt is when the directory was last synced (cron, ~30min cadence) — if it is old or null, the data may be stale. If several accounts share a display name, present the candidates and ask the user which one before acting. limit caps at 500. GATED ON SYNC: this tool reads only what the AD directory sync cron has already written; if sync is disabled for the domain it returns {items: [], count: 0, total: 0, snapshotAt: null, syncEnabled: false, message} instead of data — do not tell the user the domain has no users in that case, report that sync is off for it.',
    {
      domain: z.string().describe('AD domain FQDN, e.g. "sphkdl.shaphar.net". NOT a DC hostname.'),
      filter: z.string().optional().describe('Match against sAMAccountName OR displayName (e.g. "zhangsan" or "张三")'),
      ouDn: z.string().optional().describe('Only users in this OU or its subtree (ADUC SUBTREE scope)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (1-500, default 200)'),
      offset: z.number().int().min(0).optional().describe('Row offset for paging (default 0)'),
      enabledOnly: z.boolean().optional().describe('If true, return only enabled accounts (default false)')
    },
    async (args) => textResult(await handleQueryAdUsers(db, args))
  );

  // 10
  server.tool(
    'query_ad_groups',
    'Search AD groups in a domain directory snapshot. Filter matches BOTH group name AND sAMAccountName. Returns {items, count, total, snapshotAt, snapshotRunId} where each item is {name, samAccountName, distinguishedName, ouDn, groupType, groupScope, description, memberCount}. snapshotAt is the last directory sync time (cron, ~30min cadence) — may be stale. memberCount comes from AD group member enumeration; note very large groups (e.g. Domain Users) may be absent from the separate user-group-membership table, so memberCount and actual membership rows can differ. limit caps at 500. GATED ON SYNC: this tool reads only what the AD directory sync cron has already written; if sync is disabled for the domain it returns {items: [], count: 0, total: 0, snapshotAt: null, syncEnabled: false, message} instead of data — do not tell the user the domain has no groups in that case, report that sync is off for it.',
    {
      domain: z.string().describe('AD domain FQDN, e.g. "sphkdl.shaphar.net". NOT a DC hostname.'),
      filter: z.string().optional().describe('Match against group name OR sAMAccountName'),
      ouDn: z.string().optional().describe('Only groups in this OU or its subtree'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (1-500, default 200)'),
      offset: z.number().int().min(0).optional().describe('Row offset for paging (default 0)')
    },
    async (args) => textResult(await handleQueryAdGroups(db, args))
  );

  // 11
  server.tool(
    'query_ad_ous',
    'List all organizational units (OU) in a domain directory snapshot. Returns {items, count, total, snapshotAt, snapshotRunId} where each item is {distinguishedName, name, description, whenCreated, whenChanged, parentDn}. parentDn is the parent OU full DN and is the ONLY hierarchy field stored — there is no path/depth column, so reconstruct the tree by walking parentDn, or pass a distinguishedName as ouDn to query_ad_users / query_ad_groups / query_ad_computers for subtree scoping. snapshotAt is the last directory sync time (cron, ~30min cadence). Not paginated (a domain has far fewer OUs than users). GATED ON SYNC: this tool reads only what the AD directory sync cron has already written; if sync is disabled for the domain it returns {items: [], count: 0, total: 0, snapshotAt: null, syncEnabled: false, message} instead of data — do not tell the user the domain has no OUs in that case, report that sync is off for it.',
    {
      domain: z.string().describe('AD domain FQDN, e.g. "sphkdl.shaphar.net". NOT a DC hostname.')
    },
    async (args) => textResult(await handleQueryAdOus(db, args))
  );

  // 12
  server.tool(
    'query_ad_computers',
    'Search AD computer accounts in a domain directory snapshot. Filter matches sAMAccountName (with trailing $), cn, OR name. Returns {items, count, total, snapshotAt, snapshotRunId} where each item is {samAccountName, cn, name, distinguishedName, ouDn, enabled, isServer, operatingSystem, dnsHostName, lastLogon, description}. snapshotAt is the last directory sync time (cron, ~30min cadence) — may be stale. limit caps at 500. GATED ON SYNC: this tool reads only what the AD directory sync cron has already written; if sync is disabled for the domain it returns {items: [], count: 0, total: 0, snapshotAt: null, syncEnabled: false, message} instead of data — do not tell the user the domain has no computers in that case, report that sync is off for it.',
    {
      domain: z.string().describe('AD domain FQDN, e.g. "sphkdl.shaphar.net". NOT a DC hostname.'),
      filter: z.string().optional().describe('Match against sAMAccountName, cn, or name'),
      ouDn: z.string().optional().describe('Only computers in this OU or its subtree'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (1-500, default 200)'),
      offset: z.number().int().min(0).optional().describe('Row offset for paging (default 0)')
    },
    async (args) => textResult(await handleQueryAdComputers(db, args))
  );

  return server;
}

// ---- HTTP router ----------------------------------------------------------
// R158.103 (2026-10-14) — 内部路径相对化:
//   server.js 现在 `app.use('/mcp', mcpRouter(...))` 装载, 内部 r.get/post
//   必须用相对 mount 的路径 ('/healthz' / '') 而不是 '/mcp/healthz' / '/mcp'.
//   之前 line 372 / 445-447 写绝对 '/mcp/healthz' '/mcp' 是 R158.102 ship 时
//   未跟 server.js 协调 — server.js 是 `app.use(mcpRouter)` no mount (跟
//   `app.use(/mcp/` mount 不一致). 现在切到 mount, router 内部同步相对化.
//   1:1 跟 agentRouter / dashboardRouter 等其它 router 平等.
//
// R158.110 (2026-10-16) — getOrCreateSession 用 SDK 1.x 的 onsessioninitialized
//   钩子登记 session. R158.102 ship 时错误地用 `transport.sessionId` 作 Map key,
//   但 SDK 1.x 的 sessionId 是 lazy 赋值 (webStandardStreamableHttp.js:545
//   只在首次 initialize 时调 sessionIdGenerator)。server.connect(transport)
//   后 transport.sessionId 还是 undefined → sessions.set(undefined, ...) →
//   客户端带 mcp-session-id header 回来永远 has()=false → 每次请求都新建
//   transport → SDK 返 'Server not initialized' / 'Server already initialized'
//   混合错 (状态机错乱, 操作员 directive 2026-10-16 "Server not initialized" +
//   'Only one initialization request is allowed' 同时出现铁证). 修法:
//   1) 用 onsessioninitialized 钩子在 server 真拿到 sid 时才入 Map, 永真 key;
//   2) 加并发锁防止同 sid 同 SID 的两个并发 initialize 创建双份 transport;
//   3) close 失败不再 .catch(()=>{}) 吞, 走 logger.error 便于追查.
export function mcpRouter({ logger, db }) {
  const r = Router();

  // R158.X.116.k (2026-10-23) — feature flag `mcp.enabled` 后端闸门。
  //   关闭时 POST/GET/DELETE /mcp 一律 503, 已持有的 mcp_ token 彻底失效。
  //   1:1 平行 mcp-write.js 的同名闸门 (本轮同批加的 mcp_write.enabled)。
  //   fail-open (查询失败 → 放行) + /healthz 不拦的理由同 mcp-write.js,
  //   不复述; 要改请两处一起改, 免得两个端点的开关语义漂移。
  async function isMcpEnabled() {
    // R161.6 — 判定逻辑搬进 src/utils/featureFlag.js, 语义与原实现**逐字相同**
    //   (缺行=不拦 / 读库失败=fail-open / '1'|1|true=放行 / 其它值=拦), 行为零变化。
    return readFeatureFlag(db, 'mcp.enabled', logger, 'mcp');
  }

  // 永远 no-auth 健康检查. 跟 /healthz 1:1 平行 (R112 / R113 precedent).
  r.get('/healthz', async (_req, res) => {
    const enabled = await isMcpEnabled();
    res.json({
      ok: enabled,
      enabled,
      server: 'dashboard-center-mcp',
      version: '1.0.0',
      tool_count: 12,
      protocol: 'streamable-http',
      ...(enabled ? {} : { reason: 'disabled_by_feature_flag:mcp.enabled' })
    });
  });

  async function gate(req, res, next) {
    const enabled = await isMcpEnabled();
    if (enabled) return next();
    logger?.warn?.({ method: req.method, path: req.path },
      'mcp request blocked: feature flag mcp.enabled is off');
    res.status(503).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'MCP server is disabled by feature flag (mcp.enabled)' }
    });
  }

  // Streamable HTTP single endpoint. mcpToken middleware 在 server.js
  // 早于本 router apply, 所以 /mcp/* 必带 Authorization: Bearer mcp_<token>.
  // 7 tool / 30s / 8 audit / 1 healthz. 错误返 JSON-RPC 2.0 格式.
  // Stateful mode (randomUUID per session) — 跟 SDK 默认 1:1 平行.
  //
  // sessions Map 实际入 Map 的时机由 onsessioninitialized 钩子负责 (见下
  // getOrCreateSession). 键 = 真实生成的 sid; entry 持有 transport/server/
  // inFlight 锁. _pendingInit 是 Map<headerSid (if any), Promise> 用于合并
  // 同 sessionId 并发请求 (race-free).
  const sessions = new Map();       // sid -> { transport, server, inFlight }
  const _pendingInit = new Map();   // pending key -> Promise<entry>

  async function getOrCreateSession(req) {
    const headerSession = req.headers['mcp-session-id'];

    // (1) 客户端带 sid: 先在 sessions 里查, 再在 _pendingInit 里等.
    if (headerSession) {
      const existing = sessions.get(headerSession);
      if (existing) return existing;
      const pending = _pendingInit.get(headerSession);
      if (pending) return pending;
    } else {
      // (2) 客户端没带 sid: 是首次 initialize. 用 headerSession (undefined)
      //     作 pending key 把并发合并. sessions Map 不入 (因为 sid 还没生成).
      const pending = _pendingInit.get(undefined);
      if (pending) return pending;
    }

    // (3) 创建新 transport + server. 在 onsessioninitialized 钩子里真正入
    //     sessions Map. entry 是占位容器, hooks 拿到 sid 时 set 进 Map.
    const entry = { transport: null, server: null, inFlight: false };
    const initPromise = (async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          // SDK 真生成 sid 的时候才入 Map. 删 _pendingInit 里 pending key.
          sessions.set(sid, entry);
          _pendingInit.delete(headerSession || undefined);
          entry._sid = sid;
          logger?.debug?.(
            { event: 'mcp.session.initialized', sid, viaHeader: !!headerSession },
            'mcp session initialized and registered'
          );
        },
        onsessionclosed: (sid) => {
          // 客户端发 DELETE 时 SDK 调这里. 清 Map + 关 transport.
          sessions.delete(sid);
          _pendingInit.delete(sid);
          logger?.debug?.({ event: 'mcp.session.closed', sid }, 'mcp session closed via DELETE');
        }
      });
      const server = buildServer({ db, logger });
      entry.transport = transport;
      entry.server = server;
      transport.onclose = () => {
        // 兜底: 任何非 DELETE 路径关 transport (server crash / client abort).
        // 用 entry._sid 删 Map (如果已注册), 否则按 entry 引用扫一次.
        const sid = entry._sid;
        if (sid && sessions.get(sid) === entry) sessions.delete(sid);
        else {
          for (const [k, v] of sessions) {
            if (v === entry) { sessions.delete(k); break; }
          }
        }
        server.close().catch((err) => {
          logger?.error?.(
            { event: 'mcp.server.close_failed', err: err?.message },
            'mcp server close failed (transport.onclose)'
          );
        });
      };
      await server.connect(transport);
      return entry;
    })();

    _pendingInit.set(headerSession || undefined, initPromise);
    try {
      return await initPromise;
    } finally {
      // initPromise 完成后, _pendingInit 已经被 onsessioninitialized 钩子清
      // 掉了 (sid 拿到时). 但如果 transport 还没收到 initialize 就异常,
      // entry 不会被注册, 这里兜底清 _pendingInit.
      if (_pendingInit.get(headerSession || undefined) === initPromise) {
        _pendingInit.delete(headerSession || undefined);
      }
    }
  }

  async function handleMcp(req, res) {
    const session = await getOrCreateSession(req);
    // Audit per request: 0 暴露 token. 30s timeout per request (跟 tool
    // timeout 一致, 防止 SSE 客户端 hang).
    const startMs = Date.now();
    let auditAction = 'mcp.request';
    // R158.X.99.report (2026-10-21) — 补 clientIp. 日报/周报「MCP 调用统计」
    //   段按 IP 聚合调用方, 之前只有 auth-fail 路径记 IP, 成功的调用不留痕.
    //   复用 mcp-token.js 的 _clientIp 单一真源 (R158.X.99.28 从 3 份抄本
    //   收敛到 1 份), 保证报告里的 IP 跟白名单判定用的是**同一**取值口径 ——
    //   两处口径分叉会让报告显示的 IP 跟实际被鉴权的 IP 不是同一个.
    let auditMeta = {
      method: req.method,
      path: req.path,
      sessionId: session.transport.sessionId,
      clientIp: _clientIp(req)
    };
    try {
      await withTimeout(
        session.transport.handleRequest(req, res, req.body),
        TOOL_TIMEOUT_MS,
        'mcp request'
      );
      auditMeta.duration_ms = Date.now() - startMs;
      writeAudit({
        userId: null,
        action: auditAction,
        target: 'mcp',
        payload: auditMeta,
        logger
      }).catch(() => {});
    } catch (e) {
      auditMeta.duration_ms = Date.now() - startMs;
      auditMeta.error = e?.message || String(e);
      writeAudit({
        userId: null,
        action: 'mcp.request.failed',
        target: 'mcp',
        payload: auditMeta,
        logger
      }).catch(() => {});
      logger.error({ err: e?.message, method: req.method, path: req.path }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(null, JSONRPC_INTERNAL_ERROR, 'mcp request failed'));
      }
    }
  }

  // R158.X.116.k — gate 挂在 handleMcp 之前, /healthz 注册在更前面不受影响
  r.post('/', gate, handleMcp);
  r.get('/', gate, handleMcp);
  r.delete('/', gate, handleMcp);

  return r;
}
