// 2026-08-21 UX redesign (auto-delivery): when the centre replies to a
// heartbeat with { agentToken, agentTokenVersion }, the agent MUST persist
// both atomically + update the in-memory config so subsequent heartbeats
// use the new credential. Used by both AD and non-AD runtimes.
//
// Kept in its own module so unit tests can exercise the version-compare +
// atomic-write + in-memory-swap logic without booting the full agent
// runtime (which is expensive + non-deterministic for side-effects).

import { writeAgentTokenAtomic } from './appsettings-writer.js';

export async function applyAgentTokenDelivery({ result, config, configPath, logger, deferWrite = false }) {
  if (!result || !result.ok || !result.data) return { applied: false };
  const data = result.data;
  if (typeof data.agentToken !== 'string' || !data.agentToken) return { applied: false };
  const incomingVersion = Number(data.agentTokenVersion);
  if (!Number.isInteger(incomingVersion) || incomingVersion < 1) return { applied: false };
  if (incomingVersion <= Number(config.agentTokenVersion || 0)) return { applied: false };

  // R161.31 (2026-11-07) — deferWrite 模式: 只算 patch 不写盘, 由调用方
  // (心跳后的合并写入器) 跟其它 delivery 的 patch 合成**一次**原子写。
  // 串行三次写 = 三倍读+写+fsync; 并行三次写 = 读-改-写丢更新 + 共用
  // tmp 文件名损坏。合并写是唯一正确且快的解法 (见 appsettings-writer.js
  // 的 writeAppsettingsPatchAtomicMerged 文档)。
  const patch = { agentToken: data.agentToken, agentTokenVersion: incomingVersion };
  if (deferWrite) {
    const previousVersion = config.agentTokenVersion;
    config.agentToken = data.agentToken;
    config.agentTokenVersion = incomingVersion;
    logger.info(
      { version: incomingVersion, previousVersion },
      'agent token auto-delivered from heartbeat response (deferred write)'
    );
    return { applied: true, deferred: true, patch, previousVersion, newVersion: incomingVersion };
  }

  const w = writeAgentTokenAtomic({
    path: configPath,
    newToken: data.agentToken,
    newVersion: incomingVersion
  });
  if (!w.ok) {
    logger.error(
      { error: w.error, version: incomingVersion },
      'appsettings.json write failed; new agent token NOT persisted (in-memory only this run)'
    );
    return { applied: false, error: w.error };
  }

  const previousVersion = config.agentTokenVersion;
  config.agentToken = data.agentToken;
  config.agentTokenVersion = incomingVersion;
  logger.info(
    { version: incomingVersion, previousVersion },
    'agent token auto-delivered from heartbeat response'
  );
  return { applied: true, previousVersion, newVersion: incomingVersion };
}
