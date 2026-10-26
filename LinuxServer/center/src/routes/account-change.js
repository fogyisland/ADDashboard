// R158.X (2026-10-15) — 账户变更明细 sub-tab (AccountChangeDetailView) 的
//   3 个 endpoint. 平行 eventlogRouter / lockoutRouter / failedLogonRouter,
//   走 userAuth-only (跟 /eventlog / /lockout-accounts / /failed-logon-2h
//   / /os-baseline 同档 — 任何普通登录用户可访问, NO admin perm gate).
//
//   路径前缀: /api/account-change/*  (新 top-level path, 不进 dashboardRouter
//   因为它有全局 `read:dash` gate, R158.X 同 R112 / R116 / R131 / R158.50
//   平行 ship 走自己 router).
//
//   3 个 endpoint:
//     GET /api/account-change/summary
//       返回 5 类 action 当日聚合计数 + 跨 DC 数. shape: { summary: [{ action,
//       count, dcCount }] × 5 }. caller 5 块大字卡片. 复用 accountChangeService
//       .listByActionToday 5 次 (无 limit 传参, 默认 50 跟 R158.72 ship 一致).
//
//     GET /api/account-change/detail?action=X&limit=50
//       当日某 action top-N 明细表 (AccountChangeDetailView 5 tab 切换).
//       action 必须 ∈ {created, modified, deleted, enabled, disabled}.
//       limit clampInt [1, 500]. 复用 accountChangeService.listByActionToday.
//
//     GET /api/account-change/events?sinceHours=24&limit=200
//       跨 DC 账户管理 event 列表 (Security log 4720/4722/4723/4725/4726/
//       4738/4740). 新 eventlog.queryAccountManagementEvents SQL helper
//       (R158.X 双 dialect ship, MySQL inline int list + MSSQL inline
//       TOP 整数, 0 N placeholder, 跟 R158.100.B+3 #2 lesson 避坑).
//
//   Auth 跟其他 userAuth-only 一致: requireAuth(本 router 内 path-scope
//   r.use('/api/account-change', requireAuth), 跟 eventlogRouter line 78
//   precedent 1:1 平行). 0 catch-all 404 (R126 fix).

import { Router } from 'express';
import { getDb } from '../db/index.js';
import * as accountChangeService from '../services/account-change.js';
import { queryAccountManagementEvents } from '../services/eventlog.js';

const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168; // 7d ceiling — covers 24h 跟 operator 后
                             // 续可加 7d 切换的扩展点 (本期 ship 用 24h).
const DETAIL_MIN_LIMIT = 1;
const DETAIL_MAX_LIMIT = 500;
const EVENTS_MIN_LIMIT = 1;
const EVENTS_MAX_LIMIT = 500;

const ALLOWED_ACTIONS = new Set(['created', 'modified', 'deleted', 'enabled', 'disabled']);
// Security log 账户管理 event_id whitelist (cross-DC 跨实例跨 DC, 不带
// dcName). 4720=创建账户, 4722=启用, 4723=用户试图创建已存在账户 (失败),
// 4724=试图重置密码, 4725=禁用, 4726=删除账户, 4738=用户账户变更 (跟
// "修改" 弱对应), 4740=锁定. 一组覆盖 operator 关心的 5 种动作 + 锁.
const ACCOUNT_MANAGEMENT_EVENT_IDS = [4720, 4722, 4723, 4725, 4726, 4738, 4740];

export function accountChangeRouter({ requireAuth }) {
  const r = Router();

  // Path-scope auth (跟 eventlogRouter:78 precedent 1:1 平行, 避免 R126
  // 类的 "r.use(requireAuth) 顶级 误伤 sibling router" 陷阱).
  r.use('/api/account-change', requireAuth);

  r.get('/api/account-change/summary', async (req, res) => {
    try {
      const db = getDb();
      const summary = [];
      for (const action of ALLOWED_ACTIONS) {
        const rows = await accountChangeService.listByActionToday(db, action, req.log);
        const count = rows.length;
        const dcSet = new Set(rows.map(row => row.dc_name).filter(Boolean));
        summary.push({ action, count, dcCount: dcSet.size });
      }
      res.json({ summary });
    } catch (e) {
      req.log?.error?.({
        event: 'account_change.summary_failed',
        err: e?.message || String(e)
      }, 'account-change summary read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/account-change/detail', async (req, res) => {
    const action = String(req.query.action ?? '').trim();
    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json({
        error: `action must be one of: ${[...ALLOWED_ACTIONS].join(', ')}`
      });
    }
    const limit = clampInt(req.query.limit, DETAIL_MIN_LIMIT, DETAIL_MAX_LIMIT);
    try {
      const db = getDb();
      const rows = await accountChangeService.listByActionToday(db, action, req.log, limit);
      // camelCase re-shape for front-end (跟 FailedLogonView / EventlogView
      // 一致, snake_case 是 DB wire shape).
      const out = rows.map((row) => ({
        sam:         row.sam,
        displayName: row.display_name ?? null,
        dcName:      row.dc_name,
        createdAt:   row.created_at,
        modifiedAt:  row.modified_at,
        changeDate:  row.change_date
      }));
      res.json({ action, rows: out, count: out.length });
    } catch (e) {
      req.log?.error?.({
        event: 'account_change.detail_failed',
        action,
        err: e?.message || String(e)
      }, 'account-change detail read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/account-change/events', async (req, res) => {
    const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
    const limit = clampInt(req.query.limit, EVENTS_MIN_LIMIT, EVENTS_MAX_LIMIT);
    try {
      const db = getDb();
      const events = await queryAccountManagementEvents(db, {
        eventIds: ACCOUNT_MANAGEMENT_EVENT_IDS,
        sinceHours,
        limit
      });
      res.json({ events, count: events.length });
    } catch (e) {
      req.log?.error?.({
        event: 'account_change.events_failed',
        err: e?.message || String(e)
      }, 'account-change events read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}

function clampInt(raw, min, max) {
  if (raw === undefined || raw === null || raw === '') return min;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return min;
  if (n > max) return max;
  return n;
}
