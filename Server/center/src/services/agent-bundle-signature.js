// R161.35 第 4 步 — 升级包 Ed25519 签名的**纯逻辑**层。
//
// ★ 这个模块解决什么漏洞:
//
//   现状的升级包校验是**自证**的:
//     中心 (agent-upgrade-source.js) 读文件 → 自己算 sha256 → 把
//     {path, sha256, base64} 一起发给 agent;
//     agent (upgrade-delivery.js 的 decodeBundleFile) 比对
//     "sha256(base64解码结果) === 收到的 sha256"。
//   ⇒ 这只证明"传输途中没损坏", **不证明"这份代码是发布方签发的**"。
//   ⇒ 攻击者(中心被拿下 / 中间人改了 bundle)把 base64 换掉、把 sha256
//     一起换掉, 校验照样通过 ⇒ agent 会**原子覆盖自己的代码**。
//   ⇒ 这正是操作员问题的最后一环: 第 1-3 步管住了"中心→agent 的命令",
//     但"中心→agent 的**代码**"这条腿是敞着的。
//
// ★ 方案: Ed25519 数字签名。
//   · 发布私钥在**构建侧** (不落库、不入库, 只在构建机本地);
//   · 发布公钥**预置在 agent 侧** (随 agent 包一起分发);
//   · 中心把签名连同 bundle 一起下发;
//   · agent 验签 ⇒ 不过就**整个包拒收** (不写盘 / 不 rename / 不 SIGTERM)。
//
// ★★★ 为什么签名对象**不含 base64**:
//   base64 是整包最大的一块 (几十 MB)。对整包 base64 签名 = 每次发布
//   多算一遍 50 MB 的哈希, 中心启动时多花几百毫秒。而"文件清单"已经
//   包含了每个文件的 sha256 ⇒ 对清单签名 = 等价于对全部文件内容签名,
//   但只需签几 KB。验签方仍然按现有逻辑逐个比对文件 sha256, 两层
//   合起来覆盖了全部字节。
//
// ★★★ 双轨 (老 agent 不验签 ⇒ 不能硬切):
//   34 台 DC + 成员机上的 agent 当前版本**都不验签**。若中心强制要求
//   签名, 而构建链某次漏签 ⇒ **整队 agent 集体拒绝升级** ⇒ 全 fleet
//   停在旧版本, 且日志显示"验签失败" ⇒ 操作员极易误判成攻击。
//   ⇒ agent 端的判定是:
//       bundle 带 signature 字段 ⇒ **必须**验签通过才用 (不过就拒收)
//       bundle 不带 signature      ⇒ 放行, 但打 warn + 回报中心
//   ⇒ 效果: 发布侧漏签只会让**新版本 agent** 拒绝; 老版本 agent 完全
//     不受影响。中心可统计"多少台还没升到验签版", 全 fleet 升级完成后
//     再关掉中心侧的"无签名放行"开关。
//
// ★ 无第三方依赖: Node 内置 crypto 原生支持 ed25519
//   (generateKeyPairSync('ed25519') / sign(null, ...) / verify(null, ...))。
//   ⇒ center/package.json **不需要改** (R161.26 纪律: .install-hash 依赖
//     它, 改动会让安装器重算依赖指纹)。

import {
  createHash, createPublicKey, createPrivateKey,
  sign as cryptoSign, verify as cryptoVerify,
  generateKeyPairSync, randomBytes
} from 'node:crypto';

// 签名算法的标识。写进签名载荷, 便于将来换算法时旧载荷仍能被识别
// (而不是被当成"格式错误"丢掉审计线索)。
export const SIGNATURE_ALGORITHM = 'ed25519';

// 签名载荷的版本号。载荷格式变了就 bump, 验签方遇到不认识的版本 =>
// 明确拒绝 (fail-closed), 而不是"尽力而为地解析"。
export const SIGNATURE_PAYLOAD_VERSION = 1;

// keyId 的默认前缀 (便于在日志/审计里一眼认出这是发布签名)。
export const DEFAULT_KEY_ID_PREFIX = 'release';

// 公钥在 agent 侧的存放形态: base64 的 SPKI DER。
//   DER(44 字节) 比 PEM(64 字节) 短, 且 base64 后只有 60 个字符 ——
//   放进 appsettings.json / 源码常量都不难看。
export const PUBLIC_KEY_FORMAT = 'spki-der-base64';

// ------------------------------------------------------------------
// 载荷构造 / 解析
// ------------------------------------------------------------------

