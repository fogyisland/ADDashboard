// center/src/routes/email-queue.js
// R158.100.B (2026-10-14) — 邮件队列 admin endpoint. 跟 R158.69 email-history
// 1:1 平行 (同 factory shape, 同 guard), 但只查 sent_at IS NULL (未发出).
// 操作员 "邮件队列" tab (EmailConfigView 7th top-level) 用. 行内 3 操作:
//   - 点行 → 复用 R158.100.A drawer 详情 (openDetail 走既有 /api/admin/email-history/:source/:id)
//   - [重发] → 本路由 POST /:source/:id/retry (UPDATE next_attempt_at=now, 不重置 att)
//   - [放弃] → 本路由 DELETE /:source/:id (硬删, markExhausted 双层防御已就位)
//
//   GET    /api/admin/email-queue?limit=500
//     limit : 1..500 (cap 500, 跟 history 一致)
//     Response: { rows: [...], count } — 字段: source, ref_id, kind_detail,
//       to_addrs, cc_addrs, subject, attempt_count, max_attempts, last_error,
//       next_attempt_at, id. status 字段前端 derive (att<5=pending / att>=5=exhausted).
//
//   POST   /api/admin/email-queue/:source/:id/retry
//     source ∈ {'alert', 'report'} (whitelisted, 防 SQL injection 拼路径)
//     id     正整数
//     Response: { ok: true, affected: number } (200) / 400 / 404 / 500.
//
//   DELETE /api/admin/email-queue/:source/:id
//     source whitelisted, id 正整数
//     Response: { ok: true, affected: number } (200) / 400 / 404 / 500.
//
// 鉴权: [userAuth, requirePerm('admin:config')], 跟 email-history 1:1 同 posture.
// 0 改 email-history.js / 0 改 service 代码 (R158.69 决策 history 路由层
// 不参与 service, queue 同理, retention 才是 outbox DELETE 唯一 service 路径).
//
// R161.11 (2026-10-26) — 列表端点降级 + 留痕:
//   现场 500 的根因分类交给 utils/dbError.js 判; 表/列缺失 ⇒ 200 + 空列表 +
//   degraded 标记 (页面能开, 空数据不再是错误); 其它错误 ⇒ 仍 500, 但**必定**
//   落 pino error 日志 (此前 catch 只回 500, 服务端零日志 —— NSSM 丢弃 stderr,
//   操作员只能看到"500"三个字)。降级/留痕逻辑跟 email-history 共用
//   email-outbox-common.js, 1:1 平行。

import express from 'express';
import { handleListFailure, logRouteError, OUTBOX_DIAGNOSTICS_URL } from './email-outbox-common.js';
import { classifyDbError } from '../utils/dbError.js';

export function createEmailQueueRouter({ db, requireAuth, requirePerm, logger }) {
  const router = express.Router();
  const guard = [requireAuth, requirePerm('admin:config')];

  // ---- helper: 解析 (source, id) 必合法 ----
  function parseSourceId(req, res) {
    const source = req.params.source;
    if (source !== 'alert' && source !== 'report') {
      res.status(400).json({ error: 'invalid source (must be alert|report)' });
      return null;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id (must be positive integer)' });
      return null;
    }
    return { source, id };
  }

  // GET /api/admin/email-queue?limit=500
  router.get('/api/admin/email-queue', guard, async (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 500));
    try {
      const helperSet = db.sql.emailQueue;
      if (!helperSet) {
        res.status(500).json({ error: 'email-queue helper missing for current dialect' });
        return;
      }
      const sql = helperSet.listQueue(limit);
      const result = await db.execute(sql, []);
      const rawRows = result?.rows ?? result?.recordset ?? [];
      res.json({ rows: rawRows, count: rawRows.length, limit });
    } catch (err) {
      // R161.11 — 表/列缺失 ⇒ 降级成空列表 (200 + degraded); 其它 ⇒ 500。
      // 两条路径都落 pino (email-outbox-common.handleListFailure 内统一处理)。
      handleListFailure({
        logger,
        scope: 'email-queue',
        err,
        extra: { limit },
        res
      });
    }
  });

  // POST /api/admin/email-queue/:source/:id/retry
  router.post('/api/admin/email-queue/:source/:id/retry', guard, async (req, res) => {
    const parsed = parseSourceId(req, res);
    if (!parsed) return;
    const { source, id } = parsed;
    try {
      const helperSet = db.sql.emailQueue;
      if (!helperSet) {
        res.status(500).json({ error: 'email-queue helper missing for current dialect' });
        return;
      }
      const sql = source === 'alert' ? helperSet.retryAlert : helperSet.retryReport;
      const result = await db.execute(sql, [id]);
      const affected = Number(result?.affectedRows ?? result?.rowsAffected?.[0] ?? 0);
      if (affected === 0) {
        // 行不存在 或 已 sent → 视为 404
        res.status(404).json({ error: 'row not found or already sent', source, id });
        return;
      }
      res.json({ ok: true, affected, source, id });
    } catch (err) {
      // 写操作不做降级 (降级成"成功"会骗操作员), 但**必须留痕**。
      const info = classifyDbError(err);
      logRouteError(logger, 'email-queue retry', err, info, { source, id });
      res.status(500).json({
        error: 'email-queue retry failed',
        errorCode: info.code ?? null,
        errorKind: info.kind,
        detail: info.message,
        diagnosticsUrl: OUTBOX_DIAGNOSTICS_URL
      });
    }
  });

  // DELETE /api/admin/email-queue/:source/:id
  router.delete('/api/admin/email-queue/:source/:id', guard, async (req, res) => {
    const parsed = parseSourceId(req, res);
    if (!parsed) return;
    const { source, id } = parsed;
    try {
      const helperSet = db.sql.emailQueue;
      if (!helperSet) {
        res.status(500).json({ error: 'email-queue helper missing for current dialect' });
        return;
      }
      const sql = source === 'alert' ? helperSet.deleteAlert : helperSet.deleteReport;
      const result = await db.execute(sql, [id]);
      const affected = Number(result?.affectedRows ?? result?.rowsAffected?.[0] ?? 0);
      if (affected === 0) {
        res.status(404).json({ error: 'row not found or already sent', source, id });
        return;
      }
      res.json({ ok: true, affected, source, id });
    } catch (err) {
      const info = classifyDbError(err);
      logRouteError(logger, 'email-queue delete', err, info, { source, id });
      res.status(500).json({
        error: 'email-queue delete failed',
        errorCode: info.code ?? null,
        errorKind: info.kind,
        detail: info.message,
        diagnosticsUrl: OUTBOX_DIAGNOSTICS_URL
      });
    }
  });

  return router;
}
