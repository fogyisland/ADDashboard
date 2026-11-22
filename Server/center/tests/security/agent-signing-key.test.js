// R161.34 (2026-11-07) — A-F1 回归网: per-agent 签名密钥 (打破"共享 token +
// 自报 hostname"的循环论证)。
//
// ★ 漏洞本体:
//   中心与 agent 之间只有**一份全局共享**的 agent token。S82 的签名
//     X-Agent-Signature = HMAC-SHA256(token, hostname + ':' + agentId + ':' + body)
//   里的 hostname / agentId **全部由请求方自报** ⇒
//   用 A 的合法 token + 伪造的 hostname=B, 可以算出**完全合法**的签名
//   (密钥全局共享 ⇒ 谁都会签) ⇒ 循环论证。
//   ⇒ 后果不是"多看一条报表": member-commands 的 params.script 是**自由
//     格式 PowerShell 全文** ⇒ 跨机领取命令 ≈ 任意代码执行。
//
// ★ 为什么"绑定表"方案不成立 (本文件锁住这个判断, 防止有人改回去):
//   全 fleet 共用一把 token ⇒ A 和 B 的签名用**同一把钥匙**算 ⇒ 中心看到
//   (hostname=B, agentId=B) 的合法签名时, **无法区分**"这是 B 发的"与
//   "这是 A 拿着共享 token 冒充 B 发的" ⇒ 绑定表只能事后审计, 拦不住请求。
//   ⇒ 唯一解法 = per-agent 密钥 + 中心按 agentId 反查重算。
//
// 本文件锁住:
//   A. 两棵 agent 树的 signRequest 必须支持 signingKey (且**优先**于 token)
//   B. 两棵树必须有 per-agent 密钥的 delivery 模块 + config 默认值 +
//      reporter 的缓存 setter + boot 时的灌入
//   C. 中心端验签: per-agent 密钥优先 + 吊销拒绝 + **DB 故障 fail-closed**
//   D. 端到端: 用 B 的密钥签的请求, 中心按 agentId 反查后**能**验过;
//      用共享 token 签的, 在 B 已有 per-agent 密钥时**验不过** (⇒ 冒充被拦)
//   E. 中心侧 SQL registry / service 的关键契约
//
// 用法: cd Server/center && node --test tests/security/agent-signing-key.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const TREES = ['agent', 'noadagent'];
const KEY_HEX = 'a'.repeat(96);
const TOKEN_HEX = 'b'.repeat(96);

function treePath(tree, ...rest) {
  return path.join(SERVER_ROOT, tree, ...rest);
}

