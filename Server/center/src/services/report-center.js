// center/src/services/report-center.js
// R158.110 (2026-10-16) — 报表中心 read services.
// R158.111 (2026-10-16) — 加 filter 维度: dcName / search (锁定账户 +
//   失败登录) / actions 5 个白名单 (账户变更). 0 改 3 老 service
// (lockout / failed-logon / account-change), 0 改 4 既有 SQL helper 默认行为.
// 仅复用既有 helper 调 db.execute / db.query, 返 camelCase reshape 给前端.
//
// 跟 services/failed-logon.js:197 aggregateByWorkstation 范式 1:1 平行
// (try/catch + log + return []). Machine-account fail-safe (NOT LIKE '%$')
// 已在 SQL helper 端 baked, service 端 0 再过滤.
//
// days/sinceHours 设计: failedLogon.aggregateByWorkstation / aggregateByDc
// 既定 sinceHours cap [1, 168] (7d, 跟 R158.50.7e 1:1). 报表中心 days
// 24h/7d/all 路由层把 days×24 clamp [1, 168] 后传 sinceHours. 跟
// ad_mgmt_retention_days=30 (R158.107 默认 30d) 不冲突 — 报表中心跟 5
// 老 dashboard page 1:1 平行走 7d 上限, "全部" 路径 ≥ 7d 走 7d (硬 cap).
// lockout.topByUserWithDisplay 跟 failedLogon 同样 sinceHours 范式 1:1.
// accountChange.trendByDay 接受 days ∈ [1, 365] 直传, 走 30d 自然支持
// ad_mgmt_retention_days=30 default 1:1.

import * as lockoutSvc from './lockout.js';
import * as failedLogonSvc from './failed-logon.js';
import { getDb } from '../db/index.js';

// sinceHours 上限 — 跟 SQL helper aggregateByWorkstation / aggregateByDc
// / topByUserWithDisplay 三处 [1, 168] 1:1 平行 (7d ceiling). 报表中心
// days ≥ 7 (即 24h*7=168h) 走 168h 7d 聚合. 跟 /api/failed-logon-2h
// / /lockout-accounts dashboard page 1:1 平行.
const MAX_SINCE_HOURS = 168;
const DEFAULT_TOP_N = 5;

// action 白名单 — 跟 SQL helper adAccountChange.trendByDay (sql.js) 1:1 平行
//   R158.72 ship 时 schema 只 5 个 action ('created'|'modified'|'deleted'|
//   'enabled'|'disabled'). 'unlocked' 不在 schema, route 层 filter 掉.
const VALID_ACCT_ACTIONS = ['created','modified','deleted','enabled','disabled'];

