// R161.17 (2026-10-27) — 编号迁移的 verify 契约 + 新装完整性回归网。
//
// ★ 要钉住的事实 (不是注释):
//   A. **凡是含可执行语句的编号迁移都必须声明 verify 标记**。
//      verify 标记 (-- verify: table X) 是 backfillMigrations 唯一的判据:
//      探针通过 ⇒ 才登记成 'applied'; 探针不过 ⇒ 不登记 ⇒ 启动迁移会
//      真的把它跑掉。没有标记 ⇒ backfill **无条件**登记成 'applied' 而
//      **从不执行** ⇒ 全新安装出来的库是残的。
//      ★ 现场 (R161.17 实测): 全新安装出来的库与源库的唯一差异就是
//        audit_logs_utc_baseline_backup —— 因为 1.0.2 没有标记, 被无条件
//        登记成 applied 而从未执行, 随后的 upgrade() 又因"已 applied"跳过。
//        而 services/audit-utc-baseline.js 在缺表时直接放弃 ⇒ R161.16 的
//        审计时间自愈在**全新安装的部署上从来没生效过**。
//   B. 标记指名的产物必须真的由**这个迁移**建出来 (不许标一个自己没建的
//      对象 —— 那样探针的语义就骗人了)。
//   C. 标记必须落在解析器扫得到的位置 (前 50 行)。
//   D. **端到端**: 走一遍"新装"路径 (applyAll → backfillMigrations →
//      upgrade), 结束时每一条标记指名的产物都必须真的在库里, 而且账本里
//      必须是 'applied'。这是 A 的**后果**, 也是本文件存在的理由。
//   E. 交付包 (LinuxServer/db) 必须与源树**逐字节**一致。
//   F. init 向导的 /db/apply 必须把"待办"的编号迁移真的跑掉 —— 向导说
//      "建库成功" 时交出去的必须是**完整的**库, 而不是"下次启动补上"。
//   G. Windows 安装脚本必须把 db/ 一起装到**安装目录的上一级** ——
//      resolveRepoRoot 命中的是 <cwd>/.., 少拷这个目录 ⇒ 自定义
//      -InstallPath 下向导在建库那一步直接报「找不到基线文件」。
//
// 用法: cd Server/center && npm test

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { applyAll, backfillMigrations, splitSqlStatements } from '../src/init/schema-applier.js';
import { parseVerifyMarker } from '../src/init/verify-marker.js';
import { createMigrationsService } from '../src/services/migrations.js';
import { sortMigrationFiles } from '../src/utils/migration-version.js';
import { initRouter } from '../src/init/router.js';
import { stripSqlComments } from '../../scripts/audit/check-dialect-compat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const REPO_ROOT = resolve(SERVER_ROOT, '..');              // 仓库根
const MIG_ROOT = resolve(SERVER_ROOT, 'db', 'migrations');
const LINUX_MIG_ROOT = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations');
const DIALECTS = ['mysql', 'mssql'];

// 基线文件名 —— 它是"冻结的完整 schema", 不是编号迁移。
const BASELINE_RE = /^1\.0\.0-baseline\.sql$/i;
const NUMBERED_RE = /^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i;

function dialectDir(dialect) {
  return resolve(MIG_ROOT, dialect);
}

function numberedFiles(dialect) {
  const dir = dialectDir(dialect);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !BASELINE_RE.test(f))
    .sort();
}

// R161.19 — **引擎真正使用的顺序** (语义版本序)。
//   迁移引擎 (services/migrations.js 的 upgrade/applyUpTo/baseline/listMigrations,
//   以及 init/schema-applier.js 的 backfillMigrations) 一律走这个排序。
//   ★ 为什么不能只看磁盘上的字典序: '1.0.10-x.sql' 在字典序里排在
//   '1.0.2-x.sql' **前面** ⇒ 版本号一到两位数, 磁盘顺序与执行顺序就分家了。
function engineOrderedFiles(dialect) {
  const dir = dialectDir(dialect);
  return sortMigrationFiles(
    readdirSync(dir).filter((f) => f.endsWith('.sql') && !BASELINE_RE.test(f))
  );
}

/** 剥掉注释, 只留可执行内容 (判定"这个迁移到底建了什么"时用)。 */
function stripComments(sql) {
  return stripSqlComments(sql);
}

/**
 * 假库 —— 一个够用的 MySQL 模拟器:
 *   · 记住"库里已有哪些表/视图" (探针查的就是它);
 *   · 记住账本 (schema_migrations) 的每一行;
 *   · execute 时把 CREATE TABLE / CREATE VIEW 的对象登记进去;
 *   · transaction / session 都只是把 execute 转发出去。
 * 它让"新装路径"可以在**不连真库**的前提下跑完整条链。
 */
// CREATE TABLE 里不是列的表级约束关键字 (未加引号时)。
// 注意: 形如 key 的列名在 MySQL 侧必须写成反引号形式 —— 加了引号就按列处理。
const NON_COLUMN_TOKENS = new Set([
  'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'KEY', 'INDEX',
  'PERIOD', 'FULLTEXT', 'SPATIAL'
]);

/**
 * 从 CREATE TABLE 语句里抽出列名与内联外键约束名。
 * 需要括号深度感知的顶层逗号切分 —— 列定义里到处是 DECIMAL(18,2) /
 * NVARCHAR(MAX) / CONVERT(BINARY(32), ...) 这种带逗号的括号。
 */
