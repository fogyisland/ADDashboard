// center/src/routes/system-inapp-notifications.js
// R158.X.99.34.d (2026-10-19) — in-app notification list endpoint.
//
// 操作员 directive (verbatim): "但是可以在窗口期不停告警,也提供恢复告警。另外
//   我们是否可以存在各种设置的消息记录和推送功能?"  澄清后: 操作员登录 dashboard
//   后,在 dashboard 内部推送/显示告警消息给管理员 (=in-app bell/drawer/toast,
//   NOT webhook/Slack/IM/邮件).
//
// 3 锁:
//   (1) 窗口期内多次告警: 同 kind+scope firing 持续期多 tick → 前端 polling 检测
//       同一 (kind, scope_ref) 仍在 firing → 仍推 (节流基线是 lastNotifiedAt,
//       跟系统告警 email 节流 NOTIFY_THROTTLE_MINUTES=120 解耦, R158.X.99.34.c).
//   (2) 恢复告警: firing → recovered transition → 前端 polling 检测 state 变化 → 推.
//   (3) in-app 推送: dashboard 内部 bell + drawer + toast, 0 外部 webhook / Slack /
//       IM / 邮件.
//
// 0 改 system-alert-engine.js — engine 继续跑同一 5 detector + 同一节流基线 + 同一
//   email outbox. in-app 推送是新 channel,纯客户端 polling 派生.
//
// 端点 (1 GET):
//   GET /api/admin/system-alerts/since?since=<ISO>&limit=50
//     since: ISO 8601 时戳 (客户端 watermark), 默认 now - 1h (前端 store 持久化)
//     limit: 1-200 (默认 50,服务端 clamp)
//     返: { items: [...], count, since }
//          每 item 含 id / kind / scope_type / scope_ref / state / fired_at /
//          recovered_at / acked_at / notify_count / detail / threshold.
//          fired_at / recovered_at / acked_at 三列任一 > since → 返该行.
//   auth: [userAuth, requirePerm('admin:users')] (跟 createSystemAlertsRouter 同 guard)
//
// 跟 routes/system-alerts.js 10 端点 0 冲突 — 独立 router file mount, 新 path
// '/since' 跟 '/recent' '/kpi' '/config' '/:id/ack' '/suppressions' 互不重叠.
// 跟 routes/email-history.js / routes/email-queue.js / routes/ad-notify.js 1:1 平行
// (同 factory shape, 同 guard).

import { Router } from 'express';
import { toMysqlDatetime } from '../utils/datetime.js';

export function createSystemInappNotificationsRouter({ db, requireAuth, requirePerm, logger }) {
  const auth = [requireAuth, requirePerm('admin:users')];

  async function listSince(req, res) {
    try {
      // since 解析: ISO 字符串 → Date. 老客户端 (0 since) 兜底 now - 1h.
      const rawSince = (typeof req.query.since === 'string' && req.query.since.trim())
        ? req.query.since.trim() : null;
      let sinceDate = rawSince ? new Date(rawSince) : new Date(Date.now() - 3600 * 1000);
      if (!Number.isFinite(sinceDate.getTime())) {
        return res.status(400).json({ error: 'invalid_since', got: rawSince });
      }
      const sinceIso = sinceDate.toISOString();
      // R161.5 (2026-10-26) — system_alerts.fired_at / recovered_at / acked_at
      //   在 MySQL 基线里是 DATETIME(3) / DATETIME ⇒ 绑 ISO 会 ER 1292
      //   (Incorrect datetime value) ⇒ 端点 500。MySQL 侧先转 naive 格式。
      //   MSSQL 侧 datetime2 接受 ISO ⇒ 保留原值 (MSSQL 零行为变化)。
      //   ⚠ sinceIso 仍用于 response body (前端 watermark 必须是 ISO),
      //     两者不能混用同一个变量。
      const sinceParam = db.dialect === 'mssql' ? sinceIso : toMysqlDatetime(sinceIso);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const fn = db.sql.systemAlerts.listSince;
      const sqlText = typeof fn === 'function' ? fn({ since: sinceParam, limit }) : fn;
      // params 顺序: [fired_at, recovered_at, acked_at] 各 1 个 since 占位符.
      const params = [sinceParam, sinceParam, sinceParam];
      const { rows } = await db.query(sqlText, params);
      res.json({ items: rows, count: rows.length, since: sinceIso });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-inapp-notifications listSince failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  }

  const router = Router();
  router.get('/api/admin/system-alerts/since', ...auth, listSince);
  return router;
}
