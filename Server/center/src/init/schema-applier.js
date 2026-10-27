// Splits a SQL string into individual statements. Splits on ; followed by
// a newline (or end of string). Ignores ; inside 'string' and "string"
// literals (with simple doubled-quote escape handling), and inside
// MSSQL-style IF...BEGIN...END blocks (tracks BEGIN depth).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseVerifyMarker, verifyMarkers } from './verify-marker.js';
import { toMysqlDatetime } from '../utils/datetime.js';
import { assertValidDatabaseName } from '../utils/dbName.js';

export function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let blockDepth = 0; // tracks BEGIN...END nesting (MSSQL blocks)
  let currentDelim = ';'; // MySQL DELIMITER directive support
  while (i < sql.length) {
    const c = sql[i];

    // MySQL DELIMITER directive (start of line: buf is empty OR buf ends with \n).
    // Comments are skipped over by allowing whitespace-only content; but in
    // practice the directive typically appears on its own line.
    if (c === 'D' && (buf === '' || buf.endsWith('\n')) && /^\s*DELIMITER\s+(\S+)/.test(sql.slice(i))) {
      const m = /^\s*DELIMITER\s+(\S+)/.exec(sql.slice(i));
      currentDelim = m[1];
      buf = '';
      // Skip to end of line
      const nl = sql.indexOf('\n', i);
      i = nl >= 0 ? nl + 1 : sql.length;
      continue;
    }

    // R158.50.7h (2026-10-08) — MSSQL `GO` batch separator. Like
    // MySQL DELIMITER above, MSSQL client tools (sqlcmd, SSMS, and
    // the centre's mssql driver) recognize `GO` on its own line as a
    // statement-batch terminator. The 1.0.0 + 1.0.1 MSSQL baseline files
    // use `GO` to separate CREATE TABLE / CREATE INDEX / ALTER TABLE
    // blocks (R158.51 baseline freeze documented this), so the splitter
    // must strip the `GO` keyword AND flush the current buffer as a
    // completed statement. Without this, 1.0.1 baseline failed with
    // "Could not find stored procedure 'GO'" because db.execute('GO',
    // []) sent the literal `GO` to MSSQL.
    //
    // Pattern: at start of line (buf empty or ends with \n), allow
    // leading whitespace, then literal "GO" followed by optional
    // whitespace up to end-of-line. Case-insensitive (MSSQL parser is
    // case-insensitive for keywords). The current buffer is flushed as
    // a completed statement so DDL blocks separated by `GO` are emitted
    // as individual db.execute calls instead of one giant concatenated
    // string.
    if (c === 'G' && (buf === '' || buf.endsWith('\n'))) {
      const lineEnd = sql.indexOf('\n', i);
      const line = (lineEnd >= 0 ? sql.slice(i, lineEnd) : sql.slice(i)).trim();
      if (/^GO\s*$/i.test(line)) {
        const stmt = buf.trim();
        if (stmt.length > 0) out.push(stmt);
        buf = '';
        i = lineEnd >= 0 ? lineEnd + 1 : sql.length;
        continue;
      }
    }

    if (inSingle) {
      buf += c;
      if (c === "'" && sql[i + 1] === "'") { buf += sql[i + 1]; i += 2; continue; }
      if (c === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && sql[i + 1] === '"') { buf += sql[i + 1]; i += 2; continue; }
      if (c === '"') inDouble = false;
      i++; continue;
    }
    // Line comment (-- to end of line): skip so an apostrophe in a comment
    // (e.g. "wasn't") can't be mistaken for a string-literal open quote.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl >= 0 ? nl : sql.length;
      continue;
    }
    // Block comment (/* ... */): skip entirely.
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end >= 0 ? end + 2 : sql.length;
      continue;
    }
    if (c === "'") { inSingle = true; buf += c; i++; continue; }
    if (c === '"') { inDouble = true; buf += c; i++; continue; }
    // Track BEGIN/END blocks (word-boundary matched)
    if (c === 'B' && /BEGIN\b/.test(sql.slice(i, i + 5))) {
      blockDepth++; buf += sql.slice(i, i + 5); i += 5; continue;
    }
    if (c === 'E' && /END\b/.test(sql.slice(i, i + 3))) {
      if (blockDepth > 0) blockDepth--; buf += sql.slice(i, i + 3); i += 3; continue;
    }
    // R158.X.99.27 (2026-10-19) — MySQL IF/THEN/END IF block tracking.
    // MySQL dialect uses `IF ... THEN ... END IF;` for conditional DDL
    // (vs MSSQL's `IF ... BEGIN ... END`). The 9 mysql sibling .sql files
    // (1.0.1/5/8-13/18) use 1-5 levels of nested IF/END IF guards with
    // `;` inside each block. Without tracking these blocks, the splitter
    // would break on every inner `;`, sending partial IF guards to the
    // driver and corrupting the 5-level IF cascade in 1.0.18.
    // ⚠ 2026-10-23 复核: `db/migrations/mysql/` 下**只剩 1.0.0-baseline.sql**,
    //   全文 0 处 `^IF`, 即那 9 个 sibling 文件已不在本仓库, 本分支目前是
    //   no-op。保留是因为 migrate 路径仍可能吃到外部/新增的 IF/THEN 文件,
    //   删它属于本次范围外的独立决策。
    if (c === 'I' && /IF\b/.test(sql.slice(i, i + 2))) {
      // Only treat as block opener if NOT preceded by `END ` (i.e. END IF).
      // Look back in buf for `END ` keyword.
      const bufEnd = buf.trimEnd();
      // R158.X.99 (2026-10-23) — 单行式 IF NOT EXISTS ... 不算块开始。
      //   MSSQL baseline 有 328 处这种守卫:
      //       IF NOT EXISTS (SELECT 1 FROM t WHERE k = 'v')
      //         INSERT INTO t (...) VALUES (...);
      //   它**没有 BEGIN/END 也没有 END IF**, 但旧逻辑照样 blockDepth++,
      //   于是永不归零 → 之后每个 `;` 都被 :139 的 `blockDepth === 0` 门吞掉,
      //   整份 baseline 只切出 7 条 (第 1 条 91069 字符的 DDL 大杂烩)。
      //   生产库之所以没炸: DDL 段全靠 `GO` 强制 flush, 且 mssql.js:187 的
      //   request.batch() 能一次执行一整坨 —— 能跑 ≠ 切对了。
      //   判据: IF 与 BEGIN 之间必须只有空白 (同一逻辑行) 才算块开始。
      //   `IF ... BEGIN ... END` 型照旧开块; `IF ... THEN ... END IF` 型不走这条
      //   路径, 由下方 END IF 分支配对。
      const after = sql.slice(i);
      const lineEnd = after.indexOf('\n');
      const restOfLine = lineEnd >= 0 ? after.slice(2, lineEnd) : after.slice(2);
      if (/^\s*BEGIN\b/i.test(restOfLine) && !/END\s+$/.test(bufEnd)) {
        blockDepth++; buf += sql.slice(i, i + 2); i += 2; continue;
      }
    }
    // END IF: word-boundary match for `END IF` (6 chars). Lookahead from 'E'.
    if (c === 'E' && /END\s+IF\b/.test(sql.slice(i))) {
      // Find end of "END IF" token (whitespace/newline after IF).
      const m = /^(END\s+IF)\b/.exec(sql.slice(i));
      if (m) {
        if (blockDepth > 0) blockDepth--;
        buf += m[1]; i += m[1].length; continue;
      }
    }
    // Statement terminator: matches the current delimiter (default ';').
    // Single-char delimiter (e.g. ';'): at top level (blockDepth=0, not in
    // string/comment), `;` is ALWAYS a terminator regardless of what
    // character follows. Previously this branch only split when the next
    // char was \n / \r / another terminator / EOF — that over-restrictive
    // check caused `PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE
    // stmt;` (inline multi-statement chains) to be bundled into one
    // mega-statement, which MySQL then rejected with a syntax error
    // (round-50 migration 021 failure). The line comment and string-literal
    // branches above this point already prevent us from mis-splitting
    // inside `--` comments or `'...'` literals, so no extra guard is needed.
    if (currentDelim.length === 1 && c === currentDelim[0] && blockDepth === 0) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    // Multi-char delimiter (e.g. '$$'): split on exact match. Same logic as
    // the single-char case — at top level, the delimiter is always terminal.
    // (MySQL DELIMITER is only legal at the top level anyway.)
    if (currentDelim.length > 1 && c === currentDelim[0] && blockDepth === 0 &&
        sql.slice(i, i + currentDelim.length) === currentDelim) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i += currentDelim.length;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// ---------------------------------------------------------------------------
