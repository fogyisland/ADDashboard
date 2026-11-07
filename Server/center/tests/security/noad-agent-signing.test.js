// R161.30 (2026-11-07) — S3 安全修复回归网: noad agent 文件下载签名 + 中间件
// 身份绑定在 4 个领取/下载端点的一致性。
//
// ★ 背景 (S3 排查结论): noadagent/agent.js 的 httpGetBinary 是 R158.75 fork
//   时的漏项 —— 只抄走了 Buffer-collecting GET, 没抄 AD 树的签名四头注入,
//   而且引用了未定义的 httpsRequest/httpRequest (真跑必 ReferenceError,
//   node --check 测不出 —— 变量在运行期才解析)。S2 把 grace 收紧为 0 后,
//   无签名下载 = 401 'missing agent signature', 成员服务器永远下载不到文件。
//   修复 = 补 signRequest 四头 + 修 lib 引用。
//   中心端 4 个消费点 (routes/agent.js:960/1013/1126/1241) 已统一
//   "_agentIdentityBound 优先, query 兜底" 范式, 无需再改。
//
// 本文件锁住:
//   A. noadagent/agent.js 源码级不变量: httpGetBinary 必须盖
//      X-Agent-Signature + 必须引用真实 lib (http/https, 不得再出现
//      未定义的 httpsRequest/httpRequest)
//   B. AD agent (Server/agent) 同守卫 (基线, 防回归)
//   C. 中心端 4 个端点必须保持 "绑定身份优先" 范式
//   D. 签名互操: noad signRequest(GET, body=null) == center
//      expectedSignature 空体格式 `${hostname}:${agentId}:`
//
// 用法: cd Server/center && node --test tests/security/noad-agent-signing.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(CENTER_ROOT, '..', '..');

describe('R161.30 S3 — agent 出站签名一致性', () => {
  test('A. noadagent httpGetBinary: 必须盖签名四头 + 引用真实 http lib', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'noadagent', 'agent.js'), 'utf8');
    assert.match(src, /import\s*\{\s*signRequest\s*\}\s*from\s*'\.\/src\/lib\/agent-identity\.js'/,
      'noadagent 必须 import signRequest');
    assert.match(src, /httpGetBinary[\s\S]{0,2500}?X-Agent-Signature/,
      'noadagent httpGetBinary 必须盖 X-Agent-Signature');
    assert.match(src, /httpGetBinary[\s\S]{0,2500}?X-Agent-Hostname/,
      'noadagent httpGetBinary 必须盖 X-Agent-Hostname (GET 无 body, 中间件读 header)');
    // 运行期 undefined 变量守卫: R158.75 引用了不存在的 httpsRequest/httpRequest
    assert.doesNotMatch(src, /httpsRequest/,
      'noadagent 不得引用未定义的 httpsRequest (R158.75 漏项)');
    assert.doesNotMatch(src, /[^a-zA-Z]httpRequest[^a-zA-Z]/,
      'noadagent 不得引用未定义的 httpRequest');
    assert.match(src, /import http from 'node:http'/, '必须 import node:http');
    assert.match(src, /import https from 'node:https'/, '必须 import node:https');
  });

  test('B. AD agent httpGetBinary: 签名四头基线 (防回归)', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'agent', 'agent.js'), 'utf8');
    const start = src.indexOf('async function agentHttpGetBinary');
    assert.notEqual(start, -1, 'agent.js 必须有 agentHttpGetBinary');
    const block = src.slice(start, start + 2500);
    assert.match(block, /X-Agent-Signature/, 'AD httpGetBinary 必须盖签名');
    assert.match(block, /X-Agent-Hostname/, 'AD httpGetBinary 必须盖 hostname 头');
    assert.match(block, /signRequest\(/, 'AD httpGetBinary 必须走 signRequest');
  });

  test('C. 中心端 4 个 agent 端点保持绑定身份优先范式', () => {
    const src = fs.readFileSync(
      path.join(CENTER_ROOT, 'src', 'routes', 'agent.js'), 'utf8');
    const bindings = src.match(/_agentIdentityBound && req\._agentIdentityBound\.hostname/g) || [];
    assert.ok(bindings.length >= 4,
      `4 个端点 (file-push 领取/下载 + ad-commands + member-commands) 必须用绑定身份, 实际 ${bindings.length}`);
    // 每处绑定都必须有 query 兜底 (老 agent 兼容)
    const fallbacks = src.match(/\|\| req\.query\.hostname/g) || [];
    assert.ok(fallbacks.length >= 4, '绑定身份必须有 query.hostname 兜底');
  });

  test('D. 签名互操: noad signRequest(GET) == center 空体 HMAC 格式', async () => {
    const identityUrl = pathToFileURL(
      path.join(REPO_ROOT, 'Server', 'noadagent', 'src', 'lib', 'agent-identity.js')).href;
    const { signRequest } = await import(identityUrl);
    const token = 'a'.repeat(96);
    const sig = signRequest({ hostname: 'MOCKHOST', agentId: 'agent-1', body: null, token });
    // center expectedSignature 未导出 — 用同构复算锁格式 (GET 无 body ⇒ 空体)
    const expected = crypto
      .createHmac('sha256', token)
      .update('MOCKHOST:agent-1:')
      .digest('hex');
    assert.equal(sig, expected, 'noad GET 签名必须匹配 center 中间件格式');
  });
});
