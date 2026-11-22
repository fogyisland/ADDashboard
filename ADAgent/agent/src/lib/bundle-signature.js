// R161.35 第 4 步 (2026-11-22) — agent 侧升级包验签 (Ed25519)。
//
// ★ 这个模块解决什么漏洞:
//
//   升级包的完整性校验原先是**自证**的 —— 中心把 {path, sha256, base64}
//   一起发给 agent, agent 比对 "sha256(base64解码结果) === 收到的 sha256"。
//   ⇒ 攻击者 (中心被拿下 / 中间人改包) 把 base64 换掉、把 sha256 一起
//     换掉, 校验照样通过 ⇒ agent 会**原子覆盖自己的代码**。
//   ⇒ 本模块: 用**发布公钥**验 Ed25519 签名 ⇒ 攻击者必须伪造一个
//     合法签名, 而私钥只存在于构建侧。
//
// ★★★ 双轨 (老 agent / 老包 不验签 ⇒ 不能硬切):
//   34 台 DC + 成员机上的 agent 当前版本**都不验签**。若强制要求签名,
//   而构建链某次漏签 ⇒ **整队 agent 集体拒绝升级** ⇒ 全 fleet 停在
//   旧版本, 且日志显示"验签失败" ⇒ 操作员极易误判成攻击。
//   ⇒ 判定规则:
//       bundle 带 signature 字段 ⇒ **必须**验签通过才用 (不过就拒收)
//       bundle 不带 signature      ⇒ 放行, 但打 warn + 回报中心
//   ⇒ 效果: 发布侧漏签只会让**新版本 agent** 拒绝; 老版本 agent 完全
//     不受影响。中心可统计"多少台还没升到验签版", 全 fleet 升级完成后
//     再关掉中心侧的"无签名放行"开关。
//
// ★ 为什么这个模块在 agent 树里**独立一份**, 不跟中心共用:
//   中心的 services/ 目录不在 agent 树里 (agent 包是独立的绿包), 而
//   且中心那份模块 import 了 node:fs 等构建侧用得到的东西。复制一份
//   (逻辑完全一致) 让 agent 包保持零依赖、自包含。
//   ⇒ **两份必须同步** —— Server/scripts/audit/ 里有守卫脚本专门盯这个。
//
// ★ 无第三方依赖: Node 内置 crypto 原生支持 ed25519。

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const SIGNATURE_ALGORITHM = 'ed25519';
export const SIGNATURE_PAYLOAD_VERSION = 1;

/**
 * 构造被签名的载荷对象 (与中心侧逐字一致)。
 *
 * @param {object} params
 * @param {string} params.version
 * @param {string} [params.gitCommit]
 * @param {string} params.keyId
 * @param {Array<{path: string, sha256: string}>} params.files
 * @returns {object}
 */
export function buildSignaturePayload({ version, gitCommit = null, keyId, files }) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => ({
      path: String(f?.path ?? ''),
      sha256: String(f?.sha256 ?? '').toLowerCase()
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    payloadVersion: SIGNATURE_PAYLOAD_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    keyId: String(keyId || ''),
    version: String(version ?? ''),
    gitCommit: gitCommit == null ? null : String(gitCommit),
    fileCount: list.length,
    files: list
  };
}

/**
 * 把载荷序列化成**确定性**的字节序列。
 *
 * ★ 排序在这里 (而不是只在 buildSignaturePayload 里) —— 中心侧是同款
 *   实现。理由见中心侧同名函数的注释: 两侧各自算出的字节必须相同。
 *
 * @param {object} payload
 * @returns {Buffer}
 */
