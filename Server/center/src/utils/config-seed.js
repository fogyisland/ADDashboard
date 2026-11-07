// R161.32 — system_config baseline seed 的**单一真源**。
//
// ── 为什么需要这个模块 ──────────────────────────────────────────────
//
// 之前有两个运维脚本 (center/scripts/audit-config-seed.mjs 与
// center/scripts/migrate-config-seed.mjs) 各自抄了一份"读 baseline 解析
// system_config seed"的逻辑, 而且**两份都是坏的**:
//
//   ★ D1 硬编码绝对路径 'D:/dashboard/db/migrations/mssql/1.0.0-baseline.sql'
//     —— 该路径在**任何机器上都不存在** (本机也没有) ⇒ 两个脚本从落地那天起
//        就一直抛 ENOENT, 从未成功运行过。
//   ★ D2 只读 mssql/ 那份 baseline
//     —— MySQL 部署读的是**别的方言**的 seed。
//   ★ D3 解析用行扫描正则, 要求 key 与 value **同行**
//     —— mssql 的 baseline 对长文本用 `+ CHAR(10) +` **跨行**拼接, 于是
//        mssql 独有的 `ad_notify_body_template` 被整个漏掉。
//        (实测: mysql 54 条 / mssql 只解析出 53 条 —— 差的正是这条。)
//
// ── 本模块的契约 ────────────────────────────────────────────────────
//
// 1. **路径**: 用 src/init/schema-applier.js 的 resolveRepoRoot (已 export)
//    定位仓库根 —— 它处理 5 种布局 (ADDASHBOARD_REPO_ROOT env / cwd/..
//    / cwd/../.. / cwd 本身), 源树 (Server/) 与交付包 (LinuxServer/) 通用。
//    **不许**再出现任何绝对路径。
//
// 2. **方言**: baseline 按**当前连接的方言**取, 不再固定 mssql。
//
// 3. **解析**: 两种方言的 seed **语法完全不同**, 必须分别认:
//      mysql: INSERT IGNORE INTO system_config (...) VALUES
//                ('k1','v1','d1'),
//                ('k2','v2','d2');
//      mssql: IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'k')
//                INSERT INTO system_config (...) VALUES
//                  ('k', 'v1' + CHAR(10) + 'v2', 'd');
//    ⇒ 解析必须**按语句作用域**做 (只看 INSERT INTO system_config ... VALUES
//      里的 tuple), 否则会把 baseline 里其它表 (users / roles / ...) 的
//      同样 tuple 形态也吃进来。
//    mssql 的 `+ CHAR(10) +` 要还原成真实的换行符 (CHAR(10) = LF),
//    否则拼出来的模板里是字面量 "+ CHAR(10) +", 跟 mysql 的 "\n" 不等价。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveRepoRoot } from '../init/schema-applier.js';

/** baseline 里 system_config 的 seed 表名 (大小写不敏感匹配)。 */
const TARGET_TABLE = 'system_config';

/**
 * ★ 剥掉 SQL 注释 (行注释 -- 与块注释 star-slash), **保留字符串字面量**。
 *
 * 为什么必须先剥注释: baseline 的注释里出现**奇数个单引号**是常态 ——
 * 例如 mysql baseline 1261 行:
 *     -- email tick 不发 SMTP. 启用改 '1'. 修改后...
 * 直扫字符串字面量时, 上一个 tuple 的收尾引号会跟注释里的 '1' **错误配对**,
 * 把后面**整段真实 seed** 吞进一个假字面量 ⇒ 那些键整个消失
 * (实测: email_enabled / access_domain 及一批 ad_* 键全部丢失)。
 *
 * 单趟字符扫描, 同步处理: 字符串 ('' 转义)、-- 行注释、/* *\/ 块注释。
 * 块注释替换成单个空格, 行注释保留换行 (行号尽量不漂)。
 *
 * @param {string} text SQL 全文
 * @returns {string} 无注释文本 (字符串字面量原样保留)
 */
export function stripSqlComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === "'") {
        if (text[i + 1] === "'") { out += "''"; i += 2; continue; }
        inStr = false;
      }
      out += ch; i += 1; continue;
    }
    if (ch === "'") { inStr = true; out += ch; i += 1; continue; }
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n'; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(text.length, i + 2);
      out += ' '; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/**
 * 定位 baseline 文件。
 *
 * @param {object}  opts
 * @param {string}  opts.dialect       'mysql' | 'mssql'
 * @param {string} [opts.repoRoot]     仓库根 (不给则用 resolveRepoRoot 猜)
 * @param {string} [opts.baselineName] 文件名 (默认 1.0.0-baseline.sql)
 * @returns {string} baseline 的绝对路径
 * @throws {Error} 找不到时抛错 (消息里带上**试过的每个候选路径**)
 */