/**
 * 构造被签名的载荷对象 (canonical JSON ⇒ 签名对象的字节序列是确定的)。
 *
 * 字段:
 *   payloadVersion  载荷格式版本
 *   algorithm       签名算法标识
 *   keyId           签名密钥标识 (agent 用它选公钥)
 *   version         升级包版本号 (与 bundle.version 一致)
 *   gitCommit       构建提交号
 *   fileCount       文件数
 *   files           [{path, sha256}] 清单 —— **按 path 排序** ⇒ 顺序确定
 *
 * ★ 不含 base64: 见文件头说明。
 * ★ files 按 path 排序: 中心遍历目录的顺序受文件系统影响, 不排序的话
 *   同一个包在两次构建里可能产出不同的载荷字节 ⇒ 验签随机失败。
 *
 * @param {object} params
 * @param {string} params.version
 * @param {string} [params.gitCommit]
 * @param {string} [params.keyId]
 * @param {Array<{path: string, sha256: string}>} params.files
 * @returns {object} 载荷对象
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
 * 把载荷对象序列化成**确定性**的字节序列 (canonical JSON)。
 *
 * 为什么要自己写而不用 JSON.stringify:
 *   JSON.stringify 的键顺序 = 属性插入顺序。本模块的 buildSignaturePayload
 *   用固定顺序构造对象, 所以理论上 JSON.stringify 就是确定的 —— 但那个
 *   "理论上"依赖构造顺序, 一旦有人调整了对象字面量的属性顺序, 签名就会
 *   在**不破坏功能**的情况下静默失效 (验签失败, 表现为"包被拒")。
 *   ⇒ 这里显式按固定键序拼装, 把顺序变成契约的一部分。
 *
 * @param {object} payload
 * @returns {Buffer} 待签名的字节
 */
export function canonicalizePayload(payload) {
  const p = payload || {};
  // ★ 排序必须发生在这里, 而不是只在 buildSignaturePayload 里。
  //   签名方 (构建脚本) 用 buildSignaturePayload 造载荷; 验签方 (agent)
  //   用 bundle 里的文件清单**自己重建**载荷 —— 那个清单的顺序取决于
  //   中心遍历目录的顺序 (受文件系统影响), 跟签名方不一致。
  //   ⇒ 排序放在 canonicalizePayload 里 ⇒ 两侧各自算出的字节必然相同。
  //   (若只放在 buildSignaturePayload 里, 验签方重建的载荷顺序不同 ⇒
  //    字节不同 ⇒ 验签失败 —— 而且表现为"包被拒", 极难排查。)
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

// ------------------------------------------------------------------
// 签名 / 验签
// ------------------------------------------------------------------

/**
 * 用发布私钥给载荷签名。
 *
 * @param {object} params
 * @param {string|Buffer} params.privateKeyPem  PEM 或 DER 编码的私钥
 * @param {object} params.payload              buildSignaturePayload 的产物
 * @returns {{signature: string, payload: object, payloadBytesHex: string}}
 *          signature = base64(64 字节原始签名)
 */
export function signPayload({ privateKeyPem, payload }) {
  const key = createPrivateKey(privateKeyPem);
  const message = canonicalizePayload(payload);
  const raw = cryptoSign(null, message, key);
  return {
    signature: raw.toString('base64'),
    payload,
    payloadBytesHex: message.toString('hex')
  };
}

/**
 * 验签。
 *
 * ★ fail-closed: 任何一步不满足都返回 {ok:false}, **绝不**"尽力而为地
 *   通过"。调用方据此拒收整个包。
 *
 * @param {object} params
 * @param {object} params.payload        载荷对象 (agent 侧从 bundle 重建)
 * @param {string} params.signature      base64 签名
 * @param {string} params.publicKeyBase64  base64 SPKI DER 公钥
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyPayload({ payload, signature, publicKeyBase64 }) {
  if (typeof signature !== 'string' || signature.length === 0) {
    return { ok: false, reason: 'missing-signature' };
  }
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64.length === 0) {
    return { ok: false, reason: 'missing-public-key' };
  }
  const payloadVersion = Number(payload?.payloadVersion);
  if (!Number.isInteger(payloadVersion) || payloadVersion !== SIGNATURE_PAYLOAD_VERSION) {
    return { ok: false, reason: 'unsupported-payload-version' };
  }
  if (payload?.algorithm !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: 'unsupported-algorithm' };
  }
  if (!Array.isArray(payload?.files) || !Array.isArray(payload?.files)) {
    return { ok: false, reason: 'malformed-payload' };
  }
  // 文件清单里的每个 sha256 必须形如 64 位 hex —— 否则说明载荷被裁剪/
  // 伪造过, 拒绝 (不给"部分有效"留口子)。
  //   大小写: canonicalizePayload 会统一转小写, 所以**校验也要按小写
  //   比较** —— 否则一个纯大小写差异的载荷会被判成"畸形"而不是"签名
  //   不匹配", 掩盖真正的失败原因。
  for (const f of payload.files) {
    if (typeof f?.path !== 'string' || f.path.length === 0) {
      return { ok: false, reason: 'malformed-payload' };
    }
    if (typeof f?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
      return { ok: false, reason: 'malformed-payload' };
    }
  }
  let key;
  try {
    key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki'
    });
  } catch {
    return { ok: false, reason: 'malformed-public-key' };
  }
  let rawSig;
  try {
    rawSig = Buffer.from(signature, 'base64');
  } catch {
    return { ok: false, reason: 'malformed-signature' };
  }
  if (rawSig.length !== 64) {
    // Ed25519 签名恒为 64 字节; 长度不对直接拒 (不必进 verify)。
    return { ok: false, reason: 'malformed-signature' };
  }
  try {
    const ok = cryptoVerify(null, canonicalizePayload(payload), key, rawSig);
    return ok ? { ok: true, reason: null } : { ok: false, reason: 'signature-mismatch' };
  } catch {
    return { ok: false, reason: 'verify-threw' };
  }
}

// ------------------------------------------------------------------
// 密钥对生成 / 导入导出 (构建侧脚本用)
// ------------------------------------------------------------------

/**
 * 生成一对新的 Ed25519 密钥。
 *
 * @param {object} [opts]
 * @param {string} [opts.keyId] 密钥标识; 不传则随机生成
 * @returns {{keyId: string, privateKeyPem: string, publicKeyBase64: string}}
 */
export function generateKeyPair({ keyId = null } = {}) {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyId: keyId || `${DEFAULT_KEY_ID_PREFIX}-${randomBytes(4).toString('hex')}`,
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: publicDer.toString('base64')
  };
}