// R161.5 (2026-10-26) — 幂等冲突的判定与容忍
//
// ★ 现场 (操作员): POST /api/init/db/apply 500, err = "Duplicate column name
//   'display_name'", code = ER_DUP_FIELDNAME。
//
// ★ 根因链 (三层, 缺一不可):
//   1) baseline 的幂等守卫是「INFORMATION_SCHEMA 探针 → PREPARE → EXECUTE」
//      **三条独立语句、四次往返**, 探针与 ALTER **不是原子的**。
//   2) init 向导的 POST /db/apply 原本**没有任何互斥** —— 两个并发 apply 各自
//      跑完整 baseline, 两边的探针都在对方的 ALTER 之前跑完 (都判定"列不存在")
//      ⇒ 两边都执行 ALTER ⇒ 后到的那个撞 1060。
//      ⇒ **串行重跑是安全的** (探针返回 1 → 'SELECT 1' → 跳过),
//         **只有并发才炸** —— 这正是本次 500 的性质。
//   3) 前端 axios 的 timeout 是 30s (web/src/api/client.js), 而一次 apply 要跑
//      286 条语句 (真库实测 ~70s) ⇒ 前端**必然**先超时 ⇒ 引导操作员点"重试"
//      ⇒ 第二个 POST 在第一个还在后端跑的时候发出 ⇒ 并发 ⇒ 1060。
//
// ★ 这三个错误码的语义是"**目标状态已经达成**"(列/索引/表已存在), 不是"库坏了"
//   ⇒ 跳过该语句、继续往下跑, 并把冲突**记录下来**返回给调用方
//   (可观测, 不静默)。真正的语法/权限/连接错误照常抛出。
// ---------------------------------------------------------------------------
const IDEMPOTENT_CONFLICT_CODES = new Set([
  'ER_DUP_FIELDNAME',      // 1060 Duplicate column name
  'ER_DUP_KEYNAME',        // 1061 Duplicate key name
  'ER_TABLE_EXISTS_ERROR'  // 1050 Table already exists
]);

