// center/src/routes/report-center.js
// R158.110 (2026-10-16) — 报表中心 3 endpoint (admin-only).
// R158.111 (2026-10-16) — 3 endpoint 加 filter query param:
//   /lockout-top?dc=&q=
//   /failed-logon-top?dc=
//   /account-change-daily?actions=created,modified (逗号分隔)
//   + 新加 /api/report-center/dc-options (DC 下拉选项).
// 跟 R158.61 reports.js / R158.68 system-alerts.js / R158.100.B email-queue
// 1:1 平行 admin perm gate (userAuth + admin:users). 0 改 3 老 endpoint
// 既有 caller (新参默认空 → 行为完全一致), 0 改老 wire shape.
//
// 4 endpoint:
//   GET /api/report-center/lockout-top?days=7&topN=5[&dc=][&q=]
//     锁定账户 top by target_user. days 24h=1 / 7d=7 / all≥7=7 走 7d
//     ceiling (跟 SQL helper [1,168] 1:1 平行). topN ∈ [1, 20]. dc/q 可选.
//   GET /api/report-center/failed-logon-top?days=7&topN=5&by=workstation|dc[&dc=]
//     失败登录 top by workstation (default) or dc. days/topN 同上. dc 可选.
//   GET /api/report-center/account-change-daily?days=7[&actions=created,modified]
//     账户变更 5 action × N day 折线数据. days ∈ [1, 365]. actions 逗号分隔
//     数组 (5 schema 真值白名单; 'unlocked' 在 service 层 filter).
//   GET /api/report-center/dc-options
//     报表中心 3 张报表 "按 DC 筛选" 下拉选项, 从 ad_dcs 动态返.
//
// 6 layer verify (Layer 2 endpoint):
//   - admin token: 200 + N row
//   - bad days (0/-1/1000): 400
//   - bad actions (foo,bar): 400 (走白名单)
//   - non-admin userAuth user: 403 (admin:users perm)
//   - R158.X.116.n: 任一 report_center.* flag = '0' → 503 disabled_by_feature_flag

import { Router } from 'express';
import * as reportCenterSvc from '../services/report-center.js';
// R161.6 (2026-10-26) — flag 判定语义抽到公共函数 (与前端 web/src/lib/featureFlag.js
//   逐字对齐, 由 tests/feature-flag-semantics.test.js 锁死两端一致)。
import { readFeatureFlag } from '../utils/featureFlag.js';

const DAYS_MIN = 1;
const DAYS_MAX = 365;
const TOP_N_MIN = 1;
const TOP_N_MAX = 20;
const ALLOWED_BY = new Set(['workstation', 'dc']);
const VALID_ACCT_ACTIONS = new Set(['created','modified','deleted','enabled','disabled']);
const SEARCH_MAX_LEN = 64;       // 前缀 LIKE 'q%' 上限, 防超长 query

