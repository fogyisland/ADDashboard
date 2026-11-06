#!/usr/bin/env node
// R161.4 — 基线 SQL **幂等性**审计
//
// WHY
// ---
// 2026-10-25 操作员在 MySQL 上跑初始化向导, POST /api/init/db/apply 报:
//     Duplicate column name 'task_id'   (errno 1060 ER_DUP_FIELDNAME)
// 根因: MySQL 基线 1.0.0-baseline.sql 里**同一张表、同一列的 DDL 出现了两代**:
//   - L867 附近: 旧代**裸** ALTER TABLE ... ADD COLUMN task_id   ← 第二次执行必炸
//   - L1709 附近: 新代**已守卫**的同一条 ALTER
// 全新库之所以没事, 是因为"旧的先执行、新的探针发现列已存在就跳过" ——
// 也就是说**新装一次过, 重跑一次炸**。而 init 向导的 POST /db/apply
// (Server/center/src/init/router.js) **每次都**调 applyAll(), 没有"已初始化就短路"
// 的分支 ⇒ 基线**必须可重复执行**。
//
// 为什么不能靠执行层兜底
// -----------------------
// 最省事的做法是"执行层遇到 1060 就跳过"。**那会把库改坏**: 基线里有一条
// 成对改名 (target_user_description → target_user_display_name)。
// 第一次跑: 旧名不存在 ⇒ 新代探针判"旧名存在?"为假 ⇒ 跳过改名 ⇒ 新名没建。
// 第二次跑: 执行层跳过 1060 ⇒ 旧名又被加回来 ⇒ 库里同时留着两个列。
// ⇒ 幂等必须落在 **DDL 本身**, 而不是执行层。
//
// 为什么不能写 `IF NOT EXISTS`
// ---------------------------
// MySQL 5.7 / 8.0 **没有** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
// 也没有 `CREATE INDEX IF NOT EXISTS` (那是 MariaDB 的方言)。
// 实测 MySQL 5.7.44: 两者都报 errno 1064 ER_PARSE_ERROR。
// ⇒ 唯一可用的写法是本文件既有的官方守卫链 (db/migrations/README.md
//    authoring rule #3):
//        SET @s = (SELECT IF(<INFORMATION_SCHEMA 探针>, '<DDL>', 'SELECT 1'));
//        PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
//    它被 splitter 切成 4 条语句, DDL 变成字符串字面量 ⇒ **顶层语句流里
//    不再出现那条 DDL** —— 这正是本检查器的静态可见性依据。
//
// 本检查器查什么
// --------------
// 双方言各查三类:
//   1. 顶层裸 DDL/DML (MySQL: ALTER / CREATE INDEX / 无 IF NOT EXISTS 的
//      CREATE TABLE / 无守卫的 CREATE VIEW / 无 IGNORE 的 INSERT /
//      无 IF EXISTS 的 DROP / TRUNCATE / RENAME / 顶层 UPDATE-DELETE);
//   2. MSSQL: 顶层语句必须被 `IF ...` 包住 (MSSQL 的守卫写法),
//      CREATE VIEW 必须有前置的守卫式 DROP VIEW;
//   3. 守卫链自身的结构完整性 (MySQL): SET @s 后面必须紧跟
//      PREPARE/EXECUTE/DEALLOCATE; 探针对象必须与 DDL 目标一致;
//      探针必须用 DATABASE() 而非硬编码库名; 成对改名必须同时探针新旧两列。
//
// ★ 第 3 类是**执行测试抓不到**的那一类: 守卫链写了一半 (例如只写了 SET @s
//   却漏了 EXECUTE) 时, 基线**不会报错**, 只是**静默少建一列** ——
//   "apply-twice 两遍都成功" 这种弱证明完全看不出来。
//
// 本检查器直接复用生产代码的 splitSqlStatements
// (center/src/init/schema-applier.js), 检查的就是**真正会被执行的那串语句**。
//
// 用法: node Server/scripts/audit/check-baseline-idempotency.mjs [file ...]
//       node Server/scripts/audit/check-baseline-idempotency.mjs --json
// 退出码: 0 = 无问题; 1 = 有问题。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

// 生产代码的唯一事实来源 —— 拆语句的语义必须跟运行时完全一致
import { splitSqlStatements } from '../../center/src/init/schema-applier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');

const DIALECT_FILES = [
  'Server/db/migrations/mysql/1.0.0-baseline.sql',
  'Server/db/migrations/mssql/1.0.0-baseline.sql',
  'LinuxServer/db/migrations/mysql/1.0.0-baseline.sql',
  'LinuxServer/db/migrations/mssql/1.0.0-baseline.sql',
];

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 归一化空白 —— 顶层语句的判定全部基于它。 */
function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

/** 语句首词 (大写)。 */
function headOf(sql) {
  const m = norm(sql).match(/^([A-Za-z_]+)/);
  return m ? m[1].toUpperCase() : '';
}

