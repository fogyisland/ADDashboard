// center/src/routes/system-settings-v2.js
// R158.87 (2026-10-12) — system-settings 域 admin API: feature flags + license.
// 平行 ship 跟 routes/system-settings.js (R114 runtime settings) 完全隔离,
// 路径前缀 /api/admin/system-settings-v2/* 跟 R114 区分 (R158.78 平行 precedent:
// member-eventlog.js 跟 R112 eventlog.js 完全独立).
//
// R158.87 (2026-10-12) — 3 endpoint:
//   GET    /api/admin/system-settings-v2/feature-flags             (admin:config) — 7 flag 列表
//   PUT    /api/admin/system-settings-v2/feature-flags             (admin:config) — UPSERT 多 key
//   GET    /api/admin/system-settings-v2/feature-flag-state/:key   (userAuth ONLY)   — 公开 boolean
//
// R158.LA-V1-delete (2026-10-15) — 删 4 ADSPK V1 老 license 端点 (GET /license,
//   POST /license/activate, POST /license/deactivate, GET /license-status-public).
//   V2 base32 (R158.LA) 闭环是当前生产路径, V1 ADSPK (4 段 XXXX-XXXX-XXXX-XXXX) bypass
//   remote server, 跟 V2 不互通. 删后 license 域只剩 7 endpoint (3 license-config +
//   2 base32 + 2 admin-email).
//
// R158.License-config (2026-10-15) — 3 endpoint (admin:config) 配合"生产 license 申请单" ship:
//   GET    /api/admin/system-settings-v2/license/signature         (admin:config) — 返 appsettings signature + installedAt
//   GET    /api/admin/system-settings-v2/license/server-mac        (admin:config) — 返本机 MAC (os.networkInterfaces)
//   GET    /api/admin/system-settings-v2/license/export-request    (admin:config) — 返 JSON 申请单 (5 字段 + signature + instance_id)
//
// R158.License-expiry (2026-10-15) — 加 1 endpoint 派生 license display status:
//   GET    /api/admin/system-settings-v2/license-state               (NO middleware, 公开) — license 状态派生
//   跟 R158.87 feature-flag-state 1:1 平行 shape, 但 license 必须登录前能查 (R158.103 precedent
//   /mcp/healthz 公开端点), 0 middleware. R158.103 教训: 严禁 app.use 顶级, 直接 router.get 完整 path.
//   fail-closed (D-8): DB 异常返 status='unknown', should_redirect=false.
//
// Auth contract (R158.License-expiry 11 endpoint 总):
//   - 8 endpoint (admin:config): admin 操作 + 配置, 走 requirePerm('admin:config')
//   - 1 endpoint (userAuth ONLY): sidebar gate 用, 任何登录 user 都可读, 失败 closed
//   - 1 endpoint (NO middleware, 公开): license-state, 任何 user 登录前/后都能查, fail-closed

import { Router } from 'express';
import { networkInterfaces } from 'node:os';
import { writeAudit } from '../services/audit.js';
import {
  sha256LicenseKey,
  readSignature,
  readInstalledAt,
  readInstanceId,
  buildLicenseRequest
} from '../services/license-validator.js';
import { loadConfigOrNull } from '../config.js';
// R158.X.117 (2026-10-26) — getPrimaryIPv4 拿服务器真实 IP.
//   MCP 接入端点的 IP 列要用**可访问**的地址, 不能是 bind 地址 0.0.0.0.
import { getPrimaryIPv4 } from '../utils/network.js';
// R158.AdminEmail (2026-10-15) — License 通知 service. fire-and-forget 调,
// 0 改既有 3 端点 (R158.87 feature-flags) + 3 端点 (R158.License-config). 0 触碰 agent.
import { enqueueLicenseNotify } from '../services/license-notify.js';
// R158.AdminEmail — setConfig / getConfig 走 audit trail, 0 改 config service.
import { setConfig, getConfig, getConfigMap } from '../services/config.js';
// R158.LA (2026-10-15) — 5 段 base32 license 闭环 service.
import { installPathFromConfigPath } from '../init/marker.js';
import { encodeLicenseCode, verifyLicenseCode } from '../services/license-codec.js';
import { saveLicenseRequest, loadLicenseRequest } from '../services/license-request-store.js';
import { licenseRequest as licenseRequestSql } from '../db/sql/license-request.js';
// R158.License-expiry (2026-10-15) — 派生 license display status (5 分支).
//   0 触碰 license-codec / license-validator / license-notify (R158.LA-V1-delete 锁定).
import { getLicenseState } from '../services/license-state.js';
// R158.X.99-quota (2026-10-21) — 1.2 倍宽限 policy 的单一真源 (applyHeadroom).
import { applyHeadroom } from '../services/license-quota.js';
// R161.5 (2026-10-26) — MySQL DATETIME 列绑 ISO 字符串 ⇒ ER 1292 的唯一出口.
//   本文件只有 expires_at 一处是 DATETIME 列 (installed_at 是 VARCHAR(32),
//   故意存 ISO, 不在此列)。
import { toMysqlDatetime } from '../utils/datetime.js';
// R161.11 (2026-10-26) — 时区单一真源 (显示时区 KV + 会话时钟探针 + IANA 校验).
import {
  DISPLAY_TIMEZONE_KEY,
  STORAGE_CONTRACT,
  isValidTimeZone,
  listSupportedTimeZones,
  normalizeDisplayTimeZone,
  offsetMinutesFor,
  readServerClock
} from '../services/timezone.js';

// R158.X.99.30.c (2026-10-19) — 本地时区 YYYY-MM-DD 纯日期 (0 必 toISOString UTC).
//   1:1 平行前端 formatYmd helper (LicenseView.vue). Node.js Date 跟浏览器 Date
//   都用系统本地时区 (getFullYear/getMonth/getDate), 0 受 UTC 偏移影响.
//   操作员 directive D4.a 锁: 0 是 UTC ("2026-10-19T05:13:08.711Z"), 必本地纯日期
//   (例 "2026-10-19", 0 时分秒). 0 复用 toLocaleString (走 zh-CN = "2026/10/19 13:13:08",
//   带时分秒, 跟 0 一致, 必新写). 0 必改 installed_at 列名 (D1 锁 preserved, 0 ALTER 列).
function toLocalYmd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// R158.LA (2026-10-15) — mask 5 段 base32 license code (5 段各 5 字符) -> 段 1 + *** + 段 5
//   例如 "RNNFR-A8KUA-FTMW7-DXHCB-HB9KA" -> "RNNFR-****-****-****-HB9KA"
//   0 暴露中间 3 段 (12 字节 cipher + 1 段 padding). V1 ADSPK mask 删 (R158.LA-V1-delete).
function maskBase32License(code) {
  if (typeof code !== 'string') return '****';
  const segs = code.split('-');
  if (segs.length !== 5) return '****';
  return `${segs[0]}-****-****-****-${segs[4]}`;
}

