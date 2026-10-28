// R158.88.B (2026-10-13) — agent upgrade rollout orchestration router.
//
// 6 endpoints, mount 在 web app (跟 R158.87 system-settings precedent 1:1):
//   POST /api/admin/rollout                  — create draft → 立即 activate
//   GET  /api/admin/rollout                  — listAll (按 created_at DESC)
//   GET  /api/admin/rollout/:id              — getById
//   POST /api/admin/rollout/:id/pause        — strategy='paused' 熔断
//   POST /api/admin/rollout/:id/resume       — strategy 恢复
//   POST /api/admin/rollout/:id/abort        — strategy='aborted'
//   POST /api/admin/rollout/:id/rollback     — (R158.88.D) 写新 rollback row
//
// Auth chain 跟 R114 systemSettingsRouter 1:1 平行: userAuth + admin:config
// perm. R158.69.3 lesson 3 永远适用: 0 fleet 改, 0 fleet 升级, 0 改 R158.48
// fleet 端 upgrade-delivery.js. R158.86.6 enumerate 5 维度 lesson 1:1 闭合.

import express from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { getDb } from '../db/index.js';
import { buildSql } from '../db/sql.js';

const ALLOWED_STRATEGY = new Set(['full', 'canary', 'paused', 'completed', 'aborted']);
const ALLOWED_STATUS = new Set(['draft', 'active', 'paused', 'completed', 'aborted']);

// 两个 driver 的 execute() 契约统一是 `{ rows, affectedRows, insertId }`
// —— **永远不是裸数组** (mysql.js:125-126, mssql.js:276). 本文件此前 5 处
// 直接 `rows[0]` / `rows.length` / `for..of`, 于是:
//   :33  rows[0]           → undefined → strategy 恒 fallback 'full'
//                           (admin 设了 paused, agent 照样升级)
//   :144 rows.length === 0 → undefined === 0 = false → 跳过 404,
//                           紧接着 rows[0].target_version 抛 TypeError
//   :298 for (const r of active) → TypeError: active is not iterable
// 统一走这一个提取点, 别再各自 cast。
function toRows(result) {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

// R158.88.B — read live rollout gate (per-call, 0 cache). Mirrors
// computeUpgradeEnvelope's gate arg in routes/agent-upgrade.js:60-120.
// Falls back to { strategy: 'full', canaryRatio: 100 } when the feature
// flag row is missing or malformed — same conservative default as the
// helper in agent-upgrade.js (R158.88.A).
async function readRolloutGate(db) {
  try {
    const rows = toRows(await db.execute(db.sql.featureFlags.getByKey, ['agent_upgrade_rollout_strategy']));
    const strategy = rows[0] ? String(rows[0].value || 'full') : 'full';
    const ratioRows = toRows(await db.execute(db.sql.featureFlags.getByKey, ['agent_upgrade_canary_ratio']));
    const ratio = ratioRows[0] ? Number(ratioRows[0].value) : 100;
    return {
      strategy: ALLOWED_STRATEGY.has(strategy) ? strategy : 'full',
      canaryRatio: Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio)) : 100
    };
  } catch {
    return { strategy: 'full', canaryRatio: 100 };
  }
}

