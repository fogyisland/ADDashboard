#!/usr/bin/env node
// R161.2 — 基线 SQL 外键顺序 / 参照完整性审计
//
// WHY
// ---
// 全新库初始化时, `center/src/init/schema-applier.js` 的 applyAll() 会把基线文件
// 拆成语句后**按文件顺序逐条** db.execute() 出去。MySQL 的 InnoDB 要求: 建带
// FOREIGN KEY 的表时, 被引用表必须**已经存在** —— 否则 errno 150, 驱动抛出的
// 文案就是裸的 "Cannot add foreign key constraint" (MySQL 8.0.16+ 的类型不兼容
// 是 errno 1824, 文案完全不同, 所以裸文案 = 150 = 被引用表还不存在)。
//
// R110.A 把新表 ad_dc_overview 插到了 ad_sites **前面** (ad_sites 在第 135 行,
// ad_dc_overview 在第 55 行) ⇒ 全新 MySQL 装机当场炸, 而**已初始化的库完全不受
// 影响** (bootstrapMigrations 见到 schema_migrations 表存在就短路)。这就是
// "只有新装会炸、老库都好好的" 的经典形状 —— 没有任何现有检查会拦住它。
//
// 两种方言的判据**现在完全一致**: 参照表必须建在**更早的语句**。
//
// ★ R161.3 修正 (2026-10-25): 之前 MSSQL 用的是**批次级**判据
//   (ref.batchIndex > fk.batchIndex), 注释的理由是"GO 是批次分隔符,
//   同批次内允许 FK 前向引用 (批次末统一解析)"。**这个前提是错的**:
//   生产执行模型不是"按批次发一个多语句请求", 而是
//   center/src/init/schema-applier.js 的 applyFile():
//
//       for (const s of stmts) { await db.execute(s, []); }   // ← 逐条
//
//   每条语句单独发出去, `GO` 只是 splitter 的 flush 标记, **不是可延后解析
//   的批次边界**。所以"同批次内前向引用会被批次末统一解析"不成立 —— 逐条
//   执行时, ALTER TABLE ... ADD FOREIGN KEY 参照一张还没建的表, 现场就是
//   Msg 1750 ("is not a referenced table")。
//   ⇒ MSSQL 必须与 MySQL 一样按**语句级**判: ref.stmtIndex > fk.stmtIndex。
//
// ★ 本检查器**直接复用生产代码的 splitSqlStatements** (center/src/init/
// schema-applier.js), 而不是自己重写一套 SQL 词法分析。这样检查的就是
// **真正会被执行的那串语句** —— 顺带覆盖了一类隐蔽故障: 语句被 `--` 注释
// 粘掉 (有损编码往返吃掉了换行 ⇒ CREATE TABLE 落到注释行尾 ⇒ 该表从未被
// 创建 ⇒ 引用它的外键全部失败)。
//
// 用法: node Server/scripts/audit/check-fk-order.mjs [file ...]
//       node Server/scripts/audit/check-fk-order.mjs --json
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

