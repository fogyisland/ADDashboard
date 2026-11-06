#!/usr/bin/env node
/**
 * R161.3 + R161.19 — 索引键长度守卫 (InnoDB 3072B / SQL Server 900B·1700B)
 *
 * 背景 (2026-10-25, R161.3): 全新 MySQL 初始化向导报
 *   "Specified key was too long; max key length is 3072 bytes"
 * ⇒ 基线里有索引键超过 InnoDB 上限的 DDL。
 *
 * 为什么要守卫而不是"跑一次就够":
 *   - 顺序类缺陷 (FK) 和长度类缺陷 (索引键) 都**只在全新库暴露** ——
 *     老库的 bootstrapMigrations 见到 schema_migrations 就短路。
 *   - 同一个坑还会换张表复发 (R161.2 是 ad_dc_overview, R161.3 是 5+ 张表)。
 *
 * ★★ R161.19 (2026-10-28) 两个扩展:
 *   (1) **编号迁移纳入扫描**。守卫以前只看 1.0.0-baseline.sql, 而
 *       1.0.3 ~ 1.0.9 里另有 128 条索引 DDL (MSSQL 127 + MySQL 1) 从来没被检查过。
 *       编号迁移**不含 CREATE TABLE** ⇒ 列宽要从基线借 (context 表),
 *       且基线里的列增补 (ALTER TABLE ADD) 也要并进 context 才能解析后续索引。
 *   (2) **MSSQL 键长模型按实测纠正** (旧模型把聚集键算进非聚集索引键 ⇒ 误报)。
 *
 * ★★ MSSQL 实测口径 (SQL Server 2025 RTM, MSSQL$SQLEXPRESS, 本机 6 轮探针实测):
 *   - DDL 阶段: 聚集键 > 900 / 非聚集键 > 1700 **只警告不报错** (Msg 1945, severity 10),
 *     索引照样建出来 ⇒ 不能按"DDL 会失败"报 error。
 *   - 写入阶段: 实际键字节超限 ⇒ **Msg 1946 硬失败**。
 *     实测边界: 900 字节通过 / 902 字节失败; 1700 通过 / 1702 失败。
 *   - **聚集键不会被追加进非聚集索引的键** (唯一索引也不会):
 *     实测 唯一 NCI 声明键 1200B + 聚集键 800B ⇒ 建得起来、写得进去,
 *     且 sys.index_columns 显示该 NCI **只含自己的键列**。
 *     ⇒ 1700 上限只按索引**自己声明的键列**算 (旧版本按"聚集键 + 索引键"合计 ⇒ 误报)。
 *   - 8060 字节的"索引行上限"在实测 (键 1600B + INCLUDE 8000B = 9600B) **没有触发**
 *     ⇒ 不在本守卫的模型里 (只在键长超限时顺带说明, 不单独判定)。
 *   ⇒ 严重级: MySQL 超 3072 = **error** (DDL 直接失败, ER 1071);
 *     MSSQL 超 900/1700 = **warn** (DDL 通过, 但写入会失败)。
 *
 * 关键设计: **复用生产代码的 splitSqlStatements** (Server/center/src/init/schema-applier.js)
 *   - 检查的就是真正会执行的那批语句, 注释吞语句类缺陷天然覆盖;
 *   - DDL 解析前先剥掉 -- / /* *\/ 注释 —— 行内注释会把下一行粘连
 *     (ad_ous_snapshot 的 "forest_id BIGINT NULL,   -- R158.38" 后面紧跟
 *      "PRIMARY KEY (...)" ⇒ 不剥注释的话这条主键会整条漏检)。
 *
 * 字节预算:
 *   MySQL  : utf8mb4 ⇒ 每字符 4 字节; 索引键上限 3072 字节 (DYNAMIC 行格式, MySQL 5.7.7+)
 *            前缀索引 (col(n)) 允许, n 以**字符**计。
 *   MSSQL  : NVARCHAR ⇒ 每字符 2 字节; 聚集主键/聚集索引键上限 **900** 字节,
 *            非聚集索引键上限 **1700** 字节 (SQL Server 2016+);
 *            MSSQL **不支持**前缀索引 ⇒ 长列必须改列宽或改键设计。
 *
 * 用法:
 *   node Server/scripts/audit/check-index-key-length.mjs [file ...] [--json]
 *   退出码: 0 = 通过; 1 = 有发现 (error 或 warn); 2 = 用法/解析错误
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// 生产切分器 —— 与初始化向导用的是同一份代码
const { splitSqlStatements } = await import(
  pathToFileURL(resolve(REPO_ROOT, 'center', 'src', 'init', 'schema-applier.js')).href
);

// 迁移版本排序 —— 与生产迁移执行顺序用的是同一份代码 (R161.19)
const { sortMigrationFiles, parseFileMeta, compareVersions } = await import(
  pathToFileURL(resolve(REPO_ROOT, 'center', 'src', 'utils', 'migration-version.js')).href
);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MYSQL_MAX_KEY_BYTES = 3072;   // InnoDB, DYNAMIC 行格式
const MSSQL_MAX_CLUSTERED_BYTES = 900;   // 聚集主键 / 聚集索引键
const MSSQL_MAX_NONCLUSTERED_BYTES = 1700; // 非聚集索引键

/**
 * 规则表 —— 负向测试靠它断言"每条规则都有对应样本"。
 *
 * R161.19: 守卫自己必须有负向测试 (R161 的教训: "检测器自己也要负向测试") ——
 * 一个只会输出 0 违规的守卫和一个哑巴无法区分。
 *
 * ★ 严重度**按方言分**: MySQL 键长超限是建索引硬失败 (ER 1071) ⇒ error;
 *   MSSQL 建索引只警告 (Msg 1945, severity 10, 索引照样建出来),
 *   但插入/更新会失败 (Msg 1946, severity 16) ⇒ warn。
 */