describe('R161.34 A-F1 — per-agent 签名密钥', () => {
  // ── A. 签名器必须支持 per-agent 密钥 ──────────────────────────────────
  test('A1. 两棵树的 signRequest 必须支持 signingKey 且优先于 token', async () => {
    for (const tree of TREES) {
      const url = pathToFileURL(treePath(tree, 'src', 'lib', 'agent-identity.js')).href;
      const { signRequest } = await import(url);

      const args = { hostname: 'HOST-B', agentId: 'agent-b', body: { z: 1, a: 2 } };

      // 用 per-agent 密钥签 ⇒ 必须是那把密钥算出来的
      const withKey = signRequest({ ...args, token: TOKEN_HEX, signingKey: KEY_HEX });
      const expectedByKey = crypto
        .createHmac('sha256', KEY_HEX)
        .update('HOST-B:agent-b:{"a":2,"z":1}')
        .digest('hex');
      assert.equal(withKey, expectedByKey,
        `${tree}: signingKey 必须优先于 token (签名消息不变, 只换密钥)`);

      // 用共享 token 签 ⇒ 必须是 token 算出来的 (存量 agent 路径不变)
      const withToken = signRequest({ ...args, token: TOKEN_HEX });
      const expectedByToken = crypto
        .createHmac('sha256', TOKEN_HEX)
        .update('HOST-B:agent-b:{"a":2,"z":1}')
        .digest('hex');
      assert.equal(withToken, expectedByToken,
        `${tree}: 没有 signingKey 时必须回退共享 token`);

      // 两把密钥算出的签名**必须不同** ⇒ 这正是切断冒充的关键
      assert.notEqual(withKey, withToken,
        `${tree}: per-agent 密钥与共享 token 的签名必须不同`);
    }
  });

  test('A2. signingKey 缺失/空串时必须回退 token (不抛异常)', async () => {
    for (const tree of TREES) {
      const url = pathToFileURL(treePath(tree, 'src', 'lib', 'agent-identity.js')).href;
      const { signRequest } = await import(url);
      const args = { hostname: 'H', agentId: 'A', body: null, token: TOKEN_HEX };
      const expected = crypto
        .createHmac('sha256', TOKEN_HEX).update('H:A:').digest('hex');
      assert.equal(signRequest(args), expected, `${tree}: 无 signingKey ⇒ 用 token`);
      assert.equal(signRequest({ ...args, signingKey: '' }), expected,
        `${tree}: 空串 signingKey ⇒ 用 token`);
      assert.equal(signRequest({ ...args, signingKey: undefined }), expected,
        `${tree}: undefined signingKey ⇒ 用 token`);
      assert.equal(signRequest({ ...args, signingKey: null }), expected,
        `${tree}: null signingKey ⇒ 用 token`);
      // 签名消息本身**不能**因为换了密钥而变 (否则中心端两条验签路径无法共用构造)
      assert.ok(signRequest({ ...args, signingKey: KEY_HEX }).length === 64,
        `${tree}: 签名必须是 64 hex 字符`);
    }
  });

  // ── B. agent 侧的分发链必须完整 ───────────────────────────────────────
  test('B1. 两棵树必须有 delivery 模块 + config 默认值 + reporter setter + boot 灌入', () => {
    for (const tree of TREES) {
      // B1.1 delivery 模块存在且含单调版本守卫
      const deliveryPath = treePath(tree, 'src', 'agent-signing-key-delivery.js');
      assert.ok(fs.existsSync(deliveryPath), `${tree}: 缺 agent-signing-key-delivery.js`);
      const delivery = fs.readFileSync(deliveryPath, 'utf8');
      assert.match(delivery, /export async function applyAgentSigningKeyDelivery/,
        `${tree}: delivery 必须导出 applyAgentSigningKeyDelivery`);
      assert.match(delivery, /incomingVersion <= Number\(config\.agentSigningKeyVersion \|\| 0\)/,
        `${tree}: delivery 必须有单调版本守卫 (乱序响应不得降级密钥)`);
      assert.match(delivery, /writeAppsettingsPatchAtomic/,
        `${tree}: delivery 必须走原子写`);

      // B1.2 config DEFAULTS 有 agentSigningKey / agentSigningKeyVersion
      const config = fs.readFileSync(treePath(tree, 'src', 'config.js'), 'utf8');
      assert.match(config, /agentSigningKey:\s*''/,
        `${tree}: config DEFAULTS 必须有 agentSigningKey: ''`);
      assert.match(config, /agentSigningKeyVersion:\s*0/,
        `${tree}: config DEFAULTS 必须有 agentSigningKeyVersion: 0`);

      // B1.3 reporter 有模块级缓存 + setter
      const reporter = fs.readFileSync(treePath(tree, 'src', 'reporter.js'), 'utf8');
      assert.match(reporter, /export function _setAgentSigningKey/,
        `${tree}: reporter 必须导出 _setAgentSigningKey`);
      assert.match(reporter, /export function _getAgentSigningKey/,
        `${tree}: reporter 必须导出 _getAgentSigningKey (package-manager 惰性取)`);
      assert.match(reporter, /signingKey:\s*signingKey \|\| _agentSigningKey/,
        `${tree}: signedRequestJson 必须优先用显式 signingKey, 否则用缓存`);

      // B1.4 agent.js boot 时把盘上的密钥灌进缓存
      const agentJs = fs.readFileSync(treePath(tree, 'agent.js'), 'utf8');
      assert.match(agentJs, /_setAgentSigningKey\(config\.agentSigningKey \|\| ''\)/,
        `${tree}: agent.js boot 必须灌 _setAgentSigningKey (重启后立即用专属密钥)`);

      // B1.5 编排器接线 (三处: makeSendCallback + 两处 inline)
      const cb = fs.readFileSync(treePath(tree, 'src', 'heartbeat-callbacks.js'), 'utf8');
      assert.match(cb, /applyAgentSigningKeyDelivery/,
        `${tree}: makeSendCallback 必须接受 applyAgentSigningKeyDelivery`);
      assert.match(cb, /applySigningKey:\s*applyAgentSigningKeyDelivery/,
        `${tree}: makeSendCallback 必须把 applySigningKey 传给编排器`);
      const orch = fs.readFileSync(treePath(tree, 'src', 'heartbeat-deliveries.js'), 'utf8');
      assert.match(orch, /applySigningKey/,
        `${tree}: 编排器必须支持 applySigningKey 参数`);
    }
  });

  test('B2. agent 侧必须覆盖所有出站签名点 (不得有漏网的共享 token 签名)', () => {
    for (const tree of TREES) {
      // B2.1 agent.js 的二进制 GET
      //   ★ 必须锚在**真正的调用点**上 (函数定义 + signRequest 调用),
      //   不能只搜 'X-Agent-Signature' —— 文件顶部的 import 注释里也有
      //   这个字符串, 会命中注释而不是代码。
      const agentJs = fs.readFileSync(treePath(tree, 'agent.js'), 'utf8');
      const fnIdx = tree === 'agent'
        ? agentJs.indexOf('async function agentHttpGetBinary')
        : agentJs.indexOf('const httpGetBinary =');
      assert.notEqual(fnIdx, -1, `${tree}: agent.js 必须有二进制 GET 包装器`);
      const binBlock = agentJs.slice(fnIdx, fnIdx + 2500);
      assert.match(binBlock, /X-Agent-Signature/,
        `${tree}: 二进制 GET 必须盖 X-Agent-Signature`);
      assert.match(binBlock, /signingKey/,
        `${tree}: 二进制 GET 的签名必须带 per-agent 密钥`);

      // B2.2 reporter 的 fetchConfig (GET 空体)
      const reporter = fs.readFileSync(treePath(tree, 'src', 'reporter.js'), 'utf8');
      const fetchIdx = reporter.indexOf('export function fetchConfig');
      assert.notEqual(fetchIdx, -1, `${tree}: reporter 必须有 fetchConfig`);
      const fetchBlock = reporter.slice(fetchIdx, fetchIdx + 1500);
      assert.match(fetchBlock, /signingKey:\s*_agentSigningKey/,
        `${tree}: fetchConfig 的签名必须用 per-agent 密钥`);
    }
    // B2.3 AD 树专属: package-manager 注入给 collect.ps1 的签名
    const pm = fs.readFileSync(treePath('agent', 'src', 'package-manager.js'), 'utf8');
    const sigIdx = pm.indexOf('AGENT_AUTH_SIGNATURE:');
    assert.notEqual(sigIdx, -1, 'AD 树必须注入 AGENT_AUTH_SIGNATURE');
    const sigBlock = pm.slice(sigIdx, sigIdx + 500);
    assert.match(sigBlock, /signingKey:\s*_getAgentSigningKey\(\)/,
      'AD package-manager 的签名必须惰性取 per-agent 密钥 (构造时可能还没有)');
  });

  // ── C. 中心端验签的 fail-closed 纪律 ─────────────────────────────────
  test('C1. 中心端中间件: per-agent 独占 + 吊销拒绝 + DB 故障 fail-closed', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'auth', 'agent-token.js'), 'utf8');

    // C1.1 必须按 agentId 反查
    assert.match(src, /lookupSigningKey/,
      '中心端必须按 agentId 反查该机的 per-agent 密钥');
    // C1.2 per-agent 密钥验签**优先**
    const perAgentIdx = src.indexOf('if (perAgent.key)');
    assert.notEqual(perAgentIdx, -1, '中心端必须先用 per-agent 密钥验签');
    // C1.3 ★★★ 该机已有 per-agent 密钥时**不得**回退共享 token。
    //   这是本批最容易写错的地方: 早期实现是 "per-agent 验签 → 失败则回退
    //   共享 token" ⇒ 共享 token 是全 fleet 共用的 ⇒ 任何机器都能用它算出
    //   任意 agentId 的合法签名 ⇒ per-agent 保护被完全绕过。
    //   (端到端测试 tests/security/agent-signing-key-e2e.test.js 抓到过这个
    //    漏洞 —— 源码级断言当时没锁住, 因为它锁的是"回退存在", 而不是
    //    "回退只在**没有** per-agent 密钥时才允许"。)
    const perAgentBlock = src.slice(perAgentIdx, perAgentIdx + 1200);
    assert.doesNotMatch(perAgentBlock, /if \(!ok\)[\s\S]{0,300}?token:\s*activeToken/,
      '★ 该机已有 per-agent 密钥时**绝不能**回退共享 token 验签 (否则保护形同虚设)');
    // 共享 token 验签必须落在 **else** 分支 (该机没有 per-agent 密钥时)
    assert.match(perAgentBlock, /}\s*else\s*\{[\s\S]{0,300}?token:\s*activeToken/,
      '共享 token 验签必须只在 else 分支 (该机没有 per-agent 密钥的存量路径)');
    // C1.4 吊销 ⇒ 一律 401 (且**不**落到共享 token 回退)
    assert.match(src, /if \(perAgent\.revoked\)[\s\S]{0,400}?401/,
      '已吊销的机器必须一律 401');
    assert.match(src, /agent signing key revoked/,
      '吊销必须返回可辨识的错误');
    // C1.5 DB 查询失败 ⇒ 503, **绝不**降级成共享 token 验签
    assert.match(src, /if \(perAgent\.lookupFailed\)[\s\S]{0,200}?503/,
      'per-agent 密钥查询失败必须 503 (fail-closed), 不得降级');
    assert.doesNotMatch(
      src,
      /if \(perAgent\.lookupFailed\)[\s\S]{0,400}?verifySignature/,
      'lookupFailed 分支绝不能走到验签 (那等于一次 DB 抖动就打开冒充窗口)'
    );
  });

  test('C2. 中心端 service: 吊销的机器不能被自动发放绕过', () => {
    const src = fs.readFileSync(
      path.join(CENTER_ROOT, 'src', 'services', 'agent-signing-key.js'), 'utf8');
    assert.match(src, /if \(ensured\.revoked\)[\s\S]{0,300}?return null/,
      '已吊销的机器不许在 heartbeat 里被重新发放密钥');
    assert.match(src, /export async function lookupSigningKey/);
    assert.match(src, /export async function ensureSigningKey/);
    assert.match(src, /export async function rotateSigningKey/);
    assert.match(src, /export async function revokeSigningKey/);
    assert.match(src, /export async function unrevokeSigningKey/);
  });

  test('C3. 中心端 SQL registry: 双方言形状 + 清单不含明文密钥', async () => {
    const url = pathToFileURL(
      path.join(CENTER_ROOT, 'src', 'db', 'sql', 'agent-signing-keys.js')).href;
    const { agentSigningKeys } = await import(url);

    for (const dialect of ['mysql', 'mssql']) {
      const set = agentSigningKeys[dialect];
      assert.ok(set, `缺少 ${dialect} 方言`);
      for (const key of ['findByAgent', 'upsert', 'touch', 'revoke', 'unrevoke', 'listAll']) {
        assert.ok(typeof set[key] === 'string' && set[key].length > 0,
          `${dialect}.${key} 必须是非空 SQL 字符串`);
      }
      // MSSQL 侧字符串参数必须 CAST (否则隐式转换让索引失效)
      if (dialect === 'mssql') {
        assert.match(set.findByAgent, /CAST\(\? AS VARCHAR\(64\)\)/,
          'mssql findByAgent 必须 CAST 字符串参数');
        assert.match(set.upsert, /MERGE INTO/,
          'mssql upsert 必须用 MERGE');
      } else {
        assert.match(set.upsert, /ON DUPLICATE KEY UPDATE/,
          'mysql upsert 必须用 ON DUPLICATE KEY UPDATE');
      }
    }
    // 清单绝不能带明文密钥
    for (const dialect of ['mysql', 'mssql']) {
      assert.doesNotMatch(agentSigningKeys[dialect].listAll, /signing_key\b(?!\s*,?\s*$)/,
        `${dialect}.listAll 不得 SELECT 明文 signing_key`);
      assert.match(agentSigningKeys[dialect].listAll, /key_version/,
        `${dialect}.listAll 必须带 key_version (版本可见)`);
    }
  });

  // ── D. 端到端: 中心按 agentId 反查 ⇒ 冒充被拦 ───────────────────────
  test('D1. 中心按 agentId 反查重算: 正确密钥过, 共享 token 冒充被拦', async () => {
    const identityUrl = pathToFileURL(
      treePath('agent', 'src', 'lib', 'agent-identity.js')).href;
    const { signRequest } = await import(identityUrl);

    // 中心侧的验签构造 (与 src/auth/agent-token.js 的 expectedSignature 同构)
    const stableJson = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
      return '{' + Object.keys(v).sort()
        .map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
    };
    const centerVerify = ({ sig, key, hostname, agentId, body }) => {
      const bodyStr = (body == null
        || (typeof body === 'object' && !Array.isArray(body)
          && Object.keys(body).length === 0))
        ? '' : stableJson(body);
      const expected = crypto.createHmac('sha256', key)
        .update(`${hostname || ''}:${agentId || ''}:${bodyStr}`).digest('hex');
      return expected === sig;
    };

    const hostname = 'HOST-B';
    const agentId = 'agent-b';
    const body = { kind: 'heartbeat', value: 42 };

    // ★ 场景: fleet 里 B 已经有 per-agent 密钥 (中心库里 keyB)。
    const keyB = 'c'.repeat(96);
    const keyA = 'd'.repeat(96);

    // 1) B 自己签 (用 B 的密钥) ⇒ 中心反查到 keyB ⇒ 验过
    const sigByB = signRequest({ hostname, agentId, body, token: TOKEN_HEX, signingKey: keyB });
    assert.ok(centerVerify({ sig: sigByB, key: keyB, hostname, agentId, body }),
      'B 用自己的密钥签 ⇒ 中心必须验过');

    // 2) ★ A 拿到**共享 token**, 伪造 hostname=B / agentId=B 签 ⇒ 验不过
    //    (这正是 A-F1 漏洞的核心场景)
    const sigForgedByA = signRequest({ hostname, agentId, body, token: TOKEN_HEX });
    assert.ok(!centerVerify({ sig: sigForgedByA, key: keyB, hostname, agentId, body }),
      '★ 用共享 token 冒充 B 的签名必须被中心拒绝 (否则 A-F1 未修复)');
    // 并且它**只**在用共享 token 时才成立 —— 换成 B 的密钥就过
    assert.ok(centerVerify({ sig: sigForgedByA, key: TOKEN_HEX, hostname, agentId, body }),
      '共享 token 签的签名对共享 token 路径仍有效 (存量兼容)');

    // 3) A 拿到 A 自己的密钥, 冒用 B 的身份 ⇒ 也验不过 (跨机不可代签)
    const sigByA = signRequest({ hostname, agentId, body, token: TOKEN_HEX, signingKey: keyA });
    assert.ok(!centerVerify({ sig: sigByA, key: keyB, hostname, agentId, body }),
      '★ 用 A 的密钥冒充 B 必须被拒绝 (跨机代签不可行)');

    // 4) A 用 A 的密钥签 A 自己的身份 ⇒ 验过 (每台机器各自工作正常)
    const sigAOwn = signRequest({
      hostname: 'HOST-A', agentId: 'agent-a', body, token: TOKEN_HEX, signingKey: keyA
    });
    assert.ok(centerVerify({ sig: sigAOwn, key: keyA, hostname: 'HOST-A', agentId: 'agent-a', body }),
      'A 用自己的密钥签自己的身份必须通过');
  });

  test('D2. 中心端 heartbeat 必须下发 per-agent 密钥 (两条运行时分支都要)', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'routes', 'agent.js'), 'utf8');
    // 调用点形态 (import 行是 `buildSigningKeyDelivery,` 不带括号, 不会被计入)
    const calls = src.match(/buildSigningKeyDelivery\(db/g) || [];
    assert.equal(calls.length, 2,
      `AD + 非AD 两条运行时分支各一处调用, 实际 ${calls.length} 处`);
    // 两条分支都必須把下发载荷**并进响应体** (否则 agent 收不到)
    const spreads = src.match(/\.\.\.\(\s*(signingKeyDelivery|agentSigningKeyDelivery)\s*\|\|\s*\{\}\s*\)/g) || [];
    assert.equal(spreads.length, 2,
      `两条分支都必须把下发载荷并进响应体, 实际 ${spreads.length} 处`);
    assert.match(src, /agentSigningKeyVersion/,
      '响应必须带 agentSigningKeyVersion (agent 用它做单调守卫)');
    // touchSigningKey (last_seen_at) 也要接上
    assert.match(src, /touchSigningKey\(/,
      '中心必须更新 last_seen_at (运维可见性)');
  });

  // ── E. 迁移文件与基线的一致性 ─────────────────────────────────────────
  test('E1. 迁移文件 + 基线必须四处齐备 (mysql/mssql 增量 + 双方言基线)', () => {
    const mysqlInc = path.join(SERVER_ROOT, 'db', 'migrations', 'mysql', '1.0.7-agent-signing-keys.sql');
    const mssqlInc = path.join(SERVER_ROOT, 'db', 'migrations', 'mssql', '1.0.12-agent-signing-keys.sql');
    assert.ok(fs.existsSync(mysqlInc), '缺 mysql 增量迁移');
    assert.ok(fs.existsSync(mssqlInc), '缺 mssql 增量迁移');

    const mysqlSql = fs.readFileSync(mysqlInc, 'utf8');
    assert.match(mysqlSql, /--\s*verify:\s*table\s+agent_signing_keys/,
      'mysql 迁移必须带 verify 标记 (table)');
    assert.match(mysqlSql, /agent_signing_keys/);
    assert.match(mysqlSql, /revoked_at/);

    const mssqlSql = fs.readFileSync(mssqlInc, 'utf8');
    assert.match(mssqlSql, /--\s*verify:\s*table\s+agent_signing_keys/,
      'mssql 迁移必须带 verify 标记 (table)');
    assert.match(mssqlSql, /agent_signing_keys/);

    // 两个基线都必须有这张表
    for (const [dialect, file] of [
      ['mysql', path.join(SERVER_ROOT, 'db', 'migrations', 'mysql', '1.0.0-baseline.sql')],
      ['mssql', path.join(SERVER_ROOT, 'db', 'migrations', 'mssql', '1.0.0-baseline.sql')]
    ]) {
      const base = fs.readFileSync(file, 'utf8');
      assert.match(base, /agent_signing_keys/,
        `${dialect} 基线必须有 agent_signing_keys 表`);
      assert.match(base, /signing_key/);
      assert.match(base, /revoked_at/);
    }
  });

  test('E2. 增量迁移的版本号必须与既有迁移不冲突且高于基线之后', () => {
    const mysqlDir = path.join(SERVER_ROOT, 'db', 'migrations', 'mysql');
    const mssqlDir = path.join(SERVER_ROOT, 'db', 'migrations', 'mssql');
    const mysqlVersions = fs.readdirSync(mysqlDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('-')[0]);
    const mssqlVersions = fs.readdirSync(mssqlDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('-')[0]);
    assert.equal(new Set(mysqlVersions).size, mysqlVersions.length,
      'mysql 迁移版本号不得重复');
    assert.equal(new Set(mssqlVersions).size, mssqlVersions.length,
      'mssql 迁移版本号不得重复');
    assert.ok(mysqlVersions.includes('1.0.7'), 'mysql 增量应为 1.0.7');
    assert.ok(mssqlVersions.includes('1.0.12'), 'mssql 增量应为 1.0.12');
  });
});