// MSSQL (tedious) 不走 `code`, 走 `number`:
const IDEMPOTENT_CONFLICT_NUMBERS = new Set([
  2705,  // Column names in each table must be unique
  1913,  // There is already an index named ... on table ...
  2714   // There is already an object named ... in the database
]);

/**
 * 判断一个错误是不是"幂等冲突"(目标对象已存在)。
 * MySQL 看 `code`, MSSQL (tedious) 看 `number` —— 双方言都要认。
 *
 * ★ R161.6 (2026-10-26) — 还要看 `err.originalError`:
 *   运行时那条路径 (src/db/index.js) 的 facade 会把驱动错误包成 DbError,
 *   而 DbError 的 `code` 是**归一化后的**名字 (ER_DUP_FIELDNAME 不在映射表里
 *   ⇒ 变成 'UNKNOWN'), `number` 干脆不复制 ⇒ 只看表层的 err.code/number
 *   会**漏判**幂等冲突 ⇒ bootstrap 路径上"目标对象已存在"照样把整个
 *   bootstrap 打挂 (它本该是 non-fatal 的)。原始错误挂在 originalError 上,
 *   两层都看才既不错判也不漏判。
 */
function isIdempotentConflict(err) {
  if (!err) return false;
  for (const candidate of [err, err.originalError]) {
    if (!candidate) continue;
    if (typeof candidate.code === 'string' && IDEMPOTENT_CONFLICT_CODES.has(candidate.code)) return true;
    if (typeof candidate.number === 'number' && IDEMPOTENT_CONFLICT_NUMBERS.has(candidate.number)) return true;
  }
  return false;
}

/** 取错误里"最原始"的那个错误 (DbError 会把驱动错误挂在 originalError 上)。 */
function unwrapError(err) {
  let current = err;
  // 最多剥 3 层, 防环。
  for (let i = 0; i < 3 && current && current.originalError; i += 1) {
    current = current.originalError;
  }
  return current || err;
}

/**
 * 逐条执行一个 SQL 文件。
 *
 * R161.5 (2026-10-26) — 容忍幂等冲突:
 *   opts.conflicts — 数组, 冲突记录会 push 进去 (可选; 不传就只跳不记)
 *   opts.logger    — pino logger, 每条冲突 warn 一条 (可选)
 *   其它错误照常抛出 —— 绝不静默吞掉。
 *
 * ★ R161.6 (2026-10-26) — 固定连接:
 *   MySQL 基线的幂等守卫是
 *     SET @s = (SELECT IF(<INFORMATION_SCHEMA 探针>, '<DDL>', 'SELECT 1'));
 *     PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
 *   @s 与 stmt 都是**连接级状态** —— 逐条 db.execute (每次从池里借还连接)
 *   可能让这几条落在**不同连接**上 ⇒ PREPARE FROM NULL (ER_PARSE_ERROR 1064)
 *   或拿到上一轮的陈旧 @s (⇒ 重复执行上一轮的 ALTER → ER_DUP_FIELDNAME 1060)。
 *   ⇒ db 提供 session() 时, 整份文件跑在**一条固定连接**上。
 *   MSSQL 侧没有 session() (它的守卫是自包含的单批 IF NOT EXISTS),
 *   此时逐条 execute —— 与从前逐字一致。
 *
 * 返回值仍是语句数组 (调用方 applyAll 把它放进 applied.schema)。
 */