export function reportCenterRouter({ requireAuth, requirePerm, db, logger }) {
  const r = Router();
  const adminAuth = [requireAuth, requirePerm('admin:users')];

  // R158.X.116.n (2026-10-23) — 报表中心 feature flag 闸门组.
  //   4 把开关: report_center.enabled (总闸) + 3 把子闸 (lockout /
  //   failed_logon / account_change). 1:1 平行 mcp.js 的 isMcpEnabled +
  //   gate (R158.X.116.k), 语义刻意逐字对齐 (缺行=不拦 / 查询失败=fail-open),
  //   改本段时三处一起改 (本文件 / mcp.js / mcp-write.js), 免得开关语义漂移.
  //
  //   **总闸与子闸都查, 不做隐式蕴含**: 若后端只查子闸, 「总闸关 + 子闸开」时
  //   后端会放行, 而前端 parent route 的 meta.featureFlag 仍把用户弹回首页 ——
  //   两层判定分裂 (lesson 158/159 的老问题). 宁可多查一次 DB, 不留口径缝隙.
  const MASTER_FLAG = 'report_center.enabled';
  const SUB_FLAGS = {
    lockout: 'report_center.lockout.enabled',
    failedLogon: 'report_center.failed_logon.enabled',
    accountChange: 'report_center.account_change.enabled'
  };

  async function readFlag(key) {
    // R161.6 — 判定逻辑搬进 src/utils/featureFlag.js (缺行=不拦 / 读库失败=fail-open
    //   / '1'|1|true=放行 / 其它值=拦), 语义与本文件原来的实现**逐字相同**,
    //   行为零变化; 目的只是让 3 个后端 gate + 前端 2 处判定共用一份定义。
    //   本函数保留原名/签名, 调用点 (gateFor / dcOptionsGate) 一行未动。
    return readFeatureFlag(db, key, logger, 'report-center');
  }

  // 要求 MASTER_FLAG + flagKeys 列出的开关**全部**开启才放行
  function gateFor(...flagKeys) {
    const required = [MASTER_FLAG, ...flagKeys];
    return async function gate(req, res, next) {
      for (const key of required) {
        if (!(await readFlag(key))) {
          logger?.warn?.({ method: req.method, path: req.path, flag: key },
            'report-center request blocked: feature flag off');
          return res.status(503).json({ error: 'disabled_by_feature_flag', flag: key });
        }
      }
      return next();
    };
  }

  // dc-options 是 3 个子页面**共用**的 DC 下拉数据源 —— 跟 3 把子闸里的哪一把
  //   都没有 1:1 归属。所以语义是「总闸开 且 至少一把子闸开」, 而不是绑死某一把:
  //   绑死的话, 关掉任意一把子闸会把另外两个页面的下拉框一起打空。
  const dcOptionsGate = async (req, res, next) => {
    if (!(await readFlag(MASTER_FLAG))) {
      return res.status(503).json({ error: 'disabled_by_feature_flag', flag: MASTER_FLAG });
    }
    const any = await Promise.all(Object.values(SUB_FLAGS).map(readFlag));
    if (!any.some(Boolean)) {
      return res.status(503).json({ error: 'disabled_by_feature_flag', flag: MASTER_FLAG });
    }
    return next();
  };

  const gateLockout = gateFor(SUB_FLAGS.lockout);
  const gateFailedLogon = gateFor(SUB_FLAGS.failedLogon);
  const gateAccountChange = gateFor(SUB_FLAGS.accountChange);

  // 1) 锁定账户报表 — top by user. 跟 R158.64 reports.js fetchLockoutSection
  //   范式 1:1 平行, 调 lockoutSvc.topByUserWithDisplay (透过 SQL helper).
  // R158.111 — 加可选 ?dc= + ?q= (前缀搜账户).
  r.get('/api/report-center/lockout-top', ...adminAuth, gateLockout, async (req, res) => {
    try {
      const days = clampInt(req.query.days, DAYS_MIN, DAYS_MAX, 7);
      const topN = clampInt(req.query.topN, TOP_N_MIN, TOP_N_MAX, 5);
      const dcName = trimOrNull(req.query.dc, 128);
      const search = trimOrNull(req.query.q, SEARCH_MAX_LEN);
      if (req.query.q !== undefined && req.query.q !== null && req.query.q !== '' && search === null) {
        return res.status(400).json({ error: `q must be ≤ ${SEARCH_MAX_LEN} chars` });
      }
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.lockoutTop(db, { days, topN, dcName, search }, req.log);
      res.json({ days, topN, dcName, search, rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.lockout_top_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /lockout-top read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 2) 失败登录报表 — by=workstation|dc 二 path. 跟 R158.55/57
  //   failedLogonView 范式 1:1 平行.
  // R158.111 — 加可选 ?dc= filter.
  r.get('/api/report-center/failed-logon-top', ...adminAuth, gateFailedLogon, async (req, res) => {
    try {
      const days = clampInt(req.query.days, DAYS_MIN, DAYS_MAX, 7);
      const topN = clampInt(req.query.topN, TOP_N_MIN, TOP_N_MAX, 5);
      const byRaw = String(req.query.by ?? 'workstation').toLowerCase().trim();
      if (!ALLOWED_BY.has(byRaw)) {
        return res.status(400).json({
          error: `by must be one of: ${[...ALLOWED_BY].join(', ')}`
        });
      }
      const dcName = trimOrNull(req.query.dc, 128);
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.failedLogonTop(db, { days, topN, by: byRaw, dcName }, req.log);
      res.json({ days, topN, by: byRaw, dcName, rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.failed_logon_top_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /failed-logon-top read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 3) 账户变更报表 — 5 action × N day. 跟 R158.108 dailyAggregate
  //   范式 1:1 平行.
  // R158.111 — 加可选 ?actions=created,modified 逗号分隔 (5 白名单).
  r.get('/api/report-center/account-change-daily', ...adminAuth, gateAccountChange, async (req, res) => {
    try {
      const days = clampInt(req.query.days, DAYS_MIN, DAYS_MAX, 7);
      const actions = parseActions(req.query.actions);
      if (req.query.actions !== undefined && req.query.actions !== null && req.query.actions !== '' && actions === null) {
        return res.status(400).json({
          error: `actions must be subset of: ${[...VALID_ACCT_ACTIONS].join(', ')}`
        });
      }
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.accountChangeDaily(db, { days, actions }, req.log);
      res.json({ days, actions: actions || 'all', rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.account_change_daily_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /account-change-daily read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 4) 锁定账户 raw event list — 流水不过滤, 跟 lockout-top 1:1 平行
  //   (R158.111.a 2026-10-16). days 缺省 / 0 = 物理全量 (sinceHours=NULL),
  //   days>0 = sinceHours=days×24 (走 SQL helper cap [1,168]). limit 默认
  //   100 (跟 R158.109.b lockout-accounts 1:1 平行), offset 默认 0.
  //   0 改 lockout-top 老端点 (R158.69 "用到端点就新建" 1:1 平行).
  r.get('/api/report-center/lockout-events', ...adminAuth, gateLockout, async (req, res) => {
    try {
      const sinceHours = parseSinceHours(req.query.days);
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1000000, 0);
      const dcName = trimOrNull(req.query.dc, 128);
      const search = trimOrNull(req.query.q, SEARCH_MAX_LEN);
      if (req.query.q !== undefined && req.query.q !== null && req.query.q !== '' && search === null) {
        return res.status(400).json({ error: `q must be ≤ ${SEARCH_MAX_LEN} chars` });
      }
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.lockoutList(db, { sinceHours, dcName, search, limit, offset }, req.log);
      res.json({ sinceHours, dcName, search, limit, offset, rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.lockout_events_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /lockout-events read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 4b) 密码错误 raw event list — 跟 lockout-events 1:1 平行
  //   (R158.111.a 2026-10-16, 操作员 directive "密码错误 和账户变更 都是按照一样的方式").
  //   字段: workstationName (跟 lockout caller 字段名不同, 1:1 平行 R158.1W.3 1:1).
  r.get('/api/report-center/failed-logon-events', ...adminAuth, gateFailedLogon, async (req, res) => {
    try {
      const sinceHours = parseSinceHours(req.query.days);
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1000000, 0);
      const dcName = trimOrNull(req.query.dc, 128);
      const search = trimOrNull(req.query.q, SEARCH_MAX_LEN);
      if (req.query.q !== undefined && req.query.q !== null && req.query.q !== '' && search === null) {
        return res.status(400).json({ error: `q must be ≤ ${SEARCH_MAX_LEN} chars` });
      }
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.failedLogonList(db, { sinceHours, dcName, search, limit, offset }, req.log);
      res.json({ sinceHours, dcName, search, limit, offset, rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.failed_logon_events_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /failed-logon-events read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 4c) 账户变更 raw event list — 跟 lockout-events 1:1 平行
  //   (R158.111.a 2026-10-16). 跟 R158.72.x.4 ship 1:1 平行, 8 列 raw row.
  //   sinceHours NULL=物理全量 (跟 lockout 1:1); SQL helper 自带 retention
  //   cap 720h 30d 跟 ad_mgmt_retention_days=30 1:1 平行.
  r.get('/api/report-center/account-change-events', ...adminAuth, gateAccountChange, async (req, res) => {
    try {
      const sinceHours = parseSinceHours(req.query.days);
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1000000, 0);
      const dcName = trimOrNull(req.query.dc, 128);
      const search = trimOrNull(req.query.q, SEARCH_MAX_LEN);
      if (req.query.q !== undefined && req.query.q !== null && req.query.q !== '' && search === null) {
        return res.status(400).json({ error: `q must be ≤ ${SEARCH_MAX_LEN} chars` });
      }
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.accountChangeList(db, { sinceHours, dcName, search, limit, offset }, req.log);
      res.json({ sinceHours, dcName, search, limit, offset, rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.account_change_events_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /account-change-events read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 5) DC 列表下拉选项 — 给 3 张报表 "按 DC 筛选" 共用.
  // R158.111 — 新加 (admin-only, 复用 adminAuth 常量, 0 改 server.js mount).
  r.get('/api/report-center/dc-options', ...adminAuth, dcOptionsGate, async (req, res) => {
    try {
      const db = (await import('../db/index.js')).getDb();
      const rows = await reportCenterSvc.dcOptions(db, req.log);
      res.json({ rows, count: rows.length });
    } catch (e) {
      req.log?.error?.({
        event: 'report_center.dc_options_endpoint_failed',
        err: e?.message || String(e)
      }, 'report-center /dc-options read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}

// clampInt 4 参 overload (跟 R158.108/109.a/109.b 1:1 平行): clampInt(raw,
// min, max, defaultValue). 缺省 defaultValue (跟 R158.108 老 caller 兼容).
function clampInt(raw, min, max, defaultValue) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue !== undefined ? defaultValue : min;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return defaultValue !== undefined ? defaultValue : min;
  if (n > max) return max;
  return n;
}

// trimOrNull — 字符串 trim 后超过 maxLen 返 null (route 层 400),
//   空字符串返 null (透传 SQL helper 走 0 filter 短路).
function trimOrNull(raw, maxLen) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (s.length > maxLen) return null;
  return s;
}

// parseActions — ?actions=created,modified 逗号分隔解析 + 白名单校验.
//   全空 (raw 未传/空串) → null (走 SQL helper 0 filter = 全选).
//   含非法 action → null + route 层返 400.
// R158.111 — 跟 service 层 VALID_ACCT_ACTIONS 1:1 平行 (双校验, 0 改).

// parseSinceHours — R158.111.a 物理全量语义: days 缺省 / null / 空串 /
//   0 / 负数 → null (走 SQL helper 物理全量), days>0 → sinceHours=days×24
//   (跟 R158.111 lockout-top 1:1 平行 days 透传). 超过 SQL helper cap
//   168h 时 service throw (lockout-list SQL helper 仍然 cap [1,168] 跟
//   topByUserWithDisplay 1:1 平行, 物理全量用 days=0/null 走 0 过滤).
function parseSinceHours(days) {
  if (days === undefined || days === null || days === '') return null;
  const n = Number(days);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n * 24;
}
function parseActions(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const list = String(raw).split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return null;
  for (const a of list) {
    if (!VALID_ACCT_ACTIONS.has(a)) return null;
  }
  return list;
}