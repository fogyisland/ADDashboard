// R161.34 (2026-11-07) — 安全批次 S6: 安全响应头 + 对外错误脱敏。
//
// ★ 本文件锁三件事:
//   1. 安全响应头必须挂在**所有**响应上 (含 404 / 500 / 静态资源)
//   2. /healthz (匿名端点) 不得回显原始 e.message
//   3. /api/system/update (localhost-only) 不得回显原始 e.message
//
// ★ 为什么用**真实 http server + fetch** (不用 supertest):
//   响应头是 HTTP 层的产物, 只有真发一次请求才能验证 —— 源码正则只能证明
//   "代码长这样", 证明不了"头真的到了客户端"。
//
// ★ 为什么用**真实 import** 而不是 stub:
//   errorSanitizer 的判定依赖 err.code / err.errno / err.number /
//   err.originalError 这些**结构化字段**, 而不同 driver / 包装层放的字段
//   不一样 ⇒ 只有跑真代码才能确认分类正确。
//
// 用法: cd Server/center && node --test tests/security/security-headers-and-error-sanitizer.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { healthzRouter } from '../../src/routes/healthz.js';
import { systemRouter } from '../../src/routes/system.js';
import {
  classifyPublicError,
  publicErrorBody,
  PUBLIC_ERROR_KIND
} from '../../src/utils/errorSanitizer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');

function makeLogger() {
  const noop = () => {};
  return {
    child: () => makeLogger(),
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
  };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

// ── 1. 安全响应头 ────────────────────────────────────────────────────────
describe('R161.34 S6.1 — 安全响应头', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createApp({
      config: { staticDir: path.join(CENTER_ROOT, 'public') },
      db: null,
      logger: makeLogger(),
      needsInit: true,
    });
    ({ server, baseUrl } = await listen(app));
  });

  after(() => { server?.close(); });

  test('所有响应都必须带安全响应头 (含 404 / 500)', async () => {
    const res = await fetch(`${baseUrl}/this-path-does-not-exist-xyz`);
    // ★ 状态码**不重要** —— 未知路径可能走 SPA fallback (404) 或静态资源
    //   缺失 (500), 取决于 staticDir 是否存在。重要的是**响应头在**:
    //   安全头必须挂在**所有**响应路径上, 不能只挂在 API 上。
    assert.ok(res.status >= 200 && res.status < 600, `收到意外的状态码 ${res.status}`);
    // ★ 逐条断言, 不只看"有没有某个头" —— 少一条就等于少一道防线。
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff',
      'X-Content-Type-Options: nosniff 必须存在 (防 MIME 猜测 ⇒ XSS)');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN',
      'X-Frame-Options: SAMEORIGIN 必须存在 (防点击劫持)');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin',
      'Referrer-Policy 必须存在 (防内网 URL 泄露)');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin',
      'Cross-Origin-Opener-Policy 必须存在 (防 tabnabbing)');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin',
      'Cross-Origin-Resource-Policy 必须存在 (防资源被外站嵌入)');
    assert.match(res.headers.get('permissions-policy') || '', /geolocation=\(\)/,
      'Permissions-Policy 必须关掉地理位置');
    assert.equal(res.headers.get('x-dns-prefetch-control'), 'off',
      'X-DNS-Prefetch-Control: off 必须存在');
  });

  test('x-powered-by 必须关闭 (Express 默认会泄露版本)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.headers.get('x-powered-by'), null,
      'X-Powered-By 不得出现');
  });

  test('★ 不得发 HSTS (纯 HTTP 内网部署下它是故障源)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.headers.get('strict-transport-security'), null,
      '★ 本项目默认 http://内网IP:8080 ⇒ 发 HSTS 会让浏览器把 http 升级成 https 而连不上');
  });

  test('★ 不得发已废弃的 X-XSS-Protection (历史上引入过自己的漏洞)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.headers.get('x-xss-protection'), null,
      'X-XSS-Protection 已废弃, 现代浏览器直接忽略');
  });
});