async function applyFile(db, filePath, opts = {}) {
  const sql = readFileSync(filePath, 'utf8');
  const stmts = splitSqlStatements(sql);
  const conflicts = Array.isArray(opts.conflicts) ? opts.conflicts : [];
  const logger = opts.logger || null;

  async function runStatements(execute) {
    for (const s of stmts) {
      try {
        await execute(s, []);
      } catch (err) {
        if (!isIdempotentConflict(err)) throw err;
        // 目标状态已达成 (列/索引/表已存在) ⇒ 跳过这条, 但**记录**下来, 让调用方
        // 和操作员都能看见 (不静默)。
        const raw = unwrapError(err);
        const entry = {
          code: typeof raw?.code === 'string' ? raw.code : null,
          number: typeof raw?.number === 'number' ? raw.number : null,
          message: err.message,
          statement: s
        };
        conflicts.push(entry);
        if (logger && typeof logger.warn === 'function') {
          logger.warn({
            err: err.message,
            code: entry.code,
            number: entry.number,
            statement: s.slice(0, 300)
          }, 'init schema 幂等冲突已跳过 (目标对象已存在)');
        }
      }
    }
  }

  if (typeof db.session === 'function') {
    await db.session(async (sess) => {
      await runStatements((s, p) => sess.execute(s, p));
    });
  } else {
    await runStatements((s, p) => db.execute(s, p));
  }
  return stmts;
}

// Resolve a SQL file path: db/{kind}/{dialect}/<name>.
//
// R161.2 (2026-10-25) — 之前这里是"优先方言目录, 缺失就回退到 db/{kind}/<name>",
// 那条回退路径是 R158.51 (2026-10-22) 方言拆分之前的布局留下的, 指向的顶层
// 旧快照已经过时且**残缺**: 它只有 54 张表 (MySQL 方言基线已 75 张), 而且它
// 经历过一次有损编码往返, 第 776 行的 `CREATE TABLE IF NOT EXISTS ad_forest (`
// 粘在了 `--` 注释行尾 ⇒ 那张表从未被创建 ⇒ 3 个引用它的外键必然失败。
//
// 后果不是"报错", 而是**静默装出错库**: 初始化向导会显示成功, 然后应用在
// 完全不相干的地方报"表不存在"。安全网是张废网, 不如让它消失 —— 现在只认
// 方言路径, 找不到就返回 null, 由调用方按各自的语义处理:
//   - applyAll (初始化向导) 必须**大声报错**: 这正是操作员该看到现场的时机
//   - bootstrapMigrations (启动自举) 允许没有 db/ (runtime-only bundle),
//     沿用旧行为静默返回
function resolveSqlPath(repoRoot, kind, dialect, name) {
  const dialectPath = join(repoRoot, 'db', kind, dialect, name);
  return existsSync(dialectPath) ? dialectPath : null;
}

// 同理: 迁移目录只认方言子目录。顶层 db/migrations 里只有方言子目录, 回退到
// 它等于"没有迁移" —— 静默跳过比报错更糟。
function resolveMigrationsDir(repoRoot, dialect) {
  const dialectDir = join(repoRoot, 'db', 'migrations', dialect);
  return existsSync(dialectDir) ? dialectDir : null;
}

// Find the repo root at runtime. An explicit caller-pinned path (opts.repoRoot)
// always wins — tests use it to point at a fixture, prod config can pin a
// non-standard layout. The candidate fallback only runs when no path is given:
// the install script copies db/ to <InstallPath>/../db/ so cwd/.. works for the
// default layout, but older installs (pre-db-copy-fix) or operators who keep
// db/ at the publish-root only land at cwd/../.. or cwd itself.
//
//   1. opts.repoRoot (caller-provided — used verbatim, NOT validated against
//      the candidate list; honoring the caller's pin is the whole point)
//   2. ADDASHBOARD_REPO_ROOT env var (set on the NSSM service for non-standard
//      layouts without re-running install)
//   3. cwd/.. (default install layout — <InstallPath>/.. = <parent>)
//   4. cwd/../.. (InPlace layout — <publish-root>/center/../.. = <publish-root>)
//   5. cwd itself (db/ co-located with install dir, rare)
// Each fallback candidate is only accepted if it actually contains a db/
// subdir; otherwise we keep looking. Falling back to cwd/.. at the end
// preserves the legacy default so the ENOENT surfaces where to look.
//
// R161.17 (2026-10-27) — 导出给 init 向导用: 向导的 /db/apply 之后要跑
//   待补的编号迁移, 而迁移引擎 (services/migrations.js) 需要同一个 repoRoot
//   才能找到 db/migrations/<dialect>/。两处各自解析的话, 解析结果可能不同
//   (cwd 在两次调用之间变了), 那就会出现"基线从 A 读、迁移从 B 读"的分裂。
export function resolveRepoRoot(opts) {
  if (opts.repoRoot) return opts.repoRoot;
  const cwd = process.cwd();
  const candidates = [
    process.env.ADDASHBOARD_REPO_ROOT,
    join(cwd, '..'),
    join(cwd, '..', '..'),
    cwd,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'db'))) return c;
  }
  return join(cwd, '..');
}

