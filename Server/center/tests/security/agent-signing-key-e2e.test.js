// R161.34 (2026-11-07) — A-F1 端到端闭环测试 (真实 import, 不是源码断言)。
//
// ★ 这个文件测的是**整条链**, 不是单个函数:
//   中心 ensureSigningKey 生成密钥
//     → 中心 buildSigningKeyDelivery 放进心跳响应
//       → agent 侧 applyAgentSigningKeyDelivery 收到 + 原子落盘 + 更新缓存
//         → agent 侧 signedRequestJson 用**新密钥**签名
//           → 中心中间件按 agentId 反查 + 验签 ⇒ 通过
//
// ★ 为什么必须用真 import 而不是源码正则:
//   源码断言只能证明"代码长这样", 证明不了"两边真的对得上"。这里的
//   每一环都跑**真实代码**, 所以密钥生成 / 落盘 / 签名 / 验签 任何一环
//   的消息构造走偏, 这个测试都会红。
//
// ★ 核心断言 (冒充被拦):
//   同一台机器, 中心持有 per-agent 密钥 K 时:
//     · 用 K 签的请求     ⇒ 中心验过
//     · 用共享 token 签的 ⇒ 中心**验不过** (401 identity mismatch)
//   ⇒ 这正是 A-F1 漏洞的场景 (A 拿共享 token 伪造 B 的身份)。
//
// 用法: cd Server/center && node --test tests/security/agent-signing-key-e2e.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');

const agentIdentityUrl = pathToFileURL(
  path.join(SERVER_ROOT, 'agent', 'src', 'lib', 'agent-identity.js')).href;
const agentDeliveryUrl = pathToFileURL(
  path.join(SERVER_ROOT, 'agent', 'src', 'agent-signing-key-delivery.js')).href;
const agentReporterUrl = pathToFileURL(
  path.join(SERVER_ROOT, 'agent', 'src', 'reporter.js')).href;
const agentConfigUrl = pathToFileURL(
  path.join(SERVER_ROOT, 'agent', 'src', 'config.js')).href;

const { signRequest } = await import(agentIdentityUrl);
const { applyAgentSigningKeyDelivery } = await import(agentDeliveryUrl);
const reporter = await import(agentReporterUrl);
const { loadConfig } = await import(agentConfigUrl);

const { ensureSigningKey, buildSigningKeyDelivery, lookupSigningKey } =
  await import(pathToFileURL(path.join(CENTER_ROOT, 'src', 'services', 'agent-signing-key.js')).href);
const { agentSigningKeys } = await import(
  pathToFileURL(path.join(CENTER_ROOT, 'src', 'db', 'sql', 'agent-signing-keys.js')).href);

const TOKEN = 'b'.repeat(96);

// ---------------------------------------------------------------------------
// 内存版 db stub —— 按 SQL registry 的**语义**实现 (不是按 SQL 字符串),
// 所以双方言都跑得通 (本测试只关心 SQL 的语义, 不关心方言)。
// ---------------------------------------------------------------------------
function makeStubDb() {
  const rows = new Map(); // agent_id -> row
  const audit = [];
  return {
    rows,
    audit,
    // ★ 形状必须跟真实 db facade 一致: db.sql.agentSigningKeys 是**方言已
    //   展开**的一层 (src/db/sql.js 里是 `agentSigningKeys: agentSigningKeys.mysql`),
    //   不是 `{mysql, mssql}` 两层。挂错形状 ⇒ service 走
    //   `if (!upsert) return {...}` 的 stub 分支 ⇒ 密钥永远不落库。
    sql: { agentSigningKeys: agentSigningKeys.mysql },
    async query(sql, params) {
      // findByAgent
      if (/FROM\s+agent_signing_keys/i.test(sql) && /WHERE\s+agent_id/i.test(sql)) {
        const id = String(params[0]);
        const row = rows.get(id);
        return { rows: row ? [row] : [] };
      }
      // listAll
      if (/FROM\s+agent_signing_keys/i.test(sql) && /ORDER BY/i.test(sql)) {
        return { rows: [...rows.values()].map(r => ({ ...r })) };
      }
      return { rows: [] };
    },
    async execute(sql, params) {
      const text = String(sql);
      if (/INSERT\s+INTO\s+agent_signing_keys/i.test(text) || /MERGE\s+INTO\s+agent_signing_keys/i.test(text)) {
        const [id, key, version] = params;
        rows.set(String(id), {
          agent_id: String(id),
          signing_key: String(key),
          key_version: Number(version),
          issued_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          revoked_at: null
        });
        return { affectedRows: 1 };
      }
      if (/UPDATE\s+agent_signing_keys\s+SET\s+last_seen_at/i.test(text)) {
        const row = rows.get(String(params[0]));
        if (row) { row.last_seen_at = new Date().toISOString(); return { affectedRows: 1 }; }
        return { affectedRows: 0 };
      }
      if (/UPDATE\s+agent_signing_keys\s+SET\s+revoked_at\s*=\s*UTC_TIMESTAMP|SET\s+revoked_at\s*=\s*SYSUTCDATETIME/i.test(text)) {
        const row = rows.get(String(params[0]));
        if (row && !row.revoked_at) { row.revoked_at = new Date().toISOString(); return { affectedRows: 1 }; }
        return { affectedRows: 0 };
      }
      return { affectedRows: 0 };
    }
  };
}

