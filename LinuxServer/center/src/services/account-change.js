// center/src/services/account-change.js
// R158.72 (2026-10-11) — AD 账户变更 ETL service (公共表 pattern, R110.A).
//   跟 admin-members 服务同模式:
//     - normalizeMetrics: PS1 wire shape → 标准化 entries (per-row camelCase)
//     - upsertMembers: 中心端 MERGE ON (sam, action, change_date) 自动 dedup
//     - getTrend: 30 天 trend data 给 dashboard 折线图
//     - listByActionToday: 当日某 action top-N 给报表 section + 新 sub-tab
//
// R158.X (2026-10-15) — listByActionToday 加可选 limit 入参 (默认 50 跟
//   SQL helper 内部 LIMIT 50 保持一致), AccountChangeDetailView 新 view
//   复用同一 service 调大到 50. 加 limit 不影响 DashboardView 既有调用
//   (R158.72 ship 调用走无 limit 默认值, 仍 50, wire shape 不变).
//
// R161.5 (2026-10-26) — MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串。
//   ad_account_change.created_at / modified_at / collected_at 都是 DATETIME
//   ⇒ 绑 ISO 会 ER 1292 (Incorrect datetime value) ⇒ 每行 upsert 失败 ⇒
//   per-row catch 把错误吞进 errors[] ⇒ 账户变更**静默不落库**。
//   MSSQL 侧 datetime2 接受 ISO ⇒ 只在 MySQL 分支转。
//   change_date 是 DATE 列 (值为 'YYYY-MM-DD') ⇒ 不能碰, 原样传。

import { toMysqlDatetime } from '../utils/datetime.js';

function pickField(obj, ...names) {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return null;
}

function asDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function asDateStr(v) {
  const d = asDate(v);
  if (!d) return null;
  return d.toISOString();
}

function normalizeEntry(e, domainDn, dcName, fallbackDate, runId) {
  const sam = pickField(e, 'sam');
  if (!sam) return null;
  const action = pickField(e, 'action');
  if (!action) return null;
  const displayName = pickField(e, 'display_name', 'displayName');
  const createdAt = pickField(e, 'created_at', 'createdAt');
  const modifiedAt = pickField(e, 'modified_at', 'modifiedAt');
  const dn = pickField(e, 'dn', 'distinguished_name');
  // R158.72.x.4 (2026-10-16) — +1 字段 operator_user (事件 Properties[4]
  //   SubjectUserName). 1:1 平行其他 6 字段; 缺则 null (老 entry 0 改 wire
  //   shape; 新 upsert SQL ON DUPLICATE KEY / MERGE 都会带 NULL 走默认).
  const operatorUser = pickField(e, 'operator_user', 'operatorUser');
  // change_date = PS1 已按 CST today 00:00 算, 也接受 metrics.change_date fallback
  let changeDate = pickField(e, 'change_date', 'changeDate') || fallbackDate;
  if (!(changeDate instanceof Date)) {
    changeDate = asDate(changeDate);
  }
  // JS Date → 'YYYY-MM-DD' 字符串 (DATE 列 MSSQL/MySQL 兼容)
  let changeDateStr;
  if (changeDate) {
    const y = changeDate.getUTCFullYear();
    const m = String(changeDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(changeDate.getUTCDate()).padStart(2, '0');
    changeDateStr = `${y}-${m}-${d}`;
  } else {
    changeDateStr = null;
  }
  if (!changeDateStr) return null;
  return {
    sam: String(sam),
    displayName: displayName ? String(displayName) : null,
    action: String(action),
    createdAt: asDateStr(createdAt),
    modifiedAt: asDateStr(modifiedAt),
    changeDate: changeDateStr,
    domainDn: dn ? String(dn) : domainDn,
    dcName,
    operatorUser: operatorUser ? String(operatorUser) : null,
    collectedAt: new Date().toISOString()
  };
}

// Normalize a metrics envelope payload from PS1 (wire shape) into the
// shape the centre post-hook will MERGE. Returns { agentId, dcName,
// domainDn, changeDate, entries, collectedAt }. Caller upserts each
// entry individually (per-row try/catch isolation — R60.7 模式).
function normalizeMetrics(metrics, fallbackAgentId, runId) {
  const agentId = pickField(metrics, 'agentId', 'agent_id') || fallbackAgentId;
  const dcName = pickField(metrics, 'dcName', 'dc_name') || agentId;
  const domainDn = pickField(metrics, 'domainDn', 'domain_dn');
  let changeDate = pickField(metrics, 'changeDate', 'change_date');
  if (!(changeDate instanceof Date)) changeDate = asDate(changeDate);
  const entriesRaw = Array.isArray(metrics?.entries) ? metrics.entries : [];
  const entries = entriesRaw.map(e => normalizeEntry(e, domainDn, dcName, changeDate, runId)).filter(Boolean);
  return { agentId, dcName, domainDn, changeDate, entries, collectedAt: new Date() };
}

export async function upsertMembers(db, metrics, fallbackAgentId, runId, log) {
  const n = normalizeMetrics(metrics, fallbackAgentId, runId);
  // R161.5 — 三个 DATETIME 列在 MySQL 分支转 naive 格式; MSSQL 保留 ISO
  //   (datetime2 接受 ISO ⇒ MSSQL 侧零行为变化)。
  const isMssql = db.dialect === 'mssql';
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (const row of n.entries) {
    try {
      const built = db.sql.adAccountChange.upsert({
        ...row,
        createdAt: isMssql ? row.createdAt : toMysqlDatetime(row.createdAt),
        modifiedAt: isMssql ? row.modifiedAt : toMysqlDatetime(row.modifiedAt),
        collectedAt: isMssql ? row.collectedAt : toMysqlDatetime(row.collectedAt)
      });
      await db.execute(built.sql, built.params);
      upserted++;
    } catch (e) {
      if (log?.error) {
        log.error({
          event: 'ad_account_change.upsert_failed',
          sam: row.sam,
          action: row.action,
          change_date: row.changeDate,
          err: e?.message || String(e)
        }, 'ad_account_change upsert failed');
      }
      errors.push({ sam: row.sam, action: row.action, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// 30-day (default) trend data for dashboard 折线图.
// 返回 [{ action, change_date, event_count }] 原始行, caller pivot。
export async function getTrend(db, days, log) {
  const spec = db.sql.adAccountChange.trendByDay({ days });
  const { rows } = await db.query(spec.sql, spec.params);
  return rows || [];
}

// 当日某 action top-N for 日报/周报 section + AccountChangeDetailView
// sub-tab. R158.X (2026-10-15) 加可选 limit 入参 (默认 50, 跟 SQL
// helper 内部 LIMIT 50 保持一致). 0 改 wire shape.
// R158.X.99 (2026-10-21) — 语义由「今天」改「昨天」. 采集端 cron 02:00 跑,
//   抓的是昨天整天; 函数名 listByActionToday 已属误导但改名要动 3 个 call site
//   (routes/account-change.js ×2 + services/reports.js), 本期保留名字只改行为,
//   注释写清新语义. 后续如需清理再统一改名.
export async function listByActionToday(db, action, log, limit = 50) {
  const spec = db.sql.adAccountChange.dailyTopByAction({ action, limit });
  const { rows } = await db.query(spec.sql, spec.params);
  return rows || [];
}
