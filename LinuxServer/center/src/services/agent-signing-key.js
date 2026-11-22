// R161.34 (2026-11-07) — per-agent 签名密钥 service (红队审计 A-F1, P1)
//
// ★ 这个 service 修的是什么漏洞:
//   中心与 agent 之间只有**一份全局共享**的 agent token。S82 的签名
//   X-Agent-Signature = HMAC(token, hostname + ':' + agentId + ':' + body)
//   ⇒ HMAC 只能证明"**持有 token 的人**签了这条请求", **不能**证明
//     "**这台机器**签了这条请求" —— hostname / agentId 全部由请求方自报。
//   ⇒ 循环论证: 用 A 的合法 token + 伪造的 hostname=B, 可以算出**完全
//     合法**的签名 (密钥全局共享, 谁都会签)。
//   ⇒ 后果不是"多看一条报表": member-commands 的 params.script 是
//     **自由格式 PowerShell 全文** ⇒ 跨机领取命令 ≈ 任意代码执行。
//
// ★ 本 service 的职责 (中心侧):
//   1. lookupSigningKey(agentId)   — 验签时按 agentId 反查该机的密钥
//   2. ensureSigningKey(agentId)   — 该机还没有密钥时生成一把并落库
//   3. rotateSigningKey(agentId)   — 轮换某台机器的密钥
//   4. revokeSigningKey(agentId)   — 吊销某台机器的密钥
//   5. listSigningKeys()           — 管理清单 (不含明文密钥!)
//
// ★★★ 为什么 per-agent 密钥能真正切断冒充, 而"绑定表"不能:
//   绑定表: 全 fleet 共用一把 token ⇒ A 和 B 的签名用**同一把钥匙**算 ⇒
//   中心看到 (hostname=B, agentId=B) 的合法签名时, **无法区分**
//   "这是 B 发的" 与 "这是 A 拿着共享 token 冒充 B 发的" ⇒ 拦不住。
//   per-agent 密钥: A 只有 A 的密钥 ⇒ 冒充者算不出 B 的签名 ⇒
//   中心的反查 (按 agentId 取 B 的密钥 → 重算 HMAC) 必然不匹配 ⇒ 401。
//
// ★ 存量部署的兼容路径 (零改造, 零分发链改动):
//   1. 存量 agent 第一次带签名的请求到达 ⇒ 中心按 agentId 生成密钥,
//      放进 heartbeat 响应下发。
//   2. agent 收到后原子落盘 (appsettings.json), 之后所有请求用它签名。
//   3. 中心验签时: 先按 agentId 查 per-agent 密钥验签; **查不到**才
//      回退到全局共享 token (那一刻该机还没领到密钥)。
//   ⇒ 未升级 agent 继续正常工作 (用共享 token 签名), 升级到含
//     per-agent 密钥支持的版本后自动切换 —— 无需操作员逐台改配置。
//
// ★★ 密钥的存储形态 (operator 2026-11-07 决定):
//   signing_key **明文**存 agent_signing_keys 表。理由:
//     中心必须能**重算** HMAC 才能验签 ⇒ 不能只存摘要 ⇒ 必须可逆。
//     这与现有的 agent_token_current (明文存 system_config) 是**同一个
//     风险面** (访问面 = 数据库访问面), 不引入**新的**风险类别。
//     ★ 不做"用中心主密钥加密后存": 中心重启后主密钥丢失 = 整个 fleet
//       同时掉线, 故障半径远大于收益。
//
// ★ 版本号 (key_version) 的作用:
//   跟 agent_token_version 同构 —— agent 用它判断"中心发来的比我手上的
//   新", 从而避免旧密钥反复覆盖新密钥 (乱序响应 ⇒ 降级)。
//   单调递增, 从 1 开始。

import { randomBytes } from 'node:crypto';
import { writeAudit, writeAuditRequired } from './audit.js';

// 密钥长度: 48 字节 = 384 bit (跟 agent_token_current 的 randomBytes(48)
//   同规格) ⇒ 96 个 hex 字符。
const KEY_BYTES = 48;
const KEY_HEX_LENGTH = KEY_BYTES * 2;

// 审计动作名 (跟 services/agent-token.js 的 taxonomy 并列, 一眼能看出
//   这是哪一类凭据操作)。
const ISSUE_AUDIT = 'issue_agent_signing_key';
const ROTATE_AUDIT = 'rotate_agent_signing_key';
const REVOKE_AUDIT = 'revoke_agent_signing_key';
const UNREVOKE_AUDIT = 'unrevoke_agent_signing_key';

/**
 * 读该机的密钥行。
 * @returns {Promise<{row: object|null, error: Error|null}>}
 */
