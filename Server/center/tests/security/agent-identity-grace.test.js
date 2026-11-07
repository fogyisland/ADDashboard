// R161.30 (2026-11-07) — S2 安全修复回归网: agent 身份签名 grace window 收紧为
// fail-closed (默认 0ms) + 环境变量逃生阀。
//
// ★ 背景: IDENTITY_GRACE_MS 原为固定 60s —— 每次 center 重启后存在一个
//   免签冒充窗口。排查确认全部在野 agent 树 (Server/agent + Server/noadagent)
//   的出站请求已统一盖 X-Agent-Signature (signedRequestJson / agentHttpGetBinary),
//   R161.29 单端口后老 Agent (硬编码 :8081/:8082) 本来就静默 404 ⇒ grace
//   已无保护对象, 收益为负 ⇒ 默认 0 (fail-closed), 仅操作员显式设置
//   ADDASHBOARD_AGENT_IDENTITY_GRACE_MS 时才开放窗口。
//
// 本文件锁住:
//   A. 默认 (无环境变量): 刚 _resetIdentityGraceForTests(Date.now()) 后,
//      无签名请求仍立即 401 'missing agent signature' (fail-closed 生效)
//   B. 逃生阀: 设置环境变量 + 重载模块 ⇒ 窗口内无签名放行 (到 next)
//   C. 窗口过期: 环境变量窗口过后无签名 ⇒ 401
//   D. 签名不匹配 ⇒ 401 'identity mismatch' 立即 (与 grace 无关)
//   E. 签名匹配 ⇒ req._agentIdentityBound 绑定 {hostname, agentId}
//   F. 源码级守卫: agent.js 出站 wrapper 必须统一走 signedRequestJson /
//      agentHttpGetBinary (保证 grace=0 不会打断真实 agent)
//
// 用法: cd Server/center && node --test tests/security/agent-identity-grace.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(CENTER_ROOT, '..', '..');

// token bundle 缓存是模块级 _cache — 每次重载后必须重新注入。
// db stub: db.sql.config.getAgentTokenBundle 不存在 ⇒ 走 FALLBACK_BUNDLE_SQL。
const TOKEN = 'a'.repeat(96);

function makeDbStub() {
  return {
    query: async (sql) => {
      if (/agent_token_current/.test(String(sql))) {
        return { rows: [{ config_key: 'agent_token_current', config_value: TOKEN }] };
      }
      return { rows: [] };
    }
  };
}

// 中间件直调构造器
function makeRes() {
  const out = { statusCode: null, body: null, nextCalled: false };
  return {
    out,
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
}

async function loadModuleWithEnv(envVal) {
  // ESM 无不重启注入方式: 用 query string cache-bust 重载模块,
  // 环境变量在 import 前设置 (IDENTITY_GRACE_MS 是模块加载期常量)。
  if (envVal === undefined) delete process.env.ADDASHBOARD_AGENT_IDENTITY_GRACE_MS;
  else process.env.ADDASHBOARD_AGENT_IDENTITY_GRACE_MS = envVal;
  const mod = await import(`../../src/auth/agent-token.js?grace=${envVal ?? 'unset'}`);
  return mod;
}

// 模拟一个带 body 的 req (POST 形态)
function makeReq({ token = TOKEN, sig, hostname = 'MOCKHOST', agentId = 'agent-1', body = { hostname } } = {}) {
  const headers = {
    'x-agent-token': token,
    'x-agent-hostname': hostname,
    'x-agent-id': agentId,
  };
  if (sig !== undefined) headers['x-agent-signature'] = sig;
  return { headers, body, path: '/api/agent/heartbeat' };
}

function sign(token, hostname, agentId, body) {
  return crypto.createHmac('sha256', token).update(message(hostname, agentId, body)).digest('hex');
}

function message(hostname, agentId, body) {
  const bodyStr = (body == null
    || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0))
    ? '' : stableJson(body);
  return `${hostname || ''}:${agentId || ''}:${bodyStr}`;
}

