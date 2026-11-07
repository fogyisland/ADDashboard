// R161.30 (2026-11-07) — S1 安全修复回归网: init 向导 installer token。
//
// ★ 背景 (安全审查 S1): init 模式下 /db/test、/db/apply、/admin/create、
//   /finalize 四个端点完全无认证 —— 内网任何人都能抢先 finalize 接管部署,
//   或借 /db/test 做 SSRF 探测。
//
// 本文件逐条锁住:
//   A. installer-token.js 文件生命周期 (生成/复用/清理/损坏文件重新生成)
//   B. router 层: 无 token / 错 token ⇒ 401; 对 token ⇒ 放行; token 未注入
//      ⇒ 503 fail-closed; /status 仍公开
//   C. /finalize 成功后清理 token 文件
//   D. /db/test 错误不再回显驱动原文 (只回脱敏文案)
//
// 用法: cd Server/center && node --test tests/init/installer-token.test.js

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureInstallerToken, readInstallerToken, clearInstallerToken,
  INSTALLER_TOKEN_FILE, INSTALLER_TOKEN_HEADER
} from '../../src/init/installer-token.js';
import { initRouter } from '../../src/init/router.js';

const VALID_TOKEN = 'a'.repeat(96);

function makeLogger() {
  return { error() {}, warn() {}, info() {}, debug() {} };
}

function makeRes() {
  const out = { statusCode: 200, body: null, headers: {} };
  return {
    _out: out,
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    send(payload) { out.body = payload; return this; },
    setHeader(k, v) { out.headers[k] = v; return this; }
  };
}

