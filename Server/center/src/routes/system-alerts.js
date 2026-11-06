// center/src/routes/system-alerts.js
// R158.68 (2026-10-10) — 系统内置告警 admin API
// R158.Suppression (2026-10-15) — 加 3 端点 (操作员行级暂停告警), 跟 ack()/putConfig() 1:1 平行.
//
// 8 端点 (5+3):
//   GET    /api/admin/system-alerts                      list current firing (可选 kind/scope_ref 过滤)
//   GET    /api/admin/system-alerts/recent               list history (含 recovered/acked)
//   GET    /api/admin/system-alerts/kpi                  顶部 KPI (firing 总数 / 24h 触发 / 已 ack)
//   GET    /api/admin/system-alerts/config               读 system_config 5 阈值 + 收件人 + interval
//   PUT    /api/admin/system-alerts/config               写 system_config 5 阈值 + 收件人 + interval
//   POST   /api/admin/system-alerts/:id/ack              operator 手动 ack 一条 firing
//   ─── R158.Suppression ─── 操作员行级暂停告警 ───
//   GET    /api/admin/system-alerts/suppressions         list 当前生效抑制 (kind 过滤可选)
//   PUT    /api/admin/system-alerts/suppressions         upsert 抑制 (永久默认, expires_at 留接口)
//   DELETE /api/admin/system-alerts/suppressions         操作员解除抑制
//
// auth: [userAuth, requirePerm('admin:users')] (跟 R158.62 alert-inbox 同 guard)

import { Router } from 'express';
import { getConfig as getSystemConfig } from '../services/config.js';
import { writeAudit } from '../services/audit.js';

const CONFIG_KEYS = [
  'system_alert_heartbeat_offline_minutes',
  'system_alert_replication_failure_count',
  'system_alert_port_latency_ms',
  'system_alert_disk_free_kb',
  'system_alert_failed_logon_24h',
  'system_alert_to',
  'system_alert_eval_interval_seconds'
];

const INT_KEYS = new Set([
  'system_alert_heartbeat_offline_minutes',
  'system_alert_replication_failure_count',
  'system_alert_port_latency_ms',
  'system_alert_disk_free_kb',
  'system_alert_failed_logon_24h',
  'system_alert_eval_interval_seconds'
]);

// R158.Suppression.1 (2026-10-15) — module-level 顶层 fn. 验 kind/scope_ref 合法性,
//   失败时直接 res.status(400). 成功返 { kind, scopeRef } 给 handler. 提到工厂外避免
//   `this` binding bug (Express handler 调时 this=req, 不是 handler 字典).
function validateKindScopeParams(req, res) {
  const kind = (typeof req.query.kind === 'string' && req.query.kind.trim()) ? req.query.kind.trim() : null;
  const scopeRef = (typeof req.query.scope_ref === 'string' && req.query.scope_ref.trim()) ? req.query.scope_ref.trim() : null;
  if (!kind || kind.length > 40) {
    res.status(400).json({ error: 'invalid_kind', got: kind });
    return null;
  }
  // scope_ref 对 PUT/DELETE 是必填; 对 GET 是可选 (会全部 list)
  const needScopeRef = req.method !== 'GET';
  if (needScopeRef && (!scopeRef || scopeRef.length > 255)) {
    res.status(400).json({ error: 'invalid_scope_ref', got: scopeRef });
    return null;
  }
  return { kind, scopeRef };
}