// R161.2 — 方言拆分 (R158.51, 2026-10-22) 之后, 顶层这份是**残留物**:
//   - 它是 R158.51 之前的 MySQL 旧快照 (54 表, 而 MySQL 方言文件已 75 表)
//   - 它经历过一次有损编码往返, 中文注释变乱码, 并**吃掉了换行符** ⇒ 第 776 行的
//     `CREATE TABLE IF NOT EXISTS ad_forest (` 粘在 `--` 注释行尾, 该表从未被创建
//     ⇒ 3 个引用 ad_forest 的外键必然失败
//   - 它只有 MySQL 语法 —— 一旦被当成 MSSQL 的回退, T-SQL 直接语法错
// 而 schema-applier.js 的 resolveSqlPath() 恰好会回退到它 ⇒ 一旦
// db/migrations/<dialect>/ 缺失, 应用会**静默装出一棵残缺库**, 故障现场
// 会出现在完全不相干的地方。这个"安全网"是张废网, 删掉并让解析函数大声报错。
const LEGACY_RELIC = 'Server/db/migrations/1.0.0-baseline.sql';

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** 归一化标识符: 去掉 ` / [ ] 限定符, 只留最后一段 (schema.table -> table)。 */
function normalizeIdent(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/^[`[]/, '')
    .replace(/[`\]]$/, '')
    .split('.')
    .pop()
    .replace(/^[`[]/, '')
    .replace(/[`\]]$/, '')
    .trim();
}

/** 逗号分隔的列名列表 -> 干净的列名数组 (剥掉 ASC/DESC 排序修饰)。 */
function parseColumnList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^[`[]/, '')
        .replace(/[`\]]$/, '')
        .replace(/\s+(ASC|DESC)\b/gi, '')
        .trim(),
    )
    .filter(Boolean);
}

/** 找到 firstIndex 之后的第一对括号, 返回括号内文本 (找不到返回 null)。 */
function readParenGroup(text, fromIndex) {
  const open = text.indexOf('(', fromIndex);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')') {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, k), end: k + 1 };
    }
  }
  return null;
}

const IDENT = '(?:`[A-Za-z0-9_$]+`|\\[[A-Za-z0-9_$]+\\]|[A-Za-z0-9_$]+)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;

// 内联外键 (CONSTRAINT 可选)
const INLINE_FK_RE = new RegExp(
  `(?:CONSTRAINT\\s+(${IDENT})\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${QUALIFIED})\\s*\\(([^)]*)\\)`,
  'gi',
);

// ALTER TABLE ... ADD ... FOREIGN KEY —— 外键延后添加 (位置 = 这条语句)
const ALTER_FK_RE = new RegExp(
  `ALTER\\s+TABLE\\s+(${QUALIFIED})\\s+ADD\\s+(?:CONSTRAINT\\s+(${IDENT})\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${QUALIFIED})\\s*\\(([^)]*)\\)`,
  'gi',
);

// ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY / UNIQUE
const ALTER_KEY_RE = new RegExp(
  `ALTER\\s+TABLE\\s+(${QUALIFIED})\\s+ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?(PRIMARY\\s+KEY|UNIQUE)\\s*\\(([^)]*)\\)`,
  'gi',
);

// 独立 CREATE [UNIQUE] INDEX ... ON t (cols)
const CREATE_INDEX_RE = new RegExp(
  `CREATE\\s+(?:UNIQUE\\s+)?(?:CLUSTERED\\s+|NONCLUSTERED\\s+)?INDEX\\s+${IDENT}\\s+ON\\s+(${QUALIFIED})\\s*\\(([^)]*)\\)`,
  'gi',
);

// 建表语句
const CREATE_TABLE_RE = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED})`, 'gi');

// 索引关键字 (排除 FOREIGN KEY —— 外键不是索引)
const INDEX_KEYWORD_RE = /\b(PRIMARY\s+KEY|UNIQUE\s+(?:KEY|INDEX)|UNIQUE|CREATE\s+(?:UNIQUE\s+)?INDEX|\bKEY|\bINDEX)\b/gi;

/**
 * 从 CREATE TABLE 的括号体里抽出所有索引的**最左列**。
 *
 * 覆盖三种写法:
 *   PRIMARY KEY (a, b)                 —— 表级
 *   CONSTRAINT [pk_x] PRIMARY KEY ([a]) —— MSSQL 表级
 *   KEY ix_x (a) / UNIQUE KEY ux (a)    —— MySQL 表级
 *   agent_id VARCHAR(64) PRIMARY KEY   —— 列级
 */
