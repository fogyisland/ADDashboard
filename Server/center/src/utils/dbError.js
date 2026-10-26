// center/src/utils/dbError.js
// R161.11 (2026-10-26) — 数据库错误分类器 (MySQL + MSSQL 双方言)
//
// ★ 为什么要这个文件:
//   现场 (操作员) 「邮件队列和邮件历史两个界面出错, 也就是数据如果是空感觉
//   会出问题」—— 两个端点都 500, 但服务端**一行日志都没有** (NSSM AppStderr='',
//   stderr 被丢弃; 路由自己的 catch 也没落 pino), 于是"表不存在"和"连接断了"
//   和"SQL 写错了"三件事在页面上长得一模一样: 一个 500。
//   ⇒ 分类器的职责: 把驱动的原始错误翻译成**可判定的 kind**, 让路由层能
//   决定"降级成空列表"还是"继续报 500"。
//
// ★ 双方言是硬要求 (memory: MySQL + MSSQL dual support on every change):
//   - MySQL (mysql2): 顶层 `err.code` 是字符串 ('ER_NO_SUCH_TABLE'), `err.errno`
//     是数字 (1146); 但本项目的 db facade 会把驱动错误包成 DbError, **顶层
//     code 可能是归一化后的 'UNKNOWN'** ⇒ 必须也看 `err.originalError`。
//   - MSSQL (tedious): 走 `err.number` (208 = Invalid object name), 没有 code。
//
// ★ 判定顺序 (先结构化字段, 后 message 兜底):
//   1. err.code (字符串) → MySQL 错误名
//   2. err.errno (数字)  → MySQL 错误号
//   3. err.number (数字) → MSSQL 错误号
//   4. err.originalError → 回到第 1 步 (最多剥 3 层)
//   5. message 正则兜底 (驱动/包装层把 code 丢了的情形)
//
// ★ 关于"表缺失"要不要算错误:
//   算 —— 但**不等于"页面报错"**。缺表是 schema 漂移 (基线没跑完), 页面
//   仍然应该能打开、能显示"队列为空 + 缺表提示", 而不是 500 让人以为服务挂了。
//   判定为 table_missing / column_missing 时由路由层降级 (degraded), 并在
//   pino 里留 error 级日志 —— 既不静默, 也不挡路。

// 错误类别。值是稳定的对外契约 (会出现在 HTTP 响应体和前端提示里)。
export const DB_ERROR_KIND = {
  TABLE_MISSING: 'table_missing',
  COLUMN_MISSING: 'column_missing',
  SYNTAX: 'syntax',
  CONNECTION: 'connection',
  CONSTRAINT: 'constraint',
  OTHER: 'other'
};

// MySQL 错误名 (err.code) → 类别。
const MYSQL_CODE_KIND = new Map([
  // 1046 / 1051 — 表不存在
  ['ER_NO_SUCH_TABLE', DB_ERROR_KIND.TABLE_MISSING],
  ['ER_BAD_TABLE_ERROR', DB_ERROR_KIND.TABLE_MISSING],
  // 1054 — 列不存在
  ['ER_BAD_FIELD_ERROR', DB_ERROR_KIND.COLUMN_MISSING],
  // 1064 语法错 / 1210 预处理语句参数类型不合法 ("Incorrect arguments to
  // mysqld_stmt_execute" —— R161.10 记录的 prepared 协议坑)
  ['ER_PARSE_ERROR', DB_ERROR_KIND.SYNTAX],
  ['ER_WRONG_ARGUMENTS', DB_ERROR_KIND.SYNTAX],
  // 约束类
  ['ER_DUP_ENTRY', DB_ERROR_KIND.CONSTRAINT],
  ['ER_NO_REFERENCED_ROW', DB_ERROR_KIND.CONSTRAINT],
  ['ER_NO_REFERENCED_ROW_2', DB_ERROR_KIND.CONSTRAINT],
  ['ER_ROW_IS_REFERENCED', DB_ERROR_KIND.CONSTRAINT],
  ['ER_ROW_IS_REFERENCED_2', DB_ERROR_KIND.CONSTRAINT],
  ['ER_LOCK_DEADLOCK', DB_ERROR_KIND.CONSTRAINT],
  ['ER_LOCK_WAIT_TIMEOUT', DB_ERROR_KIND.CONSTRAINT],
  // 连接类
  ['ER_BAD_DB_ERROR', DB_ERROR_KIND.CONNECTION],
  ['ER_CON_COUNT_ERROR', DB_ERROR_KIND.CONNECTION],
  ['ER_SERVER_SHUTDOWN', DB_ERROR_KIND.CONNECTION],
  ['ECONNREFUSED', DB_ERROR_KIND.CONNECTION],
  ['ECONNRESET', DB_ERROR_KIND.CONNECTION],
  ['EPIPE', DB_ERROR_KIND.CONNECTION],
  ['ETIMEDOUT', DB_ERROR_KIND.CONNECTION],
  ['EHOSTUNREACH', DB_ERROR_KIND.CONNECTION],
  ['ENOTFOUND', DB_ERROR_KIND.CONNECTION],
  ['PROTOCOL_CONNECTION_LOST', DB_ERROR_KIND.CONNECTION],
  ['PROTOCOL_ENQUEUE_AFTER_QUIT', DB_ERROR_KIND.CONNECTION],
  ['PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', DB_ERROR_KIND.CONNECTION],
  ['PROTOCOL_SEQUENCE_TIMEOUT', DB_ERROR_KIND.CONNECTION]
]);

