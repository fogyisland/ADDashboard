// center/tests/email-outbox-degrade.test.js
// R161.11 (2026-10-26) — 邮件队列 / 邮件历史: 空数据**不是**错误 + 失败必留痕
//
// ★ 现场 (操作员原话):
//     GET http://localhost:8080/api/admin/email-queue?limit=500       500
//     GET http://localhost:8080/api/admin/email-history?days=30&...   500
//     「邮件队列和邮件历史两个界面出错, 也就是数据如果是空感觉会出问题」
//
// ★ 根因分层 (三层, 本文件逐层锁住):
//   ① 分类层 (utils/dbError.js): 把驱动原始错误翻成**可判定**的 kind ——
//      表/列缺失 (schema 漂移) / 语法 / 连接 / 约束 / 其它。
//      双方言: MySQL (err.code 字符串 / err.errno 数字) + MSSQL (err.number 数字),
//      且必须**穿过** db facade 的 DbError 包装 (顶层 code 被归一化成 'UNKNOWN',
//      原始错误挂在 originalError 上 —— 不剥壳就会把"表不存在"误判成 other)。
//   ② 降级层 (routes/email-outbox-common.js):
//      表/列缺失 ⇒ HTTP 200 + { rows: [], count: 0, degraded: true, reason,
//      reasonText, detail, missingTable, missingColumn, diagnosticsUrl }
//      ⇒ **空数据渲染成空列表, 绝不 500**。其它错误 ⇒ 保持 500, 但补
//      errorCode / errorKind / detail。
//   ③ 留痕层: 上面**两条**路径都必须落 pino error 日志。
//      现场之所以"查不动", 就是因为路由 catch 只回 500 而**一行日志都没有**
//      (NSSM AppStderr='' 把 stderr 也丢了) ⇒ 静默失败是最贵的失败。
//
// 用法: cd Server/center && node --test tests/email-outbox-degrade.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DB_ERROR_KIND,
  classifyDbError,
  unwrapDbError,
  isDegradableKind,
  DEGRADE_REASON_TEXT
} from '../src/utils/dbError.js';

import {
  handleListFailure,
  buildDegradedPayload,
  logRouteError,
  OUTBOX_DIAGNOSTICS_URL
} from '../src/routes/email-outbox-common.js';

import { createEmailQueueRouter } from '../src/routes/email-queue.js';
import { createEmailHistoryRouter } from '../src/routes/email-history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const WEB_SRC = path.join(CENTER_ROOT, 'web', 'src');

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 造一个带 code / errno / number / originalError 的错误 (对齐驱动 + DbError 形状)。 */
function makeError({ code, errno, number, message, originalError }) {
  const e = new Error(message || 'boom');
  if (code) e.code = code;
  if (typeof errno === 'number') e.errno = errno;
  if (typeof number === 'number') e.number = number;
  if (originalError) e.originalError = originalError;
  return e;
}

/** 记录 pino 调用的假 logger。 */
function makeLogger() {
  const entries = [];
  return {
    entries,
    error(payload, msg) { entries.push({ level: 'error', payload, msg }); },
    warn(payload, msg) { entries.push({ level: 'warn', payload, msg }); },
    info(payload, msg) { entries.push({ level: 'info', payload, msg }); },
    debug(payload, msg) { entries.push({ level: 'debug', payload, msg }); },
    get errorCount() { return entries.filter((e) => e.level === 'error').length; }
  };
}

/** 假 express response。 */
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