function collectIndexedFirstColumns(body) {
  const firstCols = new Set();

  // 1) 表级索引: 先把 FOREIGN KEY 子句挖掉, 否则 "FOREIGN KEY (x)" 会被当成索引
  const withoutFk = body.replace(
    /(?:CONSTRAINT\s+(?:`[A-Za-z0-9_$]+`|\[[A-Za-z0-9_$]+\]|[A-Za-z0-9_$]+)\s+)?FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+(?:`[A-Za-z0-9_$]+`|\[[A-Za-z0-9_$]+\]|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:`[A-Za-z0-9_$]+`|\[[A-Za-z0-9_$]+\]|[A-Za-z0-9_$]+))?\s*\([^)]*\)/gi,
    ' ',
  );

  // 2) 表级: 关键字 -> 后面第一对括号里的列
  INDEX_KEYWORD_RE.lastIndex = 0;
  let m;
  while ((m = INDEX_KEYWORD_RE.exec(withoutFk)) !== null) {
    // "FOREIGN KEY" 已在上面挖掉; 仍要防 "PRIMARY KEY" 里的 KEY 被二次匹配
    const kw = m[1].toUpperCase();
    if (kw === 'KEY' || kw === 'INDEX') {
      const before = withoutFk.slice(Math.max(0, m.index - 12), m.index).toUpperCase();
      if (/PRIMARY\s*$/.test(before) || /FOREIGN\s*$/.test(before)) continue;
    }
    const group = readParenGroup(withoutFk, m.index + m[0].length);
    if (!group) continue;
    const cols = parseColumnList(group.inner);
    if (cols.length) firstCols.add(cols[0]);
    INDEX_KEYWORD_RE.lastIndex = group.end;
  }

  // 3) 列级: `col` TYPE ... PRIMARY KEY / UNIQUE
  const columnLevelRe = new RegExp(
    `^\\s*(${IDENT})\\s+[^,\\n]*?\\b(PRIMARY\\s+KEY|UNIQUE)\\b`,
    'gim',
  );
  while ((m = columnLevelRe.exec(body)) !== null) {
    firstCols.add(normalizeIdent(m[1]));
  }
  return firstCols;
}

// ---------------------------------------------------------------------------
// 批次 (MSSQL 的 GO)
// ---------------------------------------------------------------------------

/**
 * 按 `GO` 行把原文切成批次。
 *
 * ⚠ GO 的识别规则必须与生产 splitter **逐字一致**, 否则这里切出来的语句序列
 * 就不是生产真正会执行的序列 —— 那时检查器的所有结论都失去意义。
 * 生产 (center/src/init/schema-applier.js:55-65) 的判据是:
 *   - 字符必须**顶格** (前面有空格 ⇒ 那些空格已经进了 buf ⇒ buf 既不为空
 *     也不以 \n 结尾 ⇒ 不认)
 *   - 必须**大写** (判据写死了 `c === 'G'`)
 *   - 行内 GO 之后只能是空白
 * ⇒ 这里的正则必须是 `/^GO[ \t]*$/`, **不能**写成 `/^[ \t]*GO[ \t]*$/`。
 */