export const INDEX_KEY_RULES = [
  {
    code: 'IDX-MISSING-PREFIX',
    dialects: ['mysql', 'mssql'],
    severity: { mysql: 'error', mssql: 'error' },
    why: 'BLOB/TEXT/JSON 列进索引键必须给前缀长度 —— MySQL 直接 ERROR 1170 建索引失败',
  },
  {
    code: 'IDX-KEY-TOO-LONG',
    dialects: ['mysql', 'mssql'],
    severity: { mysql: 'error', mssql: 'warn' },
    why: '非聚集索引键超过引擎上限 —— MySQL ER 1071 硬失败; '
      + 'MSSQL 建索引只警告 (Msg 1945) 但插入/更新会失败 (Msg 1946)',
  },
  {
    code: 'IDX-KEY-TOO-LONG-CLUSTERED',
    dialects: ['mssql'],
    severity: { mysql: 'error', mssql: 'warn' },
    why: 'MSSQL 聚集索引键超过 900 字节 —— 同样是建索引只警告、插入/更新失败',
  },
  {
    code: 'IDX-TABLE-UNKNOWN',
    dialects: ['mysql', 'mssql'],
    severity: { mysql: 'error', mssql: 'error' },
    why: '迁移给基线上下文里没有的表建索引 ⇒ 键长无从核算 ⇒ 不能静默跳过 '
      + '(跳过 = 没检查过, 却看着像检查过并通过了)',
  },
];

/**
 * 固定宽度类型 → 字节数。**按方言分表** ——
 *
 * ★ R161.19 (实测纠正): 旧实现只有一张共用表, 里面的 DATETIME=5 / DATETIME2=8 / TIME=3
 *   是 **MySQL** 的值, 却被 MSSQL 一起用了 ⇒ MSSQL 的时间列一律算错
 *   (SQL Server 的 DATETIME 是 8 字节, TIME(7) 是 5 字节)。
 *
 * MSSQL 一列的值全部来自 SQL Server 2025 RTM 实测 (probe12):
 *   手法 = NVARCHAR(450) NOT NULL (900 字节, 正好卡在聚集索引上限) + 一列目标类型,
 *   引擎在 DDL 时自报 "索引的最大长度为 N 字节" ⇒ N - 900 = 该类型的键字节数。
 *   实测: DATETIME=8 / DATETIME2(3)=7 / DATETIME2(0)=6 / DATE=3 / SMALLDATETIME=4
 *        / TIME(7)=5 / UNIQUEIDENTIFIER=16 / FLOAT=8 / INT=4 / BIGINT=8。
 *   与 sys.columns.max_length 完全一致。
 */
const FIXED_WIDTH_MSSQL = new Map([
  ['TINYINT', 1], ['SMALLINT', 2], ['INT', 4], ['INTEGER', 4], ['BIGINT', 8],
  ['BIT', 1], ['DATE', 3], ['DATETIME', 8], ['SMALLDATETIME', 4],
  ['FLOAT', 8], ['REAL', 4], ['MONEY', 8], ['SMALLMONEY', 4],
  ['UNIQUEIDENTIFIER', 16], ['ROWVERSION', 8], ['TIMESTAMP', 8],
]);

/**
 * MySQL/InnoDB 固定宽度类型 → 字节数。
 * 依据 InnoDB "Space Requirements" (DATE 3 / TIME 3 / DATETIME 5 / TIMESTAMP 4 / YEAR 1),
 * 且 InnoDB 的键长判定用的就是列的**最大存储字节数** (不是字符数 × 字符集)。
 */
const FIXED_WIDTH_MYSQL = new Map([
  ['TINYINT', 1], ['SMALLINT', 2], ['MEDIUMINT', 3], ['INT', 4], ['INTEGER', 4],
  ['BIGINT', 8], ['BIT', 1], ['DATE', 3], ['DATETIME', 5], ['TIMESTAMP', 4],
  ['TIME', 3], ['YEAR', 1], ['FLOAT', 4], ['DOUBLE', 8], ['REAL', 4],
]);

/**
 * 需要前缀长度的类型。
 *
 * ★ R161.3 修正: **BINARY / VARBINARY 不在此列**。
 *   MySQL 只对 BLOB/TEXT/JSON/GEOMETRY 要求索引前缀
 *   ("BLOB/TEXT column 'x' used in key specification without a key length")。
 *   BINARY(n) 是**定长** n 字节、VARBINARY(n) 是定长上界 n 字节的二进制列,
 *   可以直接进索引 —— 把它们当 BLOB 会让每个哈希列 (BINARY(32)) 都误报
 *   "必须给前缀长度", 而 BINARY(32) 给前缀反而是语法错。
 *   证据: 基线里的 uq_ous_dn / uq_admin_member / uq_ugm 三条唯一键都建在
 *   BINARY(32) 哈希列上, 真库 250/250 建表成功。
 */
const NEEDS_PREFIX = new Set([
  'TEXT', 'TINYTEXT', 'MEDIUMTEXT', 'LONGTEXT', 'NTEXT',
  'BLOB', 'TINYBLOB', 'MEDIUMBLOB', 'LONGBLOB', 'IMAGE', 'JSON', 'GEOMETRY',
]);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 剥掉 SQL 注释 (-- 行注释 / 块注释), 字符串字面量内的不算 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'") {
      // 字符串字面量: '' 是转义的单引号
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

