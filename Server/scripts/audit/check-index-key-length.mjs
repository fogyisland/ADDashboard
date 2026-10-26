#!/usr/bin/env node
/**
 * R161.3 — 索引键长度守卫 (InnoDB 3072B / SQL Server 900B·1700B)
 *
 * 背景 (2026-10-25): 全新 MySQL 初始化向导报
 *   "Specified key was too long; max key length is 3072 bytes"
 * ⇒ 基线里有索引键超过 InnoDB 上限的 DDL。
 *
 * 为什么要守卫而不是"跑一次就够":
 *   - 顺序类缺陷 (FK) 和长度类缺陷 (索引键) 都**只在全新库暴露** ——
 *     老库的 bootstrapMigrations 见到 schema_migrations 就短路。
 *   - 同一个坑还会换张表复发 (R161.2 是 ad_dc_overview, R161.3 是 5+ 张表)。
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
 *            非聚集索引隐含包含聚集键 ⇒ 实际预算还要减去聚集键长度, 本守卫
 *            按"聚集键 + 索引键"合计判定。
 *
 * 用法:
 *   node Server/scripts/audit/check-index-key-length.mjs [file ...] [--json]
 *   退出码: 0 = 通过; 1 = 有 error; 2 = 用法/解析错误
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// 生产切分器 —— 与初始化向导用的是同一份代码
const { splitSqlStatements } = await import(
  pathToFileURL(resolve(REPO_ROOT, 'center', 'src', 'init', 'schema-applier.js')).href
);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MYSQL_MAX_KEY_BYTES = 3072;   // InnoDB, DYNAMIC 行格式
const MSSQL_MAX_CLUSTERED_BYTES = 900;   // 聚集主键 / 聚集索引键
const MSSQL_MAX_NONCLUSTERED_BYTES = 1700; // 非聚集索引键 (SQL Server 2016+)

/** 固定宽度类型 → 字节数 */
const FIXED_WIDTH = new Map([
  ['TINYINT', 1], ['SMALLINT', 2], ['MEDIUMINT', 3], ['INT', 4], ['INTEGER', 4],
  ['BIGINT', 8], ['DATE', 3], ['DATETIME', 5], ['DATETIME2', 8], ['SMALLDATETIME', 4],
  ['TIMESTAMP', 4], ['TIME', 3], ['FLOAT', 4], ['DOUBLE', 8], ['REAL', 4],
  ['BIT', 1], ['MONEY', 8], ['SMALLMONEY', 4], ['UNIQUEIDENTIFIER', 16],
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
  return raw.replace(/^[`[]/, '').replace(/[\]`]$/, '').replace(/^"(.*)"$/, '$1').toLowerCase();
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
        const type = col[2].toUpperCase().replace(/\s+/g, ' ');
        const rest = col[3] || '';
        // MSSQL 计算列: `name AS <expr> [PERSISTED]` —— 类型关键字被读成 'AS'
        const computed = type === 'AS';
        const computedType = computed ? detectComputedKeyType(rest) : null;
        columns.set(name, {
          type,
          rest,
          computed,
          // 键长度按结果类型算; 认不出结果类型时退回 'AS'(= 未知类型, 8 字节)
          keyType: computedType || type,
        });
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
 * @param {string} type        列类型原文, 如 "VARCHAR(1024)"
 * @param {number|null} prefix 前缀长度 (字符数); null = 没有前缀
 * @param {string} dialect     'mysql' | 'mssql'
 */
export function columnKeyBytes(type, prefix, dialect) {
  const upper = String(type || '').toUpperCase().trim();
  const base = upper.split('(')[0].trim();
  const lenMatch = /\(\s*(\d+)/.exec(upper);
  const declaredLen = lenMatch ? parseInt(lenMatch[1], 10) : null;

  if (base === 'VARCHAR' || base === 'CHAR' || base === 'NVARCHAR' || base === 'NCHAR') {
    const unit = base.startsWith('N') ? 2 : (dialect === 'mysql' ? 4 : 1);
    if (prefix !== null) return prefix * unit + (base.endsWith('VARCHAR') ? 2 : 0);
    const len = declaredLen || (base.endsWith('CHAR') ? 1 : 255);
    return len * unit + (base.endsWith('VARCHAR') ? 2 : 0);
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
    const precision = declaredLen || 10;
    return Math.ceil(precision / 9) * 4;
  }
  if (base === 'JSON') return 255 * 4;
  if (FIXED_WIDTH.has(base)) return FIXED_WIDTH.get(base);
  return 8; // 未知类型: 保守按 8 字节
}

/** 列是否可空 (MSSQL 聚集键每多一个可空列多 1 字节) */
function isNullable(column) {
  if (!column) return false;
  return !/\bNOT\s+NULL\b/i.test(column.rest || '');
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 校验一份基线文件。
 * @returns {{ problems: Array, stats: Object }}
 */
export function checkBaseline(sql, dialect) {
  const statements = splitSqlStatements(sql);
  const problems = [];
  const tables = new Map();
  const order = new Map();

  // 1) CREATE TABLE
  for (const stmt of statements) {
    const parsed = parseCreateTable(stmt);
    if (!parsed) continue;
    if (!tables.has(parsed.table)) order.set(parsed.table, tables.size);
    const existing = tables.get(parsed.table) || { columns: new Map(), indexes: [] };
    for (const [k, v] of parsed.columns) if (!existing.columns.has(k)) existing.columns.set(k, v);
    existing.indexes.push(...parsed.indexes);
    tables.set(parsed.table, existing);
  }

  // 2) MSSQL: 独立的 CREATE INDEX / ADD CONSTRAINT PRIMARY KEY
  if (dialect === 'mssql') {
    const ciRe = /CREATE\s+(?:UNIQUE\s+)?(NONCLUSTERED|CLUSTERED)\s+INDEX\s+([`[]\w+[`\]])\s+ON\s+([`[]\w+[`\]])\s*\(([\s\S]*?)\)\s*;/gi;
    let m;
    while ((m = ciRe.exec(sql))) {
      const t = tables.get(normalizeIdent(m[3]));
      if (!t) continue;
      t.indexes.push({ kind: `${m[1].toUpperCase()} INDEX`, name: normalizeIdent(m[2]), spec: m[4] });
    }
    const pkRe = /ALTER\s+TABLE\s+([`[]\w+[`\]])\s+ADD\s+CONSTRAINT\s+([`[]\w+[`\]])\s+PRIMARY\s+KEY\s*\(([\s\S]*?)\)\s*;/gi;
    while ((m = pkRe.exec(sql))) {
      const t = tables.get(normalizeIdent(m[1]));
      if (!t) continue;
      t.indexes.push({ kind: 'PRIMARY KEY', name: normalizeIdent(m[2]), spec: m[3] });
    }
  }

  // 3) 逐表逐索引算字节
  const stats = { tables: 0, indexes: 0, dialect };
  for (const [table, t] of tables) {
    stats.tables += 1;
    // MySQL: 该表的主键字节 (供 MSSQL 风格判定用不到, 但便于报表)
    let clusteredBytes = 0;
    for (const idx of t.indexes) {
      if (idx.kind === 'PRIMARY KEY') {
        for (const c of parseIndexColumns(idx.spec)) {
          const col = t.columns.get(c.name);
          clusteredBytes += columnKeyBytes(col ? col.keyType : '?', c.prefix, dialect);
          if (dialect === 'mssql' && col && isNullable(col)) clusteredBytes += 1;
        }
      }
    }

    for (const idx of t.indexes) {
      stats.indexes += 1;
      let bytes = 0;
      const parts = [];
      let prefixMissing = false;
      for (const c of parseIndexColumns(idx.spec)) {
        const col = t.columns.get(c.name);
        const type = col ? col.type : 'UNKNOWN';
        // 计算列按**结果类型**算键长 (R161.3)
        const keyType = col ? col.keyType : 'UNKNOWN';
        const b = columnKeyBytes(keyType, c.prefix, dialect);
        if (dialect === 'mssql' && col && isNullable(col)) { bytes += 1; }
        bytes += b;
        parts.push({ name: c.name, type, keyType, prefix: c.prefix, bytes: b });
        const base = keyType.split('(')[0].trim().toUpperCase();
        if (NEEDS_PREFIX.has(base) && c.prefix === null) prefixMissing = true;
      }

      const isClustered = idx.kind === 'PRIMARY KEY' || idx.kind === 'CLUSTERED INDEX';
      let limit;
      let effective = bytes;
      if (dialect === 'mysql') {
        limit = MYSQL_MAX_KEY_BYTES;
      } else {
        limit = isClustered ? MSSQL_MAX_CLUSTERED_BYTES : MSSQL_MAX_NONCLUSTERED_BYTES;
        if (!isClustered) effective = bytes + clusteredBytes; // 非聚集索引隐含聚集键
      }

      if (prefixMissing) {
        problems.push({
          code: 'IDX-MISSING-PREFIX',
          severity: 'error',
          dialect,
          table,
          index: idx.name || idx.kind,
          kind: idx.kind,
          bytes,
          limit,
          detail: 'BLOB/TEXT/JSON 列进索引必须给前缀长度 (MySQL ERROR 1170)',
          parts,
        });
      }
      if (effective > limit) {
        problems.push({
          code: isClustered ? 'IDX-KEY-TOO-LONG-CLUSTERED' : 'IDX-KEY-TOO-LONG',
          severity: 'error',
          dialect,
          table,
          index: idx.name || idx.kind,
          kind: idx.kind,
          bytes: effective,
          limit,
          detail: dialect === 'mysql'
            ? `索引键 ${effective} 字节 > InnoDB 上限 ${limit} 字节 (utf8mb4 每字符 4 字节 ⇒ 单列最多 767 字符)`
            : `索引键 ${effective} 字节 > SQL Server 上限 ${limit} 字节 (聚集 ${MSSQL_MAX_CLUSTERED_BYTES} / 非聚集 ${MSSQL_MAX_NONCLUSTERED_BYTES})`,
          parts,
        });
      }
    }
  }
  return { problems, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_FILES = [
  ['mysql', 'db/migrations/mysql/1.0.0-baseline.sql'],
  ['mssql', 'db/migrations/mssql/1.0.0-baseline.sql'],
];

function dialectOf(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/mysql/')) return 'mysql';
  if (normalized.includes('/mssql/')) return 'mssql';
  return null;
}

function main(argv) {
  const json = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));
  const targets = [];

  if (files.length > 0) {
    for (const f of files) {
      const abs = resolve(process.cwd(), f);
      if (!existsSync(abs)) {
        process.stderr.write(`[FAIL] 文件不存在: ${f}\n`);
        return 2;
      }
      targets.push({ path: abs, dialect: dialectOf(abs) || 'mysql' });
    }
  } else {
    for (const [dialect, rel] of DEFAULT_FILES) {
      const abs = resolve(REPO_ROOT, rel);
      if (!existsSync(abs)) {
        process.stderr.write(`[FAIL] 基线文件不存在: ${rel}\n`);
        return 2;
      }
      targets.push({ path: abs, dialect });
    }
  }

  let allProblems = [];
  for (const t of targets) {
    const sql = readFileSync(t.path, 'utf8');
    const { problems, stats } = checkBaseline(sql, t.dialect);
    allProblems = allProblems.concat(problems);
    if (!json) {
      process.stdout.write(
        `${basename(t.path)} (${t.dialect}) → 表 ${stats.tables} / 索引 ${stats.indexes} / 违规 ${problems.length}\n`,
      );
      for (const p of problems) {
        process.stdout.write(
          `  [${p.code}] ${p.table}.${p.index} — ${p.bytes}B > ${p.limit}B\n` +
          `      ${p.detail}\n` +
          `      ${p.parts.map((x) => `${x.name}:${x.keyType}${x.prefix !== null ? `(${x.prefix})` : ''}=${x.bytes}B`).join(' , ')}\n`,
        );
      }
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ problems: allProblems }, null, 2)}\n`);
  }
  if (allProblems.length > 0) {
    process.stdout.write(`\nFAIL: 索引键长度违规 ${allProblems.length} 处\n`);
    return 1;
  }
  process.stdout.write('\nOK: 索引键长度全部在引擎上限内\n');
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
