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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { applyAll, backfillMigrations, splitSqlStatements } from '../src/init/schema-applier.js';
import { parseVerifyMarker } from '../src/init/verify-marker.js';
import { createMigrationsService } from '../src/services/migrations.js';
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
function createFakeDb(dialect = 'mysql') {
  const objects = new Set();       // 已存在的表/视图名
  const indexes = new Set();       // 已存在的索引名 (限定名 <table>.<index>)
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
    const idxRe = /CREATE\s+(?:UNIQUE\s+|NONCLUSTERED\s+|CLUSTERED\s+)?INDEX\s+\[?([A-Za-z0-9_]+)\]?\s+ON\s+\[?([A-Za-z0-9_]+)\]?/gi;
    let im;
    while ((im = idxRe.exec(clean)) !== null) {
      indexes.add(`${im[2].toLowerCase()}.${im[1].toLowerCase()}`);
    }
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
      return { rows: [] };
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
      probe: { table: 'PROBE_TABLE', column: 'PROBE_COLUMN', index: 'PROBE_INDEX' },
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

  return { db, objects, indexes, ledger, executed, probes };
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
          if (!['table', 'column', 'index'].includes(m.kind)) {
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
      const { db, objects, indexes, ledger } = fake;

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
