// R114 — admin system-settings endpoint for probe cadence override.
//
// Spec: docs/superpowers/specs/2026-09-26-r114-centre-remote-port-probe-design.md §4.4
//
// Two endpoints (same path, different verb) for runtime-configurable cadence:
//
//   GET  /api/admin/system-settings/r114_probe_interval_ms
//        -> { key: 'r114_probe_interval_ms', value: <ms|60000> }
//
//   PUT  /api/admin/system-settings/r114_probe_interval_ms
//        body: { value: <ms in [5000, 3_600_000]> }
//        -> 200 { key, value } | 400 { error: 'invalid_value', detail }
//
// Range is enforced server-side so a bad payload can't crash the scheduler
// (clamp-on-read in the scheduler would silently swallow the bad input —
// better to reject loudly at the write boundary).
//
// The path is hard-coded to a single key. Adding more settings later means
// either widening this router with new routes OR moving to a generic
// /api/admin/system-settings/:key path with a key allowlist. For v1 we
// ship the narrow shape per spec §4.4.
//
// Auth shape mirrors center/src/routes/admin.js (userAuth({ db, logger }) +
// requirePerm('admin:config')) — the router factory accepts { db, logger, config }
// and db is captured in the closure for use inside handlers (the same
// pattern admin.js uses; userAuth middleware does NOT expose db on req).

import express from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { getDb } from '../db/index.js';

const KEY = 'r114_probe_interval_ms';
const MIN_MS = 5_000;
const MAX_MS = 3_600_000;
const DEFAULT_MS = 60_000;

export function systemSettingsRouter({ config, logger, db }) {
  const router = express.Router();
  const _db = db ?? getDb();

  // Both endpoints require an authenticated admin user with config-level
  // permission (matches admin.js's auth chain for /api/admin/config/*).
  // The auth chain is path-scoped to /api/admin/system-settings so this
  // router no longer acts as a blanket GET 401 for any un-claimed path
  // (pre-fix `router.use(userAuth)` had the same global-interceptor
  // shape as eventlogRouter / osBaselineRouter — see those for the
  // exact failure mode).
  router.use('/api/admin/system-settings', userAuth({ db: _db, logger }));
  router.use('/api/admin/system-settings', requirePerm('admin:config'));

  // ⚠ 这里**曾经**有一行 catch-all 404:
  //     router.use('/api/admin/system-settings', (req,res) => res.status(404)...)
  //   它让本 router 的 GET/PUT handler 永久 404 —— `router.use(path, h)`
  //   匹配该前缀下所有 method + 所有子路径且按注册顺序执行, catch-all
  //   注册在下面的 router.get 之前. 原注释担心的"吞掉兄弟 router"确实成立,
  //   但代价是把自己的 handler 也全吞了 —— eventlog.js:66-77 (R126) 已给出
  //   正确结论: 删掉 catch-all, Express 默认 404 兜底, SPA fallback 排除
  //   /api/* 所以不会返回 index.html.
  //   详见 rollout.js 同位置的完整分析 (同一个 bug 的两处副本).

  router.get(`/api/admin/system-settings/${KEY}`, async (req, res) => {
    try {
      const r = await _db.execute(_db.sql.systemSettings.get, [KEY]);
      const raw = r.rows?.[0]?.setting_value;
      const value = Number(raw);
      // Sanity: if the row exists but is malformed, fall back to default.
      // We still return 200 because the default IS a valid response shape.
      const safeValue = Number.isFinite(value) && value >= MIN_MS && value <= MAX_MS
        ? value
        : DEFAULT_MS;
      res.json({ key: KEY, value: safeValue });
    } catch (e) {
      logger?.error?.({ event: 'system_settings.get.fail', key: KEY, err: e.message }, 'failed to read system_settings row');
      // system_settings table might not exist (migration not yet run).
      // Treat as "default applied" so the UI never sees a hard error.
      res.json({ key: KEY, value: DEFAULT_MS });
    }
  });

  router.put(`/api/admin/system-settings/${KEY}`, async (req, res) => {
    const raw = req.body?.value;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
      return res.status(400).json({
        error: 'invalid_value',
        detail: `必须在 ${MIN_MS}-${MAX_MS} ms 之间`
      });
    }
    try {
      await _db.execute(_db.sql.systemSettings.upsert, [KEY, String(ms)]);
      res.json({ key: KEY, value: ms });
    } catch (e) {
      logger?.error?.({ event: 'system_settings.put.fail', key: KEY, err: e.message }, 'failed to write system_settings row');
      // If the table doesn't exist (e.g. fresh install + migration not yet
      // applied), surface 503 so the operator knows to run migrations —
      // don't silently swallow it like the GET path does.
      if (/InvalidObjectName|doesn't exist|does not exist/i.test(e.message || '')) {
        return res.status(503).json({
          error: 'system_settings_not_available',
          detail: 'system_settings table missing — apply migrations 028 first'
        });
      }
      res.status(500).json({ error: 'internal', detail: e.message });
    }
  });

  return router;
}