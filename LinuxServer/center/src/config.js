import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SUPPORTED_DIALECTS } from './db/sql.js';
import { getDb } from './db/index.js';

// Reads the center version from package.json at module load. Used by the
// package router's compat checks (checkCenterCompat) so admin installs
// reject manifests that require a newer center than the running build.
const PKG_VERSION = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
let _centerVersion = '0.0.0';
try {
  _centerVersion = JSON.parse(PKG_VERSION).version || _centerVersion;
} catch {
  // fall through — leave as '0.0.0'
}

export function getCenterVersion() {
  return _centerVersion;
}

const REQUIRED_BY_DIALECT = {
  mysql: ['db.mysql.host', 'db.mysql.database'],
  mssql: ['db.mssql.server', 'db.mssql.database']
};

const TOP_LEVEL_REQUIRED = ['listenPort', 'jwtSecret', 'agentToken', 'staticDir'];

// R161.25 (2026-10-29 部署审计) — 校验与读取拆开。
//
// 旧实现只有 loadConfig(path) = 读文件 + 校验揉在一起, 于是**任何"改配置"
// 的写路径**都只能"写文件 → 再 loadConfig 校验 → 校验不过就 unlink 文件"。
// 那条 unlink 契约对**启动期**的补字段 (ensureSignatureAndInstalledAt) 是
// 可以接受的 (写坏了就退回初始化向导), 但对**运行期**的写路径 (例如管理
// 后台改端口) 是灾难性的: 一次手滑的端口值就会把生产环境的凭据文件删掉,
// 服务随即掉进"配置没了"的状态 (marker 已锁 ⇒ 直接 exit 2)。
//
// 拆出 validateConfigObject(cfg) 后, 写路径可以在**落盘前**对"合并后的对象"
// 做同一套校验 —— 不合格就 throw, **磁盘上什么都没动**。
export function validateConfigObject(cfg) {
  // Validate dialect
  const dialect = cfg.db?.dialect;
  if (!dialect) throw new Error('config missing required key: db.dialect');
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new Error(`config.db.dialect invalid: '${dialect}'; supported: ${SUPPORTED_DIALECTS.join(', ')}`);
  }

  // Validate dialect-specific connection block
  for (const k of REQUIRED_BY_DIALECT[dialect]) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), cfg);
    if (v === undefined || v === null || v === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }

  // Validate top-level required
  for (const k of TOP_LEVEL_REQUIRED) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }

  // ★ R161.25 — 端口必须是**数字**。
  //   旧实现把 cfg.listenPort 原样返回。Node 的 `app.listen(x)` 里, x 是
  //   **字符串**时它不是端口, 而是"监听这个路径"(Unix socket / Windows 命名
  //   管道) ⇒ 中心**起得来但谁都连不上**, 而且**不报错** (端口冲突/权限
  //   之类的日志一条都没有) —— 操作员只会看到"服务 RUNNING, 但页面打不开"。
  //   手改过 appsettings.json 的机器最容易踩到 (JSON 里写成 "8090")。
  const listenPort = Number(cfg.listenPort);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error(`config listenPort invalid: ${JSON.stringify(cfg.listenPort)} (must be an integer in 1..65535)`);
  }

  return {
    db: { dialect, [dialect]: cfg.db[dialect] },
    listenPort,
    jwtSecret: cfg.jwtSecret,
    agentToken: cfg.agentToken,
    staticDir: cfg.staticDir,
    logLevel: cfg.logLevel || 'info',
    env: cfg.env || 'prod',
    frontendDevProxy: cfg.frontendDevProxy || null
  };
}

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  return validateConfigObject(JSON.parse(raw));
}

export function loadConfigOrNull(path) {
  if (!existsSync(path)) return null;
  return loadConfig(path);
}

export function defaultConfig() {
  return {
    db: undefined,
    listenPort: 8080,
    jwtSecret: '',
    agentToken: '',
    staticDir: './dist',
    logLevel: 'info',
    env: 'prod',
    frontendDevProxy: null
  };
}

// Reads the package registry URL from the system_config table. Returns
// null when the key is absent (no registry configured yet).
//
// Used by the admin REST endpoints in center/src/packages/router.js to
// gate the /packages/registry/refresh and /packages/:name/upgrade routes.
export async function getRegistryUrl() {
  const db = getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'package_registry_url'"
  );
  return rows[0]?.config_value || null;
}