/** 按顶层逗号切分 (括号内不算) */
export function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 取第一个括号组的内部内容 (配对扫描) */
function readParenGroup(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

/** 去掉标识符的方括号/反引号 */
function normalizeIdent(raw) {
  return String(raw).replace(/^[`[]/, '').replace(/[\]`]$/, '').replace(/^"(.*)"$/, '$1').toLowerCase();
}

/**
 * 把字符串字面量的**内容**清空 (保留引号)。
 *
 * R161.19: MSSQL 侧的扫描必须先把字面量掏空 —— 否则 RAISERROR('...CREATE INDEX...')
 * 这类消息文本会被当成真的 DDL 扫进来 (假阳性)。
 */
export function blankStringLiterals(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      out += ch; i += 1;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") { out += "''"; i += 2; continue; }
        if (text[i] === "'") { out += "'"; i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/**
 * 取出所有单引号字面量的内容。
 *
 * R161.19: MySQL 侧的 DDL 藏在字面量里 ——
 *   SET @s = (SELECT IF(<探针>, 'CREATE INDEX xxx ON t (c)', 'SELECT 1'));
 *   PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
 * (MySQL 5.7/8.0 没有 CREATE INDEX IF NOT EXISTS ⇒ 幂等只能靠这个形态。)
 */
export function extractStringLiterals(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === "'") {
      let value = '';
      i += 1;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") { value += "'"; i += 2; continue; }
        if (text[i] === "'") { i += 1; break; }
        value += text[i];
        i += 1;
      }
      out.push(value);
      continue;
    }
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 列 / 索引 解析
// ---------------------------------------------------------------------------

const COL_RE = /^([`[]\w+[`\]]|[A-Za-z_]\w*)\s+([A-Za-z]+(?:\s*\([^)]*\))?)([\s\S]*)$/;
const IDX_RE = /^(PRIMARY\s+KEY|UNIQUE\s+(?:KEY|INDEX)|KEY|INDEX)\s*([`[]\w+[`\]]|[A-Za-z_]\w*)?\s*\(([\s\S]*)\)$/i;

/**
 * MSSQL 计算列的结果类型。
 *
 * R161.3 — 计算列的**键长度 = 表达式的结果类型长度**, 不是源列长度。
 * 基线里的哈希列:
 *     [distinguished_name_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [distinguished_name])) PERSISTED
 * 如果不识别它, COL_RE 会把类型读成关键字 'AS' ⇒ 未知类型 ⇒ 按 8 字节估算
 * ⇒ **低估** ⇒ 一个真正超限的计算列索引会被漏报 (这比误报更危险)。
 */
export function detectComputedKeyType(rest) {
  const text = String(rest || '');
  const convert = /CONVERT\s*\(\s*([A-Za-z]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i.exec(text);
  if (convert) return convert[1].replace(/\s+/g, ' ').toUpperCase();
  const cast = /CAST\s*\([^)]*?\s+AS\s+([A-Za-z]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)/i.exec(text);
  if (cast) return cast[1].replace(/\s+/g, ' ').toUpperCase();
  return null;
}

/**
 * 由"列名 + 列定义剩余部分"构造列描述。
 *
 * 两种列定义形态:
 *   普通列   `name BIGINT NOT NULL`            ⇒ type = BIGINT
 *   计算列   `name AS CONVERT(BINARY(32), ...)` ⇒ type = 'AS', keyType = BINARY(32)
 */
function buildColumn(nameRaw, restRaw) {
  const name = normalizeIdent(nameRaw);
  const rest = String(restRaw || '').trim();
  const computed = /^AS\b/i.test(rest);
  if (computed) {
    // 计算列: 类型关键字被读成 'AS' —— 键长度按**结果类型**算
    const computedType = detectComputedKeyType(rest);
    return { name, type: 'AS', rest, computed: true, keyType: computedType || 'AS' };
  }
  const typeMatch = /^([A-Za-z]+(?:\s*\([^)]*\))?)/.exec(rest);
  const type = typeMatch ? typeMatch[1].toUpperCase().replace(/\s+/g, ' ') : 'UNKNOWN';
  return { name, type, rest, computed: false, keyType: type };
}

/**
 * 解析一条 CREATE TABLE 语句 → { table, columns: Map, indexes: [] }
 */
export function parseCreateTable(statement) {
  const head = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`[]\w+[`\]]|(?:\[[^\]]+\]\.)?\[[^\]]+\]|[A-Za-z_]\w*)\s*\(/i.exec(statement);
  if (!head) return null;
  const table = normalizeIdent(head[1].split('.').pop());
  const group = readParenGroup(statement, head.index + head[0].length - 1);
  if (!group) return null;

  const columns = new Map();
  const indexes = [];

  for (const part of splitTopLevel(group.body)) {
    const idx = IDX_RE.exec(part);
    if (idx) {
      indexes.push({
        kind: idx[1].replace(/\s+/g, ' ').toUpperCase(),
        name: idx[2] ? normalizeIdent(idx[2]) : '',
        spec: idx[3],
      });
      continue;
    }
    const col = COL_RE.exec(part);
    if (col) {
      const name = normalizeIdent(col[1]);
      if (!columns.has(name)) {
        const column = buildColumn(col[1], `${col[2]} ${col[3] || ''}`);
        columns.set(name, column);
        // MySQL 的列级主键: `id BIGINT AUTO_INCREMENT PRIMARY KEY`
        if (/\bPRIMARY\s+KEY\b/i.test(col[3] || '')) {
          indexes.push({ kind: 'PRIMARY KEY', name: 'PRIMARY', spec: name });
        }
      }
      continue;
    }
    // 约束 (CONSTRAINT x FOREIGN KEY ...) 等, 忽略
  }
  return { table, columns, indexes };
}

/** 解析索引列清单 → [{ name, prefix }] */
export function parseIndexColumns(spec) {
  return splitTopLevel(spec).map((part) => {
    const m = /^([`[]\w+[`\]]|[A-Za-z_]\w*)\s*(?:\(\s*(\d+)\s*\))?/.exec(part);
    if (!m) return { name: normalizeIdent(part), prefix: null, raw: part };
    return {
      name: normalizeIdent(m[1]),
      prefix: m[2] ? parseInt(m[2], 10) : null,
      raw: part,
    };
  });
}