export async function lookupSigningKey(db, agentId) {
  const id = String(agentId || '').trim();
  if (!id) return { row: null, error: null };
  const sql = db?.sql?.agentSigningKeys?.findByAgent;
  if (!sql) return { row: null, error: null };
  try {
    const res = await db.query(sql, [id]);
    const row = (res?.rows || [])[0] || null;
    return { row, error: null };
  } catch (e) {
    return { row: null, error: e };
  }
}

/**
 * 取该机密钥; 没有就生成一把并落库 (首次发放)。
 *
 * @param {object} db
 * @param {object} params
 * @param {string} params.agentId
 * @param {object} params.logger
 * @returns {Promise<{key: string|null, version: number, created: boolean, revoked: boolean, error: Error|null}>}
 *          key 为 null 且 error 非空 ⇒ DB 故障 (调用方必须 503, 不得 fail-open)
 */
export async function ensureSigningKey(db, { agentId, logger }) {
  const id = String(agentId || '').trim();
  if (!id) return { key: null, version: 0, created: false, revoked: false, error: null };

  const found = await lookupSigningKey(db, id);
  if (found.error) {
    logger?.error?.({ err: found.error.message, agentId: id }, 'agent signing key lookup failed');
    return { key: null, version: 0, created: false, revoked: false, error: found.error };
  }
  if (found.row) {
    const revoked = Boolean(found.row.revoked_at);
    return {
      key: found.row.signing_key,
      version: Number(found.row.key_version || 0),
      created: false,
      revoked,
      error: null
    };
  }

  // 首次发放: 生成密钥 + 落库。并发首发可能撞车 (两个请求都看到"没有") ——
  //   UPSERT 的冲突分支会把先落的那把覆盖掉, 后到的请求拿到的是**自己**
  //   那把 (它随后会用自己那把签名, 中心按 agentId 查到的是最后落库的那把)
  //   ⇒ 并发窗口内可能出现"该机刚领到的密钥立刻失效"。
  //   ⇒ 修法: 冲突时**重查一次**并用库里的那把 (库里的一定是有效的)。
  const key = randomBytes(KEY_BYTES).toString('hex');
  const version = 1;
  const upsert = db?.sql?.agentSigningKeys?.upsert;
  if (!upsert) {
    // 没有 registry 的 stub db: 返回生成值但不落库 (测试契约)。
    return { key, version, created: true, revoked: false, error: null };
  }
  try {
    await db.execute(upsert, [id, key, version]);
    await writeAudit({
      userId: null,
      action: ISSUE_AUDIT,
      target: id,
      payload: { agentId: id, keyVersion: version, keyLength: key.length },
      logger
    }, logger);
    logger?.info?.({ agentId: id, keyVersion: version }, 'issued per-agent signing key');
    // 重查一次: 若并发下别人已落了一把, 用库里那把 (保证 agent 拿到的一定
    //   是中心此刻持有的那把)。
    const recheck = await lookupSigningKey(db, id);
    if (!recheck.error && recheck.row?.signing_key) {
      return {
        key: recheck.row.signing_key,
        version: Number(recheck.row.key_version || version),
        created: true,
        revoked: Boolean(recheck.row.revoked_at),
        error: null
      };
    }
    return { key, version, created: true, revoked: false, error: null };
  } catch (e) {
    logger?.error?.({ err: e.message, agentId: id }, 'agent signing key issue failed');
    return { key: null, version: 0, created: false, revoked: false, error: e };
  }
}

/**
 * 轮换某台机器的密钥 (版本 +1, 换一把新的)。
 */
export async function rotateSigningKey(db, { agentId, logger, userId }) {
  const id = String(agentId || '').trim();
  if (!id) return { key: null, version: 0, error: null };
  const found = await lookupSigningKey(db, id);
  if (found.error) return { key: null, version: 0, error: found.error };
  if (!found.row) return { key: null, version: 0, error: null, notFound: true };

  const key = randomBytes(KEY_BYTES).toString('hex');
  const version = Number(found.row.key_version || 0) + 1;
  const upsert = db?.sql?.agentSigningKeys?.upsert;
  if (!upsert) return { key, version, error: null };
  try {
    await db.execute(upsert, [id, key, version]);
    await writeAuditRequired({
      userId,
      action: ROTATE_AUDIT,
      target: id,
      payload: { agentId: id, keyVersion: version },
      logger
    }, logger);
    logger?.info?.({ agentId: id, keyVersion: version }, 'rotated per-agent signing key');
    return { key, version, error: null };
  } catch (e) {
    logger?.error?.({ err: e.message, agentId: id }, 'agent signing key rotation failed');
    return { key: null, version: 0, error: e };
  }
}

/**
 * 吊销某台机器的密钥 —— 该机后续请求一律 401。
 */
