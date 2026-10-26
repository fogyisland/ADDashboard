// Member-server CRUD + per-host package bind + agent self-register.
//
// Mounts on webApp under /api/admin/member-servers/* (Task 6 of the
// non-AD server management plan, spec §4.3). Lives in a dedicated
// memberRouter per the design's no-cross-pollination rule with the DC
// agent routes.
//
// Routes:
//   GET    /api/admin/member-servers                       (list)
//   GET    /api/admin/member-servers/:hostname             (detail, 404 on miss)
//   POST   /api/admin/member-servers                       (manual entry)
//   PUT    /api/admin/member-servers/:hostname             (partial update)
//   DELETE /api/admin/member-servers/:hostname             (drop; FK cascade clears packages/group_members)
//     R158.X.115: 该端点**保留但不再用于下线**。agent 每 30min 重发
//     self-register → 删掉的行会自己回来; 下线请改用 :hostname/decommission。
//   GET    /api/admin/member-servers/:hostname/packages    (list per-host packages)
//   PUT    /api/admin/member-servers/:hostname/packages/:package_name  (toggle enabled)
//   DELETE /api/admin/member-servers/:hostname/packages/:package_name
//           - for ad-os-baseline: audit disable_builtin_ad_os_baseline BEFORE the DELETE
//           - other packages: DELETE only
//   POST   /api/admin/member-servers/self-register          (agent_token; upsert discovered_via='self-register')
//   GET    /api/admin/member-servers/ports                  (R158.74 — list all biz-ports)
//   GET    /api/admin/member-servers/:hostname/lifecycle-preview
//           (R158.X.115 — 下线前影响预览: 保留的历史条数 + 前置操作步骤)
//   POST   /api/admin/member-servers/:hostname/pause-monitoring
//           (R158.X.115 — 暂停管控, 临时态, 手动恢复, 无自动到期)
//   POST   /api/admin/member-servers/:hostname/resume-monitoring
//           (R158.X.115 — 恢复管控; 已退役则 409)
//   POST   /api/admin/member-servers/:hostname/decommission
//           (R158.X.115 — 退役下线, 终态不可逆; 物理 0 删除)
//   GET    /api/admin/member-servers/ports/:hostname        (R158.74 — list by host)
//   POST   /api/admin/member-servers/ports                  (R158.74 — upsert biz-port)
//   PUT    /api/admin/member-servers/ports/:hostname/:port   (R158.74 — update note)
//   DELETE /api/admin/member-servers/ports/:hostname/:port   (R158.74 — delete one)
//   DELETE /api/admin/member-servers/ports/by-host/:hostname (R158.74 — delete all for host)
//
// R158.68 (2026-10-10) — 删 5 个 alert-rules CRUD 端点 + 2 个 alert-related
//   端点 (hostname/alerts + hostname/baseline). 旧 alert 全套被 system_alerts
//   内置告警替代, 路由迁到 routes/system-alerts.js.
//
// Auth: admin routes use [userAuth, requirePerm('admin:users')] (matches
// all other admin routers). self-register uses [agentToken] — agents
// don't carry user JWTs.
//
// SQL access follows the project's canonical dialect-aware pattern: read
// db.sql.memberServers.<query> / db.sql.serverGroups.<query> — never
// hardcode `sql.mysql.foo` here.

import { Router } from 'express';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { agentToken } from '../auth/agent-token.js';
import { getDb } from '../db/index.js';
import { writeAudit } from '../services/audit.js';
// R158.X.115 (2026-10-20) — 主机生命周期 service: 退役(终态) / 暂停管控(临时态)。
//   注意跟上面这个 writeAudit 是两回事: 这里的 audit 由 service 内部调用。
import {
  decommissionHost, pauseHost, resumeHost, previewLifecycle, HostStatusError
} from '../services/host-status.js';
// R158.74 (2026-10-11) — MemberServer 业务端口 service (admin 手填).
//   跟 ad_member_servers 同 admin perm gate. 6 端点 append-only.
import * as memberServerPortsService from '../services/member-server-ports.js';

