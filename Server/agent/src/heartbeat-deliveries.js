// R161.31 (2026-11-07) — 心跳后 delivery 的**合并写入**编排器 (性能项 2)。
//
// ★ 问题: 心跳响应可能同时携带三份"要落盘的东西":
//   ① agentToken + agentTokenVersion  (凭据轮换)
//   ② agentSettings 若干字段           (心跳间隔 / 轮询间隔 / 日志级别)
//   ③ upgradeAvailable + upgradeVersion (自动升级, 装盘后要记版本)
//   旧实现是**串行三次** applyXxxDelivery, 每个都 read → parse → mutate
//   → write-tmp → fsync → rename 同一个 appsettings.json ⇒ 一次心跳付
//   三倍全量读 + 三倍全量写 + 三次 fsync。
//
// ★ 为什么不能改成 Promise.all (并行):
//   (a) 读-改-写丢更新 —— 三个 writer 各自 read 一个快照, 各自 mutate,
//       各自 rename。后两个的快照里没有前一个的改动 ⇒ 字段丢失。
//   (b) 共用 tmp 文件名 —— 旧实现都用 `${path}.tmp` ⇒ 两个 writer 同时
//       openSync 同一个 tmp ⇒ 内容交错 ⇒ appsettings.json 变损坏 JSON。
//   ⇒ (b) 已在本仓 appsettings-writer.js 里用 nextTmpPath (pid+计数)
//     根治; (a) 由本模块的"合并成一次写"根治。
//
// ★ 本模块的契约:
//   1. 三个 delivery 全部以 deferWrite=true 调用 —— 它们只算 patch + 更新
//      内存 config, **不碰磁盘**;
//   2. 收集到的 patch 按 **token → settings → upgrade** 顺序合并;
//   3. 一次 writeAppsettingsPatchAtomicMerged 落盘;
//   4. 写失败 ⇒ 落日志 + 全部 in-memory 版本回滚? —— 不回滚 (见下)。
//
// ★ 为什么写失败不回滚内存: 三个 delivery 的失败语义在各自模块里已经
//   定义好了 (token: 不落盘 = 下次心跳重试; settings: 同; upgrade: bundle
//   已在盘上, 落盘失败只 warn)。合并写失败时, 内存里的 version 已经推进
//   ⇒ 中心认为我们收到了 ⇒ 不会重推。**但凭据本身在内存里是对的** (下
//   一��心跳就用新 token), 只是磁盘上还是旧的 ⇒ 最坏情况 = 重启后回到旧
//   token, 中心会再推一次。这跟旧实现的失败语义完全一致 (旧实现写失败也
//   是内存已更新、磁盘未更新)。所以这里保持一致, 不引入新语义。

import { writeAppsettingsPatchAtomicMerged } from './appsettings-writer.js';

/**
 * applyHeartbeatDeliveries — 心跳响应后的三个 delivery 编排入口。
 *
 * @param {object}  params
 * @param {object}  params.result            心跳响应 { ok, data }
 * @param {object}  params.config            运行时 config (会被就地更新)
 * @param {string}  params.configPath        appsettings.json 路径
 * @param {object}  params.logger
 * @param {function} params.applyAgentToken   applyAgentTokenDelivery 包装
 * @param {function} params.applySettings     applySettingsDelivery 包装
 * @param {function} params.applyUpgrade      applyUpgradeDelivery 包装
 * @param {function} [params.applySigningKey]  R161.34: applyAgentSigningKeyDelivery 包装
 * @returns {Promise<{applied: boolean, deferred: boolean, patches: object[],
 *   error?: string, upgradeOutcome?: object}>}
 */
export async function applyHeartbeatDeliveries({
  result,
  config,
  configPath,
  logger,
  applyAgentToken,
  applySettings,
  applyUpgrade,
  applySigningKey
}) {
  // 缺 config 或 configPath ⇒ 无处可写 (configPath 是落盘路径, config 是
  // 内存状态)。这种情况只在单测 / 旧调用点出现 ⇒ 直接跳过落盘, 但**仍
  // 允许 delivery 自己更新内存**? —— 不行: delivery 的单调守卫要读
  // config.agentTokenVersion, 没有 config 会抛 TypeError。所以整体跳过,
  // 由调用方自己决定怎么办。
  if (!config || typeof configPath !== 'string' || !configPath) {
    logger?.warn?.({ event: 'heartbeat.deliveries.skipped', reason: 'missing-config-or-path' },
      'heartbeat deliveries skipped: config/configPath not provided');
    return { applied: false, deferred: false, patches: [], upgradeOutcome: null };
  }

  const patches = [];

  // ① 凭据轮换。
  if (typeof applyAgentToken === 'function') {
    const r = await applyAgentToken({ result, config, configPath, logger, deferWrite: true });
    if (r && r.applied === true && r.patch) patches.push(r.patch);
  }

  // ② 客户端设置。
  if (typeof applySettings === 'function') {
    const r = await applySettings({ result, config, configPath, logger, deferWrite: true });
    if (r && r.applied === true && r.patch) patches.push(r.patch);
  }

  // ③ 自动升级。
  // ★ 注意: upgrade 的落盘是**语义关键**的 —— bundle 已经在盘上, 版本号
  //   必须记下来, 否则下次心跳会重复装同一个包 (R158.87.6.5 的
  //   "already-at-target" 短路就是靠这个字段)。所以它**不能**只靠合并写:
  //   合并写失败时必须**回退到独立写**, 保证版本号一定落盘。
  let upgradeResult = null;
  if (typeof applyUpgrade === 'function') {
    upgradeResult = await applyUpgrade({ result, config, configPath, logger, deferWrite: true });
    if (upgradeResult && upgradeResult.applied === true && upgradeResult.patch) {
      patches.push(upgradeResult.patch);
    }
  }

  // ④ per-agent 签名密钥 (R161.34, A-F1)。
  //   ★ 顺序: 放在 token 之后 —— 两者的版本守卫互不干扰 (agentTokenVersion
  //     vs agentSigningKeyVersion), 但语义上"先换共享凭据, 再换专属密钥"
  //     更符合直觉: 拿到新 token 的那一拍, 中心已经知道这台机的新密钥版本,
  //     一起下发最省一次心跳往返。
  //   ★ 落盘不是"语义关键" (跟 ③ 不同): 密钥落盘失败 ⇒ 重启后中心会
  //     再推一次 ⇒ 只是多一次往返, 不丢功能 ⇒ 走合并写即可, 不需要
  //     像 upgrade 那样回退到独立写。
  if (typeof applySigningKey === 'function') {
    const r = await applySigningKey({ result, config, configPath, logger, deferWrite: true });
    if (r && r.applied === true && r.patch) patches.push(r.patch);
  }

  if (patches.length === 0) {
    return { applied: false, deferred: false, patches: [], upgradeOutcome: upgradeResult };
  }

  const w = writeAppsettingsPatchAtomicMerged({ path: configPath, patches });
  if (!w.ok) {
    logger?.error?.(
      { error: w.error, keys: patches.flatMap((p) => Object.keys(p)) },
      'merged appsettings.json write failed; in-memory values updated, disk unchanged'
    );
    return { applied: false, deferred: false, patches, error: w.error, upgradeOutcome: upgradeResult };
  }

  logger?.info?.(
    { applied: w.applied },
    'merged appsettings.json write complete (single atomic write)'
  );
  return { applied: true, deferred: false, patches, upgradeOutcome: upgradeResult };
}