function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && Boolean(l.route.methods[method])
  );
  assert.ok(layer, `未找到路由 ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  // 写端点现在有两个 handler: [requireInstallerToken, 主 handler]。
  return { guard: handlers[0], main: handlers[handlers.length - 1], count: handlers.length };
}

function makeRouter(installPath, token) {
  const calls = { applyAll: 0, createAdmin: 0, writeConfig: 0, writeMarker: 0, closeFacade: 0 };
  const router = initRouter({
    logger: makeLogger(),
    configPath: join(installPath, 'appsettings.json'),
    installPath,
    getNeedsInit: () => true,
    installerToken: token,
    _deps: {
      withOneShotFacade: async (_d, _p, work) => work({
        dialect: 'mysql',
        async probeServer() { throw new Error('ECONNREFUSED 10.0.0.99:3306 secret-host'); },
        async databaseExists() { return false; },
        async execute() { return { rows: [], affectedRows: 0 }; }
      }),
      applyAll: async () => { calls.applyAll++; return { count: 0, conflicts: [] }; },
      createAdmin: async () => { calls.createAdmin++; return { ok: true }; },
      writeConfig: () => { calls.writeConfig++; },
      getWizardFacade: async () => ({ dialect: 'mysql', async execute() { return { rows: [], affectedRows: 0 }; } }),
      closeWizardFacade: async () => { calls.closeFacade++; },
      writeMarker: async () => { calls.writeMarker++; },
      backfillMigrations: async () => ({ count: 0, skipped: [] }),
      createMigrationsService: () => ({ upgrade: async () => ({ ok: true, migrations: { applied: [], failed: [] } }) }),
      resolveRepoRoot: () => process.cwd()
    }
  });
  return { router, calls };
}

// ---------------------------------------------------------------------------
// A. 文件生命周期
// ---------------------------------------------------------------------------

describe('A. installer token 文件生命周期', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insttoken-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('ensureInstallerToken 生成 96 字符 hex 并落盘', () => {
    const token = ensureInstallerToken(dir);
    assert.match(token, /^[0-9a-f]{96}$/);
    const file = join(dir, INSTALLER_TOKEN_FILE);
    assert.equal(existsSync(file), true, '.installer-token 必须落在安装目录');
    assert.equal(readInstallerToken(dir), token, '文件内容必须能读回同一个令牌');
  });

  test('文件已存在且形状合法 ⇒ 复用, 不重新生成', () => {
    const first = ensureInstallerToken(dir);
    const second = ensureInstallerToken(dir);
    assert.equal(second, first, '跨重启续跑时令牌必须不变');
  });

  test('文件损坏 (空 / 非 hex / 长度不对) ⇒ 重新生成, 不信任垃圾值', () => {
    for (const junk of ['', 'not-hex-at-all', 'a'.repeat(95), `${'a'.repeat(96)}\nextra`]) {
      writeFileSync(join(dir, INSTALLER_TOKEN_FILE), junk, 'utf8');
      const token = ensureInstallerToken(dir);
      assert.match(token, /^[0-9a-f]{96}$/, `损坏内容 ${JSON.stringify(junk.slice(0, 12))}… 必须被重新生成覆盖`);
    }
  });

  test('clearInstallerToken 删除文件; 缺失时幂等', () => {
    ensureInstallerToken(dir);
    clearInstallerToken(dir);
    assert.equal(existsSync(join(dir, INSTALLER_TOKEN_FILE)), false, 'finalize 后令牌文件必须被清掉');
    assert.doesNotThrow(() => clearInstallerToken(dir), '重复清理必须幂等');
  });

  test('installPath 非法 ⇒ TypeError (fail-closed, 不静默)', () => {
    assert.throws(() => ensureInstallerToken(''), TypeError);
    assert.throws(() => ensureInstallerToken(null), TypeError);
  });
});

// ---------------------------------------------------------------------------
// B. router 层认证
// ---------------------------------------------------------------------------

describe('B. router 层 installer token 认证', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insttoken-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('四个写端点都挂了 token guard (handler 链长度 ≥ 2)', () => {
    const { router } = makeRouter(dir, VALID_TOKEN);
    for (const p of ['/db/test', '/db/apply', '/admin/create', '/finalize']) {
      const h = findRouteHandler(router, 'post', p);
      assert.ok(h.count >= 2, `${p} 必须在主 handler 前挂 requireInstallerToken`);
      assert.notEqual(h.guard, h.main, `${p} 的 guard 与主 handler 不能是同一个函数`);
    }
  });

  test('无 x-installer-token 头 ⇒ 401, 且主 handler 不执行', async () => {
    const { router, calls } = makeRouter(dir, VALID_TOKEN);
    const { guard, main } = findRouteHandler(router, 'post', '/admin/create');
    const res = makeRes();
    let mainRan = false;
    const wrappedMain = (...a) => { mainRan = true; return main(...a); };
    await guard({ headers: {}, ip: '10.1.2.3' }, res, wrappedMain);
    assert.equal(res._out.statusCode, 401, '缺头必须 401');
    assert.equal(mainRan, false, '401 后不得进入主 handler');
    assert.equal(calls.createAdmin, 0);
  });

  test('错误 token ⇒ 401 (常量时间路径, 不抛异常)', async () => {
    const { router } = makeRouter(dir, VALID_TOKEN);
    const { guard } = findRouteHandler(router, 'post', '/finalize');
    for (const bad of ['', 'x'.repeat(96), VALID_TOKEN.slice(0, 95), VALID_TOKEN + 'a']) {
      const res = makeRes();
      await guard({ headers: { [INSTALLER_TOKEN_HEADER]: bad }, ip: '10.1.2.3' }, res, () => {
        assert.fail('错误 token 绝不能放行');
      });
      assert.equal(res._out.statusCode, 401, `token ${JSON.stringify(bad.slice(0, 8))}… 必须 401`);
    }
  });

  test('正确 token ⇒ next() 放行', async () => {
    const { router } = makeRouter(dir, VALID_TOKEN);
    const { guard } = findRouteHandler(router, 'post', '/db/test');
    const res = makeRes();
    let nextCalled = false;
    await guard({ headers: { [INSTALLER_TOKEN_HEADER]: VALID_TOKEN }, ip: '10.1.2.3' }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, '正确 token 必须放行');
  });

  test('installerToken 未注入 (null) ⇒ 503 fail-closed, 绝不放行', async () => {
    const { router } = makeRouter(dir, null);
    const { guard } = findRouteHandler(router, 'post', '/db/apply');
    const res = makeRes();
    await guard({ headers: { [INSTALLER_TOKEN_HEADER]: VALID_TOKEN }, ip: '10.1.2.3' }, res, () => {
      assert.fail('token 未配置时绝不能放行');
    });
    assert.equal(res._out.statusCode, 503, 'fail-closed 必须 503');
  });

  test('/status 不挂 token guard — 公开端点保持公开', () => {
    const { router } = makeRouter(dir, VALID_TOKEN);
    const layer = router.stack.find((l) => l.route && l.route.path === '/status');
    assert.ok(layer, '/status 必须存在');
    const handlers = layer.route.stack.map((s) => s.handle);
    assert.equal(handlers.length, 1, '/status 必须是单 handler (无 token guard)');
  });

  test('端到端: 正确 token 走完 /db/test guard + 主 handler', async () => {
    const { router } = makeRouter(dir, VALID_TOKEN);
    const { guard, main } = findRouteHandler(router, 'post', '/db/test');
    const res = makeRes();
    const req = { headers: { [INSTALLER_TOKEN_HEADER]: VALID_TOKEN }, body: { dialect: 'mysql', host: 'h', database: 'd' }, ip: '10.1.2.3' };
    // ★ next() 里的主 handler 是 async —— 必须 await 它, 否则 guard resolve 时
    //   主 handler 尚未完成, res._out.body 还是 null (时序坑)。
    await guard(req, res, async () => { await main(req, res); });
    assert.equal(res._out.statusCode, 200);
    assert.equal(res._out.body.ok, false, 'probeServer 抛错 ⇒ ok:false');
    assert.equal(res._out.body.error, '连接失败 — 请检查主机/端口/用户名/密码 (详情见服务端 init 日志)',
      '错误文案必须是脱敏版');
    assert.equal(String(res._out.body.error).includes('ECONNREFUSED'), false, '不得回显驱动原文');
    assert.equal(String(res._out.body.error).includes('10.0.0.99'), false, '不得回显内部 host');
  });
});

// ---------------------------------------------------------------------------
// C. finalize 清理 token 文件
// ---------------------------------------------------------------------------

describe('C. /finalize 成功后清理 token 文件', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'insttoken-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('finalize 成功 ⇒ .installer-token 被删除', async () => {
    ensureInstallerToken(dir);
    const { router, calls } = makeRouter(dir, VALID_TOKEN);
    const { guard, main } = findRouteHandler(router, 'post', '/finalize');
    const res = makeRes();
    const req = {
      headers: { [INSTALLER_TOKEN_HEADER]: VALID_TOKEN },
      body: { dialect: 'mysql', connParams: { host: 'h', database: 'd', user: 'u', password: 'p' }, listenPort: 8080 },
      ip: '10.1.2.3'
    };
    await guard(req, res, async () => { await main(req, res); });
    assert.equal(res._out.statusCode, 200, `finalize 应成功, 实际 ${JSON.stringify(res._out.body)}`);
    assert.equal(calls.writeConfig, 1);
    assert.equal(calls.writeMarker, 1);
    assert.equal(existsSync(join(dir, INSTALLER_TOKEN_FILE)), false, 'finalize 后令牌文件必须被清掉');
  });
});

// ---------------------------------------------------------------------------
// D. /db/test 错误脱敏
// ---------------------------------------------------------------------------

describe('D. /db/test 错误回显脱敏', () => {
  test('MSSQL 路径同样只回脱敏文案', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insttoken-'));
    try {
      const { router } = makeRouter(dir, VALID_TOKEN);
      const { guard, main } = findRouteHandler(router, 'post', '/db/test');
      const res = makeRes();
      const req = {
        headers: { [INSTALLER_TOKEN_HEADER]: VALID_TOKEN },
        body: { dialect: 'mssql', server: 's', database: 'd' },
        ip: '10.1.2.3'
      };
      await guard(req, res, async () => { await main(req, res); });
      assert.equal(res._out.statusCode, 200);
      assert.equal(String(res._out.body.error).includes('secret-host'), false, 'MSSQL 路径也不得回显内部 host');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