// MySQL 错误号 (err.errno) → 类别。code 丢了时的兜底。
// ★ 号码必须核对过 MySQL 官方错误表 (R161.11 实测踩坑):
//   ER_NO_SUCH_TABLE = **1146** (不是 1046 —— 1046 是 ER_NO_DB "No database
//   selected")。写错成 1046 的后果: code 被剥掉时"表不存在"被判成 other
//   ⇒ 页面 500 而不是降级成空列表。
const MYSQL_ERRNO_KIND = new Map([
  [1146, DB_ERROR_KIND.TABLE_MISSING],   // ER_NO_SUCH_TABLE
  [1051, DB_ERROR_KIND.TABLE_MISSING],   // ER_BAD_TABLE_ERROR
  [1054, DB_ERROR_KIND.COLUMN_MISSING],  // ER_BAD_FIELD_ERROR
  [1064, DB_ERROR_KIND.SYNTAX],          // ER_PARSE_ERROR
  [1210, DB_ERROR_KIND.SYNTAX],          // ER_WRONG_ARGUMENTS
  [1049, DB_ERROR_KIND.CONNECTION],      // ER_BAD_DB_ERROR
  [1040, DB_ERROR_KIND.CONNECTION],      // ER_CON_COUNT_ERROR
  [1062, DB_ERROR_KIND.CONSTRAINT],      // ER_DUP_ENTRY
  [1216, DB_ERROR_KIND.CONSTRAINT],      // ER_NO_REFERENCED_ROW
  [1452, DB_ERROR_KIND.CONSTRAINT],      // ER_NO_REFERENCED_ROW_2
  [1217, DB_ERROR_KIND.CONSTRAINT],      // ER_ROW_IS_REFERENCED
  [1451, DB_ERROR_KIND.CONSTRAINT],      // ER_ROW_IS_REFERENCED_2
  [1205, DB_ERROR_KIND.CONSTRAINT],      // ER_LOCK_WAIT_TIMEOUT
  [1213, DB_ERROR_KIND.CONSTRAINT]       // ER_LOCK_DEADLOCK
]);

// MSSQL 错误号 (err.number) → 类别。
const MSSQL_NUMBER_KIND = new Map([
  [208, DB_ERROR_KIND.TABLE_MISSING],   // Invalid object name 'x'.
  [207, DB_ERROR_KIND.COLUMN_MISSING],  // Invalid column name 'x'.
  [4902, DB_ERROR_KIND.COLUMN_MISSING], // column not found
  [2812, DB_ERROR_KIND.SYNTAX],         // Could not find stored procedure
  [470, DB_ERROR_KIND.SYNTAX],          // syntax error
  [102, DB_ERROR_KIND.SYNTAX],          // incorrect syntax near
  [229, DB_ERROR_KIND.CONSTRAINT],      // permission denied
  [2627, DB_ERROR_KIND.CONSTRAINT],     // unique constraint violation
  [2601, DB_ERROR_KIND.CONSTRAINT],     // duplicate key
  [547, DB_ERROR_KIND.CONSTRAINT],      // constraint conflict
  [471, DB_ERROR_KIND.CONSTRAINT],      // constraint conflict
  [18456, DB_ERROR_KIND.CONNECTION],    // login failed
  [4060, DB_ERROR_KIND.CONNECTION]      // cannot open database
]);

// message 兜底正则 —— 最后一层, 结构化字段全丢时的救命稻草。
// 顺序有意义: 先表后列, 先精确后宽泛。
const MESSAGE_PATTERNS = [
  [/table\s+'[^']*'\s+doesn't exist/i, DB_ERROR_KIND.TABLE_MISSING],
  [/unknown table/i, DB_ERROR_KIND.TABLE_MISSING],
  [/invalid object name/i, DB_ERROR_KIND.TABLE_MISSING],
  [/undefined table/i, DB_ERROR_KIND.TABLE_MISSING],
  [/unknown column/i, DB_ERROR_KIND.COLUMN_MISSING],
  [/invalid column name/i, DB_ERROR_KIND.COLUMN_MISSING],
  [/column .* doesn't exist/i, DB_ERROR_KIND.COLUMN_MISSING],
  [/incorrect arguments to mysqld_stmt_execute/i, DB_ERROR_KIND.SYNTAX],
  [/you have an error in your sql syntax/i, DB_ERROR_KIND.SYNTAX],
  [/syntax error/i, DB_ERROR_KIND.SYNTAX],
  [/deadlock found/i, DB_ERROR_KIND.CONSTRAINT],
  [/duplicate entry/i, DB_ERROR_KIND.CONSTRAINT],
  [/cannot add foreign key constraint/i, DB_ERROR_KIND.CONSTRAINT],
  [/connection (refused|reset|lost|closed)/i, DB_ERROR_KIND.CONNECTION],
  [/connect econnrefused/i, DB_ERROR_KIND.CONNECTION],
  [/socket hang up/i, DB_ERROR_KIND.CONNECTION],
  [/read econnreset/i, DB_ERROR_KIND.CONNECTION],
  [/timeout/i, DB_ERROR_KIND.CONNECTION]
];

