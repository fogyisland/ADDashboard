// R161.5 — init 向导「并发 apply」竞态的回归网
//
// ★ 现场 (操作员 2026-10-26, POST /api/init/db/apply 500):
//   err = "Duplicate column name 'display_name'", code = ER_DUP_FIELDNAME
//
// ★ 根因链 (本文件逐条锁住):
//   1) baseline 的幂等守卫是「INFORMATION_SCHEMA 探针 → PREPARE → EXECUTE」
//      **三步、四条独立语句**, 探针与 ALTER **之间不是原子的**。
//   2) init 向导的 POST /db/apply **没有任何互斥**: 前端 InitStep.vue 的
//      `onMounted(() => runSequence())` 与 `retry()` 都能触发, 而一次 apply
//      要跑 286 条语句 (真库实测 ~70 s) —— 这个窗口里刷新页面/组件重挂载
//      就会**并发**发出第二个 apply。
//   3) 两个 apply 各自跑完整 baseline, 两边的探针都在对方的 ALTER 之前
//      跑完 (都判定"列不存在") ⇒ 两边都执行 ALTER ⇒ 后到的那个撞
//      ER_DUP_FIELDNAME (1060)。
//      ⇒ **串行重跑是安全的** (探针会返回 1 → 'SELECT 1' → 跳过),
//         **只有并发才炸** —— 这正是本次 500 的性质。
//
// ★ 证据 (真库 .frm 时间戳, 无需凭据):
//   addashboard.ad_admin_commands.frm  14:02:32  ← #151 task_id ALTER 成功
//   addashboard.ad_admin_members.frm   14:03:01  ← #155 display_name ALTER 成功
//   init db apply failed (ER_DUP_FIELDNAME) 14:03:02.558 ← 同一 ALTER 又跑一次
//   ⇒ 同一个 ALTER **先成功后失败** 1.5 s ⇒ 必然有第二个执行者。
//
// ★ 本文件用**假 db** 复现, 不连真库: 假 db 实现了 baseline 守卫链需要的
//   最小语义 (INFORMATION_SCHEMA 探针求值 / PREPARE / EXECUTE / DEALLOCATE),
//   并且每条语句后让出事件循环, 使两个 apply 流**逐条交错** —— 正是真库上
//   两个池连接并发推进的样子。
//
// 用法: cd Server/center && node --test tests/init-apply-concurrency.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAll } from '../src/init/schema-applier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Server/ — 其下有 db/migrations/mysql/1.0.0-baseline.sql
const REPO_ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// 假 db: 复刻 baseline 守卫链所需的最小 MySQL 语义
// ---------------------------------------------------------------------------

/** 幂等冲突错误码 —— 与 schema-applier.js 里的集合必须一致。 */
const CONFLICT_CODES = ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR'];

/** MySQL 错误对象 (只要 code + message, 与 mysql2 的形状对齐)。 */
function mysqlError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 假 db —— 维护一张「表 → 列集合 / 索引集合」的极简 schema 状态。
 *
 * 支持的语句:
 *   SET @s = (SELECT IF(<cond>, '<ddl>', 'SELECT 1'))   → 求值 @s
 *   PREPARE stmt FROM @s                                → 记录待执行 DDL
 *   EXECUTE stmt                                        → 执行 DDL (可能抛 1060/1061)
 *   DEALLOCATE PREPARE stmt                             → 清空待执行 DDL
 *   其余 (CREATE TABLE / INSERT IGNORE / CREATE VIEW …)  → no-op
 */