/**
 * 单列在索引键里的字节数。
 *
 * ★ R161.19 (实测纠正): **不加变长列的长度前缀字节**。
 *   - MSSQL: SQL Server 自己报出来的键长就是"各键列声明宽度之和"。
 *     实测: NVARCHAR(128)+NVARCHAR(1024) 的聚集键 = 2304 字节 (= 256+2048),
 *     NVARCHAR(400) NOT NULL + NVARCHAR(400) NULL = 1600 字节 (= 800+800),
 *     三个 NVARCHAR(400) NULL = 2400 字节 ⇒ **既没有长度前缀, 也没有 NULL 位图字节**。
 *   - MySQL: ER 1071 的判定用的也是声明宽度 (不含 InnoDB 存储时的 2 字节长度前缀)。
 *   ⇒ 旧实现给 VARCHAR/NVARCHAR 加 2 字节是**高估**, 会把正好卡在上限的索引误报成违规。
 *
 * ★ R161.19 (实测纠正): **固定宽度类型按方言分表**。
 *   旧实现用一张 MySQL 口径的表同时算 MSSQL ⇒ MSSQL 的 DATETIME 被算成 5 字节
 *   (SQL Server 实际 8 字节)、TIME 被算成 3 字节 (TIME(7) 实际 5 字节)、
 *   FLOAT 被算成 4 字节 (MSSQL 的 FLOAT 是双精度, 8 字节) ⇒ 键长被低估,
 *   正好卡在 900/1700 上限的 MSSQL 索引会被**漏报**。
 *
 * @param {string} type        列类型原文, 如 "VARCHAR(1024)"
 * @param {number|null} prefix 前缀长度 (字符数); null = 没有前缀
 * @param {string} dialect     'mysql' | 'mssql'
 */