/** 去掉标识符限定符 ( ` / [ ] )。 */
function stripId(raw) {
  return String(raw).replace(/[`\[\]]/g, '').trim();
}

/** 取出一条语句里的所有单引号字符串字面量 ( '' 按转义处理)。 */
function stringLiterals(sql) {
  const out = [];
  const re = /'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(sql))) {
    out.push({ value: m[1], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 探针里被比较的列名 / 索引名 → 比较值 (0 = 不存在, 1 = 存在)。 */
function probeComparisons(condition) {
  const map = new Map();
  const re = /COLUMN_NAME\s*=\s*'([^']+)'|INDEX_NAME\s*=\s*'([^']+)'/gi;
  let m;
  while ((m = re.exec(condition))) {
    const name = m[1] || m[2];
    const after = condition.slice(m.index + m[0].length);
    const cmp = after.match(/^\s*\)?\s*=\s*([01])\b/);
    map.set(name, cmp ? Number(cmp[1]) : null);
  }
  return map;
}

/** 探针里被比较的表名集合。 */
function probeTables(condition) {
  const out = new Set();
  const re = /TABLE_NAME\s*=\s*'([^']+)'/gi;
  let m;
  while ((m = re.exec(condition))) out.add(m[1]);
  return out;
}

/** DDL 的目标表名。 */
function ddlTargetTable(ddl) {
  const t = norm(ddl);
  let m = t.match(/^ALTER\s+TABLE\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) return stripId(m[1]);
  m = t.match(/^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+\S+\s+ON\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) return stripId(m[1]);
  m = t.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) return stripId(m[1]);
  m = t.match(/^RENAME\s+TABLE\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) return stripId(m[1]);
  return null;
}

/** DDL 里的"主列名" —— 只取 ADD/CHANGE/MODIFY 的目标列, 不含 AFTER xxx。 */
function ddlColumns(ddl) {
  const t = norm(ddl);
  const out = [];
  let m = t.match(/\bADD\s+(?:COLUMN\s+)?([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) out.push(stripId(m[1]));
  m = t.match(/\bCHANGE\s+(?:COLUMN\s+)?([`[]?[A-Za-z0-9_$]+[`\]]?)\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) {
    out.push(stripId(m[1]));
    out.push(stripId(m[2]));
  }
  m = t.match(/\bMODIFY\s+(?:COLUMN\s+)?([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  if (m) out.push(stripId(m[1]));
  return out;
}

/** DDL 创建的索引名。 */
function ddlIndexName(ddl) {
  const m = norm(ddl).match(/^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
  return m ? stripId(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 守卫链解剖
// ---------------------------------------------------------------------------

const RE_GUARD_SET = /^SET\s+@s\b/i;
const RE_PREPARE = /^PREPARE\s+\w+\s+FROM\s+@s/i;
const RE_EXECUTE = /^EXECUTE\s+\w+/i;
const RE_DEALLOCATE = /^DEALLOCATE\s+PREPARE\s+\w+/i;

/**
 * 把一条 `SET @s = ...` 守卫语句解剖成结构化描述。
 * 返回 null 表示这不是一条规范守卫 (由 GUARD-NON-CANONICAL-SHAPE 负责报错)。
 */
function dissectGuard(stmt) {
  const flat = norm(stmt);
  const literals = stringLiterals(flat);
  if (literals.length < 2) return null;

  const noop = literals[literals.length - 1];
  const ddl = literals[literals.length - 2];
  if (!/^select\s+1$/i.test(noop.value)) return null;

  const condition = flat.slice(0, ddl.start);
  return {
    flat,
    condition,
    ddl: ddl.value,
    literals,
  };
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------
// 每条规则带:
//   negativeSample : 必须触发该规则的语句序列 (自检用, 见 selfTest)
//   positiveSamples: 必须**不**触发的语句序列 (防止规则过宽)
// ⇒ 规则不是死代码, 也不是过宽的网。

/** 构造一条标准 MySQL 守卫链样本。 */
function guardSample({ table, column, index, ddl, value = 0, schema = 'DATABASE()' }) {
  const infoSchema = index ? 'STATISTICS' : 'COLUMNS';
  const nameKey = index ? 'INDEX_NAME' : 'COLUMN_NAME';
  const nameVal = index || column;
  const schemaPart = schema === 'DATABASE()' ? 'TABLE_SCHEMA = DATABASE()' : `TABLE_SCHEMA = '${schema}'`;
  return [
    `SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.${infoSchema} WHERE ${schemaPart} AND TABLE_NAME = '${table}' AND ${nameKey} = '${nameVal}') = ${value}, '${ddl}', 'SELECT 1'))`,
    'PREPARE stmt FROM @s',
    'EXECUTE stmt',
    'DEALLOCATE PREPARE stmt',
  ];
}

/** 遍历语句, 把 detect 返回的 [index, message] 收集起来。 */
function collect(statements, fn) {
  const out = [];
  statements.forEach((stmt, index) => {
    const message = fn(stmt, index);
    if (message) out.push({ index, message });
  });
  return out;
}

export const RULES = [
  // -------------------------------------------------------------------------
  // MySQL — 顶层裸 DDL / DML
  // -------------------------------------------------------------------------
  {
    id: 'MYSQL-BARE-ALTER',
    dialects: ['mysql'],
    title: '顶层 ALTER TABLE 没有幂等守卫',
    why:
      'MySQL 5.7 / 8.0 没有 ADD COLUMN IF NOT EXISTS, CHANGE / DROP COLUMN 也没有幂等写法 ⇒ ' +
      '第二次执行必炸 (errno 1060 ER_DUP_FIELDNAME / 1054 ER_BAD_FIELD_ERROR / 1091 ER_DUP_KEYNAME)。',
    detect: ({ statements }) =>
      collect(statements, (stmt) =>
        /^ALTER\s+TABLE\b/i.test(norm(stmt))
          ? '顶层 ALTER TABLE 必须包进 INFORMATION_SCHEMA 守卫链 (SET @s = ... PREPARE/EXECUTE/DEALLOCATE)'
          : null
      ),
    negativeSample: ['ALTER TABLE ad_admin_commands ADD COLUMN task_id VARCHAR(64) NULL'],
    positiveSamples: [
      guardSample({
        table: 'ad_admin_commands',
        column: 'task_id',
        ddl: 'ALTER TABLE ad_admin_commands ADD COLUMN task_id VARCHAR(64) NULL',
      }),
    ],
  },
  {
    id: 'MYSQL-BARE-CREATE-INDEX',
    dialects: ['mysql'],
    title: '顶层 CREATE INDEX 没有幂等守卫',
    why:
      'MySQL 没有 CREATE INDEX IF NOT EXISTS (MariaDB 才有) ⇒ 重跑报 errno 1061 ER_DUP_KEYNAME。' +
      '建表语句内部的 KEY / UNIQUE KEY 是 CREATE TABLE 的一部分, 不算。',
    detect: ({ statements }) =>
      collect(statements, (stmt) =>
        /^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\b/i.test(norm(stmt))
          ? '顶层 CREATE INDEX 必须包进 INFORMATION_SCHEMA 守卫链 (探针用 INFORMATION_SCHEMA.STATISTICS)'
          : null
      ),
    negativeSample: ['CREATE INDEX ix_ad_admin_commands_task_id ON ad_admin_commands(task_id)'],
    positiveSamples: [
      guardSample({
        table: 'ad_admin_commands',
        index: 'ix_ad_admin_commands_task_id',
        ddl: 'CREATE INDEX ix_ad_admin_commands_task_id ON ad_admin_commands(task_id)',
      }),
      ['CREATE TABLE IF NOT EXISTS ad_x (id INT, a INT, KEY ix_a (a))'],
    ],
  },
  {
    id: 'MYSQL-CREATE-TABLE-NOT-IDEMPOTENT',
    dialects: ['mysql'],
    title: '顶层 CREATE TABLE 缺 IF NOT EXISTS',
    why: '重跑报 errno 1050 ER_TABLE_EXISTS_ERROR。',
    detect: ({ statements }) =>
      collect(statements, (stmt) => {
        const t = norm(stmt);
        if (!/^CREATE\s+TABLE\b/i.test(t)) return null;
        if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(t)) return null;
        return '顶层 CREATE TABLE 必须带 IF NOT EXISTS';
      }),
    negativeSample: ['CREATE TABLE ad_x (id INT PRIMARY KEY)'],
    positiveSamples: [['CREATE TABLE IF NOT EXISTS ad_x (id INT PRIMARY KEY)']],
  },
  {
    id: 'MYSQL-CREATE-VIEW-UNGUARDED',
    dialects: ['mysql'],
    title: '顶层 CREATE VIEW 没有前置删除守卫',
    why:
      'MySQL 的 CREATE VIEW 没有 IF NOT EXISTS ⇒ 重跑报 errno 1356 ER_VIEW_EXISTS。' +
      '合法写法: CREATE OR REPLACE VIEW, 或前面一条 DROP VIEW IF EXISTS 同名视图。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        const m = t.match(/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
        if (!m) return;
        if (m[1]) return; // CREATE OR REPLACE VIEW 本身幂等
        const viewName = stripId(m[2]);
        const prev = index > 0 ? norm(statements[index - 1]) : '';
        const dropMatch = prev.match(/DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
        if (dropMatch && stripId(dropMatch[1]) === viewName) return;
        out.push({
          index,
          message: `顶层 CREATE VIEW ${viewName} 既没有 OR REPLACE, 前面也没有 DROP VIEW IF EXISTS ${viewName}`,
        });
      });
      return out;
    },
    negativeSample: ['CREATE VIEW v_partner_inbound AS SELECT 1 AS a'],
    positiveSamples: [
      ['DROP VIEW IF EXISTS v_partner_inbound', 'CREATE VIEW v_partner_inbound AS SELECT 1 AS a'],
      ['CREATE OR REPLACE VIEW v_partner_inbound AS SELECT 1 AS a'],
    ],
  },
  {
    id: 'MYSQL-INSERT-NOT-IDEMPOTENT',
    dialects: ['mysql'],
    title: '顶层 INSERT 缺 IGNORE',
    why:
      '重跑报 errno 1062 ER_DUP_ENTRY。基线里的种子数据必须用 INSERT IGNORE —— ' +
      '这是本文件既有的约定 (23 条种子全部是 INSERT IGNORE)。',
    detect: ({ statements }) =>
      collect(statements, (stmt) => {
        const t = norm(stmt);
        if (!/^INSERT\b/i.test(t)) return null;
        if (/^INSERT\s+IGNORE\b/i.test(t)) return null;
        return '顶层 INSERT 必须写成 INSERT IGNORE';
      }),
    negativeSample: ["INSERT INTO probe_state (port_role, status) VALUES ('web', 'unknown')"],
    positiveSamples: [["INSERT IGNORE INTO probe_state (port_role, status) VALUES ('web', 'unknown')"]],
  },
  {
    id: 'MYSQL-DROP-MISSING-IF-EXISTS',
    dialects: ['mysql'],
    title: '顶层 DROP TABLE/VIEW 缺 IF EXISTS',
    why: '重跑报 errno 1051 ER_BAD_TABLE_ERROR / 1146 ER_NO_SUCH_TABLE。',
    detect: ({ statements }) =>
      collect(statements, (stmt) => {
        const t = norm(stmt);
        const m = t.match(/^DROP\s+(TABLE|VIEW)\b\s*(.*)$/i);
        if (!m) return null;
        if (/^IF\s+EXISTS\b/i.test(m[2])) return null;
        return `顶层 DROP ${m[1].toUpperCase()} 必须带 IF EXISTS`;
      }),
    negativeSample: ['DROP VIEW v_partner_inbound'],
    positiveSamples: [
      ['DROP VIEW IF EXISTS v_partner_inbound'],
      ['DROP TABLE IF EXISTS ad_dc_probe_outbound'],
    ],
  },
  {
    id: 'MYSQL-DROP-DATABASE',
    dialects: ['mysql'],
    title: '基线里出现 DROP DATABASE',
    why: '基线是"建库脚本", 任何 DROP DATABASE 都会把操作员的库删掉 —— 无论有没有 IF EXISTS。',
    detect: ({ statements }) =>
      collect(statements, (stmt) =>
        /^DROP\s+DATABASE\b/i.test(norm(stmt)) ? '基线里不允许 DROP DATABASE' : null
      ),
    negativeSample: ['DROP DATABASE IF EXISTS addashboard'],
    positiveSamples: [['DROP TABLE IF EXISTS ad_x']],
  },
  {
    id: 'MYSQL-BARE-TRUNCATE',
    dialects: ['mysql'],
    title: '顶层 TRUNCATE',
    why: 'TRUNCATE 清空数据且没有守卫语义 —— 重跑会把操作员的业务数据清空。',
    detect: ({ statements }) =>
      collect(statements, (stmt) =>
        /^TRUNCATE\b/i.test(norm(stmt)) ? '基线里不允许顶层 TRUNCATE' : null
      ),
    negativeSample: ['TRUNCATE TABLE ad_lockout_events'],
    positiveSamples: [['DROP TABLE IF EXISTS ad_x']],
  },
  {
    id: 'MYSQL-BARE-RENAME',
    dialects: ['mysql'],
    title: '顶层 RENAME TABLE',
    why: 'RENAME TABLE 没有幂等写法, 重跑报 errno 1017 ER_FILE_EXISTS / 1050 ER_TABLE_EXISTS_ERROR。',
    detect: ({ statements }) =>
      collect(statements, (stmt) =>
        /^RENAME\s+TABLE\b/i.test(norm(stmt)) ? '顶层 RENAME TABLE 必须包进守卫链' : null
      ),
    negativeSample: ['RENAME TABLE ad_old TO ad_new'],
    positiveSamples: [['DROP TABLE IF EXISTS ad_x']],
  },
  {
    id: 'MYSQL-BARE-DML',
    dialects: ['mysql'],
    title: '顶层 UPDATE / DELETE',
    why:
      '基线只负责建结构。顶层 UPDATE/DELETE 会改操作员的业务数据, 而且重跑会重复施加 —— ' +
      '幂等与否取决于数据, 不可控 ⇒ 一律禁止。',
    detect: ({ statements }) =>
      collect(statements, (stmt) => {
        const t = norm(stmt);
        if (/^UPDATE\b/i.test(t)) return '基线里不允许顶层 UPDATE (只放种子数据, 且用 INSERT IGNORE)';
        if (/^DELETE\b/i.test(t)) return '基线里不允许顶层 DELETE';
        return null;
      }),
    negativeSample: ["UPDATE system_config SET config_value = '1' WHERE config_key = 'polling_interval_minutes'"],
    positiveSamples: [['DROP TABLE IF EXISTS ad_x']],
  },

  // -------------------------------------------------------------------------
  // MSSQL — 顶层语句必须被 IF 包住
  // -------------------------------------------------------------------------
  {
    id: 'MSSQL-UNGUARDED-TOPLEVEL',
    dialects: ['mssql'],
    title: 'MSSQL 顶层语句没有被 IF 守卫',
    why:
      'MSSQL 侧没有 MySQL 那套 SET @s 守卫链, 本项目一贯的写法是 ' +
      '`IF <不存在条件> BEGIN <DDL> END` / `IF NOT EXISTS (...) <DML>`。' +
      '裸的顶层 DDL 重跑必然报 "There is already an object named ..."。' +
      '唯一豁免: CREATE VIEW —— 它靠前一条守卫式 DROP VIEW 保证可重跑 (见 MSSQL-CREATE-VIEW-NO-PRECEDING-DROP)。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const head = headOf(stmt);
        if (head === 'IF') return;
        // 豁免只给 CREATE VIEW (它靠前一条守卫式 DROP VIEW 保证可重跑);
        // 顶层的 CREATE TABLE / CREATE INDEX 一律要报 —— 豁免写宽了就等于没规则。
        if (head === 'CREATE' && /^CREATE\s+(?:OR\s+ALTER\s+)?VIEW\b/i.test(norm(stmt))) return;
        out.push({ index, message: `顶层语句以 ${head || '?'} 开头, 没有被 IF ... 守卫` });
      });
      return out;
    },
    negativeSample: ['CREATE TABLE ad_x (id INT NOT NULL)'],
    positiveSamples: [
      ["IF OBJECT_ID('[ad_x]', 'U') IS NULL BEGIN CREATE TABLE [ad_x] ([id] INT NOT NULL) END"],
      ["IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin') INSERT INTO sys_roles ([role_name]) VALUES ('admin')"],
    ],
  },
  {
    id: 'MSSQL-CREATE-VIEW-NO-PRECEDING-DROP',
    dialects: ['mssql'],
    title: 'MSSQL 顶层 CREATE VIEW 缺前置守卫式 DROP VIEW',
    why:
      'MSSQL 的 CREATE VIEW 没有 OR REPLACE ⇒ 重跑报 "There is already an object named \'v_x\' in the database"。' +
      '本项目的写法是前一条 `IF OBJECT_ID(\'[v_x]\', \'V\') IS NOT NULL DROP VIEW [v_x]`。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const m = norm(stmt).match(/^CREATE\s+VIEW\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i);
        if (!m) return;
        const viewName = stripId(m[1]);
        const prev = index > 0 ? norm(statements[index - 1]) : '';
        const dropMatch = prev.match(
          /IF\s+OBJECT_ID\s*\(\s*'?\[?([A-Za-z0-9_$]+)\]?'?\s*,\s*'V'\s*\)\s+IS\s+NOT\s+NULL\s+DROP\s+VIEW\s+\[?([A-Za-z0-9_$]+)\]?/i
        );
        if (dropMatch && stripId(dropMatch[2]) === viewName) return;
        out.push({
          index,
          message:
            `顶层 CREATE VIEW ${viewName} 前面没有守卫式 DROP VIEW` +
            ` (期望: IF OBJECT_ID('[${viewName}]', 'V') IS NOT NULL DROP VIEW [${viewName}])`,
        });
      });
      return out;
    },
    negativeSample: ['CREATE VIEW v_partner_inbound AS SELECT 1 AS a'],
    positiveSamples: [
      [
        "IF OBJECT_ID('[v_partner_inbound]', 'V') IS NOT NULL DROP VIEW [v_partner_inbound]",
        'CREATE VIEW v_partner_inbound AS SELECT 1 AS a',
      ],
    ],
  },
  {
    id: 'MSSQL-TRUNCATE-INSIDE-GUARD',
    dialects: ['mssql'],
    title: 'MSSQL 语句里出现 TRUNCATE TABLE',
    why:
      'TRUNCATE 即使被 IF 包住也不是幂等的: 守卫只保证"对象存在时才执行", ' +
      '而 TRUNCATE 的效果是**每次都清空数据** ⇒ 重跑会清空操作员的数据。',
    detect: ({ statements }) =>
      collect(statements, (stmt) =>
        /\bTRUNCATE\s+TABLE\b/i.test(norm(stmt)) ? '基线里不允许 TRUNCATE TABLE (即使在 IF 守卫内)' : null
      ),
    negativeSample: ["IF OBJECT_ID('[ad_x]', 'U') IS NOT NULL TRUNCATE TABLE [ad_x]"],
    positiveSamples: [["IF OBJECT_ID('[ad_x]', 'U') IS NULL BEGIN CREATE TABLE [ad_x] ([id] INT) END"]],
  },

  // -------------------------------------------------------------------------
  // 守卫链自身的结构完整性 (MySQL)
  // -------------------------------------------------------------------------
  {
    id: 'GUARD-CHAIN-BROKEN',
    dialects: ['mysql'],
    title: 'SET @s 后面没有紧跟 PREPARE/EXECUTE/DEALLOCATE',
    why:
      '守卫链写成一半时, 基线**不会报错**, 只是**静默不执行那条 DDL** ⇒ ' +
      '库里少一列, 而且"跑两遍都成功"这种弱证明完全看不出来。' +
      '这是 apply-twice 测试的盲区, 只能靠静态检查兜住。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        if (!RE_GUARD_SET.test(norm(stmt))) return;
        const next = [
          statements[index + 1] || '',
          statements[index + 2] || '',
          statements[index + 3] || '',
        ].map(norm);
        if (RE_PREPARE.test(next[0]) && RE_EXECUTE.test(next[1]) && RE_DEALLOCATE.test(next[2])) return;
        out.push({
          index,
          message:
            'SET @s 之后必须紧跟 PREPARE stmt FROM @s / EXECUTE stmt / DEALLOCATE PREPARE stmt ' +
            '(缺任何一条 ⇒ 该守卫里的 DDL 永远不会被执行)',
        });
      });
      return out;
    },
    negativeSample: [
      "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_x' AND COLUMN_NAME = 'c1') = 0, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL', 'SELECT 1'))",
    ],
    positiveSamples: [
      guardSample({ table: 'ad_x', column: 'c1', ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL' }),
    ],
  },
  {
    id: 'GUARD-CHAIN-ORPHAN',
    dialects: ['mysql'],
    title: '出现孤立的 PREPARE / EXECUTE / DEALLOCATE',
    why: '没有对应的 SET @s 时, 这条语句要么报语法错, 要么执行上一条语句遗留的 @s (内容不可控)。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        let expectedPrev = null;
        if (RE_PREPARE.test(t)) expectedPrev = RE_GUARD_SET;
        else if (RE_EXECUTE.test(t)) expectedPrev = RE_PREPARE;
        else if (RE_DEALLOCATE.test(t)) expectedPrev = RE_EXECUTE;
        if (!expectedPrev) return;
        const prev = index > 0 ? norm(statements[index - 1]) : '';
        if (expectedPrev.test(prev)) return;
        out.push({ index, message: `顶层 ${headOf(stmt)} 没有配对的上一条语句 (守卫链断裂)` });
      });
      return out;
    },
    negativeSample: ['PREPARE stmt FROM @s'],
    positiveSamples: [
      guardSample({ table: 'ad_x', column: 'c1', ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL' }),
    ],
  },
  {
    id: 'GUARD-NON-CANONICAL-SHAPE',
    dialects: ['mysql'],
    title: '守卫语句不是规范形态',
    why:
      '规范形态 = SET @s = (SELECT IF(<INFORMATION_SCHEMA 探针>, \'<DDL>\', \'SELECT 1\'))。' +
      '偏离这个形态的写法, 例如条件恒真 (IF(1 = 1, ...)) 或比较方向写反 (> / < / <>), ' +
      '会让守卫**永远执行**或**永远跳过** DDL —— 而这两种都不报错。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        if (!RE_GUARD_SET.test(t)) return;
        const problems = [];
        if (!/^SET\s+@s\s*=\s*\(\s*SELECT\s+IF\s*\(/i.test(t)) {
          problems.push('开头不是 SET @s = (SELECT IF(...');
        }
        const guard = dissectGuard(stmt);
        if (!guard) {
          problems.push("不是 'SELECT IF(<探针>, '<DDL>', 'SELECT 1')' 形态 (末尾必须是 no-op 分支)");
        } else {
          if (!/INFORMATION_SCHEMA/i.test(guard.condition)) {
            problems.push('探针没有查 INFORMATION_SCHEMA');
          }
          if (!/\)\s*=\s*[01]\b/.test(guard.condition)) {
            problems.push('条件里没有 "(<计数子查询>) = 0 / = 1" 形式的比较');
          }
          const badOp = guard.condition.match(/(<=|>=|<>|!=|<|>)/);
          if (badOp) {
            problems.push(`条件里出现了关系运算符 "${badOp[0]}" (守卫只允许 = 0 / = 1)`);
          }
          if (!/^(ALTER|CREATE|RENAME|DROP)\b/i.test(norm(guard.ddl))) {
            problems.push(`守卫里的 DDL 不是 DDL: ${norm(guard.ddl).slice(0, 60)}`);
          }
        }
        if (problems.length) {
          out.push({ index, message: `守卫语句形态不规范: ${problems.join('; ')}` });
        }
      });
      return out;
    },
    negativeSample: [
      "SET @s = (SELECT IF(1 = 1, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'EXECUTE stmt',
      'DEALLOCATE PREPARE stmt',
    ],
    positiveSamples: [
      guardSample({ table: 'ad_x', column: 'c1', ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL' }),
    ],
  },
  {
    id: 'GUARD-PROBE-TARGET-MISMATCH',
    dialects: ['mysql'],
    title: '守卫的探针对象与 DDL 目标不一致',
    why:
      '探针查 A 表 / DDL 改 B 表 (或探针查列 c / DDL 加列 d) ⇒ 守卫永远为真或永远为假, ' +
      'DDL 要么每次都执行 (重跑炸), 要么永远不执行 (静默缺列)。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        if (!RE_GUARD_SET.test(t)) return;
        const guard = dissectGuard(stmt);
        if (!guard) return; // 形态问题由 GUARD-NON-CANONICAL-SHAPE 负责
        const tables = probeTables(guard.condition);
        const cols = probeComparisons(guard.condition);
        const target = ddlTargetTable(guard.ddl);
        if (target && tables.size > 0 && !tables.has(target)) {
          out.push({
            index,
            message: `探针查的表是 [${[...tables].join(', ')}], DDL 改的表却是 ${target}`,
          });
          return;
        }
        const ddlCols = ddlColumns(guard.ddl);
        // 成对改名 (CHANGE COLUMN) 的"旧列存在(=1) 且 新列不存在(=0)"语义
        // 由 GUARD-RENAME-PAIR-INCOMPLETE 单独把守 —— 这里只查**列名是否被探针覆盖**,
        // 否则两条规则会互相打架 (改名守卫要求旧列 = 1, 本规则要求 = 0)。
        const isRename = /^ALTER\s+TABLE\s+\S+\s+CHANGE\b/i.test(norm(guard.ddl));
        for (const col of ddlCols) {
          if (cols.size === 0) break;
          if (!cols.has(col)) {
            out.push({ index, message: `DDL 涉及的列 ${col} 没有出现在探针里` });
            return;
          }
          if (!isRename && cols.get(col) !== 0) {
            out.push({
              index,
              message: `DDL 涉及的列 ${col} 在探针里比较的值是 ${cols.get(col)}, 应当是 0 (不存在才执行)`,
            });
            return;
          }
        }
        const idxName = ddlIndexName(guard.ddl);
        if (idxName && cols.size > 0) {
          if (!cols.has(idxName)) {
            out.push({ index, message: `DDL 创建的索引 ${idxName} 没有出现在探针里` });
            return;
          }
          if (cols.get(idxName) !== 0) {
            out.push({
              index,
              message: `DDL 创建的索引 ${idxName} 在探针里比较的值是 ${cols.get(idxName)}, 应当是 0`,
            });
          }
        }
      });
      return out;
    },
    negativeSample: guardSample({
      table: 'ad_y',
      column: 'c1',
      ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL',
    }),
    positiveSamples: [
      guardSample({ table: 'ad_x', column: 'c1', ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL' }),
      guardSample({
        table: 'ad_x',
        index: 'ix_x_c1',
        ddl: 'CREATE INDEX ix_x_c1 ON ad_x (c1)',
      }),
    ],
  },
  {
    id: 'GUARD-PROBE-HARDCODED-SCHEMA',
    dialects: ['mysql'],
    title: '探针硬编码了库名',
    why:
      '探针必须用 TABLE_SCHEMA = DATABASE() —— 基线跑在哪个库就作用于哪个库。' +
      '硬编码库名会让守卫在**别的库名**下永远为真 (每次都执行 ⇒ 重跑炸) 或永远为假 (静默缺列)。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        if (!RE_GUARD_SET.test(t)) return;
        const guard = dissectGuard(stmt);
        if (!guard) return;
        if (/TABLE_SCHEMA\s*=\s*DATABASE\s*\(\s*\)/i.test(guard.condition)) return;
        const hardcoded = guard.condition.match(/TABLE_SCHEMA\s*=\s*'([^']*)'/i);
        if (hardcoded) {
          out.push({
            index,
            message: `探针硬编码了库名 '${hardcoded[1]}' —— 必须用 TABLE_SCHEMA = DATABASE()`,
          });
          return;
        }
        out.push({
          index,
          message: '探针没有用 TABLE_SCHEMA = DATABASE() 限定当前库',
        });
      });
      return out;
    },
    negativeSample: guardSample({
      table: 'ad_x',
      column: 'c1',
      ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL',
      schema: 'addashboard',
    }),
    positiveSamples: [
      guardSample({ table: 'ad_x', column: 'c1', ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL' }),
    ],
  },
  {
    id: 'GUARD-DDL-MULTI-STATEMENT',
    dialects: ['mysql'],
    title: '守卫里的 DDL 字符串含多条语句',
    why:
      'PREPARE 只能编译**一条**语句 ⇒ 字符串里带分号时执行会报语法错, ' +
      '而这条错误发生在 EXECUTE 上, 排查成本极高。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        if (!RE_GUARD_SET.test(t)) return;
        const guard = dissectGuard(stmt);
        if (!guard) return;
        if (!guard.ddl.includes(';')) return;
        out.push({ index, message: `守卫里的 DDL 含分号 (PREPARE 只能编译单条语句): ${guard.ddl.slice(0, 80)}` });
      });
      return out;
    },
    negativeSample: guardSample({
      table: 'ad_x',
      column: 'c1',
      ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL; DROP TABLE ad_y',
    }),
    positiveSamples: [
      guardSample({ table: 'ad_x', column: 'c1', ddl: 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL' }),
    ],
  },
  {
    id: 'GUARD-RENAME-PAIR-INCOMPLETE',
    dialects: ['mysql'],
    title: '成对改名 (CHANGE COLUMN) 的守卫条件不完整',
    why:
      '基线里有一条成对改名 target_user_description → target_user_display_name。' +
      '它的守卫必须**同时**满足两个条件: 旧列存在 (= 1) **且** 新列不存在 (= 0)。' +
      '只探一个的后果: 只探旧列 ⇒ 新列永远建不出来; 只探新列 ⇒ 旧列被永久留下, ' +
      '库里同时留着两个列 —— 而且**两种情况都不报错**。',
    detect: ({ statements }) => {
      const out = [];
      statements.forEach((stmt, index) => {
        const t = norm(stmt);
        if (!RE_GUARD_SET.test(t)) return;
        const guard = dissectGuard(stmt);
        if (!guard) return;
        const m = norm(guard.ddl).match(
          /^ALTER\s+TABLE\s+\S+\s+CHANGE\s+(?:COLUMN\s+)?([`[]?[A-Za-z0-9_$]+[`\]]?)\s+([`[]?[A-Za-z0-9_$]+[`\]]?)/i
        );
        if (!m) return;
        const oldName = stripId(m[1]);
        const newName = stripId(m[2]);
        const cols = probeComparisons(guard.condition);
        const oldValue = cols.get(oldName);
        const newValue = cols.get(newName);
        if (oldValue === undefined) {
          out.push({ index, message: `成对改名的旧列 ${oldName} 没有出现在探针里` });
          return;
        }
        if (newValue === undefined) {
          out.push({ index, message: `成对改名的新列 ${newName} 没有出现在探针里` });
          return;
        }
        if (oldValue !== 1) {
          out.push({ index, message: `成对改名的旧列 ${oldName} 探针值是 ${oldValue}, 应当是 1 (存在)` });
          return;
        }
        if (newValue !== 0) {
          out.push({ index, message: `成对改名的新列 ${newName} 探针值是 ${newValue}, 应当是 0 (不存在)` });
        }
      });
      return out;
    },
    negativeSample: guardSample({
      table: 'ad_lockout_events',
      column: 'target_user_description',
      ddl:
        'ALTER TABLE ad_lockout_events CHANGE COLUMN target_user_description target_user_display_name VARCHAR(512) NULL',
      value: 1,
    }),
    positiveSamples: [
      [
        "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_description') = 1 AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_display_name') = 0, 'ALTER TABLE ad_lockout_events CHANGE COLUMN target_user_description target_user_display_name VARCHAR(512) NULL', 'SELECT 1'))",
        'PREPARE stmt FROM @s',
        'EXECUTE stmt',
        'DEALLOCATE PREPARE stmt',
      ],
    ],
  },
];

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