/** 从 express Router 里取出某个端点的最后一个 handler (绕过鉴权中间件)。 */
function findRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && Boolean(l.route.methods[method])
  );
  assert.ok(layer, `未找到路由 ${method.toUpperCase()} ${routePath}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

/** 假 db —— execute 抛指定错误。 */
function makeDb({ dialect = 'mysql', error = null, rows = [] } = {}) {
  return {
    dialect,
    sql: {
      emailQueue: { listQueue: () => 'SELECT * FROM system_alert_outbox' },
      emailHistory: { listSent: () => 'SELECT * FROM system_alert_outbox UNION ALL SELECT * FROM report_email_outbox' }
    },
    async execute() {
      if (error) throw error;
      return { rows };
    },
    async query() { return { rows }; }
  };
}

// ---------------------------------------------------------------------------
// A. 分类器: 双方言 + 穿过 DbError 包装
// ---------------------------------------------------------------------------

describe('A. classifyDbError — MySQL + MSSQL 双方言', () => {
  test('MySQL: 按 err.code 判定', () => {
    assert.equal(
      classifyDbError(makeError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'x.y' doesn't exist" })).kind,
      DB_ERROR_KIND.TABLE_MISSING
    );
    assert.equal(
      classifyDbError(makeError({ code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'x' in 'field list'" })).kind,
      DB_ERROR_KIND.COLUMN_MISSING
    );
    assert.equal(
      classifyDbError(makeError({ code: 'ER_PARSE_ERROR', message: 'You have an error in your SQL syntax' })).kind,
      DB_ERROR_KIND.SYNTAX
    );
    assert.equal(
      classifyDbError(makeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3306' })).kind,
      DB_ERROR_KIND.CONNECTION
    );
    assert.equal(
      classifyDbError(makeError({ code: 'ER_DUP_ENTRY', message: "Duplicate entry '1' for key 'PRIMARY'" })).kind,
      DB_ERROR_KIND.CONSTRAINT
    );
  });

  test('MySQL: code 丢了时按 err.errno 判定', () => {
    assert.equal(classifyDbError(makeError({ errno: 1146, message: 'nope' })).kind, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(classifyDbError(makeError({ errno: 1054, message: 'nope' })).kind, DB_ERROR_KIND.COLUMN_MISSING);
    assert.equal(classifyDbError(makeError({ errno: 1064, message: 'nope' })).kind, DB_ERROR_KIND.SYNTAX);
    assert.equal(classifyDbError(makeError({ errno: 1062, message: 'nope' })).kind, DB_ERROR_KIND.CONSTRAINT);
    assert.equal(classifyDbError(makeError({ errno: 1049, message: 'nope' })).kind, DB_ERROR_KIND.CONNECTION);
  });

  test('MSSQL: 按 err.number 判定', () => {
    assert.equal(classifyDbError(makeError({ number: 208, message: "Invalid object name 'x'." })).kind, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(classifyDbError(makeError({ number: 207, message: "Invalid column name 'x'." })).kind, DB_ERROR_KIND.COLUMN_MISSING);
    assert.equal(classifyDbError(makeError({ number: 102, message: 'Incorrect syntax near x' })).kind, DB_ERROR_KIND.SYNTAX);
    assert.equal(classifyDbError(makeError({ number: 18456, message: 'Login failed' })).kind, DB_ERROR_KIND.CONNECTION);
    assert.equal(classifyDbError(makeError({ number: 2627, message: 'unique constraint' })).kind, DB_ERROR_KIND.CONSTRAINT);
  });

  test('★ 穿过 db facade 的 DbError 包装 (顶层 code 被归一化成 UNKNOWN)', () => {
    // 这一条是现场的形状: 顶层 error.code = 'UNKNOWN' (归一化后), 真正的
    // ER_NO_SUCH_TABLE 挂在 originalError 上 ⇒ 不剥壳就会误判成 other,
    // 于是"表不存在"被当成硬错误 500, 而这恰恰是最该降级的情形。
    const inner = makeError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'ad.system_alert_outbox' doesn't exist" });
    const wrapped = makeError({ code: 'UNKNOWN', message: `未知错误: ${inner.message}`, originalError: inner });
    const info = classifyDbError(wrapped);
    assert.equal(info.kind, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(info.isSchemaDrift, true);
  });

  test('unwrapDbError — 最多剥 3 层, 认得出原始错误', () => {
    const inner = makeError({ code: 'ER_BAD_FIELD_ERROR', message: 'x' });
    const l2 = makeError({ code: 'UNKNOWN', originalError: inner });
    const l1 = makeError({ code: 'UNKNOWN', originalError: l2 });
    assert.equal(unwrapDbError(l1), inner);
    assert.equal(unwrapDbError(null), null);
  });

  test('message 兜底 — 结构化字段全丢时靠正则救', () => {
    assert.equal(classifyDbError(new Error("Table 'ad.x' doesn't exist")).kind, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(classifyDbError(new Error('Unknown table ad.x')).kind, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(classifyDbError(new Error("Invalid object name 'x'")).kind, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(classifyDbError(new Error("Unknown column 'y' in 'field list'")).kind, DB_ERROR_KIND.COLUMN_MISSING);
    assert.equal(classifyDbError(new Error("Invalid column name 'y'.")).kind, DB_ERROR_KIND.COLUMN_MISSING);
    assert.equal(classifyDbError(new Error('You have an error in your SQL syntax')).kind, DB_ERROR_KIND.SYNTAX);
  });

  test('缺哪个表/列 —— 名字要抓出来 (降级提示必须指名道姓)', () => {
    const info = classifyDbError(new Error("Table 'ad.system_alert_outbox' doesn't exist"));
    assert.equal(info.missingTable, 'ad.system_alert_outbox');
    assert.equal(info.missingColumn, null);

    const info2 = classifyDbError(new Error("Unknown column 'sent_at' in 'field list'"));
    assert.equal(info2.missingColumn, 'sent_at');
    assert.equal(info2.missingTable, null);
  });

  test('认不出的错误 ⇒ kind=other, isSchemaDrift=false (不许乱降级)', () => {
    const info = classifyDbError(new Error('something went sideways'));
    assert.equal(info.kind, DB_ERROR_KIND.OTHER);
    assert.equal(info.isSchemaDrift, false);
    assert.equal(isDegradableKind(info.kind), false);
  });

  test('isDegradableKind 只对表/列缺失为真', () => {
    assert.equal(isDegradableKind(DB_ERROR_KIND.TABLE_MISSING), true);
    assert.equal(isDegradableKind(DB_ERROR_KIND.COLUMN_MISSING), true);
    assert.equal(isDegradableKind(DB_ERROR_KIND.SYNTAX), false);
    assert.equal(isDegradableKind(DB_ERROR_KIND.CONNECTION), false);
    assert.equal(isDegradableKind(DB_ERROR_KIND.CONSTRAINT), false);
    assert.equal(isDegradableKind(DB_ERROR_KIND.OTHER), false);
  });

  test('降级原因文案 — 表缺失与列缺失要说得清楚', () => {
    assert.ok(DEGRADE_REASON_TEXT[DB_ERROR_KIND.TABLE_MISSING]);
    assert.ok(DEGRADE_REASON_TEXT[DB_ERROR_KIND.COLUMN_MISSING]);
    assert.notEqual(
      DEGRADE_REASON_TEXT[DB_ERROR_KIND.TABLE_MISSING],
      DEGRADE_REASON_TEXT[DB_ERROR_KIND.COLUMN_MISSING]
    );
  });
});

// ---------------------------------------------------------------------------
// B. 降级层: 空数据渲染成空列表, 绝不 500
// ---------------------------------------------------------------------------

describe('B. handleListFailure — 表/列缺失 ⇒ 200 + 空列表 + degraded', () => {
  test('表缺失 ⇒ 200 + { rows:[], count:0, degraded:true }', () => {
    const logger = makeLogger();
    const res = makeRes();
    const err = makeError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'ad.system_alert_outbox' doesn't exist" });

    const degraded = handleListFailure({
      logger, scope: 'email-queue', err, extra: { limit: 500 }, res
    });

    assert.equal(degraded, true, '表缺失必须走降级分支');
    assert.equal(res._out.statusCode, 200, '降级必须是 200 —— 页面要能开');
    assert.deepEqual(res._out.body.rows, [], '必须返回空列表');
    assert.equal(res._out.body.count, 0);
    assert.equal(res._out.body.degraded, true);
    assert.equal(res._out.body.reason, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(res._out.body.missingTable, 'ad.system_alert_outbox');
    assert.equal(res._out.body.limit, 500, '端点自己的字段必须保留');
    assert.ok(res._out.body.reasonText && res._out.body.reasonText.length > 0);
    assert.ok(res._out.body.detail && res._out.body.detail.length > 0, '必须带原始原因, 别让操作员只能看 DevTools');
    assert.equal(res._out.body.diagnosticsUrl, OUTBOX_DIAGNOSTICS_URL);
  });

  test('列缺失 ⇒ 200 + degraded', () => {
    const logger = makeLogger();
    const res = makeRes();
    const err = makeError({ code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'sent_at' in 'field list'" });

    const degraded = handleListFailure({ logger, scope: 'email-history', err, extra: { days: 30 }, res });

    assert.equal(degraded, true);
    assert.equal(res._out.statusCode, 200);
    assert.equal(res._out.body.degraded, true);
    assert.equal(res._out.body.reason, DB_ERROR_KIND.COLUMN_MISSING);
    assert.equal(res._out.body.missingColumn, 'sent_at');
  });

  test('连接错误 ⇒ 500 + errorCode/errorKind/detail (不降级)', () => {
    const logger = makeLogger();
    const res = makeRes();
    const err = makeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3306' });

    const degraded = handleListFailure({ logger, scope: 'email-queue', err, extra: { limit: 500 }, res });

    assert.equal(degraded, false, '连接断了不能降级成"空队列" —— 那是在骗操作员');
    assert.equal(res._out.statusCode, 500);
    assert.equal(res._out.body.errorKind, DB_ERROR_KIND.CONNECTION);
    assert.equal(res._out.body.errorCode, 'ECONNREFUSED');
    assert.ok(res._out.body.detail);
    assert.equal(res._out.body.diagnosticsUrl, OUTBOX_DIAGNOSTICS_URL);
  });

  test('语法错误 ⇒ 500 + kind=syntax', () => {
    const logger = makeLogger();
    const res = makeRes();
    const err = makeError({ code: 'ER_PARSE_ERROR', message: 'You have an error in your SQL syntax' });

    handleListFailure({ logger, scope: 'email-queue', err, res });

    assert.equal(res._out.statusCode, 500);
    assert.equal(res._out.body.errorKind, DB_ERROR_KIND.SYNTAX);
  });

  test('★ 每一条失败路径都必须落 pino error 日志 (不许静默失败)', () => {
    const cases = [
      makeError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'x' doesn't exist" }),
      makeError({ code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'x'" }),
      makeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }),
      makeError({ code: 'ER_PARSE_ERROR', message: 'syntax' }),
      new Error('完全认不出的错误')
    ];
    for (const err of cases) {
      const logger = makeLogger();
      handleListFailure({ logger, scope: 'email-queue', err, res: makeRes() });
      assert.equal(logger.errorCount, 1,
        `错误 [${err.message}] 没有落 error 日志 —— 现场就是这样查不动的`);
      const entry = logger.entries[0];
      assert.equal(entry.payload.scope, 'email-queue');
      assert.ok(entry.payload.kind, '日志里要带 kind, 便于聚合');
      assert.ok(entry.payload.err);
    }
  });

  test('没有 logger 时退回 console.error, 不抛错 (NSSM 丢 stderr 但不能崩)', () => {
    const originalError = console.error;
    const captured = [];
    console.error = (...args) => { captured.push(args.join(' ')); };
    try {
      const res = makeRes();
      const degraded = handleListFailure({
        logger: null,
        scope: 'email-queue',
        err: new Error("Table 'x' doesn't exist"),
        res
      });
      assert.equal(degraded, true);
      assert.equal(captured.length, 1, '没有 logger 也必须留痕');
      assert.match(captured[0], /email-queue/);
    } finally {
      console.error = originalError;
    }
  });

  test('buildDegradedPayload — 结构固定 (前端按它渲染)', () => {
    const info = classifyDbError(new Error("Table 'ad.x' doesn't exist"));
    const payload = buildDegradedPayload(info, { limit: 200 });
    assert.deepEqual(payload.rows, []);
    assert.equal(payload.count, 0);
    assert.equal(payload.limit, 200);
    assert.equal(payload.degraded, true);
    assert.equal(payload.reason, DB_ERROR_KIND.TABLE_MISSING);
    assert.equal(payload.diagnosticsUrl, OUTBOX_DIAGNOSTICS_URL);
  });

  test('logRouteError — 附加字段透传', () => {
    const logger = makeLogger();
    const info = classifyDbError(new Error('boom'));
    logRouteError(logger, 'email-queue retry', new Error('boom'), info, { source: 'alert', id: 7 });
    assert.equal(logger.errorCount, 1);
    assert.equal(logger.entries[0].payload.source, 'alert');
    assert.equal(logger.entries[0].payload.id, 7);
  });
});

// ---------------------------------------------------------------------------
// C. 端点级: 两个列表端点在表缺失时必须 200
// ---------------------------------------------------------------------------

describe('C. 端点级 — 邮件队列 / 邮件历史 在表缺失时返回 200 + degraded', () => {
  const auth = (req, res, next) => next();
  const perm = () => (req, res, next) => next();

  test('GET /api/admin/email-queue — 表缺失 ⇒ 200 + 空列表', async () => {
    const logger = makeLogger();
    const db = makeDb({
      error: makeError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'ad.system_alert_outbox' doesn't exist" })
    });
    const router = createEmailQueueRouter({ db, requireAuth: auth, requirePerm: perm, logger });
    const handler = findRouteHandler(router, 'get', '/api/admin/email-queue');
    const res = makeRes();

    await handler({ query: { limit: '500' } }, res);

    assert.equal(res._out.statusCode, 200, '空数据不是错误, 不许 500');
    assert.deepEqual(res._out.body.rows, []);
    assert.equal(res._out.body.count, 0);
    assert.equal(res._out.body.degraded, true);
    assert.equal(res._out.body.limit, 500);
    assert.equal(logger.errorCount, 1, '必须留痕');
  });

  test('GET /api/admin/email-history — 表缺失 ⇒ 200 + 空列表', async () => {
    const logger = makeLogger();
    const db = makeDb({
      error: makeError({ code: 'ER_NO_SUCH_TABLE', message: "Table 'ad.report_email_outbox' doesn't exist" })
    });
    const router = createEmailHistoryRouter({ db, requireAuth: auth, requirePerm: perm, logger });
    const handler = findRouteHandler(router, 'get', '/api/admin/email-history');
    const res = makeRes();

    await handler({ query: { days: '30', kind: 'all', limit: '200' } }, res);

    assert.equal(res._out.statusCode, 200);
    assert.deepEqual(res._out.body.rows, []);
    assert.equal(res._out.body.count, 0);
    assert.equal(res._out.body.degraded, true);
    assert.equal(res._out.body.days, 30);
    assert.equal(res._out.body.kind, 'all');
    assert.equal(res._out.body.limit, 200);
    assert.equal(logger.errorCount, 1);
  });

  test('两个端点 — 正常空数据 (表在, 0 行) ⇒ 200, 且**不是** degraded', async () => {
    const logger = makeLogger();
    const db = makeDb({ rows: [] });
    const router = createEmailQueueRouter({ db, requireAuth: auth, requirePerm: perm, logger });
    const handler = findRouteHandler(router, 'get', '/api/admin/email-queue');
    const res = makeRes();

    await handler({ query: {} }, res);

    assert.equal(res._out.statusCode, 200);
    assert.deepEqual(res._out.body.rows, []);
    assert.equal(res._out.body.count, 0);
    assert.equal(res._out.body.degraded, undefined,
      '表在但没数据 ⇒ 是"真的没有", 不是"查不了" ⇒ 不许挂降级横幅');
    assert.equal(logger.errorCount, 0, '正常路径不许报错日志');
  });

  test('两个端点 — 连接错误 ⇒ 500 + errorKind, 且留痕', async () => {
    const logger = makeLogger();
    const db = makeDb({ error: makeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }) });
    const router = createEmailHistoryRouter({ db, requireAuth: auth, requirePerm: perm, logger });
    const handler = findRouteHandler(router, 'get', '/api/admin/email-history');
    const res = makeRes();

    await handler({ query: {} }, res);

    assert.equal(res._out.statusCode, 500);
    assert.equal(res._out.body.errorKind, DB_ERROR_KIND.CONNECTION);
    assert.equal(logger.errorCount, 1);
  });
});

// ---------------------------------------------------------------------------
// D. 前端: 降级横幅 + <form> 包裹 (静默 Chrome 告警)
// ---------------------------------------------------------------------------

describe('D. 前端接线 (EmailConfigView)', () => {
  const VIEW = path.join(WEB_SRC, 'views', 'admin', 'EmailConfigView.vue');

  test('页面存在', () => {
    assert.ok(existsSync(VIEW), '缺少 EmailConfigView.vue');
  });

  test('处理 body.degraded (空数据与故障在界面上必须区分得开)', () => {
    const src = readFileSync(VIEW, 'utf8');
    assert.match(src, /body\.degraded/, '必须识别 degraded 标记');
    assert.match(src, /queueDegraded/, '队列要有降级横幅');
    assert.match(src, /historyDegraded/, '历史要有降级横幅');
    assert.match(src, /reasonText/, '降级提示要用后端给的文案');
  });

  test('口令输入框在 <form> 里 (消掉 Chrome 的 [DOM] Password field is not contained in a form 告警)', () => {
    const src = readFileSync(VIEW, 'utf8');
    assert.match(src, /<form[^>]*@submit\.prevent/, '口令区必须包在 <form> 里');
    const formIdx = src.indexOf('<form');
    const pwIdx = src.indexOf('type="password"');
    assert.ok(formIdx >= 0 && pwIdx >= 0);
    assert.ok(formIdx < pwIdx, '口令框必须在 <form> 之后');
  });
});
