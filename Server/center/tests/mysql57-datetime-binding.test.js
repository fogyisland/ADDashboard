// R161.5 — 「MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串」缺陷族的回归网
//
// 背景 (操作员真库 = MySQL 5.7.44, 操作员 2026-10-26 报 os-baseline 500 +
// 端口探测结果一条都存不进去 + 账户变更静默不落库):
//   MySQL 5.7 的 DATETIME 列收到 "2026-10-20T00:00:00.000Z" 会报
//   ER 1292 (Incorrect datetime value) ⇒ INSERT/UPDATE 直接失败 (端点 500);
//   放进 SELECT 谓词则只 warning 1292、谓词退化 ⇒ 静默返回错结果 (更隐蔽)。
//   MSSQL 侧 datetime2 接受 ISO ⇒ 这族缺陷在 MSSQL 分支**零症状**。
//
// 根因 (driver 契约):
//   `src/db/drivers/mysql.js` 的 `normalizeParam` **只转换 Date 实例, 字符串
//   原样透传** ⇒ 往 DATETIME 列绑字符串时间戳是**调用侧**的责任。
//   公共转换函数 = `src/utils/datetime.js` 的 `toMysqlDatetime()`
//   (输出 UTC naive "YYYY-MM-DD HH:mm:ss")。
//   ⚠ 禁止在 driver 层兜底自动转 ISO —— `system_config.config_value` 是
//     TEXT 列且**故意**存 ISO 字符串, driver 一刀切会把 TEXT 写坏。
//
// 本文件锁 8 件事 (每处都做 MySQL / MSSQL 1:1 平行断言):
//   A. services/account-change.js  — ad_account_change 的 3 个 DATETIME 列
//   B. routes/system-inapp-notifications.js — system_alerts 的 3 个 DATETIME 列
//   C. db/sql.js (仅 mysql 段) — healthSummaryWithHeartbeat 第 3 个 bind
//   D. services/heartbeat-report.js — ad_replication_status.collected_at
//   E. routes/system-settings-v2.js — ad_system_registration.expires_at
//   F. services/replication.js — ad_replication_active_errors 的 3 个 DATETIME 列
//   附1. routes/member-servers.js — systemSettings.upsert 传了多余的第 3 参
//
// 断言的两条铁律 (缺一不可):
//   (1) MySQL 侧 DATETIME 位置必须是 naive 格式
//   (2) MSSQL 侧**必须仍是 ISO** —— 这是「MSSQL 零行为变化」的证据
//
// 放在 center/tests/ 顶层的原因:
//   center/package.json 的 "test" glob 是 `tests/*.test.js ...`, **不含
//   tests/audit/** ⇒ 放子目录 CI 根本不跑。而给 package.json 加 glob 会改掉
//   它的内容 ⇒ `.install-hash` 失配 ⇒ 目标机 (常常离线) 删 node_modules 重跑
//   npm install ⇒ 装机报废 ⇒ **package.json 不能动**。
//
// 用法: cd Server/center && node --test tests/mysql57-datetime-binding.test.js

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSql } from '../src/db/sql.js';
import { _setDbForTest } from '../src/db/index.js';
import { toMysqlDatetime } from '../src/utils/datetime.js';
import { upsertMembers } from '../src/services/account-change.js';
import { heartbeatReportService } from '../src/services/heartbeat-report.js';
import { upsertStatus } from '../src/services/replication.js';
import { createSystemInappNotificationsRouter } from '../src/routes/system-inapp-notifications.js';
import { createSystemSettingsV2Router } from '../src/routes/system-settings-v2.js';
import { memberRouter } from '../src/routes/member-servers.js';
import { encodeLicenseCode } from '../src/services/license-codec.js';

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

/** MySQL naive DATETIME 格式 (UTC, 秒精度)。 */
const NAIVE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** ISO 8601 字符串 (`Date.prototype.toISOString()` 的产物)。 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function assertNaive(value, label) {
  assert.equal(typeof value, 'string', `${label}: 期望字符串, 实际 ${typeof value} (${JSON.stringify(value)})`);
  assert.match(value, NAIVE_RE, `${label}: 期望 MySQL naive 格式 "YYYY-MM-DD HH:mm:ss", 实际 ${JSON.stringify(value)}`);
}

function assertIso(value, label) {
  assert.equal(typeof value, 'string', `${label}: 期望字符串, 实际 ${typeof value} (${JSON.stringify(value)})`);
  assert.match(value, ISO_RE, `${label}: 期望 ISO 8601 格式, 实际 ${JSON.stringify(value)}`);
}