export function dialectOf(filePath) {
  return filePath.split(/[\\/]/).includes('mssql') ? 'mssql' : 'mysql';
}

/**
 * 对一串顶层语句跑全部适用规则。
 * @returns {Array<{ruleId:string, index:number, statement:string, message:string}>}
 */
export function checkStatements(dialect, statements) {
  const problems = [];
  for (const rule of RULES) {
    if (!rule.dialects.includes(dialect)) continue;
    for (const hit of rule.detect({ dialect, statements })) {
      problems.push({
        ruleId: rule.id,
        index: hit.index,
        statement: String(statements[hit.index]).replace(/\s+/g, ' ').trim().slice(0, 200),
        message: hit.message,
      });
    }
  }
  return problems;
}

/**
 * 核心检查: 返回该文件的问题列表。
 */
export function checkFile(filePath, sql) {
  const dialect = dialectOf(filePath);
  const statements = splitSqlStatements(sql);
  const relPath = relative(repoRoot, filePath).split(sep).join('/');
  const problems = [];

  // ★ 自检: 本检查器用的就是生产 splitSqlStatements, 这里的断言是"仪器体检" ——
  //   万一将来有人把这里的切分换成自己写的实现, 这条会立刻响。
  if (!Array.isArray(statements) || statements.length === 0) {
    problems.push({
      severity: 'error',
      file: relPath,
      ruleId: 'SPLIT-SEQUENCE-EMPTY',
      message: '生产 splitSqlStatements 没切出任何语句 ⇒ 检查器没有可检查的对象',
    });
    return { file: relPath, dialect, statementCount: 0, guardCount: 0, problems };
  }

  for (const hit of checkStatements(dialect, statements)) {
    const rule = RULES.find((r) => r.id === hit.ruleId);
    problems.push({
      severity: 'error',
      file: relPath,
      ruleId: hit.ruleId,
      statementIndex: hit.index + 1,
      statement: hit.statement,
      message: `${rule ? rule.title : hit.ruleId} —— ${hit.message}`,
    });
  }

  const guardCount = statements.filter((s) => RE_GUARD_SET.test(norm(s))).length;
  return { file: relPath, dialect, statementCount: statements.length, guardCount, problems };
}

