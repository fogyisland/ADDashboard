#!/usr/bin/env node
/**
 * R161.5 — MySQL 5.7 兼容守卫
 *
 * 背景 (2026-10-26)
 * -----------------
 * 项目历史把 db.dialect 钉死在 'mssql' (appsettings.json), 所以 **MySQL
 * 分支从来没有在生产跑过**。操作员把库换成 MySQL 5.7.44 之后, 一次就把
 * 整族"只在 MySQL 8.0 才有的语法"缺陷暴露了出来:
 *
 *   · CTE (`WITH x AS (...)`)            — MySQL 8.0+
 *   · window function (`ROW_NUMBER() OVER (...)`) — MySQL 8.0.2+
 *   · `ADD COLUMN IF NOT EXISTS`         — MySQL 8.0.29+
 *   · `CREATE INDEX IF NOT EXISTS`       — MySQL 8.0+
 *
 * 症状不是"建表失败", 而是 **整条 SQL 报 ER_PARSE_ERROR** ⇒ 对应端点
 * 500 (/api/os-baseline、/api/dashboard/summary、/api/lockout-accounts …)。
 * 而且这些缺陷在 MSSQL 上**完全看不出来** —— 同一份代码的 MSSQL 段用 CTE
 * 和窗口函数是合法的, 两段互不干扰 ⇒ 代码审查时看不出问题, 只有真库能验。
 *
 * 与 check-dialect-compat.mjs 的分工
 * ---------------------------------
 *   check-dialect-compat.mjs 管的是"**对方方言**的语法" (MySQL 写法和
 *   MSSQL 写法混用)。本守卫管的是"**同一方言的不同版本**" —— MySQL 5.7
 *   装不下 MySQL 8.0 的语法。两者是不同维度的问题, 所以是两个脚本。
 *
 * 扫描范围 (刻意收窄, 每一项都有理由)
 * -----------------------------------
 *   1) Server/center/src/db/sql.js 的 **mysql 段** (VARIANTS.mysql)。
 *      MSSQL 段用 CTE / 窗口函数是合法的, 所以必须按方言分段扫, 不能整文件扫。
 *      做法: 先用括号配平切出 mysql 变体的源码, 再抽出其中的字符串字面量
 *      (SQL 就住在模板字符串里), 剥掉 JS 注释与 SQL 注释后逐条匹配规则。
 *   2) Server/db/migrations/mysql/*.sql — 初始化向导用的 MySQL 基线。
 *   3) 内置包**声明版本**的 migrations/*.sql (MySQL 方言的那一份)。
 *      历史版本目录 (ad_os_baseline 1.0.3~1.0.8 等) **不在范围内**:
 *      seeder 只处理 BUILTIN_PACKAGES 里声明的那个版本目录
 *      (builtin-packages.js 的 resolveMigrationFiles 拿到的 pkgDir 就是
 *      <dataDir>/<name>/<version>), 历史目录既不会被复制也不会被执行 ——
 *      留着它们只是历史档案。它们里的 `ADD COLUMN IF NOT EXISTS` 是
 *      R161.5 之前的写法, 已经由新版本目录里的整表 CREATE TABLE 取代。
 *   4) Server/center/src/db/sql/*.js 的 30 个**双 dialect 独立模块**
 *      (R161.5 补的漏项)。这些模块各导出 `{ mysql, mssql }` 两份 SQL,
 *      而 sql.js 的 VARIANTS 只注册了其中一部分、且注册的是 `X.mysql`
 *      而不是 `X` 本身 ⇒ checkRuntimeSqlTree 走不到它们 (forestRegistry
 *      的 26 段 SQL 就完全在盲区)。本守卫对每个模块单独扫 MySQL 侧。
 *
 * 用法:
 *   node Server/scripts/audit/check-mysql57-compat.mjs [--json]
 * 退出码: 0 = 通过; 1 = 有 error; 2 = 用法/内部错误
 *
 * 本脚本是 **source-only** 的开发工具 (随交付包发布没有意义 —— 目标机上的
 * 库已经是装好的, 而它的 MySQL 5.7 里不会再生出新的 SQL 模板)。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------
// 每条规则: code / pattern / why / since
//   since —— 该语法从哪个 MySQL 版本开始才有 (写清楚是为了让报错文案能
//             直接告诉操作员"目标库是 5.7, 这条是 8.0 才有的")。
export const MYSQL57_RULES = [
  {
    code: 'MYSQL57-HAS-CTE',
    since: '8.0',
    pattern: /\bWITH\s+[A-Za-z_][A-Za-z0-9_]*\s+AS\s*\(/i,
    why:
      'CTE (WITH <名字> AS (...)) 是 MySQL 8.0 才有的语法。5.7 上整条 SQL 报 ' +
      'ER_PARSE_ERROR。5.7 的替代写法: 把 CTE 内联成 FROM 里的派生表 ' +
      '(INNER JOIN (SELECT ...) alias), 或按分支拆成多条 SQL。',
  },
  {
    code: 'MYSQL57-HAS-WINDOW-FUNCTION',
    since: '8.0.2',
    pattern: /\bOVER\s*\(/i,
    why:
      'window function (ROW_NUMBER() OVER (...) 等) 是 MySQL 8.0.2 才有的语法。' +
      '5.7 上整条 SQL 报 ER_PARSE_ERROR。5.7 的替代写法: "同分区内没有更新的行" ' +
      '(NOT EXISTS + 唯一列做 tiebreaker), 或 "每组一个带 LIMIT 的派生表 UNION ALL"。',
  },
  {
    code: 'MYSQL57-HAS-ADD-COLUMN-IF-NOT-EXISTS',
    since: '8.0.29',
    pattern: /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i,
    why:
      'ALTER TABLE ... ADD COLUMN IF NOT EXISTS 是 MySQL 8.0.29 才有的语法。' +
      '5.7 上报 ER_PARSE_ERROR。5.7 的幂等写法: 用 INFORMATION_SCHEMA.COLUMNS ' +
      '查一次 + PREPARE/EXECUTE 动态执行 (基线里就是这个范式), 或者把列一次性' +
      '给全在建表语句里。',
  },
  {
    code: 'MYSQL57-HAS-CREATE-INDEX-IF-NOT-EXISTS',
    since: '8.0',
    pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i,
    why:
      'CREATE INDEX IF NOT EXISTS 是 MySQL 8.0 才有的语法。5.7 上报 ER_PARSE_ERROR。' +
      '5.7 的幂等写法: 先查 INFORMATION_SCHEMA.STATISTICS, 已存在就跳过。',
  },
  {
    code: 'MYSQL57-HAS-DROP-INDEX-IF-EXISTS',
    since: '8.0',
    pattern: /\bDROP\s+INDEX\s+IF\s+EXISTS\b/i,
    why:
      'DROP INDEX IF EXISTS 是 MySQL 8.0 才有的语法。5.7 上报 ER_PARSE_ERROR。' +
      '5.7 的幂等写法: 先查 INFORMATION_SCHEMA.STATISTICS, 不存在就跳过。',
  },
  {
    code: 'MYSQL57-HAS-RENAME-COLUMN',
    since: '8.0',
    pattern: /\bRENAME\s+COLUMN\b/i,
    why:
      'ALTER TABLE ... RENAME COLUMN 是 MySQL 8.0 才有的语法。5.7 上报 ' +
      'ER_PARSE_ERROR。5.7 的改列名写法: CHANGE <旧名> <新名> <完整列定义>。',
  },
  {
    code: 'MYSQL57-HAS-JSON-TABLE',
    since: '8.0',
    pattern: /\bJSON_TABLE\s*\(/i,
    why:
      'JSON_TABLE() 是 MySQL 8.0 才有的函数。5.7 上报 ER_PARSE_ERROR。' +
      '5.7 没有等价物 —— JSON 只能整体存成文本列, 需要在应用层解析。',
  },
  {
    code: 'MYSQL57-HAS-REGEXP-FUNCTION',
    since: '8.0',
    pattern: /\bREGEXP_(?:LIKE|REPLACE|SUBSTR|INSTR)\s*\(/i,
    why:
      'REGEXP_LIKE / REGEXP_REPLACE / REGEXP_SUBSTR / REGEXP_INSTR 是 MySQL 8.0 ' +
      '才有的函数。5.7 上报 ER_PARSE_ERROR。5.7 的替代写法: 用 REGEXP 运算符 ' +
      '(WHERE col REGEXP \'...\' / WHERE col NOT REGEXP \'...\')。',
  },
  {
    code: 'MYSQL57-HAS-LATERAL',
    since: '8.0.14',
    pattern: /\bLATERAL\b/i,
    why:
      'LATERAL 派生表是 MySQL 8.0.14 才有的语法。5.7 上报 ER_PARSE_ERROR。' +
      '5.7 的替代写法: 把外层引用搬进派生表内部 (相关子查询), 或者把相关条件' +
      '写成 JOIN 条件。',
  },
  {
    code: 'MYSQL57-HAS-SKIP-LOCKED',
    since: '8.0',
    pattern: /\bSKIP\s+LOCKED\b/i,
    why:
      'SELECT ... FOR UPDATE SKIP LOCKED 是 MySQL 8.0 才有的语法。5.7 上报 ' +
      'ER_PARSE_ERROR。5.7 只有 SELECT ... FOR UPDATE (会阻塞到锁释放)。',
  },
  {
    code: 'MYSQL57-HAS-WITH-CUBE',
    since: '8.0',
    pattern: /\bWITH\s+CUBE\b/i,
    why:
      'GROUP BY ... WITH CUBE 是 MySQL 8.0 才有的语法。5.7 上报 ER_PARSE_ERROR。' +
      '5.7 用 GROUP BY ... WITH ROLLUP (注意不是 CUBE)。',
  },
];

// ---------------------------------------------------------------------------
// 词法工具
// ---------------------------------------------------------------------------

/**
 * 剥掉 SQL 注释 (-- 行注释 / /* 块注释 *\/)，字符串字面量内的不算。
 * 与 check-dialect-compat.mjs 的同名函数同义, 但这里单独实现 —— 两个审计
 * 脚本互相 import 会形成耦合 (任一个被删都会连带另一个)。
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

// ---------------------------------------------------------------------------
// 规则执行
// ---------------------------------------------------------------------------

/**
 * 把 SQL 字符串字面量的**内容**清空 (保留引号与换行, 保证行号不变)。
 *
 * 为什么需要: 规则匹配的是**语法关键字**, 不是文本。字符串常量里的
 * "OVER (PARTITION BY)" 是一个普通文本, 不是窗口函数调用。
 * 不清空就会误报 —— 而且这类误报很阴险, 因为它会出现在一条完全正常的
 * SQL 里 (比如某列存的是一段说明文本)。
 *
 * 与 check-dialect-compat.mjs 的 blankSqlLiterals 同义, 但这里独立实现 ——
 * 两个审计脚本互相 import 会形成耦合。
 */
