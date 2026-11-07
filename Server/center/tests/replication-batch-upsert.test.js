// R161.31 (2026-11-07) — 性能项 3: 复制状态批量 upsert 的回归网。
//
// 背景:
//   逐行版 upsertStatus 每行 1~3 条语句 ⇒ 一次 agent report (N 个 partner)
//   付 2N~3N 次网络往返。批量化把它降到 N/150 量级。
//   ★ 批量化最容易出的错不是"变慢", 而是"变快但写错数据" ——
//     所以本文件重点锁**语义等价性**, 往返数只是顺带断言。
//
// 本文件锁 9 件事:
//   A. 批量化后**往返数**真的降下来了 (N 行 ≤ 3 条语句, 而不是 N 条)
//   B. 去重语义: 同 merge key 重复 ⇒ 保留**最后一条** (last-wins),
//      且 MSSQL 不会出现重复 merge key (MERGE 错误 8672)
//   C. status 行数 = 去重后的行数, 且 active-error 的两个分支
//      (sc===0 → DELETE / sc>0 → UPSERT) 分流正确
//   D. MSSQL MERGE 的源里**绝不出现重复 merge key** (源码级 + 行为级)
//   E. 批大小上限: mysql 200 行/批, mssql 150 行/批
//      (mssql 受 sp_executesql 的 2100 参数上限约束)
//   F. 占位符个数 == 行数 × 列数 (mysql2 预处理协议要求精确匹配,
//      少一个就报 "Incorrect arguments to mysqld_stmt_execute")
//   G. 单行失败不影响其它行 (批量化后的降级重试路径)
//   H. MSSQL 的多值 VALUES 语法形状 (VALUES 后是 N 组括号)
//   I. 双方言的列集合 1:1 平行 (同样的列、同样的顺序、同样的更新列)
//
// 用法: cd Server/center && node --test tests/replication-batch-upsert.test.js

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildSql } from '../src/db/sql.js';
import { _setDbForTest } from '../src/db/index.js';
import { upsertStatus, insertHistoryEntries, dedupeByMergeKey } from '../src/services/replication.js';
import {
  BATCH_LIMITS,
  batchLimitFor,
  chunkRows,
  upsertStatusBatchMySql,
  upsertStatusBatchMssql,
  upsertActiveErrorBatchMySql,
  upsertActiveErrorBatchMssql,
  removeActiveErrorBatchMySql,
  removeActiveErrorBatchMssql,
  upsertHistoryBatch
} from '../src/db/sql/replication-batch.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 假 db facade —— 记录每次 execute 的 (sql, params)。 */
function makeFakeDb(dialect, opts = {}) {
  const calls = [];
  const failOn = opts.failOn ?? null;
  const db = {
    dialect,
    sql: buildSql(dialect),
    execute: async (sql, params = []) => {
      calls.push({ kind: 'execute', sql, params });
      if (failOn && failOn(sql, params, calls.length)) {
        throw new Error('synthetic-batch-failure');
      }
      return { rows: [], recordset: [], insertId: 42, affectedRows: 1 };
    },
    query: async (sql, params = []) => {
      calls.push({ kind: 'query', sql, params });
      return { rows: [] };
    }
  };
  return { db, calls };
}

function makeLogger() {
  return {
    error() {}, warn() {}, info() {}, debug() {}, trace() {},
    calls: { error: 0, warn: 0, info: 0 }
  };
}

/** 造一行合法的 replication status 行。 */
function makeRow(i, overrides = {}) {
  return {
    sourceDc: `DC${String(i).padStart(3, '0')}`,
    destDc: `DC${String(i + 500).padStart(3, '0')}`,
    agentId: 'AGENT-1',
    namingContext: `CN=Part${i},DC=corp,DC=local`,
    sourceSite: 'SiteA',
    destSite: 'SiteB',
    collectedAt: '2026-11-07T10:00:00.000Z',
    lastSuccessTime: '2026-11-07T09:59:00.000Z',
    lastAttemptTime: '2026-11-07T10:00:00.000Z',
    statusCode: 0,
    errorMessage: null,
    ...overrides
  };
}