function splitBatches(sql) {
  const lines = sql.split('\n');
  const batches = [];
  let current = [];
  for (const line of lines) {
    if (/^GO[ \t]*$/.test(line)) {
      batches.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  batches.push(current.join('\n'));
  return batches;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析一个基线文件, 返回**实际执行顺序**下的表 / 外键 / 索引模型。
 */
export function parseBaseline(sql) {
  const tables = new Map(); // name -> { name, stmtIndex, batchIndex, body }
  const indexes = new Map(); // tableName -> Map<firstCol, { availableAt, batchIndex }>
  const foreignKeys = [];
  let stmtIndex = 0;

  const addIndex = (tableName, col, availableAt, batchIndex) => {
    if (!tableName || !col) return;
    if (!indexes.has(tableName)) indexes.set(tableName, new Map());
    const byCol = indexes.get(tableName);
    const prev = byCol.get(col);
    if (!prev || availableAt < prev.availableAt) byCol.set(col, { availableAt, batchIndex });
  };

  const batches = splitBatches(sql);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const statements = splitSqlStatements(batches[batchIndex]);
    for (const stmt of statements) {
      const currentIndex = stmtIndex++;

      // --- CREATE TABLE ---
      CREATE_TABLE_RE.lastIndex = 0;
      let cm;
      while ((cm = CREATE_TABLE_RE.exec(stmt)) !== null) {
        const name = normalizeIdent(cm[1]);
        if (!name || tables.has(name)) continue;
        const group = readParenGroup(stmt, cm.index + cm[0].length);
        if (!group) continue;
        tables.set(name, {
          name,
          stmtIndex: currentIndex,
          batchIndex,
          body: stmt.slice(group.end),
        });
        for (const col of collectIndexedFirstColumns(stmt.slice(0, group.end))) {
          addIndex(name, col, currentIndex, batchIndex);
        }
        // 表体内的内联外键
        INLINE_FK_RE.lastIndex = 0;
        let fm;
        while ((fm = INLINE_FK_RE.exec(stmt)) !== null) {
          foreignKeys.push({
            owner: name,
            constraint: fm[1] ? normalizeIdent(fm[1]) : '(unnamed)',
            refTable: normalizeIdent(fm[3]),
            refColumns: parseColumnList(fm[4]),
            kind: 'inline',
            stmtIndex: currentIndex,
            batchIndex,
          });
        }
        break; // 一条语句只建一张表
      }

      // --- ALTER TABLE ... ADD ... FOREIGN KEY ---
      ALTER_FK_RE.lastIndex = 0;
      let am;
      while ((am = ALTER_FK_RE.exec(stmt)) !== null) {
        foreignKeys.push({
          owner: normalizeIdent(am[1]),
          constraint: am[2] ? normalizeIdent(am[2]) : '(unnamed)',
          refTable: normalizeIdent(am[4]),
          refColumns: parseColumnList(am[5]),
          kind: 'alter',
          stmtIndex: currentIndex,
          batchIndex,
        });
      }

      // --- ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY / UNIQUE ---
      ALTER_KEY_RE.lastIndex = 0;
      while ((am = ALTER_KEY_RE.exec(stmt)) !== null) {
        const cols = parseColumnList(am[3]);
        if (cols.length) addIndex(normalizeIdent(am[1]), cols[0], currentIndex, batchIndex);
      }

      // --- 独立 CREATE INDEX ---
      CREATE_INDEX_RE.lastIndex = 0;
      while ((am = CREATE_INDEX_RE.exec(stmt)) !== null) {
        const cols = parseColumnList(am[2]);
        if (cols.length) addIndex(normalizeIdent(am[1]), cols[0], currentIndex, batchIndex);
      }
    }
  }

  return { tables, indexes, foreignKeys, statementCount: stmtIndex };
}

/** 判定某个文件是什么方言 —— 路径里带 /mssql/ 就是 MSSQL。 */
export function dialectOf(filePath) {
  return filePath.split(/[\\/]/).includes('mssql') ? 'mssql' : 'mysql';
}

/**
 * 核心检查: 返回该文件的问题列表。
 */
export function checkFile(filePath, sql) {
  const dialect = dialectOf(filePath);
  const { tables, indexes, foreignKeys, statementCount } = parseBaseline(sql);
  const problems = [];
  const relPath = relative(repoRoot, filePath).split(sep).join('/');

  // ★ 自检 (R161.3): 本检查器按"先按 GO 切批次, 再逐批 splitSqlStatements"的
  //   方式复原语句序列, 而生产是"对整份文件 splitSqlStatements"。两者**必须**
  //   得到同一串语句, 否则下面所有"第几条语句"的判断都指向一个生产根本不会
  //   执行的序列 —— 检查器会变成一台永远说 OK 的假仪器。
  //   这条断言就是那台仪器自己的体检指标。
  const productionStatements = splitSqlStatements(sql);
  if (productionStatements.length !== statementCount) {
    problems.push({
      severity: 'error',
      file: relPath,
      code: 'SPLIT-SEQUENCE-MISMATCH',
      message:
        `检查器切出 ${statementCount} 条语句, 但生产 splitSqlStatements 切出 ` +
        `${productionStatements.length} 条 ⇒ 两者不一致, 下面的语句级判断全部失效` +
        ` (检查 splitBatches 的 GO 识别规则是否还与生产一致)`,
    });
  }

  for (const fk of foreignKeys) {
    const ref = tables.get(fk.refTable);

    if (!ref) {
      problems.push({
        severity: 'error',
        file: relPath,
        code: 'FK-MISSING-REF-TABLE',
        message:
          `${fk.owner}.${fk.constraint} 参照表 ${fk.refTable} 从未被创建` +
          ` ⇒ 全新库建外键必然失败 (errno 150 "Cannot add foreign key constraint")`,
      });
      continue;
    }

    // R161.3 — 判据**双方言一致**: 参照表必须建在**更早的语句**。
    // 理由见文件头: 生产 applyFile() 是 `for (const s of stmts) { await
    // db.execute(s, []); }` —— 逐条执行, `GO` 只是 flush 标记, 不是可延后
    // 解析的批次边界。之前 MSSQL 用批次级判据是**假阴性来源**。
    if (ref.stmtIndex > fk.stmtIndex) {
      problems.push({
        severity: 'error',
        file: relPath,
        code: 'FK-FORWARD-REF',
        message:
          `${fk.owner}.${fk.constraint} 参照 ${fk.refTable}, 但 ${fk.refTable} 的 CREATE TABLE` +
          ` 在它之后才执行 (语句 #${ref.stmtIndex} > #${fk.stmtIndex})` +
          (dialect === 'mysql'
            ? ` ⇒ 全新库 errno 150 "Cannot add foreign key constraint"`
            : ` ⇒ 全新库 Msg 1750 "is not a referenced table"`),
      });
    }

    // 参照列必须被父表某个索引覆盖 (MySQL 要求是某个索引的最左前缀, 否则 1822)
    const byCol = indexes.get(fk.refTable);
    for (const col of fk.refColumns) {
      const hit = byCol && byCol.get(col);
      if (!hit) {
        problems.push({
          severity: 'error',
          file: relPath,
          code: 'FK-REF-COL-NOT-INDEXED',
          message:
            `${fk.owner}.${fk.constraint} 参照 ${fk.refTable}(${col}), 但 ${col} 不是 ${fk.refTable}` +
            ` 任何索引的最左列 ⇒ 父表缺索引, 建外键会失败`,
        });
        continue;
      }
      // 双方言一致: 建 FK 的那一刻, 父表这个最左列索引必须**已经存在**。
      //   MySQL : 缺索引 ⇒ errno 1822 "Failed to add the foreign key constraint"
      //   MSSQL: 缺 PK/UNIQUE 覆盖 ⇒ Msg 1776 "is not a primary key or unique index"
      // R161.3 之前 MSSQL 用的是批次级判据 + warning 级别 —— 同批次内索引晚于
      // FK 的情况**根本不会被报出来**, 同样是真问题被降级成噪声。
      if (hit.availableAt > fk.stmtIndex) {
        problems.push({
          severity: 'error',
          file: relPath,
          code: 'FK-REF-INDEX-TOO-LATE',
          message:
            `${fk.owner}.${fk.constraint} 参照 ${fk.refTable}(${col}), 但该索引在 FK 之后才建立` +
            ` (语句 #${hit.availableAt} > #${fk.stmtIndex})` +
            (dialect === 'mysql'
              ? ` ⇒ MySQL 建外键时父表还没有可用索引 (errno 1822)`
              : ` ⇒ MSSQL 建外键时父表还没有可用的 PK/UNIQUE 覆盖 (Msg 1776)`),
        });
      }
    }
  }

  return {
    file: relPath,
    dialect,
    tableCount: tables.size,
    fkCount: foreignKeys.length,
    statementCount,
    problems,
  };
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

  // R161.2 — 残留的方言无关基线必须不在树里
  const relic = resolve(repoRoot, LEGACY_RELIC);
  if (existsSync(relic)) {
    errorCount++;
    results.push({
      file: LEGACY_RELIC,
      dialect: 'mysql',
      tableCount: 0,
      fkCount: 0,
      statementCount: 0,
      problems: [
        {
          severity: 'error',
          file: LEGACY_RELIC,
          code: 'LEGACY-DIALECTLESS-BASELINE',
          message:
            '顶层 db/migrations/1.0.0-baseline.sql 是 R158.51 方言拆分前的残留旧快照' +
            ' (54 表, 且第 776 行的 CREATE TABLE ad_forest 被注释吃掉 ⇒ 该表从未创建)。' +
            ' schema-applier.js 的 resolveSqlPath 会回退到它 ⇒ 一旦 db/migrations/<dialect>/ ' +
            '缺失, 应用会静默装出一棵残缺库。请删除, 让解析函数大声报错。',
        },
      ],
    });
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
    console.log(JSON.stringify({ errorCount, warnCount, results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`=== ${r.file} (${r.dialect}) ===`);
      console.log(
        `  tables: ${r.tableCount}  foreign keys: ${r.fkCount}  statements: ${r.statementCount}  problems: ${r.problems.length}`,
      );
      for (const p of r.problems) {
        console.log(`  [${p.severity.toUpperCase()}] ${p.code}`);
        console.log(`      ${p.message}`);
      }
    }
    console.log('');
    console.log(
      errorCount === 0
        ? `OK: 外键顺序与参照完整性全部通过 (warning ${warnCount})`
        : `FAILED: ${errorCount} 个错误, ${warnCount} 个警告`,
    );
  }

  process.exit(errorCount > 0 ? 1 : 0);
}