export function columnKeyBytes(type, prefix, dialect) {
  const upper = String(type || '').toUpperCase().trim();
  const base = upper.split('(')[0].trim();
  const lenMatch = /\(\s*(\d+)/.exec(upper);
  const declaredLen = lenMatch ? parseInt(lenMatch[1], 10) : null;
  const scaleMatch = /\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(upper);
  const declaredScale = scaleMatch ? parseInt(scaleMatch[1], 10) : 0;

  if (base === 'VARCHAR' || base === 'CHAR' || base === 'NVARCHAR' || base === 'NCHAR') {
    const unit = base.startsWith('N') ? 2 : (dialect === 'mysql' ? 4 : 1);
    if (prefix !== null) return prefix * unit;
    const len = declaredLen || (base.endsWith('CHAR') ? 1 : 255);
    return len * unit;
  }
  // ★ R161.3: BINARY(n) 定长 n 字节 / VARBINARY(n) 上界 n 字节 —— 定长类型,
  //   不需要前缀 (MySQL 也不允许对它们写前缀), 键长就是 n。
  if (base === 'BINARY' || base === 'VARBINARY') {
    return declaredLen || (base === 'BINARY' ? 1 : 255);
  }
  if (NEEDS_PREFIX.has(base)) {
    const unit = base === 'NTEXT' ? 2 : 1;
    if (prefix !== null) return prefix * unit;
    // 没有前缀 ⇒ MySQL 直接报错 (1170); 这里按最大前缀估算, 由 prefixMissing 单独报
    return 255 * unit;
  }
  if (base === 'DECIMAL' || base === 'NUMERIC') {
    // DECIMAL(p,s) 的存储 = 整数部分与小数部分各按 9 位一组、每组 4 字节
    // (MySQL InnoDB 与 SQL Server 的分组规则一致)。
    const precision = declaredLen || 10;
    const scale = declaredScale || 0;
    const integralDigits = Math.max(precision - scale, 0);
    return (Math.ceil(integralDigits / 9) + Math.ceil(scale / 9)) * 4;
  }
  // ★ R161.19: 精度相关的时间类型 —— 字节数随声明精度变化, 不能用固定表。
  const precise = dialect === 'mssql'
    ? mssqlPreciseBytes(base, declaredLen)
    : mysqlPreciseBytes(base, declaredLen);
  if (precise !== null) return precise;

  const fixed = dialect === 'mssql' ? FIXED_WIDTH_MSSQL : FIXED_WIDTH_MYSQL;
  if (fixed.has(base)) return fixed.get(base);
  return 8; // 未知类型: 保守按 8 字节
}

/**
 * MSSQL 精度相关类型的键字节数。
 *
 * ★ R161.19 实测 (probe12, SQL Server 2025 RTM):
 *   DATETIME2(0)=6 / DATETIME2(3)=7 / DATETIME2(7)=8
 *   TIME(7)=5 / TIME(3)=4 / TIME(0)=3
 *   DATETIMEOFFSET(n) = DATETIME2(n) + 2 (时区偏移)
 *   声明不写精度时 SQL Server 取默认值 7。
 */
function mssqlPreciseBytes(base, declaredLen) {
  const precision = declaredLen === null ? 7 : declaredLen;
  if (base === 'TIME') return precision <= 2 ? 3 : (precision <= 4 ? 4 : 5);
  if (base === 'DATETIME2') return precision <= 2 ? 6 : (precision <= 4 ? 7 : 8);
  if (base === 'DATETIMEOFFSET') return mssqlPreciseBytes('DATETIME2', precision) + 2;
  return null;
}

/**
 * MySQL 时间类型的键字节数 (InnoDB 存储要求)。
 *   DATETIME = 5 (+1 当 fsp > 0) / TIMESTAMP = 4 (+1 当 fsp > 0)
 *   TIME = 3 + ceil(fsp / 2)
 */
function mysqlPreciseBytes(base, declaredLen) {
  const fsp = declaredLen || 0;
  if (base === 'DATETIME') return 5 + (fsp > 0 ? 1 : 0);
  if (base === 'TIMESTAMP') return 4 + (fsp > 0 ? 1 : 0);
  if (base === 'TIME') return 3 + Math.ceil(fsp / 2);
  return null;
}

/**
 * 列是否可空 —— **只用于报表**, 不参与键长计算。
 *
 * ★ R161.19 (实测): SQL Server 的 900/1700 键长上限**不含 NULL 位图字节**。
 *   实测 NVARCHAR(400) NOT NULL + NVARCHAR(400) NULL = 1600 字节 (与全 NOT NULL 同值),
 *   三个可空 NVARCHAR(400) = 2400 字节 ⇒ 引擎的算法就是"各键列声明宽度之和"。
 */
function isNullable(column) {
  if (!column) return false;
  return !/\bNOT\s+NULL\b/i.test(column.rest || '');
}

// ---------------------------------------------------------------------------
// 独立 CREATE INDEX / ALTER TABLE 解析 (R161.19)
// ---------------------------------------------------------------------------

const IDENT = '`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_]\\w*';
const MSSQL_INDEX_HEAD_RE = new RegExp(
  `CREATE\\s+(UNIQUE\\s+)?(NONCLUSTERED|CLUSTERED)\\s+INDEX\\s+(${IDENT})\\s+ON\\s+(${IDENT})\\s*\\(`,
  'gi',
);
const MYSQL_INDEX_HEAD_RE = new RegExp(
  `CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(${IDENT})\\s+ON\\s+(${IDENT})\\s*\\(`,
  'gi',
);
const MSSQL_PK_HEAD_RE = new RegExp(
  `ALTER\\s+TABLE\\s+(${IDENT})\\s+ADD\\s+CONSTRAINT\\s+(${IDENT})\\s+PRIMARY\\s+KEY\\s*\\(`,
  'gi',
);
// ★ ADD 后面紧跟的**约束关键字**不是列名 ——
//   `ALTER TABLE t ADD CONSTRAINT [pk] PRIMARY KEY (...)` 里的 CONSTRAINT 是约束,
//   `ALTER TABLE t ADD PRIMARY KEY (...)` 里的 PRIMARY 是约束类型。
//   不排除它们 ⇒ 会往 context 里塞一个名叫 "constraint" / "primary" 的假列。
const NOT_A_COLUMN = '(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|KEY|INDEX|CHECK|PERIOD)\\b)';
const MSSQL_ADD_COL_RE = new RegExp(
  `ALTER\\s+TABLE\\s+(${IDENT})\\s+ADD\\s+${NOT_A_COLUMN}(${IDENT})\\s+`,
  'gi',
);
const MYSQL_ADD_COL_RE = new RegExp(
  `ALTER\\s+TABLE\\s+(${IDENT})\\s+ADD\\s+(?:COLUMN\\s+)?${NOT_A_COLUMN}(${IDENT})\\s+`,
  'gi',
);

/**
 * 解析独立 CREATE INDEX 语句 → [{ table, name, unique, kind, spec }]
 *
 * R161.19 的三个要点:
 *   1. 键列清单用**配对括号扫描**取, 不能用正则 —— `([a], [b])` 用正则会被
 *      截成 `[a], [b` (少了右括号), 而 `([a]) WHERE (x IS NOT NULL)` 会被
 *      正则吞掉过滤谓词。旧守卫的正则要求结尾是 `)\s*;` ⇒ 带 WHERE 的索引
 *      一条都匹配不上 (基线里 6 条带过滤谓词的索引全部漏检)。
 *   2. INCLUDE (...) 列**不计入键长** (SQL Server 的 INCLUDE 列不进索引键),
 *      但必须跳过, 否则会被当成键列。
 *   3. MySQL 的 DDL 藏在字符串字面量里 ⇒ 逐个字面量单独解析。
 */
export function parseStandaloneIndexes(sql, dialect) {
  const text = stripSqlComments(sql);
  // ★ MySQL 侧要扫**两处**:
  //   ① 字面量内容 —— 基线/迁移把 DDL 藏在 SET @s = (SELECT IF(..., 'CREATE INDEX ...'))
  //   ② 掏空字面量后的正文 —— 裸写的 CREATE INDEX (合法 MySQL 语法)。
  //     只扫 ① 的话, 迁移里裸写的索引会整个漏掉 (与 MSSQL 侧的 "WHERE 过滤谓词"
  //     同一个病: 扫描范围比文件窄 ⇒ 没检查过却看着像检查过)。
  //   ② 里的字面量已被掏空 ⇒ 两处不会重复计数。
  const sources = dialect === 'mysql'
    ? [blankStringLiterals(text), ...extractStringLiterals(text)]
    : [blankStringLiterals(text)];

  const out = [];
  for (const source of sources) {
    const re = dialect === 'mysql' ? MYSQL_INDEX_HEAD_RE : MSSQL_INDEX_HEAD_RE;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const openIndex = m.index + m[0].length - 1;
      const group = readParenGroup(source, openIndex);
      if (!group) { re.lastIndex = openIndex + 1; continue; }
      const unique = Boolean(m[1]);
      const table = normalizeIdent(dialect === 'mysql' ? m[3] : m[4]);
      const name = normalizeIdent(dialect === 'mysql' ? m[2] : m[3]);
      // ★ 必须按捕获到的**整个**分组判定聚集/非聚集 ——
      //   /CLUSTERED/i.test('NONCLUSTERED') 是 true ("NONCLUSTERED" 里含 "CLUSTERED")
      //   ⇒ 那样会把非聚集索引误判成聚集索引, 门槛从 1700 掉到 900 ⇒ 假阳性。
      const clustered = dialect === 'mssql' && String(m[2]).toUpperCase() === 'CLUSTERED';
      const kind = dialect === 'mysql'
        ? (unique ? 'UNIQUE INDEX' : 'INDEX')
        : `${unique ? 'UNIQUE ' : ''}${String(m[2]).toUpperCase()} INDEX`;
      out.push({ table, name, unique, kind, spec: group.body });
      // 跳过整个键列括号, 别让 INCLUDE / WHERE 被二次匹配
      re.lastIndex = group.end + 1;
    }
  }
  return out;
}

/**
 * 解析 ALTER TABLE ADD CONSTRAINT ... PRIMARY KEY (...) → [{ table, name, spec }]
 */
export function parsePrimaryKeyConstraints(sql, dialect) {
  if (dialect !== 'mssql') return [];
  const text = blankStringLiterals(stripSqlComments(sql));
  const out = [];
  MSSQL_PK_HEAD_RE.lastIndex = 0;
  let m;
  while ((m = MSSQL_PK_HEAD_RE.exec(text))) {
    const openIndex = m.index + m[0].length - 1;
    const group = readParenGroup(text, openIndex);
    if (!group) { MSSQL_PK_HEAD_RE.lastIndex = openIndex + 1; continue; }
    out.push({ table: normalizeIdent(m[1]), name: normalizeIdent(m[2]), spec: group.body });
    MSSQL_PK_HEAD_RE.lastIndex = group.end + 1;
  }
  return out;
}

