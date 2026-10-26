// center/src/routes/system-settings-v2.js
// R158.87 (2026-10-12) — system-settings 域 admin API: feature flags + license.
// 平行 ship 跟 routes/system-settings.js (R114 runtime settings) 完全隔离,
// 路径前缀 /api/admin/system-settings-v2/* 跟 R114 区分 (R158.78 平行 precedent:
// member-eventlog.js 跟 R112 eventlog.js 完全独立).
//
// 7 endpoint (R158.87):
//   GET    /api/admin/system-settings-v2/feature-flags             (admin:config) — 7 flag 列表
//   PUT    /api/admin/system-settings-v2/feature-flags             (admin:config) — UPSERT 多 key
//   GET    /api/admin/system-settings-v2/feature-flag-state/:key   (userAuth ONLY)   — 公开 boolean
//   GET    /api/admin/system-settings-v2/license                   (admin:config) — 当前 license 状态
//   POST   /api/admin/system-settings-v2/license/activate          (admin:config) — 录入 license
//   POST   /api/admin/system-settings-v2/license/deactivate        (admin:config) — 撤销 license
//   GET    /api/admin/system-settings-v2/license-status-public     (userAuth ONLY)   — 公开 boolean
//
// R158.License-config (2026-10-15) — 加 3 endpoint (admin:config) 配合"生产 license 申请单" ship:
//   GET    /api/admin/system-settings-v2/license/signature         (admin:config) — 返 appsettings signature + installedAt
//   GET    /api/admin/system-settings-v2/license/server-mac        (admin:config) — 返本机 MAC (os.networkInterfaces)
//   GET    /api/admin/system-settings-v2/license/export-request    (admin:config) — 返 JSON 申请单 (5 字段 + signature + instance_id)
//
// Auth contract:
//   - 8 endpoint (admin:config): admin 操作 + 配置, 走 requirePerm('admin:config')
//   - 2 endpoint (userAuth ONLY): sidebar gate 用, 任何登录 user 都可读, 失败 closed

import { Router } from 'express';
import { networkInterfaces } from 'node:os';
import { writeAudit } from '../services/audit.js';
import {
  validateLicenseFormat,
  sha256LicenseKey,
  computeInstanceId,
  validateLicenseRemote,
  readSignature,
  readInstalledAt,
  readInstanceId,
  buildLicenseRequest
} from '../services/license-validator.js';
import { loadConfigOrNull } from '../config.js';
// R158.AdminEmail (2026-10-15) — License 通知 service. fire-and-forget 调,
// 0 改既有 7 端点 + 3 端点 (R158.License-config). 0 触碰 agent.
import { enqueueLicenseNotify } from '../services/license-notify.js';
// R158.AdminEmail — setConfig / getConfig 走 audit trail, 0 改 config service.
import { setConfig, getConfig, getConfigMap } from '../services/config.js';
// R158.LA (2026-10-15) — 5 段 base32 license 闭环 service.
import { installPathFromConfigPath } from '../init/marker.js';
import { encodeLicenseCode, verifyLicenseCode } from '../services/license-codec.js';
import { saveLicenseRequest, loadLicenseRequest } from '../services/license-request-store.js';
import { licenseRequest as licenseRequestSql } from '../db/sql/license-request.js';

// mask license key 只返后 4 位 (e.g. "ADSPK-AAAA-BBBB-CCCC-DDDD" -> "*-DDDD")
function maskLicenseKey(key) {
  if (typeof key !== 'string' || key.length < 4) return '****';
  return `*-${key.slice(-4)}`;
}

// R158.LA (2026-10-15) — mask 5 段 base32 license code (5 段各 5 字符) -> 段 1 + *** + 段 5
//   例如 "RNNFR-A8KUA-FTMW7-DXHCB-HB9KA" -> "RNNFR-****-****-****-HB9KA"
//   跟 ADSPK mask 风格 1:1 平行, 0 暴露中间 3 段 (12 字节 cipher + 1 段 padding).
function maskBase32License(code) {
  if (typeof code !== 'string') return '****';
  const segs = code.split('-');
  if (segs.length !== 5) return '****';
  return `${segs[0]}-****-****-****-${segs[4]}`;
}