export function blankSqlLiterals(sql) {
  const text = String(sql ?? '');
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (quote !== '`' && text[i] === '\\') {
          // 反斜杠转义: 跳过被转义的那个字符
          out += text[i + 1] === '\n' ? '\n' : ' ';
          if (text[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          if (text[i + 1] === quote) { out += '  '; i += 2; continue; } // 双写转义
          out += quote;
          i += 1;
          break;
        }
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 对一段 SQL 文本跑 5.7 规则。
 * @param {string} text  SQL 文本 (注释与字符串字面量会先被中和)
 * @param {string} label 定位用的标签 (文件名 / `sql.js:mysql 段:lockout.trend24h`)
 */
export function checkMysql57Sql(text, label) {
  const problems = [];
  // 顺序: 先剥 SQL 注释 (保证字符串里的 `--` 不被当注释), 再清空字符串
  // 字面量 (保证字面量里的关键字不被当语法)。
  const source = blankSqlLiterals(stripSqlComments(String(text ?? '')));
  for (const rule of MYSQL57_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    const m = re.exec(source);
    if (!m) continue;
    const line = source.slice(0, m.index).split('\n').length;
    problems.push({
      code: rule.code,
      severity: 'error',
      detail:
        `${label}: 命中 ${rule.code} —— ${rule.why} ` +
        `(该语法自 MySQL ${rule.since} 起才有; 目标库是 MySQL 5.7。命中位置: 第 ${line} 行)`,
      excerpt: source.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ').trim(),
      line,
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// JS 源码切分 (为了按方言分段扫 sql.js)
// ---------------------------------------------------------------------------

/**
 * 切出 `VARIANTS.<variantName>` 那一段的源码。
 *
 * 做法: 找到 `  <name>: {` 这个标记, 然后**括号配平**走到配对的 `}`。
 * 配平时跳过字符串字面量 (模板字符串里的 `{}` 不算括号, 否则 SQL 里的
 * 花括号会让配平跑偏)。
 *
 * 找不到标记 ⇒ 返回 null (调用方必须当成硬错误, 不能当成"没问题" ——
 * 静默通过的守卫等于没有守卫)。
 */
export function extractDialectVariant(source, variantName) {
  const text = String(source ?? '');
  const marker = new RegExp(`^  ${variantName}: \\{`, 'm');
  const m = marker.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length; // 指向 '{' 之后
  let depth = 1;
  let i = start;
  const n = text.length;
  while (i < n && depth > 0) {
    const ch = text[i];
    if (ch === '`') {
      i = skipTemplateLiteral(text, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuotedLiteral(text, i, ch);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null; // 括号没配平 ⇒ 源文件被改坏了, 不能当"通过"
  return text.slice(start, i - 1);
}

/** 跳过一段模板字符串, 返回结束位置 (指向收尾的 ` 之后)。 */
function skipTemplateLiteral(text, from) {
  const n = text.length;
  let i = from + 1;
  while (i < n) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') return i + 1;
    if (text[i] === '$' && text[i + 1] === '{') {
      // ${...} 里可能有嵌套的模板字符串 —— 用一个深度计数找到配对的 }。
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '`') { i = skipTemplateLiteral(text, i); continue; }
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return n;
}

/** 跳过一段单/双引号字符串, 返回结束位置。 */
function skipQuotedLiteral(text, from, quote) {
  const n = text.length;
  let i = from + 1;
  while (i < n) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return n;
}

/**
 * 抽出一段 JS 源码里的所有字符串字面量 (单引号 / 双引号 / 模板字符串)。
 *
 * JS 注释会被跳过 (注释里为了对照而写的 "WITH x AS (...)" 不该触发规则);
 * 模板字符串里的内容原样保留 —— **SQL 就住在那里**, 而模板字符串内部的
 * SQL 注释 (`-- ...`) 交给 stripSqlComments 处理。
 *
 * 模板字符串里的 ${...} 插值被替换成占位符 —— 插值是 JS 表达式, 不是 SQL。
 */
export function extractStringLiterals(jsSource) {
  const text = String(jsSource ?? '');
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '`') {
      const start = i;
      const end = skipTemplateLiteral(text, i);
      out.push({ kind: 'template', content: text.slice(start + 1, Math.max(start + 1, end - 1)) });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuotedLiteral(text, i, ch);
      out.push({ kind: 'string', content: text.slice(i + 1, Math.max(i + 1, end - 1)) });
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * 扫 sql.js 的 mysql 变体。
 *
 * 走**两条腿**:
 *   ① 静态腿: 把 mysql 变体的源码切出来, 抽字符串字面量, 逐条扫。
 *      覆盖到所有 SQL 模板 (包括那些参数校验很严、探针调不动的函数)。
 *   ② 运行时腿: 直接 import 中心模块, 把 buildSql('mysql') 的每个 SQL 串
 *      取出来再扫一遍。运行时腿的价值是"扫的就是真的要发给库的那段 SQL" ——
 *      静态腿扫的是源码里的字面量, 两者互为交叉验证。
 *
 * 运行时腿探针调不动的函数**不算失败** —— 静态腿已经覆盖了它们, 在这里
 * 报 error 只会制造永远消不掉的假阳性。
 */
export function checkSqlJsMysqlVariant(sqlJsSource, { sqlTree = null, label = 'sql.js:mysql 段' } = {}) {
  const problems = [];
  const notes = [];

  // --- ① 静态腿 ---
  const variant = extractDialectVariant(sqlJsSource, 'mysql');
  if (variant === null) {
    problems.push({
      code: 'MYSQL57-VARIANT-NOT-FOUND',
      severity: 'error',
      detail:
        `${label}: 在 sql.js 里找不到 "  mysql: {" 变体标记 (或括号没配平) —— ` +
        '守卫无法定位 mysql 段, 不能当成"没问题"。请检查 sql.js 的结构是否被改坏。',
      excerpt: '',
    });
  } else {
    const literals = extractStringLiterals(variant);
    for (const literal of literals) {
      const sql = stripSqlComments(literal.content);
      if (!/\b(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|INSERT)\b/i.test(sql)) {
        continue; // 不是 SQL (比如一个普通的英文提示串) —— 跳过
      }
      problems.push(...checkMysql57Sql(sql, `${label}:${literal.kind}`));
    }
  }

  // --- ② 运行时腿 ---
  if (sqlTree) {
    const runtime = checkRuntimeSqlTree(sqlTree, label);
    problems.push(...runtime.problems);
    notes.push(...runtime.notes);
  }

  return { problems, notes };
}

/**
 * 运行时腿: 遍历 buildSql('mysql') 产出的 SQL 树, 把每一段 SQL 扫一遍。
 *
 * 树是两层: domain → query。query 可以是字符串, 也可以是"返回 {sql, params}"
 * 的函数。函数需要参数, 所以用一组探针参数去试; 一个都试不动的函数
 * (参数校验太严) 记成 note, 不算 error —— 静态腿已经覆盖了它。
 */
export function checkRuntimeSqlTree(sqlTree, label = 'buildSql(mysql)') {
  const problems = [];
  const notes = [];
  const probes = buildProbes();

  for (const [domain, queries] of Object.entries(sqlTree || {})) {
    if (!queries || typeof queries !== 'object') continue;
    for (const [name, query] of Object.entries(queries)) {
      const where = `${label}:${domain}.${name}`;
      if (typeof query === 'string') {
        problems.push(...checkMysql57Sql(stripSqlComments(query), where));
        continue;
      }
      if (typeof query !== 'function') continue; // 子命名空间 (如 forestRegistry.forest.*)
      // **所有**能调通的探针都跑一遍, 而不是第一个就停 ——
      // 一个 SQL builder 往往有多个分支 (按 dc 过滤 / 不按 dc 过滤),
      // 只扫第一个分支会漏掉另一个分支里的 8.0 语法。
      const produced = new Set();
      for (const probe of probes) {
        try {
          const result = probe.length === 0 ? query() : query(...probe);
          // 两种返回形态都要接:
          //   ① { sql, params } —— 主流形态
          //   ② 裸 SQL 字符串 —— 也有不少 (如 replication.errorsRecent)
          if (typeof result === 'string') produced.add(result);
          else if (result && typeof result.sql === 'string') produced.add(result.sql);
        } catch {
          // 探针不匹配 ⇒ 换下一个探针
        }
      }
      if (produced.size === 0) {
        notes.push(`${where}: 没有一组探针参数能调出 SQL —— 静态腿覆盖它`);
        continue;
      }
      let branch = 0;
      for (const sql of produced) {
        branch += 1;
        problems.push(...checkMysql57Sql(stripSqlComments(sql), `${where}#分支${branch}`));
      }
    }
  }

  return { problems, notes };
}

/** 运行时腿用的探针参数组合。 */
function buildProbes() {
  const rich = {
    topN: 5, limit: 200, days: 7, sinceHours: 24, windowHours: 24, windowDays: 7,
    hours: 24, bucketMinutes: 5, minStations: 1, dc: null, dcName: null,
    workstation: null, search: null, name: 'x', agentId: 'a1', agentIds: ['a1'],
    packageName: 'p1', names: ['p1'], status: 'ok', key: 'k', value: 'v',
    page: 1, pageSize: 20, kind: 'k', since: '2026-01-01 00:00:00',
    periodStart: '2026-01-01 00:00:00', periodEnd: '2026-01-02 00:00:00',
    cutoffIso: '2026-01-01 00:00:00', groupNames: [], schemaName: 'pkg_x',
    eventIds: [1], channel: 'c', metric: 'm', target: 't', ids: [1],
    includeSystem: false, includeMachine: false, level: 'error', eventId: 1,
  };
  const richWithDc = { ...rich, dc: 'DC1', dcName: 'DC1', workstation: 'WS1' };
  const metricStore = { schemaName: 'pkg_x', columns: ['metric_value'] };
  return [
    [],
    [{}],
    [rich],
    [richWithDc],
    [metricStore],
    [{ ...metricStore, columns: ['a', 'b'] }],
    [['p1', 'p2']],
    [['p1', 'p2'], 10, '2026-01-01 00:00:00'],
    [10, '2026-01-01 00:00:00'],
    [null],
    ['DC1'],
    [24],
    ['a1'],
    ['?'],
    ['?,?'],
    [true],
    [{ ...rich, names: ['p1', 'p2'], agentIds: ['a1', 'a2'] }],
    [rich, rich],
  ];
}

// ---------------------------------------------------------------------------
// .sql 文件
// ---------------------------------------------------------------------------

/** 扫一个 .sql 文件。 */
export function checkSqlFile(filePath, repoRoot) {
  const rel = relative(repoRoot, filePath).split(sep).join('/');
  const raw = readFileSync(filePath, 'utf8');
  return checkMysql57Sql(stripSqlComments(raw), rel);
}

/**
 * 扫 MySQL 基线 + 内置包声明版本的迁移。
 *
 * 分级:
 *   · **声明版本目录** (BUILTIN_PACKAGES 里写的那个 version) —— error。
 *     这是唯一会被 seeder 复制、会被 ddl-apply 执行的目录 ⇒ 5.7 上跑不通
 *     就是真的 500。
 *   · **历史版本目录** (同一个包的其他 version) —— warning。
 *     这些目录是惰性的: seeder 只处理声明版本 (builtin-packages.js 的
 *     resolveMigrationFiles 拿到的 pkgDir 就是 <dataDir>/<name>/<version>),
 *     历史目录既不会被复制也不会被执行 ⇒ 现在不会炸。
 *     但它们是**地雷**: 哪天把 BUILTIN_PACKAGES 的版本号改回去 (降级
 *     修复 / 补发历史包), 5.7 上立刻 ER_PARSE_ERROR。
 *     所以扫出来报 warning 而不是静默排除 —— 排除等于假装它不存在。
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {Array<{name:string, version:string}>} options.builtins
 * @param {string} options.packagesRoot  内置包源目录 (center/data/packages)
 */
export function checkMysqlSqlFiles({ repoRoot, builtins, packagesRoot }) {
  const problems = [];
  const declared = new Map((builtins || []).map((p) => [p.name, p.version]));

  // --- 基线 ---
  const baselineDir = join(repoRoot, 'Server', 'db', 'migrations', 'mysql');
  for (const file of listSqlFiles(baselineDir)) {
    problems.push(...checkSqlFile(file, repoRoot));
  }

  // --- 内置包: 声明版本 (error) + 历史版本 (warning) ---
  for (const pkg of builtins || []) {
    const pkgDir = join(packagesRoot, pkg.name);
    if (!existsSync(pkgDir)) continue;
    const versions = readdirSync(pkgDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const version of versions) {
      const isDeclared = declared.get(pkg.name) === version;
      const migrationsDir = join(pkgDir, version, 'migrations');
      if (!existsSync(migrationsDir)) continue;
      for (const file of listSqlFiles(migrationsDir)) {
        const found = checkSqlFile(file, repoRoot);
        if (isDeclared) {
          problems.push(...found);
          continue;
        }
        for (const p of found) {
          p.severity = 'warning';
          p.detail =
            `${p.detail} —— 附注: 这是**历史版本目录** ${pkg.name}/${version}, ` +
            '当前不会被 seeder 复制、也不会被执行 (只有声明版本会), 所以现在不炸; ' +
            '但把 BUILTIN_PACKAGES 的版本号改回它就会在 5.7 上 ER_PARSE_ERROR。' +
            '处置: 改用整表 CREATE TABLE 或 INFORMATION_SCHEMA 守卫范式重写该迁移。';
          problems.push(p);
        }
      }
    }
  }

  return problems;
}

/** 列出一个目录下的 .sql 文件 (不递归)。 */
function listSqlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isFile());
}

// ---------------------------------------------------------------------------
// db/sql/*.js 独立模块 (双 dialect 模块)
// ---------------------------------------------------------------------------
//
// 为什么必须单独扫 (R161.5 的守卫漏项)
// ------------------------------------
// sql.js 的 VARIANTS.mysql 只注册了**一部分**模块, 而且注册的是
// `X.mysql` 而不是 `X` 本身:
//
//     memberServers: memberServers.mysql,      ← 注册的是 mysql 侧
//     osBaselineTimeseries: osBaselineTimeseries,  ← 注册的是整个对象
//     forestRegistry,                              ← 注册的是整个对象
//
// checkRuntimeSqlTree 只走**两层** (domain → query), 遇到
// `{ mysql, mssql }` 这种"query 是个对象"的情形会直接 continue ⇒
//   · forestRegistry 的 26 段 SQL **完全没被扫到** (它注册的是整个对象,
//     而它的每条 query 又都是 { mysql, mssql } 结构);
//   · osBaselineTimeseries 同理 (它的 mysql 侧本身还是个函数)。
// 而这些模块的 SQL 文本**不在 sql.js 里** ⇒ sql.js 的静态腿也扫不到。
// ⇒ 30 个模块整体处于守卫盲区。本节把盲区补上。
//
// 两条腿
// ------
//   ① 静态腿 —— 源码里**确定是 MySQL 侧**的字符串字面量:
//      · `mysql: { ... }` 变体块 (键名约定 ⇒ 块内必然是 MySQL 侧);
//      · `const <NAME>_MYSQL = ...` (命名约定 ⇒ 必然是 MySQL 侧,
//        对照 ..._MSSQL)。
//      两条约定都**不可能**命中 MSSQL 侧 ⇒ 零误报。
//   ② 运行时腿 —— 真的 import 模块, 遍历导出树, 凡是挂在 `mysql` 键下的
//      字符串/函数都算 MySQL 侧。这条腿能覆盖静态腿切不到的形态
//      (比如 `mysql: ({...}) => \`...\`` 这种函数型变体)。

/** 判断一个字符串字面量"看起来像不像 SQL" (静态腿过滤用)。 */
const SQL_KEYWORD_RE = /\b(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|MERGE|REPLACE|TRUNCATE)\b/i;

/**
 * 切出源码里所有 `mysql: {` 变体块 (缩进不限, 个数不限)。
 *
 * 与 extractDialectVariant 的区别:
 *   · extractDialectVariant 找**第一个** `  <name>: {` (固定 2 空格缩进),
 *     服务 sql.js 那种"一个文件两大段"的结构;
 *   · 本函数找**所有** `mysql: {` (任意缩进), 服务 db/sql/*.js 这种
 *     "一个文件 0~N 个 mysql 段"的结构 (license-email-outbox.js 就有两个:
 *     licenseEmailOutbox.mysql + licenseExpiryDedup.mysql)。
 *
 * 返回 null = 括号没配平 ⇒ 源文件被改坏 ⇒ 调用方必须当硬错误,
 * 不能当成"没问题" (静默通过的守卫等于没有守卫)。
 */
export function extractMysqlVariantBlocks(source) {
  const text = String(source ?? '');
  const blocks = [];
  const marker = /^[ \t]*mysql[ \t]*:[ \t]*\{/gm;
  let m;
  while ((m = marker.exec(text)) !== null) {
    const openIdx = m.index + m[0].length - 1;   // 指向 '{'
    const n = text.length;
    let depth = 1;
    let i = openIdx + 1;
    while (i < n && depth > 0) {
      const ch = text[i];
      if (ch === '`') { i = skipTemplateLiteral(text, i); continue; }
      if (ch === "'" || ch === '"') { i = skipQuotedLiteral(text, i, ch); continue; }
      if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
      if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    if (depth !== 0) return null;                 // 配平失败 ⇒ 硬错误
    blocks.push(text.slice(openIdx + 1, i - 1));
    marker.lastIndex = i;                        // 跳过块内容, 避免嵌套重复
  }
  return blocks;
}

/**
 * 切出源码里所有 `const <NAME>_MYSQL = <初始化表达式>` 的初始化表达式。
 *
 * 命名约定 = MySQL 侧 (对照同名的 ..._MSSQL)。这是本项目里既有的、
 * 贯穿全部 30 个模块的约定 (forest-registry.js / metric-store.js /
 * orphan-schemas.js / package-*.js 都是这个写法)。
 */
export function extractMysqlNamedConsts(source) {
  const text = String(source ?? '');
  const out = [];
  const marker = /^[ \t]*(?:export[ \t]+)?const[ \t]+([A-Za-z0-9_]*_MYSQL)[ \t]*=/gm;
  let m;
  while ((m = marker.exec(text)) !== null) {
    const initStart = m.index + m[0].length;
    const initEnd = findStatementEnd(text, initStart);
    out.push({ name: m[1], init: text.slice(initStart, initEnd) });
    marker.lastIndex = initEnd;
  }
  return out;
}

/**
 * 从 `from` 处扫到语句结束 (分号) 为止, 返回结束下标。
 * 模板字符串/引号里的分号不算语句结束 —— 模板字符串里常带分号。
 */
function findStatementEnd(text, from) {
  const n = text.length;
  let i = from;
  let depth = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '`') { i = skipTemplateLiteral(text, i); continue; }
    if (ch === "'" || ch === '"') { i = skipQuotedLiteral(text, i, ch); continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; i += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; i += 1; continue; }
    if (ch === ';' && depth <= 0) return i;
    i += 1;
  }
  return n;
}

/**
 * 遍历一个模块的导出树, 收集挂在 `mysql` 键下的 SQL 候选。
 *
 * 覆盖项目里 4 种实际形态:
 *   ① { mysql: { a: 'SQL', b: fn }, mssql: {...} }        → X.mysql 里的每项
 *   ② { a: { mysql: 'SQL', mssql: 'SQL' }, b: {...} }      → X.a.mysql
 *   ③ { mysql: ({...}) => `SQL` }                          → X.mysql 本身是函数
 *   ④ { a: { mysql: fn, mssql: fn } }                     → X.a.mysql 是函数
 *
 * `mssql` 键一律跳过 —— MSSQL 侧的语法本守卫不管 (CTE/窗口函数在 MSSQL 上合法)。
 *
 * @param {*} node     当前节点 (导出对象 / 子对象)
 * @param {string} path 定位路径 (如 "systemAlerts.mysql.listSince")
 * @param {Array}  out  收集桶
 */
export function collectMysqlSqlCandidates(node, path = '', out = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'mssql') continue;                       // MSSQL 侧不管
    if (key === 'mysql') {
      collectSqlLeaves(value, path ? `${path}.mysql` : 'mysql', out);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectMysqlSqlCandidates(value, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

/** 收集 mysql 键下的叶子 (字符串 = SQL, 函数 = SQL builder)。 */
function collectSqlLeaves(value, path, out) {
  if (typeof value === 'string') { out.push({ path, kind: 'string', value }); return; }
  if (typeof value === 'function') { out.push({ path, kind: 'function', value }); return; }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'mssql') continue;
      collectSqlLeaves(child, `${path}.${key}`, out);
    }
  }
}

/**
 * 扫一个 db/sql/*.js 模块的 MySQL 侧。
 *
 * @param {object} options
 * @param {string} options.source       模块源码 (静态腿)
 * @param {object} options.moduleExports 模块导出 (运行时腿; null = 只跑静态腿)
 * @param {string} options.label        定位标签 (一般是相对仓库根的路径)
 */
export function checkSqlModuleMysqlVariant({ source, moduleExports = null, label = 'db/sql 模块' }) {
  const problems = [];
  const notes = [];
  // 覆盖度统计 —— 用来证明"这个模块确实被扫到了, 不是扫了 0 条"。
  const stats = { staticLiterals: 0, runtimeCandidates: 0 };

  // --- ① 静态腿 ---
  const blocks = extractMysqlVariantBlocks(source);
  if (blocks === null) {
    problems.push({
      code: 'MYSQL57-MODULE-VARIANT-NOT-FOUND',
      severity: 'error',
      detail:
        `${label}: mysql 变体块的括号没配平 —— 守卫无法定位 MySQL 侧源码, ` +
        '不能当成"没问题"。请检查该文件是否被改坏。',
      excerpt: '',
    });
  } else {
    blocks.forEach((block, index) => {
      for (const literal of extractStringLiterals(block)) {
        const sql = stripSqlComments(literal.content);
        if (!SQL_KEYWORD_RE.test(sql)) continue;   // 不是 SQL (普通字符串)
        stats.staticLiterals += 1;
        problems.push(...checkMysql57Sql(sql, `${label}:mysql 段#${index + 1}:${literal.kind}`));
      }
    });
  }

  for (const named of extractMysqlNamedConsts(source)) {
    for (const literal of extractStringLiterals(named.init)) {
      const sql = stripSqlComments(literal.content);
      if (!SQL_KEYWORD_RE.test(sql)) continue;
      stats.staticLiterals += 1;
      problems.push(...checkMysql57Sql(sql, `${label}:${named.name}`));
    }
  }

  // --- ② 运行时腿 ---
  if (moduleExports) {
    const candidates = collectMysqlSqlCandidates(moduleExports, label);
    stats.runtimeCandidates = candidates.length;
    if (candidates.length === 0) {
      notes.push(`${label}: 导出树里没有 mysql 侧的 SQL —— 该模块可能是纯常量/纯 helper, 静态腿已覆盖`);
    }
    for (const candidate of candidates) {
      if (candidate.kind === 'string') {
        problems.push(...checkMysql57Sql(stripSqlComments(candidate.value), candidate.path));
        continue;
      }
      // 函数: 所有能调通的探针都跑一遍 (一个 builder 往往有多分支,
      // 只扫第一个分支会漏掉另一个分支里的 8.0 语法)。
      const produced = new Set();
      for (const probe of buildProbes()) {
        try {
          const result = probe.length === 0 ? candidate.value() : candidate.value(...probe);
          if (typeof result === 'string') produced.add(result);
          else if (result && typeof result.sql === 'string') produced.add(result.sql);
        } catch {
          // 探针不匹配 ⇒ 换下一个探针
        }
      }
      if (produced.size === 0) {
        notes.push(`${candidate.path}: 没有一组探针参数能调出 SQL —— 静态腿覆盖它`);
        continue;
      }
      let branch = 0;
      for (const sql of produced) {
        branch += 1;
        problems.push(...checkMysql57Sql(stripSqlComments(sql), `${candidate.path}#分支${branch}`));
      }
    }
  }

  return { problems, notes, stats };
}

/** 列出 db/sql 目录下的模块文件 (按文件名排序, 保证输出稳定)。 */
export function listSqlModuleFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isFile())
    .sort();
}

/**
 * 扫全部 db/sql/*.js 模块 (双 dialect 模块)。
 *
 * 逐个 import 走运行时腿 —— import 失败不致命 (静态腿照样跑), 只记 note。
 */
export async function checkSqlModules({ sqlModuleDir, repoRoot }) {
  const problems = [];
  const notes = [];
  // scanned: 每个模块的覆盖度统计 —— 用来证明"确实扫到了", 防静默通过。
  const scanned = [];
  const files = listSqlModuleFiles(sqlModuleDir);
  if (files.length === 0) {
    problems.push({
      code: 'MYSQL57-MODULE-DIR-MISSING',
      severity: 'error',
      detail:
        `${relative(repoRoot, sqlModuleDir).split(sep).join('/')}: 目录不存在或没有 .js 模块 —— ` +
        '守卫扫不到 db/sql/*.js ⇒ 30 个双 dialect 模块处于盲区。不能当成"没问题"。',
      excerpt: '',
    });
    return { problems, notes, scanned };
  }
  for (const file of files) {
    const rel = relative(repoRoot, file).split(sep).join('/');
    const source = readFileSync(file, 'utf8');
    let moduleExports = null;
    try {
      moduleExports = await import(new URL(`file:///${file.replace(/\\/g, '/')}`).href);
    } catch (err) {
      notes.push(`${rel}: 无法 import (${err.message}) —— 只跑了静态腿`);
    }
    const result = checkSqlModuleMysqlVariant({ source, moduleExports, label: rel });
    problems.push(...result.problems);
    notes.push(...result.notes);
    scanned.push({ path: rel, ...result.stats });
  }
  return { problems, notes, scanned };
}

/**
 * 去重: 同一处缺陷可能被两条腿各报一次 (sql.js 的运行时树里注册了
 * `X.mysql`, 模块扫描又扫了一遍 X) ⇒ 按 (code, 归一化 excerpt) 去重,
 * 只留第一条 (模块扫描先跑 ⇒ 留的是更精确的模块定位)。
 */
export function dedupeProblems(problems) {
  const byKey = new Map();
  for (const problem of problems) {
    const key = `${problem.code}|${String(problem.excerpt || '').replace(/\s+/g, ' ').trim()}`;
    const hit = byKey.get(key);
    if (hit) {
      hit.duplicateCount = (hit.duplicateCount || 0) + 1;
      continue;
    }
    byKey.set(key, problem);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
// 本脚本位于 <项目根>/Server/scripts/audit/ ⇒ 上两级是 Server, 上三级是项目根。
const SERVER_ROOT = resolve(HERE, '..', '..');
const PROJECT_ROOT = resolve(SERVER_ROOT, '..');

async function loadBuiltins() {
  const modulePath = join(SERVER_ROOT, 'center', 'src', 'services', 'builtin-packages.js');
  const mod = await import(new URL(`file:///${modulePath.replace(/\\/g, '/')}`).href);
  return mod.BUILTIN_PACKAGES;
}

async function main(argv) {
  const json = argv.includes('--json');

  const sqlJsPath = join(SERVER_ROOT, 'center', 'src', 'db', 'sql.js');
  if (!existsSync(sqlJsPath)) {
    process.stderr.write(`[FAIL] 找不到 sql.js: ${sqlJsPath}\n`);
    return 2;
  }
  const sqlJsSource = readFileSync(sqlJsPath, 'utf8');

  // 运行时腿: 直接 import 中心模块, 拿 buildSql('mysql')。
  let sqlTree = null;
  try {
    const mod = await import(new URL(`file:///${sqlJsPath.replace(/\\/g, '/')}`).href);
    sqlTree = mod.buildSql('mysql');
  } catch (err) {
    process.stderr.write(`[FAIL] 无法 import sql.js 取 buildSql('mysql'): ${err.message}\n`);
    return 2;
  }

  const problems = [];
  const notes = [];

  // --- ① db/sql/*.js 独立模块 (30 个双 dialect 模块) ---
  // 先跑模块扫描: 它给的定位比 sql.js 运行时树更精确, 去重时优先保留。
  const moduleResult = await checkSqlModules({
    sqlModuleDir: join(SERVER_ROOT, 'center', 'src', 'db', 'sql'),
    repoRoot: PROJECT_ROOT,
  });
  problems.push(...moduleResult.problems);
  notes.push(...moduleResult.notes);
  const moduleStats = {
    moduleCount: moduleResult.scanned.length,
    staticLiterals: moduleResult.scanned.reduce((sum, m) => sum + m.staticLiterals, 0),
    runtimeCandidates: moduleResult.scanned.reduce((sum, m) => sum + m.runtimeCandidates, 0),
  };

  // --- ② sql.js 的 mysql 段 (静态腿 + 运行时腿) ---
  const sqlJsResult = checkSqlJsMysqlVariant(sqlJsSource, {
    sqlTree,
    label: 'Server/center/src/db/sql.js:mysql 段'
  });
  problems.push(...sqlJsResult.problems);
  notes.push(...sqlJsResult.notes);

  const builtins = await loadBuiltins();
  problems.push(...checkMysqlSqlFiles({
    repoRoot: PROJECT_ROOT,
    builtins,
    packagesRoot: join(SERVER_ROOT, 'center', 'data', 'packages'),
  }));

  const deduped = dedupeProblems(problems);
  const errors = deduped.filter((p) => p.severity === 'error');
  const warnings = deduped.filter((p) => p.severity === 'warning');

  if (json) {
    process.stdout.write(`${JSON.stringify({
      errorCount: errors.length,
      warningCount: warnings.length,
      problems: deduped,
      notes,
      moduleScan: { ...moduleStats, modules: moduleResult.scanned }
    }, null, 2)}\n`);
  } else {
    console.log('=== mysql 5.7 compatibility check ===');
    console.log(`project root: ${PROJECT_ROOT}`);
    console.log(`内置包 (声明版本): ${builtins.length}`);
    console.log(
      `db/sql/*.js 模块: ${moduleStats.moduleCount} 个 ` +
      `(静态腿 ${moduleStats.staticLiterals} 条 SQL / 运行时腿 ${moduleStats.runtimeCandidates} 个候选)`
    );
    for (const p of errors) {
      console.log(`  [ERROR] ${p.code}`);
      console.log(`      ${p.detail}`);
      if (p.excerpt) console.log(`      > ${p.excerpt}`);
      if (p.duplicateCount) console.log(`      (另有 ${p.duplicateCount} 处相同命中已合并)`);
    }
    for (const p of warnings) {
      console.log(`  [WARN]  ${p.code}`);
      console.log(`      ${p.detail}`);
      if (p.excerpt) console.log(`      > ${p.excerpt}`);
      if (p.duplicateCount) console.log(`      (另有 ${p.duplicateCount} 处相同命中已合并)`);
    }
    // note 只是"运行时腿没调通, 靠静态腿兜住"的记录 —— 量大且不 actionable,
    // 只报数量 + 前几条, 完整清单走 --json。
    if (notes.length > 0) {
      console.log(`  note  ${notes.length} 个 SQL builder 未被运行时探针调通 (已由静态腿覆盖)`);
      for (const n of notes.slice(0, 5)) console.log(`        - ${n}`);
      if (notes.length > 5) console.log(`        ... 其余 ${notes.length - 5} 条见 --json`);
    }
    console.log(`--- ${errors.length} error(s), ${warnings.length} warning(s)`);
  }

  return errors.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`[FATAL] ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(2);
  });
}