export function createSystemAlertsRouter({ db, requireAuth, requirePerm, logger }) {
  const auth = [requireAuth, requirePerm('admin:users')];
  const r = {
    // ----------------------------------------------------------
    // GET /api/admin/system-alerts?state=firing&kind=heartbeat_offline
    // 默认 list current firing. UI 当前告警 tab.
    // ----------------------------------------------------------
    async listCurrent(req, res) {
      try {
        const state = req.query.state === 'recovered' || req.query.state === 'acked' || req.query.state === 'firing'
          ? req.query.state : 'firing';
        const kind = (typeof req.query.kind === 'string' && req.query.kind.trim()) ? req.query.kind.trim() : null;
        const scopeRef = (typeof req.query.scope_ref === 'string' && req.query.scope_ref.trim()) ? req.query.scope_ref.trim() : null;
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
        const fn = db.sql.systemAlerts[state === 'firing' ? 'listFiring' : 'listRecent'];
        const sqlText = typeof fn === 'function' ? fn({ kind, scope_ref: scopeRef, limit }) : fn;
        const params = [];
        if (state === 'firing' && kind) params.push(kind);
        if (state === 'firing' && scopeRef) params.push(scopeRef);
        if (typeof fn !== 'function' && kind) params.push(kind);
        const { rows } = await db.query(sqlText, params);
        res.json({ items: rows, count: rows.length, state, kind });
      } catch (e) {
        logger.error({ err: e?.message, stack: e?.stack }, 'system-alerts listCurrent failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // GET /api/admin/system-alerts/recent?limit=100&kind=...
    // 历史告警 (含 recovered/acked).
    // ----------------------------------------------------------
    async listRecent(req, res) {
      try {
        const kind = (typeof req.query.kind === 'string' && req.query.kind.trim()) ? req.query.kind.trim() : null;
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
        const fn = db.sql.systemAlerts.listRecent;
        const sqlText = typeof fn === 'function' ? fn({ kind, limit }) : fn;
        const params = typeof fn === 'function' ? [] : (kind ? [kind] : []);
        const { rows } = await db.query(sqlText, params);
        res.json({ items: rows, count: rows.length });
      } catch (e) {
        logger.error({ err: e?.message }, 'system-alerts listRecent failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // GET /api/admin/system-alerts/kpi
    // 顶部 KPI bar: firing_count / last_24h_count / acked_count
    // ----------------------------------------------------------
    async getKpi(req, res) {
      try {
        const { rows } = await db.query(db.sql.systemAlerts.countKpi);
        // R158.X.116.m — fallback 跟 helper 的 4 字段对齐 (补 recovered_24h_count)。
        //   空表时 SUM() 返 NULL 而非 0, 前端 `?? '-'` 会把 NULL 显成 '-' ——
        //   所以这里统一 Number() 归零, 让"确实 0 条"和"没数据"视觉可区分。
        const raw = rows[0] || {};
        res.json({
          firing_count: Number(raw.firing_count) || 0,
          last_24h_count: Number(raw.last_24h_count) || 0,
          recovered_24h_count: Number(raw.recovered_24h_count) || 0,
          acked_count: Number(raw.acked_count) || 0
        });
      } catch (e) {
        logger.error({ err: e?.message }, 'system-alerts getKpi failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // GET /api/admin/system-alerts/config
    // 读 7 个 system_config 阈值/收件人/interval
    // ----------------------------------------------------------
    async getConfig(req, res) {
      try {
        const cfg = await getSystemConfig();
        const out = {};
        for (const k of CONFIG_KEYS) {
          out[k] = cfg?.[k] ?? null;
        }
        res.json({ config: out });
      } catch (e) {
        logger.error({ err: e?.message }, 'system-alerts getConfig failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // PUT /api/admin/system-alerts/config
    // body: { system_alert_heartbeat_offline_minutes: 10, system_alert_to: 'ops@x.com', ... }
    // 走 system_config write-through (跟 R158.61 reports config 同一机制)
    // ----------------------------------------------------------
    async putConfig(req, res) {
      const body = req.body || {};
      // 校验: 未知 key 拒绝 (避免误改其他 config)
      const updates = {};
      for (const [k, v] of Object.entries(body)) {
        if (!CONFIG_KEYS.includes(k)) {
          return res.status(400).json({ error: 'unknown_key', key: k, allowed: CONFIG_KEYS });
        }
        if (INT_KEYS.has(k)) {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'invalid_int', key: k, value: v });
          }
          updates[k] = String(Math.floor(n));
        } else {
          updates[k] = String(v ?? '').trim();
        }
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'no_updates' });
      }
      try {
        const dbConn = db;
        for (const [k, v] of Object.entries(updates)) {
          // R158.68.6 (2026-10-10) — fix dormant schema drift. system_config 真列
          //   config_key/config_value/description/updated_at/updated_by (R158.42 schema freeze),
          //   旧 plan 写 [key]/value/value_type/default_value/description 错 (R158.42-rebase 时已改).
          //   R158.68.3 修过 1.0.6 baseline INSERT, 但漏修 putConfig UPSERT → 点保存
          //   抛 "Invalid column name 'key'" 500. Mirrors os-baseline-metrics.js R158.68 fix.
          const checkSql = db.dialect === 'mssql'
            ? `SELECT TOP 1 1 FROM system_config WHERE config_key = ?`
            : `SELECT 1 FROM system_config WHERE config_key = ? LIMIT 1`;
          const { rows: exists } = await dbConn.query(checkSql, [k]);
          if (exists.length > 0) {
            const updSql = db.dialect === 'mssql'
              ? `UPDATE system_config SET config_value = ?, updated_at = SYSUTCDATETIME() WHERE config_key = ?`
              : `UPDATE system_config SET config_value = ?, updated_at = UTC_TIMESTAMP(3) WHERE config_key = ?`;
            await dbConn.execute(updSql, [v, k]);
          } else {
            const insSql = db.dialect === 'mssql'
              ? `INSERT INTO system_config (config_key, config_value, description, updated_at) VALUES (?, ?, '', SYSUTCDATETIME())`
              : `INSERT INTO system_config (config_key, config_value, description, updated_at) VALUES (?, ?, '', UTC_TIMESTAMP(3))`;
            await dbConn.execute(insSql, [k, v]);
          }
        }
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'update_system_alert_config',
          target: 'system_alert',
          payload: { keys: Object.keys(updates), updates },
          logger
        });
        res.json({ ok: true, updated: Object.keys(updates) });
      } catch (e) {
        logger.error({ err: e?.message, stack: e?.stack }, 'system-alerts putConfig failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // POST /api/admin/system-alerts/:id/ack
    // operator 手动 ack 一条 firing. body { by: 'admin' } 可选.
    // ----------------------------------------------------------
    async ack(req, res) {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const ackedBy = (req.body?.by || req.user?.sub || 'operator').toString().slice(0, 64);
      try {
        const { affectedRows } = await db.execute(db.sql.systemAlerts.markAcked, [ackedBy, id]);
        if (affectedRows === 0) {
          // 可能是 id 不存在, 或 state != 'firing'
          const { rows } = await db.query(
            db.dialect === 'mssql'
              ? `SELECT TOP 1 id, state FROM system_alerts WHERE id = ?`
              : `SELECT id, state FROM system_alerts WHERE id = ? LIMIT 1`,
            [id]
          );
          if (rows.length === 0) return res.status(404).json({ error: 'alert_not_found' });
          return res.status(400).json({ error: 'not_firing', current_state: rows[0].state });
        }
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'ack_system_alert',
          target: String(id),
          payload: { acked_by: ackedBy },
          logger
        });
        res.json({ ok: true, id, acked_at: new Date().toISOString(), acked_by: ackedBy });
      } catch (e) {
        logger.error({ err: e?.message, stack: e?.stack }, 'system-alerts ack failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // R158.Suppression (2026-10-15) — 操作员行级暂停告警.
    //   PUT  /api/admin/system-alerts/suppressions?kind=&scope_ref=  upsert
    //   body: { reason?: string } (≤ 500 字符截断, NULL = 无备注)
    //   DELETE /api/admin/system-alerts/suppressions?kind=&scope_ref=  解除
    //   GET  /api/admin/system-alerts/suppressions?kind=&limit=  list 当前生效
    //
    // 3 handler 形状 100% 仿 ack() + putConfig() — 验参 → db.execute → writeAudit
    // → res.json. 永久抑制 (expires_at NULL); 想恢复 DELETE 即可.
    //
    // 校验 scope_ref 长度: NVARCHAR(255) 限, encodeURIComponent 必解码才能存真字符 (例
    //   "DC-A → DC-B" 的 '→' 是 unicode U+2192, 4 字节 UTF8 — 比 255 短, 通过).
    //
    // R158.Suppression.1 (2026-10-15) — validateKindScopeParams 必须 module-level 顶层
    //   函数, 不能挂在 `r = { ... }` 字典当方法. Express 调 handler 时 `this === req`
    //   (router bind 上下文), 不是 handler 字典, `this.validateKindScopeParams(...)` →
    //   TypeError: not a function → 500 一切. 3 端点全炸. 修法提到工厂外顶层 fn.
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // GET /api/admin/system-alerts/suppressions?kind=...&limit=500
    // list 当前生效抑制 (expire 没过期或永久). 给 UI 端按钮态用.
    // ----------------------------------------------------------
    async listSuppressions(req, res) {
      const params = validateKindScopeParams(req, res);
      if (!params) return;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 500));
      try {
        const fn = db.sql.systemAlertSuppressions.listActiveByKind;
        const sqlText = typeof fn === 'function' ? fn({ kind: params.kind, limit }) : fn;
        const { rows } = await db.query(sqlText, params.kind ? [params.kind] : []);
        res.json({ items: rows, count: rows.length, kind: params.kind });
      } catch (e) {
        logger.error({ err: e?.message, stack: e?.stack }, 'system-alerts listSuppressions failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // PUT /api/admin/system-alerts/suppressions?kind=&scope_ref=
    // body: { reason?: string }. 永久 (expires_at NULL). UI 端暂不传 expires_at.
    //   upsert 走 MERGE (mssql) / ON DUPLICATE KEY (mysql) — 单 statement 原子.
    // ----------------------------------------------------------
    async putSuppression(req, res) {
      const params = validateKindScopeParams(req, res);
      if (!params) return;
      const reasonRaw = (typeof req.body?.reason === 'string') ? req.body.reason.trim() : '';
      const reason = reasonRaw ? reasonRaw.slice(0, 500) : null;
      const setBy = (req.user?.sub || 'operator').toString().slice(0, 64);
      try {
        await db.execute(
          db.sql.systemAlertSuppressions.upsert,
          [params.kind, params.scopeRef, reason, setBy]
        );
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'suppress_replication_alert',
          target: `${params.kind}:${params.scopeRef}`,
          payload: { reason, set_by: setBy, expires_at: null },
          logger
        });
        res.json({
          ok: true,
          kind: params.kind,
          scope_ref: params.scopeRef,
          reason,
          set_by: setBy,
          set_at: new Date().toISOString(),
          expires_at: null
        });
      } catch (e) {
        logger.error({ err: e?.message, stack: e?.stack }, 'system-alerts putSuppression failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    },

    // ----------------------------------------------------------
    // DELETE /api/admin/system-alerts/suppressions?kind=&scope_ref=
    // 解除抑制 (操作员主动恢复). 0 行也算成功 (幂等).
    // ----------------------------------------------------------
    async deleteSuppression(req, res) {
      const params = validateKindScopeParams(req, res);
      if (!params) return;
      const setBy = (req.user?.sub || 'operator').toString().slice(0, 64);
      try {
        // R158.X lesson: mssql `Number(affectedRows ?? rowsAffected?.[0] ?? 0)` 真相 — 兜底返 0.
        //   mysql driver 返 result.affectedRows (number); mssql driver 返 result.rowsAffected[0]
        //   (object 包). 1 行兼容写法兼容两端, 0 行也返 0 (DELETE 未命中不算错).
        const result = await db.execute(
          db.sql.systemAlertSuppressions.remove,
          [params.kind, params.scopeRef]
        );
        const removed = Number(result?.affectedRows ?? result?.rowsAffected?.[0] ?? 0) > 0;
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'unsuppress_replication_alert',
          target: `${params.kind}:${params.scopeRef}`,
          payload: { removed, set_by: setBy },
          logger
        });
        res.json({ ok: true, kind: params.kind, scope_ref: params.scopeRef, removed });
      } catch (e) {
        logger.error({ err: e?.message, stack: e?.stack }, 'system-alerts deleteSuppression failed');
        res.status(500).json({ error: 'internal', detail: e?.message });
      }
    }
  };

  // 挂载到 express router
  const router = Router();
  router.get('/api/admin/system-alerts', ...auth, r.listCurrent);
  router.get('/api/admin/system-alerts/recent', ...auth, r.listRecent);
  router.get('/api/admin/system-alerts/kpi', ...auth, r.getKpi);
  router.get('/api/admin/system-alerts/config', ...auth, r.getConfig);
  router.put('/api/admin/system-alerts/config', ...auth, r.putConfig);
  router.post('/api/admin/system-alerts/:id/ack', ...auth, r.ack);
  // R158.Suppression — 3 新端点 平行挂载, 跟 ack() 同 auth chain. 路由顺序: GET/PUT/DELETE
  //   独立 path, 跟 :id/ack 无冲突 (PUT/DELETE query 是 kind+scope_ref 不带 :id).
  router.get('/api/admin/system-alerts/suppressions', ...auth, r.listSuppressions);
  router.put('/api/admin/system-alerts/suppressions', ...auth, r.putSuppression);
  router.delete('/api/admin/system-alerts/suppressions', ...auth, r.deleteSuppression);
  return router;
}
