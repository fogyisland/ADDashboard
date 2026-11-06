// agent-packages-manifest — 「DB 行 → 上线 manifest 列表」纯函数
//
// R161.21 (2026-10-29)
//
// 为什么单独一个模块 (不是洁癖):
//
//   这条链路上有三个独立的判定, 任何一个写错, 成员代理就静默地「收到包
//   但一个都不跑」 (agent 端 non-ad-scheduler.js 的
//   `pkg.scope !== 'agent_type:non-ad'` 硬条件) —— 而且症状是
//   **0 行数据**, 不是 500。R158.86.5 → R158.87.6.5 → R161.21 这一串
//   缺陷全都栽在同一条链上, 因为它没有可执行的断言:
//
//     ① 水合时有没有把 DB 的 scope 送出 (R161.21 修)
//     ② 合并后有没有把 AD 作用域的包挡住 (R161.21 修)
//     ③ agent 端过滤条件与服务端送出的字段是否 1:1
//
//   抽成纯函数后, 这三点可以在**不连数据库**的前提下被一条测试钉死
//   (见 Server/center/tests/agent-packages-scope.test.js)。
//
// 纯函数 = 无 IO、无 DB、无 clock、无第三方依赖; 输入是两组 DB 行,
// 输出是 manifest 数组。
//
// ★ 为什么这个模块必须**零 import**(除下面的 merge 服务):
//   回归网 tests/agent-packages-scope.test.js 要同时 import
//   「服务端纯函数」和「agent 端真谓词」来断言 1:1 契约。若本模块
//   import 了 express / mysql2 / mssql, 测试就会因为安装环境缺依赖
//   (本机 center/node_modules 里 express 根本没装) 而整个跑不起来。
//   —— service 层保持零依赖, 是这条回归网能长期活着的硬前提。

import { mergePackagesForHost } from './agent-packages-for-host.js';

/**
 * 把 `package_scripts + package_policies` 的 JOIN 行 与
 * `ad_member_server_packages` 的按主机行, 合成一份**只含该主机该跑的**
 * manifest 列表。
 *
 * @param {object} args
 * @param {Array<object>} [args.enabledRows]
 *   `db.sql.packageScripts.listEnabledGlobal` 的行。字段:
 *   { name, version, script_sha256, manifest_json, interval_sec,
 *     timeout_ms, enabled, params_json, scope, source, created_at, updated_at }
 *   `manifest_json` 两种形态都要吃:
 *     · mysql2 的 JSON 列 → 已经是 JS 对象
 *     · mssql 的 NVARCHAR → JSON 字符串
 * @param {Array<object>} [args.memberRows]
 *   `db.sql.serverGroups.listPackagesForHost` 的行。
 *   字段: { hostname, package_name, enabled, installed_at, last_run_at,
 *           version, pkg_enabled }
 * @returns {Array<object>} 上线 manifest 数组。
 */
export function buildManifestItems({ enabledRows = [], memberRows = [] } = {}) {
  // parseManifest — handle both shapes:
  //   mysql2 (json column): already a JS object
  //   mssql (NVARCHAR): JSON string
  // Defensive: a corrupt JSON string should drop the row, not crash
  // the agent's package fetch.
  const parseManifest = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  };
  const installedGlobal = enabledRows
    .map((r) => {
      const manifest = parseManifest(r.manifest_json);
      if (!manifest || !manifest.name) return null;
      // JSON.parse(JSON.stringify(...)) is a cheap deep clone so the
      // upstream DB row's manifest object is never shared/mutated
      // (matches runner.js:73).
      const baked = JSON.parse(JSON.stringify(manifest));
      baked.agent = baked.agent || {};
      baked.agent.intervalSec = Number(r.interval_sec);
      baked.agent.timeoutMs = Number(r.timeout_ms);
      // R161.21 (2026-10-29) — 把 package_policies.scope 原样送上线.
      // 非 AD 代理的客户端过滤器 (non-ad-scheduler.js
      // shouldRunPackageForNonAd) 以 pkg.scope === 'agent_type:non-ad'
      // 为硬条件, 而 scope 之前只存在于 DB 列 ⇒ 成员代理实测「14 包输入
      // → 0 包通过」. scope 是权威信号 (manifest.agent.type 不可信:
      // ad_os_baseline 的 manifest.agent.type 至今仍写着 'non-ad', 但它
      // 的 scope 是 'agent_type:ad').
      // DB 列有 DEFAULT 'global', 但历史行可能是 NULL ⇒ 兜底 'global',
      // 绝不 undefined (undefined 会让客户端条件判定走 false 分支).
      baked.scope = r.scope || 'global';
      return baked;
    })
    .filter(Boolean);
  const merged = mergePackagesForHost({
    installedGlobal,
    memberServerPackages: memberRows
  });
  // R161.21 (2026-10-29) — 本端点是**成员代理专用** (只有 non-AD
  // agent 会调它), 所以只下发 scope === 'agent_type:non-ad' 的包.
  //
  // 为什么必须在这里收口: mergePackagesForHost 的 'global' 分支会把
  // 全部全局启用包 (含 11 个 agent_type:ad 的 DC 包) 一并放进结果,
  // 它的文档契约写的是 "globals ... surface for AD hosts" —— 但这个
  // 端点根本不服务 AD 主机. 之前 AD 包能挡住, 只是因为 agent 端过滤器
  // 恰好拦住了 (而那个过滤器在 scope 缺失时是全拦 ⇒ 连 member 包也
  // 一起没了). R158.87.6.5 已经在 /api/agent/packages 上踩过同一个坑
  // ("member-server 拉 AD 包"), 这里不重复踩: 服务端只发成员该跑的包,
  // agent 端的 scope 校验退化成纵深防御.
  //
  // 判定用**精确相等**, 与 /api/agent/packages 的 joinSelect 同规则
  // (runner.js:482 喂 `agent_type:<type>`): scope='global' 的包两边都
  // 不下发 (它们是 on-demand command 包, 走 ad_admin_commands 生命周期).
  return merged.filter((p) => p && p.scope === 'agent_type:non-ad');
}