// 抓"缺哪个表/列"的名字 —— 降级提示要指名道姓, 不能只说"表缺失"。
const TABLE_NAME_PATTERNS = [
  /table\s+'([^']+)'\s+doesn't exist/i,
  /unknown table\s+'([^']+)'/i,
  /invalid object name\s+'([^']+)'/i
];

const COLUMN_NAME_PATTERNS = [
  /unknown column\s+'([^']+)'/i,
  /invalid column name\s+'([^']+)'/i,
  /column\s+'([^']+)'\s+doesn't exist/i
];

/**
 * 取错误链上最原始的那个错误 (最多剥 3 层, 防环)。
 * db facade 的 DbError 会把驱动错误挂在 originalError 上, code 归一化成
 * 'UNKNOWN' —— 不剥壳就会把"表不存在"误判成 other。
 */
export function unwrapDbError(err) {
  let current = err;
  for (let depth = 0; depth < 3 && current && current.originalError; depth += 1) {
    current = current.originalError;
  }
  return current || err;
}

/**
 * 分类一个数据库错误。
 *
 * @param {unknown} err 驱动/包装后的错误对象
 * @returns {{
 *   kind: string,          // DB_ERROR_KIND 之一
 *   code: string|null,     // 原始错误码 (MySQL code 名 / 驱动 code)
 *   errno: number|null,    // MySQL errno (1046/1054/1064 ...)
 *   number: number|null,   // MSSQL number (208/207/...)
 *   message: string,       // 原始 message
 *   missingTable: string|null,
 *   missingColumn: string|null,
 *   isSchemaDrift: boolean // 表/列缺失 ⇒ 可以降级成空列表
 * }}
 */
export function classifyDbError(err) {
  const message = err && err.message ? String(err.message) : String(err ?? '');
  const raw = unwrapDbError(err);

  const code = typeof raw?.code === 'string' ? raw.code : null;
  const errno = Number.isFinite(Number(raw?.errno)) ? Number(raw.errno) : null;
  const number = Number.isFinite(Number(raw?.number)) ? Number(raw.number) : null;

  let kind = null;
  if (code && MYSQL_CODE_KIND.has(code)) {
    kind = MYSQL_CODE_KIND.get(code);
  } else if (errno != null && MYSQL_ERRNO_KIND.has(errno)) {
    kind = MYSQL_ERRNO_KIND.get(errno);
  } else if (number != null && MSSQL_NUMBER_KIND.has(number)) {
    kind = MSSQL_NUMBER_KIND.get(number);
  }

  if (!kind) {
    for (const [pattern, candidate] of MESSAGE_PATTERNS) {
      if (pattern.test(message)) { kind = candidate; break; }
    }
  }

  let missingTable = null;
  for (const pattern of TABLE_NAME_PATTERNS) {
    const m = message.match(pattern);
    if (m) { missingTable = m[1]; break; }
  }
  let missingColumn = null;
  for (const pattern of COLUMN_NAME_PATTERNS) {
    const m = message.match(pattern);
    if (m) { missingColumn = m[1]; break; }
  }
  // 类别与抓到的名字互相校正 (message 说缺表但 code 认不出 ⇒ 仍然是缺表)。
  if (!kind) {
    if (missingTable) kind = DB_ERROR_KIND.TABLE_MISSING;
    else if (missingColumn) kind = DB_ERROR_KIND.COLUMN_MISSING;
  } else if (kind === DB_ERROR_KIND.TABLE_MISSING && !missingTable && missingColumn) {
    kind = DB_ERROR_KIND.COLUMN_MISSING;
  }

  return {
    kind: kind || DB_ERROR_KIND.OTHER,
    code,
    errno,
    number,
    message,
    missingTable,
    missingColumn,
    isSchemaDrift: kind === DB_ERROR_KIND.TABLE_MISSING || kind === DB_ERROR_KIND.COLUMN_MISSING
  };
}

// 降级时给操作员看的中文说明 (前端直接显示, 不再自己拼)。
export const DEGRADE_REASON_TEXT = {
  [DB_ERROR_KIND.TABLE_MISSING]: '队列表缺失 (数据库基线未完整应用)',
  [DB_ERROR_KIND.COLUMN_MISSING]: '队列表结构不完整 (缺列, 数据库基线未完整应用)'
};

// 表缺失 / 列缺失 ⇒ 允许降级成"空列表 + 提示", 而不是 500。
export function isDegradableKind(kind) {
  return kind === DB_ERROR_KIND.TABLE_MISSING || kind === DB_ERROR_KIND.COLUMN_MISSING;
}