/**
 * 解析 ALTER TABLE ... ADD <列> ... → [{ table, columns: [列描述] }]
 *
 * R161.19: 编号迁移靠 ALTER TABLE 加列 (MSSQL 1.0.4 的三个 hash 计算列、
 * MySQL 基线里 39 处 ALTER TABLE ... ADD COLUMN), 这些列不进 context
 * ⇒ 后面引用它们的索引就解析不出宽度 ⇒ 必须并进 context。
 */
export function parseColumnAdditions(sql, dialect) {
  const text = stripSqlComments(sql);
  // 与 parseStandaloneIndexes 同理: MySQL 侧既要扫字面量里的 ADD COLUMN,
  // 也要扫正文里裸写的 ALTER TABLE ... ADD COLUMN。
  const sources = dialect === 'mysql'
    ? [blankStringLiterals(text), ...extractStringLiterals(text)]
    : [blankStringLiterals(text)];

  const out = [];
  for (const source of sources) {
    const re = dialect === 'mysql' ? MYSQL_ADD_COL_RE : MSSQL_ADD_COL_RE;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const table = normalizeIdent(m[1]);
      const columnName = m[2];
      // 列定义 = 名字后面到下一个顶层逗号 / 语句结束为止
      const restStart = m.index + m[0].length;
      const rest = readColumnRest(source, restStart);
      if (rest === null) continue;
      const columns = splitTopLevel(rest).map((part) => buildColumn(columnName, part));
      out.push({ table, columns });
      re.lastIndex = restStart + rest.length;
    }
  }
  return out;
}

/** 从 start 处读到"顶层逗号或语句结束"为止, 返回这段文本 (读不到则 null) */
function readColumnRest(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return source.slice(start, i);
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return source.slice(start, i);
    } else if (ch === ';' && depth === 0) {
      return source.slice(start, i);
    }
  }
  return source.slice(start);
}

// ---------------------------------------------------------------------------
// 上下文 (表 → 列 / 索引)
// ---------------------------------------------------------------------------

/**
 * 把一份 SQL 解析成上下文: 表名 → { columns: Map, indexes: [] }。
 * @returns {Map<string, {name: string, columns: Map, indexes: Array}>}
 */
export function buildSchemaContext(sql, dialect) {
  const tables = new Map();
  const ensure = (rawName) => {
    const key = normalizeIdent(rawName);
    let table = tables.get(key);
    if (!table) {
      table = { name: key, columns: new Map(), indexes: [] };
      tables.set(key, table);
    }
    return table;
  };

  // 1) CREATE TABLE —— 列与表内索引
  for (const stmt of splitSqlStatements(sql)) {
    const parsed = parseCreateTable(stmt);
    if (!parsed) continue;
    const table = ensure(parsed.table);
    for (const [name, column] of parsed.columns) {
      if (!table.columns.has(name)) table.columns.set(name, column);
    }
    table.indexes.push(...parsed.indexes);
  }

  // 2) ALTER TABLE ADD <列> —— 补进 context (含 MySQL 藏在字面量里的)
  for (const addition of parseColumnAdditions(sql, dialect)) {
    const table = ensure(addition.table);
    for (const column of addition.columns) {
      if (!table.columns.has(column.name)) table.columns.set(column.name, column);
    }
  }

  // 3) 独立 CREATE INDEX
  for (const index of parseStandaloneIndexes(sql, dialect)) {
    ensure(index.table).indexes.push({ kind: index.kind, name: index.name, spec: index.spec });
  }

  // 4) ALTER TABLE ADD CONSTRAINT ... PRIMARY KEY
  for (const pk of parsePrimaryKeyConstraints(sql, dialect)) {
    ensure(pk.table).indexes.push({ kind: 'PRIMARY KEY', name: pk.name, spec: pk.spec });
  }

  return tables;
}