export function createSystemSettingsV2Router({ db, requireAuth, requirePerm, logger }) {
  const router = Router();
  const userAuth = requireAuth;
  const configPerm = requirePerm('admin:config');

  // 1. GET /feature-flags (admin:config) — 7 flag 列表
  router.get('/api/admin/system-settings-v2/feature-flags', userAuth, configPerm, async (req, res) => {
    try {
      const { rows } = await db.query(db.sql.featureFlags.listAll, []);
      res.json({ items: rows, count: rows.length });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 listFeatureFlags failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 2. PUT /feature-flags (admin:config) — UPSERT 多 key
  //    R158.86.5.2 lesson: COALESCE(?, existing) preserve description
  //    (R158.87 走 SQL helper MERGE 写, 端点不直接管 description 字段)
  router.put('/api/admin/system-settings-v2/feature-flags', userAuth, configPerm, async (req, res) => {
    try {
      const { flags } = req.body || {};
      if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
        return res.status(400).json({ error: 'flags must be object' });
      }
      const updatedBy = req.user?.sub ?? null;
      const updatedKeys = [];
      for (const [key, value] of Object.entries(flags)) {
        // R158.87 v1 简化: value 走 '1' / '0' 字符串 (跟 DDL seed 一致),
        // UI toggle 直接传 '0' / '1'. 不接 boolean / number.
        if (typeof value !== 'string') {
          return res.status(400).json({ error: 'flag_value_must_be_string', key });
        }
        if (key.length < 1 || key.length > 64) {
          return res.status(400).json({ error: 'flag_key_length_out_of_range', key });
        }
        // description 传 null = 走 SQL helper 的 COALESCE(?, existing) 保留老 description
        await db.execute(db.sql.featureFlags.upsertValue, [key, value, null, updatedBy]);
        updatedKeys.push(key);
      }
      await writeAudit({
        userId: updatedBy,
        action: 'update_feature_flags',
        target: 'feature_flags',
        payload: { keys: updatedKeys, updates: flags }
      }, logger);
      res.json({ ok: true, updated: updatedKeys.length, keys: updatedKeys });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 updateFeatureFlags failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 3. GET /feature-flag-state/:key (userAuth ONLY) — 公开 boolean, 给前端 sidebar gate
  router.get('/api/admin/system-settings-v2/feature-flag-state/:key', userAuth, async (req, res) => {
    try {
      const key = req.params.key;
      if (!key || key.length > 64) {
        return res.status(400).json({ error: 'invalid_key' });
      }
      const { rows } = await db.query(db.sql.featureFlags.getByKey, [key]);
      const enabled = rows[0]?.value === '1' || rows[0]?.value === 1;
      res.json({ key, enabled });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getFeatureFlagState failed');
      // fail-closed: 失败时返 enabled=false, 前端 sidebar 隐藏对应 group
      res.status(500).json({ key: req.params.key, enabled: false, error: 'internal' });
    }
  });

  // 4. GET /license (admin:config) — 当前 license 状态, license_key masked 后 4 位
  router.get('/api/admin/system-settings-v2/license', userAuth, configPerm, async (req, res) => {
    try {
      const instanceId = computeInstanceId();
      const { rows } = await db.query(db.sql.systemRegistration.getCurrent, []);
      if (!rows || rows.length === 0) {
        return res.json({
          has_license: false,
          status: null,
          activated_at: null,
          expires_at: null,
          instance_id: instanceId,
          license_key_masked: null
        });
      }
      const r = rows[0];
      res.json({
        has_license: true,
        status: r.status,
        activated_at: r.activated_at,
        expires_at: r.expires_at,
        instance_id: r.instance_id,
        license_key_masked: maskLicenseKey(r.license_key),
        notes: r.notes,
        id: r.id
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getLicense failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 5. POST /license/activate (admin:config) — 录入 license
  router.post('/api/admin/system-settings-v2/license/activate', userAuth, configPerm, async (req, res) => {
    try {
      const fmt = validateLicenseFormat(req.body?.license_key);
      if (!fmt.ok) {
        return res.status(400).json({ error: 'invalid_license_format', detail: fmt.error });
      }
      const hash = sha256LicenseKey(fmt.normalizedKey);
      const instanceId = computeInstanceId();
      const existing = await db.query(db.sql.systemRegistration.findByHash, [hash]);
      if (existing.rows?.length) {
        return res.status(409).json({ error: 'license_already_activated', existing_id: existing.rows[0].id });
      }
      // 撤销现有 active license (单一 active invariant: 跟 system_settings v1 single-row 同 precedent)
      await db.execute(db.sql.systemRegistration.deactivate, []);
      const remote = await validateLicenseRemote(hash);
      if (!remote.valid) {
        return res.status(400).json({ error: 'license_remote_rejected', detail: remote.detail ?? null });
      }
      const notes = (typeof req.body?.notes === 'string' && req.body.notes.trim())
        ? req.body.notes.trim().slice(0, 500) : null;
      const result = await db.execute(
        db.sql.systemRegistration.activate,
        [fmt.normalizedKey, hash, remote.expiresAt, instanceId, notes]
      );
      // R158.87 v1: 拿新行 id (mssql OUTPUT inserted.id / mysql insertId)
      const newId = result?.recordset?.[0]?.id || result?.insertId || null;
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'activate_license',
        target: 'license',
        // R158.87 lesson: audit payload 只写 hash_prefix (前 8 位) + instance_id, 不写完整 hash 也不写明文 key
        payload: { hash_prefix: hash.slice(0, 8), instance_id: instanceId, license_id: newId }
      }, logger);
      // R158.AdminEmail (2026-10-15) — license 激活成功后, fire-and-forget 发邮件
      // 通知 system_config.admin_email. void + 0 await, 0 阻塞 JSON 响应.
      // 收件人为空 (T-5 默认 '') 时 enqueueLicenseNotify 内部早返, 0 写 outbox.
      // 跟 ad-notify.js enqueueAdNotify 范式 1:1 平行.
      void enqueueLicenseNotify({
        kind: 'license_activated',
        payload: {
          licenseId: newId,
          hashPrefix: hash.slice(0, 8),
          expiresAt: remote.expiresAt,
          instanceId
        }
      });
      res.json({
        ok: true,
        license_status: 'active',
        activated_at: new Date().toISOString(),
        expires_at: remote.expiresAt,
        instance_id: instanceId,
        license_id: newId,
        license_key_masked: maskLicenseKey(fmt.normalizedKey)
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 activateLicense failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 6. POST /license/deactivate (admin:config) — 撤销 license
  router.post('/api/admin/system-settings-v2/license/deactivate', userAuth, configPerm, async (req, res) => {
    try {
      const instanceId = computeInstanceId();
      const result = await db.execute(db.sql.systemRegistration.deactivate, []);
      const affected = result?.rowsAffected?.[0] ?? result?.affectedRows ?? 0;
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'deactivate_license',
        target: 'license',
        payload: { instance_id: instanceId, revoked_count: affected }
      }, logger);
      res.json({ ok: true, revoked_count: affected });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 deactivateLicense failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 7. GET /license-status-public (userAuth ONLY) — 公开 boolean, 给前端 badge 用
  router.get('/api/admin/system-settings-v2/license-status-public', userAuth, async (req, res) => {
    try {
      const { rows } = await db.query(db.sql.systemRegistration.getCurrent, []);
      const hasLicense = !!(rows && rows.length > 0 && rows[0].status === 'active');
      res.json({ has_license: hasLicense });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getLicenseStatusPublic failed');
      // fail-closed: 失败时返 has_license=false, UI 显示 "未激活" (operator 知情)
      res.status(500).json({ has_license: false, error: 'internal' });
    }
  });

  // ==========================================================================
  // R158.License-config (2026-10-15) — 3 新端点 配合"生产 license 申请单" ship.
  // 0 改上面 R158.87 既有 7 端点 (R158.86.6 #5 wire shape preserve).
  // ==========================================================================

  // 8. GET /license/signature (admin:config) — 返 appsettings.json signature + installedAt.
  //    前端 LicenseView 申请单生成卡片 onMounted 时调一次展示 + prefill 表单.
  router.get('/api/admin/system-settings-v2/license/signature', userAuth, configPerm, async (req, res) => {
    try {
      // configPath 走 env / argv 跟 server.js 1:1 平行, 不重新解析.
      const configPath = process.env.APPSETTINGS_PATH || process.argv[2] || './appsettings.json';
      const signature = readSignature(configPath);
      const installedAt = readInstalledAt(configPath);
      res.json({
        signature,            // null if missing/invalid (前端展示 "未生成")
        installedAt,          // null if missing/invalid (前端展示 "未安装")
        hasSignature: signature !== null,
        hasInstalledAt: installedAt !== null
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getLicenseSignature failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 9. GET /license/server-mac (admin:config) — 返本机 MAC.
  //    os.networkInterfaces() 选 first non-internal + IPv4 mac (R158.License-config lesson #2).
  //    多网卡环境取错风险: 0 expose 完整列表, 取第一个; 前端展示具体值允许操作员手改.
  router.get('/api/admin/system-settings-v2/license/server-mac', userAuth, configPerm, async (_req, res) => {
    try {
      let mac = null;
      let allMacs = [];
      try {
        const nics = networkInterfaces();
        for (const name of Object.keys(nics)) {
          for (const info of nics[name] || []) {
            if (info.internal) continue;
            if (info.family !== 'IPv4') continue;
            if (!info.mac || info.mac === '00:00:00:00:00:00') continue;
            allMacs.push({ name, mac: info.mac });
            if (!mac) mac = info.mac;
          }
        }
      } catch (e) {
        // 0 抛, fallback 留空
        return res.json({ mac: null, allMacs: [], error: e.message });
      }
      res.json({ mac, allMacs });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getServerMac failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 10. GET /license/export-request (admin:config) — 返 JSON 申请单.
  //     query params: company / mac / months / maxNodes. 后端从 appsettings 读
  //     signature + installedAt, 加 instance_id, 拼成 7 字段 JSON 申请单.
  //     操作员复制发邮件 fogyisland_x@hotmail.com 换 license_key (下轮 R158.License-activation ship).
  //     R158.LA (2026-10-15) — 追加落盘 license-requests/<id>.json + 入库
  //     ad_license_request. response 0 改既有 request 字段, 仅追加 request_id + json_path.
  router.get('/api/admin/system-settings-v2/license/export-request', userAuth, configPerm, async (req, res) => {
    try {
      const { company, mac, months, maxNodes } = req.query || {};
      const monthsInt = Number.parseInt(months, 10);
      const maxNodesInt = Number.parseInt(maxNodes, 10);
      const configPath = process.env.APPSETTINGS_PATH || process.argv[2] || './appsettings.json';
      const installedAt = readInstalledAt(configPath);
      const signature = readSignature(configPath);
      const instanceId = readInstanceId();
      const result = buildLicenseRequest({
        company: typeof company === 'string' ? company : '',
        mac: typeof mac === 'string' ? mac : '',
        months: monthsInt,
        maxNodes: maxNodesInt,
        installedAt,
        signature,
        instanceId
      });
      if (!result.ok) {
        return res.status(400).json({ error: 'invalid_request', detail: result.error });
      }
      // R158.LA — 落盘 + 入库 (0 改既有 7 字段). fail-closed: 落盘 / 入库失败
      // → 500, 0 返 request 字段 (避免 operator 拿半截申请单发给 vendor).
      // request_id 走 ISO timestamp + 8 hex 跟 D:\verify 1:1 平行, 后续 verify
      // /activate 端点用 request_id 找落盘文件 + 喂 license-codec.
      const installPath = installPathFromConfigPath(configPath);
      const saved = saveLicenseRequest({ installPath, data: result.request });
      try {
        const { request_id, company: co, mac_address, months: mo, max_nodes, installed_at, signature: sig, instance_id } = result.request;
        const dialect = db.dialect;
        const r = await db.execute(
          db.sql.licenseRequest[dialect].insert,
          [request_id, co, mac_address, mo, max_nodes, installed_at, sig, instance_id, 'base32', saved.jsonPath]
        );
        const newId = r?.recordset?.[0]?.id || r?.insertId || null;
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'license_request_created',
          target: 'license_request',
          payload: { request_id, company: co, months: mo, max_nodes, instance_id, db_id: newId }
        }, logger);
      } catch (e) {
        // 入库失败不算致命 — JSON 已落盘, operator 拿到 request_id 就能走流程.
        // 但写一条 audit + log 供事后查.
        logger.warn({ err: e?.message, request_id: saved.requestId },
          'ad_license_request insert failed; JSON already on disk');
      }
      // R158.AdminEmail (2026-10-15) — license 申请单生成后 fire-and-forget 发邮件到 admin_email.
      // 0 await 永不 block 端点响应; admin_email 空时 enqueueLicenseNotify 内部早返 + audit skip.
      // 跟 R158.100.C enqueueAdNotify fire-and-forget 1:1 平行.
      void enqueueLicenseNotify({ kind: 'license_request', payload: result.request });
      res.json({
        ok: true,
        request: result.request,
        request_id: saved.requestId,
        json_path: saved.jsonPath
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 exportLicenseRequest failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 11. GET /admin-email (admin:config) — R158.AdminEmail (2026-10-15) — 读 system_config.admin_email.
  //     用于 SystemSettingsView 第 3 子 tab "管理员邮件" 配置页.
  //     wire shape: { value } — last-updated chrome 不必 (操作员每次保存立刻见新值, 0 必 audit 反射).
  //     audit 留痕 走 setConfig 内部 writeAudit('admin_email_update') 持久化在 sys_config_audit.
  router.get('/api/admin/system-settings-v2/admin-email', userAuth, configPerm, async (req, res) => {
    try {
      const cfg = await getConfig();
      const value = String(cfg?.admin_email || '').trim();
      res.json({ value });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getAdminEmail failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // ==========================================================================
  // R158.LA (2026-10-15) — 5 段 base32 License 闭环 (license-codec.js + license-request-store.js).
  //   E1 POST /license/base32/verify  (admin:config) — dry-run, 验 license code 真伪
  //   E2 POST /license/base32/activate (admin:config) — 验 + 写 ad_system_registration (kind='base32')
  //   0 改上面 R158.87/R158.License-config/R158.AdminEmail 既有 12 端点 (R158.86.6 #5 wire shape preserve).
  //   0 改 ADSPK 路径 (D7 + R158.69 0 改 fleet). 新表 ad_license_request + 既有表加 3 列走
  //   scripts/r158-LA-license-activation-ddl.js.
  // ==========================================================================

  // E1. POST /license/base32/verify (admin:config) — 验 license code 真伪, 0 写 DB.
  //     body: { license_code, request_id }. 流程: 1) request_id 找落盘 JSON 拿 (data, jsonPath)
  //     2) 调 verifyLicenseCode(code, data, jsonPath) → boolean 3) 返 valid + expires_at + masked
  router.post('/api/admin/system-settings-v2/license/base32/verify', userAuth, configPerm, async (req, res) => {
    try {
      const code = req.body?.license_code;
      const requestId = req.body?.request_id;
      if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/i.test(code)) {
        return res.status(400).json({ error: 'invalid_license_format' });
      }
      if (typeof requestId !== 'string' || !requestId) {
        return res.status(400).json({ error: 'invalid_request_id' });
      }
      const configPath = process.env.APPSETTINGS_PATH || process.argv[2] || './appsettings.json';
      const installPath = installPathFromConfigPath(configPath);
      let loaded;
      try {
        loaded = loadLicenseRequest({ installPath, requestId });
      } catch (e) {
        if (e.code === 'ENOENT') {
          return res.status(400).json({ error: 'invalid_request_id' });
        }
        throw e;
      }
      const { data, jsonPath } = loaded;
      const valid = verifyLicenseCode(code, data, jsonPath);
      if (!valid) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'license_verify_failed',
          target: 'license_base32',
          payload: { request_id: requestId, instance_id: data.instance_id, code_prefix: code.slice(0, 5) }
        }, logger);
      }
      // expires_at 推算: months * 30 天 (跟 ADSPK 端点 1:1 平行, 操作员 120 月上限)
      const monthsNum = Number(data.months) || 0;
      const expiresAt = new Date(Date.now() + monthsNum * 30 * 24 * 60 * 60 * 1000).toISOString();
      res.json({
        ok: true,
        valid,
        request_id: requestId,
        company: data.company ?? null,
        months: monthsNum,
        max_nodes: Number(data.max_nodes) || 0,
        expires_at: expiresAt,
        instance_id: data.instance_id ?? null,
        license_code_masked: maskBase32License(code)
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 verifyBase32License failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // E2. POST /license/base32/activate (admin:config) — 验 + 写 DB 闭环.
  //     body: { license_code, request_id, notes? }.
  //     流程: 1) verify → 不通过返 400 license_verify_failed (fail-closed, 0 写 DB)
  //     2) sha256(code) 查重 → 409 license_already_activated
  //     3) revoke 既有 active (单一 active invariant)
  //     4) INSERT ad_system_registration (kind='base32', license_key, hash, expires_at, instance_id, notes, license_request_id, request_json_path)
  //     5) ad_license_request.markActivated(requestId, newId)
  //     6) writeAudit + enqueueLicenseNotify
  router.post('/api/admin/system-settings-v2/license/base32/activate', userAuth, configPerm, async (req, res) => {
    try {
      const code = req.body?.license_code;
      const requestId = req.body?.request_id;
      if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/i.test(code)) {
        return res.status(400).json({ error: 'invalid_license_format' });
      }
      if (typeof requestId !== 'string' || !requestId) {
        return res.status(400).json({ error: 'invalid_request_id' });
      }
      const configPath = process.env.APPSETTINGS_PATH || process.argv[2] || './appsettings.json';
      const installPath = installPathFromConfigPath(configPath);
      let loaded;
      try {
        loaded = loadLicenseRequest({ installPath, requestId });
      } catch (e) {
        if (e.code === 'ENOENT') {
          return res.status(400).json({ error: 'invalid_request_id' });
        }
        throw e;
      }
      const { data, jsonPath } = loaded;
      const valid = verifyLicenseCode(code, data, jsonPath);
      if (!valid) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'license_verify_failed',
          target: 'license_base32',
          payload: { request_id: requestId, instance_id: data.instance_id, code_prefix: code.slice(0, 5) }
        }, logger);
        return res.status(400).json({ error: 'license_verify_failed' });
      }
      const hash = sha256LicenseKey(code);
      const existing = await db.query(db.sql.systemRegistration.findByHash, [hash]);
      if (existing.rows?.length) {
        return res.status(409).json({ error: 'license_already_activated', existing_id: existing.rows[0].id });
      }
      // 撤销现有 active (单一 active invariant, 跟 ADSPK 端点 1:1 平行)
      await db.execute(db.sql.systemRegistration.deactivate, []);
      const monthsNum = Number(data.months) || 0;
      const expiresAt = new Date(Date.now() + monthsNum * 30 * 24 * 60 * 60 * 1000).toISOString();
      const notes = (typeof req.body?.notes === 'string' && req.body.notes.trim())
        ? req.body.notes.trim().slice(0, 500) : null;
      // INSERT ad_system_registration (kind='base32'). 走 ad-hoc INSERT (新加 3 列), 0 改 SQL helper.
      const dialect = db.dialect;
      const insertSql = dialect === 'mssql'
        ? `INSERT INTO ad_system_registration
            (license_key, license_hash, expires_at, instance_id, notes, status, license_kind, license_request_id, request_json_path)
            OUTPUT inserted.id
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        : `INSERT INTO ad_system_registration
            (license_key, license_hash, expires_at, instance_id, notes, status, license_kind, license_request_id, request_json_path)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`;
      const r = await db.execute(insertSql, [
        code, hash, expiresAt, data.instance_id, notes,
        'base32', null, jsonPath
      ]);
      const newId = r?.recordset?.[0]?.id || r?.insertId || null;
      // markActivated: ad_license_request.activated_at + license_id 关联
      try {
        await db.execute(
          db.sql.licenseRequest[dialect].markActivated,
          [newId, requestId]
        );
      } catch (e) {
        logger.warn({ err: e?.message, request_id: requestId, license_id: newId },
          'ad_license_request.markActivated failed; activation succeeded but metadata not updated');
      }
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'activate_license_base32',
        target: 'license',
        payload: { hash_prefix: hash.slice(0, 8), request_id: requestId, instance_id: data.instance_id, license_id: newId, expires_at: expiresAt }
      }, logger);
      void enqueueLicenseNotify({
        kind: 'license_activated_base32',
        payload: {
          licenseId: newId,
          hashPrefix: hash.slice(0, 8),
          requestId,
          expiresAt,
          instanceId: data.instance_id
        }
      });
      res.json({
        ok: true,
        license_status: 'active',
        license_kind: 'base32',
        activated_at: new Date().toISOString(),
        expires_at: expiresAt,
        instance_id: data.instance_id,
        license_id: newId,
        license_key_masked: maskBase32License(code),
        request_id: requestId
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 activateBase32License failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 12. PUT /admin-email (admin:config) — R158.AdminEmail (2026-10-15) — 写 system_config.admin_email.
  //     body: { email }. 空字符串放行 (操作员主动清空), 非空走 regex 校验.
  //     走 setConfig 入口 (system_config 表 upsert + writeAudit 'admin_email_update').
  router.put('/api/admin/system-settings-v2/admin-email', userAuth, configPerm, async (req, res) => {
    try {
      const raw = req.body?.email;
      const email = (typeof raw === 'string') ? raw.trim() : '';
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'invalid_email', detail: '邮箱格式不正确' });
      }
      await setConfig('admin_email', email, req.user?.sub ?? null);
      res.json({ ok: true, value: email });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 updateAdminEmail failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  return router;
}