// 1) 锁定账户报表 — top by target_user. 复用 lockout.topByUserWithDisplay
//   既有 SQL helper (R158.64 reports.js fetchLockoutSection 范式 1:1). 返
// [{ sam, displayName, lockoutCount, lastLockoutAt, dcCount, dcNameList }]
// 跟 reports.js wire shape 1:1.
// R158.111 — 加 dcName + search (前缀 LIKE 'q%') 2 个可选 filter.
export async function lockoutTop(db, { days = 7, topN = DEFAULT_TOP_N, dcName = null, search = null } = {}, log = null) {
  try {
    // days → sinceHours clamp [1, 168]. days=0/-1/超 168 → 168 (跟 SQL
    // helper 既定 cap 1:1, 走 7d 顶). 7d (days=7) 跟 retention_days=30
    // 默认不冲突 — 报表中心聚合 by user 走 7d ceiling.
    const sinceHours = clampSinceHours(days);
    // 直接调 SQL helper (lockoutSvc.topByUserWithDisplay 不存在 —
    //   reports.js:126 caller 直接调 SQL helper, 跟 0 改 caller 范式 1:1).
    const built = db.sql.lockout.topByUserWithDisplay({ sinceHours, topN, dcName, search });
    const { rows } = await db.execute(built.sql, built.params);
    // 1:1 reshape 跟 reports.js 1:1 平行.
    return (rows || []).map((r) => ({
      sam:              r.sam,
      displayName:      r.display_name ?? null,
      lockoutCount:     Number(r.lockout_count),
      lastLockoutAt:    r.last_lockout_at,
      dcCount:          Number(r.dc_count ?? 0),
      dcNameList:       r.dc_name_list ?? null
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.lockout_top_failed',
      days, topN, dcName, search, err: e?.message || String(e)
    }, 'report-center lockoutTop read failed');
    return [];
  }
}

// 2) 失败登录报表 — by=workstation|dc 二 path 复用既有 service. 返
//   [{ workstationName|dcName, eventCount }] topN DESC.
// R158.111 — 加 dcName 可选 filter (by=workstation 时限定某 DC;
//   by=dc 时进一步退化到 1 DC).
export async function failedLogonTop(db, { days = 7, topN = DEFAULT_TOP_N, by = 'workstation', dcName = null } = {}, log = null) {
  try {
    const sinceHours = clampSinceHours(days);
    const byNorm = String(by ?? 'workstation').toLowerCase();
    if (byNorm === 'dc') {
      const rows = await failedLogonSvc.aggregateByDc(db, { sinceHours, topN, dcName }, log);
      return (rows || []).map((r) => ({
        dcName:     r.dcName,
        eventCount: Number(r.eventCount)
      }));
    }
    // default: workstation
    const rows = await failedLogonSvc.aggregateByWorkstation(db, { sinceHours, topN, dcName }, log);
    return (rows || []).map((r) => ({
      workstationName: r.workstationName,
      eventCount:      Number(r.eventCount)
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.failed_logon_top_failed',
      days, topN, by, dcName, err: e?.message || String(e)
    }, 'report-center failedLogonTop read failed');
    return [];
  }
}

// 3) 账户变更报表 — 5 action × N day 走 adAccountChange.trendByDay
//   既有 SQL helper. 返 flat [{ action, bucketDay, eventCount }]. 跟
//   R158.108 dailyAggregate 1:1 平行 caller pivot 5 series.
// R158.111 — 加 actions: string[] filter (5 个 schema 真值白名单, 空数组/null
//   → 0 改老行为 = 全部 5 action).
export async function accountChangeDaily(db, { days = 7, actions = null } = {}, log = null) {
  try {
    // days ∈ [1, 365] 跟 SQL helper 1:1. 服务端 clamp 防 bad query 400.
    const safeDays = Math.max(1, Math.min(365, Number.parseInt(days, 10) || 7));
    // actions 白名单 filter — 走 SQL helper 前再做一次 (SQL helper 内部
    //   同样 filter, service 端双保险). 'unlocked' 在这里就被过滤掉, 0 污染 SQL.
    const safeActions = Array.isArray(actions) && actions.length > 0
      ? actions.filter((a) => VALID_ACCT_ACTIONS.includes(a))
      : null;
    const built = db.sql.adAccountChange.trendByDay({ days: safeDays, actions: safeActions });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      action:     r.action,
      bucketDay:  r.bucket_day,  // 'YYYY-MM-DD' string
      eventCount: Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.account_change_daily_failed',
      days, actions, err: e?.message || String(e)
    }, 'report-center accountChangeDaily read failed');
    return [];
  }
}

// 4) 锁定账户 raw event list — 流水不过滤, 跟 lockoutTop (top 聚合) 1:1
//   平行二视图 (跟 R158.X account-change 1:1 平行). 走新加的 lockout.listAll
//   SQL helper, sinceHours=NULL = 物理全量 (1264 行物理可达, 18d). 0 过滤
//   machine account / 空 sam (用户 directive "不接受筛选"). 返 raw row:
//   [{ dcName, sam, displayName, workstationName, eventId, occurredAt }].
// R158.111.a (2026-10-16) — 新加 (admin-only, 跟 4 既有 endpoint 1:1 平行).
export async function lockoutList(db, { sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}, log = null) {
  try {
    const built = db.sql.lockout.listAll({ sinceHours, dcName, search, limit, offset });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      dcName:           r.dc_name,
      sam:              r.target_user_name,
      displayName:      r.target_user_display_name ?? null,
      workstationName:  r.caller_computer_name ?? null,
      eventId:          Number(r.event_id),
      occurredAt:       r.occurred_at
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.lockout_list_failed',
      sinceHours, dcName, search, limit, offset, err: e?.message || String(e)
    }, 'report-center lockoutList read failed');
    return [];
  }
}