function parseCreateTable(stmt) {
  const openIdx = stmt.search(
    /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+[`\[\]"]?[A-Za-z0-9_]+[`\[\]"]?\s*\(/i
  );
  if (openIdx < 0) return null;
  const open = stmt.indexOf('(', openIdx);
  let depth = 0, inStr = false, close = -1;
  for (let i = open; i < stmt.length; i++) {
    const ch = stmt[i];
    if (inStr) { if (ch === "'") inStr = false; continue; }
    if (ch === "'") { inStr = true; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return null;
  const body = stmt.slice(open + 1, close);
  const parts = [];
  let d = 0, cur = '', str = false;
  for (const ch of body) {
    if (str) { cur += ch; if (ch === "'") str = false; continue; }
    if (ch === "'") { str = true; cur += ch; continue; }
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const columns = [];
  const foreignKeys = [];
  for (const part of parts) {
    const raw = part.trim();
    if (!raw) continue;
    // 内联外键: CONSTRAINT <name> FOREIGN KEY ...
    // ★ 约束名可能是 [name] (MSSQL) 或 `name` (MySQL) —— 都要认。
    const fk = /^CONSTRAINT\s+[\[`]?([A-Za-z0-9_]+)[\]`]?\s+FOREIGN\s+KEY/i.exec(raw);
    if (fk) { foreignKeys.push(fk[1]); continue; }
    // 列名: MSSQL 用 [name], MySQL 用 `name`, 或裸 name。
    // ★ 旧写法 /^([`\[]?)([A-Za-z0-9_]+)\1/ 只能匹配**反引号**形式 ——
    //   MSSQL 的 [name] 因为收尾的 \1 要求再出现一个 '[' 而**永远匹配不上**
    //   ⇒ 基线里 75 张表的所有列都没登记进 columns 集合 ⇒
    //   任何以"基线里的列"为标记的迁移都会被假库误判成"缺列"。
    const token = /^(\[[^\]]*\]|`[^`]*`|[A-Za-z0-9_]+)/.exec(raw);
    if (!token) continue;
    const literal = token[1];
    const isQuoted = literal[0] === '[' || literal[0] === '`';
    const name = isQuoted ? literal.slice(1, -1) : literal;
    if (!isQuoted && NON_COLUMN_TOKENS.has(name.toUpperCase())) continue;
    columns.push(name);
  }
  return { columns, foreignKeys };
}

function createFakeDb(dialect = 'mysql') {
  const objects = new Set();       // 已存在的表/视图名
  const indexes = new Set();       // 已存在的索引名 (限定名 <table>.<index>)
  const columns = new Set();       // 已存在的列 (限定名 <table>.<column>)
  const foreignKeys = new Set();   // 已存在的外键 (限定名 <table>.<constraint>)
  const ledger = new Map();        // version -> row
  const executed = [];             // 跑过的每一条语句
  const probes = [];               // 探针问过的每个 (kind, name)
  let pendingPayload = null;       // MySQL 的 SET @s 载荷 (等 EXECUTE 才落地)

  function registerObjects(stmt) {
    // 表/视图: 只认**语句开头**就是 CREATE 的那些 —— SET @s = 'CREATE TABLE ...'
    // 这种 PREPARE 载荷里的名字不算数 (那是 ALTER/INDEX 的守卫链)。
    const m = stmt.match(
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\[\]"]?([A-Za-z0-9_]+)/i
    );
    if (m) objects.add(m[1].toLowerCase());
    // MSSQL 风格: IF OBJECT_ID(...) IS NULL BEGIN CREATE TABLE [x] (...) END
    const m2 = stmt.match(/CREATE\s+TABLE\s+\[?([A-Za-z0-9_]+)\]?/i);
    if (m2 && /^\s*(IF\b|BEGIN\b)/i.test(stmt)) objects.add(m2[1].toLowerCase());

    // ★ 索引: **不能**锚定语句开头 ——
    //   MySQL 侧 5.7 没有 CREATE INDEX IF NOT EXISTS, 基线里那条 DDL 是
    //   SET @s = (SELECT IF(..., 'CREATE INDEX x ON t (c)', 'SELECT 1'))，
    //   CREATE INDEX 藏在**字符串载荷**里;
    //   MSSQL 侧是 IF NOT EXISTS (...) BEGIN CREATE NONCLUSTERED INDEX ... END。
    //   两种形态都必须在假库里被认出来, 否则"新装路径建出了这个索引"这件事
    //   在测试里就看不见 —— 断言会变成哑巴。
    //   先剥注释: 基线的注释里也会提到 CREATE INDEX 的名字, 不剥就会把
    //   "注释里提过" 误当成 "真建出来了"。
    const clean = stripComments(stmt);
    // MSSQL 侧可以是 `CREATE UNIQUE NONCLUSTERED INDEX` (两个修饰词连用),
    // 所以修饰词必须**可重复**, 不能只允许一个。
    const idxRe = /CREATE\s+(?:UNIQUE\s+|NONCLUSTERED\s+|CLUSTERED\s+)*INDEX\s+\[?([A-Za-z0-9_]+)\]?\s+ON\s+\[?([A-Za-z0-9_]+)\]?/gi;
    let im;
    while ((im = idxRe.exec(clean)) !== null) {
      indexes.add(`${im[2].toLowerCase()}.${im[1].toLowerCase()}`);
    }

    // 列 (R161.18): 两条来源 ——
    //   ① CREATE TABLE 的列定义 (基线里 75 张表的**全部**列都在这儿);
    //   ② ALTER TABLE ... ADD [col] (MSSQL 的 hash 计算列走这条:
    //      ALTER TABLE [t] ADD [c] AS CONVERT(BINARY(32), ...) PERSISTED)。
    const tableName = (m && m[1]) || (m2 && m2[1]);
    if (tableName) {
      const parsed = parseCreateTable(clean);
      if (parsed) {
        for (const c of parsed.columns) columns.add(`${tableName.toLowerCase()}.${c.toLowerCase()}`);
        for (const fk of parsed.foreignKeys) foreignKeys.add(`${tableName.toLowerCase()}.${fk.toLowerCase()}`);
      }
    }
    // ADD CONSTRAINT 是外键/PK, 不是列 —— 必须先排除, 否则会把 CONSTRAINT
    // 当成列名登记进去。
    if (!/ADD\s+CONSTRAINT/i.test(clean)) {
      const colRe = /ALTER\s+TABLE\s+\[?`?([A-Za-z0-9_]+)`?\]?\s+ADD\s+(?:COLUMN\s+)?\[?`?([A-Za-z0-9_]+)`?\]?/i;
      const cm = clean.match(colRe);
      if (cm) columns.add(`${cm[1].toLowerCase()}.${cm[2].toLowerCase()}`);
    }

    // 外键 (R161.18): ALTER TABLE ... ADD CONSTRAINT [fk] FOREIGN KEY ...
    const fkRe = /ALTER\s+TABLE\s+\[?`?([A-Za-z0-9_]+)`?\]?\s+ADD\s+CONSTRAINT\s+\[?`?([A-Za-z0-9_]+)`?\]?\s+FOREIGN\s+KEY/i;
    const fm = clean.match(fkRe);
    if (fm) foreignKeys.add(`${fm[1].toLowerCase()}.${fm[2].toLowerCase()}`);
  }

  async function exec(sql, params) {
    executed.push(sql);
    if (sql === 'UPSERT_LEDGER') {
      ledger.set(String(params[0]), {
        version: params[0],
        description: params[1],
        type: params[2],
        script: params[3],
        checksum: params[4],
        applied_at: params[5],
        execution_ms: params[6],
        applied_by: params[7],
        status: params[8],
        error_message: params[9]
      });
      return { affectedRows: 1 };
    }
    // ★ MySQL 的守卫形态: SET @s = 'CREATE INDEX ...' → PREPARE → EXECUTE。
    //   索引真正建出来的时刻是 **EXECUTE**, 不是 SET —— 假库照着这个时序走,
    //   才不会把"准备了载荷"当成"建出来了"。
    const clean = stripComments(sql);
    const setPayload = clean.match(/^\s*SET\s+@s\s*=\s*([\s\S]+)$/i);
    if (setPayload) {
      pendingPayload = setPayload[1];
      return { affectedRows: 0 };
    }
    if (/^\s*EXECUTE\s+stmt/i.test(clean) && pendingPayload !== null) {
      registerObjects(pendingPayload);
      pendingPayload = null;
      return { affectedRows: 0 };
    }
    registerObjects(clean);
    return { affectedRows: 0 };
  }

  async function query(sql, params) {
    if (sql === 'PROBE_TABLE') {
      probes.push({ kind: 'table', name: params[0] });
      return { rows: objects.has(String(params[0]).toLowerCase()) ? [{ ok: 1 }] : [] };
    }
    if (sql === 'PROBE_COLUMN') {
      probes.push({ kind: 'column', name: `${params[0]}.${params[1]}` });
      return { rows: columns.has(`${params[0]}.${params[1]}`.toLowerCase()) ? [{ ok: 1 }] : [] };
    }
    if (sql === 'PROBE_FOREIGNKEY') {
      probes.push({ kind: 'foreignkey', name: `${params[0]}.${params[1]}` });
      return { rows: foreignKeys.has(`${params[0]}.${params[1]}`.toLowerCase()) ? [{ ok: 1 }] : [] };
    }
    if (sql === 'PROBE_INDEX') {
      // 标记点名是 '<table>.<index>' (verify-marker.js 的约定)。
      probes.push({ kind: 'index', name: `${params[0]}.${params[1]}` });
      return { rows: indexes.has(`${params[0]}.${params[1]}`.toLowerCase()) ? [{ ok: 1 }] : [] };
    }
    if (sql === 'FIND_BY_VERSION') {
      const row = ledger.get(String(params[0]));
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  }

  const db = {
    dialect,
    sql: {
      probe: { table: 'PROBE_TABLE', column: 'PROBE_COLUMN', index: 'PROBE_INDEX', foreignKey: 'PROBE_FOREIGNKEY' },
      schemaMigrations: {
        upsert: 'UPSERT_LEDGER',
        findByVersion: 'FIND_BY_VERSION',
        list: 'LIST_LEDGER'
      }
    },
    execute: exec,
    query,
    transaction: async (work) => work({ execute: exec }),
    session: async (work) => work({ execute: exec })
  };

  return { db, objects, indexes, columns, foreignKeys, ledger, executed, probes };
}

const silentLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return silentLogger; }
};

describe('A. 凡是含可执行语句的编号迁移, 都必须声明 verify 标记', () => {
  let sawStatementful = 0;
  let sawMarker = 0;

  for (const dialect of DIALECTS) {
    const files = numberedFiles(dialect);

    test(`${dialect}: 至少有一个编号迁移 (否则这条断言是哑巴)`, () => {
      assert.ok(files.length > 0, `${dialect} 目录下没有编号迁移 —— 分支是否被删干净了?`);
    });

    for (const file of files) {
      test(`${dialect}/${file}: 有语句 ⇒ 必须有 verify 标记`, () => {
        const full = resolve(dialectDir(dialect), file);
        const content = readFileSync(full, 'utf8');
        const body = stripComments(content);
        // 判定"有没有可执行语句"用切分器 (它认得 DELIMITER / GO / BEGIN...END)。
        const stmts = splitSqlStatements(content);
        if (stmts.length === 0) {
          // 有意为之的空迁移 (MSSQL 1.0.1) —— 没有产物要验证, 豁免。
          assert.ok(
            /有意为之|无需|不需要/.test(content),
            `${file} 是空迁移, 必须在注释里写明"为什么不需要改" —— 否则后人分不清"有意为空"与"忘了写"`
          );
          return;
        }
        sawStatementful += 1;
        const markers = parseVerifyMarker(content);
        if (markers.length === 0) {
          assert.fail(
            `${dialect}/${file} 含 ${stmts.length} 条可执行语句, 却没有任何 verify 标记 —— `
            + 'backfillMigrations 会**无条件**把它登记成 applied 而从不执行 ⇒ '
            + '全新安装出来的库缺这个迁移的产物 (R161.17 的现场)。'
            + '请在文件头加一行 `-- verify: table <产物名>`'
          );
        }
        sawMarker += 1;
        assert.ok(body.length > 0, `${file} 剥掉注释后是空的 (它到底是语句还是注释?)`);
      });
    }
  }

  test('这条断言本身不是哑巴 (真的扫到了带语句的迁移和 verify 标记)', () => {
    assert.ok(sawStatementful > 0, '一条带可执行语句的编号迁移都没扫到 —— 扫描逻辑坏了');
    assert.ok(sawMarker > 0, '一条 verify 标记都没扫到 —— 扫描逻辑坏了');
  });
});

describe('B. 标记指名的产物必须真的由这个迁移建出来', () => {
  // 标记名有两种形态 (verify-marker.js 的约定):
  //   table  <name>              —— 单段
  //   index  <table>.<index>     —— 点号限定 (列级同理)
  // 点号形态要**逐段**检查: 'ad_dcs.idx_ad_dcs_forest_domain' 在正文里是以
  // "ON ad_dcs" + "CREATE INDEX idx_ad_dcs_forest_domain" 两段出现的, 整串
  // 匹配会误判成"正文里没提到"。
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const dialect of DIALECTS) {
    for (const file of numberedFiles(dialect)) {
      test(`${dialect}/${file}: 每个标记都在本文件里被建出来`, () => {
        const full = resolve(dialectDir(dialect), file);
        const content = readFileSync(full, 'utf8');
        const markers = parseVerifyMarker(content);
        if (markers.length === 0) return;
        const body = stripComments(content);
        for (const m of markers) {
          if (!['table', 'column', 'index', 'foreignkey'].includes(m.kind)) {
            assert.fail(`未知的 verify 标记类型 ${m.kind}`);
          }
          const parts = m.name.split('.');
          for (const part of parts) {
            assert.ok(
              new RegExp(`\\b${escapeRe(part)}\\b`, 'i').test(body),
              `${file} 声明了 \`-- verify: ${m.kind} ${m.name}\`, 但文件正文里根本没提到 ${part} —— `
              + '这个标记会让探针说谎 (它探的不是这个迁移的产物)'
            );
          }
        }
      });
    }
  }
});

describe('C. 标记必须落在解析器扫得到的位置 (前 50 行)', () => {
  for (const dialect of DIALECTS) {
    for (const file of numberedFiles(dialect)) {
      test(`${dialect}/${file}: 标记行号 < 50`, () => {
        const full = resolve(dialectDir(dialect), file);
        const lines = readFileSync(full, 'utf8').split('\n');
        const markerLines = lines
          .map((text, i) => ({ text, no: i + 1 }))
          .filter((l) => /^\s*--\s*verify:/i.test(l.text));
        if (markerLines.length === 0) return;   // 空迁移, 已在 A 组豁免
        for (const l of markerLines) {
          assert.ok(
            l.no <= 50,
            `${file} 第 ${l.no} 行才出现 verify 标记 —— 解析器只扫前 50 行 `
            + '(parseVerifyMarker 的 MAX_SCAN_LINES), 放在那儿等于没写'
          );
        }
      });
    }
  }
});

describe('D. 端到端: 走一遍新装路径, 每条标记指名的产物都必须真的在库里', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: applyAll → backfill → upgrade 之后, 标记指名的产物全部就位`, async () => {
      const fake = createFakeDb(dialect);
      const { db, objects, indexes, columns, foreignKeys, ledger } = fake;

      // 1. 建库 (跑基线)
      await applyAll(dialect, db, {
        createDatabase: false,
        databaseName: 'fake_db',
        repoRoot: SERVER_ROOT,
        logger: silentLogger
      });

      // 2. 登记账本
      const backfill = await backfillMigrations(dialect, db, {
        repoRoot: SERVER_ROOT,
        getDataDir: null,
        writeAudit: null,
        logger: silentLogger
      });

      // 3. 把待办的编号迁移真的跑掉 (init 向导与启动路径都走这一步)
      const svc = createMigrationsService({
        db,
        logger: silentLogger,
        getRepoRoot: () => SERVER_ROOT,
        writeAudit: null,
        getDataDir: null
      });
      const up = await svc.upgrade({ appliedBy: 'test' });
      assert.ok(up.ok, `${dialect}: upgrade 失败: ${JSON.stringify(up.migrations.failed)}`);

      // 4. 断言: 每条编号迁移的每个标记产物都在库里, 且账本是 applied
      const files = numberedFiles(dialect);
      assert.ok(files.length > 0, `${dialect} 没有编号迁移 —— 断言成了哑巴`);
      for (const file of files) {
        const content = readFileSync(resolve(dialectDir(dialect), file), 'utf8');
        const markers = parseVerifyMarker(content);
        const version = file.match(NUMBERED_RE)?.[1];
        for (const m of markers) {
          // 表/视图看 objects; 索引 (点号限定名) 看 indexes。
          const present = m.kind === 'index'
            ? indexes.has(m.name.toLowerCase())
            : m.kind === 'column'
              ? columns.has(m.name.toLowerCase())
              : m.kind === 'foreignkey'
                ? foreignKeys.has(m.name.toLowerCase())
                : objects.has(m.name.toLowerCase());
          assert.ok(
            present,
            `${dialect}/${file} 声明要建 ${m.name}, 但新装路径跑完之后它**不在库里** —— `
            + `objects=[${[...objects].join(', ')}] indexes=[${[...indexes].join(', ')}] `
            + `backfill.skipped=${JSON.stringify(backfill.skipped)}`
          );
          const row = ledger.get(version);
          assert.ok(row, `${dialect}/${file} 跑完之后账本里没有 ${version} 这一行`);
          assert.equal(row.status, 'applied', `${dialect}/${file} 的账本状态不是 applied`);
        }
      }

      // 5. 关键的那一条: 1.0.2 的备份表必须真的建出来了 (R161.17 的现场)
      assert.ok(
        objects.has('audit_logs_utc_baseline_backup'),
        `${dialect}: 新装路径跑完之后 audit_logs_utc_baseline_backup 仍然不存在 —— `
        + 'R161.17 的 bug 复现: backfill 无条件登记 + upgrade 因"已 applied"跳过 ⇒ 表永远建不出来'
      );
    });
  }
});

describe('E. 交付包 (LinuxServer/db) 必须与源树逐字节一致', () => {
  for (const dialect of DIALECTS) {
    const files = readdirSync(resolve(LINUX_MIG_ROOT, dialect)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      test(`${dialect}/${file} 源树与交付树逐字节一致`, () => {
        const src = resolve(dialectDir(dialect), file);
        const dst = resolve(LINUX_MIG_ROOT, dialect, file);
        assert.ok(existsSync(dst), `交付包缺文件: ${dst}`);
        assert.ok(
          readFileSync(src).equals(readFileSync(dst)),
          `${dialect}/${file} 源树与交付树不一致 —— 交付包会跑旧 SQL`
        );
      });
    }
  }
});

describe('F. init 向导的 /db/apply 必须把待办的编号迁移真的跑掉', () => {
  let server = null;
  let baseUrl = '';

  before(async () => {
    const app = express();
    app.use(express.json());
    // 探针用的假依赖: 只关心"向导有没有调用 upgrade()、失败有没有变成 500"。
    app.use('/api/init', initRouter({
      logger: silentLogger,
      configPath: 'unused',
      installPath: 'unused',
      getNeedsInit: () => true,
      _deps: {
        withOneShotFacade: async () => ({}),
        applyAll: async () => ({ schema: [], seed: [], migrations: [], conflicts: [] }),
        createAdmin: async () => ({}),
        writeConfig: () => {},
        getWizardFacade: async () => ({ dialect: 'mysql', sql: {}, execute: async () => ({}), query: async () => ({ rows: [] }) }),
        closeWizardFacade: async () => {},
        writeMarker: async () => {},
        backfillMigrations: async () => ({
          count: 1,
          skipped: [{ file: '1.0.2-audit-utc-baseline.sql', version: '1.0.2', missing: ['table audit_logs_utc_baseline_backup'] }]
        }),
        createMigrationsService: () => fakeMigrations,
        resolveRepoRoot: () => SERVER_ROOT
      }
    }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  test('待办的迁移会被跑掉, 且结果回传给操作员', async () => {
    fakeMigrations.upgradeResult = {
      ok: true,
      message: '升级完成: 1 baseline 应用',
      migrations: { applied: [{ version: '1.0.2', executionMs: 12 }], skipped: [], failed: [] }
    };
    const res = await fetch(`${baseUrl}/api/init/db/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dialect: 'mysql', connParams: { host: 'h' }, createDatabase: false })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(fakeMigrations.calls, ['init-wizard'], '向导必须用 upgrade() 跑待办的迁移');
    assert.deepEqual(body.migrations, [{ version: '1.0.2', executionMs: 12 }]);
    assert.equal(body.pendingMigrations.length, 1, '待办清单必须回传给操作员 (不能静默吞掉)');
  });

  test('迁移跑失败 ⇒ 必须 500 (不能"建库成功"地放过一个残库)', async () => {
    fakeMigrations.upgradeResult = {
      ok: false,
      message: '升级部分失败: 1 baseline 失败',
      migrations: { applied: [], skipped: [], failed: [{ version: '1.0.2', errorMessage: 'ER_LOCK_WAIT_TIMEOUT' }] }
    };
    const res = await fetch(`${baseUrl}/api/init/db/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dialect: 'mysql', connParams: { host: 'h' }, createDatabase: false })
    });
    assert.equal(res.status, 500, '迁移失败必须报错 —— 静默放过 = 交付一棵残库');
    const body = await res.json();
    assert.match(body.error, /1\.0\.2/, '错误里必须点名是哪条迁移失败了');
  });
});

// 供 F 组替换的假迁移服务 (upgrade 的返回由测试改写)。
const fakeMigrations = {
  calls: [],
  upgradeResult: {
    ok: true,
    message: '',
    migrations: { applied: [], skipped: [], failed: [] }
  },
  upgrade: async ({ appliedBy }) => {
    fakeMigrations.calls.push(appliedBy);
    return fakeMigrations.upgradeResult;
  }
};

describe('G. Windows 安装脚本必须把 db/ 装到安装目录的上一级', () => {
  const installer = resolve(SERVER_ROOT, 'scripts', 'install-center.ps1');

  test('install-center.ps1 存在', () => {
    assert.ok(existsSync(installer), `安装脚本必须存在: ${installer}`);
  });

  test('它必须拷 db/ 到 <安装目录上一级>\\db (resolveRepoRoot 命中的是 cwd/..)', () => {
    const src = readFileSync(installer, 'utf8');
    assert.match(
      src,
      /dbSrc\s*=\s*Join-Path\s+\$projectRoot\s+'db'/,
      '安装脚本必须从 <projectRoot>\\db 取基线与迁移'
    );
    assert.match(
      src,
      /dbTarget\s*=\s*Join-Path\s+\$installParent\s+'db'/,
      'db/ 必须落在**安装目录的上一级** —— 服务进程的 cwd = 安装目录, resolveRepoRoot 找的是 cwd/..'
    );
    assert.match(
      src,
      /Copy-DirectoryContent\s+-SourceDir\s+\$dbSrc\s+-TargetDir\s+\$dbTarget/,
      '必须真的把 db/ 拷过去 (只算路径不拷贝 = 还是缺文件)'
    );
  });
});

// R161.17 — 「冻结的基线被事后编辑」留下的唯一一条真实差异:
//   ad_dcs.idx_ad_dcs_forest_domain。R161.6 把这条索引加进了基线, 但基线
//   只在**建库**时跑一次 ⇒ 在那之前建好的库永远补不上。
//   真库的 schema 级对比 (源库 vs 用当前基线新建的库) 的差异**只有这一条**。
//
//   本组钉住两件事:
//     ① 存量库 (索引不在) ⇒ 探针不过 ⇒ 迁移**不被登记**成 applied
//        (登记了就等于"跑过了", upgrade 会跳过 ⇒ 永远补不上);
//     ② 迁移引擎真的跑一遍 ⇒ 索引就位 + 账本变成 applied。
//   新装库的那条路径由 D 组覆盖 (基线已经建好索引 ⇒ 探针过 ⇒ 迁移被跳过,
//   不重复劳动)。
describe('H. 存量部署: 基线里后加的索引必须被编号迁移补上', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 库里缺索引 ⇒ 不登记 ⇒ 迁移跑完之后索引就位`, async () => {
      const fake = createFakeDb(dialect);
      const { db, indexes, ledger } = fake;

      // 1. 先跑基线 (= 一个"很久以前就建好了"的库)
      await applyAll(dialect, db, {
        createDatabase: false,
        databaseName: 'fake_db',
        repoRoot: SERVER_ROOT,
        logger: silentLogger
      });

      // 2. 模拟 "R161.6 之前建的库": 那时候索引还不存在
      //    ★ 先断言基线**确实**建出了这个索引 —— 否则下面的 delete 是在删一个
      //      压根不存在的东西, 整组断言就成了哑巴 (恒真 ⇒ 什么也没验)。
      assert.ok(
        indexes.has('ad_dcs.idx_ad_dcs_forest_domain'),
        '模拟前提没成立: 基线跑完之后假库里就该有这个索引 (基线是"冻结的完整 schema", '
        + '里面带着这条索引) —— 假库坏了, 不是被测代码坏了'
      );
      indexes.delete('ad_dcs.idx_ad_dcs_forest_domain');
      assert.ok(
        !indexes.has('ad_dcs.idx_ad_dcs_forest_domain'),
        '模拟失败: 索引没能从假库里删掉 —— 假库坏了, 不是被测代码坏了'
      );

      // 3. 登记账本: 探针不过 ⇒ 1.0.3 **不能**被登记成 applied
      const backfill = await backfillMigrations(dialect, db, {
        repoRoot: SERVER_ROOT,
        getDataDir: null,
        writeAudit: null,
        logger: silentLogger
      });
      const skippedFiles = backfill.skipped.map((s) => s.file);
      assert.ok(
        skippedFiles.some((f) => f.startsWith('1.0.3-')),
        `1.0.3 应该因为探针不过而被跳过, 实际 skipped=${JSON.stringify(backfill.skipped)}`
      );
      assert.ok(
        !ledger.has('1.0.3'),
        '探针不过 ⇒ 账本里不能出现 1.0.3 这一行 (登记了 = upgrade 会跳过 = 永远补不上)'
      );

      // 4. 迁移引擎真的跑一遍 ⇒ 索引就位 + 账本变成 applied
      const svc = createMigrationsService({
        db,
        logger: silentLogger,
        getRepoRoot: () => SERVER_ROOT,
        writeAudit: null,
        getDataDir: null
      });
      const up = await svc.upgrade({ appliedBy: 'test' });
      assert.ok(up.ok, `upgrade 失败: ${JSON.stringify(up.migrations.failed)}`);
      assert.ok(
        indexes.has('ad_dcs.idx_ad_dcs_forest_domain'),
        `迁移跑完索引还没建出来 —— indexes=[${[...indexes].join(', ')}]`
      );
      assert.equal(ledger.get('1.0.3')?.status, 'applied', '1.0.3 的账本状态不是 applied');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// R161.18 (2026-10-28) — MSSQL 收敛迁移 (1.0.4 ~ 1.0.9) 的专项回归网。
//
// 背景 (实测): 生产形状的 MSSQL 库跟仓库基线**结构不同** ——
//   · 75 张表: 一致;
//   · 基线二级索引 154 个: 库里只有 26 个 ⇒ **缺 127 个** (8 唯一 + 119 非唯一);
//   · hash 计算列: 基线 3 个, 库里 **0 个** ⇒ P0 (4 条 MSSQL MERGE 的 ON 子句
//     直接引用它们 ⇒ 必然 Msg 207);
//   · 外键: 基线 23 个, 库里 22 个 ⇒ 缺 fk_dc_overview_site。
// 根因与 R161.17 同源: 基线只在**建库**时跑一次, 之后新增的 DDL 到不了存量库。
//
// 本组钉住的是**这些迁移自身的形状**, 而不是"它们建了啥" (那是 A~D 组的事):
//   I-1 编号迁移的**文件顺序**必须与**语义版本顺序**一致 —— 迁移引擎用
//        readdirSync().sort(), 那是**字典序**: '1.0.10' 排在 '1.0.2' **前面**
//        ⇒ 版本号一旦到两位数, 迁移顺序就乱了。
//   I-2 每个 CREATE INDEX 前面必须有**形状守卫** —— 按名字判重不够:
//        SQL Server 的索引名只在**表内**唯一, 客户库的 PK/唯一约束是
//        SSMS 自动名 ⇒ 只按名字判重会造出重复索引。
//   I-3 每个 UNIQUE 索引前面必须有**重复数据预检** —— 建唯一索引遇到重复行
//        会失败; 迁移必须**报出诊断**而不是偷偷删数据。
//   I-4 外键前必须有**孤儿预检**, 且必须排在 ADD CONSTRAINT **之前**。
//   I-5 hash 列迁移必须排在**使用它的唯一索引迁移之前**。
//   I-6 端到端: "老一代库" ⇒ 探针不过 ⇒ 不登记 ⇒ upgrade 之后全部补齐。
// ─────────────────────────────────────────────────────────────────────────────

/** 语义版本比较 (只按数字段比, 不做字符串比)。 */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

describe('I. MSSQL 收敛迁移 (R161.18): 顺序 / 守卫 / 端到端', () => {
  const MSSQL_MIG = resolve(MIG_ROOT, 'mssql');
  // 收敛迁移 (基线之后的那些) —— 顺序敏感, 都要逐个断言形状。
  const CONVERGENCE = [
    '1.0.4-mssql-hash-columns.sql',
    '1.0.5-mssql-unique-indexes.sql',
    '1.0.6-mssql-secondary-indexes-1.sql',
    '1.0.7-mssql-secondary-indexes-2.sql',
    '1.0.8-mssql-secondary-indexes-3.sql',
    '1.0.9-mssql-dc-overview-site-fk.sql'
  ];

  test('I-1 编号迁移的版本号必须唯一 (引擎按语义版本序执行, 账本按 version 主键记)', () => {
    for (const dialect of DIALECTS) {
      const files = engineOrderedFiles(dialect);   // 引擎序 (语义版本序)
      const versions = files.map((f) => f.match(NUMBERED_RE)[1]);
      const seen = new Map();
      for (const f of files) {
        const v = f.match(NUMBERED_RE)[1];
        assert.ok(
          !seen.has(v),
          `${dialect}: 版本号 ${v} 出现了两次 (${seen.get(v)} 与 ${f}) —— `
          + '账本 schema_migrations 按 version 主键记 ⇒ 后一条会覆盖前一条 ⇒ 有一条永远执行不到'
        );
        seen.set(v, f);
      }
      // 引擎序必须严格递增 (排序工具本身的性质, 这里顺带钉住"引擎序 = 语义序")。
      for (let i = 1; i < versions.length; i++) {
        assert.ok(
          cmpVersion(versions[i - 1], versions[i]) < 0,
          `${dialect}: 引擎序里 "${files[i - 1]}" (${versions[i - 1]}) 之后不是更小的 `
          + `"${files[i]}" (${versions[i]}) ⇒ 排序工具坏了`
        );
      }
      // ★ R161.19: 引擎已改成语义版本序 ⇒ "编号迁移最多到 1.0.9" 这个约定**作废**。
      //   下一个迁移可以安全地叫 1.0.10 (J 组钉住这一点)。
    }
  });

  test('I-2 每个 CREATE INDEX 前面必须有形状守卫 (按名字判重会造重复索引)', () => {
    let checked = 0;
    for (const file of CONVERGENCE) {
      const content = readFileSync(resolve(MSSQL_MIG, file), 'utf8');
      const stmts = splitSqlStatements(content);
      for (const stmt of stmts) {
        if (!/CREATE\s+(?:UNIQUE\s+|NONCLUSTERED\s+|CLUSTERED\s+)*INDEX/i.test(stmt)) continue;
        checked++;
        assert.match(
          stmt,
          /IF\s+NOT\s+EXISTS/i,
          `${file}: CREATE INDEX 没有 IF NOT EXISTS 守卫 ⇒ 重复执行会报 "索引已存在"`
        );
        assert.match(
          stmt,
          /sys\.index_columns/i,
          `${file}: CREATE INDEX 的守卫只按**名字**判重, 没有比对键列 ⇒ `
          + 'SQL Server 的索引名只在表内唯一, 客户库同名不同形的索引会被漏判 ⇒ 造出重复索引'
        );
        assert.match(
          stmt,
          /sys\.columns/i,
          `${file}: 守卫必须比对**键列名** (sys.columns), 不能只比数量`
        );
        assert.match(
          stmt,
          /is_unique\s*=\s*[01]/i,
          `${file}: 守卫必须比对唯一性 (is_unique) —— 同名不同唯一性的索引是不同的对象`
        );
      }
    }
    assert.ok(checked > 0, '一条 CREATE INDEX 都没扫到 —— 断言成了哑巴 (文件被改名或被删了?)');
  });

  test('I-3 每个 UNIQUE 索引前面必须有重复数据预检 (绝不偷偷删数据)', () => {
    const file = '1.0.5-mssql-unique-indexes.sql';
    const content = readFileSync(resolve(MSSQL_MIG, file), 'utf8');
    const stmts = splitSqlStatements(content);
    const creates = stmts.filter((s) => /CREATE\s+UNIQUE\s+/i.test(s));
    const raisers = stmts.filter((s) => /RAISERROR/i.test(s));
    assert.ok(creates.length > 0, '一个唯一索引都没扫到 —— 断言成了哑巴');
    assert.equal(
      raisers.length,
      creates.length,
      `${file}: 建了 ${creates.length} 个唯一索引, 却只有 ${raisers.length} 个重复数据预检 —— `
      + '唯一索引遇到重复行会失败, 迁移必须**先报出诊断** (RAISERROR) 而不是让语句莫名其妙地挂掉'
    );
    for (const r of raisers) {
      assert.match(r, /GROUP\s+BY/i, `${file}: 重复数据预检必须用 GROUP BY ... HAVING COUNT(*) > 1`);
      assert.match(r, /HAVING\s+COUNT\(\s*\*\s*\)\s*>\s*1/i, `${file}: 重复数据预检的 HAVING 条件写错了`);
      assert.doesNotMatch(
        r,
        /\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b/i,
        `${file}: 重复数据预检里出现了写操作 —— 迁移**绝不自动删/改业务数据**, 只能报错让人来处理`
      );
    }
  });

  test('I-4 外键迁移必须有孤儿预检, 且排在 ADD CONSTRAINT 之前', () => {
    const file = '1.0.9-mssql-dc-overview-site-fk.sql';
    const content = readFileSync(resolve(MSSQL_MIG, file), 'utf8');
    const stmts = splitSqlStatements(content);
    const orphanIdx = stmts.findIndex((s) => /RAISERROR/i.test(s) && /ad_sites/i.test(s) && /NOT\s+EXISTS/i.test(s));
    const addIdx = stmts.findIndex((s) => /ADD\s+CONSTRAINT/i.test(s));
    assert.ok(orphanIdx >= 0, `${file}: 没有找到孤儿预检 —— 有孤儿行时建外键会失败, 必须提前报出诊断`);
    assert.ok(addIdx >= 0, `${file}: 没有找到 ADD CONSTRAINT —— 断言成了哑巴`);
    assert.ok(
      orphanIdx < addIdx,
      `${file}: 孤儿预检(第 ${orphanIdx + 1} 批) 必须排在 ADD CONSTRAINT(第 ${addIdx + 1} 批) **之前** `
      + '—— splitSqlStatements 按语句拆批, 块里的 RETURN 会退出整批, 顺序反了就等于没有预检'
    );
    assert.doesNotMatch(
      content,
      /\bDELETE\b[^;]*ad_dc_overview/i,
      `${file}: 孤儿处理不得出现 DELETE —— 迁移只报错, 清理孤儿是人的决定`
    );
  });

  test('I-5 hash 列迁移必须排在使用它的唯一索引迁移之前', () => {
    const files = engineOrderedFiles('mssql');   // 引擎序 (语义版本序)
    const hashIdx = files.findIndex((f) => f.startsWith('1.0.4-'));
    const uniqIdx = files.findIndex((f) => f.startsWith('1.0.5-'));
    assert.ok(hashIdx >= 0 && uniqIdx >= 0, '1.0.4 / 1.0.5 必须存在 —— 断言成了哑巴');
    assert.ok(
      hashIdx < uniqIdx,
      'hash 计算列的迁移必须排在唯一索引迁移之前 —— '
      + 'uq_admin_member / uq_ous_dn / uq_ugm 的键里含 hash 列, 列不在 ⇒ 索引建不出来'
    );
    // 反向锚定: 唯一索引的键列里真的出现了 hash 列 (防止将来有人改了 1.0.5 却忘了改顺序)。
    const uniq = readFileSync(resolve(MSSQL_MIG, '1.0.5-mssql-unique-indexes.sql'), 'utf8');
    for (const hashCol of ['domain_dn_hash', 'distinguished_name_hash', 'group_dn_hash']) {
      assert.match(
        uniq,
        new RegExp(`\\[${hashCol}\\]`, 'i'),
        `1.0.5 里没有用到 hash 列 ${hashCol} —— I-5 的前提变了, 请重新评估 1.0.4/1.0.5 的先后`
      );
    }
  });

  test('I-6 端到端: 老一代 MSSQL 库 ⇒ 探针不过 ⇒ 不登记 ⇒ upgrade 之后全部补齐', async () => {
    const fake = createFakeDb('mssql');
    const { db, indexes, columns, foreignKeys, ledger } = fake;

    await applyAll('mssql', db, {
      createDatabase: false,
      databaseName: 'fake_db',
      repoRoot: SERVER_ROOT,
      logger: silentLogger
    });

    const HASH_COLS = [
      'ad_admin_members.domain_dn_hash',
      'ad_ous_snapshot.distinguished_name_hash',
      'ad_user_group_memberships.group_dn_hash'
    ];
    const UNIQUE_IDX = [
      'ad_admin_commands.ux_ad_admin_commands_task_id',
      'ad_admin_members.uq_admin_member',
      'ad_failed_logon_events.uq_failed_logon_dc_record',
      'ad_ous_snapshot.uq_ous_dn',
      'ad_dc_inbound_partners.uq_inbound_partner',
      'ad_dc_outbound_partners.uq_outbound_partner',
      'ad_user_group_memberships.uq_ugm',
      'system_alert_suppressions.uq_sas_kind_scope'
    ];
    const FK = 'ad_dc_overview.fk_dc_overview_site';

    // ★ 先断言基线**确实**建出了这些产物 —— 否则下面的 delete 是在删不存在的东西,
    //   整组断言就成了哑巴 (恒真 ⇒ 什么也没验)。
    for (const c of HASH_COLS) {
      assert.ok(columns.has(c), `模拟前提没成立: 基线跑完之后假库里就该有列 ${c} —— 假库坏了, 不是被测代码坏了`);
    }
    for (const i of UNIQUE_IDX) {
      assert.ok(indexes.has(i), `模拟前提没成立: 基线跑完之后假库里就该有索引 ${i} —— 假库坏了`);
    }
    assert.ok(foreignKeys.has(FK), `模拟前提没成立: 基线跑完之后假库里就该有外键 ${FK} —— 假库坏了`);

    // 模拟"旧一代"库: 这三样都还没有 (这正是生产形状的 MSSQL 库的形状)
    for (const c of HASH_COLS) columns.delete(c);
    for (const i of UNIQUE_IDX) indexes.delete(i);
    foreignKeys.delete(FK);
    for (const c of HASH_COLS) assert.ok(!columns.has(c), '模拟失败: 列没能从假库里删掉');
    for (const i of UNIQUE_IDX) assert.ok(!indexes.has(i), '模拟失败: 索引没能从假库里删掉');
    assert.ok(!foreignKeys.has(FK), '模拟失败: 外键没能从假库里删掉');

    // 探针不过 ⇒ 三条迁移都不能被登记成 applied
    const backfill = await backfillMigrations('mssql', db, {
      repoRoot: SERVER_ROOT,
      getDataDir: null,
      writeAudit: null,
      logger: silentLogger
    });
    for (const v of ['1.0.4', '1.0.5', '1.0.9']) {
      assert.ok(
        !ledger.has(v),
        `探针不过 ⇒ 账本里不能出现 ${v} 这一行 (登记了 = upgrade 会跳过 = 永远补不上) `
        + `skipped=${JSON.stringify(backfill.skipped)}`
      );
    }

    // 迁移引擎真的跑一遍 ⇒ 全部补齐
    const svc = createMigrationsService({
      db,
      logger: silentLogger,
      getRepoRoot: () => SERVER_ROOT,
      writeAudit: null,
      getDataDir: null
    });
    const up = await svc.upgrade({ appliedBy: 'test' });
    assert.ok(up.ok, `upgrade 失败: ${JSON.stringify(up.migrations.failed)}`);

    for (const c of HASH_COLS) {
      assert.ok(columns.has(c), `迁移跑完列 ${c} 还是不在 —— columns=[${[...columns].join(', ')}]`);
    }
    for (const i of UNIQUE_IDX) {
      assert.ok(indexes.has(i), `迁移跑完索引 ${i} 还是不在 —— indexes=[${[...indexes].join(', ')}]`);
    }
    assert.ok(foreignKeys.has(FK), '迁移跑完外键 fk_dc_overview_site 还是不在');
    for (const v of ['1.0.4', '1.0.5', '1.0.9']) {
      assert.equal(ledger.get(v)?.status, 'applied', `${v} 的账本状态不是 applied`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R161.19 (2026-10-28) — 迁移引擎必须按**语义版本**执行 (字典序陷阱)。
//
// 背景: 引擎原来用 readdirSync().sort() (字典序) 遍历迁移文件。
//   字典序下 '1.0.10-x.sql' 排在 '1.0.2-x.sql' **前面**
//   ('1.0.1' 是 '1.0.10' 的前缀, 而 '-' (0x2D) < '0' (0x30))。
//   ⇒ 版本号一旦进到两位数, 后果不是"列表排得难看", 是**执行顺序错**:
//     · upgrade() —— 先执行 1.0.10, 再执行 1.0.2~1.0.9。
//       而 1.0.5 的唯一索引**依赖** 1.0.4 建出来的 hash 计算列 ⇒ 顺序反了就建不出来。
//     · applyUpTo('1.0.9') —— 遍历到 1.0.10 时 compareVersions('1.0.10','1.0.9') > 0
//       ⇒ break ⇒ 1.0.2 ~ 1.0.9 **一个都不会被执行**。
//   R161.18 把 MSSQL 编号迁移排到 1.0.9 ⇒ 下一个迁移就是 1.0.10 ⇒ 这个坑就摆在
//   下一个文件上等着 ⇒ 在它发生之前把排序换掉 (src/utils/migration-version.js)。
//
// 本组钉的是**行为** (端到端跑一遍引擎, 看它到底按什么顺序执行), 而不是
// "源码里有没有调用某个排序函数" —— 后者会在有人换实现时误报。
// ─────────────────────────────────────────────────────────────────────────────

describe('J. 迁移引擎必须按语义版本执行 (R161.19: 字典序陷阱)', () => {
  // ★ 临时 repo root: 造出"版本号到两位数"的目录, 验证引擎的**真实执行顺序**。
  //   磁盘上 readdirSync 的返回顺序不做保证, 所以断言只看**引擎跑出来的顺序**。
  const TMP_ROOT = mkdtempSync(join(tmpdir(), 'ad-mig-order-'));
  const TMP_MIG = join(TMP_ROOT, 'db', 'migrations', 'mysql');
  // 语义序: 1.0.0 < 1.0.2 < 1.0.9 < 1.0.10
  // 字典序: 1.0.0 < 1.0.10 < 1.0.2 < 1.0.9   ← 1.0.10 插在中间
  const TMP_FILES = [
    ['1.0.0-baseline.sql', 'SELECT 1;'],
    ['1.0.2-second.sql', 'SELECT 1;'],
    ['1.0.9-ninth.sql', 'SELECT 1;'],
    ['1.0.10-tenth.sql', 'SELECT 1;']
  ];

  before(() => {
    mkdirSync(TMP_MIG, { recursive: true });
    for (const [name, body] of TMP_FILES) {
      writeFileSync(join(TMP_MIG, name), body, 'utf8');
    }
  });

  after(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  test('J-1 upgrade() 的执行顺序 = 语义版本顺序 (1.0.10 必须排在 1.0.9 之后)', async () => {
    const fake = createFakeDb('mysql');
    const svc = createMigrationsService({
      db: fake.db,
      logger: silentLogger,
      getRepoRoot: () => TMP_ROOT,
      writeAudit: null,
      getDataDir: null
    });
    const up = await svc.upgrade({ appliedBy: 'test' });
    assert.ok(up.ok, `upgrade 失败: ${JSON.stringify(up.migrations.failed)}`);
    assert.deepEqual(
      up.migrations.applied.map((a) => a.version),
      ['1.0.0', '1.0.2', '1.0.9', '1.0.10'],
      '★ 引擎按字典序执行了 —— 1.0.10 跑到了 1.0.2 前面。'
      + '字典序陷阱: \'1.0.10\' < \'1.0.2\' ⇒ 版本号到两位数, 执行顺序就反了'
    );
  });

  test('J-2 applyUpTo("1.0.9") 会真的执行到 1.0.9, 且不会把 1.0.10 带上', async () => {
    const fake = createFakeDb('mysql');
    const svc = createMigrationsService({
      db: fake.db,
      logger: silentLogger,
      getRepoRoot: () => TMP_ROOT,
      writeAudit: null,
      getDataDir: null
    });
    const r = await svc.applyUpTo('1.0.9', { appliedBy: 'test' });
    assert.ok(r.ok, `applyUpTo 失败: ${JSON.stringify(r.failed)}`);
    assert.deepEqual(
      r.applied.map((a) => a.version),
      ['1.0.0', '1.0.2', '1.0.9'],
      '★ applyUpTo 的 break 点依赖"已按版本升序" —— 字典序下走到 1.0.10 就 break, '
      + '1.0.2 ~ 1.0.9 一个都不会执行'
    );
    assert.ok(
      !fake.ledger.has('1.0.10'),
      'applyUpTo("1.0.9") 把 1.0.10 也执行了 —— 版本上界没生效'
    );
  });

  test('J-3 共享排序工具把 1.0.10 排在 1.0.9 之后 (单元级)', () => {
    const sorted = sortMigrationFiles([
      '1.0.10-tenth.sql',
      '1.0.9-ninth.sql',
      '1.0.2-second.sql',
      '1.0.0-baseline.sql'
    ]);
    assert.deepEqual(
      sorted,
      ['1.0.0-baseline.sql', '1.0.2-second.sql', '1.0.9-ninth.sql', '1.0.10-tenth.sql'],
      'sortMigrationFiles 没有按语义版本排序'
    );
  });

  test('J-4 backfillMigrations 的登记顺序也是语义版本序', async () => {
    const fake = createFakeDb('mysql');
    await backfillMigrations('mysql', fake.db, {
      repoRoot: TMP_ROOT,
      getDataDir: null,
      writeAudit: null,
      logger: silentLogger
    });
    // 账本是 Map ⇒ 插入顺序可观测。
    assert.deepEqual(
      [...fake.ledger.keys()],
      ['1.0.0', '1.0.2', '1.0.9', '1.0.10'],
      'backfillMigrations 按字典序登记了 —— 登记顺序即"以后会被认为已应用"的顺序'
    );
  });
});