export function rolloutRouter({ config, logger, db }) {
  const router = express.Router();
  const _db = db ?? getDb();
  const _sql = buildSql(_db.dialect);

  // Path-scoped auth (跟 R158.87 systemSettingsRouter:49 1:1 平行).
  router.use('/api/admin/rollout', userAuth({ db: _db, logger }));
  router.use('/api/admin/rollout', requirePerm('admin:config'));
  // ⚠ 这里**曾经**有一行 catch-all 404:
  //     router.use('/api/admin/rollout', (_req, res) => res.status(404).json(...))
  //   它让本 router 全部 7 个 handler 永久 404. 原因: `router.use(path, h)`
  //   匹配该前缀下**所有 method + 所有子路径**, 且按注册顺序执行 ——
  //   catch-all 注册在下面的 router.post 之前, 所以每个请求都先被它吃掉.
  //   登录用户看到的全是 404, 而匿名探测被 userAuth 先拦成 401, 正好掩盖了它.
  //
  //   跟 eventlog.js:66-77 记录的 R126 是**同一个 bug**, 但那次是往好了修:
  //   结论是「不要加 catch-all」. 当时的注释被后来的人当成了要照抄的正确
  //   模式 (本文件原注释写的正是 "跟 systemSettingsRouter:59 1:1 平行"),
  //   结果把 bug 一起复制了 —— 而这两处本身也是坏的.
  //
  //   Express 默认 404 已经覆盖未匹配路径; src/app.js 的 SPA fallback 排除
  //   /api/*, 所以未匹配请求会落到下一个 mount 的 router, 不会返回 index.html.
  //   要点: 若将来要恢复「未匹配路径给 JSON 404 而不是 HTML」, 必须挂在
  //   全部 handler **之后**, 或者用精确路径匹配, 绝不能用前缀 use.

  // POST /api/admin/rollout — create draft → 立即 activate, 同步写
  //   ad_feature_flags 2 row (rolloutStrategy + canaryRatio). 跟
  //   R158.87 system-registration.js activate precedent 1:1 平行.
  router.post('/api/admin/rollout', async (req, res) => {
    try {
      const body = req.body || {};
      const targetVersion = String(body.targetVersion || '').trim();
      const fromVersion = body.fromVersion ? String(body.fromVersion).trim() : null;
      const strategy = String(body.strategy || 'full');
      const canaryRatio = Number.isFinite(Number(body.canaryRatio)) ? Math.max(0, Math.min(100, Number(body.canaryRatio))) : 100;
      const createdBy = String(body.createdBy || req.user?.username || 'admin');
      const notes = body.notes ? String(body.notes).slice(0, 500) : null;
      if (!targetVersion || targetVersion.length > 32) {
        return res.status(400).json({ error: 'invalid_target_version' });
      }
      if (!ALLOWED_STRATEGY.has(strategy) || strategy === 'completed' || strategy === 'aborted') {
        return res.status(400).json({ error: 'invalid_strategy', detail: strategy });
      }

      const insertedRes = await _db.execute(_sql.rollout.insert, [
        targetVersion, fromVersion, strategy,
        strategy === 'canary' ? canaryRatio : null,
        'active', createdBy, notes
      ]);
      // 两个 driver 都把 id 放在 `insertId` 上 (mssql 走 SCOPE_IDENTITY 追加的
      // `SELECT ... AS id`, mysql 走驱动的**原生** insertId —— 有绑定参数时
      // mysql.js 的 execute() 走 pool.execute() 预处理协议, OkPacket 自带
      // insertId) —— 见 mssql.js:263-274 / mysql.js:326-338。
      // R161.19 — mysql 侧 SQL 里原来还挂着 `; SELECT LAST_INSERT_ID() AS id;`,
      //   而连接是 multipleStatements:false ⇒ 两条语句 = ER_PARSE_ERROR(1064)
      //   ⇒ 这个 POST **必然 500**。已把尾部那条 SELECT 从 sql/rollout.js
      //   删掉, 改走原生 insertId。
      // 旧代码用 Array.isArray 判 inserted 是不是数组, 对
      // `{rows,affectedRows,insertId}` 恒 false → insertedId 恒 null →
      // **返回 500 但 INSERT 已提交**,
      // 操作员重试就堆重复行. 兼容 OUTPUT inserted 的双层 recordset 形态。
      const insertedRows = toRows(insertedRes);
      const insertedId = Number(
        insertedRes?.insertId
        ?? (Array.isArray(insertedRows[0]) ? insertedRows[0][0]?.id : insertedRows[0]?.id)
      ) || null;
      if (!insertedId) {
        return res.status(500).json({ error: 'insert_returned_no_id' });
      }

      // 同步 ad_feature_flags — computeUpgradeEnvelope (R158.88.A) per-call
      // 读这 2 row. 0 改 fleet 端. R158.86.5.2 lesson 1:1 平行 (COALESCE
      // preserve description, 4-th arg updated_by 永远传, 1-th 0 抹掉旧
      // description).
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_rollout_strategy', strategy, null, createdBy
      ]);
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_canary_ratio', String(canaryRatio), null, createdBy
      ]);

      logger?.info?.({
        event: 'rollout.created', id: insertedId, targetVersion, strategy, canaryRatio, createdBy
      }, 'rollout created and activated');
      res.status(201).json({ id: insertedId, targetVersion, strategy, canaryRatio, status: 'active' });
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.create.500' }, 'rollout create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/admin/rollout — listAll. limit 默认 100, max 500.
  router.get('/api/admin/rollout', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const rows = toRows(await _db.execute(_sql.rollout.listAll, [limit]));
      res.json({ count: rows.length, items: rows });
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.list.500' }, 'rollout list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/admin/rollout/:id — getById
  router.get('/api/admin/rollout/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const rows = toRows(await _db.execute(_sql.rollout.getById, [id]));
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      res.json(rows[0]);
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.get.500' }, 'rollout get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/admin/rollout/:id/pause — strategy='paused', status='paused'.
  //   写完同步 ad_feature_flags 1 row (R158.88.A 0 改 fleet 端 链路).
  router.post('/api/admin/rollout/:id/pause', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const updatedBy = String(req.user?.username || 'admin');
      await _db.execute(_sql.rollout.updateStrategy, [id, 'paused', 'paused', null]);
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_rollout_strategy', 'paused', null, updatedBy
      ]);
      logger?.warn?.({ event: 'rollout.paused', id, updatedBy }, 'rollout paused (kill-switch)');
      res.json({ id, strategy: 'paused', status: 'paused' });
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.pause.500' }, 'rollout pause failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/admin/rollout/:id/resume — 从 paused 恢复. 拿 rollout 之前
  //   strategy ('full' or 'canary') 写回, 同步 ad_feature_flags.
  router.post('/api/admin/rollout/:id/resume', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const rows = toRows(await _db.execute(_sql.rollout.getById, [id]));
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      const prev = rows[0];
      // canary 保留原 canaryRatio, full 不写 ratio. 跟 R158.88.A
      // computeUpgradeEnvelope gate 形参 1:1 平行.
      const resumeStrategy = prev.strategy === 'paused' ? 'full' : prev.strategy;
      const resumeRatio = prev.canary_ratio != null ? Number(prev.canary_ratio) : null;
      await _db.execute(_sql.rollout.updateStrategy, [id, resumeStrategy, 'active', resumeRatio]);
      const updatedBy = String(req.user?.username || 'admin');
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_rollout_strategy', resumeStrategy, null, updatedBy
      ]);
      if (resumeRatio != null) {
        await _db.execute(_sql.featureFlags.upsertValue, [
          'agent_upgrade_canary_ratio', String(resumeRatio), null, updatedBy
        ]);
      }
      logger?.info?.({ event: 'rollout.resumed', id, strategy: resumeStrategy, canaryRatio: resumeRatio, updatedBy }, 'rollout resumed');
      res.json({ id, strategy: resumeStrategy, status: 'active', canaryRatio: resumeRatio });
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.resume.500' }, 'rollout resume failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/admin/rollout/:id/abort — strategy='aborted'.
  router.post('/api/admin/rollout/:id/abort', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const updatedBy = String(req.user?.username || 'admin');
      await _db.execute(_sql.rollout.markAborted, [id]);
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_rollout_strategy', 'paused', null, updatedBy
      ]);
      logger?.warn?.({ event: 'rollout.aborted', id, updatedBy }, 'rollout aborted');
      res.json({ id, strategy: 'aborted', status: 'aborted' });
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.abort.500' }, 'rollout abort failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.88.D (2026-10-13) — POST /api/admin/rollout/:id/rollback.
  //   写新 rollback row (target_version = prev.from_version, from_version
  //   = prev.target_version, strategy = 'full') + 同步 ad_feature_flags
  //   rolloutStrategy='full' 让 computeUpgradeEnvelope 立刻返 full.
  //   0 改 agent 端 (复用 R158.48 链路). 注释原 rollout row 不改
  //   (status='paused' 留作 audit trail).
  router.post('/api/admin/rollout/:id/rollback', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' });
      }
      const rows = toRows(await _db.execute(_sql.rollout.getById, [id]));
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      const prev = rows[0];
      const fromVersion = String(prev.target_version || '').trim();
      const targetVersion = String(prev.from_version || '').trim();
      if (!targetVersion) {
        // 0 from_version = 0 真可回滚目标 (全新 rollout 还没 from), 拒.
        return res.status(400).json({ error: 'no_from_version_to_rollback_to' });
      }
      const updatedBy = String(req.user?.username || 'admin');
      const inserted2 = await _db.execute(_sql.rollout.insert, [
        targetVersion, fromVersion, 'full', null, 'active', updatedBy,
        `rollback of rollout #${id}`
      ]);
      const rows2 = toRows(inserted2);
      const newId = Number(
        inserted2?.insertId
        ?? (Array.isArray(rows2[0]) ? rows2[0][0]?.id : rows2[0]?.id)
      ) || null;
      // 原 row 改 paused (audit trail 留), 不删.
      await _db.execute(_sql.rollout.updateStrategy, [id, 'aborted', 'aborted', null]);
      // 同步 feature flag → 立刻 'full' 推 fleet.
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_rollout_strategy', 'full', null, updatedBy
      ]);
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_canary_ratio', '100', null, updatedBy
      ]);
      logger?.warn?.({
        event: 'rollout.rollback', oldId: id, newId, fromVersion, targetVersion, updatedBy
      }, 'rollout rolled back to previous version');
      res.status(201).json({ oldId: id, newId, targetVersion, fromVersion, strategy: 'full', status: 'active' });
    } catch (err) {
      logger?.error?.({ err: err.message, event: 'rollout.rollback.500' }, 'rollout rollback failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}

// R158.88.B — tickRolloutScheduler. */5 cadence (off :00/:30 health-check,
//   跟 R158.87.2 cron 5min race condition lesson 1:1 平行). 负责 canary →
//   full 自动晋升: active 状态 rollout 如果 target_version 跟 _agentUpgradeSource
//   version 一致 (跟中心 build-manifest 1:1), 跟 activated_at 距今 > 30min
//   (canary 观察期), 升 full. R158.87.2 lesson 关键: 5min cadence 必然
//   永远 0 跟 :00 :30 health-check 同时 tick. R158.69.3 lesson 3 永远适用:
//   0 fleet 改, 0 fleet 升级, 0 改 R158.48 fleet 端 upgrade-delivery.js.
export async function tickRolloutScheduler({ db, logger, getAgentUpgradeSource, intervalMinutes = 5 }) {
  const _db = db ?? getDb();
  const _sql = buildSql(_db.dialect);
  try {
    const source = typeof getAgentUpgradeSource === 'function' ? getAgentUpgradeSource() : null;
    if (!source || !source.available) return { checked: 0, advanced: 0 };
    const active = toRows(await _db.execute(_sql.rollout.listActive, []));
    let advanced = 0;
    for (const r of active) {
      if (r.strategy !== 'canary') continue;
      if (String(r.target_version) !== String(source.version)) continue;
      const activatedAt = r.activated_at ? new Date(r.activated_at).getTime() : 0;
      const elapsedMin = activatedAt > 0 ? (Date.now() - activatedAt) / 60000 : 0;
      if (elapsedMin < 30) continue;
      // canary → full 自动晋升
      await _db.execute(_sql.rollout.updateStrategy, [r.id, 'full', 'active', null]);
      await _db.execute(_sql.featureFlags.upsertValue, [
        'agent_upgrade_rollout_strategy', 'full', null, 'rollout-scheduler'
      ]);
      advanced += 1;
      logger?.info?.({
        event: 'rollout.scheduler.advanced', id: r.id, targetVersion: r.target_version, elapsedMin
      }, 'rollout canary advanced to full');
    }
    return { checked: active.length, advanced };
  } catch (err) {
    logger?.error?.({ err: err.message, event: 'rollout.scheduler.500' }, 'rollout scheduler tick failed');
    return { checked: 0, advanced: 0, error: err.message };
  }
}