// R158.X.117 (2026-10-26) — 判定 "本机回环 / 不可路由" 的 host 字符串.
//
// 真因: 操作员在 MCP-TOKEN 界面看到的所有端点路径都是 localhost.
//   根因 2 处, 都在**后端** (前端 0 hard-code):
//   ① 域名列 = system_config.access_domain 的值 —— 操作员配成了 'localhost'.
//      localhost 对**跨机**的 MCP 客户端毫无意义 (客户端在自己机器上解析 localhost
//      = 客户端自己, 连不上 center).
//   ② IP 列 = http://<listen.host>:<port> —— listen.host 来自 appsettings.json
//      的 listen.host, 生产环境**没有** listen 段 ⇒ 该值是 '0.0.0.0'.
//      0.0.0.0 是 **bind 地址** ("监听所有网卡"), 不是可访问地址 —— 浏览器/客户端
//      连 http://0.0.0.0:8080 是连自己.
//      config.js:173-177 的注释自己写明了这一点: "浏览器访问要换 localhost 或具体 IP".
//      ⇒ R158.X.117 改为用 getPrimaryIPv4() (服务器真实 IP) 代替.
//
// 修法: 把这 2 类"本机地址"当作**未配置**处理, 统一回落到服务器真实 IP
//   (getPrimaryIPv4(), 本机实测 = 10.170.140.23).
//
// 判据用**精确匹配**而不是模糊 includes ——
//   'localhost' / '127.0.0.1' / '::1' / '0.0.0.0' / '0' 视为本机;
//   'mylocalhost.example.com' / '127.0.0.1.nip.io' 这类**含**回环串但实际
//   可路由的域名必须**保留** (includes 判据会把它们误杀).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '0', '[::1]']);

// host 可能带 port (access_domain 允许 'host:port' 形态, 见 PUT 端点校验).
//   IPv6 字面量带 [ ] 包裹, 拆 port 时要保留括号.
function splitHostPort(host) {
  const s = String(host || '').trim();
  if (!s) return { host: '', port: '' };
  // IPv6 带括号: [::1]:8080
  const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] || '' };
  const idx = s.lastIndexOf(':');
  // 裸 IPv6 (多个冒号, 无括号) 整体当 host —— 0 拆 port (拆了反而错).
  if (idx === -1 || s.indexOf(':') !== idx) return { host: s, port: '' };
  return { host: s.slice(0, idx), port: s.slice(idx + 1) };
}
export { splitHostPort };

// true = 这个 host 指向本机 (对跨机客户端不可用).
export function isLoopbackHost(host) {
  const { host: h } = splitHostPort(host);
  if (!h) return true;                 // 空 = 未配
  const lower = h.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  // 'localhost.' (带尾点, DNS 合法) 同样指本机.
  if (lower === 'localhost.') return true;
  // 整个 127.0.0.0/8 都是回环.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  return false;
}