// 4b) 密码错误 raw event list — 流水不过滤, 跟 lockoutList 1:1 平行
//   (R158.111.a 2026-10-16). 走新加的 failedLogon.listAll SQL helper,
//   字段 workstation_name (跟 lockout caller_computer_name 字段名不同,
//   R158.1W.3 1:1 平行 caller 透明). 返 raw row:
//   [{ dcName, sam, displayName, workstationName, eventId, occurredAt }].
export async function failedLogonList(db, { sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}, log = null) {
  try {
    const built = db.sql.failedLogon.listAll({ sinceHours, dcName, search, limit, offset });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      dcName:           r.dc_name,
      sam:              r.target_user_name,
      displayName:      r.target_user_display_name ?? null,
      workstationName:  r.workstation_name ?? null,
      eventId:          Number(r.event_id),
      occurredAt:       r.occurred_at
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.failed_logon_list_failed',
      sinceHours, dcName, search, limit, offset, err: e?.message || String(e)
    }, 'report-center failedLogonList read failed');
    return [];
  }
}

// 4c) 账户变更 raw event list — 流水不过滤, 跟 lockoutList 1:1 平行
//   (R158.111.a 2026-10-16). 走新加的 adAccountChange.listAll SQL helper.
//   字段: sam / displayName / action / changeDate / createdAt / modifiedAt /
//   dcName / operatorUser (8 列, 跟 R158.72.x.4 ship 1:1 平行). sinceHours
//   NULL = 物理全量 (跟 lockout.listAll 1:1).
export async function accountChangeList(db, { sinceHours = null, dcName = null, search = null, limit = 100, offset = 0 } = {}, log = null) {
  try {
    const built = db.sql.adAccountChange.listAll({ sinceHours, dcName, search, limit, offset });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      sam:            r.sam,
      displayName:    r.display_name ?? null,
      action:         r.action,
      changeDate:     r.change_date,
      createdAt:      r.created_at ?? null,
      modifiedAt:     r.modified_at ?? null,
      dcName:         r.dc_name ?? null,
      operatorUser:   r.operator_user ?? null
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.account_change_list_failed',
      sinceHours, dcName, search, limit, offset, err: e?.message || String(e)
    }, 'report-center accountChangeList read failed');
    return [];
  }
}

// 5) 活跃 DC 列表 — 给报表中心 3 张报表"按 DC 筛选"下拉用.
export async function dcOptions(db, log = null) {
  try {
    const built = db.sql.reportCenter.dcOptions();
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      dcName:        r.dc_name,
      isPdc:         Boolean(r.is_pdc),
      isGc:          Boolean(r.is_gc),
      isBridgehead:  Boolean(r.is_bridgehead),
      discoveredAt:  r.discovered_at ?? null
    }));
  } catch (e) {
    log?.error?.({
      event: 'report_center.dc_options_failed',
      err: e?.message || String(e)
    }, 'report-center dcOptions read failed');
    return [];
  }
}

// Helper — 路由层 / 报表中心共用. days × 24 clamp [1, MAX_SINCE_HOURS].
function clampSinceHours(days) {
  const n = Math.max(1, Math.min(MAX_SINCE_HOURS, Math.floor(Number(days) * 24) || MAX_SINCE_HOURS));
  return n;
}

// Re-export db getter for routes/report-center.js (跟 services/eventlog.js
// 等其它 service 1:1 平行).
export { getDb };