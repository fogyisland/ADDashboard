// R161.35 第 4 步 — 发布签名私钥的**定位与加载**。
//
// ★ 私钥在哪:
//   构建侧持发布私钥。默认路径 <repoRoot>/.secrets/release-signing-key.pem
//   (Server/.secrets/ —— 在 .gitignore 里, 绝不入库)。
//   也可用环境变量指定路径: AD_DASHBOARD_RELEASE_KEY_FILE。
//
// ★★★ 为什么**不**把私钥放进数据库 / system_config:
//   中心进程需要**验签**的能力吗? 不需要 —— 验签用的是**公钥**, 公钥
//   放在 agent 侧。中心只需要**转发**签名, 不需要签名。
//   ⇒ 那么"中心端签名"这条路就要求: 中心机器上有一把私钥。
//   ⇒ 私钥在中心机器上 = 中心被拿下 ⇒ 攻击者可以签任意包 ⇒ agent 验签
//     失去意义。
//   ⇒ 正确的形态: **构建侧预签名**, 中心只转发已签好的包。
//   ⇒ 本模块提供两条路:
//     (a) 预签名文件 (推荐): <agentRoot>/bundle-signature.json 由构建
//         脚本生成, 中心只读它并原样转发 —— **中心不碰私钥**。
//     (b) 中心本地签名 (应急/内网自签场景): 中心读本地私钥现场签。
//         此时中心确实持有私钥, 安全等级低于 (a), 但对"内网自建、
//         无人能接触构建机"的部署仍然有意义。
//   ⇒ 默认走 (a)。(b) 需要显式开关 (env) 才启用, 且启动日志会明确
//     标注"中心持有私钥"这一事实。
//
// ★ 失败语义 (fail-soft, 但**大声**):
//   找不到签名文件 / 私钥 ⇒ 返回 null ⇒ bundle 以"无签名"形态下发 ⇒
//   agent 侧走双轨的老路 (放行 + warn + 回报中心)。
//   ⇒ **绝不**因为没有签名就让升级通道整个失效 (那比不签名更糟)。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 预签名文件名 (放在 agent 树根下, 与 build-manifest.json 同级)。
export const PRESIGNED_SIGNATURE_FILENAME = 'bundle-signature.json';

// 默认私钥路径 (相对 <repoRoot>)。
export const DEFAULT_PRIVATE_KEY_RELATIVE = join('.secrets', 'release-signing-key.pem');

// 环境变量名。
export const ENV_KEY_FILE = 'AD_DASHBOARD_RELEASE_KEY_FILE';

// 预签名文件名 (可覆盖)。
export const ENV_PRESIGNED_FILE = 'AD_DASHBOARD_RELEASE_SIGNATURE_FILE';

// "中心本地签名"的开关。
export const ENV_CENTER_SIGNING = 'AD_DASHBOARD_CENTER_SIGNS_BUNDLES';

/**
 * 读预签名文件 (构建侧生成的 bundle-signature.json)。
 *
 * ★ 文件里存的是 wire 格式的签名块 + 签发时的元数据:
 *   { payloadVersion, algorithm, keyId, version, gitCommit, fileCount,
 *     signature }
 *
 * @param {string} agentRoot agent 树根 (含 build-manifest.json 的那一层)
 * @param {object} [opts]
 * @param {string} [opts.filePath] 显式指定预签名文件路径
 * @returns {object|null} 签名块; 不可用时返回 null
 */
export function readPresignedSignature(agentRoot, { filePath = null } = {}) {
  const path = filePath || process.env[ENV_PRESIGNED_FILE]
    || (agentRoot ? join(agentRoot, PRESIGNED_SIGNATURE_FILENAME) : null);
  if (!path) return null;
  if (!existsSync(path)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // 形状校验: 缺的字段一律当作"没有签名" (fail-soft, 由调用方打日志)。
  if (typeof parsed.signature !== 'string' || parsed.signature.length === 0) return null;
  if (typeof parsed.keyId !== 'string' || parsed.keyId.length === 0) return null;
  return parsed;
}

/**
 * 加载发布私钥 (仅在"中心本地签名"模式下调用)。
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] 树根 (默认 dirname(dirname(__filename)))
 * @param {string} [opts.keyPath]  显式私钥路径
 * @returns {{privateKeyPem: string, keyId: string|null}|null}
 */
export function loadReleasePrivateKey({ repoRoot = null, keyPath = null } = {}) {
  const path = keyPath || process.env[ENV_KEY_FILE]
    || (repoRoot ? join(repoRoot, DEFAULT_PRIVATE_KEY_RELATIVE) : null);
  if (!path) return null;
  if (!existsSync(path)) return null;
  let pem = null;
  try {
    pem = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) return null;
  // keyId 默认从文件名派生 (release-signing-key.pem ⇒ release-signing-key),
  //   让日志/审计里能看出"这把钥匙是哪来的"。可用 env 覆盖。
  const keyId = process.env.AD_DASHBOARD_RELEASE_KEY_ID
    || path.split(/[\\/]/).pop().replace(/\.pem$/i, '');
  return { privateKeyPem: pem, keyId };
}

/**
 * 中心端是否被授权**本地签名** (持有私钥现场签)。
 *
 * 默认 **false** —— 中心只转发构建侧预签好的签名。
 *
 * @returns {boolean}
 */
export function centerSigningEnabled() {
  const v = process.env[ENV_CENTER_SIGNING];
  return typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * 决定本次升级源的签名策略。
 *
 * @param {object} params
 * @param {string} params.agentRoot agent 树根
 * @param {string} params.repoRoot  树根
 * @param {object} params.logger
 * @returns {{mode: 'presigned'|'center'|'none', signature: object|null,
 *            signing: {privateKeyPem: string, keyId: string}|null}}
 */
export function resolveSigningStrategy({ agentRoot, repoRoot, logger = null }) {
  // (a) 预签名优先 —— 中心不碰私钥, 安全等级最高。
  const presigned = readPresignedSignature(agentRoot);
  if (presigned) {
    logger?.info?.({
      event: 'agent.upgrade.signing.presigned',
      keyId: presigned.keyId,
      version: presigned.version
    }, 'agent upgrade bundle will be served with PRESIGNED signature (centre holds no private key)');
    return { mode: 'presigned', signature: presigned, signing: null };
  }

  // (b) 中心本地签名 —— 需显式开关。
  if (centerSigningEnabled()) {
    const key = loadReleasePrivateKey({ repoRoot });
    if (key) {
      logger?.warn?.({
        event: 'agent.upgrade.signing.center',
        keyId: key.keyId
      }, 'agent upgrade bundle will be signed BY THE CENTRE (centre holds the private key) — weaker than presigned mode');
      return { mode: 'center', signature: null, signing: key };
    }
    logger?.error?.({
      event: 'agent.upgrade.signing.center.key-missing'
    }, 'centre signing enabled but private key not found — bundle will be served UNSIGNED');
  }

  // (c) 无签名 —— 老路。
  logger?.warn?.({
    event: 'agent.upgrade.signing.none'
  }, 'agent upgrade bundle will be served UNSIGNED (no presigned file; centre signing not enabled)');
  return { mode: 'none', signature: null, signing: null };
}