/**
 * 从私钥 PEM 推出公钥 base64 (SPKI DER)。
 *
 * 构建侧常见场景: 手里只有私钥文件, 需要把公钥写进 agent 树。
 *
 * @param {string|Buffer} privateKeyPem
 * @returns {string} base64 SPKI DER
 */
export function publicKeyFromPrivate(privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(key);
  return spki.export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * 计算一个 bundle 的"内容指纹" —— 用于日志/审计里快速比对两个包
 * 是否同一份 (不需要验签, 也不构成安全保证)。
 *
 * @param {Array<{path: string, sha256: string}>} files
 * @returns {string} 64 位 hex
 */
export function bundleFingerprint(files) {
  const payload = buildSignaturePayload({ version: '', keyId: '', files });
  return createHash('sha256').update(canonicalizePayload(payload)).digest('hex');
}

// ------------------------------------------------------------------
// wire 格式 (中心编码 / agent 解码)
// ------------------------------------------------------------------

/**
 * 编码成随 bundle 下发的签名块。
 *
 * wire 形状 (bundle.signature):
 *   {
 *     payloadVersion: 1,
 *     algorithm: 'ed25519',
 *     keyId: 'release-xxxxxxxx',
 *     version: '0.1.5',
 *     gitCommit: 'abc123',
 *     fileCount: 42,
 *     signature: '<base64, 88 字符>'
 *   }
 *
 * ★ 为什么把 payloadVersion / algorithm / keyId / version / gitCommit
 *   **原样**放进 wire, 而不只是发一个裸签名:
 *   agent 端必须**独立重建**载荷才能验签 (不能信任中心给的载荷)。
 *   重建需要: 载荷格式版本 + 算法 + keyId (选公钥) + 版本号 + gitCommit
 *   —— 这几个值 agent 侧无法自己得知 (gitCommit 只有中心知道, 除非
 *   agent 去解析 build-manifest.json, 但那是 bundle 里的一个文件, 它的
 *   sha256 本身也在被签名的清单里 ⇒ 循环)。
 *   ⇒ 中心把这几个字段作为**签名元数据**下发; agent 用它们重建载荷,
 *     再用自己的公钥验签。中心送来的这些字段本身也被签名覆盖
 *     (它们是载荷的一部分) ⇒ 改任何一个都会导致验签失败。
 *
 * @param {object} params
 * @param {string} params.version
 * @param {string} [params.gitCommit]
 * @param {string} params.keyId
 * @param {Array<{path: string, sha256: string}>} params.files
 * @param {string} params.privateKeyPem
 * @returns {object} wire 签名块
 */
export function encodeBundleSignature({ version, gitCommit = null, keyId, files, privateKeyPem }) {
  const payload = buildSignaturePayload({ version, gitCommit, keyId, files });
  const signed = signPayload({ privateKeyPem, payload });
  return {
    payloadVersion: payload.payloadVersion,
    algorithm: payload.algorithm,
    keyId: payload.keyId,
    version: payload.version,
    gitCommit: payload.gitCommit,
    fileCount: payload.fileCount,
    signature: signed.signature
  };
}

/**
 * 从 wire 签名块 + 实际收到的文件清单, **独立重建**载荷并验签。
 *
 * ★ 这是 agent 侧的入口。关键点: 载荷里的 files 用的是**实际收到的**
 *   文件清单 (bundle.files 的 path + sha256), 而不是中心送来的任何
 *   清单 —— 因为 base64 才是真正要被保护的内容。
 *   ⇒ 攻击者改了 base64 → 实际 sha256 对不上载荷 → 验签失败。
 *   ⇒ 攻击者连 sha256 一起改 → 载荷变了 → 验签失败。
 *   ⇒ 攻击者改 version/gitCommit → 载荷变了 → 验签失败。
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
  // 中心送来的 fileCount 必须与实际收到的文件数一致 —— 不一致说明中间
  // 少传/多传了文件 (或有人动过清单) ⇒ 拒收。
  if (Number(signatureBlock.fileCount) !== payload.fileCount) {
    return { ok: false, reason: 'file-count-mismatch', payload };
  }
  const verdict = verifyPayload({
    payload,
    signature: signatureBlock.signature,
    publicKeyBase64
  });
  return { ok: verdict.ok, reason: verdict.reason, payload };
}

