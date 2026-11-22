// center/src/utils/errorSanitizer.js
// R161.34 (2026-11-07) — 对外错误消息脱敏 (安全批次 S6)。
//
// ★ 漏洞本体:
//   多个路由把 catch 里的 `e.message` **原样**放进 HTTP 响应体:
//     · routes/healthz.js  → `res.status(503).json({ status:'degraded', error: e.message })`
//     · routes/system.js    → `res.status(500).json({ error:'internal', message: e.message })`
//   ⇒ 原始异常消息里通常带着**内部实现细节**: SQL 语句片段、表名、列名、
//     连接串、文件路径、驱动内部堆栈首行。
//   ⇒ 这些信息对操作员**没有用** (他们要的是"服务挂了 + 日志里有细节"),
//     但对攻击者很有用: 它把 schema 和内部结构直接交出去, 让后续攻击
//     从"猜"变成"照着做"。
//   ⇒ 修法 = **响应体里只回稳定的、无信息量的短语**; 完整原文只进 pino
//     (服务端日志, 操作员能看到)。
//
// ★ 为什么不能简单地"把 message 换成 'internal error'":
//   操作员看页面时会想知道是**数据库**挂了还是**代码**炸了 —— 纯黑箱
//   会让他们反复打电话。所以本模块提供一个**白名单式**的分类:
//   已知的、对操作员有用但**不含内部细节**的类别名 (database / timeout /
//   timeout / validation / not_found / conflict / internal), 其余一律 internal。
//
// ★ 安全边界 (本模块**不**做的事):
//   · 不做"关键词替换"式的伪脱敏 —— 把 `password=x` 换成 `password=***`
//     依然泄露了"这里有个 password 字段"这个信息, 而且正则永远漏。
//   · 不保留错误码/错误名 —— 那些同样泄露内部实现 (MySQL ER_xxx /
//     MSSQL 208)。要判定类别请在**服务端**用 dbError.js 做, 不要把
//     kind 传给前端当"细节"。

/**
 * 对外可暴露的错误类别。值是稳定的对外契约。
 */
export const PUBLIC_ERROR_KIND = {
  DATABASE: 'database',
  TIMEOUT: 'timeout',
  VALIDATION: 'validation',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  INTERNAL: 'internal'
};

// 默认对外文案。**不含任何**内部细节。
const PUBLIC_MESSAGES = {
  [PUBLIC_ERROR_KIND.DATABASE]: 'database error',
  [PUBLIC_ERROR_KIND.TIMEOUT]: 'request timed out',
  [PUBLIC_ERROR_KIND.VALIDATION]: 'invalid request',
  [PUBLIC_ERROR_KIND.NOT_FOUND]: 'not found',
  [PUBLIC_ERROR_KIND.CONFLICT]: 'conflict',
  [PUBLIC_ERROR_KIND.INTERNAL]: 'internal error'
};

// 驱动错误名 / 错误号 → 类别。
// ★ 故意**只**收 MySQL/MSSQL 的**已知**错误名 —— 认不出来的走 internal。
const DB_ERROR_NAMES = new Set([
  'ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR', 'ER_BAD_FIELD_ERROR',
  'ER_PARSE_ERROR', 'ER_DUP_ENTRY', 'ER_DUP_FIELDNAME',
  'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR', 'ER_NO_REFERENCED_ROW', 'ER_ROW_IS_REFERENCED',
  'ER_DATA_TOO_LONG', 'ER_TRUNCATED_WRONG_VALUE', 'ER_WARN_DATA_OUT_OF_RANGE',
  'ER_LOCK_TABLE_FULL', 'ER_TOO_MANY_USER_CONNECTIONS'
]);

// MSSQL 错误号 → 类别 (只收"操作员需要知道是数据库问题"的那些)。
const MSSQL_DB_ERROR_NUMBERS = new Set([
  208,   // Invalid object name (表/视图不存在)
  207,   // Invalid column name
  2627,  // Violation of PRIMARY KEY constraint
  2601,  // Duplicate key in index
  1205,  // Deadlock
  4060,  // Cannot open database
  18456, // Login failed
  262,   // Permission denied
  515,   // Cannot insert NULL
  547,   // Constraint violation
  8134,  // Divide by zero
  3966,  // Transaction rollback
  229,   // Permission denied on object
  300,   // View referencing invalid object
]);

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed\s*out/i,
  /etimedout/i,
  /esockettimedout/i,
  /lock\s*wait\s*timeout/i,
  /lock\s*request\s*time\s*out/i,
  /canceling\s+statement\s+due\s+to\s+statement\s+timeout/i
];

const VALIDATION_PATTERNS = [
  /invalid\s+(request|input|argument|parameter)/i,
  /validation\s+failed/i,
  /zod/i,
  /must\s+be\s+a/i
];

const NOT_FOUND_PATTERNS = [
  /not\s+found/i,
  /does\s+not\s+exist/i,
  /enoent/i
];

const CONFLICT_PATTERNS = [
  /duplicate/i,
  /already\s+exists/i,
  /conflict/i,
  /unique\s+constraint/i
];