// ---------------------------------------------------------------------------
// 自检 —— 规则表里的每一条都必须**能被触发**, 否则它就是一台永远说 OK 的假仪器
// ---------------------------------------------------------------------------

export function selfTest() {
  const failures = [];

  for (const rule of RULES) {
    const dialect = rule.dialects[0];

    // 负样本必须触发
    const negHits = rule.detect({ dialect, statements: rule.negativeSample });
    if (!negHits || negHits.length === 0) {
      failures.push({
        ruleId: rule.id,
        kind: 'negative-sample-did-not-trigger',
        detail:
          '规则表的负样本没有触发本规则 ⇒ 这条规则永远不会报警 (假仪器)。' +
          `负样本: ${JSON.stringify(rule.negativeSample)}`,
      });
    }

    // 正样本必须不触发 (防止规则过宽)
    for (const sample of rule.positiveSamples || []) {
      const posHits = rule.detect({ dialect, statements: sample });
      if (posHits && posHits.length > 0) {
        failures.push({
          ruleId: rule.id,
          kind: 'positive-sample-triggered',
          detail:
            '规则表的正样本触发了本规则 ⇒ 规则过宽, 会误报。' +
            `正样本: ${JSON.stringify(sample)} → ${JSON.stringify(posHits)}`,
        });
      }
    }
  }

  return { ok: failures.length === 0, checkedRules: RULES.length, failures };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isCli = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const fileArgs = args.filter((a) => !a.startsWith('--'));
  const files = (fileArgs.length ? fileArgs : DIALECT_FILES).map((f) => resolve(repoRoot, f));

  const results = [];
  let errorCount = 0;
  let warnCount = 0;

  const self = selfTest();
  if (!self.ok) {
    errorCount += self.failures.length;
    for (const f of self.failures) {
      console.error(`[SELF-TEST FAIL] ${f.ruleId} (${f.kind})`);
      console.error(`    ${f.detail}`);
    }
  }

  for (const file of files) {
    if (!existsSync(file)) {
      console.log(`SKIP  ${relative(repoRoot, file).split(sep).join('/')}: 文件不存在`);
      continue;
    }
    const sql = readFileSync(file, 'utf8');
    const result = checkFile(file, sql);
    results.push(result);
    errorCount += result.problems.filter((p) => p.severity === 'error').length;
    warnCount += result.problems.filter((p) => p.severity === 'warning').length;
  }

  if (asJson) {
    console.log(JSON.stringify({ errorCount, warnCount, selfTest: self, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`=== ${r.file} (${r.dialect}) ===`);
      console.log(`  statements: ${r.statementCount}  guards: ${r.guardCount}  problems: ${r.problems.length}`);
      for (const p of r.problems) {
        console.log(`  [${p.severity.toUpperCase()}] ${p.ruleId} @ stmt #${p.statementIndex}`);
        console.log(`      ${p.message}`);
        console.log(`      > ${p.statement}`);
      }
    }
    console.log('');
    console.log(
      errorCount === 0
        ? `OK: 基线幂等性全部通过 (规则 ${self.checkedRules} 条自检通过, warning ${warnCount})`
        : `FAILED: ${errorCount} 个错误, ${warnCount} 个警告`
    );
  }

  process.exit(errorCount > 0 ? 1 : 0);
}