function makeFakeDb(opts = {}) {
  const columns = new Map();   // table → Set<column>
  const indexes = new Map();   // table → Set<index>
  const tables = new Set();
  const state = {
    sVar: null,
    prepared: null,
    statements: 0,       // 走过的语句总数
    ddlExecuted: 0,      // 真正执行过的 DDL 条数
    conflicts: 0,        // 撞出的幂等冲突数
    ddlLog: [],          // 执行过的 DDL 原文 (诊断用)
    guardLog: [],        // 守卫求值轨迹 (诊断用)
  };

  const colsOf = (t) => {
    if (!columns.has(t)) columns.set(t, new Set());
    return columns.get(t);
  };
  const idxOf = (t) => {
    if (!indexes.has(t)) indexes.set(t, new Set());
    return indexes.get(t);
  };

  /**
   * 把一条 SET @s 语句里的探针子查询求值成数字, 再算 IF 的条件。
   *
   * ★ 语义 (与 baseline 的 `IF(<cond>, '<ddl>', 'SELECT 1')` 严格对齐):
   *   条件为**真** ⇒ 该列/索引**不存在** ⇒ 走 DDL 分支 (加列/建索引);
   *   条件为**假** ⇒ 已存在 ⇒ 走 'SELECT 1' 分支 (跳过)。
   */
  function evalGuard(sql) {
    const flat = sql.replace(/\s+/g, ' ');
    // 每个探针子查询: (SELECT COUNT(*) FROM INFORMATION_SCHEMA.<SRC>
    //   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '<t>' AND <KEY> = '<v>')
    const probeRe = /\(\s*SELECT COUNT\(\*\)\s+FROM INFORMATION_SCHEMA\.(COLUMNS|STATISTICS)\s+WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = '([^']+)' AND (COLUMN_NAME|INDEX_NAME) = '([^']+)'\s*\)/gi;
    let cond = flat;
    cond = cond.replace(probeRe, (_m, src, table, key, value) => {
      const has = src.toUpperCase() === 'COLUMNS'
        ? colsOf(table).has(value)
        : idxOf(table).has(value);
      return has ? '1' : '0';
    });
    // 剩下的是 "0 = 0" / "1 = 1" / "0 AND 1" 这类布尔式
    cond = cond.replace(/=/g, '===').replace(/\bAND\b/g, '&&').replace(/\bOR\b/g, '||');
    // 只取 IF( 的第一个参数
    const m = /IF\(\s*([^,]+),/.exec(cond);
    if (!m) return false;
    // eslint-disable-next-line no-new-func
    const shouldRunDdl = Boolean(new Function(`return (${m[1]});`)());
    state.guardLog.push({ cond: m[1], shouldRunDdl });
    return shouldRunDdl;
  }

  /** 从 DDL 文本里取出要改的对象。 */
  function parseDdl(ddl) {
    let m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(ddl);
    if (m) return { kind: 'addColumn', table: m[1], name: m[2] };
    m = /^ALTER TABLE (\w+) CHANGE COLUMN (\w+) (\w+)/i.exec(ddl);
    if (m) return { kind: 'changeColumn', table: m[1], from: m[2], to: m[3] };
    m = /^CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)/i.exec(ddl);
    if (m) return { kind: 'createIndex', index: m[1], table: m[2] };
    m = /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(ddl);
    if (m) return { kind: 'createTable', table: m[1] };
    return { kind: 'other' };
  }

  async function execute(sql) {
    state.statements += 1;
    const flat = sql.replace(/\s+/g, ' ').trim();

    if (/^SET @s\s*=\s*\(SELECT IF\(/i.test(flat)) {
      // 求值条件 → 选 DDL 分支或 'SELECT 1'
      // ★ 条件为真 = 目标列/索引**不存在** = 该执行 DDL (SQL 的 IF(cond, ddl, 'SELECT 1'))
      const shouldRunDdl = evalGuard(flat);
      // 取 IF 的第二个参数 (DDL 文本)
      const ddlMatch = /,\s*'((?:[^']|'')*)'\s*,\s*'SELECT 1'\s*\)/i.exec(flat);
      state.sVar = shouldRunDdl
        ? (ddlMatch ? ddlMatch[1].replace(/''/g, "'") : 'SELECT 1')
        : 'SELECT 1';
      return;
    }
    if (/^PREPARE stmt FROM @s$/i.test(flat)) {
      state.prepared = state.sVar;
      return;
    }
    if (/^EXECUTE stmt$/i.test(flat)) {
      const ddl = state.prepared;
      if (!ddl || /^SELECT 1$/i.test(ddl)) return;
      // ★ 测试钩子: 在真正执行 DDL 之前拦一道 (可以抛错), 用来模拟
      //   "探针说列不存在, 但另一个执行者已经把它建好了" 的竞态现场。
      if (typeof opts.onDdl === 'function') opts.onDdl(ddl);
      state.ddlExecuted += 1;
      state.ddlLog.push(ddl);
      const t = parseDdl(ddl);
      if (t.kind === 'addColumn') {
        if (colsOf(t.table).has(t.name)) {
          state.conflicts += 1;
          throw mysqlError('ER_DUP_FIELDNAME', `Duplicate column name '${t.name}' | ddl=${ddl}`);
        }
        colsOf(t.table).add(t.name);
      } else if (t.kind === 'changeColumn') {
        if (colsOf(t.table).has(t.to)) {
          state.conflicts += 1;
          throw mysqlError('ER_DUP_FIELDNAME', `Duplicate column name '${t.to}' | ddl=${ddl}`);
        }
        colsOf(t.table).delete(t.from);
        colsOf(t.table).add(t.to);
      } else if (t.kind === 'createIndex') {
        if (idxOf(t.table).has(t.index)) {
          state.conflicts += 1;
          throw mysqlError('ER_DUP_KEYNAME', `Duplicate key name '${t.index}' | ddl=${ddl}`);
        }
        idxOf(t.table).add(t.index);
      } else if (t.kind === 'createTable') {
        if (tables.has(t.table)) {
          state.conflicts += 1;
          throw mysqlError('ER_TABLE_EXISTS_ERROR', `Table '${t.table}' already exists | ddl=${ddl}`);
        }
        tables.add(t.table);
      }
      return;
    }
    if (/^DEALLOCATE PREPARE stmt$/i.test(flat)) {
      state.prepared = null;
      return;
    }
    // 裸 CREATE TABLE (无 IF NOT EXISTS) 也要建模, 否则并发时看不到冲突
    const bareCreate = /^CREATE TABLE (\w+)/i.exec(flat);
    if (bareCreate && !/IF NOT EXISTS/i.test(flat)) {
      if (tables.has(bareCreate[1])) {
        state.conflicts += 1;
        throw mysqlError('ER_TABLE_EXISTS_ERROR', `Table '${bareCreate[1]}' already exists`);
      }
      tables.add(bareCreate[1]);
      return;
    }
    // 其余语句 (INSERT IGNORE / CREATE VIEW / SET FOREIGN_KEY_CHECKS …) 一律 no-op
  }

  // ★ 每条语句后让出事件循环 —— 两个 apply 流因此**逐条交错**,
  //   探针与 ALTER 之间的窗口必然被对方钻进去 (这正是真库上的情形)。
  if (opts.interleave !== false) {
    const raw = execute;
    // eslint-disable-next-line no-func-assign
    execute = async (...args) => {
      const r = await raw(...args);
      await new Promise((resolve) => setImmediate(resolve));
      return r;
    };
  }

  return { execute, query: async () => ({ rows: [] }), state, columns, indexes, tables };
}

