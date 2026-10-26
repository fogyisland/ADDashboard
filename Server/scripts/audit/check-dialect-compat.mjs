#!/usr/bin/env node
/**
 * R161.3 — 跨方言误用守卫 (MySQL ⇄ MSSQL)
 *
 * 背景 (2026-10-25)
 * ------------------
 * 全新库初始化只会执行**一份**方言基线:
 *   Server/db/migrations/<dialect>/1.0.0-baseline.sql
 * (schema-applier.js 的 resolveSqlPath 只认方言目录, R161.2 起不再回退到
 *  顶层那份 MySQL 旧快照)。
 *
 * 这意味着: 一份基线里混进了**另一方言的语法**, 后果不是"报错", 而是
 * **在装机的那个方言上当场炸**, 或者更糟 —— 在 MySQL 上装出一棵缺表的库
 * (语句被解析成别的意思 / 被静默跳过), 故障现场落在完全不相干的地方。
 *
 * 双方言基线**必须**各自只含自己方言的语法。本守卫就是这条契约的体检仪。
 *
 * 为什么要"跨方言"而不是"语法对不对"
 * ------------------------------------
 * 语法对不对由真库验证 (R161.3: MSSQL 412/412, MySQL 250/250) 兜底, 但真库
 * 验证**只在改动的那一刻**跑一次, 之后没人记得再跑。本守卫是**可重复执行**
 * 的静态契约: 任何人往基线里粘一行从另一方言抄来的 DDL, 立刻被挡住。
 *
 * 检查什么
 * --------
 *   1) 词法层: 目标方言的基线里出现**对方方言独有的关键字** ⇒ 报错。
 *      注释与字符串字面量先剥掉 —— 否则基线注释里为了对照而写的
 *      "MSSQL 用 NVARCHAR(1024)" 会把守卫变成永远误报的哑巴。
 *   2) 结构层 (MSSQL):
 *      a) CREATE VIEW 必须是它那条语句的开头 —— 否则 Msg 156
 *         "CREATE VIEW must be the first statement in a query batch"。
 *         生产是逐条 db.execute (每条 = 一个批次), 所以判据是
 *         "这条语句是不是以 CREATE VIEW 开头", 不是"它在一个 GO 段里的位置"。
 *      b) SET IDENTITY_INSERT ON / OFF 必须成对, 且必须与那条 INSERT 在
 *         **同一条语句**里 —— 它是会话级开关, 而连接池有 25 条连接
 *         (drivers/mssql.js 的 pool.max=25); 一旦被拆成多条语句,
 *         INSERT 很可能落到另一条连接上 ⇒ Msg 544。
 *      c) IDENTITY 列的显式 INSERT 必须落在 SET ... ON 之后。
 *   3) 结构层 (MySQL):
 *      a) 每张表都要 ENGINE=InnoDB —— 否则默认引擎 (可能是 MyISAM) 没有
 *         事务、没有外键, 而基线里的 FK 一条都不会报错, 只是被忽略。
 *      b) 每张表都要 CREATE TABLE IF NOT EXISTS —— 基线要能重复执行
 *         (bootstrapMigrations 会对已初始化的库重跑基线)。
 *
 * 已知例外 (allowlist)
 * ---------------------
 * 每条例外**必须**带 reason。���原因的例外条目 = 让守卫慢慢腐烂的入口,
 * 所以本守卫在没有例外时也要能跑 (allowlist 默认为空数组)。
 *
 * 用法:
 *   node Server/scripts/audit/check-dialect-compat.mjs [file ...] [--json]
 *   退出码: 0 = 通过; 1 = 有 error; 2 = 用法/解析错误
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 生产切分器 —— 与初始化向导用的是同一份代码 (语句边界必须一致)
import { splitSqlStatements } from '../../center/src/init/schema-applier.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// 词法工具
// ---------------------------------------------------------------------------

/**
 * 剥掉 SQL 注释 (-- 行注释 / 块注释)。字符串字面量内的不算。
 * 与 check-index-key-length.mjs 的同名函数同义, 但这里单独实现, 避免两个
 * 审计脚本互相 import 造成的耦合 (任一个被删都会连带另一个)。
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'") {
      out += ch; i += 1;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/**
 * 把字符串字面量替换成空串 (保留引号与长度, 便于按位置对齐)。
 * 种子数据里出现 'Engine=InnoDB' 这种值是合法的, 不该触发关键字规则。
 */