export async function revokeSigningKey(db, { agentId, logger, userId }) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: null };
  const sql = db?.sql?.agentSigningKeys?.revoke;
  if (!sql) return { ok: true, error: null };
  try {
    const res = await db.execute(sql, [id]);
    const affected = Number(res?.affectedRows ?? 0);
    if (affected === 0) {
      // 已经是吊销态 (revoked_at 非 NULL) ⇒ 幂等, 不重复写审计。
      return { ok: true, alreadyRevoked: true, error: null };
    }
    await writeAuditRequired({
      userId,
      action: REVOKE_AUDIT,
      target: id,
      payload: { agentId: id, revokedAt: new Date().toISOString() },
      logger
    }, logger);
    return { ok: true, error: null };
  } catch (e) {
    logger?.error?.({ err: e.message, agentId: id }, 'agent signing key revoke failed');
    return { ok: false, error: e };
  }
}

/**
 * 解除吊销 (admin 决策) —— 机器修好后重新入网。
 */
export async function unrevokeSigningKey(db, { agentId, logger, userId }) {
  const id = String(agentId || '').trim();
  if (!id) return { ok: false, error: null };
  const sql = db?.sql?.agentSigningKeys?.unrevoke;
  if (!sql) return { ok: true, error: null };
  try {
    await db.execute(sql, [id]);
    await writeAudit({
      userId,
      action: UNREVOKE_AUDIT,
      target: id,
      payload: { agentId: id },
      logger
    }, logger);
    return { ok: true, error: null };
  } catch (e) {
    logger?.error?.({ err: e.message, agentId: id }, 'agent signing key unrevoke failed');
    return { ok: false, error: e };
  }
}

/**
 * 管理清单 —— **不含明文密钥**。
 *
 * ★ 为什么清单不带 signing_key: 它是凭据材料。本项目的设计契约是
 *   "凡是读凭据材料必留审计" (services/agent-token.js 的 fingerprint
 *   设计论证)。把明文挪到无审计的读路径上, 密码学上可忽略, 但**方向
 *   是错的**, 过不了安全评审。要看明文只能走专门的 reveal 端点
 *   (带审计)。
 */
export async function listSigningKeys(db) {
  const sql = db?.sql?.agentSigningKeys?.listAll;
  if (!sql) return { items: [], error: null };
  try {
    const res = await db.query(sql);
    return { items: res?.rows || [], error: null };
  } catch (e) {
    return { items: [], error: e };
  }
}

/**
 * 触碰该机的 last_seen_at (best-effort; 失败不影响请求)。
 */
export async function touchSigningKey(db, agentId) {
  const id = String(agentId || '').trim();
  const sql = db?.sql?.agentSigningKeys?.touch;
  if (!id || !sql) return;
  try {
    await db.execute(sql, [id]);
  } catch {
    // best-effort: 活跃时间只是运维可见性, 写不进去不该影响认证。
  }
}

/**
 * 构建 heartbeat 响应里的 per-agent 密钥下发载荷。
 *
 * ★ 什么时候下发:
 *   · 该机**还没有**密钥 ⇒ 首次发放 (ensureSigningKey 生成一把)
 *   · 该机**有**密钥但版本落后于中心 ⇒ 中心这边是权威 (轮换场景)
 *   · 该机已有当前版本的密钥 ⇒ 不下发 (省流量, 也避免无谓的落盘)
 *
 * ★ fail-soft 契约 (跟 agentTokenDelivery / agentSettingsDelivery 一致):
 *   密钥下发失败**绝不能**让 heartbeat 500 —— agent 的首要职责是上报,
 *   不是接收凭据。下发失败时返回 null, agent 继续用共享 token 通信
 *   (功能降级但不失能), 下一次 heartbeat 再试。
 *
 * @param {object} db
 * @param {object} params
 * @param {string} params.agentId
 * @param {number} [params.reportedKeyVersion] agent 上报的手上密钥版本
 * @param {object} params.logger
 * @returns {Promise<{agentSigningKey: string, agentSigningKeyVersion: number}|null>}
 */
export async function buildSigningKeyDelivery(db, { agentId, reportedKeyVersion, logger }) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  try {
    const ensured = await ensureSigningKey(db, { agentId: id, logger });
    if (ensured.error || !ensured.key) return null;
    if (ensured.revoked) {
      // 已吊销的机器不拿新密钥 (吊销是 admin 决策, 不能被自动发放绕过)。
      logger?.warn?.({ agentId: id }, 'revoked agent requested a signing key — not reissued');
      return null;
    }
    const reported = Number(reportedKeyVersion || 0);
    if (reported === ensured.version && ensured.created === false) {
      // 该机手上已经是当前版本 ⇒ 不下发。
      return null;
    }
    return { agentSigningKey: ensured.key, agentSigningKeyVersion: ensured.version };
  } catch (e) {
    logger?.warn?.({ err: e.message, agentId: id }, 'signing key delivery build failed (fail-soft)');
    return null;
  }
}

export { KEY_HEX_LENGTH };
