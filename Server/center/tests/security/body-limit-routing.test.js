// R161.31 (2026-11-07) — 性能项 1: body parser 按路径分流。
//
// ★ 背景: 旧实现是全局 express.json({ limit: '50mb' }) —— 每个请求
//   （含 60s 一次的心跳、/healthz、SPA 静态资源）都挂着一个"最多读 50MB"
//   的 JSON 解析器。body-parser 会把整个 body 读进内存再 JSON.parse ⇒
//   任何未受控的 JSON 端点（admin 批量导入等）单请求就能吃掉 50MB RSS。
//   修法 = 按路径分三档: 50mb (file-push 上传) / 10mb (agent 上报类) /
//   1mb (其余全部)。
//
// ★ 本文件用**真实 http server + fetch** 验证 (不用 supertest —— 本仓
//   没有这个依赖): 真发一个超过 1MB 的 JSON body 到普通端点 ⇒ 必须 413;
//   发到 file-push 上传端点 ⇒ 不得因体积被拒 (交给路由层判 contentB64)。
//   同时验证 express 的"parser 只消费一次"约束: 大体量 parser 必须排在
//   通用 parser **之前**, 否则通用 parser 先消费了请求流。
//
// 用法: cd Server/center && node --test tests/security/body-limit-routing.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(CENTER_ROOT, '..', '..');

const ONE_MB = 1024 * 1024;
// 略超过 1MB 默认档 —— 但远小于 10mb / 50mb 档。
const OVER_DEFAULT = Buffer.alloc(ONE_MB + 64 * 1024, 0x41).toString('utf8');

function makeLogger() {
  const noop = () => {};
  return {
    child: () => makeLogger(),
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
  };
}

// 只挂 body parser + 一个 echo 端点 —— 不引业务路由 (业务路由需要 DB /
// 鉴权, 与本测试无关)。这里复刻 app.js 的挂载顺序。
function buildTestApp() {
  const app = createApp({
    config: { staticDir: path.join(CENTER_ROOT, 'public') },
    db: null,
    logger: makeLogger(),
    needsInit: true,
  });
  return app;
}

describe('R161.31 — body parser 按路径分流', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = buildTestApp();
    // 在所有内建路由之后追加一个 echo 端点, 观察 body 有没有被解析。
    // 注意: createApp 里 SPA fallback 是 app.get(/^\/(?!api\/|...).*/) ——
    // /api/ 路径被排除, 所以 echo 端点能被命中 (fallback 只处理 GET,
    // 而我们发 POST)。
    app.post('/api/__probe__/echo', (req, res) => {
      res.json({ gotBody: req.body ?? null, keys: Object.keys(req.body || {}) });
    });
    app.post('/api/admin/file-push/__probe__', (req, res) => {
      res.json({ gotBody: req.body ?? null, keys: Object.keys(req.body || {}) });
    });
    app.post('/api/agent/report/__probe__', (req, res) => {
      res.json({ gotBody: req.body ?? null, keys: Object.keys(req.body || {}) });
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('A. 普通 /api 端点: 超过 1MB 的 body 必须被拒 (413)', async () => {
    const res = await fetch(`${baseUrl}/api/__probe__/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: OVER_DEFAULT }),
    });
    assert.equal(res.status, 413,
      `默认档必须拒掉 >1MB 的 body, 实际 ${res.status}`);
  });

  test('B. file-push 上传端点: >1MB 的 body 必须被接受 (50mb 档)', async () => {
    const res = await fetch(`${baseUrl}/api/admin/file-push/__probe__`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: OVER_DEFAULT }),
    });
    assert.equal(res.status, 200,
      `file-push 必须走 50mb 档, 实际 ${res.status}`);
    const body = await res.json();
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0], 'blob', 'body 必须被真正解析 (不能是 {} 或 undefined)');
  });

  test('C. agent 上报端点: >1MB 的 body 必须被接受 (10mb 档)', async () => {
    const res = await fetch(`${baseUrl}/api/agent/report/__probe__`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: OVER_DEFAULT }),
    });
    assert.equal(res.status, 200,
      `agent 上报必须走 10mb 档, 实际 ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body.keys, ['blob'], 'body 必须被真正解析');
  });

  test('D. 小 body 在普通端点照常解析 (分流不能误伤)', async () => {
    const res = await fetch(`${baseUrl}/api/__probe__/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world', n: 42 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.keys.sort(), ['hello', 'n']);
    assert.equal(body.gotBody.hello, 'world');
  });

  test('E. 源码级守卫: 大体量 parser 必须排在通用 parser 之前', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'app.js'), 'utf8');
    // 只看**代码行** —— 注释里出现的 express.json({limit:'50mb'}) 是
    // 历史说明文字, 不是实际调用。
    const codeLines = src.split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0);
    const code = codeLines.join('\n');

    const bigIdx = code.indexOf("app.use('/api/admin/file-push', express.json({ limit: BIG_BODY_LIMIT }))");
    const medIdx = code.indexOf("app.use('/api/agent/report', express.json({ limit: MEDIUM_BODY_LIMIT }))");
    const defIdx = code.indexOf('app.use(express.json({ limit: DEFAULT_BODY_LIMIT }))');
    assert.ok(bigIdx > -1, 'app.js 必须有 file-push 大体量 parser');
    assert.ok(medIdx > -1, 'app.js 必须有 agent 上报中体量 parser');
    assert.ok(defIdx > -1, 'app.js 必须有通用 parser');
    assert.ok(bigIdx < defIdx,
      '大体量 parser 必须排在通用 parser 之前 (express parser 只消费一次)');
    assert.ok(medIdx < defIdx,
      '中体量 parser 必须排在通用 parser 之前');
    // 不允许再出现"全局 50mb" —— 那是本项要消灭的目标。
    assert.doesNotMatch(code, /express\.json\(\{\s*limit:\s*'50mb'\s*\}\)/,
      '不得再有全局 50mb parser');
  });

  test('F. body-parser 错误必须透出状态码 (413/400), 不得伪装成 500', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'app.js'), 'utf8');
    assert.match(src, /entity\.too\.large/,
      'errorMiddleware 必须识别 entity.too.large ⇒ 413');
    assert.match(src, /entity\.parse\.failed/,
      'errorMiddleware 必须识别 entity.parse.failed ⇒ 400');
  });
});