/** 把一份迁移里的新增列并进已有 context (原地) */
export function applyColumnAdditions(context, sql, dialect) {
  for (const addition of parseColumnAdditions(sql, dialect)) {
    let table = context.get(addition.table);
    if (!table) {
      table = { name: addition.table, columns: new Map(), indexes: [] };
      context.set(addition.table, table);
    }
    for (const column of addition.columns) {
      if (!table.columns.has(column.name)) table.columns.set(column.name, column);
    }
  }
  return context;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 算一条索引的键字节数。
 * @returns {{bytes: number, parts: Array, prefixMissing: boolean}}
 */
function evaluateIndex(index, table, dialect) {
  let bytes = 0;
  const parts = [];
  let prefixMissing = false;
  for (const column of parseIndexColumns(index.spec)) {
    const col = table.columns.get(column.name);
    // 计算列按**结果类型**算键长 (R161.3)
    const keyType = col ? col.keyType : 'UNKNOWN';
    const b = columnKeyBytes(keyType, column.prefix, dialect);
    bytes += b;
    parts.push({
      name: column.name,
      type: col ? col.type : 'UNKNOWN',
      keyType,
      prefix: column.prefix,
      bytes: b,
      nullable: col ? isNullable(col) : null,
    });
    const base = keyType.split('(')[0].trim().toUpperCase();
    if (NEEDS_PREFIX.has(base) && column.prefix === null) prefixMissing = true;
  }
  return { bytes, parts, prefixMissing };
}

/** 索引是否按聚集方式存放 (决定 MSSQL 的 900 / 1700 门槛) */
function isClusteredIndex(index) {
  return index.kind === 'PRIMARY KEY' || index.kind === 'CLUSTERED INDEX';
}

/**
 * 对一条索引做判定, 命中则产出 finding。
 * @returns {Array} 0 或 1 条 finding
 */
function checkIndex(index, table, dialect) {
  const problems = [];
  const evaluated = evaluateIndex(index, table, dialect);

  if (evaluated.prefixMissing) {
    problems.push({
      code: 'IDX-MISSING-PREFIX',
      severity: 'error',
      dialect,
      table: table.name,
      index: index.name || index.kind,
      kind: index.kind,
      bytes: evaluated.bytes,
      limit: MYSQL_MAX_KEY_BYTES,
      detail: 'BLOB/TEXT/JSON 列进索引必须给前缀长度 (MySQL ERROR 1170)',
      parts: evaluated.parts,
    });
  }

  const clustered = isClusteredIndex(index);
  const limit = dialect === 'mysql'
    ? MYSQL_MAX_KEY_BYTES
    : (clustered ? MSSQL_MAX_CLUSTERED_BYTES : MSSQL_MAX_NONCLUSTERED_BYTES);

  if (evaluated.bytes > limit) {
    // ★ MySQL 没有聚集/非聚集之分 (InnoDB 的主键也是二级索引) ⇒ 它的主键超限
    //   报的是同一条规则 'IDX-KEY-TOO-LONG' (门槛仍然是 3072), 不能报成
    //   'IDX-KEY-TOO-LONG-CLUSTERED' (那个名字只对 MSSQL 有意义)。
    const code = (dialect === 'mssql' && clustered)
      ? 'IDX-KEY-TOO-LONG-CLUSTERED'
      : 'IDX-KEY-TOO-LONG';
    problems.push({
      code,
      // MySQL: DDL 直接失败 (ER 1071) ⇒ error
      // MSSQL: DDL 只警告 (Msg 1945), 但写入会失败 (Msg 1946) ⇒ warn
      severity: dialect === 'mysql' ? 'error' : 'warn',
      dialect,
      table: table.name,
      index: index.name || index.kind,
      kind: index.kind,
      bytes: evaluated.bytes,
      limit,
      detail: dialect === 'mysql'
        ? `索引键 ${evaluated.bytes} 字节 > InnoDB 上限 ${limit} 字节 `
          + `(utf8mb4 每字符 4 字节 ⇒ 单列最多 767 字符) — 建表/建索引直接失败 (ER 1071)`
        : `索引键 ${evaluated.bytes} 字节 > SQL Server 上限 ${limit} 字节 `
          + `(聚集 ${MSSQL_MAX_CLUSTERED_BYTES} / 非聚集 ${MSSQL_MAX_NONCLUSTERED_BYTES}) — `
          + `建索引只警告 (Msg 1945) 但**插入/更新会失败** (Msg 1946)`,
      parts: evaluated.parts,
    });
  }
  return problems;
}

/**
 * 校验一份基线文件 (自包含: 表和列都在这份文件里)。
 * @param {string} sql
 * @param {string} dialect 'mysql' | 'mssql'
 * @returns {{ problems: Array, stats: Object }}
 */
export function checkBaseline(sql, dialect) {
  const tables = buildSchemaContext(sql, dialect);
  const problems = [];
  const stats = { tables: tables.size, indexes: 0, dialect };
  for (const table of tables.values()) {
    for (const index of table.indexes) {
      stats.indexes += 1;
      problems.push(...checkIndex(index, table, dialect));
    }
  }
  return { problems, stats };
}

/**
 * 收集一份**编号迁移**里建的索引, 并算出各自的键字节数。
 *
 * R161.19: 编号迁移不含 CREATE TABLE ⇒ 列宽从 context (基线 + 更早迁移的
 * 列增补) 里取。context 里找不到表 ⇒ 记 unknownTable (不静默跳过:
 * 跳过 = "没检查过" 却看起来像"检查过并通过")。
 *
 * @param {string} sql    迁移文件内容
 * @param {string} dialect
 * @param {Map} context   buildSchemaContext 的产物
 * @returns {Array<{table: string, name: string, kind: string, bytes: number|null, parts: Array, unknownTable: boolean}>}
 */
export function collectMigrationIndexes(sql, dialect, context) {
  const candidates = [
    ...parseStandaloneIndexes(sql, dialect).map((i) => ({
      table: i.table, name: i.name, kind: i.kind, spec: i.spec,
    })),
    ...parsePrimaryKeyConstraints(sql, dialect).map((i) => ({
      table: i.table, name: i.name, kind: 'PRIMARY KEY', spec: i.spec,
    })),
  ];

  return candidates.map((index) => {
    const table = context.get(index.table);
    if (!table) {
      return { ...index, bytes: null, parts: [], prefixMissing: false, unknownTable: true };
    }
    const evaluated = evaluateIndex(index, table, dialect);
    return {
      ...index,
      bytes: evaluated.bytes,
      parts: evaluated.parts,
      prefixMissing: evaluated.prefixMissing,
      unknownTable: false,
    };
  });
}

/**
 * 校验一份**编号迁移**里建的索引。
 *
 * @param {string} sql    迁移文件内容
 * @param {string} dialect
 * @param {Map} context   buildSchemaContext 的产物
 * @returns {{ problems: Array, stats: Object }}
 */
export function checkMigrationIndexes(sql, dialect, context) {
  const problems = [];
  const stats = { tables: context.size, indexes: 0, dialect };

  for (const index of collectMigrationIndexes(sql, dialect, context)) {
    stats.indexes += 1;
    if (index.unknownTable) {
      problems.push({
        code: 'IDX-TABLE-UNKNOWN',
        severity: 'error',
        dialect,
        table: index.table,
        index: index.name || index.kind,
        kind: index.kind,
        bytes: 0,
        limit: dialect === 'mysql' ? MYSQL_MAX_KEY_BYTES : MSSQL_MAX_NONCLUSTERED_BYTES,
        detail: `迁移里给 [${index.table}] 建索引, 但基线上下文里没有这张表 ⇒ 无法核算键长`,
        parts: [],
      });
      continue;
    }
    problems.push(...checkIndex(index, context.get(index.table), dialect));
  }
  return { problems, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const BASELINE_NAME = '1.0.0-baseline.sql';
const DIALECTS = ['mysql', 'mssql'];

function dialectOf(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/mysql/')) return 'mysql';
  if (normalized.includes('/mssql/')) return 'mssql';
  return null;
}

function migrationDirOf(dialect) {
  return resolve(REPO_ROOT, 'db', 'migrations', dialect);
}

/** 该方言下的编号迁移文件 (按语义版本排序, 与生产执行顺序一致) */
function listMigrationFiles(dialect) {
  const dir = migrationDirOf(dialect);
  if (!existsSync(dir)) return [];
  return sortMigrationFiles(
    readdirSync(dir).filter((f) => /\.sql$/i.test(f) && f !== BASELINE_NAME),
  );
}

/** 基线上下文 (按需加载, 缓存在 contexts 里) */
function loadBaselineContext(dialect, contexts) {
  if (contexts.has(dialect)) return contexts.get(dialect);
  const baselinePath = resolve(migrationDirOf(dialect), BASELINE_NAME);
  if (!existsSync(baselinePath)) return null;
  const tables = buildSchemaContext(readFileSync(baselinePath, 'utf8'), dialect);
  contexts.set(dialect, tables);
  return tables;
}

/** 把版本号小于 targetVersion 的迁移里的新增列并进 context */
function applyPrecedingMigrationColumns(dialect, targetVersion, context) {
  for (const file of listMigrationFiles(dialect)) {
    const meta = parseFileMeta(file);
    if (!meta) continue;
    if (compareVersions(meta.version, targetVersion) >= 0) continue;
    const sql = readFileSync(resolve(migrationDirOf(dialect), file), 'utf8');
    applyColumnAdditions(context, sql, dialect);
  }
  return context;
}

function printProblems(problems) {
  for (const p of problems) {
    process.stdout.write(
      `  [${p.severity === 'warn' ? 'WARN' : 'FAIL'}] ${p.code} ${p.table}.${p.index} — ${p.bytes}B > ${p.limit}B\n` +
      `      ${p.detail}\n` +
      `      ${p.parts.map((x) => `${x.name}:${x.keyType}${x.prefix !== null ? `(${x.prefix})` : ''}=${x.bytes}B`).join(' , ')}\n`,
    );
  }
}

function main(argv) {
  const json = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));

  /** @type {Array<{path: string, dialect: string, role: string}>} */
  const targets = [];
  if (files.length > 0) {
    for (const f of files) {
      const abs = resolve(process.cwd(), f);
      if (!existsSync(abs)) {
        process.stderr.write(`[FAIL] 文件不存在: ${f}\n`);
        return 2;
      }
      const dialect = dialectOf(abs) || 'mysql';
      targets.push({
        path: abs,
        dialect,
        role: basename(abs).toLowerCase() === BASELINE_NAME ? 'baseline' : 'migration',
      });
    }
  } else {
    for (const dialect of DIALECTS) {
      const baseline = resolve(migrationDirOf(dialect), BASELINE_NAME);
      if (!existsSync(baseline)) {
        process.stderr.write(`[FAIL] 基线文件不存在: ${baseline}\n`);
        return 2;
      }
      targets.push({ path: baseline, dialect, role: 'baseline' });
      for (const file of listMigrationFiles(dialect)) {
        targets.push({ path: resolve(migrationDirOf(dialect), file), dialect, role: 'migration' });
      }
    }
  }

  const contexts = new Map();
  const fileStats = [];
  let allProblems = [];

  for (const target of targets) {
    const sql = readFileSync(target.path, 'utf8');
    let problems = [];
    let stats;

    if (target.role === 'baseline') {
      const tables = buildSchemaContext(sql, target.dialect);
      contexts.set(target.dialect, tables);
      const checked = checkBaseline(sql, target.dialect);
      problems = checked.problems;
      stats = checked.stats;
    } else {
      const meta = parseFileMeta(target.path);
      let context = loadBaselineContext(target.dialect, contexts);
      if (!context) {
        process.stderr.write(`[FAIL] 找不到 ${target.dialect} 的基线上下文, 无法校验迁移: ${target.path}\n`);
        return 2;
      }
      if (meta) applyPrecedingMigrationColumns(target.dialect, meta.version, context);
      // 先把本迁移新增的列并进 context, 再检查它建的索引
      applyColumnAdditions(context, sql, target.dialect);
      const checked = checkMigrationIndexes(sql, target.dialect, context);
      problems = checked.problems;
      stats = checked.stats;
    }

    allProblems = allProblems.concat(problems);
    fileStats.push({
      file: basename(target.path),
      dialect: target.dialect,
      role: target.role,
      tables: stats.tables,
      indexes: stats.indexes,
      problems: problems.length,
    });

    if (!json) {
      const prefix = target.role === 'baseline'
        ? `${basename(target.path)} (${target.dialect}) → 表 ${stats.tables} / 索引 ${stats.indexes}`
        : `${basename(target.path)} (${target.dialect}) → 索引 ${stats.indexes}`;
      process.stdout.write(`${prefix} / 违规 ${problems.length}\n`);
      printProblems(problems);
    }
  }

  if (json) {
    // ★ --json 模式必须输出**纯 JSON** —— 后面不能再追加 "OK: ..." 这类人读的行,
    //   否则调用方 JSON.parse(stdout) 会炸 (实测过: "Unexpected non-whitespace
    //   character after JSON")。
    process.stdout.write(`${JSON.stringify({ problems: allProblems, files: fileStats }, null, 2)}\n`);
    return allProblems.length > 0 ? 1 : 0;
  }

  if (allProblems.length > 0) {
    const errors = allProblems.filter((p) => p.severity === 'error').length;
    const warns = allProblems.length - errors;
    process.stdout.write(
      `\nFAIL: 索引键长度违规 ${allProblems.length} 处 (error ${errors} / warn ${warns})\n` +
      `  warn = MSSQL: 建索引只警告, 但插入/更新会失败 (Msg 1946)\n`,
    );
    return 1;
  }
  process.stdout.write('\nOK: 索引键长度全部在引擎上限内\n');
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
