// R161.25 (2026-10-29 部署审计) — 端口的**真值**回归测试。
//
// ★ 要钉住的事实 (每一条都对应一个真缺陷):
//
//   1. **后台改端口必须真的生效**。旧实现: 绑定读 appsettings.json, 后台写
//      system_config ⇒ 后台改端口永远不生效, 而界面写着「改完需重启后生效」。
//      现在: `listenPort_source='admin'` ⇒ 启动期以**数据库**为准。
//
//   2. **存量部署的绑定端口不能漂**。旧 seed 往库里写死过 8080 (而文件里是
//      8090) ⇒ 若无脑让数据库说了算, 升级后端口会从 8090 变成 8080 ⇒ 操作员
//      的防火墙/反代全断。现在: **没有 source 标记的老行按"文件镜像"处理**
//      ⇒ 端口保持不变, 并顺带把那行谎报纠正回来。
//
//   3. **界面报的端口必须是真实监听的端口**。`center_listen_port_bound` 记录
//      本进程真实绑定的端口; 后台改了端口还没重启的那段时间, 期望端口 ≠
//      真实端口 ⇒ 对外地址必须报 bound 的那个。
//
//   4. **「重启生效」徽标必须会熄灭**。旧实现 pending/started 各带一个 ISO
//      时间戳 ⇒ 永远不相等 ⇒ 徽标永远亮着 ⇒ 操作员更加确信"这功能坏了"。
//      现在两边都只哈希端口值 ⇒ 重启后相等 ⇒ 徽标自动灭。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSql } from '../src/db/sql.js';
import { _setDbForTest } from '../src/db/index.js';
import {
  resolveListenPort,
  getListenPort,
  getBoundListenPort,
  recordBoundListenPort,
  validateConfigObject,
  sha256Hex,
  LISTEN_PORT_SOURCE_ADMIN,
  LISTEN_PORT_SOURCE_APPSETTINGS
} from '../src/config.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const SERVER_ROOT = resolve(HERE, '..');   // center/

const KNOWN_KEYS = new Set(['listenPort', 'listenPort_source', 'center_listen_port_bound']);

/** 一个"合法的最小配置对象" —— 供 validateConfigObject 的用例改字段用。 */
function baseConfig(overrides = {}) {
  return {
    db: { dialect: 'mysql', mysql: { host: 'db.internal', database: 'addashboard', user: 'u', password: 'p' } },
    listenPort: 8080,
    jwtSecret: 'jwt-secret',
    agentToken: 'agent-token',
    staticDir: './dist',
    logLevel: 'info',
    env: 'prod',
    ...overrides
  };
}

/** 假 db facade —— system_config 用一个 Map 当 KV 表。 */function makeFakeDb(initial = {}) {
  const kv = new Map(Object.entries(initial));
  const db = {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async query(sql) {
      const keys = [...String(sql).matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)]
        .map(m => m[1])
        .filter(k => KNOWN_KEYS.has(k));
      const rows = keys
        .filter(k => kv.has(k))
        .map(k => ({ config_key: k, config_value: kv.get(k) }));
      return { rows };
    },
    async execute(sql, params) {
      if (params && params.length >= 2 && typeof params[0] === 'string') {
        kv.set(params[0], params[1] == null ? null : String(params[1]));
      }
    },
    kv
  };
  return db;
}