export function resolveBaselinePath({ dialect, repoRoot, baselineName = '1.0.0-baseline.sql' } = {}) {
  if (!dialect) throw new Error('resolveBaselinePath: dialect 是必填项');
  const root = repoRoot || resolveRepoRoot({});
  const candidates = [
    join(root, 'db', 'migrations', dialect, baselineName),
    join(root, '..', 'db', 'migrations', dialect, baselineName),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {
      // 继续试下一个候选
    }
  }
  throw new Error(
    `resolveBaselinePath: 找不到 baseline 文件 (dialect=${dialect})。\n`
    + `试过的候选路径:\n${candidates.map((c) => `  · ${c}`).join('\n')}\n`
    + `⇒ 检查 db/migrations/${dialect}/ 是否随交付包发布, `
    + `或用 ADDASHBOARD_REPO_ROOT 环境变量指定仓库根。`
  );
}

/**
 * ★ 把 SQL 文本切成"语句", 同时保留每个语句里的字符串字面量位置。
 *
 * 为什么要切语句: baseline 里**每张表**都用 `('k','v','d')` 这种 tuple 形态
 * 插数据 (users / roles / system_config / ...)。只按字面量扫全局会把
 * 别的表的 key 也吃进来 ⇒ 必须先确定"哪段文本属于 system_config"。
 *
 * 切分规则:
 * - `;` 结束一条语句 (但**不在字符串字面量内部**的 `;`) —— 所以切分前
 *   要先把字符串字面量挖掉, 避免 `'a;b'` 被切成两半。
 * - mssql 的 `BEGIN ... END` 块里含多条语句 —— `;` 切分对 `IF NOT EXISTS`
 *   形态仍然成立 (IF 守卫行不含分号)。
 *
 * @param {string} text SQL 全文
 * @returns {string[]} 语句数组
 */
function splitStatements(text) {
  // 先把字符串字面量换成等长的占位符 (保持偏移不变), 避免字面量里的
  // 分号 / 括号 / 逗号干扰切分。
  const masked = text.replace(/'(?:[^']|'')*'/gs, (m) => ' '.repeat(m.length));
  const out = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ';') {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 从一条 `INSERT INTO system_config ... VALUES ...` 语句里抽出
 * (key, value) 对。
 *
 * 语句形态 (方言无关, 因为我们只认 VALUES 后面那串 tuple):
 *   INSERT [IGNORE] INTO system_config (cols...) VALUES ('k','v','d'), (...);
 *
 * value 可能是:
 *   'plain'                              — 同行
 *   'v1' + CHAR(10) + 'v2'               — 跨行拼接 (mssql 长文本)
 *   'v1\nv2'                             — mysql 用 \n 字面量
 *
 * @param {string} statement 单条 SQL 语句
 * @returns {Array<{key: string, value: string}>}
 */
function parseConfigInsert(statement) {
  // 定位 VALUES 关键字 (大小写不敏感)。
  // ★ 必须容忍 VALUES 后面是**换行**的情形 —— 两份 baseline 都这么写:
  //     mysql: `... VALUES\n  ('k','v','d'),`
  //     mssql: `... VALUES\n    ('k', 'v', 'd');`
  //   所以匹配 'VALUES' 后必须**不是**标识符字符 (字母/数字/_)。
  // ★ 取**第一个** —— INSERT 语句的数据段就是第一个 VALUES; 而 description
  //   字段里可能出现 "VALUES" 这个单词 (取最后一个会跳到数据段之后)。
  const valuesMatch = /\bVALUES\b/i.exec(statement);
  if (!valuesMatch) return [];

  const tail = statement.slice(valuesMatch.index + 'VALUES'.length);

  // 扫 tail 里的 tuple: '(' 字面量 ',' 字面量 ',' 字面量 ')'
  const out = [];
  let i = 0;
  while (i < tail.length) {
    const open = tail.indexOf('(', i);
    if (open < 0) break;
    // 找到配对的 ')'
    let depth = 0;
    let close = -1;
    for (let j = open; j < tail.length; j += 1) {
      if (tail[j] === '(') depth += 1;
      else if (tail[j] === ')') {
        depth -= 1;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close < 0) break;
    const tupleBody = tail.slice(open + 1, close);
    const fields = splitTupleFields(tupleBody);
    if (fields.length >= 2) {
      const key = fields[0];
      const value = fields[1];
      if (key && /^[a-z0-9_]+$/i.test(key)) out.push({ key, value });
    }
    i = close + 1;
  }
  return out;
}

/**
 * 把一个 tuple 的内容按顶层逗号切成若干字段, 每个字段还原成字符串值。
 *
 * 顶层 = 不在单引号字符串内部、且不在嵌套括号内。
 *
 * @param {string} body tuple 内部文本 (不含最外层括号)
 * @returns {string[]} 每个字段的值 ('' 表示 SQL NULL)
 */
function splitTupleFields(body) {
  const fields = [];
  let buf = '';
  let inStr = false;
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (ch === "'") {
        // '' 是转义的单引号
        if (body[i + 1] === "'") { buf += "''"; i += 1; continue; }
        inStr = false;
        buf += ch;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === "'") { inStr = true; buf += ch; continue; }
    if (ch === '(') { depth += 1; buf += ch; continue; }
    if (ch === ')') { depth -= 1; buf += ch; continue; }
    if (ch === ',' && depth === 0) { fields.push(buf); buf = ''; continue; }
    buf += ch;
  }
  fields.push(buf);

  return fields.map((f) => literalToValue(f.trim()));
}

/**
 * ★ 解码字符串字面量里的反斜杠转义 (MySQL 方言语义)。
 *
 * 为什么在这里做: mysql baseline 的多行文本 (ad_notify_body_template 等)
 * 用 `\n` **字面两字符**写在 SQL 里 —— MySQL 执行时才变成真 LF;
 * mssql 侧同一个值用 `+ CHAR(10) +` 拼接 (解析时已还原为真 LF)。
 * 不解码 ⇒ 同一个键两方言解析出的 Map 值**不相等**: audit 脚本对真库假报漂移,
 * migrate 脚本会拿字面 `\n` 写库。真库里的值是真 LF
 * (实测: 两方言 decode 后逐字节相等, 各 167 字符)。
 *
 * 认的转义 (MySQL 5.7 官方集合): \n \r \t \0 \b \Z \' \" \\
 * 其余 (如 \%) 保持原样两字符 —— MySQL 对未识别转义也是原样保留。
 *
 * @param {string} s 已还原 '' 转义后的字符串内容
 * @returns {string}
 */
function decodeSqlBackslashEscapes(s) {
  if (!s.includes('\\')) return s;
  const ESCAPES = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\x1a' };
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += ch; continue; } // 尾部孤立反斜杠, 不猜
    if (next in ESCAPES) { out += ESCAPES[next]; i += 1; continue; }
    if (next === "'" || next === '"' || next === '\\') { out += next; i += 1; continue; }
    out += ch; // 未识别转义 (如 \%) → 原样保留两字符, 与 MySQL 语义一致
  }
  return out;
}