function stableJson(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

describe('R161.30 S2 — agent 身份签名 grace window fail-closed', () => {
  test('A. 默认 grace=0: 窗口重置后无签名请求仍立即 401', async () => {
    const { agentToken, _resetIdentityGraceForTests, invalidateAgentTokenCache } =
      await loadModuleWithEnv(undefined);
    invalidateAgentTokenCache();
    const mw = agentToken({ db: makeDbStub(), logger: { warn() {} } });
    _resetIdentityGraceForTests(Date.now()); // 刚"重启"
    const res = makeRes();
    await mw(makeReq({ sig: undefined }), res, () => { res.out.nextCalled = true; });
    assert.equal(res.out.statusCode, 401, 'grace=0 时无签名必须 401');
    assert.deepEqual(res.out.body, { error: 'missing agent signature' });
    assert.equal(res.out.nextCalled, false, '不得放行到下游');
  });

  test('B. 逃生阀: 设置环境变量后窗口内无签名放行', async () => {
    const { agentToken, _resetIdentityGraceForTests, invalidateAgentTokenCache } =
      await loadModuleWithEnv('60000');
    invalidateAgentTokenCache();
    const mw = agentToken({ db: makeDbStub(), logger: { warn() {} } });
    _resetIdentityGraceForTests(Date.now());
    const res = makeRes();
    await mw(makeReq({ sig: undefined }), res, () => { res.out.nextCalled = true; });
    assert.equal(res.out.nextCalled, true, '窗口内无签名应放行 (逃生阀)');
    assert.equal(res.out.statusCode, null, '放行时不得写 status');
  });

  test('C. 逃生阀窗口过期后无签名 ⇒ 401', async () => {
    const { agentToken, _resetIdentityGraceForTests, invalidateAgentTokenCache } =
      await loadModuleWithEnv('60000');
    invalidateAgentTokenCache();
    const mw = agentToken({ db: makeDbStub(), logger: { warn() {} } });
    _resetIdentityGraceForTests(Date.now() - 61000); // 61s 前"重启"
    const res = makeRes();
    await mw(makeReq({ sig: undefined }), res, () => { res.out.nextCalled = true; });
    assert.equal(res.out.statusCode, 401, '窗口过期必须 401');
  });

  test('D. 签名不匹配 ⇒ 401 identity mismatch (与 grace 无关)', async () => {
    const { agentToken, _resetIdentityGraceForTests, invalidateAgentTokenCache } =
      await loadModuleWithEnv('60000');
    invalidateAgentTokenCache();
    const mw = agentToken({ db: makeDbStub(), logger: { warn() {} } });
    _resetIdentityGraceForTests(Date.now());
    const req = makeReq({ sig: 'f'.repeat(64) });
    const res = makeRes();
    await mw(req, res, () => { res.out.nextCalled = true; });
    assert.equal(res.out.statusCode, 401);
    assert.deepEqual(res.out.body, { error: 'identity mismatch' });
  });

  test('E. 签名匹配 ⇒ _agentIdentityBound 绑定 + 放行', async () => {
    const { agentToken, _resetIdentityGraceForTests, invalidateAgentTokenCache } =
      await loadModuleWithEnv(undefined);
    invalidateAgentTokenCache();
    const mw = agentToken({ db: makeDbStub(), logger: { warn() {} } });
    _resetIdentityGraceForTests(Date.now());
    const bound = {};
    const req = makeReq({ sig: sign(TOKEN, 'MOCKHOST', 'agent-1', { hostname: 'MOCKHOST' }) });
    const res = makeRes();
    await mw(req, res, () => { res.out.nextCalled = true; });
    assert.equal(res.out.nextCalled, true);
    assert.deepEqual(req._agentIdentityBound, { hostname: 'MOCKHOST', agentId: 'agent-1' });
    assert.ok(bound);
  });

  test('F. 源码级守卫: agent 出站 wrapper 必须统一盖签名', () => {
    // signedRequestJson 实体在 agent/src/reporter.js; agent.js 只是 import
    // 并把它注入各 drainer。agentHttpGetBinary 在 agent.js 手工盖签名。
    const reporterSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'agent', 'src', 'reporter.js'), 'utf8');
    assert.match(reporterSrc, /function\s+signedRequestJson/,
      'reporter.js 必须有 signedRequestJson wrapper');
    assert.match(reporterSrc, /X-Agent-Signature/,
      'signedRequestJson 必须盖 X-Agent-Signature');
    const agentSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'agent', 'agent.js'), 'utf8');
    assert.match(agentSrc, /import\s*\{[^}]*signedRequestJson[^}]*\}\s*from\s*'\.\/src\/reporter\.js'/,
      'agent.js 必须 import signedRequestJson');
    assert.match(agentSrc, /agentHttpGetBinary[\s\S]{0,2000}?X-Agent-Signature/,
      'agentHttpGetBinary 必须盖 X-Agent-Signature');
  });
});