/** 收集两个并发 apply 的失败原因 (便于断言错误码)。 */
function rejectionCodes(results) {
  return results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.code || r.reason?.message || String(r.reason));
}

describe('init applyAll — R161.5 并发 DDL 竞态', () => {
  test('1. 两个并发 applyAll 不得因幂等冲突炸掉 (探针与 ALTER 之间的竞态)', async () => {
    const db = makeFakeDb();
    const results = await Promise.allSettled([
      applyAll('mysql', db, { repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard' }),
      applyAll('mysql', db, { repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard' })
    ]);

    const codes = rejectionCodes(results);
    assert.deepEqual(codes, [],
      `并发 apply 撞出了幂等冲突: ${codes.join(', ')} —— ` +
      'applyAll 必须把并发调用**串行化** (single-flight), 否则两个流会同时通过 ' +
      'INFORMATION_SCHEMA 探针, 后到的 ALTER 必撞 1060/1061 (R161.5 init 500 根因)');
  });

  test('2. 并发 applyAll 时底层 DDL 只跑一遍 (后来者复用前一个的结果)', async () => {
    const db = makeFakeDb();
    const [first, second] = await Promise.all([
      applyAll('mysql', db, { repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard' }),
      applyAll('mysql', db, { repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard' })
    ]);

    assert.ok(first && second, '两个调用都应拿到结果');
    assert.equal(first.schema.length, second.schema.length,
      '后来者应复用前一个 apply 的结果 (语句条数一致)');
    assert.ok(db.state.statements < first.schema.length * 2,
      `底层语句被执行了 ${db.state.statements} 次, 应只跑一遍 (${first.schema.length} 条) —— ` +
      'later caller 必须复用 in-flight 的 promise, 而不是重跑一遍 DDL');
  });

  test('3. 串行两次 applyAll 是幂等的 (第二次不重复加列、不报错)', async () => {
    const db = makeFakeDb();
    const first = await applyAll('mysql', db, { repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard' });
    const afterFirst = db.state.ddlExecuted;
    const second = await applyAll('mysql', db, { repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard' });

    assert.equal(second.schema.length, first.schema.length, '两次 apply 的语句条数应一致');
    assert.equal(db.state.ddlExecuted, afterFirst,
      `第二次 apply 又执行了 DDL (${db.state.ddlExecuted - afterFirst} 条) —— 探针应判定"已存在" → SELECT 1。` +
      `新增的 DDL: ${JSON.stringify(db.state.ddlLog.slice(afterFirst))}`);
    assert.equal(db.state.conflicts, 0, '串行重跑不应产生任何幂等冲突');
  });

  test('4. 兜底: 撞出 1060/1061 时跳过该语句并记录 (不中断整个 apply)', async () => {
    // 造一个"某条 ALTER 必然撞 1060"的假 db: 所有 ADD COLUMN 在真正执行时
    // 都被另一个执行者抢先建好了 ⇒ 现场就是"探针说不存在, 执行时却已存在"。
    let injectAfter = 0;
    const db = makeFakeDb({
      onDdl: (ddl) => {
        if (/^ALTER TABLE \w+ ADD COLUMN/i.test(ddl)) {
          injectAfter += 1;
          throw mysqlError('ER_DUP_FIELDNAME', "Duplicate column name 'display_name'");
        }
      }
    });

    const applied = await applyAll('mysql', db, {
      repoRoot: REPO_ROOT, createDatabase: false, databaseName: 'addashboard'
    });

    assert.ok(injectAfter > 0, '前置条件: 应至少撞到一次 ADD COLUMN 冲突');
    assert.ok(Array.isArray(applied.conflicts), 'applyAll 的结果应带 conflicts 数组');
    assert.equal(applied.conflicts.length, injectAfter,
      '每一次幂等冲突都应被记录下来 (可观测, 不静默)');
    assert.ok(applied.conflicts.every((c) => CONFLICT_CODES.includes(c.code)),
      `conflicts 只应包含幂等冲突码, 实际: ${JSON.stringify(applied.conflicts.map((c) => c.code))}`);
    assert.ok(applied.conflicts.every((c) => typeof c.statement === 'string' && c.statement.length > 0),
      '每条 conflict 都应带上出错的语句原文 (便于定位)');
    assert.ok(applied.schema.length > 0,
      '冲突被跳过后 apply 仍应跑完整个 baseline (不能半途而废)');
  });
});