/**
 * 把一个 SQL 表达式字段还原成它的字符串值。
 *
 * 认的形态:
 *   'plain'                       → plain
 *   'v1' + CHAR(10) + 'v2'        → "v1LFv2"   (mssql 跨行拼接)
 *   'v1' + NCHAR(10) + 'v2'       → "v1LFv2"
 *   'v1\nv2'                      → "v1LFv2"   (mysql 反斜杠转义, 解码为真 LF)
 *   NULL                          → ''
 *
 * @param {string} expr 字段的原始 SQL 表达式
 * @returns {string}
 */
function literalToValue(expr) {
  if (/^null$/i.test(expr)) return '';

  // 逐个取出字面量, 中间允许出现 `+ CHAR(10) +` (或 `+ NCHAR(10) +`)。
  // ★ 字符类必须认反斜杠转义 (`\\.`): mysql baseline 的多行文本里写的是
  //   字面 `\n` 两字符, `[^']*` 也能吃进来, 但 `'\\.'` 让意图显式化,
  //   且防止将来有人在字面量里写 `\'` 时被 `''` 分支误判。
  const pieceRe = /'((?:[^'\\]|\\.|'')*)'|\+\s*(?:N?CHAR)\s*\(\s*10\s*\)/gi;
  let out = '';
  let matched = false;
  let m;
  while ((m = pieceRe.exec(expr)) !== null) {
    if (m[1] !== undefined) {
      out += decodeSqlBackslashEscapes(m[1].replace(/''/g, "'"));
      matched = true;
    } else {
      // CHAR(10) → 真实换行
      out += '\n';
      matched = true;
    }
  }
  if (!matched) {
    // 不是字面量 (例如表达式列) —— 保留原文本, 不猜。
    return expr;
  }
  return out;
}

/**
 * 解析 baseline 里的 system_config seed。
 *
 * @param {string} text baseline SQL 全文
 * @returns {Map<string, string>} key -> value
 */
export function parseConfigSeeds(text) {
  const out = new Map();
  const cleaned = stripSqlComments(text);
  for (const stmt of splitStatements(cleaned)) {
    // ★ 只认 system_config 的 INSERT —— 表名可以带方括号 (mssql)。
    const m = /INSERT\s+(?:IGNORE\s+)?INTO\s+\[?system_config\]?/i.exec(stmt);
    if (!m) continue;
    for (const { key, value } of parseConfigInsert(stmt)) {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * 读 baseline 并解析出 system_config seed。
 *
 * @param {object}  opts
 * @param {string}  opts.dialect   'mysql' | 'mssql'
 * @param {string} [opts.repoRoot]
 * @returns {{ path: string, seeds: Map<string,string> }}
 */
export function loadConfigSeeds({ dialect, repoRoot } = {}) {
  const path = resolveBaselinePath({ dialect, repoRoot });
  const text = readFileSync(path, 'utf8');
  return { path, seeds: parseConfigSeeds(text) };
}
