// R161.34 (2026-11-07, A-F1) — per-agent 签名密钥的接收与落盘。
//
// ★ 这个模块解决什么:
//   中心按 agentId 反查该机的专属签名密钥; agent 第一次带签名的请求
//   到达时, 中心生成一把并**放在心跳响应里下发**。agent 收到后原子落盘
//   (appsettings.json) 并更新 reporter 的模块级缓存 ⇒ 之后所有出站请求
//   都用本机专属密钥签名 ⇒ 别的机器 (哪怕也拿到了全局共享 token) 算不
//   出本机的合法签名 ⇒ 自报 hostname 的循环论证被打断。
//
// ★ 跟 applyAgentTokenDelivery 同构 (刻意保持一致, 便于 review):
//   版本号单调守卫 → 算 patch → (deferWrite) 合并写 / 直接写 → 更新内存。
//
// ★★ 密钥落盘是**必须的**, 不是优化:
//   密钥只在内存里的话, 每次重启都要重新向中心申请 ⇒ 中心每次都要
//   重新生成/下发 ⇒ 版本号会一直推进, 且重启窗口内的请求仍然用共享
//   token 签名 (可被冒充)。落盘后, 重启即从盘上恢复 (见 agent.js boot
//   里的 _setAgentSigningKey(config.agentSigningKey))。
//
// ★ 失败语义 (与 agent token 一致):
//   落盘失败 ⇒ 内存**仍**更新 (下一心跳就能用新密钥签名), 但盘上是旧
//   的 ⇒ 最坏情况 = 重启后回到旧密钥, 中心会再推一次。不回滚内存。
//
// ★ 绝不把密钥写进日志: logger 只打 version, 不打 key 本身。

import { writeAppsettingsPatchAtomic } from './appsettings-writer.js';
import { _setAgentSigningKey } from './reporter.js';

/**
 * 消费心跳响应里的 per-agent 签名密钥。
 *
 * @param {object}  params
 * @param {object}  params.result     心跳响应 { ok, data }
 * @param {object}  params.config     运行时 config (会被就地更新)
 * @param {string}  params.configPath appsettings.json 路径
 * @param {object}  params.logger
 * @param {boolean} [params.deferWrite] 只算 patch 不写盘 (由合并写入器落盘)
 * @returns {Promise<{applied: boolean, deferred?: boolean, patch?: object,
 *   previousVersion?: number, newVersion?: number, error?: string}>}
 */
export async function applyAgentSigningKeyDelivery({
  result, config, configPath, logger, deferWrite = false
}) {
  if (!result || !result.ok || !result.data) return { applied: false };
  const data = result.data;

  // 中心没下发 ⇒ 什么都不做 (存量 agent / 尚未领取)。
  if (typeof data.agentSigningKey !== 'string' || !data.agentSigningKey) {
    return { applied: false };
  }
  // 形状校验: 中心发的是 96 个 hex 字符 (48 字节)。形状不对 = 传输层
  // 出了问题 (截断 / 被改写) ⇒ 宁可不用, 也不能拿半截密钥去签名
  // (那样中心验签会 401, 而且日志会误导排查方向)。
  if (!/^[0-9a-f]{96}$/i.test(data.agentSigningKey)) {
    logger?.error?.(
      { event: 'agent.signingkey.reject', reason: 'malformed-key', length: data.agentSigningKey.length },
      'agent signing key delivery rejected: malformed key material'
    );
    return { applied: false, error: 'malformed-key' };
  }

  const incomingVersion = Number(data.agentSigningKeyVersion);
  if (!Number.isInteger(incomingVersion) || incomingVersion < 1) {
    return { applied: false, error: 'invalid-version' };
  }
  // ★ 单调守卫: 中心发来的版本必须**严格大于**本机手上的。
  //   否则乱序响应 (旧的 heartbeat 响应后到) 会把新密钥降级成旧密钥 ——
  //   降级后中心按 agentId 反查到的是新密钥 ⇒ 验签失败 ⇒ 该机失联。
  if (incomingVersion <= Number(config.agentSigningKeyVersion || 0)) {
    return { applied: false, reason: 'stale-version' };
  }

  const previousVersion = Number(config.agentSigningKeyVersion || 0);

  if (deferWrite) {
    // 只更新内存 + 返回 patch, 由心跳后的合并写入器落盘 (一次原子写)。
    config.agentSigningKey = data.agentSigningKey;
    config.agentSigningKeyVersion = incomingVersion;
    _setAgentSigningKey(data.agentSigningKey);
    logger?.info?.(
      { version: incomingVersion, previousVersion },
      'per-agent signing key auto-delivered from heartbeat response (deferred write)'
    );
    return {
      applied: true,
      deferred: true,
      patch: { agentSigningKey: data.agentSigningKey, agentSigningKeyVersion: incomingVersion },
      previousVersion,
      newVersion: incomingVersion
    };
  }

  const w = writeAppsettingsPatchAtomic({
    path: configPath,
    patch: {
      agentSigningKey: data.agentSigningKey,
      agentSigningKeyVersion: incomingVersion
    }
  });
  if (!w.ok) {
    logger?.error?.(
      { error: w.error, version: incomingVersion },
      'appsettings.json write failed; per-agent signing key NOT persisted (in-memory only this run)'
    );
    return { applied: false, error: w.error };
  }

  config.agentSigningKey = data.agentSigningKey;
  config.agentSigningKeyVersion = incomingVersion;
  _setAgentSigningKey(data.agentSigningKey);
  logger?.info?.(
    { version: incomingVersion, previousVersion },
    'per-agent signing key auto-delivered from heartbeat response'
  );
  return { applied: true, previousVersion, newVersion: incomingVersion };
}