export function createSystemSettingsV2Router({ db, requireAuth, requirePerm, logger }) {
  const router = Router();
  const userAuth = requireAuth;
  const configPerm = requirePerm('admin:config');

  // R158.X.99.30-revalidate (2026-10-23) — verify/activate 侧的周期二次校验.
  //
  // 为什么要补: 1-5 的范围规则**只在 buildLicenseRequest (生成申请单时) 跑过一次**,
  //   verify / activate 这两条路径直接把落盘 JSON 的 months 取出来就乘 366 算
  //   expires_at, 从不复核。于是改语义**之前**生成的申请单 (当时 months 真的是月,
  //   范围 1-120) 可以一路畅通走完激活 —— months=12 会被算成 12 年。
  //   2026-10-23 已把那 2 份 12 的历史申请单删掉, 但规则本身的洞还在:
  //   任何非 1-5 的值只要能落到 JSON 里, 激活端点仍会照单全收。
  //
  // 为什么不靠"删干净数据": 数据是一次性的, 校验是永久的。而且
  //   `Number(data.months) || 0` 这行还有个静默坑: 非数字值被 || 兜成 0,
  //   算出 0 年有效期 (到期时间 = 激活时刻), 比算长更隐蔽。
  //
  // 复用 license-validator.js:112 的同一套规则 (1-5 整数), 两处不各写一份。
  function readYearsOrThrow(data) {
    const years = Number(data?.months);
    if (!Number.isInteger(years) || years < 1 || years > 5) {
      return { ok: false, raw: data?.months };
    }
    return { ok: true, years };
  }

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

  // 3.5. GET /license-state (NO middleware, 公开) — license 状态派生.
  //     R158.License-expiry (2026-10-15). 跟 feature-flag-state shape 1:1 平行但 NO
  //     middleware (R158.103 /mcp/healthz 公开端点 precedent). 登录前 LoginView onMounted
  //     调一次, AppLayout store 30s polling 调一次. 0 触碰既有 8 admin 端点 + 1 userAuth
  //     端点. fail-closed (D-8): 5xx + status='unknown', should_redirect=false.
  router.get('/api/admin/system-settings-v2/license-state', async (req, res) => {
    try {
      // R158.X.99-trial (2026-10-21) — 第三个参数 configPath 用于派生 trial envelope.
      //   configPath 走 env / argv 跟下面 line 187 precedent 1:1 平行, 不动 factory signature.
      const configPath = process.env.APPSETTINGS_PATH || process.argv[2] || './appsettings.json';
      const state = await getLicenseState(db, logger, configPath);
      res.json(state);
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getLicenseState failed');
      // R158.X.99-trial — fail-closed 5xx 也带 trial envelope (lesson 141: 0 静默丢状态).
      //   date_source='unknown' 让前端能区分"真的没有 license"跟"状态查询挂了".
      res.status(500).json({
        has_license: false,
        status: 'unknown',
        should_redirect: false,
        days_remaining: null,
        days_until_warning: 30,
        trial: {
          active: false,
          days_total: 30,
          days_remaining: null,
          started_at: null,
          expires_at: null,
          date_source: 'unknown',
          pinned: false
        },
        // R158.X.99-quota — 端点级 5xx 时配额不可知, enforced=false (不限额, fail-open).
        quota: {
          max_nodes: null,
          headroom_ratio: 1.2,
          allowed_nodes: null,
          used_nodes: null,
          remaining_nodes: null,
          over_quota: null,
          enforced: false
        },
        error: 'internal'
      });
    }
  });

  // ==========================================================================
  // R158.License-config (2026-10-15) — 3 新端点 配合"生产 license 申请单" ship.
  // R158.LA-V1-delete (2026-10-15) — 0 改下面 3 端点 (R158.86.6 #5 wire shape preserve).
  // 删了上面 4 ADSPK V1 老 license 端点 (GET /license, POST /license/activate,
  // POST /license/deactivate, GET /license-status-public), V2 base32 (R158.LA) 闭环
  // 走文件最末 2 端点 (verify / activate).
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
      // R158.X.99.30.b (2026-10-19) — installedAt 0 必从 appsettings.json 读 (boot 写死时戳,
      //   R158.License-config precedent ensureSignatureAndInstalledAt 范式必废). 必 = 当前申请时间.
      //   前端 query `appliedAt` 必发 (前端 onMounted 时 formatYmd(new Date())), 0 发时
      //   后端兜底 toLocalYmd(new Date()) (本地 YYYY-MM-DD 纯日期, 申请当日).
      // R158.X.99.30.c (2026-10-19) — 进一步修正 D4.a: 0 必 toISOString UTC ("2026-10-19T05:13:08.711Z"),
      //   操作员明确 "0 是 UTC, 是本地时间", 必本地 YYYY-MM-DD 纯日期 (例 "2026-10-19", 0 时分秒).
      //   列名 `installed_at` 保留 (0 ALTER 列, D1 锁), 语义改 = "申请时戳" 非 "安装时戳".
      //   1:1 平行前端 formatYmd (LicenseView.vue). 0 必改 signature / instance_id / 其它字段.
      const appliedAtRaw = (typeof req.query.appliedAt === 'string' && req.query.appliedAt) ? req.query.appliedAt : null;
      const appliedAt = appliedAtRaw || toLocalYmd(new Date());
      const signature = readSignature(configPath);
      const instanceId = readInstanceId();
      const result = buildLicenseRequest({
        company: typeof company === 'string' ? company : '',
        mac: typeof mac === 'string' ? mac : '',
        months: monthsInt,
        maxNodes: maxNodesInt,
        installedAt: appliedAt,
        signature,
        instanceId
      });
      if (!result.ok) {
        // R158.X.99.30.fix-empty (2026-10-19) — 400 校验失败此前完全 silent, 补 logger.warn
        //   留痕供事后 audit 排错. 1:1 平行 try/catch 块的 logger.error 范式 (line 310).
        //   必操作员手动点击重试次数 ≤ 3/24h, 若 log 暴涨说明前端校验被绕 (lesson 41 探针).
        logger.warn(
          {
            err: result.error,
            company_len: (typeof company === 'string' ? company.trim().length : -1),
            mac_present: typeof mac === 'string' && mac.trim().length > 0,
            months: monthsInt,
            max_nodes: maxNodesInt,
            user: req.user?.sub ?? null
          },
          'system-settings-v2 exportLicenseRequest validation failed'
        );
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
        // 用顶部已 import 的 helper (`db/sql/license-request.js`), 0 走 db.sql:
          // licenseRequest domain 从未在 sql.js 的 VARIANTS 注册 →
          // db.sql.licenseRequest === undefined → `[dialect]` 抛 TypeError.
          const r = await db.execute(
          licenseRequestSql[dialect].insert,
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
      // R158.LA-V1-delete.fix (2026-10-15) — 往 result.request 内注入 request_id 字段.
      //   真因: R158.LA ship 时端点 response 把 request_id 放外层, result.request 内没
      //   这个字段, 前端 _maybeCaptureRequest 读 request.value.request_id 拿 undefined
      //   早退, base32Requests 永远空, 操作员看不到历史. 修法: 往内层也注入一份,
      //   外层 request_id 保留 (R158.86.6 #5 wire shape 1:1 平行, 0 删字段).
      const requestWithId = { ...result.request, request_id: saved.requestId };
      res.json({
        ok: true,
        request: requestWithId,
        request_id: saved.requestId,
        json_path: saved.jsonPath
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 exportLicenseRequest failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 10b. GET /license/requests (admin:config) — 列出本机申请单, **已激活的不返回**.
  //   R158.LA-hide-activated (2026-10-23).
  //
  //   为什么要新端点 (0 改既有 3 个端点, feedback-new-endpoint-dont-modify-old):
  //     原先前端 `base32Requests` 是纯 sessionStorage 缓存 (LicenseView.vue:541),
  //     【刷新列表】按钮调的其实是 export-request —— 也就是**再生成一份新申请单**,
  //     根本不读 DB。所以 activated_at 无论填得多准, 前端都看不见。
  //     sessionStorage 还有个更硬的性质: 清缓存 / 换浏览器 / 无痕窗口 → 全丢,
  //     操作员看不到任何历史申请单。
  //
  //   过滤口径: activated_at IS NULL = 还没用掉, 可选。
  //     ⚠ 必须用 `activated_at IS NULL` 而不是 `activated_at != NULL` 或 JS 侧
  //       truthy 判断 —— 后者在 MSSQL 的 datetime2 上语义相同, 但一旦将来回填
  //       时区导致 activated_at 变成空串/0 值, JS 侧会误判成「未激活」。
  //       判在 SQL 里是单一口径 (lesson 159)。
  //   instance_id 收窄: 只列本机的单 (跟 listByInstance 的既有契约一致), 避免
  //     装了多台 / 迁移过 instance_id 的环境互相看到对方的申请单。
  router.get('/api/admin/system-settings-v2/license/requests', userAuth, configPerm, async (req, res) => {
    try {
      const instanceId = readInstanceId();
      // limit 走 query, 但**夹死上限** —— 免得有人手敲 ?limit=999999 把表拉爆。
      const rawLimit = Number.parseInt(req.query.limit, 10);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 100;
      // ★ R161.10 (2026-10-26) — 两边方言现在**都是函数形式**, 行数上限整数内联
      //   (mssql: R93.4 precedent `TOP (?)` 会抛 error 1060; mysql: `LIMIT ?` 会让
      //   预处理语句的参数个数对不上 ⇒ mysqld_stmt_execute 报
      //   "Incorrect arguments to mysqld_stmt_execute" ⇒ 端点 500)。
      //   ⇒ 产出的 SQL 里**恰好 1 个 `?`** (instance_id), 与下面绑定的
      //   [instanceId] 一一对应 —— 调用点 0 分叉, 两边行为完全一致。
      //   ★ 不变量: **SQL 里的 `?` 个数必须等于绑定参数个数**。改这段 SQL 时
      //     必须同步核对参数数组, 否则又是一次 500 (见 db/sql/license-request.js
      //     文件头 R161.10 段)。
      const sqlText = typeof licenseRequestSql[db.dialect].listByInstance === 'function'
        ? licenseRequestSql[db.dialect].listByInstance(limit)
        : licenseRequestSql[db.dialect].listByInstance;
      const rows = await db.query(sqlText, [instanceId]);
      const list = (rows?.rows || []).map((r) => ({
        request_id: r.request_id,
        company: r.company,
        months: r.months,
        max_nodes: r.max_nodes,
        kind: r.kind,
        created_at: r.created_at
      }));
      res.json({ ok: true, requests: list, count: list.length });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 listLicenseRequests failed');
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
  //     body: { license_code, request_id }. 流程: 1) request_id 找落盘 JSON 拿 data
  //     2) 调 verifyLicenseCode(code, data) → boolean (R158.LA-depath: 删第 3 参 jsonPath)
  //     3) 返 valid + expires_at + masked
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
      const { data } = loaded;
      const valid = verifyLicenseCode(code, data);
      if (!valid) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'license_verify_failed',
          target: 'license_base32',
          payload: { request_id: requestId, instance_id: data.instance_id, code_prefix: code.slice(0, 5) }
        }, logger);
      }
      // R158.X.99.30 (2026-10-19) — 周期单位月→年, 1年=366天 (操作员 directive D5)
      //   原 monthsNum * 30 天/月 → 改 yearsNum * 366 天/年. 列名 `months` 保留 (0 ALTER 列,
      //   1:1 平行 R158.LA / R158.License-config precedent 锁). verify + activate 2 处
      //   1:1 平行改. 起点 Date.now() 保留 (verify 时点 = 申请时点附近, 跟 activated_at 1:1 平行).
      //   response.months 字段 (line 365) 仍用 yearsNum 复用 wire shape 0 改 (前端读 base32VerifyResult.months).
      //
      // R158.X.99.30-revalidate — 算 expires_at 之前先复核范围, 越界 400 而不是
      //   把非法周期算成有效期返回。放在 verifyLicenseCode 之后: 先验签名再谈周期,
      //   免得未验签的请求就拿到「有效期是多少」这种信息。
      const yr = readYearsOrThrow(data);
      if (!yr.ok) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'license_verify_failed',
          target: 'license_base32',
          payload: { request_id: requestId, reason: 'months_out_of_range:1-5', raw_months: yr.raw }
        }, logger);
        return res.status(400).json({ error: 'invalid_request', detail: 'months_out_of_range:1-5' });
      }
      const yearsNum = yr.years;
      const expiresAt = new Date(Date.now() + yearsNum * 366 * 24 * 60 * 60 * 1000).toISOString();
      res.json({
        ok: true,
        valid,
        request_id: requestId,
        company: data.company ?? null,
        months: yearsNum,
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
      const valid = verifyLicenseCode(code, data);
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
      // R158.X.99.30-revalidate — 必须在 deactivate **之前**判, 否则一个周期非法的
      //   申请单会把现有 license 先撤掉再失败, 属于"验证失败却造成破坏"。
      const yr = readYearsOrThrow(data);
      if (!yr.ok) {
        await writeAudit({
          userId: req.user?.sub ?? null,
          action: 'license_activate_failed',
          target: 'license_base32',
          payload: { request_id: requestId, reason: 'months_out_of_range:1-5', raw_months: yr.raw }
        }, logger);
        return res.status(400).json({ error: 'invalid_request', detail: 'months_out_of_range:1-5' });
      }
      // 撤销现有 active (单一 active invariant, 跟 ADSPK 端点 1:1 平行)
      await db.execute(db.sql.systemRegistration.deactivate, []);
      // R158.X.99.30 (2026-10-19) — 周期单位月→年, 1年=366天 (操作员 directive D5)
      //   原 monthsNum * 30 天/月 → 改 yearsNum * 366 天/年. 列名 `months` 保留 (0 ALTER 列,
      //   1:1 平行 R158.LA / R158.License-config precedent 锁). verify + activate 2 处
      //   1:1 平行改. 起点 Date.now() 保留 (verify 时点 = 申请时点附近, 跟 activated_at 1:1 平行).
      const yearsNum = yr.years;
      const expiresAt = new Date(Date.now() + yearsNum * 366 * 24 * 60 * 60 * 1000).toISOString();
      const notes = (typeof req.body?.notes === 'string' && req.body.notes.trim())
        ? req.body.notes.trim().slice(0, 500) : null;
      // INSERT ad_system_registration (kind='base32'). 走 ad-hoc INSERT (新加 3 列), 0 改 SQL helper.
      // R158.X.99-quota (2026-10-21) — 追加 max_nodes / max_nodes_allowed 两列.
      //   max_nodes         = 申请单原值 (授权意图, 审计可还原厂商发了什么)
      //   max_nodes_allowed = ceil(max_nodes × 1.2), 激活时算一次**写死**. 刻意不实时重算:
      //   宽限比例日后若调整, 已激活的 license 不应跟着变 (否则改个常量就悄悄改了
      //   存量客户的授权契约)。
      //   降级路径: 若启动期 ALTER 没成功 (MySQL baseline 根本没这张表 / 权限不足),
      //   写这两列的 INSERT 会抛错 → 走**不带配额列**的 INSERT 重试一次, 保证
      //   license 激活这个核心动作不因配额功能不可用而失败 (可选增强独立失败域).
      const appliedMaxNodes = Number(data.max_nodes) > 0 ? Number(data.max_nodes) : null;
      const appliedMaxNodesAllowed = appliedMaxNodes === null ? null : applyHeadroom(appliedMaxNodes);
      const dialect = db.dialect;
      // R161.5 (2026-10-26) — 只有 **DB 绑定** 用 naive; audit / notify / response
      //   一律仍用 ISO (前端要显示带时区的绝对时刻)。
      //   MySQL: ad_system_registration.expires_at 是 DATETIME (无 fractional) ⇒
      //     绑 '2026-...T..Z' ⇒ ER 1292 (INSERT 500) / 谓词静默退化。
      //   MSSQL: datetime2 吃 ISO ⇒ 0 行为变化。
      const expiresAtDb = dialect === 'mssql' ? expiresAt : toMysqlDatetime(expiresAt);
      const insertSqlFull = dialect === 'mssql'
        ? `INSERT INTO ad_system_registration
            (license_key, license_hash, expires_at, instance_id, notes, status, license_kind, license_request_id, request_json_path, max_nodes, max_nodes_allowed)
            OUTPUT inserted.id
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
        : `INSERT INTO ad_system_registration
            (license_key, license_hash, expires_at, instance_id, notes, status, license_kind, license_request_id, request_json_path, max_nodes, max_nodes_allowed)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`;
      const insertSqlNoQuota = dialect === 'mssql'
        ? `INSERT INTO ad_system_registration
            (license_key, license_hash, expires_at, instance_id, notes, status, license_kind, license_request_id, request_json_path)
            OUTPUT inserted.id
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        : `INSERT INTO ad_system_registration
            (license_key, license_hash, expires_at, instance_id, notes, status, license_kind, license_request_id, request_json_path)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`;
      let r;
      try {
        r = await db.execute(insertSqlFull, [
          code, hash, expiresAtDb, data.instance_id, notes,
          'base32', null, jsonPath, appliedMaxNodes, appliedMaxNodesAllowed
        ]);
      } catch (insertErr) {
        logger.warn(
          { err: insertErr?.message, request_id: requestId },
          'license activate: quota columns unavailable, retrying without them (quota feature disabled)'
        );
        r = await db.execute(insertSqlNoQuota, [
          code, hash, expiresAtDb, data.instance_id, notes,
          'base32', null, jsonPath
        ]);
      }
      const newId = r?.recordset?.[0]?.id || r?.insertId || null;
      // markActivated: ad_license_request.activated_at + license_id 关联
      try {
        await db.execute(
          licenseRequestSql[dialect].markActivated,
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
        // R158.X.99.30 (2026-10-19) — 安装时间 = 申请时间 (操作员 directive D4)
        //   复用 data.installed_at (ad_license_request.installed_at = 申请时戳),
        //   0 重新 new Date() (保持单一 invariant). 兼容兜底: data.installed_at 缺
        //   (历史 row) → fallback new Date(data.created_at || Date.now()) (不破老 license).
        activated_at: data.installed_at || new Date(data.created_at || Date.now()).toISOString(),
        expires_at: expiresAt,
        instance_id: data.instance_id,
        license_id: newId,
        license_key_masked: maskBase32License(code),
        request_id: requestId,
        // R158.X.99-quota — 激活时确定的配额契约 (含 20% 宽限). 回给前端让
        // 激活成功提示里直接显示"授权 N 个节点 (宽限后可容纳 M 台)", 0 必让操作员
        // 激活完再去翻申请单才知道批了多少.
        max_nodes: appliedMaxNodes,
        max_nodes_allowed: appliedMaxNodesAllowed
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

  // 13. GET /access-domain (admin:config) — R158.113.c (2026-10-17) — 读 system_config.access_domain.
  //     用于 McpReadTabView + McpWriteTokenView 替换 <center>:<port> 占位符.
  //     操作员 directive "将当前所有的 <center> 占位符定义为访问域名
  //     access_domain = dashboard.shaphar.net 访问域名绑定, 没有则直接定义为
  //     Agent 连接地址".
  //     wire shape: { value, fallback } — value 是操作员配的 access_domain (空串 = 未配),
  //     fallback 是 Agent 连接地址 (appsettings.json listen.host:listen.port 拼出).
  //     1:1 平行 R158.AdminEmail admin-email GET (line 297-306) 范式 + setConfig 入口 (line 491).
  //     0 改 schema (system_config KV 既有, 0 ALTER) / 0 改 5 老包 / 0 改 8 老 read tool /
  //     0 改 6 老 write tool (R158.69.3 + R158.113 锁 1:1 平行).
  router.get('/api/admin/system-settings-v2/access-domain', userAuth, configPerm, async (req, res) => {
    try {
      const cfg = await getConfig();
      const map = await getConfigMap();
      // listenPort 优先走 system_config (R158.78 起 allow admin UI 改), fallback 8080
      const listenPort = Number(map?.listenPort) || 8080;

      // R158.X.117 (2026-10-26) — 端点地址改成**可访问**的服务器地址.
      //
      // 旧逻辑 (R158.113.c):
      //   value    = access_domain 原样 (配成 localhost 就显示 localhost)
      //   fallback = http://<listen.host>:<port>  (listen.host 缺失 ⇒ 0.0.0.0)
      // ⇒ 界面 2 列全是"本机不可用"地址.
      //
      // 新逻辑:
      //   serverIp = 服务器真实 IP (getPrimaryIPv4, 本机 = 10.170.140.23)
      //   value    = access_domain, 但**本机地址**(localhost/127.x/::1/0.0.0.0)
      //              视为未配 ⇒ 清空 (前端显示 "— (未配访问域名)")
      //   fallback = http://<host>:<port>  ← IP 列显示这个
      //
      // ⚠ wire shape 约定 (跟 McpReadTabView.vue:207 / McpWriteTokenView.vue:210 1:1 对齐):
      //   前端 2 处都拼 `${value}/mcp` / `${fallback}/mcp` —— 即两者都必须是
      //   **完整 base** (含 scheme, 含 port), 前端只加路径后缀.
      //   ⚠ 旧版 value 是**裸 host** (access_domain 原样) ⇒ 域名列渲染出
      //     'dashboard.shaphar.net/mcp' —— **缺 scheme**, 不是合法 URL.
      //     R158.X.117 一并修正: value 改成含 scheme 的完整 base.
      //   (ConfigView.vue:330-352 的 "Agent 连接地址" 走 GET /api/admin/config
      //    拿的**另一个** access_domain 副本, 那边保持裸 host 约定, 0 冲突.)
      const serverIp = getPrimaryIPv4();
      const rawValue = String(cfg?.access_domain || '').trim();
      const { host: rawHost, port: domainPort } = splitHostPort(rawValue);
      const valueIsLoopback = isLoopbackHost(rawValue);

      // access_domain 自带 port 时优先, 否则用 listenPort.
      const effectivePort = Number(domainPort) || listenPort;

      // 本机地址 (localhost/127.x/::1/0.0.0.0) 视为未配 ⇒ value 留空,
      // 前端显示 "— (未配访问域名)".
      const domainHost = valueIsLoopback ? '' : rawHost;

      // value (域名列) 与 fallback (IP 列) 都是**完整 base**:
      //   有域名 → 域名列 = 域名 base, fallback = 域名 base (兼容老前端)
      //   无域名 → 域名列 = 空 (前端显示 "—"), fallback = 真实 IP base
      // 0 用 0.0.0.0 (bind 地址, 客户端连不上).
      //
      // ipBase (R158.X.117 新增): **永远**是服务器真实 IP 的 base.
      //   前端 IP 列用 ipBase —— 配了域名时 2 列不再显示一样的东西 (语义正确),
      //   且域名没解析到本机时, IP 列仍是可用的兜底地址.
      const value = domainHost ? `http://${domainHost}:${effectivePort}` : '';
      const fallbackHost = domainHost || serverIp;
      const fallback = `http://${fallbackHost}:${effectivePort}`;
      const ipBase = `http://${serverIp}:${effectivePort}`;

      res.json({ value, fallback, ipBase, serverIp });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getAccessDomain failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 14. PUT /access-domain (admin:config) — R158.113.c (2026-10-17) — 写 system_config.access_domain.
  //     body: { domain }. 空字符串放行 (操作员主动清空回 fallback), 非空走域名格式校验
  //     (host 或 host:port, 不带 protocol, 跟 R158.111 agentUrl 1:1 平行).
  //     走 setConfig 入口 (system_config 表 upsert + writeAudit 'access_domain_update').
  router.put('/api/admin/system-settings-v2/access-domain', userAuth, configPerm, async (req, res) => {
    try {
      const raw = req.body?.domain;
      const domain = (typeof raw === 'string') ? raw.trim() : '';
      if (domain) {
        // 允许 hostname / ipv4 / ipv6 / host:port (反向代理常见), 不允许 protocol prefix
        if (/^https?:\/\//i.test(domain)) {
          return res.status(400).json({ error: 'invalid_domain_format', detail: '不要带 http(s):// 前缀' });
        }
        if (!/^[A-Za-z0-9.\-:[\]]+$/.test(domain)) {
          return res.status(400).json({ error: 'invalid_domain_format', detail: '域名格式不正确' });
        }
      }
      await setConfig('access_domain', domain, req.user?.sub ?? null);
      res.json({ ok: true, value: domain });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 updateAccessDomain failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 15. GET /mcp-ip-whitelist (admin:config) — R158.X.99.28 (2026-10-19) —
  //     读 MCP IP 白名单 (system_config.mcp_ip_whitelist + mcp_ip_whitelist_enabled,
  //     2 KV 合并 1 endpoint). 1:1 平行 line 509 access-domain GET 范式.
  //     wire shape: { list, enabled, count } — list 走 cidr.js parseIpList 反
  //     解析 (跟 middleware cache 走同 1 个 parser, 0 必前端 2 次 verify).
  //     后端 0 schema 改 (复用 system_config KV, R158.X.99.28 D6 决策锁).
  router.get('/api/admin/system-settings-v2/mcp-ip-whitelist', userAuth, configPerm, async (req, res) => {
    try {
      const map = await getConfigMap();
      const rawJson = String(map?.mcp_ip_whitelist || '[]');
      const enabled = String(map?.mcp_ip_whitelist_enabled || '0') === '1';
      // 跟 middleware 1:1 平行 utils/cidr.js parseIpList (fail-safe: JSON 损坏
      // → [] 跟 middleware 行为一致, 0 必 frontend 二次 verify).
      const { parseIpList } = await import('../utils/cidr.js');
      const parsed = parseIpList(rawJson);
      const list = parsed.map(p => p.raw);
      res.json({ list, enabled, count: list.length });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getMcpIpWhitelist failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 16. PUT /mcp-ip-whitelist (admin:config) — R158.X.99.28 (2026-10-19) —
  //     写 MCP IP 白名单. body: { list: [...], enabled: bool }. 1:1 平行
  //     line 529 access-domain PUT 范式. 后端 cidr.js parseIpList 验每行
  //     (垃圾 entry 静默跳过, 跟 middleware 同 parseIpList 1:1 平行 — 0 必
  //     前端先 verify). setConfig 入口 (line 491) 走 writeAudit
  //     'update_config' 留痕. R158.X.99.28 D2 决策: enabled=0 旁路放行
  //     (1:1 平行 R158.16 email_enabled); enabled=1 + list=[] 也放行
  //     (操作员可能想先清再填, fail-closed 留 middleware 层 拒绝 0 必填).
  router.put('/api/admin/system-settings-v2/mcp-ip-whitelist', userAuth, configPerm, async (req, res) => {
    try {
      const { parseIpList } = await import('../utils/cidr.js');
      const rawList = req.body?.list;
      if (!Array.isArray(rawList)) {
        return res.status(400).json({ error: 'invalid_list', detail: 'list 必 JSON 数组' });
      }
      const enabled = !!req.body?.enabled;
      // 复用 cidr.js parseIpList 1:1 平行 middleware, 0 必重写 IP 验证.
      const parsed = parseIpList(rawList);
      const cleanedList = parsed.map(p => p.raw);
      // 写 2 个 KV 走 setConfigBundle (db.transaction 包裹), 走 audit 留痕 (R158.45.34 锁 1:1 平行).
      // R158.X.99.28.b (2026-10-19) — 1-click 修 F3 CRITICAL finding: 原 setConfig×2
      // 顺序写, 第 1 OK + 第 2 失败 = DB 半写 (mcp_ip_whitelist 写新但
      // mcp_ip_whitelist_enabled 0 写 → fail-open 旁路漏流量). 改调 setConfigBundle
      // (config.js 新 helper, db.transaction 包裹 2 KV) 整批 0 必半写.
      const actor = req.user?.sub ?? null;
      const { setConfigBundle } = await import('../services/config.js');
      await setConfigBundle({
        mcp_ip_whitelist:         JSON.stringify(cleanedList),
        mcp_ip_whitelist_enabled: enabled ? '1' : '0',
      });
      // R158.X.99.28 (2026-10-19) — invalidate module-level cache 防 drift.
      //   mcp-token.js / mcp-write-token.js 都 import 'invalidateMcpTokenCache' /
      //   'invalidateMcpWriteTokenCache' (R158.102/113 锁), 加进同一个 patch
      //   让下一次 middleware request 立刻拉新白名单. 动态 import 走 module
      //   registry, 0 必硬编码.
      try {
        const mcpTokenMod = await import('../auth/mcp-token.js');
        mcpTokenMod.invalidateMcpTokenCache?.();
        const mcpWriteTokenMod = await import('../auth/mcp-write-token.js');
        mcpWriteTokenMod.invalidateMcpWriteTokenCache?.();
      } catch (e) {
        logger.warn({ err: e?.message }, 'mcp-ip-whitelist invalidate cache failed (non-fatal, TTL 会自动过期)');
      }
      writeAudit({
        userId: actor,
        action: 'update_config',
        target: 'mcp_ip_whitelist',
        payload: { count: cleanedList.length, enabled, before: { list_count: rawList.length, enabled: null } }
      }, logger).catch(() => { /* best-effort audit */ });
      res.json({ ok: true, list: cleanedList, enabled, count: cleanedList.length });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 updateMcpIpWhitelist failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 16. GET /timezone (userAuth ONLY) — R161.11 (2026-10-26) — 时区单一真源 (读)
  //
  //   ★ 为什么是 userAuth 而不是 admin:config:
  //     显示时区是**渲染层**的参数, 前台 (AppLayout) 也要用 ⇒ 任何登录用户
  //     都要能读。跟 feature-flag-state (userAuth ONLY, 给 sidebar gate 用)
  //     1:1 平行。写 (PUT) 仍是 admin:config。
  //
  //   ★ 为什么必须返回**服务器侧**的时钟证据:
  //     R161.10 的现场事故 = 审计时间整整偏 8 小时, 而界面**没有任何**提示。
  //     操作员只能靠"这个时间看着不对"发现 ⇒ 页面必须自己把
  //     「会话时区 / 系统时区 / 是否已钉 UTC / 当前 UTC 时间」摊开给操作员看。
  //     pinnedToUtc=false (MySQL 侧会话时区不是 UTC) ⇒ 说明
  //     `DEFAULT CURRENT_TIMESTAMP` 还在按服务器本地时区写 ⇒ 时间会错。
  //
  //   wire shape:
  //   {
  //     displayTimezone: 'Asia/Shanghai',
  //     displayTimezoneOffsetMinutes: 480,
  //     storageContract: 'UTC',
  //     server: { dialect, sessionTimeZone, systemTimeZone, sessionOffsetMinutes,
  //                serverTimeUtc, serverTimeSession, pinnedToUtc },
  //     supportedCount: 428
  //   }
  router.get('/api/admin/system-settings-v2/timezone', userAuth, async (req, res) => {
    try {
      const [cfgMap, clock] = await Promise.all([
        getConfigMap(),
        readServerClock(db)
      ]);
      const displayTimezone = normalizeDisplayTimeZone(cfgMap?.[DISPLAY_TIMEZONE_KEY]);
      res.json({
        displayTimezone,
        displayTimezoneOffsetMinutes: offsetMinutesFor(displayTimezone),
        storageContract: STORAGE_CONTRACT,
        server: clock,
        supportedCount: listSupportedTimeZones().length
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 getTimezone failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 17. PUT /timezone (admin:config) — R161.11 (2026-10-26) — 写显示时区
  //
  //   body: { timezone: 'Asia/Shanghai' }
  //   存储: system_config.app_display_timezone (走 db.sql.config.upsert ——
  //   ★ 不能用 services/config.js 的 setConfig: 那是 UPDATE-only,
  //   key 不存在时**静默 0 行** ⇒ 新 key 永远写不进去 (R161.11 踩坑点).
  //   留痕: writeAudit 'update_display_timezone'。
  router.put('/api/admin/system-settings-v2/timezone', userAuth, configPerm, async (req, res) => {
    try {
      const raw = req.body?.timezone;
      const timezone = typeof raw === 'string' ? raw.trim() : '';
      if (!isValidTimeZone(timezone)) {
        return res.status(400).json({
          error: 'invalid_timezone',
          detail: '时区名必须是合法 IANA 名 (如 Asia/Shanghai / UTC), 不接受固定偏移串 (如 GMT+8)'
        });
      }
      const actor = req.user?.sub ?? null;
      await db.execute(db.sql.config.upsert, [DISPLAY_TIMEZONE_KEY, timezone]);
      await writeAudit({
        userId: actor,
        action: 'update_display_timezone',
        target: DISPLAY_TIMEZONE_KEY,
        payload: { timezone, offsetMinutes: offsetMinutesFor(timezone) }
      }, logger);
      res.json({
        ok: true,
        displayTimezone: timezone,
        displayTimezoneOffsetMinutes: offsetMinutesFor(timezone)
      });
    } catch (e) {
      logger.error({ err: e?.message, stack: e?.stack }, 'system-settings-v2 updateTimezone failed');
      res.status(500).json({ error: 'internal', detail: e?.message });
    }
  });

  // 18. GET /email-outbox-diagnostics (admin:config) — R161.11 (2026-10-26)
  //
  //   ★ 为什么需要这个端点:
  //     现场两个邮件端点 500, 而**服务端一行日志都没有** (路由 catch 不落 pino,
  //     NSSM 又丢弃 stderr) ⇒ Claude 侧无法判定到底是"表不存在"还是"SQL 写错"。
  //     这个端点让**服务器自己**把地面真相报出来: 哪些 outbox 表在不在、
  //     关键列在不在、各表多少行、当前会话时区是什么。
  //     操作员打开一个 URL 就能看到, 不需要装 mysql 客户端、不需要碰凭据。
  //
  //   ★ 探针复用 db.sql.probe (MySQL: information_schema + DATABASE();
  //     MSSQL: INFORMATION_SCHEMA / sys.tables) —— 双方言同一份代码路径。
  //   ★ 表名/列名来自下面两个**硬编码白名单**, 绝不接受请求参数 ⇒ 无注入面。
  //
  //   wire shape:
  //   {
  //     dialect: 'mysql',
  //     tables: [{ name, exists, rows|null, error|null }],
  //     columns: [{ table, column, exists }],
  //     missingTables: [...],
  //     missingColumns: [...],
  //     server: { sessionTimeZone, systemTimeZone, pinnedToUtc, ... }
  //   }
  router.get('/api/admin/system-settings-v2/email-outbox-diagnostics', userAuth, configPerm, async (req, res) => {
    // 白名单 (硬编码) —— 4 张 outbox + 2 张关联表。
    const TABLE_WHITELIST = [
      'system_alert_outbox',
      'report_email_outbox',
      'ad_notify_outbox',
      'license_email_outbox',
      'system_alerts',
      'daily_reports'
    ];
    // 邮件列表/详情 SQL 真正用到的列 —— 少一列就会 ER_BAD_FIELD_ERROR。
    const COLUMN_WHITELIST = [
      ['system_alert_outbox', 'sent_at'],
      ['system_alert_outbox', 'next_attempt_at'],
      ['system_alert_outbox', 'attempt_count'],
      ['system_alert_outbox', 'max_attempts'],
      ['system_alert_outbox', 'alert_id'],
      ['report_email_outbox', 'sent_at'],
      ['report_email_outbox', 'next_attempt_at'],
      ['report_email_outbox', 'attempt_count'],
      ['report_email_outbox', 'max_attempts'],
      ['report_email_outbox', 'report_id'],
      ['report_email_outbox', 'kind'],
      ['report_email_outbox', 'created_at']
    ];

    const dialect = db.dialect === 'mssql' ? 'mssql' : 'mysql';
    const probeTableSql = db.sql?.probe?.table;
    const probeColumnSql = db.sql?.probe?.column;

    // 表存在性 + 行数 (逐表隔离: 一张表炸了不影响其它表)。
    const tables = [];
    for (const name of TABLE_WHITELIST) {
      const entry = { name, exists: false, rows: null, error: null };
      try {
        if (probeTableSql) {
          const probe = await db.execute(probeTableSql, [name]);
          const probeRows = probe?.rows ?? probe?.recordset ?? [];
          entry.exists = probeRows.length > 0;
        }
        if (entry.exists) {
          const countSql = dialect === 'mssql'
            ? `SELECT COUNT(*) AS n FROM [${name}]`
            : `SELECT COUNT(*) AS n FROM \`${name}\``;
          const counted = await db.execute(countSql, []);
          const countRows = counted?.rows ?? counted?.recordset ?? [];
          entry.rows = Number(countRows?.[0]?.n ?? 0);
        }
      } catch (e) {
        entry.error = e?.message ?? String(e);
      }
      tables.push(entry);
    }

    // 列存在性 (只在表存在时才探, 否则列必然缺失, 没意义)。
    const columns = [];
    for (const [table, column] of COLUMN_WHITELIST) {
      const entry = { table, column, exists: false };
      try {
        if (probeColumnSql) {
          const probe = await db.execute(probeColumnSql, [table, column]);
          const probeRows = probe?.rows ?? probe?.recordset ?? [];
          entry.exists = probeRows.length > 0;
        }
      } catch (e) {
        entry.error = e?.message ?? String(e);
      }
      columns.push(entry);
    }

    const missingTables = tables.filter((t) => !t.exists).map((t) => t.name);
    const missingColumns = columns
      .filter((c) => !c.exists && !missingTables.includes(c.table))
      .map((c) => `${c.table}.${c.column}`);

    // 服务器时钟 (顺带证明会话时区是否已钉 UTC —— R161.10 的验收点)。
    let server = null;
    try {
      server = await readServerClock(db);
    } catch (e) {
      server = { error: e?.message ?? String(e) };
    }

    // ★ R161.12 (2026-10-27) — collation 证据。
    //   现场邮件两个界面 500 = "Illegal mix of collations for operation 'UNION'",
    //   而这类错误**只看 500 文本分不清**是"表缺列"还是"连接 collation 与 schema
    //   不一致"。⇒ 这里把三件事摊开:
    //     connection.charset/collation — 当前连接的字符集与 collation
    //     tableCollation             — 两张 outbox 表的表级 collation
    //     columnCollation            — UNION 涉及列的列级 collation
    //   一眼就能看出"连接 utf8mb4_general_ci vs 列 utf8mb4_unicode_ci"。
    let collation = null;
    try {
      const connInfoSql = dialect === 'mssql'
        ? `SELECT CONVERT(nvarchar(64), SERVERPROPERTY('Collation')) AS server_collation`
        : `SELECT @@character_set_connection AS charset_connection,
                  @@collation_connection AS collation_connection,
                  @@character_set_database AS charset_database,
                  @@collation_database AS collation_database`;
      const connRes = await db.execute(connInfoSql, []);
      const connRows = connRes?.rows ?? connRes?.recordset ?? [];

      const tableCollSql = dialect === 'mssql'
        ? `SELECT t.name AS table_name, c.name AS collation_name
             FROM sys.tables t
             JOIN sys.columns c ON c.object_id = t.object_id
            WHERE t.name IN ('system_alert_outbox','report_email_outbox')
              AND c.name = 'subject'`
        : `SELECT TABLE_NAME AS table_name, TABLE_COLLATION AS collation_name
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME IN ('system_alert_outbox','report_email_outbox')`;
      const tableRes = await db.execute(tableCollSql, []);
      const tableRows = tableRes?.rows ?? tableRes?.recordset ?? [];

      const columnCollSql = dialect === 'mssql'
        ? `SELECT t.name AS table_name, c.name AS column_name, c.collation_name AS collation_name
             FROM sys.tables t
             JOIN sys.columns c ON c.object_id = t.object_id
            WHERE t.name IN ('system_alert_outbox','report_email_outbox')
              AND c.name IN ('to_addrs','cc_addrs','subject','last_error','kind')
            ORDER BY t.name, c.name`
        : `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
                  CHARACTER_SET_NAME AS charset_name, COLLATION_NAME AS collation_name
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME IN ('system_alert_outbox','report_email_outbox')
              AND COLUMN_NAME IN ('to_addrs','cc_addrs','subject','last_error','kind')
            ORDER BY TABLE_NAME, COLUMN_NAME`;
      const columnRes = await db.execute(columnCollSql, []);
      const columnRows = columnRes?.rows ?? columnRes?.recordset ?? [];

      collation = {
        connection: connRows[0] ?? null,
        tables: tableRows,
        columns: columnRows
      };
    } catch (e) {
      collation = { error: e?.message ?? String(e) };
    }

    res.json({
      dialect,
      tables,
      columns,
      missingTables,
      missingColumns,
      collation,
      server,
      checkedAt: new Date().toISOString()
    });
  });

  return router;
}