// Built-in package name. Disabling it on a per-host basis is allowed but
// audited so operators can see who pulled the safety net. Lives here (and
// only here) — Task 7+ refer to it via this constant.
const BUILTIN_AD_OS_BASELINE = 'ad-os-baseline';

// R158.112 (2026-10-16) — self-register 写 audit 守卫开关. 操作员 directive
//   "和 ad Server 一样即可。同一名字写一次就可以了". AD agent 走 heartbeat
//   路径 0 调 self-register 端点 (R100 改造), 自然 0 audit row; member-
//   server agent 每 30 min 重发 1 次 upsert (agent.js:1251-1257), 但 audit
//   只在 row 首次创建时写 1 行. upsert 仍跑 (R158 锁保留 30 min 重发, 用于
//   中心端 boot 晚起时 30 min 内可补注册), audit 由 SELF_REGISTER_AUDIT_DEDUP
//   守卫: findByHostname 返 row = 之前注册过 → 跳过 audit. 0 改 agent
//   binary, 0 改 audit-classifier.js, 0 改 wire shape.
const SELF_REGISTER_AUDIT_DEDUP_ENABLED = true;

// Standard DNS hostname check (RFC 952 / 1123, with Windows NetBIOS leeway).
// Labels are 1-63 chars of [a-zA-Z0-9-], not starting or ending in hyphen,
// separated by dots. Total length <= 253. Rejects reserved names that an
// attacker could try to claim to gain visibility or confuse operators
// ('localhost', 'localhost.localdomain'). C5 fix — see self-register route.
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
const RESERVED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);
function isValidHostname(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 253) return false;
  if (RESERVED_HOSTNAMES.has(s.toLowerCase())) return false;
  return HOSTNAME_RE.test(s);
}