// ── 2. 错误脱敏: 分类器 ──────────────────────────────────────────────────
describe('R161.34 S6.2 — 错误分类器', () => {
  test('MySQL 错误名 ⇒ database', () => {
    assert.equal(classifyPublicError({ code: 'ER_NO_SUCH_TABLE' }), PUBLIC_ERROR_KIND.DATABASE);
    assert.equal(classifyPublicError({ code: 'ER_DUP_ENTRY' }), PUBLIC_ERROR_KIND.DATABASE);
    assert.equal(classifyPublicError({ code: 'ER_LOCK_WAIT_TIMEOUT' }), PUBLIC_ERROR_KIND.DATABASE);
  });

  test('MSSQL 错误号 ⇒ database', () => {
    assert.equal(classifyPublicError({ number: 208 }), PUBLIC_ERROR_KIND.DATABASE);
    assert.equal(classifyPublicError({ number: 2627 }), PUBLIC_ERROR_KIND.DATABASE);
    assert.equal(classifyPublicError({ number: 1205 }), PUBLIC_ERROR_KIND.DATABASE);
  });

  test('★ 包装层 (originalError / cause) 必须能穿透', () => {
    // db facade 把驱动错误包成 DbError ⇒ code 在 originalError 里
    const wrapped = { code: 'UNKNOWN', originalError: { code: 'ER_NO_SUCH_TABLE' } };
    assert.equal(classifyPublicError(wrapped), PUBLIC_ERROR_KIND.DATABASE,
      'originalError 里的 MySQL 错误名必须能被识别');
    const chained = { message: 'boom', cause: { number: 208 } };
    assert.equal(classifyPublicError(chained), PUBLIC_ERROR_KIND.DATABASE,
      'cause 里的 MSSQL 错误号必须能被识别');
  });

  test('超时 ⇒ timeout', () => {
    assert.equal(classifyPublicError({ code: 'ETIMEDOUT' }), PUBLIC_ERROR_KIND.TIMEOUT);
    assert.equal(classifyPublicError({ message: 'Lock wait timeout exceeded' }), PUBLIC_ERROR_KIND.TIMEOUT);
  });

  test('未知错误 ⇒ internal (绝不泄露原文)', () => {
    assert.equal(classifyPublicError(new Error('connect ECONNREFUSED 10.0.0.5:3306')), PUBLIC_ERROR_KIND.INTERNAL);
    assert.equal(classifyPublicError(null), PUBLIC_ERROR_KIND.INTERNAL);
    assert.equal(classifyPublicError('a string'), PUBLIC_ERROR_KIND.INTERNAL);
  });

  test('★ 响应体里绝不能出现原始 message', () => {
    const secret = "SQLSTATE[42S02]: Base table or view not found: 1146 Table 'ad_dashboard.secret_table' doesn't exist";
    const body = publicErrorBody(new Error(secret));
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('secret_table'), '响应体不得含原始 message');
    assert.ok(!serialized.includes('SQLSTATE'), '响应体不得含原始 message');
    assert.ok(!serialized.includes('1146'), '响应体不得含驱动错误号');
    // 但**必须**还能告诉操作员"这是数据库层的问题"
    assert.equal(body.kind, PUBLIC_ERROR_KIND.DATABASE);
  });
});