export function canonicalizePayload(payload) {
  const p = payload || {};
  const files = (Array.isArray(p.files) ? p.files : [])
    .map((f) => ({
      path: String(f?.path ?? ''),
      sha256: String(f?.sha256 ?? '').toLowerCase()
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fileLines = files.map((f) => `${f.path}\t${f.sha256}`).join('\n');
  const text = [
    `payloadVersion=${Number(p.payloadVersion) || 0}`,
    `algorithm=${String(p.algorithm || '')}`,
    `keyId=${String(p.keyId || '')}`,
    `version=${String(p.version || '')}`,
    `gitCommit=${String(p.gitCommit ?? '')}`,
    `fileCount=${Number(p.fileCount) || 0}`,
    files.length > 0 ? fileLines : ''
  ].join('\n');
  return Buffer.from(text, 'utf8');
}

/**
 * 从 wire 签名块 + **实际收到的**文件清单重建载荷并验签。
 *
 * ★ 载荷里的 files 用的是**实际收到的**清单 (bundle.files 的 path +
 *   sha256), 不是中心送来的任何清单 —— 因为 base64 才是真正要被保护的
 *   内容。
 *
 * @param {object} params
 * @param {object} params.signatureBlock  bundle.signature (wire 形状)
 * @param {Array<{path: string, sha256: string}>} params.files 实际收到的清单
 * @param {string} params.publicKeyBase64 发布公钥 (base64 SPKI DER)
 * @returns {{ok: boolean, reason: string|null, payload: object|null}}
 */
export function verifyBundleSignature({ signatureBlock, files, publicKeyBase64 }) {
  if (!signatureBlock || typeof signatureBlock !== 'object') {
    return { ok: false, reason: 'missing-signature-block', payload: null };
  }
  const payload = buildSignaturePayload({
    version: signatureBlock.version,
    gitCommit: signatureBlock.gitCommit,
    keyId: signatureBlock.keyId,
    files
  });
  if (Number(signatureBlock.fileCount) !== payload.fileCount) {
    return { ok: false, reason: 'file-count-mismatch', payload };
  }
  const payloadVersion = Number(payload.payloadVersion);
  if (!Number.isInteger(payloadVersion) || payloadVersion !== SIGNATURE_PAYLOAD_VERSION) {
    return { ok: false, reason: 'unsupported-payload-version', payload };
  }
  if (payload.algorithm !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: 'unsupported-algorithm', payload };
  }
  for (const f of payload.files) {
    if (typeof f?.path !== 'string' || f.path.length === 0) {
      return { ok: false, reason: 'malformed-payload', payload };
    }
    if (typeof f?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      return { ok: false, reason: 'malformed-payload', payload };
    }
  }
  if (typeof signatureBlock.signature !== 'string' || signatureBlock.signature.length === 0) {
    return { ok: false, reason: 'missing-signature', payload };
  }
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64.length === 0) {
    return { ok: false, reason: 'missing-public-key', payload };
  }
  let key;
  try {
    key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki'
    });
  } catch {
    return { ok: false, reason: 'malformed-public-key', payload };
  }
  let rawSig;
  try {
    rawSig = Buffer.from(signatureBlock.signature, 'base64');
  } catch {
    return { ok: false, reason: 'malformed-signature', payload };
  }
  if (rawSig.length !== 64) {
    return { ok: false, reason: 'malformed-signature', payload };
  }
  try {
    const ok = cryptoVerify(null, canonicalizePayload(payload), key, rawSig);
    return { ok, reason: ok ? null : 'signature-mismatch', payload };
  } catch {
    return { ok: false, reason: 'verify-threw', payload };
  }
}

/**
 * 决定这个 bundle 能不能用 —— 双轨判定的**唯一真源**。
 *
 * 返回三态:
 *   {mode:'signed-verified'}  带签名 + 验签通过 ⇒ 用
 *   {mode:'unsigned'}         不带签名 ⇒ 放行 (双轨老路), 但要报警
 *   {mode:'rejected'}         带签名 + 验签失败 ⇒ **拒收整个包**
 *
 * ★ "拒收"的具体含义 (调用方必须做到):
 *   不写盘 / 不 rename / 不 SIGTERM / 不改 installedAgentVersion ⇒
 *   agent 停在当前版本继续干活, 并把失败回报给中心。
 *
 * @param {object} params
 * @param {object} params.bundle           中心下发的 bundle (含 .files/.signature)
 * @param {string} [params.publicKeyBase64] 发布公钥 (base64 SPKI DER)
 * @returns {{mode: string, reason: string|null, payload: object|null}}
 */
export function evaluateBundleSignature({ bundle, publicKeyBase64 }) {
  const signatureBlock = bundle?.signature;
  if (!signatureBlock || typeof signatureBlock !== 'object') {
    // 无签名 ⇒ 放行 (双轨)。调用方负责打 warn + 回报中心。
    return { mode: 'unsigned', reason: 'no-signature', payload: null };
  }
  const files = (Array.isArray(bundle?.files) ? bundle.files : [])
    .map((f) => ({ path: String(f?.path ?? ''), sha256: String(f?.sha256 ?? '') }));
  const verdict = verifyBundleSignature({
    signatureBlock,
    files,
    publicKeyBase64
  });
  if (verdict.ok) {
    return { mode: 'signed-verified', reason: null, payload: verdict.payload };
  }
  return { mode: 'rejected', reason: verdict.reason, payload: verdict.payload };
}

/**
 * bundle 的内容指纹 —— 只用于日志比对, **不构成**安全保证。
 *
 * @param {Array<{path: string, sha256: string}>} files
 * @returns {string} 64 位 hex
 */
export function bundleFingerprint(files) {
  const payload = buildSignaturePayload({ version: '', keyId: '', files });
  return createHash('sha256').update(canonicalizePayload(payload)).digest('hex');
}