export function blankSqlLiterals(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch; i += 1;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += "' '"; i += 2; continue; }
          out += "'"; i += 1; break;
        }
        out += ' ';
        i += 1;
      }
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/** 剥注释 + 填空白字面量 —— 词法规则的输入 */
export function normalizeForLexing(sql) {
  return blankSqlLiterals(stripSqlComments(sql));
}

// ---------------------------------------------------------------------------
// 词法规则
// ---------------------------------------------------------------------------

/**
 * 规则表。
 *   appliesTo —— 出现在**这个方言**的基线里就算错
 *   pattern   —— 匹配即报错
 *   why       —— 报错文案 (要能直接告诉操作员"改成什么")
 */
export const LEXICAL_RULES = [
  // ---------------- MySQL 独有 ⇒ 不许出现在 MSSQL 基线 ----------------
  { code: 'MSSQL-HAS-MYSQL-ENGINE', appliesTo: 'mssql', pattern: /\bENGINE\s*=\s*InnoDB\b/i,
    why: 'ENGINE=InnoDB 是 MySQL 语法。SQL Server 用 ENGINE-less 的 CREATE TABLE, 存储引擎由服务器实例决定。' },
  { code: 'MSSQL-HAS-MYSQL-AUTOINCREMENT', appliesTo: 'mssql', pattern: /\bAUTO_INCREMENT\b/i,
    why: 'AUTO_INCREMENT 是 MySQL 语法。SQL Server 用 IDENTITY(1,1)。' },
  { code: 'MSSQL-HAS-MYSQL-BACKTICK', appliesTo: 'mssql', pattern: /`/,
    why: '反引号是 MySQL 的标识符引用符。SQL Server 用方括号 (或双引号, 需开 QUOTED_IDENTIFIER)。' },
  { code: 'MSSQL-HAS-MYSQL-GENERATED-COLUMN', appliesTo: 'mssql', pattern: /\bGENERATED\s+ALWAYS\s+AS\b/i,
    why: 'GENERATED ALWAYS AS ... STORED 是 MySQL 的生成列语法。SQL Server 用 AS <expr> PERSISTED。' },
  { code: 'MSSQL-HAS-MYSQL-ON-UPDATE', appliesTo: 'mssql', pattern: /\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i,
    why: 'ON UPDATE CURRENT_TIMESTAMP 是 MySQL 语法。SQL Server 没有等价子句, 需要触发器。' },
  { code: 'MSSQL-HAS-MYSQL-ON-DUPLICATE', appliesTo: 'mssql', pattern: /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i,
    why: 'ON DUPLICATE KEY UPDATE 是 MySQL 语法。SQL Server 用 MERGE。' },
  { code: 'MSSQL-HAS-MYSQL-CT-IF-NOT-EXISTS', appliesTo: 'mssql', pattern: /\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i,
    why: 'CREATE TABLE IF NOT EXISTS 是 MySQL 语法。SQL Server 用 IF OBJECT_ID(<表>, \'U\') IS NULL BEGIN ... END。' },
  { code: 'MSSQL-HAS-MYSQL-ADD-COLUMN', appliesTo: 'mssql', pattern: /\bADD\s+COLUMN\b/i,
    why: 'ADD COLUMN 是 MySQL 写法。SQL Server 的 ALTER TABLE ADD 直接写列名 (ADD <col> <type>)。' },
  { code: 'MSSQL-HAS-MYSQL-CHANGE', appliesTo: 'mssql', pattern: /\bALTER\s+TABLE\b[^;]*?\bCHANGE\b/i,
    why: 'ALTER TABLE ... CHANGE 是 MySQL 的改列语法。SQL Server 用 ALTER COLUMN。' },
  { code: 'MSSQL-HAS-MYSQL-LIMIT', appliesTo: 'mssql', pattern: /\bLIMIT\s+\d/i,
    why: 'LIMIT 是 MySQL 的分页语法。SQL Server 用 TOP n 或 OFFSET n ROWS FETCH NEXT m ROWS ONLY。' },
  { code: 'MSSQL-HAS-MYSQL-CURRENT-TIMESTAMP-FRAC', appliesTo: 'mssql', pattern: /\bCURRENT_TIMESTAMP\s*\(\s*\d/i,
    why: 'CURRENT_TIMESTAMP(3) 是 MySQL 的小数秒写法。SQL Server 的 CURRENT_TIMESTAMP 不接受参数, 要小数秒请用 DATETIME2。' },
  { code: 'MSSQL-HAS-MYSQL-GROUP-CONCAT', appliesTo: 'mssql', pattern: /\bGROUP_CONCAT\s*\(/i,
    why: 'GROUP_CONCAT 是 MySQL 函数。SQL Server 用 STRING_AGG。' },
  { code: 'MSSQL-HAS-MYSQL-IFNULL', appliesTo: 'mssql', pattern: /\bIFNULL\s*\(/i,
    why: 'IFNULL() 是 MySQL 函数。SQL Server 用 ISNULL()。' },
  { code: 'MSSQL-HAS-MYSQL-RENAME-COLUMN', appliesTo: 'mssql', pattern: /\bRENAME\s+COLUMN\b/i,
    why: 'RENAME COLUMN 是 MySQL 8.0 语法 (本项目目标库是 MySQL 5.7, 也不支持)。SQL Server 用 sp_rename。' },
  { code: 'MSSQL-HAS-MYSQL-DELIMITER', appliesTo: 'mssql', pattern: /^\s*DELIMITER\s+\S+/im,
    why: 'DELIMITER 是 MySQL 客户端指令, 不是 SQL。SQL Server 用 GO 分批。' },
  { code: 'MSSQL-HAS-MYSQL-UNIQUE-KEY', appliesTo: 'mssql', pattern: /\bUNIQUE\s+KEY\s+[`[]?[A-Za-z_]\w*/i,
    why: 'UNIQUE KEY <名> (...) 是 MySQL 表内唯一键写法。SQL Server 用 CONSTRAINT <名> UNIQUE (...) 或独立的 CREATE UNIQUE INDEX。' },
  { code: 'MSSQL-HAS-MYSQL-LATERAL', appliesTo: 'mssql', pattern: /\bLATERAL\b/i,
    why: 'LATERAL 是 MySQL 8.0.14+ 的写法。SQL Server 用 CROSS APPLY / OUTER APPLY。' },
  { code: 'MSSQL-HAS-MYSQL-SHOW', appliesTo: 'mssql', pattern: /^\s*(SHOW|DESCRIBE|EXPLAIN)\s+/im,
    why: 'SHOW / DESCRIBE / EXPLAIN 是 MySQL 客户端指令, 不是 SQL 语句。' },

  // ---------------- MSSQL 独有 ⇒ 不许出现在 MySQL 基线 ----------------
  { code: 'MYSQL-HAS-MSSQL-NVARCHAR', appliesTo: 'mysql', pattern: /\bN(?:VAR)?CHAR\s*\(\s*\d+\s*\)/i,
    why: 'NVARCHAR/NCHAR 是 SQL Server 的 Unicode 类型。MySQL 用 VARCHAR + utf8mb4 字符集。' },
  { code: 'MYSQL-HAS-MSSQL-DATETIME2', appliesTo: 'mysql', pattern: /\bDATETIME2\b/i,
    why: 'DATETIME2 是 SQL Server 类型。MySQL 用 DATETIME(3) / TIMESTAMP(3)。' },
  { code: 'MYSQL-HAS-MSSQL-IDENTITY', appliesTo: 'mysql', pattern: /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i,
    why: 'IDENTITY(1,1) 是 SQL Server 的自增列语法。MySQL 用 AUTO_INCREMENT。' },
  { code: 'MYSQL-HAS-MSSQL-IDENTITY-INSERT', appliesTo: 'mysql', pattern: /\bIDENTITY_INSERT\b/i,
    why: 'SET IDENTITY_INSERT 是 SQL Server 专有语句。MySQL 允许显式给自增列的值, 不需要这个开关。' },
  { code: 'MYSQL-HAS-MSSQL-PERSISTED', appliesTo: 'mysql', pattern: /\bPERSISTED\b/i,
    why: 'PERSISTED 是 SQL Server 计算列的关键字。MySQL 用 GENERATED ALWAYS AS (...) STORED。' },
  { code: 'MYSQL-HAS-MSSQL-DATE-FUNC', appliesTo: 'mysql', pattern: /\b(?:SYSUTCDATETIME|GETDATE|GETUTCDATE|NEWID)\s*\(/i,
    why: '这是 SQL Server 的时间/UUID 函数。MySQL 用 UTC_TIMESTAMP() / NOW() / UUID()。' },
  { code: 'MYSQL-HAS-MSSQL-IF-OBJECT-ID', appliesTo: 'mysql', pattern: /\bIF\s+OBJECT_ID\s*\(/i,
    why: 'IF OBJECT_ID(...) IS NULL 是 SQL Server 的存在性守卫。MySQL 用 CREATE TABLE IF NOT EXISTS。' },
  { code: 'MYSQL-HAS-MSSQL-APPLY', appliesTo: 'mysql', pattern: /\b(?:CROSS|OUTER)\s+APPLY\b/i,
    why: 'CROSS APPLY / OUTER APPLY 是 SQL Server 写法。MySQL 8.0.14+ 用 LATERAL, MySQL 5.7 只能靠派生表。' },
  { code: 'MYSQL-HAS-MSSQL-FROM-STATISTICS', appliesTo: 'mysql', pattern: /\bFROM\s+STATISTICS\b/i,
    why: 'FROM STATISTICS 是 SQL Server 2022 的系统视图。' },
  { code: 'MYSQL-HAS-MSSQL-TOP', appliesTo: 'mysql', pattern: /\bSELECT\s+(?:DISTINCT\s+)?TOP\s+\(?\s*\d/i,
    why: 'SELECT TOP n 是 SQL Server 写法。MySQL 用 LIMIT n。' },
  { code: 'MYSQL-HAS-MSSQL-OFFSET-FETCH', appliesTo: 'mysql', pattern: /\bOFFSET\s+\d+\s+ROWS\b/i,
    why: 'OFFSET n ROWS FETCH NEXT 是 SQL Server 的分页写法。MySQL 用 LIMIT <offset>, <count>。' },
  { code: 'MYSQL-HAS-MSSQL-STRING-AGG', appliesTo: 'mysql', pattern: /\bSTRING_AGG\s*\(/i,
    why: 'STRING_AGG 是 SQL Server 2017+ 函数。MySQL 用 GROUP_CONCAT。' },
  { code: 'MYSQL-HAS-MSSQL-IIF', appliesTo: 'mysql', pattern: /\bIIF\s*\(/i,
    why: 'IIF() 是 SQL Server 2012+ 函数。MySQL 用 IFNULL() / CASE。' },
  { code: 'MYSQL-HAS-MSSQL-MERGE', appliesTo: 'mysql', pattern: /\bMERGE\s+INTO\b/i,
    why: 'MERGE INTO 是 SQL Server 语法, MySQL 没有。MySQL 用 INSERT ... ON DUPLICATE KEY UPDATE。' },
  { code: 'MYSQL-HAS-MSSQL-THROW', appliesTo: 'mysql', pattern: /\b(?:RAISERROR|THROW)\s+/i,
    why: 'RAISERROR / THROW 是 SQL Server 的错误抛出语法。' },
  { code: 'MYSQL-HAS-MSSQL-BEGIN-TRY', appliesTo: 'mysql', pattern: /\bBEGIN\s+TRY\b/i,
    why: 'BEGIN TRY / END TRY 是 SQL Server 的错误处理块。MySQL 用 DECLARE ... HANDLER。' },
  { code: 'MYSQL-HAS-MSSQL-SUSER', appliesTo: 'mysql', pattern: /\b(?:SUSER_SNAME|SCHEMA_NAME|CURRENT_USER)\s*\(/i,
    why: '这是 SQL Server 的上下文函数。MySQL 用 USER() / CURRENT_USER() / DATABASE()。' },

  // ---------------- 双方言都不该出现的 ----------------
  { code: 'BOTH-HAS-SP-RENAME', appliesTo: 'both', pattern: /\bsp_rename\b/i,
    why: 'sp_rename 是 SQL Server 的存储过程, MySQL 侧不存在 —— 出现在任一方言的基线里都说明是从别处抄错了。' },
];

/**
 * 合法例外。每条**必须**带 reason —— 没有原因的例外就是让守卫腐烂的入口。
 * 形如 { code, dialect, pattern, reason } —— pattern 命中且命中处不含 reason
 * 标记时才放行 (用 marker 字符串精确豁免某一行)。
 */
export const ALLOWLIST = [
  // 目前没有例外。两个方言基线剥掉注释后各自纯净 (R161.3 实测)。
];

// ---------------------------------------------------------------------------
// 结构规则
// ---------------------------------------------------------------------------

const VIEW_CREATE_RE = /\bCREATE\s+(?:OR\s+ALTER\s+)?VIEW\b/i;
const VIEW_CREATE_AT_START_RE = /^\s*(?:CREATE\s+(?:OR\s+ALTER\s+)?VIEW)\b/i;
const IDENTITY_INSERT_ON_RE = /\bSET\s+IDENTITY_INSERT\s+(?:\[[^\]]+\]|[\w.]+)\s+ON\b/gi;
const IDENTITY_INSERT_OFF_RE = /\bSET\s+IDENTITY_INSERT\s+(?:\[[^\]]+\]|[\w.]+)\s+OFF\b/gi;
const CREATE_TABLE_RE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`[]?\w+[`\]]?)/gi;

/**
 * MSSQL 结构规则。
 * @param {string[]} statements 生产切分器产出的语句序列
 */
export function checkMssqlStructure(statements) {
  const problems = [];

  statements.forEach((stmt, index) => {
    // --- CREATE VIEW 必须是这条语句的开头 ---
    if (VIEW_CREATE_RE.test(stmt) && !VIEW_CREATE_AT_START_RE.test(stmt)) {
      problems.push({
        code: 'MSSQL-CREATE-VIEW-NOT-FIRST',
        severity: 'error',
        detail:
          `第 ${index + 1} 条语句包含 CREATE VIEW, 但它不是这条语句的第一条语句` +
          ` ⇒ SQL Server Msg 156 "CREATE VIEW must be the first statement in a query batch"。` +
          `生产是逐条 db.execute (每条 = 一个批次), 所以必须把 CREATE VIEW 单独成一条语句` +
          ` (先 DROP VIEW, 再单独 CREATE VIEW)。`,
        excerpt: stmt.replace(/\s+/g, ' ').slice(0, 120),
      });
    }

    // --- SET IDENTITY_INSERT 必须成对, 且与 INSERT 同语句 ---
    const onCount = (stmt.match(IDENTITY_INSERT_ON_RE) || []).length;
    const offCount = (stmt.match(IDENTITY_INSERT_OFF_RE) || []).length;
    if (onCount !== offCount) {
      problems.push({
        code: 'MSSQL-IDENTITY-INSERT-UNPAIRED',
        severity: 'error',
        detail:
          `第 ${index + 1} 条语句里 SET IDENTITY_INSERT ON 出现 ${onCount} 次、OFF 出现 ${offCount} 次` +
          ` ⇒ 未配对。它是**会话级**开关, 配对必须在**同一条语句**里` +
          ` (一条 db.execute = 一条连接 = 一个会话)。`,
        excerpt: stmt.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
    if (onCount > 0 && !/\bINSERT\b/i.test(stmt)) {
      problems.push({
        code: 'MSSQL-IDENTITY-INSERT-WITHOUT-INSERT',
        severity: 'error',
        detail:
          `第 ${index + 1} 条语句开了 SET IDENTITY_INSERT ON, 但同一条语句里没有 INSERT` +
          ` ⇒ ON/OFF 被拆到了不同语句 (甚至不同连接), 开关会泄漏到后续语句。`,
        excerpt: stmt.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  });

  return problems;
}

/**
 * MySQL 结构规则。
 */
export function checkMysqlStructure(statements) {
  const problems = [];

  statements.forEach((stmt, index) => {
    CREATE_TABLE_RE.lastIndex = 0;
    let m;
    while ((m = CREATE_TABLE_RE.exec(stmt)) !== null) {
      const table = (m[1] || '').replace(/[`[]/g, '').trim();
      if (!table) continue;
      if (!/\bIF\s+NOT\s+EXISTS\b/i.test(stmt.slice(0, m.index + m[0].length))) {
        problems.push({
          code: 'MYSQL-CREATE-TABLE-NOT-IDEMPOTENT',
          severity: 'error',
          detail:
            `第 ${index + 1} 条语句的 CREATE TABLE ${table} 没有 IF NOT EXISTS` +
            ` ⇒ 基线不能重复执行 (bootstrapMigrations 会对已初始化的库重跑基线)。`,
          excerpt: stmt.replace(/\s+/g, ' ').slice(0, 120),
        });
      }
      if (!/\bENGINE\s*=\s*InnoDB\b/i.test(stmt)) {
        problems.push({
          code: 'MYSQL-TABLE-NOT-INNODB',
          severity: 'error',
          detail:
            `第 ${index + 1} 条语句的 CREATE TABLE ${table} 没有显式 ENGINE=InnoDB` +
            ` ⇒ 默认引擎 (可能是 MyISAM) 没有事务也没有外键, 基线里的 FK 会被**静默忽略**。`,
          excerpt: stmt.replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// 主检查
// ---------------------------------------------------------------------------

/** 判定某个文件是什么方言 —— 路径里带 /mssql/ 就是 MSSQL。 */
export function dialectOf(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/mssql/')) return 'mssql';
  if (normalized.includes('/mysql/')) return 'mysql';
  return null;
}

/**
 * 检查一份基线文件。
 * @param {string} filePath 用于判定方言与报错定位
 * @param {string} sql     文件内容
 */
export function checkBaseline(filePath, sql) {
  const dialect = dialectOf(filePath);
  const problems = [];
  const statements = splitSqlStatements(sql);
  const lexed = normalizeForLexing(sql);

  if (!dialect) {
    return {
      file: filePath,
      dialect: null,
      statementCount: statements.length,
      problems: [{
        code: 'DIALECT-UNKNOWN',
        severity: 'error',
        detail:
          '无法从路径判定方言 (路径里既没有 /mysql/ 也没有 /mssql/) —— ' +
          '跨方言检查的前提就是知道这份基线给谁用。',
        excerpt: '',
      }],
    };
  }

  // --- 词法规则 ---
  for (const rule of LEXICAL_RULES) {
    if (rule.appliesTo !== 'both' && rule.appliesTo !== dialect) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let m;
    while ((m = re.exec(lexed)) !== null) {
      const allowed = ALLOWLIST.find(
        (a) => a.code === rule.code && (a.dialect === dialect || a.dialect === 'both'),
      );
      if (allowed && allowed.marker && lexed.slice(m.index, m.index + allowed.marker.length) === allowed.marker) {
        continue;
      }
      const line = lexed.slice(0, m.index).split('\n').length;
      problems.push({
        code: rule.code,
        severity: 'error',
        detail: `${rule.why} (第 ${line} 行)`,
        excerpt: lexed.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ').trim(),
      });
      break; // 同一个规则只报一次, 免得刷屏
    }
  }

  // --- 结构规则 ---
  if (dialect === 'mssql') {
    problems.push(...checkMssqlStructure(statements));
  } else {
    problems.push(...checkMysqlStructure(statements));
  }

  return {
    file: filePath,
    dialect,
    statementCount: statements.length,
    problems,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_FILES = [
  'Server/db/migrations/mysql/1.0.0-baseline.sql',
  'Server/db/migrations/mssql/1.0.0-baseline.sql',
  'LinuxServer/db/migrations/mysql/1.0.0-baseline.sql',
  'LinuxServer/db/migrations/mssql/1.0.0-baseline.sql',
];

function main(argv) {
  const json = argv.includes('--json');
  const fileArgs = argv.filter((a) => !a.startsWith('--'));
  const files = (fileArgs.length ? fileArgs : DEFAULT_FILES).map((f) => resolve(REPO_ROOT, '..', f));

  const results = [];
  let errorCount = 0;

  for (const file of files) {
    if (!existsSync(file)) {
      process.stderr.write(`[FAIL] 文件不存在: ${relative(REPO_ROOT, file)}\n`);
      return 2;
    }
    const relPath = relative(resolve(REPO_ROOT, '..'), file).split(sep).join('/');
    const sql = readFileSync(file, 'utf8');
    const result = checkBaseline(relPath, sql);
    results.push(result);
    errorCount += result.problems.filter((p) => p.severity === 'error').length;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ errorCount, results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      console.log(`=== ${r.file} (${r.dialect}) ===`);
      console.log(`  statements: ${r.statementCount}  problems: ${r.problems.length}`);
      for (const p of r.problems) {
        console.log(`  [${p.severity.toUpperCase()}] ${p.code}`);
        console.log(`      ${p.detail}`);
        if (p.excerpt) console.log(`      > ${p.excerpt}`);
      }
    }
    console.log('');
    console.log(errorCount === 0
      ? 'OK: 双方言基线各自只含本方言语法'
      : `FAILED: ${errorCount} 个跨方言误用`);
  }

  return errorCount > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
