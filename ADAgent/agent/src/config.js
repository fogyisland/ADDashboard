import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// R161.33 (2026-11-07) — DEFAULTS 里的路径**不许**再写死盘符。本模块位于
// <installRoot>/agent/src/config.js, 因此 agent 目录 = 本文件的上一级。
// 之前写死 'C:\\agentInstall\\agent\\...' 的后果: 操作员把绿色包装到任意
// install root (R158.94 以后是受支持的布局) 且 appsettings.json 缺 key 时,
// 这些默认值静默指向一个不存在的盘符路径 —— queue 打开失败、脚本 spawn
// ENOENT, 报错里看到的全是陌生路径。Register-ADDashboardAgent.ps1 安装时
// 仍写绝对路径进 appsettings.json (shallow-merge 里 appsettings 永远赢),
// 这里只兜底, 而兜底必须落在真实安装位置。
const AGENT_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))));

const REQUIRED = ['centerUrl', 'agentId', 'agentToken'];
const DEFAULTS = {
  logLevel: 'info',
  pollingIntervalMinutes: 1,
  // 2026-09-30 — OOM 缓解: 心跳从 5s 改为 60s (1 分钟).
  // 原来 5s × 34 agents = 6.8 req/s × 3 round-trips ≈ 36 req/s 打 DB pool=10
  // → queue 累积 → closure 持有 → V8 heap 4GB → FATAL OOM. 60s 后降到
  // ~1 req/s × 3 = 3 req/s,pool 完全不排队. centres/agent.js:522 和
  // :905 都读这个字段,改一处全 agent 同步生效。
  heartbeatIntervalSeconds: 60,
  discoveryIntervalHours: 1,
  // 2026-09-27 — green-package defaults. 旧默认写死 `C:\\agentInstall\\...`;
  // R161.33 改为相对本模块推导 (<installRoot>/agent/...), 任意 install root
  // 都成立. Resolved relative to the CWD at launch (NSSM runs the service
  // with CWD = install dir), which is exactly where PackageManager creates
  // its queue file and package cache. appsettings.json still wins via
  // shallow-merge.
  psDiscoveryScriptPath: join(AGENT_DIR, 'scripts', 'collect-discovery.ps1'),
  queueDbPath: join(AGENT_DIR, 'queue.db'),
  agentDataDir: join(AGENT_DIR, 'data'),
  powerShellPath: 'powershell.exe',
  psScriptPath: join(AGENT_DIR, 'scripts', 'collect-replication.ps1'),
  healthCheckIntervalMs: 600_000,
  // T16: agent type discriminator. 'ad' = DC-collector (legacy); 'non-ad'
  // = member-server heartbeat + self-register + per-host package fetch.
  // Default stays 'ad' so existing deployments keep working without a
  // config-file change.
  agentType: 'ad',
  // R158.0.1.9 (2026-10-20) — port-scanner 删除. 4 个 scan DEFAULTS
  // (centerHost / scanOnBoot / scanOnRuntimeFail / scanFailureThreshold)
  // 删, 不再有 fallback 给 appsettings.json. 操作员 directive '不需要
  // 扫描端口'. 0 必保留这些 key 给老 appsettings.json 兼容 — loadConfig
  // 的 shallow-merge ({ ...DEFAULTS, ...cfg }) 是单向覆盖, 老 appsettings
  // 里残留的 4 个 key 仍然在 cfg 对象里被 agent.js 读到 (但代码已不再用).
  // 1.0.9 ship 后操作员手工 edit appsettings.json 清掉这 4 行更干净.
  // 2026-08-21 UX redesign (auto-delivery): the agent's last-seen
  // agent_token_version. Sent on every heartbeat; the centre replies with
  // a newer agentToken when its own version has been bumped. Default 0 =
  // fresh-install (matches a server that has never rotated; if the server
  // HAS rotated and the agent is on version 0, the next heartbeat will
  // immediately deliver the live token). Persistent so the agent doesn't
  // re-request the same credential after a restart.
  agentTokenVersion: 0,
  // R161.34 (2026-11-07, A-F1) — 本机**专属**的签名密钥 + 版本号。
  //   跟 agentToken / agentTokenVersion 同构 (同一套下发 → 落盘 → 回读
  //   流程), 但语义完全不同:
  //     agentToken      — **全 fleet 共享**的凭据 (中心 → agent 认证用)
  //     agentSigningKey — **本机独占**的签名密钥 (中心按 agentId 反查,
  //                       用来证明"这台机器签了这条请求")
  //   ★ 为什么必须有它: S82 的 X-Agent-Signature = HMAC(token, ...) 用的是
  //     **共享**密钥 ⇒ 谁拿到 token 都能签 ⇒ hostname/agentId 全是自报的
  //     ⇒ 循环论证 (用 A 的 token 伪造 hostname=B 可算出完全合法的签名)。
  //   ★ agentSigningKeyVersion = 0 ⇒ 还没领到密钥 ⇒ 签名回退共享 token
  //     (存量 agent 的正常路径, 零改造)。领到后由心跳响应自动下发并落盘。
  agentSigningKey: '',
  agentSigningKeyVersion: 0,
  // R158.48 (2026-10-06) — agent auto-update. The agent's last-applied
  // bundle version (mirrors agent.js:49 const VERSION at build time). The
  // centre reads its own boot-time cached version; if newer than this, the
  // heartbeat response carries upgradeAvailable=true and the agent pulls
  // GET /api/agent/upgrade. After atomic-apply, this field is bumped via
  // writeAppsettingsPatchAtomic (same pattern as agentTokenVersion) so a
  // process restart remembers the version we last applied. Default '0.0.0'
  // means "fresh install, force first upgrade" — after the first successful
  // upgrade the centre sees a matching version and stops nudging.
  installedAgentVersion: '0.0.0',
  // R161.35 第 4 步 (2026-11-22) — 发布签名公钥 (base64 SPKI DER)。
  //   中心下发的升级包带 Ed25519 签名 ⇒ agent 用这把**公钥**验签。
  //   · 公钥**不是秘密** ⇒ 可以随包分发, 也可以写进 appsettings.json。
  //   · 空字符串 ⇒ 本机没有公钥 ⇒ 收到带签名的包时**拒收** (fail-closed),
  //     收到不带签名的包时放行 (双轨老路)。
  //   ★ 为什么"没公钥 ⇒ 拒收带签名的包"而不是"没公钥 ⇒ 放行":
  //     放行 = 攻击者只要**把签名字段删掉**就能绕过验签 ⇒ 验签形同
  //     虚设。拒收 = 攻击者必须**伪造一个合法签名**才行。
  //     这只影响"已经预置了公钥的机"与"收到带签名的包"这个组合;
  //     存量机 (没公钥) 收到老包 (无签名) 依然正常升级。
  releasePublicKey: '',
  // 发布签名密钥标识 —— 只用于日志/审计 (说明"这把包是谁签的")。
  //   验签本身不依赖它 (公钥一把就够); 保留它是为了让审计日志可读。
  releaseKeyId: '',
  // R158.50.7f (2026-10-07) — agent in-process dashboard config. Passed
  // straight to startDashboard() in agent.js boot (fire-and-forget, see
  // agent.js boot block), which binds the loopback HTTP server that renders
  // the local-only "采集计划 / 最近报表 / 日志" page. dashboardEnabled=false
  // leaves the page off but doesn't disable the agent; collectors, heartbeat,
  // and R158.48 auto-upgrade are unaffected.
  //
  // username + password mirror what Register-ADDashboardAgent.ps1:162-163
  // writes to a fresh appsettings.json (admin / base64('admin')). The agent
  // resolves the base64 password back to plainPassword before handing off
  // to startDashboard, because dashboard/server.js compares the form-typed
  // password against plainPassword, not against the base64 string.
  //
  // 0.1.1 used these via the in-process startDashboard() call; 0.1.2 lost
  // the call site during the R158.50.7e refactor and left the schema
  // orphaned. Re-adding the DEFAULTS so loadConfig's shallow merge
  // ({ ...DEFAULTS, ...cfg }) backfills them automatically — operators do
  // not have to edit appsettings.json manually on the next upgrade.
  username: 'admin',
  password: Buffer.from('admin').toString('base64'),
  port: 8080,
  dashboardEnabled: true
};

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  // 2026-08-24 round-8: PowerShell 5.1 `Set-Content -Encoding UTF8` writes a
  // UTF-8 BOM (EF BB BF) into appsettings.json. JSON.parse rejects those
  // leading bytes with `SyntaxError: Unexpected token` and the agent
  // crashes on first call. Strip a leading BOM defensively — also covers
  // manual Notepad edits on Windows which save UTF-8-with-BOM by default.
  // We only strip the *leading* BOM so a stray embedded one (which would
  // itself be malformed JSON) is still surfaced as a parse error.
  const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const missing = REQUIRED.filter(
    (k) => cfg[k] === undefined || cfg[k] === null || cfg[k] === ''
  );
  if (missing.length > 0) {
    throw new Error(`agent config missing required key(s): ${missing.join(', ')}`);
  }
  // 2026-09-24 R91.3 — reject centerUrl that doesn't look like an absolute
  // URL with a scheme. Real install on KDLFLOFADSRV2 had appsettings.json
  // with `"centerUrl": "Add-Content : 流不可读。"` after an operator-side
  // `Add-Content` failure redirected stderr into the JSON file. The
  // previous loadConfig accepted the string as-is and the agent crashed
  // 30 lines deeper inside `new URL(url)` in reporter.js:13 with a stack
  // trace that pointed at the wrong layer. Fail loudly at config-load
  // time so the operator sees "your config is corrupt" instead of "the
  // URL parser is broken".
  //
  // Acceptable shapes: anything matching RFC 3986 generic scheme syntax
  // (`scheme://authority/...`): `http://x`, `https://x`, `ws://x` (future
  // websocket probes), `tcp://x` (lab bench), even `file:///path` for local
  // dev. The constraint we actually need is "has a scheme" — anything
  // else is either a relative path, a bare hostname, or a stray error
  // string from a redirected PowerShell `Add-Content` failure.
  if (typeof cfg.centerUrl !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(cfg.centerUrl.trim())) {
    throw new Error(
      `agent config centerUrl is not a valid URL (missing scheme): ${JSON.stringify(cfg.centerUrl)}`
    );
  }
  return { ...DEFAULTS, ...cfg };
}