/** 统计某段 SQL 关键字出现的次数 (用来数"批量语句条数")。 */
function countMatching(calls, needle) {
  return calls.filter((c) => c.kind === 'execute' && c.sql.includes(needle)).length;
}

/** 找到第一条包含 needle 的 execute 调用。 */
function findCall(calls, needle) {
  return calls.find((c) => c.kind === 'execute' && c.sql.includes(needle)) ?? null;
}

/**
 * extractInsertCols — 从 INSERT 语句里取出**目标列清单**。
 *
 * 两个方言的 INSERT 出现在不同位置:
 *   MySQL: `INSERT INTO t\n      (col1, col2, ...)\n      VALUES ...`
 *   MSSQL: `WHEN NOT MATCHED THEN INSERT\n           (col1, col2, ...)\n           VALUES ...`
 * ⇒ 先按 "INSERT" 关键字定位, 再找它后面**第一个** `(`..`)` 括号组,
 *   避免抓到 VALUES 的括号组 (那个是 `?, ?, ...`)。
 */
function extractInsertCols(sql) {
  const insertAt = sql.search(/\bINSERT\b/i);
  assert.ok(insertAt >= 0, 'SQL 里没有 INSERT');
  const openAt = sql.indexOf('(', insertAt);
  assert.ok(openAt >= 0, 'INSERT 之后没有括号组');
  const closeAt = sql.indexOf(')', openAt);
  assert.ok(closeAt > openAt, 'INSERT 的括号组没闭合');
  return sql.slice(openAt + 1, closeAt)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------

describe('R161.31 — replication 批量 upsert', () => {
  afterEach(() => {
    // 复位 db 单例, 免得影响下一个用例
    _setDbForTest(null);
  });

  // -------------------------------------------------------------------------
  describe('A. 往返数真的降下来了', () => {
    test('A1. 30 行 → 至多 3 条语句 (逐行版是 30~90 条)', async () => {
      for (const dialect of ['mysql', 'mssql']) {
        const { db, calls } = makeFakeDb(dialect);
        _setDbForTest(db);
        const rows = Array.from({ length: 30 }, (_, i) => makeRow(i));
        await upsertStatus(rows, { logger: makeLogger() });
        const execCalls = calls.filter((c) => c.kind === 'execute');
        assert.ok(
          execCalls.length <= 3,
          `${dialect}: 30 行产生了 ${execCalls.length} 条语句, 期望 ≤ 3 (批量没生效?)`
        );
        // 至少要有 status 的批量 INSERT
        assert.ok(countMatching(calls, 'ad_replication_status') >= 1, `${dialect}: 缺 status 批量写`);
      }
    });

    test('A2. 30 行 sc=0 → status 批量 INSERT + active-error 批量 DELETE = 2 条', async () => {
      for (const dialect of ['mysql', 'mssql']) {
        const { db, calls } = makeFakeDb(dialect);
        _setDbForTest(db);
        const rows = Array.from({ length: 30 }, (_, i) => makeRow(i, { statusCode: 0 }));
        await upsertStatus(rows, { logger: makeLogger() });
        assert.equal(countMatching(calls, 'ad_replication_status'), 1, `${dialect}: status 应 1 条批量`);
        assert.equal(countMatching(calls, 'DELETE FROM ad_replication_active_errors'), 1,
          `${dialect}: active-error 删除应 1 条批量`);
        assert.equal(countMatching(calls, 'MERGE INTO ad_replication_active_errors'), 0,
          `${dialect}: sc=0 不该走 active-error upsert`);
      }
    });

    test('A3. 30 行 sc>0 → status 批量 INSERT + active-error 批量 UPSERT = 2 条', async () => {
      for (const dialect of ['mysql', 'mssql']) {
        const { db, calls } = makeFakeDb(dialect);
        _setDbForTest(db);
        const rows = Array.from({ length: 30 }, (_, i) => makeRow(i, { statusCode: 1398 }));
        await upsertStatus(rows, { logger: makeLogger() });
        assert.equal(countMatching(calls, 'ad_replication_status'), 1, `${dialect}: status 应 1 条批量`);
        assert.equal(countMatching(calls, 'ad_replication_active_errors'), 1,
          `${dialect}: active-error upsert 应 1 条批量`);
        assert.equal(countMatching(calls, 'DELETE FROM ad_replication_active_errors'), 0,
          `${dialect}: sc>0 不该走删除分支`);
      }
    });

    test('A4. appendHistory → 再加 1 条批量 INSERT (共 3 条)', async () => {
      for (const dialect of ['mysql', 'mssql']) {
        const { db, calls } = makeFakeDb(dialect);
        _setDbForTest(db);
        const rows = Array.from({ length: 30 }, (_, i) => makeRow(i));
        await upsertStatus(rows, { appendHistory: true, logger: makeLogger() });
        assert.equal(countMatching(calls, 'ad_replication_history'), 1,
          `${dialect}: history 应 1 条批量`);
      }
    });

    test('A5. insertHistoryEntries 同样批量化', async () => {
      for (const dialect of ['mysql', 'mssql']) {
        const { db, calls } = makeFakeDb(dialect);
        _setDbForTest(db);
        const rows = Array.from({ length: 30 }, (_, i) => makeRow(i, {
          namingContext: `__history__:h${i}`
        }));
        const n = await insertHistoryEntries(rows);
        assert.equal(n, 30);
        assert.equal(countMatching(calls, 'ad_replication_history'), 1,
          `${dialect}: history 应 1 条批量, 实际 ${countMatching(calls, 'ad_replication_history')}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('B. 去重语义 (last-wins)', () => {
    test('B1. dedupeByMergeKey 保留最后一条, 位置按首次出现', () => {
      const rows = [
        makeRow(1, { statusCode: 0 }),
        makeRow(2, { statusCode: 1 }),
        makeRow(1, { statusCode: 2 })   // 与第一行同 merge key
      ];
      const out = dedupeByMergeKey(rows);
      assert.equal(out.length, 2, '应去重成 2 行');
      assert.equal(out[0].statusCode, 2, '第一行的值应取最后一条 (last-wins)');
      assert.equal(out[1].statusCode, 1, '位置应保持首次出现顺序');
    });

    test('B2. dedupeByMergeKey 的键不受分隔符碰撞影响', () => {
      const a = makeRow(1, { sourceDc: 'x|y', destDc: 'z' });
      const b = makeRow(2, { sourceDc: 'x', destDc: 'y|z' });
      const out = dedupeByMergeKey([a, b]);
      assert.equal(out.length, 2, '不同三元组不该被误判成同一个');
    });

    test('B3. 重复 pair 在批量 upsert 里只出现一次', async () => {
      for (const dialect of ['mysql', 'mssql']) {
        const { db, calls } = makeFakeDb(dialect);
        _setDbForTest(db);
        const rows = [
          makeRow(1, { statusCode: 0 }),
          makeRow(2, { statusCode: 0 }),
          makeRow(1, { statusCode: 0 })   // 重复
        ];
        await upsertStatus(rows, { logger: makeLogger() });
        const statusCall = findCall(calls, 'ad_replication_status');
        assert.ok(statusCall, `${dialect}: 缺 status 调用`);
        // 12 列/行 × 2 行 = 24 个参数
        assert.equal(statusCall.params.length, 24,
          `${dialect}: 期望 2 行的参数 (24), 实际 ${statusCall.params.length}`);
      }
    });

    test('B4. 去重后的值是最后一条 (last-wins), 不是第一条', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      const rows = [
        makeRow(1, { statusCode: 1398, errorMessage: 'first' }),
        makeRow(1, { statusCode: 1722, errorMessage: 'last' })
      ];
      await upsertStatus(rows, { logger: makeLogger() });
      const activeCall = findCall(calls, 'ad_replication_active_errors');
      assert.ok(activeCall, '缺 active-error 调用');
      // 参数: 0 source_dc 1 dest_dc 2 naming_context 3 status_code
      //       4 last_attempt 5 first_seen 6 last_reported 7 error_message
      assert.equal(activeCall.params.length, 8, '应只有 1 行的参数');
      assert.equal(activeCall.params[3], 1722, 'status_code 应取最后一条');
      assert.equal(activeCall.params[7], 'last', 'error_message 应取最后一条');
    });
  });

  // -------------------------------------------------------------------------
  describe('C. active-error 分流', () => {
    test('C1. 混合 sc (0 / 1 / 1398 / -1) 分流正确', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      const rows = [
        makeRow(1, { statusCode: 0 }),
        makeRow(2, { statusCode: 1 }),
        makeRow(3, { statusCode: 1398 }),
        makeRow(4, { statusCode: -1 })     // META 哨兵 → 不动 active_errors
      ];
      await upsertStatus(rows, { logger: makeLogger() });
      const del = findCall(calls, 'DELETE FROM ad_replication_active_errors');
      const ups = findCall(calls, 'INSERT INTO ad_replication_active_errors');
      assert.ok(del, '缺 DELETE 调用');
      assert.ok(ups, '缺 UPSERT 调用');
      assert.equal(del.params.length, 3, 'DELETE 应只有 1 行 (sc=0) × 3 参数');
      assert.equal(ups.params.length, 16, 'UPSERT 应只有 2 行 (sc>0) × 8 参数');
    });

    test('C2. 全部 sc>0 ⇒ 没有 DELETE 分支', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      await upsertStatus(
        Array.from({ length: 5 }, (_, i) => makeRow(i, { statusCode: 1 })),
        { logger: makeLogger() }
      );
      assert.equal(countMatching(calls, 'DELETE FROM ad_replication_active_errors'), 0);
    });
  });

  // -------------------------------------------------------------------------
  describe('D. MSSQL MERGE 不得有重复 merge key (错误 8672)', () => {
    test('D1. MSSQL 批量 MERGE 的源里每行 merge key 唯一', async () => {
      const { db, calls } = makeFakeDb('mssql');
      _setDbForTest(db);
      // 故意造重复
      const rows = [
        makeRow(1, { statusCode: 0 }),
        makeRow(1, { statusCode: 0 }),
        makeRow(2, { statusCode: 0 }),
        makeRow(1, { statusCode: 0 })
      ];
      await upsertStatus(rows, { logger: makeLogger() });
      const mergeCall = findCall(calls, 'MERGE INTO ad_replication_status');
      assert.ok(mergeCall, '缺 MERGE 调用');
      // 参数: 12 列/行 × 去重后 2 行 = 24
      assert.equal(mergeCall.params.length, 24,
        `期望去重后 2 行 (24 参数), 实际 ${mergeCall.params.length}`);
    });

    test('D2. active-error 的 MERGE 同样去重', async () => {
      const { db, calls } = makeFakeDb('mssql');
      _setDbForTest(db);
      const rows = [
        makeRow(1, { statusCode: 1 }),
        makeRow(1, { statusCode: 1 })
      ];
      await upsertStatus(rows, { logger: makeLogger() });
      const mergeCall = findCall(calls, 'MERGE INTO ad_replication_active_errors');
      assert.ok(mergeCall, '缺 MERGE 调用');
      assert.equal(mergeCall.params.length, 8, '应只有 1 行');
    });
  });

  // -------------------------------------------------------------------------
  describe('E. 批大小上限', () => {
    test('E1. 上限常量: mysql 200 / mssql 150', () => {
      assert.equal(BATCH_LIMITS.mysql, 200);
      assert.equal(BATCH_LIMITS.mssql, 150);
      assert.equal(batchLimitFor('mysql'), 200);
      assert.equal(batchLimitFor('mssql'), 150);
    });

    test('E2. MSSQL 的 150 行 = 1800 参数 < sp_executesql 的 2100 上限', () => {
      // status 表 12 列/行
      assert.ok(BATCH_LIMITS.mssql * 12 <= 2100,
        `mssql 批大小 ${BATCH_LIMITS.mssql} × 12 列 = ${BATCH_LIMITS.mssql * 12} 超过 2100 参数上限`);
      // MySQL prepared statement 占位符上限 65535
      assert.ok(BATCH_LIMITS.mysql * 12 <= 65535,
        `mysql 批大小 ${BATCH_LIMITS.mysql} × 12 列 超过 65535 占位符上限`);
    });

    test('E3. 超过上限的行被切成多批', async () => {
      const { db, calls } = makeFakeDb('mssql');
      _setDbForTest(db);
      const rows = Array.from({ length: 320 }, (_, i) => makeRow(i));
      await upsertStatus(rows, { logger: makeLogger() });
      // 320 行 / 150 = 3 批 (150 + 150 + 20)
      assert.equal(countMatching(calls, 'MERGE INTO ad_replication_status'), 3,
        `期望 3 批, 实际 ${countMatching(calls, 'MERGE INTO ad_replication_status')}`);
    });

    test('E4. chunkRows 空数组返回空数组 (不是 [[]])', () => {
      assert.deepEqual(chunkRows([], 10), []);
      assert.deepEqual(chunkRows(null, 10), []);
      assert.equal(chunkRows([1, 2, 3], 2).length, 2);
      assert.deepEqual(chunkRows([1, 2, 3], 2), [[1, 2], [3]]);
    });
  });

  // -------------------------------------------------------------------------
  describe('F. 占位符个数必须精确等于 行数 × 列数', () => {
    test('F1. mysql status 批: 3 行 = 36 个占位符 = 36 个参数', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      await upsertStatus(
        Array.from({ length: 3 }, (_, i) => makeRow(i)),
        { logger: makeLogger() }
      );
      const c = findCall(calls, 'INSERT INTO ad_replication_status');
      assert.ok(c);
      const placeholders = (c.sql.match(/\?/g) ?? []).length;
      assert.equal(placeholders, 36, `SQL 里应 36 个 ?, 实际 ${placeholders}`);
      assert.equal(c.params.length, 36, `params 应 36 个, 实际 ${c.params.length}`);
    });

    test('F2. mssql status 批: 3 行 = 36 个占位符 = 36 个参数', async () => {
      const { db, calls } = makeFakeDb('mssql');
      _setDbForTest(db);
      await upsertStatus(
        Array.from({ length: 3 }, (_, i) => makeRow(i)),
        { logger: makeLogger() }
      );
      const c = findCall(calls, 'MERGE INTO ad_replication_status');
      assert.ok(c);
      const placeholders = (c.sql.match(/\?/g) ?? []).length;
      assert.equal(placeholders, 36, `SQL 里应 36 个 ?, 实际 ${placeholders}`);
      assert.equal(c.params.length, 36, `params 应 36 个, 实际 ${c.params.length}`);
    });

    test('F3. 每个 builder 的占位符数 = 行数 × 列数', () => {
      const builders = [
        [upsertStatusBatchMySql, 12],
        [upsertStatusBatchMssql, 12],
        [upsertActiveErrorBatchMySql, 8],
        [upsertActiveErrorBatchMssql, 8],
        [removeActiveErrorBatchMySql, 3],
        [removeActiveErrorBatchMssql, 3],
        [upsertHistoryBatch, 11]
      ];
      for (const [fn, cols] of builders) {
        for (const n of [1, 2, 7]) {
          const sql = fn(n);
          const placeholders = (sql.match(/\?/g) ?? []).length;
          assert.equal(placeholders, n * cols,
            `${fn.name}(${n}) 应有 ${n * cols} 个 ?, 实际 ${placeholders}`);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('G. 单行失败不影响其它行', () => {
    test('G1. 批量失败 ⇒ 降级逐行重试, 坏行进 errors', async () => {
      // 让**第 1 次**调用 (批量 status) 失败, 后续 (逐行重试) 成功。
      const { db, calls } = makeFakeDb('mysql', {
        failOn: (sql, params, callNo) => callNo === 1
      });
      _setDbForTest(db);
      const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
      const result = await upsertStatus(rows, { logger: makeLogger() });
      assert.equal(typeof result, 'number', '无错误时应返回数字');
      assert.equal(result, 3, '批量失败后逐行重试成功 ⇒ 3 行都算 upserted');
      // 批量 status 1 次 + 逐行 status 3 次 + active-error DELETE 批 1 次 = 5
      assert.equal(calls.filter((c) => c.kind === 'execute').length, 5,
        '期望 1 次批量 + 3 次逐行重试 + 1 次 active-error 批量');
    });

    test('G2. 批量失败且逐行也失败 ⇒ 每一行进 errors', async () => {
      // 所有 execute 都失败 ⇒ 批量失败 + 逐行重试也失败 ⇒ 3 行全进 errors
      const { db, calls } = makeFakeDb('mysql', {
        failOn: () => true
      });
      _setDbForTest(db);
      const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
      const result = await upsertStatus(rows, { logger: makeLogger() });
      assert.equal(typeof result, 'object', '有错误时应返回 {upserted, errors}');
      assert.equal(result.errors.length, 3, '3 行都失败 ⇒ 3 个 error');
      assert.equal(result.upserted, 0);
    });

    test('G2b. 批量失败但逐行成功 ⇒ 无错误, 行全部落库', async () => {
      // 只让多行批量 (params.length > 12) 失败, 逐行 (params.length === 12) 成功
      const { db, calls } = makeFakeDb('mysql', {
        failOn: (sql, params) => sql.includes('ad_replication_status') && params.length > 12
      });
      _setDbForTest(db);
      const rows = Array.from({ length: 3 }, (_, i) => makeRow(i));
      const result = await upsertStatus(rows, { logger: makeLogger() });
      assert.equal(typeof result, 'number', '降级重试全成功 ⇒ 不应有 errors');
      assert.equal(result, 3);
    });

    test('G3. 缺必填字段的行被拒 (不进 SQL)', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      const rows = [
        makeRow(1),
        { ...makeRow(2), sourceDc: null },
        { ...makeRow(3), agentId: '' }
      ];
      const result = await upsertStatus(rows, { logger: makeLogger() });
      assert.equal(typeof result, 'object');
      assert.equal(result.errors.length, 2, '2 行缺必填字段');
      const c = findCall(calls, 'ad_replication_status');
      assert.equal(c.params.length, 12, '只有 1 行有效 ⇒ 12 个参数');
    });

    test('G4. 全是无效行 ⇒ 不发任何 SQL', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      const result = await upsertStatus(
        [{ ...makeRow(1), destDc: null }],
        { logger: makeLogger() }
      );
      assert.equal(calls.filter((c) => c.kind === 'execute').length, 0, '不该发任何 SQL');
      assert.equal(typeof result, 'object');
      assert.equal(result.errors.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  describe('H. MSSQL 多值 VALUES 的语法形状', () => {
    test('H1. MERGE 的 USING 子句是 VALUES (...),(...),(...) 形式', () => {
      const sql = upsertStatusBatchMssql(3);
      assert.match(sql, /USING \(VALUES /, 'MSSQL MERGE 应用 VALUES 构造器');
      // 3 组 ( 开始 ⇒ VALUES 后应有 3 个 "("
      const afterValues = sql.slice(sql.indexOf('USING (VALUES ') + 'USING (VALUES '.length);
      const groups = (afterValues.match(/\(\s*\n\s*CAST\(/g) ?? []).length;
      assert.equal(groups, 3, `应有 3 组 VALUES 行, 实际 ${groups}`);
    });

    test('H2. 每个 cell 都有 CAST (VALUES 的列类型取自第一行)', () => {
      const sql = upsertStatusBatchMssql(2);
      const cells = (sql.match(/CAST\(\? AS /g) ?? []).length;
      // 12 列里 11 个需要 CAST (status_code 是裸 ?)
      assert.equal(cells, 22, `2 行应有 22 个 CAST, 实际 ${cells}`);
    });

    test('H3. MySQL 的 ON DUPLICATE KEY UPDATE 更新列与逐行版一致 (9 列)', () => {
      const sql = upsertStatusBatchMySql(1);
      const updated = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
      const cols = [...updated.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
      assert.deepEqual(cols, [
        'collected_at', 'agent_id', 'source_site', 'dest_site',
        'last_success_time', 'last_attempt_time', 'status_code',
        'error_message', 'partner_port_status'
      ], '更新列集合必须与逐行版逐字一致');
    });

    test('H4. MySQL 的 active-error 用 VALUES(col) 而不是 AS 别名 (MySQL 5.7 兼容)', () => {
      const sql = upsertActiveErrorBatchMySql(1);
      assert.match(sql, /ON DUPLICATE KEY UPDATE/, '应有多行 ON DUPLICATE');
      assert.doesNotMatch(sql, /AS\s+new\b/, 'MySQL 5.7 不支持 VALUES() 的 AS 别名语法');
    });

    test('H5. MSSQL 的 DELETE 用 EXISTS + 派生表 (MSSQL 不支持行值 IN)', () => {
      const sql = removeActiveErrorBatchMssql(2);
      assert.match(sql, /EXISTS\s*\(/, 'MSSQL 应用 EXISTS');
      assert.doesNotMatch(sql, /\)\s+IN\s*\(\s*\(/, 'MSSQL 不支持行值 IN');
    });

    test('H6. MySQL 的 DELETE 用行值 IN', () => {
      const sql = removeActiveErrorBatchMySql(2);
      assert.match(sql, /\(source_dc, dest_dc, naming_context\)\s+IN\s*\(/, 'MySQL 应用行值 IN');
    });
  });

  // -------------------------------------------------------------------------
  describe('I. 双方言列集合 1:1 平行', () => {
    test('I1. status 批: mysql / mssql 的 INSERT 列完全一致', () => {
      const mysqlCols = extractInsertCols(upsertStatusBatchMySql(1));
      const mssqlCols = extractInsertCols(upsertStatusBatchMssql(1));
      assert.deepEqual(mysqlCols, mssqlCols,
        `列集合不一致:\n  mysql: ${mysqlCols.join(',')}\n  mssql: ${mssqlCols.join(',')}`);
      assert.equal(mysqlCols.length, 12, 'status 表 12 列');
    });

    test('I2. active-error 批: mysql / mssql 的列完全一致', () => {
      const mysqlCols = extractInsertCols(upsertActiveErrorBatchMySql(1));
      const mssqlCols = extractInsertCols(upsertActiveErrorBatchMssql(1));
      assert.deepEqual(mysqlCols, mssqlCols,
        `列集合不一致:\n  mysql: ${mysqlCols.join(',')}\n  mssql: ${mssqlCols.join(',')}`);
      assert.equal(mysqlCols.length, 9, 'active-error 表 9 列');
    });

    test('I3. history 批: 两个方言用同一个 builder (列相同)', () => {
      const sql = upsertHistoryBatch(2);
      const placeholders = (sql.match(/\?/g) ?? []).length;
      assert.equal(placeholders, 22, '2 行 × 11 列');
      assert.match(sql, /INSERT INTO ad_replication_history/, 'history 是纯 INSERT');
      assert.doesNotMatch(sql, /ON DUPLICATE KEY|MERGE/i, 'history 不做 upsert');
    });

    test('I4. history 不去重 (每次尝试都要落库)', async () => {
      const { db, calls } = makeFakeDb('mysql');
      _setDbForTest(db);
      const rows = [
        makeRow(1, { namingContext: '__history__:a' }),
        makeRow(1, { namingContext: '__history__:a' })   // 同 key 但历史不合并
      ];
      await upsertStatus(rows, { appendHistory: true, logger: makeLogger() });
      const h = findCall(calls, 'ad_replication_history');
      assert.ok(h);
      assert.equal(h.params.length, 22, 'history 应保留 2 行 (11 列 × 2)');
    });
  });
});