// R158.51 (2026-10-08) — baseline freeze. applyAll now reads the frozen
// 1.0.0-baseline.sql (which already absorbs every CREATE + seed INSERT).
// The previous dual-file path (db/schema/01-tables.sql + 02-seed-roles.sql)
// is gone: schema/ directory deleted, seed folded into baseline.
//
// ★ R161.5 (2026-10-26) — 并发 apply 的 single-flight 互斥。
//   键 = 方言 + 库名 (同一个库的 DDL 目标就是同一个)。同一时刻只允许一个
//   apply 在跑: 后来者**复用**在飞的那一次的结果 (而不是重跑一遍 DDL);
//   若在飞的那次失败了, 后来者**串行**重跑一次 (此时已无并发, 守卫链幂等 ⇒
//   这次应当干净通过)。互斥是**主防线** —— 冲突容忍只是兜底。
const APPLY_INFLIGHT = new Map();

/**
 * 带互斥的 apply 入口 (内部使用)。
 *
 * @param {string} dialect  'mysql' | 'mssql'
 * @param {object} db       driver 句柄
 * @param {object} opts     { repoRoot, createDatabase, databaseName, logger }
 * @param {string} key      互斥键
 * @param {number} attempt  内部重试计数 (只允许一次串行重跑)
 */
async function runApplyExclusive(dialect, db, opts, key, attempt = 0) {
  const inflight = APPLY_INFLIGHT.get(key);
  if (inflight) {
    // 已经有一次 apply 在跑 ⇒ 等它, 复用它的结果。
    try {
      return await inflight.promise;
    } catch (err) {
      // 在飞的那次失败了。互斥记录在它 settle 时就已摘除, 所以这里**没有并发**,
      // 串行重跑一次是安全的 (守卫链幂等)。只重跑一次, 避免无限循环。
      if (attempt >= 1) throw err;
      const logger = opts.logger || null;
      if (logger && typeof logger.warn === 'function') {
        logger.warn({ err: err.message, code: err.code, key }, 'init schema apply 在飞的那次失败, 串行重跑一次');
      }
      return runApplyExclusive(dialect, db, opts, key, attempt + 1);
    }
  }

  // 我是第一个 ⇒ 登记 in-flight, 然后跑。
  const record = { promise: null };
  record.promise = applyAllInternal(dialect, db, opts).finally(() => {
    // settle 时摘除 —— 这样等待者 catch 到失败后再跑一轮时, 不会撞上自己。
    if (APPLY_INFLIGHT.get(key) === record) APPLY_INFLIGHT.delete(key);
  });
  APPLY_INFLIGHT.set(key, record);
  return record.promise;
}

/**
 * applyAll 的真正实现 (调用方已拿到互斥)。
 *
 * 返回 { schema, seed, migrations, conflicts }:
 *   schema     — baseline 的语句数组
 *   conflicts  — R161.5: 被跳过的幂等冲突 (列/索引/表已存在), 可观测
 */