// ----- listenPort helpers (Task 2) -----
//
// ★ R161.25 (2026-10-29 部署审计) — 端口的**真值表**在这里定死。
//
//   | 来源 | 含义 | 谁写 | 谁读 |
//   |---|---|---|---|
//   | appsettings.json `listenPort` | **期望端口** (下次启动要绑的端口) | 初始化向导 / 启动期对账 | 启动时绑定 |
//   | system_config `listenPort` | 期望端口的**镜像** (管理后台可改) | 启动期对账 / 管理后台 | 管理界面表单 |
//   | system_config `listenPort_source` | 镜像来源: 'appsettings' \| 'admin' | 同上 | 启动期对账 |
//   | system_config `center_listen_port_bound` | **当前进程实际绑定的端口** | 每次正常模式启动 | 对外地址 / 部署自检 |
//
//   ★ 旧实现 (R161.25 之前) 的病根: **绑定只看 appsettings.json**, 而管理后台
//     写的是 system_config ⇒ **后台改端口永远不生效**, 而界面却明明白白写着
//     「改完需重启 center 后生效」(web/src/views/admin/ConfigView.vue:277)。
//     操作员改完 → 重启 → 端口没变 → 徽标「重启生效」还一直亮着 (徽标的
//     pending/started 哈希各带一个时间戳 ⇒ 永远不相等 ⇒ 徽标永远不消)。
//
//   ★ 修法 (不是把 appsettings.json 改成从数据库读 —— 那会让**存量部署**的
//     绑定端口漂移): 绑定改为 **DB 优先**, 但用 `listenPort_source` 区分两种
//     语义 ——
//       · 'admin'    ⇒ 管理后台**显式**指定过 ⇒ 数据库说了算;
//       · 'appsettings' (以及**任何没有 source 标记的老行**) ⇒ 该行只是
//         appsettings.json 的镜像 ⇒ 以**文件里的值**为准, 并把数据库那行改回来。
//     老 seed 往库里写死过 8080 (而文件里是 8090) ⇒ 老行按镜像处理正好把
//     这个谎报纠正回来, **存量部署的绑定端口一个字节都不变**; 而后台改端口
//     从此真正生效 (改完重启即换端口)。
export const LISTEN_PORT_SOURCE_APPSETTINGS = 'appsettings';
export const LISTEN_PORT_SOURCE_ADMIN = 'admin';

// 端口合法性: 1..65535 的整数 (与既有 getListenPort 的判定口径一致)。
// 返回 null 表示"没有可用值" —— 调用方必须自己决定兜底, 不许静默吞掉。
function normalizeListenPort(value, fallback = null) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  return fallback;
}

// Query helper — single-key read reused by getListenPort.
async function readListenPortRow() {
  const db = getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'listenPort'"
  );
  return rows[0]?.config_value ?? null;
}