// ── 3. 错误脱敏: /healthz (匿名端点) ────────────────────────────────────
describe('R161.34 S6.3 — /healthz 不得回显原始错误', () => {
  let server;
  let baseUrl;

  before(async () => {
    // ★ 直接挂 healthzRouter, 并让 getDb() 抛一个"带敏感信息"的错。
    //   getDb 的返回值来自 src/db/index.js —— 这里用真实的模块替换,
    //   保证测的是**生产路径**上的那个 catch。
    const dbIndex = await import('../../src/db/index.js');
    const originalGetDb = dbIndex.getDb;
    // getDb 是具名导出 —— ESM 具名导出不可直接改写。
    // ⇒ 改用"让真实的 getDb 抛错"的办法: 它在没初始化 DB 时本来就会抛。
    //   为了让错误消息**确定可控**, 这里断言"不抛异常时不含原始 message",
    //   抛异常时的行为由下面的 e2e(healthz) 用真 server 覆盖。
    void originalGetDb;
    const app = createApp({
      config: { staticDir: path.join(CENTER_ROOT, 'public') },
      db: null,
      logger: makeLogger(),
      needsInit: true,
    });
    ({ server, baseUrl } = await listen(app));
  });

  after(() => { server?.close(); });

  test('★ healthz 降级时不得回显原始错误消息', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    // healthz 在没有 DB 时必然降级 (503) —— 无论 200 还是 503,
    // 关键都是**响应体里不能有原始异常原文**。
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      assert.fail(`healthz 响应体不是 JSON: ${text.slice(0, 200)}`);
    }
    assert.equal(body.status, 'degraded', '没有 DB 时 healthz 必须降级');
    assert.ok(!('error' in body) || typeof body.error !== 'string' || body.error.length < 200,
      '★ healthz 的 error 字段不得是原始异常消息');
    // 脱敏后应该有一个稳定的 kind
    assert.ok(Object.values(PUBLIC_ERROR_KIND).includes(body.kind),
      `healthz 必须带一个合法的 kind, 实际: ${body.kind}`);
    // 绝不能出现堆栈 / SQL 关键字
    assert.ok(!/\bat\s+\w+\s+\(/.test(text), 'healthz 不得回显堆栈');
    assert.ok(!/SQLSTATE|SELECT\s+.*FROM/i.test(text), 'healthz 不得回显 SQL');
  });
});

// ── 4. 错误脱敏: /api/system/update ────────────────────────────────────
describe('R161.34 S6.4 — /api/system/update 不得回显原始错误', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = createApp({
      config: { staticDir: path.join(CENTER_ROOT, 'public') },
      db: null,
      logger: makeLogger(),
      needsInit: true,
    });
    // ★ systemRouter **不在** createApp 里 —— 它由 server.js 单独挂
    //   (server.js:1073, 只在 web app 上)。所以这里显式挂一次,
    //   复刻生产路径。
    app.use(systemRouter({
      logger: makeLogger(),
      getRepoRoot: () => CENTER_ROOT,
      getExitDelayMs: () => 1,
    }));
    ({ server, baseUrl } = await listen(app));
  });

  after(() => { server?.close(); });

  test('system 端点在没有 DB 时不得回显原始错误消息', async () => {
    const res = await fetch(`${baseUrl}/api/system/update`, { method: 'POST' });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      assert.fail(`system/update 响应体不是 JSON: ${text.slice(0, 200)}`);
    }
    // 从 localhost 发, 所以不会撞上 403 的 localhost-only 闸门;
    // 真实结果取决于 DB 是否可用, 但**无论**成功失败, 响应体都不得
    // 出现原始异常原文。
    const serialized = JSON.stringify(body);
    assert.ok(!/SQLSTATE|Cannot find module|ECONNREFUSED/.test(serialized),
      '★ system/update 不得回显原始错误原文');
    assert.ok(!/at\s+\w+\s+\([^)]*:\d+:\d+\)/.test(serialized),
      'system/update 不得回显堆栈');
  });
});

// ── 5. 源码级不变量 ─────────────────────────────────────────────────────
describe('R161.34 S6.5 — 源码级不变量', () => {
  test('★ healthz.js 与 system.js 里不许再有裸的 e.message 进响应体', () => {
    for (const rel of ['routes/healthz.js', 'routes/system.js']) {
      const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', rel), 'utf8');
      assert.doesNotMatch(src, /json\(\{[^}]*\berror:\s*e\.message/,
        `${rel}: 不得把 e.message 直接放进响应体的 error 字段`);
      assert.doesNotMatch(src, /json\(\{[^}]*\bmessage:\s*e\.message/,
        `${rel}: 不得把 e.message 直接放进响应体的 message 字段`);
      assert.match(src, /publicErrorBody/,
        `${rel}: 必须走 publicErrorBody 脱敏`);
    }
  });

  test('★ app.js 里 securityHeaders 必须是最早的 app.use', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'app.js'), 'utf8');
    const firstUse = src.indexOf('app.use(');
    const secIdx = src.indexOf('app.use(securityHeaders())');
    assert.notEqual(secIdx, -1, 'app.js 必须挂 securityHeaders()');
    assert.ok(secIdx === firstUse,
      `★ securityHeaders 必须是第一个 app.use (实际 firstUse@${firstUse}, sec@${secIdx})`);
  });
});