async function applyAllInternal(dialect, db, opts = {}) {
  const repoRoot = resolveRepoRoot(opts);

  const applied = { schema: [], seed: [], migrations: [], conflicts: [] };

  if (opts.createDatabase && dialect === 'mysql') {
    // Caller should have provided db name in opts.databaseName
    const dbName = opts.databaseName;
    if (dbName) {
      // ★ R161.6 (2026-10-26) — 建库必须在**不绑定目标库**的 server 级连接上做。
      //   db 句柄的池是按 `database: <目标库>` 建的, 目标库还不存在时, 连接
      //   握手阶段就 ER_BAD_DB_ERROR (1049) —— 旧实现那句
      //   `CREATE DATABASE IF NOT EXISTS` **根本执行不到** (全新安装必挂)。
      //   db.createDatabase 走 driver 的 server 级连接池 ⇒ 真的能建。
      //   没有 createDatabase 的 db (老 facade / 测试假 db) 才退回旧写法,
      //   并且**先校验库名** —— 库名会拼进 DDL, 必须挡住注入。
      if (typeof db.createDatabase === 'function') {
        await db.createDatabase(dbName);
      } else {
        const safeName = assertValidDatabaseName(dbName);
        await db.execute(
          `CREATE DATABASE IF NOT EXISTS \`${safeName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
          []
        );
      }
    }
  }

  // Single-file baseline — runs schema + seed in one go (seed INSERTs are
  // guarded with INSERT IGNORE / IF NOT EXISTS so re-running is a no-op).
  //
  // R161.2: 基线文件缺失必须**大声报错**。旧实现在这里回退到 db/migrations/
  // 顶层的过时 MySQL 快照 (54 表残缺版), 初始化会"显示成功"并留下一棵缺表的库,
  // 故障现场落在完全不相干的地方。
  const baselineFile = resolveSqlPath(repoRoot, 'migrations', dialect, '1.0.0-baseline.sql');
  if (!baselineFile) {
    throw new Error(
      `[init] 找不到基线文件 db/migrations/${dialect}/1.0.0-baseline.sql —— ` +
      `请确认部署里带上了 db/migrations/${dialect}/ 目录。` +
      ` (R161.2: 不再回退到顶层旧快照, 那份是 R158.51 之前的残缺 MySQL 基线)`,
    );
  }
  applied.schema = await applyFile(db, baselineFile, {
    conflicts: applied.conflicts,
    logger: opts.logger || null
  });
  applied.seed = [];   // folded into baseline; kept in response shape for API compat

  // After applyAll, the caller (init wizard) should run backfillMigrations
  // to record the baseline in schema_migrations with applied_by='system-init'.
  // This avoids re-running the DDL on every startup.

  return applied;
}

/**
 * 对某个库执行完整基线 (schema + seed)。
 *
 * R161.5 (2026-10-26): 同一库的并发调用会被**串行化** (single-flight) ——
 * 后来者复用先到者的结果, 不重跑 DDL。
 */
export async function applyAll(dialect, db, opts = {}) {
  const key = `${dialect}:${String(opts.databaseName || '').toLowerCase()}`;
  return runApplyExclusive(dialect, db, opts, key);
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

// Resolve the JS helper path for a given migration version, mirroring the
// shape of `resolveFile`/`resolveJsFile` in services/migrations.js. Returns
// the absolute path of the version-matched .js sibling, or null when the
// migration has no JS step. Used by the backfill path below to invoke the
// R66-style data migration that needs fs reads + sha256 (not expressible
// in raw SQL).
function resolveMigrationJsFile(dir, version) {
  const entries = readdirSync(dir);
  const match = entries.find(f => f.startsWith(version + '-') && f.endsWith('.js'));
  return match ? join(dir, match) : null;
}

// Record every migration file on disk as already-applied. Used by two paths:
//   1. the init wizard, right after applyAll() ran every file for real;
//   2. bootstrapMigrations(), when an existing deployment first gains the
//      schema_migrations table and its pre-009 history has to be reconstructed.
// Both cases mean "these files are already in the DB", hence applied_by
// 'system-init' and execution_ms 0 — we did not time the original run.
// Idempotent: the upsert keys on `version`, so re-running is a no-op update.
//
// DB H4 (2026-09-22): a .js sibling of a SQL migration (e.g. R66's
// `023-package-scripts-policies-split.js`) is also a "migration" and must
// be recorded. Previously the readdirSync filter at line 208 (now below)
// only matched .sql files, so on a fresh install `023-*.js` was never
// recorded and the admin Schema Migrations page kept listing it as pending
// even though 01-tables.sql already created `package_scripts` +
// `package_policies`. The fix is to include .js files in the same loop;
// the .js branch dynamically imports the module, invokes the exported
// `migrateInstalledPackagesToTwoTable({db, dataDir, writeAudit})` helper
// (safe on a fresh DB — the helper short-circuits when `installed_packages`
// has 0 rows), and upserts the row with `type='js'`.
//
// .js files have no verify markers (verify markers are an SQL-only
// concept), so the marker probe is skipped. The .sql sibling is the
// authority for "is the schema present?" — if its markers fail the probe,
// the .js record is also skipped to keep the row pair consistent.
export async function backfillMigrations(dialect, db, opts = {}) {
  const repoRoot = resolveRepoRoot(opts);
  const dir = resolveMigrationsDir(repoRoot, dialect);
  if (!dir) return { count: 0, skipped: [] };   // R161.2: 方言目录缺失 ⇒ 没有迁移可登记
  // SQL files must be iterated BEFORE their .js siblings so the
  // skipped-versions set is populated in time for the lockstep gate
  // below (see comment before the loop). The natural lex sort would put
  // `…023-foo.js` ahead of `…023-foo.sql` because `j` < `s`, so we
  // partition by extension first.
  const allFiles = readdirSync(dir)
    .filter(f => f.endsWith('.sql') || f.endsWith('.js'));
  const sqlFiles = allFiles.filter(f => f.endsWith('.sql')).sort();
  const jsFiles = allFiles.filter(f => f.endsWith('.js')).sort();
  const files = [...sqlFiles, ...jsFiles];
  // MySQL DATETIME rejects ISO 8601 strings; the schema_migrations.applied_at
  // column is DATETIME on MySQL. Pre-format per the convention in db/drivers/mysql.js.
  const appliedAt = dialect === 'mysql' ? toMysqlDatetime(new Date()) : new Date().toISOString();
  const logger = opts.logger ?? console;
  const getDataDir = opts.getDataDir ?? null;
  const writeAudit = opts.writeAudit ?? null;
  let count = 0;
  const skipped = [];
  // Track which versions had their .sql migration skipped because its
  // verify markers failed. The corresponding .js sibling must share that
  // fate: if the schema was never created by the SQL, the data migration
  // couldn't have run either. Without this gate, the .js row would claim
  // `applied` against a DB that's missing the underlying tables.
  //
  // Pre-scan all .sql files FIRST (filename-sorted) so the skipped-version
  // set is fully populated before any .js file is considered. The natural
  // lex sort puts `…023-foo.js` ahead of `…023-foo.sql` because `j` < `s`,
  // so a single-pass approach that just relies on iteration order would
  // let the .js row slip through. The two-pass split above (SQL before JS)
  // keeps the contract honest.
  const skippedVersions = new Set();
  for (const f of files) {
    const isSql = f.endsWith('.sql');
    // R158.X.116.p.3 (2026-10-23) — 原为 /^\d{3}-([a-z0-9-]+)\.(sql|js)$/,
    //   它要求「恰好 3 位数字 + 短横线」, 于是 R158.51 baseline freeze 之后的
    //   `1.0.0-baseline.sql` **匹配失败** → 循环里 continue 掉 → count 恒 0。
    //   直接后果: fresh 部署时 bootstrapMigrations 建好了 schema_migrations 表
    //   (表来自 baseline 自身的 DDL), 却一行记录都不回填 —— 与它上一行注释
    //   "Backfill the baseline row so schema_migrations has 1.0.0 applied"
    //   自相矛盾。admin「Schema Migrations」页显示空列表, 操作员无从判断
    //   这台机器的 schema 是否完整。
    //   ⚠ 稳态服务不受影响: bootstrapMigrations 开头的
    //   `SELECT 1 FROM schema_migrations LIMIT 1` 探针在表存在时就 return,
    //   所以这是「可观测性缺失」而非「功能故障」。
    //   修法: 对齐 migrations.js:94 parseFileMeta 已有的 semver 规则 (R158.42
    //   就写了 "Accepts both legacy 3-digit prefix and semver") —— 那才是
    //   本项目的权威解析器, 此处是漏改的一侧。
    const re = isSql
      ? /^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i
      : /^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.js$/i;
    const m = f.match(re);
    if (!m) continue;
    const version = m[1];
    const description = m[2];
    const filePath = join(dir, f);
    const content = readFileSync(filePath, 'utf8');

    // Lockstep gate — if the SQL sibling for this version was already
    // skipped on a prior iteration (sort order is filename-based and JS
    // sorts after its SQL sibling, but earlier files may have other
    // .sql markers that put this version on the skip list), propagate.
    // Prevents a half-applied row pair where the JS says "applied" but
    // the schema (created by the SQL) is absent.
    if (!isSql && skippedVersions.has(version)) {
      skipped.push({
        file: f,
        version,
        missing: [`js: sql sibling ${version} verify markers failed — skipping js to keep row pair consistent`]
      });
      continue;
    }

    if (isSql) {
      // If the SQL file declares verify markers, probe the DB — only backfill
      // the row when every marker is present. A missing marker means the
      // migration was never actually applied to this DB; warn + skip so the
      // admin /api/admin/migrations list surfaces it as pending.
      const markers = parseVerifyMarker(content);
      if (markers.length > 0) {
        const { ok, missing } = await verifyMarkers(db, markers);
        if (!ok) {
          // ★ R161.17 (2026-10-27) — 措辞要说清"缺的是**库里的产物**", 不是
          //   "文件里没写标记"。文件里的标记明明在 (markers.length > 0),
          //   探针查的是**这些标记指向的表/列/索引在不在库里** —— 不在, 说明
          //   这个迁移的产物还没落到这个库上, 所以**不能登记成 applied**。
          //   旧措辞 "verify markers missing" 会被读成"文件里没声明标记",
          //   而那条路径 (markers.length === 0) 恰恰是**直接登记**的, 一旦读反
          //   就会得出完全相反的结论。
          logger.warn?.(
            { file: f, version, missing },
            'verify 探针未通过 (标记指向的对象不在库里) — 不登记为 applied, 留给迁移引擎真的跑一遍'
          );
          skipped.push({ file: f, version, missing });
          skippedVersions.add(version);
          continue;
        }
      }
    }

    // For .js siblings, actually run the helper on a fresh install so that:
    //   - on a *fresh* DB the helper is a no-op (installed_packages has 0
    //     rows → early return), but we still record the migration;
    //   - on an *upgrade-path* backfill (older deployments whose
    //     schema_migrations table is being reconstructed), the helper
    //     performs the data migration into the just-created
    //     package_scripts + package_policies tables.
    //
    // Both cases end in a single upsert with `type='js'`; the helper
    // itself is idempotent (early-return on 0 rows, FK probe before drop).
    if (!isSql) {
      try {
        const jsUrl = pathToFileURL(filePath).href;
        const mod = await import(jsUrl);
        const fn = mod.migrateInstalledPackagesToTwoTable ?? mod.default;
        if (typeof fn !== 'function') {
          throw new Error(`migration ${version} JS helper did not export migrateInstalledPackagesToTwoTable`);
        }
        const dataDir = (getDataDir ? getDataDir() : null) || `${process.cwd()}/data/packages`;
        await fn({ db, dataDir, writeAudit });
      } catch (jsErr) {
        logger.warn?.({ err: jsErr.message, version, file: f }, 'migration JS helper failed during backfill — skipping');
        skipped.push({ file: f, version, missing: [`js: ${jsErr.message}`] });
        continue;
      }
    }

    const checksum = sha256(content);
    const type = isSql ? 'sql' : 'js';
    // Param order matches the upsert column list in db/sql.js:
    // (version, description, type, script, checksum, applied_at,
    //  execution_ms, applied_by, status, error_message)
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, description, type, f, checksum,
      appliedAt, 0, 'system-init', 'applied', null
    ]);
    count++;
  }
  return { count, skipped };
}

// Probe SQL for "does schema_migrations exist?". MSSQL has no LIMIT clause,
// so the two dialects need different shapes.
function existsProbeSql(dialect) {
  return dialect === 'mssql'
    ? 'SELECT TOP 1 1 AS ok FROM schema_migrations'
    : 'SELECT 1 AS ok FROM schema_migrations LIMIT 1';
}

// Ensure schema_migrations exists and reflects the baseline on disk.
// Called from db.init() on every server start, so it must be cheap and
// idempotent:
//   - table present (the common case, incl. fresh init-wizard installs where
//     applyAll already ran the baseline) -> one SELECT, then return;
//   - table absent (a deployment upgrading from pre-009 code) -> apply the
//     baseline file (which now also contains the schema_migrations CREATE
//     TABLE statement as part of the absorbed 009), then backfill the
//     baseline row.
//
// R158.51 (2026-10-08) — the bootstrap entry point no longer references
// 009-schema-migrations.sql as a separate file. The baseline file's body
// already absorbs the schema_migrations CREATE TABLE block, so a pre-009
// deployment that runs the baseline gets the bookkeeping table for free.
export async function bootstrapMigrations(dialect, db, opts = {}) {
  try {
    await db.query(existsProbeSql(dialect), []);
    return; // table exists; nothing to bootstrap
  } catch {
    // Table doesn't exist — fall through to apply baseline + backfill.
  }
  const repoRoot = resolveRepoRoot(opts);
  const baselineFile = resolveSqlPath(repoRoot, 'migrations', dialect, '1.0.0-baseline.sql');
  // A deployment can legitimately ship without db/migrations (runtime-only
  // bundles). Nothing to bootstrap from, so leave the DB untouched.
  // R161.2: 解析函数现在只认方言路径, 缺失时返回 null (不再回退到顶层旧快照)。
  if (!baselineFile) return;
  const bootstrapConflicts = [];
  await applyFile(db, baselineFile, {
    // R161.5 (2026-10-26) — 启动自举也可能与另一次 apply 并发 (例如两台
    //   center 同时起), 撞出的幂等冲突必须被**跳过并留痕**, 不能让整个
    //   bootstrap 失败 —— bootstrap 是 non-fatal 的 (见 db/index.js)。
    conflicts: bootstrapConflicts,
    logger: opts.logger || null
  });
  if (bootstrapConflicts.length > 0) {
    const msg = `bootstrapMigrations 跳过了 ${bootstrapConflicts.length} 条幂等冲突 (目标对象已存在)`;
    const logger = opts.logger || null;
    if (logger && typeof logger.warn === 'function') logger.warn({ count: bootstrapConflicts.length }, msg);
    else console.warn(`[init] ${msg}`);
  }
  // Backfill the baseline row so schema_migrations has 1.0.0 applied. Idempotent.
  await backfillMigrations(dialect, db, {
    repoRoot,
    getDataDir: opts.getDataDir ?? null,
    writeAudit: opts.writeAudit ?? null
  });
}