// 一次读齐端口相关的三个键 (避免三次往返)。
async function readListenPortState() {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT config_key, config_value FROM system_config
     WHERE config_key IN ('listenPort', 'listenPort_source', 'center_listen_port_bound')`
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  return {
    desired: normalizeListenPort(map.listenPort, null),
    source: map.listenPort_source === LISTEN_PORT_SOURCE_ADMIN
      ? LISTEN_PORT_SOURCE_ADMIN
      : LISTEN_PORT_SOURCE_APPSETTINGS,
    sourceRaw: map.listenPort_source ?? null,
    bound: normalizeListenPort(map.center_listen_port_bound, null)
  };
}

// 返回 system_config 里记着的**期望端口** (镜像值)。
// 纯读, 不写。fallbackPort 由调用方给出 (通常是 appsettings.json 的值),
// 绝不再写死 8080 —— 那是老实现把"文件里是 8090、库里是 8080"这个谎报
// 固化下来的根源。
export async function getListenPort(fallbackPort = defaultConfig().listenPort) {
  const raw = await readListenPortRow();
  return normalizeListenPort(raw, normalizeListenPort(fallbackPort, defaultConfig().listenPort));
}

// 返回**当前进程实际绑定的端口**。优先取启动时写下的
// `center_listen_port_bound`; 拿不到 (老版本 / 没写过) 再退回期望端口。
// 对外地址 (agent 连接串) 与部署自检脚本要用这个, 不是期望端口 ——
// "后台改了端口但还没重启" 这段时间里, 期望端口 ≠ 真实端口。
export async function getBoundListenPort(fallbackPort = defaultConfig().listenPort) {
  const state = await readListenPortState();
  return state.bound ?? state.desired ?? normalizeListenPort(fallbackPort, defaultConfig().listenPort);
}

// 解析"这次启动要绑哪个端口", 并把 system_config.listenPort 对账成同一个值。
//
// 规则 (见上面的真值表):
//   · source === 'admin' ⇒ 管理后台显式指定过 ⇒ **数据库说了算**;
//   · 否则 (含**任何没有 source 标记的老行**) ⇒ 该行只是 appsettings.json 的
//     镜像 ⇒ 以**文件里的值**为准, 并把数据库那行改回来。
//
// 返回 { port, source, changed, previous }。
export async function resolveListenPort({ logger, appsettingsPort } = {}) {
  const filePort = normalizeListenPort(appsettingsPort, defaultConfig().listenPort);
  const state = await readListenPortState();
  const db = getDb();

  const port = (state.source === LISTEN_PORT_SOURCE_ADMIN && state.desired != null)
    ? state.desired
    : filePort;
  const source = (state.source === LISTEN_PORT_SOURCE_ADMIN && state.desired != null)
    ? LISTEN_PORT_SOURCE_ADMIN
    : LISTEN_PORT_SOURCE_APPSETTINGS;

  const changed = state.desired !== port || state.sourceRaw !== source;
  if (changed) {
    await db.execute(db.sql.config.upsert, ['listenPort', String(port)]);
    await db.execute(db.sql.config.upsert, ['listenPort_source', source]);
    logger?.info?.({
      port,
      previous: state.desired,
      source,
      previousSource: state.sourceRaw,
      appsettingsPort: filePort
    }, 'system_config.listenPort reconciled');
  }
  return { port, source, changed, previous: state.desired };
}

// 记下"当前进程实际绑定的端口"。启动成功之后调一次 —— 这一行是对外地址与
// 部署自检脚本 (Linux verify.sh / Windows verify.ps1) 的唯一真值。
export async function recordBoundListenPort(port, logger) {
  const db = getDb();
  const value = normalizeListenPort(port, null);
  if (value == null) {
    logger?.warn?.({ port }, 'refusing to record an invalid bound listenPort');
    return null;
  }
  await db.execute(db.sql.config.upsert, ['center_listen_port_bound', String(value)]);
  return value;
}

// First 16 hex chars (8 bytes) of sha256(input). Used to build the
// pending/started version hashes that gate the "restart required" badge in
// the ConfigView (Task 6). 8 bytes is plenty of entropy for "did the port
// change since startup?" — collisions across valid port values are
// negligible. Matches the spec's "Version hash" section.
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ----- listenHost helper (R158.113.c) -----
//
// R158.113.c (2026-10-17) — system_config.access_domain 配置项生效后, 前端
//   2 view (McpReadTabView + McpWriteTokenView) 必读 appsettings.json 的
//   listen.host 拼 fallback "Agent 连接地址". 1:1 平行 getListenPort 范式:
//   静态读 appsettings.json, 0 必 bootstrap seed (host 0 必写 DB).
//   fallback `0.0.0.0` 跟前端展示无关, 前端用它拼 URL 时 bind 0.0.0.0 实际
//   上是 "all interfaces", 浏览器访问要换 `localhost` 或具体 IP. 1:1 平行
//   R158.AdminEmail 锁 "admin 域配置走 system_config + service entry".
const CONFIG_PATH = process.env.APPSETTINGS_PATH || process.argv[2] || './appsettings.json';
function readListenHostFromAppsettings() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const host = cfg?.listen?.host;
    if (typeof host === 'string' && host.trim()) return host.trim();
  } catch {
    // fall through to default
  }
  return '0.0.0.0';
}

// Returns the host the center should advertise in the fallback
// "Agent 连接地址" when system_config.access_domain is empty.
// Reads appsettings.json → listen.host, falls back to '0.0.0.0'.
// 1:1 平行 getListenPort (line 123) — but listen.host 0 必 bootstrap
// seed because it never goes through system_config.
export async function getListenHost() {
  return readListenHostFromAppsettings();
}