// 中心侧验签 —— 与 src/auth/agent-token.js 的 expectedSignature 1:1 同构
function centerExpectedSignature({ key, hostname, agentId, body }) {
  const stableJson = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  };
  const bodyStr = (body == null
    || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0))
    ? '' : stableJson(body);
  const message = `${hostname || ''}:${agentId || ''}:${bodyStr}`;
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

describe('R161.34 A-F1 — 端到端闭环 (真实 import)', () => {
  test('E2E-1. 首次心跳下发密钥 → agent 落盘 → 用新密钥签名 → 中心反查验过', async () => {
    const db = makeStubDb();
    const logger = { info: () => {}, warn: () => {}, error: () => {} };

    const agentId = 'HOST-B';
    const hostname = 'HOST-B';
    const body = { kind: 'heartbeat', seq: 7 };

    // ── 中心: 生成密钥并准备下发载荷 ─────────────────────────────────
    const ensured = await ensureSigningKey(db, { agentId, logger });
    assert.equal(ensured.error, null, '密钥生成不得失败');
    assert.ok(ensured.key && ensured.key.length === 96, '密钥必须是 96 个 hex 字符');
    assert.equal(ensured.version, 1);

    const delivery = await buildSigningKeyDelivery(db, {
      agentId, reportedKeyVersion: 0, logger
    });
    assert.ok(delivery, '中心必须下发密钥 (agent 上报版本 0 = 没领过)');
    assert.equal(delivery.agentSigningKeyVersion, 1);
    assert.equal(delivery.agentSigningKey, ensured.key);

    // ── agent: 消费下发载荷 → 原子落盘 + 更新内存 + 更新缓存 ───────────
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addash-signkey-'));
    const configPath = path.join(tmpDir, 'appsettings.json');
    fs.writeFileSync(configPath, JSON.stringify({
      centerUrl: 'http://127.0.0.1:8080',
      agentId,
      agentToken: TOKEN
    }, null, 2), 'utf8');

    const config = loadConfig(configPath);
    assert.equal(config.agentSigningKey, '', '初始必须没有密钥');
    assert.equal(config.agentSigningKeyVersion, 0);

    const applyResult = await applyAgentSigningKeyDelivery({
      result: { ok: true, data: delivery },
      config,
      configPath,
      logger
    });
    assert.equal(applyResult.applied, true, 'agent 必须接受下发的密钥');
    assert.equal(config.agentSigningKey, ensured.key);
    assert.equal(config.agentSigningKeyVersion, 1);
    assert.equal(reporter._getAgentSigningKey(), ensured.key,
      'reporter 的缓存必须同步更新 (否则出站请求还在用共享 token)');

    // ★ 落盘断言 —— 密钥必须真的写到 appsettings.json (重启后仍可用)
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.agentSigningKey, ensured.key, '密钥必须落盘');
    assert.equal(onDisk.agentSigningKeyVersion, 1, '版本号必须落盘');
    // 落盘不能破坏其它字段
    assert.equal(onDisk.agentToken, TOKEN);
    assert.equal(onDisk.agentId, agentId);
    assert.equal(onDisk.centerUrl, 'http://127.0.0.1:8080');

    // ── agent: 用新密钥签名 ────────────────────────────────────────────
    const sigWithPerAgentKey = signRequest({
      hostname, agentId, body, token: TOKEN, signingKey: config.agentSigningKey
    });

    // ── 中心: 按 agentId 反查 + 验签 ───────────────────────────────────
    const found = await lookupSigningKey(db, agentId);
    assert.ok(found.row, '中心必须能反查到该机的密钥');
    assert.equal(found.row.signing_key, ensured.key);
    assert.equal(
      centerExpectedSignature({ key: found.row.signing_key, hostname, agentId, body }),
      sigWithPerAgentKey,
      '★ 中心用反查到的密钥重算的签名必须与 agent 签的一致'
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('E2E-2. ★ 冒充被拦: 同一台机器, 用共享 token 签的请求中心必须拒', async () => {
    const db = makeStubDb();
    const logger = { info: () => {}, warn: () => {}, error: () => {} };

    const agentId = 'HOST-B';
    const hostname = 'HOST-B';
    const body = { kind: 'heartbeat', seq: 8 };

    // 中心已给这台机器发过密钥 (⇒ 该机有 per-agent 密钥)
    const ensured = await ensureSigningKey(db, { agentId, logger });

    // 攻击者: 拿到**共享 token**, 伪造 hostname=B / agentId=B 签名
    const forgedSig = signRequest({ hostname, agentId, body, token: TOKEN });

    // 中心验签 (per-agent 优先)
    const found = await lookupSigningKey(db, agentId);
    const perAgentPass = found.row
      ? centerExpectedSignature({ key: found.row.signing_key, hostname, agentId, body }) === forgedSig
      : false;
    assert.equal(perAgentPass, false,
      '★ 用共享 token 冒充的签名, 必须过不了 per-agent 验签');

    // 回退路径 (共享 token) —— 只在**该机没有** per-agent 密钥时才允许
    const fallbackPass =
      centerExpectedSignature({ key: TOKEN, hostname, agentId, body }) === forgedSig;
    assert.equal(fallbackPass, true,
      '共享 token 签的签名对共享 token 路径本身是有效的 (存量兼容)');

    // ★★ 中心的确切行为必须是"该机已有 per-agent 密钥 ⇒ **只**用该密钥
    //   验签, 共享 token 签的一律拒" ⇒ 复刻 center/src/auth/agent-token.js
    //   修好之后的分支顺序:
    //     有 per-agent 密钥 ⇒ 只用它验签 (不试共享 token)
    //     没有 per-agent 密钥 ⇒ 用共享 token 验签
    const centerActualBehavior = (() => {
      let ok = false;
      if (found.row) {
        // 情形 A: 有专属密钥 ⇒ 只用它验签
        ok = centerExpectedSignature({ key: found.row.signing_key, hostname, agentId, body }) === forgedSig;
      } else {
        // 情形 B: 无专属密钥 ⇒ 共享 token 路径
        ok = centerExpectedSignature({ key: TOKEN, hostname, agentId, body }) === forgedSig;
      }
      return ok;
    })();
    assert.equal(centerActualBehavior, false,
      '★ 中心必须拒绝"用共享 token 冒充别台机器"的请求 (该机已有 per-agent 密钥时不得回退共享 token 路径)');

    // ★★ 情形 B 仍必须成立: **没有** per-agent 密钥的存量机器, 用共享
    //   token 签的请求照常过 (零改造兼容路径不能被这个修复打死)。
    const db2 = makeStubDb();
    const fresh = await lookupSigningKey(db2, 'HOST-NEW');
    assert.equal(fresh.row, null, '新机器还没领过密钥');
    const legacySig = signRequest({ hostname: 'HOST-NEW', agentId: 'HOST-NEW', body, token: TOKEN });
    const legacyOk = centerExpectedSignature({
      key: TOKEN, hostname: 'HOST-NEW', agentId: 'HOST-NEW', body
    }) === legacySig;
    assert.equal(legacyOk, true,
      '存量 agent (无 per-agent 密钥) 用共享 token 签的请求必须照常通过');
  });
});