/**
 * 从一个错误对象里提取可用于判定的标识 (code / errno / number / 原始错误链)。
 * @param {unknown} err
 * @returns {Array<string|number>} 标识列表
 */
function collectErrorCodes(err) {
  const out = [];
  let current = err;
  // 最多剥 5 层包装 (db facade / driver 层层包)
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if (typeof current.code === 'string' || typeof current.code === 'number') {
      out.push(current.code);
    }
    if (typeof current.errno === 'number') out.push(current.errno);
    if (typeof current.number === 'number') out.push(current.number);
    current = current.originalError || current.cause || null;
  }
  return out;
}

/**
 * 把一个异常归类成对外可暴露的类别。
 * @param {unknown} err
 * @returns {string} PUBLIC_ERROR_KIND 之一
 */
export function classifyPublicError(err) {
  if (!err || typeof err !== 'object') return PUBLIC_ERROR_KIND.INTERNAL;

  // 1) 结构化错误码优先 —— 最可靠
  for (const code of collectErrorCodes(err)) {
    if (typeof code === 'string' && DB_ERROR_NAMES.has(code)) {
      return PUBLIC_ERROR_KIND.DATABASE;
    }
    if (typeof code === 'number' && MSSQL_DB_ERROR_NUMBERS.has(code)) {
      return PUBLIC_ERROR_KIND.DATABASE;
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST') {
      return PUBLIC_ERROR_KIND.TIMEOUT;
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
      return PUBLIC_ERROR_KIND.DATABASE;
    }
  }

  // 2) message 兜底 (仅当 message 是字符串且不太长时才做正则匹配)
  //
  // ★ 判定顺序很重要 (R161.34 测试实测踩到的坑):
  //   MySQL 的缺表错误原文是
  //     "SQLSTATE[42S02]: Base table or view not found: 1146 Table 'x' doesn't exist"
  //   它同时命中 NOT_FOUND_PATTERNS (/not\s+found/) 和数据库措辞。
  //   ⇒ 如果先判 "not found", 一个**数据库**故障会被误报成"资源不存在",
  //     操作员会去查路径而不是查数据库 —— 分类错了比不分类更糟。
  //   ⇒ 所以: **先**判数据库措辞 (SQLSTATE / 表 / 列 / 约束), **再**判
  //     其余类别。数据库是"哪一层坏了"的答案, 优先级最高。
  const message = typeof err.message === 'string' ? err.message : '';
  if (message && message.length <= 2000) {
    // 2a. 数据库措辞 (最高优先级)
    if (/SQLSTATE|\bSQL\b|\bdatabase\b|\btable\b|\bcolumn\b|\bconstraint\b|\btransaction\b/i.test(message)) {
      return PUBLIC_ERROR_KIND.DATABASE;
    }
    // 2b. 超时
    if (TIMEOUT_PATTERNS.some(p => p.test(message))) return PUBLIC_ERROR_KIND.TIMEOUT;
    // 2c. 校验
    if (VALIDATION_PATTERNS.some(p => p.test(message))) return PUBLIC_ERROR_KIND.VALIDATION;
    // 2d. 冲突 (在 not found 之前 —— "duplicate" 比 "not found" 更具体)
    if (CONFLICT_PATTERNS.some(p => p.test(message))) return PUBLIC_ERROR_KIND.CONFLICT;
    // 2e. 不存在
    if (NOT_FOUND_PATTERNS.some(p => p.test(message))) return PUBLIC_ERROR_KIND.NOT_FOUND;
  }

  return PUBLIC_ERROR_KIND.INTERNAL;
}

/**
 * 生成一个**可以安全返回给客户端**的错误响应体。
 *
 * ★ 返回体里**只有**:
 *   - kind   — 稳定的类别名
 *   - error  — 稳定的短语 (不含任何内部细节)
 *   - message — 与 error 相同 (前端两个字段都在用, 保持兼容)
 *   - requestId (可选) — 用于让操作员在日志里定位这次失败
 *
 * ★ **绝不**包含: 原始 message / stack / SQL / 路径 / 连接串。
 *
 * @param {unknown} err 原始异常
 * @param {object} [options]
 * @param {string} [options.requestId] 用于关联服务端日志的请求标识
 * @returns {{kind:string, error:string, message:string, requestId?:string}}
 */
export function toPublicError(err, { requestId } = {}) {
  const kind = classifyPublicError(err);
  const message = PUBLIC_MESSAGES[kind] || PUBLIC_MESSAGES[PUBLIC_ERROR_KIND.INTERNAL];
  const body = { kind, error: message, message };
  if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 64) {
    body.requestId = requestId;
  }
  return body;
}

/**
 * 便捷包装: 直接生成 Express 的 500 响应体。
 * @param {unknown} err
 * @param {object} [options]
 * @returns {{kind:string, error:string, message:string, requestId?:string}}
 */
export function publicErrorBody(err, options) {
  return toPublicError(err, options);
}