/** 假 db facade —— 记录每次 execute/query 的 (sql, params)。 */
function makeFakeDb(dialect) {
  const calls = [];
  const db = {
    dialect,
    sql: buildSql(dialect),
    execute: async (sql, params = []) => {
      calls.push({ kind: 'execute', sql, params });
      return { rows: [], recordset: [], insertId: 42 };
    },
    query: async (sql, params = []) => {
      calls.push({ kind: 'query', sql, params });
      return { rows: [] };
    }
  };
  return { db, calls };
}

/** 假 logger —— 全方法吞掉, 只记录调用次数。 */
function makeLogger() {
  return {
    error() {}, warn() {}, info() {}, debug() {},
    calls: { error: 0, warn: 0, info: 0 }
  };
}

/** 假 res —— 捕获 status + json body。 */
function makeRes() {
  const out = { statusCode: 200, body: null };
  return {
    _out: out,
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    send(payload) { out.body = payload; return this; },
    setHeader() { return this; }
  };
}

/**
 * 从 express Router 里取出某个端点的**最后一个** handler。
 *
 * 为什么取最后一个: 路由栈是 [auth 中间件..., 端点 handler], 我们要绕过
 * auth (测试不涉及登录) 直接驱动端点逻辑。
 */
function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && Boolean(l.route.methods[method])
  );
  assert.ok(layer, `未找到路由 ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

/** 在记录里按 SQL 关键字挑出某一条调用。 */
function findCall(calls, keyword) {
  const hit = calls.find((c) => String(c.sql).includes(keyword));
  assert.ok(hit, `未找到 SQL 含 "${keyword}" 的调用; 实际调用: ${JSON.stringify(calls.map((c) => String(c.sql).slice(0, 70)))}`);
  return hit;
}

// ---------------------------------------------------------------------------
// 临时安装目录 (E 端点需要真实 license 申请单文件)
// ---------------------------------------------------------------------------

const tempDirs = [];

function makeInstallPath() {
  const root = mkdtempSync(path.join(tmpdir(), 'r161-5-license-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'data', 'license-requests'), { recursive: true });
  writeFileSync(
    path.join(root, 'appsettings.json'),
    JSON.stringify({ instance_id: 'r161-5-test', signature: 'R1615TESTSIG', installed_at: '2026-10-01T00:00:00.000Z' }, null, 2),
    'utf8'
  );
  return root;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A. services/account-change.js
// ---------------------------------------------------------------------------

const ACCOUNT_METRICS = {
  agentId: 'DC01',
  dcName: 'DC01',
  domainDn: 'CN=Users,DC=corp,DC=local',
  changeDate: new Date('2026-10-20T00:00:00.000Z'),
  entries: [
    {
      sam: 'alice',
      action: 'created',
      display_name: 'Alice A',
      created_at: '2026-10-19T08:30:00.000Z',
      modified_at: '2026-10-20T09:15:00.000Z',
      dn: 'CN=Alice A,OU=Users,DC=corp,DC=local',
      operator_user: 'administrator'
    }
  ]
};

describe('A. account-change — ad_account_change 的 DATETIME 列', () => {
  test('MySQL 侧 3 个 DATETIME bind 必须是 naive 格式, change_date(DATE) 不动', async () => {
    const { db, calls } = makeFakeDb('mysql');
    const result = await upsertMembers(db, ACCOUNT_METRICS, 'DC01', 'run-1', makeLogger());

    assert.equal(result.upserted, 1, `upsert 应成功, 实际 errors=${JSON.stringify(result.errors)}`);
    const call = findCall(calls, 'ad_account_change');
    const p = call.params;
    // params 顺序 (sql.js mysql 段 adAccountChange.upsert):
    //   0 sam · 1 display_name · 2 action · 3 created_at · 4 modified_at
    //   5 change_date · 6 domain_dn · 7 dc_name · 8 collected_at · 9 operator_user
    assertNaive(p[3], 'created_at');
    assertNaive(p[4], 'modified_at');
    assertNaive(p[8], 'collected_at');
    assert.equal(p[3], '2026-10-19 08:30:00', 'created_at 应是 naive UTC');
    assert.equal(p[4], '2026-10-20 09:15:00', 'modified_at 应是 naive UTC');
    // change_date 是 DATE 列 ('YYYY-MM-DD'), 不能被转成 datetime
    assert.match(p[5], /^\d{4}-\d{2}-\d{2}$/, `change_date 应保持 YYYY-MM-DD, 实际 ${JSON.stringify(p[5])}`);
  });

  test('MSSQL 侧 3 个 DATETIME bind 必须仍是 ISO (零行为变化)', async () => {
    const { db, calls } = makeFakeDb('mssql');
    const result = await upsertMembers(db, ACCOUNT_METRICS, 'DC01', 'run-1', makeLogger());

    assert.equal(result.upserted, 1, `upsert 应成功, 实际 errors=${JSON.stringify(result.errors)}`);
    const p = findCall(calls, 'ad_account_change').params;
    assertIso(p[3], 'created_at');
    assertIso(p[4], 'modified_at');
    assertIso(p[8], 'collected_at');
  });

  test('缺失的 created_at / modified_at 保持 null (不变成 "Invalid Date")', async () => {
    const { db, calls } = makeFakeDb('mysql');
    const metrics = {
      ...ACCOUNT_METRICS,
      entries: [{ sam: 'bob', action: 'modified', change_date: '2026-10-20' }]
    };
    await upsertMembers(db, metrics, 'DC01', 'run-1', makeLogger());
    const p = findCall(calls, 'ad_account_change').params;
    assert.equal(p[3], null, 'created_at 缺失应为 null');
    assert.equal(p[4], null, 'modified_at 缺失应为 null');
    assertNaive(p[8], 'collected_at');
  });
});

// ---------------------------------------------------------------------------
// B. routes/system-inapp-notifications.js
// ---------------------------------------------------------------------------

describe('B. system-inapp-notifications — system_alerts 的 DATETIME 列', () => {
  function makeRouter(dialect) {
    const { db, calls } = makeFakeDb(dialect);
    const router = createSystemInappNotificationsRouter({
      db,
      requireAuth: (_req, _res, next) => next(),
      requirePerm: () => (_req, _res, next) => next(),
      logger: makeLogger()
    });
    return { db, calls, router };
  }

  test('MySQL 侧 3 个 since bind 必须是 naive 格式, response.since 仍是 ISO', async () => {
    const { calls, router } = makeRouter('mysql');
    const handler = findRouteHandler(router, 'get', '/api/admin/system-alerts/since');
    const res = makeRes();
    await handler({ query: { since: '2026-10-20T00:00:00.000Z', limit: '10' } }, res, () => {});

    assert.equal(res._out.statusCode, 200, `端点应 200, 实际 ${res._out.statusCode} body=${JSON.stringify(res._out.body)}`);
    const p = findCall(calls, 'FROM system_alerts').params;
    assert.equal(p.length, 3, '应有 3 个 since 占位符');
    p.forEach((v, i) => assertNaive(v, `since[${i}]`));
    // response body 的 since 是前端 watermark, 必须是 ISO
    assert.equal(res._out.body.since, '2026-10-20T00:00:00.000Z', 'response.since 应保持 ISO');
  });

  test('MSSQL 侧 3 个 since bind 必须仍是 ISO (零行为变化)', async () => {
    const { calls, router } = makeRouter('mssql');
    const handler = findRouteHandler(router, 'get', '/api/admin/system-alerts/since');
    const res = makeRes();
    await handler({ query: { since: '2026-10-20T00:00:00.000Z', limit: '10' } }, res, () => {});

    assert.equal(res._out.statusCode, 200);
    const p = findCall(calls, 'FROM system_alerts').params;
    p.forEach((v, i) => assertIso(v, `since[${i}]`));
  });
});

// ---------------------------------------------------------------------------
// C. db/sql.js — healthSummaryWithHeartbeat (仅 mysql 段)
// ---------------------------------------------------------------------------

describe('C. db/sql.js — healthSummaryWithHeartbeat 的第 3 个 bind', () => {
  const SINCE_MS = Date.parse('2026-10-20T00:00:00.000Z');

  test('MySQL 段: 第 3 个 bind 必须是 naive 格式', () => {
    const built = buildSql('mysql').dcOverview.healthSummaryWithHeartbeat({
      sinceMs: SINCE_MS, staleMinutes: 5, windowHours: 24
    });
    assertNaive(built.params[2], 'sinceMs');
    assert.equal(built.params[2], '2026-10-20 00:00:00');
    assert.equal(built.params[2], toMysqlDatetime(new Date(SINCE_MS)));
  });

  test('MSSQL 段: 第 3 个 bind 必须仍是 ISO (零行为变化)', () => {
    const built = buildSql('mssql').dcOverview.healthSummaryWithHeartbeat({
      sinceMs: SINCE_MS, staleMinutes: 5, windowHours: 24
    });
    assertIso(built.params[2], 'sinceMs');
  });
});

// ---------------------------------------------------------------------------
// D. services/heartbeat-report.js
// ---------------------------------------------------------------------------

describe('D. heartbeat-report — ad_replication_status.collected_at', () => {
  test('MySQL 侧 since bind 必须是 naive 格式', async () => {
    const { db, calls } = makeFakeDb('mysql');
    await heartbeatReportService.getLatestReportDetail('DC01', db);
    const p = findCall(calls, 'FROM ad_replication_status').params;
    assert.equal(p.length, 3, '应有 3 个 bind (agent_id ×2 + since)');
    assertNaive(p[2], 'since');
  });

  test('MSSQL 侧 since bind 必须仍是 ISO (零行为变化)', async () => {
    const { db, calls } = makeFakeDb('mssql');
    await heartbeatReportService.getLatestReportDetail('DC01', db);
    const p = findCall(calls, 'FROM ad_replication_status').params;
    assertIso(p[2], 'since');
  });
});

// ---------------------------------------------------------------------------
// E. routes/system-settings-v2.js — ad_system_registration.expires_at
// ---------------------------------------------------------------------------

describe('E. system-settings-v2 — ad_system_registration.expires_at', () => {
  const REQUEST_ID = 'r1615-test-request';

  /**
   * 造一个可用的 base32 license 申请单:
   *   - code 由 `encodeLicenseCode(data)` 生成 (与 verifyLicenseCode 同一套 key)
   *   - 申请单 JSON 落在 <installPath>/data/license-requests/<id>.json
   *     (license-request-store.js 的 _licenseRequestsDir 规则)
   *   - installPath 由 APPSETTINGS_PATH 的 dirname 推出 (init/marker.js)
   */
  function makeLicenseFixture() {
    const installPath = makeInstallPath();
    const data = {
      mac_address: 'AA:BB:CC:DD:EE:FF',
      months: 2,
      max_nodes: 10,
      installed_at: '2026-10-01T00:00:00.000Z',
      signature: 'R1615TESTSIGNATURE',
      instance_id: 'r1615-test-instance'
    };
    const code = encodeLicenseCode(data);
    writeFileSync(
      path.join(installPath, 'data', 'license-requests', `${REQUEST_ID}.json`),
      JSON.stringify(data, null, 2),
      'utf8'
    );
    return { installPath, code };
  }

  async function activate(dialect) {
    const { installPath, code } = makeLicenseFixture();
    const prevAppsettings = process.env.APPSETTINGS_PATH;
    process.env.APPSETTINGS_PATH = path.join(installPath, 'appsettings.json');
    const { db, calls } = makeFakeDb(dialect);
    // writeAudit / enqueueLicenseNotify 走 getDb() 全局 ⇒ 替掉它
    _setDbForTest(db);
    try {
      const router = createSystemSettingsV2Router({
        db,
        requireAuth: (_req, _res, next) => next(),
        requirePerm: () => (_req, _res, next) => next(),
        logger: makeLogger()
      });
      const handler = findRouteHandler(router, 'post', '/api/admin/system-settings-v2/license/base32/activate');
      const res = makeRes();
      await handler(
        { body: { license_code: code, request_id: REQUEST_ID }, user: { sub: 'u-test' } },
        res,
        () => {}
      );
      return { calls, res };
    } finally {
      if (prevAppsettings === undefined) delete process.env.APPSETTINGS_PATH;
      else process.env.APPSETTINGS_PATH = prevAppsettings;
    }
  }

  test('MySQL 侧 expires_at bind 必须是 naive 格式, response.expires_at 仍是 ISO', async () => {
    const { calls, res } = await activate('mysql');
    assert.equal(res._out.statusCode, 200,
      `激活端点应 200, 实际 ${res._out.statusCode} body=${JSON.stringify(res._out.body)}`);
    const call = findCall(calls, 'INSERT INTO ad_system_registration');
    // params 顺序: 0 license_key · 1 license_hash · 2 expires_at · 3 instance_id ...
    assertNaive(call.params[2], 'expires_at');
    // response / audit / notify 用的仍是 ISO
    assertIso(res._out.body.expires_at, 'response.expires_at');
  });

  test('MSSQL 侧 expires_at bind 必须仍是 ISO (零行为变化)', async () => {
    const { calls, res } = await activate('mssql');
    assert.equal(res._out.statusCode, 200,
      `激活端点应 200, 实际 ${res._out.statusCode} body=${JSON.stringify(res._out.body)}`);
    const call = findCall(calls, 'INSERT INTO ad_system_registration');
    assertIso(call.params[2], 'expires_at');
  });
});

// ---------------------------------------------------------------------------
// F. services/replication.js — ad_replication_active_errors
// ---------------------------------------------------------------------------

describe('F. replication — ad_replication_active_errors 的 DATETIME 列', () => {
  const ROW = {
    sourceDc: 'DC01',
    destDc: 'DC02',
    agentId: 'DC01',
    namingContext: 'CN=Part,DC=corp,DC=local',
    statusCode: 1398,
    collectedAt: '2026-10-20T10:00:00.000Z',
    lastAttemptTime: '2026-10-20T10:00:00.000Z',
    errorMessage: '命名空间绑定失败'
  };

  async function runUpsert(dialect) {
    const { db, calls } = makeFakeDb(dialect);
    _setDbForTest(db);
    await upsertStatus([{ ...ROW }], { logger: makeLogger() });
    return calls;
  }

  test('MySQL 侧 last_attempt_time / first_seen_at / last_reported_at 必须是 naive 格式', async () => {
    const calls = await runUpsert('mysql');
    const p = findCall(calls, 'INSERT INTO ad_replication_active_errors').params;
    // params 顺序: 0 source_dc · 1 dest_dc · 2 naming_context · 3 status_code
    //   4 last_attempt_time · 5 first_seen_at · 6 last_reported_at · 7 last_error_message
    assertNaive(p[4], 'last_attempt_time');
    assertNaive(p[5], 'first_seen_at');
    assertNaive(p[6], 'last_reported_at');
    assert.equal(p[4], '2026-10-20 10:00:00');
  });

  test('MSSQL 侧同一批 bind 必须是 naive 格式 (文件内惯例: 无条件转换 + CAST(? AS DATETIME2))', async () => {
    const calls = await runUpsert('mssql');
    const p = findCall(calls, 'ad_replication_active_errors').params;
    assertNaive(p[4], 'last_attempt_time');
    assertNaive(p[5], 'first_seen_at');
    assertNaive(p[6], 'last_reported_at');
  });

  test('缺 last_attempt_time 时保持 null (不是 "Invalid Date")', async () => {
    const { db, calls } = makeFakeDb('mysql');
    _setDbForTest(db);
    await upsertStatus(
      [{ ...ROW, lastAttemptTime: undefined }],
      { logger: makeLogger() }
    );
    const p = findCall(calls, 'INSERT INTO ad_replication_active_errors').params;
    assert.equal(p[4], null, 'last_attempt_time 缺失应为 null');
    assert.equal(p[5], null, 'first_seen_at 缺失应为 null');
    assert.equal(p[6], null, 'last_reported_at 缺失应为 null');
  });
});

// ---------------------------------------------------------------------------
// 附1. routes/member-servers.js — systemSettings.upsert 的参数个数
// ---------------------------------------------------------------------------

describe('附1. member-servers — systemSettings.upsert 只接受 2 个占位符', () => {
  test('cadence PUT 只绑 2 个参数 (updated_at 由 DB 端 UTC_TIMESTAMP() 算)', async () => {
    const { db, calls } = makeFakeDb('mysql');
    _setDbForTest(db);
    const router = memberRouter({ config: {}, logger: makeLogger(), db });
    const handler = findRouteHandler(router, 'put', '/api/admin/member-servers/port-probe/cadence');
    const res = makeRes();
    await handler({ body: { intervalMs: 15000 } }, res, () => {});

    assert.equal(res._out.statusCode, 200,
      `cadence PUT 应 200, 实际 ${res._out.statusCode} body=${JSON.stringify(res._out.body)}`);
    const call = findCall(calls, 'INSERT INTO system_settings');
    assert.equal(call.params.length, 2,
      `systemSettings.upsert 只有 2 个占位符, 实际传了 ${call.params.length} 个: ${JSON.stringify(call.params)}`);
    assert.equal(call.params[0], 'member_port_probe_interval_ms');
    assert.equal(call.params[1], '15000');
  });
});