describe('R161.25: 端口真值 (DB 优先 + 来源标记)', () => {
  let db = null;
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  beforeEach(() => { db = makeFakeDb(); _setDbForTest(db); });
  afterEach(() => { _setDbForTest(null); });

  test('老行 (没有任何 source 标记) 按 appsettings.json 的镜像处理 —— 端口不漂', async () => {
    // 老 seed 写死的 8080 vs 文件里的 8090 —— 升级前中心实际跑在 8090。
    db.kv.set('listenPort', '8080');
    const res = await resolveListenPort({ logger, appsettingsPort: 8090 });
    assert.equal(res.port, 8090, '绑定端口必须仍是文件里的 8090 (存量部署不能漂)');
    assert.equal(res.source, LISTEN_PORT_SOURCE_APPSETTINGS);
    assert.equal(res.changed, true, '那行谎报必须被纠正');
    assert.equal(db.kv.get('listenPort'), '8090');
    assert.equal(db.kv.get('listenPort_source'), LISTEN_PORT_SOURCE_APPSETTINGS);
  });

  test('source=admin ⇒ 数据库说了算 (后台改端口真的生效)', async () => {
    db.kv.set('listenPort', '9090');
    db.kv.set('listenPort_source', LISTEN_PORT_SOURCE_ADMIN);
    const res = await resolveListenPort({ logger, appsettingsPort: 8090 });
    assert.equal(res.port, 9090, '后台指定的端口必须赢');
    assert.equal(res.source, LISTEN_PORT_SOURCE_ADMIN);
    assert.equal(res.changed, false, '已经是 admin 的行不该被改写');
    assert.equal(db.kv.get('listenPort'), '9090');
  });

  test('全新库 (没有任何 listenPort 行) ⇒ 用文件里的值并落库', async () => {
    const res = await resolveListenPort({ logger, appsettingsPort: 8091 });
    assert.equal(res.port, 8091);
    assert.equal(db.kv.get('listenPort'), '8091');
    assert.equal(db.kv.get('listenPort_source'), LISTEN_PORT_SOURCE_APPSETTINGS);
  });

  test('source=admin 但库里的值非法 ⇒ 退回文件值并修好那行', async () => {
    db.kv.set('listenPort', 'abc');
    db.kv.set('listenPort_source', LISTEN_PORT_SOURCE_ADMIN);
    const res = await resolveListenPort({ logger, appsettingsPort: 8090 });
    assert.equal(res.port, 8090);
    assert.equal(res.source, LISTEN_PORT_SOURCE_APPSETTINGS);
    assert.equal(db.kv.get('listenPort'), '8090');
  });

  test('getListenPort = 期望端口; getBoundListenPort = 实际绑定端口', async () => {
    db.kv.set('listenPort', '9090');
    db.kv.set('listenPort_source', LISTEN_PORT_SOURCE_ADMIN);
    db.kv.set('center_listen_port_bound', '8080');
    assert.equal(await getListenPort(8080), 9090, '期望端口读数据库');
    assert.equal(await getBoundListenPort(8080), 8080, '实际绑定端口读 bound 行');
  });

  test('recordBoundListenPort 写下的值就是本进程真实监听的端口', async () => {
    assert.equal(await recordBoundListenPort(8090, logger), 8090);
    assert.equal(db.kv.get('center_listen_port_bound'), '8090');
    // 非法端口不许落库 (否则自检脚本会去探一个不存在的端口)
    assert.equal(await recordBoundListenPort('abc', logger), null);
  });

  test('「重启生效」徽标: pending 与 started 必须哈希同一个端口值 (不带时间戳)', () => {
    const adminSrc = readFileSync(resolve(SERVER_ROOT, 'src', 'routes', 'admin.js'), 'utf8');
    const serverSrc = readFileSync(resolve(SERVER_ROOT, 'server.js'), 'utf8');

    // pending: sha256Hex(String(port)) —— 不能掺时间戳
    assert.match(
      adminSrc,
      /const pending = sha256Hex\(String\(updates\.listenPort\)\);/,
      'pending 哈希必须只哈希端口值'
    );
    assert.doesNotMatch(
      adminSrc,
      /sha256Hex\(`\$\{new Date\(\)\.toISOString\(\)\}:\$\{updates\.listenPort\}`\)/,
      'pending 哈希不得掺时间戳 (否则徽标永远不熄灭)'
    );
    // started: sha256Hex(String(port))
    assert.match(
      serverSrc,
      /const startedVersion = sha256Hex\(String\(finalConfig\.listenPort\)\);/,
      'started 哈希必须只哈希端口值'
    );
    // 两边哈希同一个端口 ⇒ 值必然相等
    assert.equal(sha256Hex('8090'), sha256Hex('8090'));
  });

  test('后台保存端口时必须写 listenPort_source=admin (否则后台改端口不生效)', () => {
    const adminSrc = readFileSync(resolve(SERVER_ROOT, 'src', 'routes', 'admin.js'), 'utf8');
    assert.match(
      adminSrc,
      /\['listenPort_source',\s*LISTEN_PORT_SOURCE_ADMIN\]/,
      '后台保存端口必须把来源标记成 admin'
    );
  });

  test('server.js 必须用 resolveListenPort 的结果去绑定 (finalConfig.listenPort)', () => {
    const serverSrc = readFileSync(resolve(SERVER_ROOT, 'server.js'), 'utf8');
    assert.match(serverSrc, /resolveListenPort\(\{ logger, appsettingsPort \}\)/);
    assert.match(serverSrc, /finalConfig\.listenPort = resolvedListenPort\.port;/);
  });

  test('对外地址必须报 center_listen_port_bound (实际监听), 而不是期望端口', () => {
    for (const rel of ['src/routes/system-settings-v2.js', 'src/routes/me-mcp.js']) {
      const src = readFileSync(resolve(SERVER_ROOT, rel), 'utf8');
      assert.match(
        src,
        /Number\(map\?\.center_listen_port_bound\) \|\| Number\(map\?\.listenPort\) \|\| 8080/,
        `${rel} 必须优先报实际绑定端口`
      );
    }
  });
});

// ★ R161.25 — listenPort 必须是**数字**。
//   Node 的 `app.listen('8090')`: 字符串参数 = "监听这个路径"(Unix socket /
//   Windows 命名管道), **不是** TCP 端口 ⇒ 中心起得来但谁都连不上, 而且
//   **一条错都不报**。手改过 appsettings.json 的机器最容易踩到。
describe('R161.25: listenPort 必须是数字 (字符串会被当成 socket 路径)', () => {
  test('字符串端口 ⇒ 归一成数字', () => {
    const cfg = validateConfigObject(baseConfig({ listenPort: '8090' }));
    assert.equal(cfg.listenPort, 8090);
    assert.equal(typeof cfg.listenPort, 'number');
  });

  test('非法端口 ⇒ throw (不许静默变成 socket 路径)', () => {
    assert.throws(() => validateConfigObject(baseConfig({ listenPort: 'abc' })), /listenPort invalid/);
    assert.throws(() => validateConfigObject(baseConfig({ listenPort: 0 })), /listenPort invalid/);
    assert.throws(() => validateConfigObject(baseConfig({ listenPort: 70000 })), /listenPort invalid/);
    assert.throws(() => validateConfigObject(baseConfig({ listenPort: 8080.5 })), /listenPort invalid/);
  });
});