export function memberRouter({ config, logger, db }) {
  const r = Router();
  // db is required (Task 5: userAuth reads token_version/status per request).
  // Lazy fallback to getDb() keeps test wirings that pre-date the new
  // signature working — every test that calls memberRouter already calls
  // _setDbForTest first.
  const _db = db ?? getDb();
  const auth = [userAuth({ db: _db, logger }), requirePerm('admin:users')];
  // I3: agentToken now resolves the bundle at request time via the db
  // facade (so a rotate+commit takes effect on the very next request).
  // Passing the old `config.agentToken` string would silently 503 every
  // request — Task 1 introduced this signature and Task 5 propagates it
  // to every caller. Use the same _db the userAuth middleware uses so a
  // test that pre-sets the db via memberRouter({ db }) keeps working.
  // `logger` is threaded in so a previous-token match emits the spec §5 warn.
  const agentMw = agentToken({ db: _db, logger });

  // ----- LIST -----
  r.get('/api/admin/member-servers', ...auth, async (_req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.memberServers.list);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'member-servers list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- R158.74 (2026-10-11) — MemberServer 业务端口 (ad_member_server_ports) -----
  //   admin perm gate 跟老端点一致. 业务类型 (file-server / web /
  //   database / app-server / custom) + 端口号 (1-65535) admin 手填.
  //   后续 NoAD agent push 时, 中心端可加 probe 状态字段 (Phase 3+).
  //
  // CRITICAL ORDERING: 这些固定路径路由 (ports / ports/:hostname / ...) 必须
  //   注册在 '/api/admin/member-servers/:hostname' 占位符路由 **之前**.
  //   Express 按注册顺序匹配, 不优先固定路径; 如果 line 86 LIST 之后直接到
  //   line 98 DETAIL (:hostname), 则 GET /ports 会先匹配到
  //   findByHostname('ports') → 0 row → 404 {"error":"not found"}, 而不是
  //   走到这里. R158.74.4 真因 = 路由顺序错.
  r.get('/api/admin/member-servers/ports', ...auth, async (_req, res) => {
    try {
      const db = getDb();
      const rows = await memberServerPortsService.listAll(db, logger);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'member-server-ports list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/admin/member-servers/ports/:hostname', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const rows = await memberServerPortsService.listByHostname(db, req.params.hostname, logger);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'member-server-ports by hostname failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/member-servers/ports', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const entry = memberServerPortsService.normalizeEntry(req.body || {});
      if (entry.error) return res.status(400).json({ error: entry.error });
      await memberServerPortsService.upsert(db, entry, logger);
      res.json({ ok: true, entry });
    } catch (e) {
      logger.error({ err: e }, 'member-server-ports upsert failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/member-servers/ports/:hostname/:port', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const port = Number(req.params.port);
      const entry = memberServerPortsService.normalizeEntry({
        hostname: req.params.hostname,
        port,
        service_type: req.body?.service_type,
        note: req.body?.note
      });
      if (entry.error) return res.status(400).json({ error: entry.error });
      await memberServerPortsService.upsert(db, entry, logger);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server-ports put failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/member-servers/ports/:hostname/:port', ...auth, async (req, res) => {
    try {
      const db = getDb();
      await memberServerPortsService.deleteByPk(db, req.params.hostname, Number(req.params.port), logger);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server-ports delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.delete('/api/admin/member-servers/ports/by-host/:hostname', ...auth, async (req, res) => {
    try {
      const db = getDb();
      await memberServerPortsService.deleteByHostname(db, req.params.hostname, logger);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server-ports delete-by-host failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.89 (2026-10-13) — member-port-probe cadence config (跟 R114
  //   r114_probe_interval_ms 1:1 平行 shape). GET 返当前生效值, PUT
  //   改 system_settings.member_port_probe_interval_ms (range [5000,
  //   3_600_000] ms, 跟 R114 1:1 平行). admin perm gate 跟 ports
  //   CRUD 同 shape, audit 写每次改值.
  r.get('/api/admin/member-servers/port-probe/cadence', ...auth, async (_req, res) => {
    try {
      const db = getDb();
      const r2 = await db.execute(db.sql.systemSettings.get, ['member_port_probe_interval_ms']);
      const raw = r2.rows?.[0]?.setting_value;
      const v = Number(raw);
      const valid = Number.isFinite(v) && v >= 5_000 && v <= 3_600_000;
      res.json({
        settingKey: 'member_port_probe_interval_ms',
        currentValueMs: valid ? v : 15 * 60_000,
        defaultValueMs: 15 * 60_000,
        minValueMs: 5_000,
        maxValueMs: 3_600_000,
        source: valid ? 'system_settings' : 'factory_default',
        rawValue: raw ?? null
      });
    } catch (e) {
      logger.error({ err: e.message }, 'member-port-probe cadence get failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.put('/api/admin/member-servers/port-probe/cadence', ...auth, async (req, res) => {
    const v = Number(req.body?.intervalMs);
    if (!Number.isFinite(v) || v < 5_000 || v > 3_600_000) {
      return res.status(400).json({
        error: 'intervalMs must be a number in [5000, 3600000]'
      });
    }
    try {
      const db = getDb();
      // R161.5 (2026-10-26) — systemSettings.upsert 只有 2 个占位符
      //   (VALUES (?, ?, UTC_TIMESTAMP())), 第 3 个参数 (new Date().toISOString())
      //   是多余的 —— 且 updated_at 由 DB 端算更权威 (本项目 UTC 单一约定)。
      //   参照 services/member-server-port-probe.js 的同类历史修复。
      await db.execute(db.sql.systemSettings.upsert, [
        'member_port_probe_interval_ms', String(v)
      ]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'set_member_port_probe_cadence',
        target: 'member_port_probe_interval_ms',
        payload: { intervalMs: v },
        logger
      });
      // 0 restart centre: scheduler 下 1 cycle 自动 re-arm (跟 R114 1:1 平行).
      res.json({ ok: true, intervalMs: v });
    } catch (e) {
      logger.error({ err: e.message }, 'member-port-probe cadence put failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DETAIL -----
  r.get('/api/admin/member-servers/:hostname', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.memberServers.findByHostname, [req.params.hostname]);
      if (rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (e) {
      logger.error({ err: e }, 'member-servers detail failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- MANUAL CREATE -----
  r.post('/api/admin/member-servers', ...auth, async (req, res) => {
    const { hostname, siteId = null, ipAddress = null, osVersion = null, enabled = 1 } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    if (!isValidHostname(hostname)) {
      return res.status(400).json({ error: 'hostname must match RFC 952/1123 (letters, digits, hyphens, dots; 1-253 chars; no reserved names)' });
    }
    try {
      const db = getDb();
      // discovered_via='admin' marks manual entries so the self-register
      // path won't overwrite site/os bindings on the next heartbeat.
      await db.execute(db.sql.memberServers.upsert, [
        hostname, siteId, ipAddress, osVersion, 'non-ad', enabled ? 1 : 0, 'admin'
      ]);
      await writeAudit({
        userId: req.user?.sub ?? null,
        action: 'create_member_server',
        target: hostname,
        payload: { hostname, siteId, ipAddress, osVersion, enabled: enabled ? 1 : 0, discoveredVia: 'admin' },
        logger
      });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-servers create failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PARTIAL UPDATE (site_id / ip_address / os_version / enabled) -----
  // Idiom follows admin.js sites-catalog updatePartial: build a dynamic SET
  // clause from whichever body fields were supplied; reject empty updates;
  // 404 if affectedRows === 0.
  r.put('/api/admin/member-servers/:hostname', ...auth, async (req, res) => {
    const { siteId, ipAddress, osVersion, enabled } = req.body || {};
    const fields = [];
    const params = [];
    if (siteId !== undefined)     { fields.push('site_id = ?');     params.push(siteId); }
    if (ipAddress !== undefined)  { fields.push('ip_address = ?');  params.push(ipAddress); }
    if (osVersion !== undefined)  { fields.push('os_version = ?');  params.push(osVersion); }
    if (enabled !== undefined)    { fields.push('enabled = ?');     params.push(enabled ? 1 : 0); }
    if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
    params.push(req.params.hostname);
    try {
      const db = getDb();
      // MSSQL updatePartial uses @pN placeholders (the db.execute wrapper
      // remaps ? -> @pN when the active dialect is mssql). Both dialects
      // share the same field-list contract.
      const { affectedRows } = await db.execute(
        `UPDATE ad_member_servers SET ${fields.join(', ')} WHERE hostname = ?`,
        params
      );
      if (affectedRows === 0) return res.status(404).json({ error: 'member server not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-servers update failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- DELETE (FK cascade clears packages / group_members) -----
  r.delete('/api/admin/member-servers/:hostname', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { affectedRows } = await db.execute(db.sql.memberServers.delete, [req.params.hostname]);
      if (affectedRows === 0) return res.status(404).json({ error: 'member server not found' });
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-servers delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // R158.X.115 (2026-10-20) — 主机生命周期: 退役下线 / 暂停管控
  // ══════════════════════════════════════════════════════════════════════
  // 跟上面 DELETE 的区别 (这是操作员最容易踩的坑, 值得写下来):
  //   DELETE  = 物理删除 + FK cascade 清历史 → agent 30min 后 self-register
  //             又把行建回来, 历史审计数据也没了。
  //   退役     = 打 decommissioned_at 时间戳 → 行留着, 历史全保留, 只是从
  //             在线视图和告警里排除。agent 残留上报也**不会**复活 (UPSERT
  //             保护见 db/sql/host-status.js)。
  // 三个动作共用 HostStatusError 的 code→status 映射, 路由层只做透传。

  // 生命周期端点共用的一段错误映射: service 抛 HostStatusError → HTTP status
  // + 结构化 body (前端弹窗直接展示 msg)。非 HostStatusError → 500。
  function lifecycleError(res, e, logger, action) {
    if (e instanceof HostStatusError) {
      // 409 (状态冲突) / 404 (主机不存在) 是**操作员可理解**的预期结果, 用
      // warn 而不是 error —— 否则正常的状态机拒绝会污染错误日志。
      logger.warn({ code: e.code, host: e.host }, `member-server ${action} rejected`);
      return res.status(e.status).json({ error: e.code, message: e.message });
    }
    logger.error({ err: e }, `member-servers ${action} failed`);
    return res.status(500).json({ error: 'internal' });
  }

  // ----- LIFECYCLE PREVIEW (下线前影响预览, 纯读) -----
  // 操作员点「下线」前先拿这个: 告诉 UI 要展示哪些历史数据会被保留、退役前
  // 必须先做哪几步。纯 SELECT, 不写任何东西, 所以无副作用地随便调。
  r.get('/api/admin/member-servers/:hostname/lifecycle-preview', ...auth, async (req, res) => {
    try {
      const data = await previewLifecycle({ kind: 'member', host: req.params.hostname }, logger);
      res.json(data);
    } catch (e) {
      lifecycleError(res, e, logger, 'lifecycle-preview');
    }
  });

  // ----- PAUSE MONITORING (暂停管控 — 临时态) -----
  // 用于突然下线的机器 (返修/送修/临时停用): 不再产生任何告警, 从在线视图
  // 消失, 但随时可以手动恢复。无自动到期 (operator directive 2026-10-20)。
  r.post('/api/admin/member-servers/:hostname/pause-monitoring', ...auth, async (req, res) => {
    try {
      const data = await pauseHost({
        kind: 'member',
        host: req.params.hostname,
        reason: req.body?.reason,
        userId: req.user?.sub ?? null
      }, logger);
      res.json(data);
    } catch (e) {
      lifecycleError(res, e, logger, 'pause-monitoring');
    }
  });

  // ----- RESUME MONITORING (恢复管控) -----
  // 仅对暂停态有效。已退役的机器不可恢复 → 409 (退役是终态)。
  r.post('/api/admin/member-servers/:hostname/resume-monitoring', ...auth, async (req, res) => {
    try {
      const data = await resumeHost({
        kind: 'member',
        host: req.params.hostname,
        reason: req.body?.reason,
        userId: req.user?.sub ?? null
      }, logger);
      res.json(data);
    } catch (e) {
      lifecycleError(res, e, logger, 'resume-monitoring');
    }
  });

  // ----- DECOMMISSION (退役下线 — 终态) -----
  // 需要确认: reason 可选, 但 UI 应该强制要求操作员勾选「已完成前置步骤」。
  r.post('/api/admin/member-servers/:hostname/decommission', ...auth, async (req, res) => {
    try {
      const data = await decommissionHost({
        kind: 'member',
        host: req.params.hostname,
        reason: req.body?.reason,
        userId: req.user?.sub ?? null
      }, logger);
      res.json(data);
    } catch (e) {
      lifecycleError(res, e, logger, 'decommission');
    }
  });

  // ----- PER-HOST PACKAGE LIST -----
  r.get('/api/admin/member-servers/:hostname/packages', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const { rows } = await db.query(db.sql.serverGroups.listPackagesForHost, [req.params.hostname]);
      res.json({ items: rows });
    } catch (e) {
      logger.error({ err: e }, 'member-server packages list failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST PACKAGE TOGGLE -----
  r.put('/api/admin/member-servers/:hostname/packages/:package_name', ...auth, async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    try {
      const db = getDb();
      // Upsert (insert if missing, otherwise update enabled) — same shape
      // as db.sql.serverGroups.upsertPackage so the call site stays clean.
      await db.execute(db.sql.serverGroups.upsertPackage, [
        req.params.hostname, req.params.package_name, enabled ? 1 : 0
      ]);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server package toggle failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ----- PER-HOST PACKAGE DELETE -----
  // Audit BEFORE the DELETE so an audit reader can always correlate a
  // disable_builtin_ad_os_baseline with the row that disappeared. If the
  // DELETE itself fails, the audit row still surfaces the operator's
  // intent (which is the more important fact for forensics).
  r.delete('/api/admin/member-servers/:hostname/packages/:package_name', ...auth, async (req, res) => {
    try {
      const db = getDb();
      if (req.params.package_name === BUILTIN_AD_OS_BASELINE) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'disable_builtin_ad_os_baseline',
          target: req.params.hostname,
          payload: { package: BUILTIN_AD_OS_BASELINE },
          logger
        });
      }
      await db.execute(db.sql.serverGroups.removePackage, [
        req.params.hostname, req.params.package_name
      ]);
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'member-server package delete failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.68 (2026-10-10) — 删 2 alert-related 端点 (hostname/alerts + hostname/baseline)
  //   + 5 alert-rules CRUD 端点 (list/create/delete/put/patch). 老 alert 全套
  //   (R158.62/63/67) 被 system_alerts 内置告警替代, 新端点走 routes/system-alerts.js.

  // ----- AGENT SELF-REGISTER -----
  // Gated by agentToken (NOT userAuth). Idempotent: upsert with
  // discovered_via='self-register'. enabled defaults to 1 so the new host
  // is immediately eligible for package binds.
  //
  // C5 fix: agent_token is a shared secret — anyone with the token can
  // currently claim ANY hostname in the body, then receive packages meant
  // for that host. Defense in depth: validate hostname against the standard
  // DNS naming rules (RFC 952 / 1123) before persisting. Hostname-shape
  // validation alone doesn't fully solve the shared-secret problem (a
  // rotated-token-still-shared scenario still allows impersonation of any
  // well-formed hostname), but it stops the cheap attacks — header injection,
  // claim of reserved names like 'admin'/'localhost'/'127.0.0.1', oversized
  // values, control characters — that an opportunistic attacker would try
  // first. Proper per-host tokens / mTLS / IP allowlist are a separate
  // design track; this is the floor.
  r.post('/api/admin/member-servers/self-register', agentMw, async (req, res) => {
    // R158.94 (2026-10-13) — installRoot 第 5 个 destructure 字段 (跟
    //   ipAddress/osVersion 1:1 平行). Agent 端 agent.js:1062-1067
    //   self-register body 加 installRoot: __dirname (derive 自运行时
    //   当前文件目录, 不写死).
    const { hostname, agentVersion, osVersion, ipAddress, installRoot } = req.body || {};
    if (!hostname) return res.status(400).json({ error: 'hostname required' });
    if (!isValidHostname(hostname)) {
      return res.status(400).json({
        error: 'hostname must match RFC 952/1123 (letters, digits, hyphens, dots; 1-253 chars; no reserved names)'
      });
    }
    try {
      const db = getDb();
      // R158.112 (2026-10-16) — 同 hostname 永远只写 1 次 self-register audit
      //   (操作员 directive "和 ad Server 一样即可。同一名字写一次就可以了").
      //   ad_member_servers.created_at schema DEFAULT CURRENT_TIMESTAMP 且
      //   upsert UPDATE 分支不更新 (sql/member-servers.js:47-73), 所以 row
      //   存在 = 之前注册过 (admin 路径 / 旧 self-register) → skipAudit=true.
      //   row 不存在 = 首次 INSERT → skipAudit=false → 写 1 行 audit. upsert
      //   照常跑 (R158 agent 30 min 重发 ip/osVersion/installRoot 仍需更新).
      //   0 改 agent binary (R158.88 锁), 0 改 wire shape, 0 新 SQL helper
      //   (复用既有 findByHostname helper).
      let skipAudit = false;
      if (SELF_REGISTER_AUDIT_DEDUP_ENABLED) {
        const existing = await db.query(db.sql.memberServers.findByHostname, [hostname]);
        if (existing.rows && existing.rows.length > 0) {
          skipAudit = true;
        }
      }
      // Param order (8): hostname, site_id(null), ip_address, os_version,
      //   agent_type('non-ad'), enabled(1), discovered_via('self-register'),
      //   install_root (8th, R158.94).
      // install_root 走 COALESCE 保护 (跟 site_id R158.86.5.2 precedent
      //   1:1) — admin 手动改的永远 win, agent 重发不覆盖. Agent 路径
      //   永远 null (它 0 admin UI).
      // agentVersion is accepted for future use (e.g. cap min-version
      // alert rules) but not persisted at registration time — the
      // heartbeat path is the source of truth for agentVersion.
      await db.execute(db.sql.memberServers.upsert, [
        hostname, null, ipAddress ?? null, osVersion ?? null, 'non-ad', 1, 'self-register',
        installRoot ?? null
      ]);
      if (!skipAudit) {
        await writeAudit({
          userId: null,
          action: 'agent_self_register',
          target: hostname,
          payload: { hostname, ipAddress: ipAddress ?? null, osVersion: osVersion ?? null, installRoot: installRoot ?? null },
          logger
        });
      }
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e, hostname }, 'member-servers self-register failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
