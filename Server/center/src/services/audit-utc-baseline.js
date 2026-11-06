// center/src/services/audit-utc-baseline.js
// R161.16 (2026-10-27) — audit_logs 时间戳基准的单一真源 + 旧基准行回填。
//
// ── 背景 (操作员报: /admin/audit 的「变更」「安全」两个 tab 时间不对) ──────
//
//   audit_logs.created_at 的列定义是:
//
//     MySQL : DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
//     MSSQL: DATETIME2 NOT NULL DEFAULT sysutcdatetime()
//
//   MySQL 的 CURRENT_TIMESTAMP 取的是**会话时区**的墙钟; MSSQL 的
//   sysutcdatetime() 恒为 UTC。R161.10 之前中心端没有钉会话时区
//   (现在每条池化连接都 SET time_zone='+00:00'), 所以 MySQL 部署上
//   **钉之前写下的那些行存的是服务器本地墙钟** (本机 = CST, +480 分钟),
//   而前端统一把 naive DATETIME 当 UTC 解读 ⇒ 那批行整体晚 8 小时。
//
//   注意: 这不是渲染错, 是**行本身的写入基准错** —— 4 个 tab 共用同一张
//   audit_logs + 同一个 fmt(), 同一 fmt + 同一张表 ⇒ 差异只可能来自行。
//
// ── 本模块干三件事 ────────────────────────────────────────────────────────
//
//   1) detectLegacyBasis()        纯函数。从 audit_logs 自己的 payload 里
//                                  那些**带时区标记**的 ISO 时刻反推每行的
//                                  写入基准, 找出「旧基准行」与「新基准行」
//                                  的分界。**判定不出来就明确说不, 绝不猜。**
//
//   2) ensureAuditUtcBaseline()   启动期入口。读 system_config 里的单一真源
//                                  (audit_utc_baseline); 没有就探测一次并落库,
//                                  落库后每次启动都照它执行回填。
//
//   3) applyAuditUtcBackfill()    按真源里的偏移把旧基准行的 created_at 平移
//                                  成真 UTC。**先写前像备份表**
//                                  (audit_logs_utc_baseline_backup), 备份表里
//                                  存的是「原值 + 目标值」⇒ 回填天然幂等,
//                                  而且随时可以按备份表反着改回来。
//
// ── 为什么偏移绝不写死在代码里 ────────────────────────────────────────────
//
//   偏移取决于**部署所在机器的本地时区**, 不是产品常量: 同一份代码装在 UTC
//   机器上偏移就是 0, 装在 IST 机器上是 -330。硬编码 +480 会让"这台机器不是
//   CST"的环境把整张表平移错 —— 那比不平移更糟 (原始墙钟至少还留着, 平移后
//   是错的真值)。所以偏移必须**从库里量出来**再落库。
//
// ── 单一真源存哪儿 ────────────────────────────────────────────────────────
//
//   system_config.config_key = 'audit_utc_baseline' (JSON 字符串)。
//   写必须走 db.sql.config.upsert (INSERT ... ON DUPLICATE KEY UPDATE /
//   MERGE) 而不是 UPDATE-only 的 setConfig —— setConfig 对不存在的 key
//   **静默 0 行**, 那正是 R161.11 记过的坑。
//
// ── 探测模型 (v2) ────────────────────────────────────────────────────────
//
// 设偏移 D (分钟)。判定模型是: 存在一个分界 B, 使得
//
//   真值(i) = 列值(i) − D    (i ≤ B — 旧基准: 会话时区墙钟)
//   真值(i) = 列值(i)         (i > B — 新基准: 真 UTC)
//
// 且 **真值序列按 id 单调不减**。这是自增主键审计日志的物理不变式:
// id 递增 ⇔ 写入时间递增。★ 这条不变式就是"新基准确实是 UTC"的证明 ——
//
//   · D 由**载荷自证**得到 (payload 里带时区标记的 ISO 时刻 vs 列值):
//     差 0 ⇒ 该行是真 UTC, 差 D ⇒ 该行是旧基准。至少要 2 行独立证据。
//   · B 由不变式**唯一**确定 (见下面 validB 集合的算法)。
//   · 若 B 之后的那些行其实也是旧基准, 那整表都是旧基准 ⇒ 真值序列 =
//     列值序列整体平移 ⇒ 必须单调; 而真库的列值序列在分界处是**回退**的
//     (旧基准墙钟比真值晚 D, 切到新基准后列值往回跳) ⇒ 矛盾
//     ⇒ B 之后的行只能是新基准。
//
// ★★ 为什么不能要求"必须有一行自证 UTC" (v1 的规则 a):
//   真库里切换之后写的那些行, 载荷里**根本没有时间戳** (payload 是
//   {transitions} / {graceMs,rotatedAt} 这种结构), 所以 v1 恒定返回
//   no_utc_proof ⇒ 回填一次都跑不了 ⇒ 操作员重启服务也看不到变化。
//   ★ 这不是"证据不足", 是"证据在别处": 证据在**单调性**里。
//
// 判定规则 (全部满足才动手, 任何一条不满足就拒绝回填):
//
//   a) 存在一个**非零**的候选偏移 D: |D| <= 840 (UTC-14..UTC+14) 且
//      D 是 15 的整数倍 (真实时区偏移都是 15 分钟的整数倍)。
//   b) D 的证据行数必须**多于**其它任何候选偏移 (否则无法确定唯一的 D)。
//   c) 旧基准证据行至少 2 行 (单行证据不足以定位分界)。
//   d) 同一行不得同时命中两种基准 (载荷里两个时刻互相矛盾)。
//   e) 若存在 UTC 自证行, 旧基准证据行与它们**不得交错**
//      (旧基准 id 全部 < UTC id)。
//   f) 分界 B 必须让真值序列单调不减; 且 B 的取值必须唯一可判:
//      优先取 B = 旧基准证据的最大 id (只平移被证实的块),
//      否则只有唯一合法 B 时才采纳, 多个候选 ⇒ 拒绝。
//   g) 重建后的最新一行真值不得晚于当前时钟 (否则说明"新基准不是 UTC")。
//
//   任何一条不满足 ⇒ status != 'detected' ⇒ **只记 warn, 一行都不改**。

import { getDb } from '../db/index.js';

// system_config 里的单一真源 key
export const AUDIT_UTC_BASELINE_KEY = 'audit_utc_baseline';
// 真源的 schema 版本 (将来要加字段时递增, 老版本按"未记录"处理)
export const AUDIT_UTC_BASELINE_VERSION = 1;
// 前像备份表名 (DDL 在 db/migrations/{mysql,mssql}/1.0.2-audit-utc-baseline.sql)
export const AUDIT_UTC_BACKUP_TABLE = 'audit_logs_utc_baseline_backup';

// 一次探测最多读多少行 audit_logs (审计表有保留期, 正常很小;
// 上限是防御性的: 免得在异常大的库上把内存吃满)
const MAX_SCAN_ROWS = 2000;
// UTC-14 .. UTC+14
const MAX_OFFSET_MINUTES = 840;
// 真实时区偏移都是 15 分钟的整数倍
const OFFSET_GRID_MINUTES = 15;
// 旧基准至少要有 2 行独立证据 (1 行不足以定位分界)
const MIN_LEGACY_EVIDENCE_ROWS = 2;
// 时钟容差: 重建后的"最新一行真值"最多允许比当前时钟晚这么多
// (应用时钟与数据库时钟之间的正常漂移)
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
// 前像 INSERT 的批大小 (避免一条语句塞爆 max_allowed_packet)
const INSERT_BATCH_SIZE = 100;

// 只认**带时区标记**的 ISO 时刻 (Z 或 ±HH:MM / ±HHMM)。
// naive 串 (没有时区标记) 没有独立真值 —— 拿它跟列值比等于拿自己比自己,
// 恒为 0, 会把每一行都误判成 "UTC 基准"。
// 第 3 组是小数秒 —— 必须原样带上, 否则毫秒级真值会被截断成秒级。
const ZONED_ISO_RE = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g;

// ─────────────────────────────────────────────────────────────────────────
// 纯函数工具 (无 IO, 可单测)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把 'YYYY-MM-DD HH:mm:ss' / Date 解释成 "当作 UTC" 的毫秒数。
 * 这跟前端 storage contract 一致: naive DATETIME 一律按 UTC 解读。
 *
 * @param {string|Date|null|undefined} naive
 * @returns {number|null} 解析不出来返回 null
 */
export function naiveToUtcMs(naive) {
  if (naive == null) return null;
  if (naive instanceof Date) {
    const ms = naive.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const text = String(naive).trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 毫秒数 → 'YYYY-MM-DD HH:mm:ss' (UTC 墙钟, 与 naive DATETIME 列同形)
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatNaiveUtc(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * 把 naive 墙钟往前平移 offsetMinutes 分钟 (offset>0 表示墙钟比真值晚)。
 *
 * @param {string} naive 'YYYY-MM-DD HH:mm:ss'
 * @param {number} offsetMinutes
 * @returns {string|null}
 */
export function shiftNaiveUtc(naive, offsetMinutes) {
  const ms = naiveToUtcMs(naive);
  if (ms == null) return null;
  return formatNaiveUtc(ms - offsetMinutes * 60000);
}

/**
 * 把 payload 解析成对象 (MySQL 的 JSON 列可能已经是对象, 也可能是串)
 *
 * @param {unknown} payload
 * @returns {unknown}
 */
export function parsePayloadJson(payload) {
  if (payload == null) return null;
  if (typeof payload === 'object') return payload;
  const text = String(payload).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 递归收集 payload 里所有**带时区标记**的 ISO 时刻 (毫秒)。
 *
 * @param {unknown} value
 * @param {number[]} out
 * @param {number} depth
 * @returns {number[]}
 */
export function collectZonedIsoInstants(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    // matchAll 内部会克隆正则, 不会污染共享的 lastIndex
    for (const match of value.matchAll(ZONED_ISO_RE)) {
      const ms = zonedIsoToMs(match[1], match[2], match[3], match[4]);
      if (ms != null) out.push(ms);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectZonedIsoInstants(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectZonedIsoInstants(item, out, depth + 1);
  }
  return out;
}

/**
 * '2026-10-26' + '06:40:59' + '.836' + 'Z' → 毫秒
 *
 * @param {string} datePart
 * @param {string} timePart
 * @param {string|null} fractionPart 小数秒 (可空)
 * @param {string} zonePart 'Z' | '+08:00' | '+0800' | '-05:00'
 * @returns {number|null}
 */
function zonedIsoToMs(datePart, timePart, fractionPart, zonePart) {
  let zone = zonePart;
  if (zonePart === 'Z') {
    zone = 'Z';
  } else if (zonePart.length === 5) {
    zone = `${zonePart.slice(0, 3)}:${zonePart.slice(3)}`;
  }
  const ms = Date.parse(`${datePart}T${timePart}${fractionPart ?? ''}${zone}`);
  return Number.isNaN(ms) ? null : ms;
}

// ─────────────────────────────────────────────────────────────────────────
// 探测: 判定哪些行是"旧基准"行, 分界在哪
// ─────────────────────────────────────────────────────────────────────────

/**
 * 重建后的真值序列是否按行序单调不减。
 *
 * 真值序列 = 前 prefixCount 行的 (列值 − 偏移), 其余行的列值。
 * 这是自增主键审计日志的物理不变式 (id 递增 ⇔ 写入时间递增)。
 *
 * @param {Array<{id:number, storedMs:number}>} perRow 按 id 升序
 * @param {number} prefixCount 旧基准块占前多少行
 * @param {number} offsetMinutes 偏移 (分钟)
 * @returns {boolean}
 */
function isNonDecreasing(perRow, prefixCount, offsetMinutes) {
  let previous = null;
  for (let i = 0; i < perRow.length; i += 1) {
    const truth = perRow[i].storedMs - (i < prefixCount ? offsetMinutes * 60000 : 0);
    if (previous !== null && truth < previous) return false;
    previous = truth;
  }
  return true;
}

/**
 * 从 audit_logs 的行里判定旧基准 (会话时区墙钟) 与新基准 (真 UTC) 的分界。
 *
 * 判定依据是**两条腿**:
 *   ① **载荷自证** —— 行自己的 payload 里往往嵌着一个**带时区标记**的 ISO
 *      时刻 (比如 token 生成时刻、过期时刻)。拿它跟列值比, 差值就是这行的
 *      写入偏移: 差 0 ⇒ 这行是按真 UTC 写的; 差 +480 ⇒ 这行是按会话时区
 *      (CST) 墙钟写的。⇒ 偏移 D 由这些证据行给出。
 *   ② **单调性** —— 重建出来的真值序列必须按 id 单调不减。⇒ 分界 B 由
 *      这条不变式定位, 并且**顺带证明** B 之后的行确实是新基准。
 *
 * ★ v1 曾要求"必须有一行能自证 UTC"。真库做不到: 切换之后写的那些行载荷里
 *   根本没有时间戳 ⇒ v1 恒定 no_utc_proof ⇒ 回填一次都跑不了。
 *
 * 纯函数 —— 不碰 DB, 所以能直接单测。
 *
 * @param {Array<{id:number, createdAt:string, payload:unknown}>} rows 按 id 升序
 * @param {number|null} [nowMs] 当前时钟 (毫秒)。给了就多一条"重建后的最新
 *                           一行不得晚于现在"的护栏; 不给就跳过这条。
 * @returns {{status:string, offsetMinutes:number|null, boundaryAuditId:number|null,
 *            legacyRowCount:number, scannedRows:number, legacyEvidenceIds:number[],
 *            utcEvidenceIds:number[], reasons:string[]}}
 */
export function detectLegacyBasis(rows, nowMs = null) {
  const result = {
    status: 'unknown',
    offsetMinutes: null,
    boundaryAuditId: null,
    legacyRowCount: 0,
    scannedRows: 0,
    legacyEvidenceIds: [],
    utcEvidenceIds: [],
    reasons: []
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    result.status = 'empty';
    result.reasons.push('audit_logs 没有可判定的行');
    return result;
  }

  // ---- ① 逐行算候选差值 (列值 - payload 真值), 单位分钟 ----
  const perRow = [];
  for (const row of rows) {
    const storedMs = naiveToUtcMs(row?.createdAt);
    if (storedMs == null) continue;
    const deltas = new Set();
    for (const truthMs of collectZonedIsoInstants(parsePayloadJson(row?.payload))) {
      deltas.add(Math.round((storedMs - truthMs) / 60000));
    }
    perRow.push({ id: Number(row.id), storedMs, deltas: [...deltas] });
  }
  result.scannedRows = perRow.length;
  if (perRow.length === 0) {
    result.status = 'no_parsable_rows';
    result.reasons.push('没有一行能解析出可比较的时间列值');
    return result;
  }

  // ---- ② 直方图 ----
  const hist = new Map();
  for (const row of perRow) {
    for (const d of row.deltas) hist.set(d, (hist.get(d) || 0) + 1);
  }

  // 规则 a/b: 唯一的非零候选偏移 (D 只能来自载荷自证, 绝不猜)
  const offsetCandidates = [...hist.entries()]
    .filter(([d]) => d !== 0 && Math.abs(d) <= MAX_OFFSET_MINUTES && d % OFFSET_GRID_MINUTES === 0)
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]));
  if (offsetCandidates.length === 0) {
    result.status = 'no_legacy_proof';
    result.reasons.push('没有任何一行的列值与 payload 真值存在非零差值 ⇒ 没有旧基准行');
    return result;
  }
  const [offsetMinutes, offsetHits] = offsetCandidates[0];
  if (offsetCandidates.length > 1 && offsetCandidates[1][1] === offsetHits) {
    result.status = 'ambiguous_offset';
    result.reasons.push(
      `存在两个证据数相同的候选偏移 (${offsetCandidates[0][0]} / ${offsetCandidates[1][0]} 分钟) ⇒ 不猜`
    );
    return result;
  }

  // ---- ③ 逐行定基准 (规则 d: 同一行不得同时命中两种基准) ----
  const legacyEvidence = [];
  const conflictIds = [];
  for (const row of perRow) {
    const isLegacy = row.deltas.includes(offsetMinutes);
    const isUtc = row.deltas.includes(0);
    if (isLegacy && isUtc) {
      conflictIds.push(row.id);
      continue;
    }
    if (isLegacy) legacyEvidence.push(row);
  }
  if (conflictIds.length > 0) {
    result.status = 'conflicting_evidence';
    result.reasons.push(`有 ${conflictIds.length} 行同时命中两种基准 (ids: ${conflictIds.slice(0, 10).join(', ')})`);
    return result;
  }

  const legacyIds = legacyEvidence.map((r) => r.id);
  const utcIds = perRow.filter((r) => r.deltas.includes(0)).map((r) => r.id);

  // 规则 e: 若存在 UTC 自证行, 旧基准证据行与它们不得交错 (基准只切换过一次)
  if (legacyIds.length > 0 && utcIds.length > 0) {
    const maxLegacyId = Math.max(...legacyIds);
    const minUtcId = Math.min(...utcIds);
    if (maxLegacyId > minUtcId) {
      result.status = 'interleaved_basis';
      result.reasons.push(`旧基准行 (max id ${maxLegacyId}) 与 UTC 基准行 (min id ${minUtcId}) 交错 ⇒ 不是"一次切换"模型`);
      return result;
    }
  }

  // 规则 c: 旧基准至少 2 行独立证据
  if (legacyIds.length < MIN_LEGACY_EVIDENCE_ROWS) {
    result.status = 'weak_legacy_evidence';
    result.reasons.push(`旧基准证据只有 ${legacyIds.length} 行 (< ${MIN_LEGACY_EVIDENCE_ROWS}) ⇒ 不足以定位分界`);
    return result;
  }

  // ---- ④ 用单调性不变式定位分界 ----
  //
  //   真值序列(prefixCount) = [列值(i) − D  (i < prefixCount), 列值(i) (i ≥ prefixCount)]
  //   validPrefix = 那些让真值序列单调不减的分界。
  //
  //   ★ 这一步同时**证明**了 prefixCount 之后的行确实是新基准: 若那些行
  //   其实也是旧基准, 整表就是一个统一平移, 真值序列必须等于列值序列 ——
  //   而列值序列在分界处是**回退**的 (旧基准墙钟比真值晚 D, 切到新基准后
  //   列值往回跳) ⇒ 矛盾 ⇒ prefixCount 之后的行只能是新基准。
  const validPrefix = [];
  for (let p = 0; p <= perRow.length; p += 1) {
    if (isNonDecreasing(perRow, p, offsetMinutes)) validPrefix.push(p);
  }
  if (validPrefix.length === 0) {
    result.status = 'inconsistent_sequence';
    result.reasons.push('没有任何分界能让重建后的真值序列单调不减 ⇒ 数据不自洽, 一行都不改');
    return result;
  }

  // 证据给出的下界: 旧基准证据行的最大 id 必须落在旧基准块里
  const maxLegacyId = Math.max(...legacyIds);
  const evidencePrefix = perRow.filter((r) => r.id <= maxLegacyId).length;

  let prefixCount;
  if (validPrefix.includes(evidencePrefix)) {
    // 首选: 只平移被证据坐实的块 (没有证据的行一律不碰)
    prefixCount = evidencePrefix;
  } else if (validPrefix.length === 1) {
    // 证据下界不在合法集合里, 但只有一个合法分界 ⇒ 由不变式单独定夺
    prefixCount = validPrefix[0];
  } else {
    result.status = 'ambiguous_boundary';
    result.reasons.push(
      `分界不唯一 (合法候选 [${validPrefix.slice(0, 10).join(', ')}], 证据下界 ${evidencePrefix} 不在其中) ⇒ 不猜`
    );
    return result;
  }

  const boundaryAuditId = prefixCount > 0 ? perRow[prefixCount - 1].id : null;

  // 规则 g: 重建后的最新一行真值不得晚于当前时钟 (否则"新基准是 UTC"不成立)
  if (Number.isFinite(nowMs) && perRow.length > 0) {
    const lastIndex = perRow.length - 1;
    const lastTruth = perRow[lastIndex].storedMs
      - (lastIndex < prefixCount ? offsetMinutes * 60000 : 0);
    if (lastTruth > nowMs + CLOCK_SKEW_TOLERANCE_MS) {
      result.status = 'future_newest_row';
      result.reasons.push(
        `重建后最新一行的真值 (${formatNaiveUtc(lastTruth)}) 晚于当前时钟 ⇒ 新基准未必是 UTC, 一行都不改`
      );
      return result;
    }
  }

  result.status = 'detected';
  result.offsetMinutes = offsetMinutes;
  result.boundaryAuditId = boundaryAuditId;
  result.legacyRowCount = prefixCount;
  result.legacyEvidenceIds = legacyIds;
  result.utcEvidenceIds = utcIds;
  result.reasons.push(
    `偏移 ${offsetMinutes} 分钟 (${offsetMinutes > 0 ? '旧基准墙钟比真值晚' : '旧基准墙钟比真值早'} ` +
    `${Math.abs(offsetMinutes)} 分钟), 分界 id = ${boundaryAuditId}, 旧基准行 ${prefixCount} 行`
  );
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// DB 读写
// ─────────────────────────────────────────────────────────────────────────

/**
 * 取"列值本身就是 naive 墙钟串"的表达式 (避免驱动层 Date 转换带来的歧义)。
 *
 * @param {string} dialect 'mysql' | 'mssql'
 * @param {string} column
 * @returns {string}
 */
function naiveExpr(dialect, column) {
  if (dialect === 'mssql') return `CONVERT(VARCHAR(19), ${column}, 120)`;
  return `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s')`;
}

/**
 * 读 audit_logs 的 (id, naive 墙钟, payload)。
 *
 * @param {object} db
 * @param {number} limit
 * @returns {Promise<Array<{id:number, createdAt:string, payload:unknown}>>}
 */
async function readAuditRows(db, limit = MAX_SCAN_ROWS) {
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_SCAN_ROWS) : MAX_SCAN_ROWS;
  // 行数上限**内联**成整数常量 (不绑参数): MySQL 的 LIMIT ? 只吃整数,
  // MSSQL 的 TOP (?) 吃参数但两边写法不同 —— 内联一个已经校验过的整数常量
  // 是唯一两种方言都安全的写法。
  const top = db.dialect === 'mssql' ? `TOP (${capped})` : '';
  const limitClause = db.dialect === 'mssql' ? '' : ` LIMIT ${capped}`;
  const sql = `SELECT ${top} a.id AS id, ${naiveExpr(db.dialect, 'a.created_at')} AS createdAt, a.payload AS payload
                 FROM audit_logs a
                ORDER BY a.id ASC${limitClause}`;
  const { rows } = await db.query(sql, []);
  const all = Array.isArray(rows) ? rows : [];
  return all.map((r) => ({
    id: Number(r.id),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : formatNaiveUtc(naiveToUtcMs(r.createdAt) ?? 0),
    payload: r.payload
  }));
}

/**
 * 读单一真源。
 *
 * @param {object} db
 * @returns {Promise<object|null>} 解析不了返回 null
 */
export async function readAuditBaseline(db) {
  const { rows } = await db.query(
    'SELECT config_value FROM system_config WHERE config_key = ?',
    [AUDIT_UTC_BASELINE_KEY]
  );
  const raw = rows?.[0]?.config_value;
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 写单一真源 (upsert —— 行不存在就插, 存在就改)。
 *
 * @param {object} db
 * @param {object} baseline
 * @returns {Promise<void>}
 */
export async function writeAuditBaseline(db, baseline) {
  await db.execute(db.sql.config.upsert, [
    AUDIT_UTC_BASELINE_KEY,
    JSON.stringify(baseline)
  ]);
}

/**
 * 备份表里已经记录了哪些 audit_id。
 *
 * @param {object} db
 * @returns {Promise<Set<number>>}
 */
async function readBackedUpIds(db) {
  const { rows } = await db.query(`SELECT audit_id FROM ${AUDIT_UTC_BACKUP_TABLE}`, []);
  const set = new Set();
  for (const r of rows ?? []) set.add(Number(r.audit_id));
  return set;
}

/**
 * 平移旧基准行。
 *
 * 幂等性来自备份表: 备份表存的是「原值 + 目标值」, 平移语句永远按备份表里的
 * 目标值写, 所以跑第二遍不会二次平移。前像也在备份表里 ⇒ 随时可反着改回来。
 *
 * @param {object} db
 * @param {{offsetMinutes:number, boundaryAuditId:number}} baseline
 * @param {object} logger
 * @returns {Promise<{backedUp:number, shifted:number, skipped:number, error?:string}>}
 */
export async function applyAuditUtcBackfill(db, baseline, logger) {
  const offsetMinutes = Number(baseline?.offsetMinutes);
  const boundaryAuditId = Number(baseline?.boundaryAuditId);
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    throw new Error(`回填中止: 偏移 ${baseline?.offsetMinutes} 不是合法分钟数`);
  }
  if (!Number.isInteger(boundaryAuditId) || boundaryAuditId < 0) {
    throw new Error(`回填中止: 分界 id ${baseline?.boundaryAuditId} 非法`);
  }

  const backedUp = await readBackedUpIds(db);

  // ① 前像: 把要平移的行连同「原值 + 目标值」写进备份表
  const { rows } = await db.query(
    `SELECT a.id AS id, ${naiveExpr(db.dialect, 'a.created_at')} AS createdAt
       FROM audit_logs a
      WHERE a.id <= ?
      ORDER BY a.id ASC`,
    [boundaryAuditId]
  );
  const targets = (rows ?? [])
    .map((r) => ({
      id: Number(r.id),
      original: typeof r.createdAt === 'string' ? r.createdAt : formatNaiveUtc(naiveToUtcMs(r.createdAt) ?? 0)
    }))
    .filter((r) => !backedUp.has(r.id));

  let inserted = 0;
  const BATCH = INSERT_BATCH_SIZE;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const placeholders = slice.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const t of slice) {
      const shifted = shiftNaiveUtc(t.original, offsetMinutes);
      if (shifted == null) {
        throw new Error(`回填中止: id ${t.id} 的原值 ${t.original} 无法解析`);
      }
      params.push(t.id, t.original, shifted, offsetMinutes, AUDIT_UTC_BASELINE_VERSION);
    }
    await db.execute(
      `INSERT INTO ${AUDIT_UTC_BACKUP_TABLE}
         (audit_id, original_created_at, shifted_created_at, offset_minutes, baseline_version)
       VALUES ${placeholders}`,
      params
    );
    inserted += slice.length;
  }

  // ② 平移: 目标值固定在备份表里 ⇒ 重复执行不会二次平移
  const updateSql = db.dialect === 'mssql'
    ? `UPDATE a
          SET a.created_at = b.shifted_created_at
         FROM audit_logs a
         INNER JOIN ${AUDIT_UTC_BACKUP_TABLE} b ON a.id = b.audit_id`
    : `UPDATE audit_logs a
         INNER JOIN ${AUDIT_UTC_BACKUP_TABLE} b ON a.id = b.audit_id
          SET a.created_at = b.shifted_created_at`;
  const res = await db.execute(updateSql, []);
  const shifted = Number(res?.affectedRows ?? res?.rowsAffected ?? 0);

  logger?.info?.({
    component: 'audit-utc-baseline',
    offsetMinutes,
    boundaryAuditId,
    backedUp: inserted,
    shifted
  }, 'R161.16 audit UTC backfill done');

  return { backedUp: inserted, shifted };
}

// ─────────────────────────────────────────────────────────────────────────
// 启动期入口
// ─────────────────────────────────────────────────────────────────────────

let inflight = null;

/**
 * 启动期入口: 保证单一真源存在, 并按它把旧基准行平移成真 UTC。
 *
 * 行为:
 *   - 真源已存在 → 直接按真源回填 (幂等)。
 *   - 真源不存在 → 探测一次; 探测成功 → 落库 + 回填; 探测失败 → 只记 warn,
 *     **一行都不改** (宁可让老行晚 8 小时显示, 也不要把对的行改错)。
 *
 * @param {{logger?:object, db?:object}} opts
 * @returns {Promise<object>}
 */
export async function ensureAuditUtcBaseline(opts = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const logger = opts.logger ?? null;
    const db = opts.db ?? getDb();
    const outcome = {
      component: 'audit-utc-baseline',
      status: 'skipped',
      offsetMinutes: null,
      boundaryAuditId: null,
      backedUp: 0,
      shifted: 0
    };
    if (!db) {
      outcome.status = 'no_db';
      logger?.warn?.(outcome, 'R161.16 audit UTC baseline skipped: no db handle');
      return outcome;
    }

    try {
      // 备份表不存在 ⇒ 说明迁移还没跑 (或被人删了) ⇒ 不做任何事, 交给迁移
      const { rows: backupProbe } = await db.query(
        db.dialect === 'mssql'
          ? `SELECT TOP 1 audit_id FROM ${AUDIT_UTC_BACKUP_TABLE}`
          : `SELECT audit_id FROM ${AUDIT_UTC_BACKUP_TABLE} LIMIT 1`,
        []
      );
      if (!Array.isArray(backupProbe)) {
        outcome.status = 'backup_table_missing';
        logger?.warn?.(outcome, 'R161.16 audit UTC baseline skipped: backup table missing (migration not applied)');
        return outcome;
      }
    } catch (e) {
      outcome.status = 'backup_table_missing';
      outcome.error = e?.message;
      logger?.warn?.({ ...outcome, err: e?.message }, 'R161.16 audit UTC baseline skipped: backup table missing');
      return outcome;
    }

    let baseline = await readAuditBaseline(db);
    let detected = null;

    if (!baseline) {
      const rows = await readAuditRows(db);
      // 传入当前时钟 ⇒ 触发规则 g 的护栏 (重建后的最新一行不得晚于现在)
      detected = detectLegacyBasis(rows, Date.now());
      if (detected.status !== 'detected') {
        outcome.status = 'inconclusive';
        outcome.detection = detected;
        logger?.warn?.(
          { component: 'audit-utc-baseline', detection: detected },
          `R161.16 audit UTC baseline not recorded: ${detected.status} — ${detected.reasons.join('; ')}`
        );
        return outcome;
      }
      baseline = {
        version: AUDIT_UTC_BASELINE_VERSION,
        detectedAtUtc: new Date().toISOString(),
        offsetMinutes: detected.offsetMinutes,
        boundaryAuditId: detected.boundaryAuditId,
        legacyRowCount: detected.legacyRowCount,
        evidence: {
          scannedRows: detected.scannedRows,
          legacyEvidenceIds: detected.legacyEvidenceIds,
          utcEvidenceIds: detected.utcEvidenceIds,
          reasons: detected.reasons
        }
      };
      await writeAuditBaseline(db, baseline);
      outcome.status = 'baseline_recorded';
      logger?.info?.(
        { component: 'audit-utc-baseline', offsetMinutes: baseline.offsetMinutes, boundaryAuditId: baseline.boundaryAuditId },
        'R161.16 audit UTC baseline recorded'
      );
    } else if (baseline.version !== AUDIT_UTC_BASELINE_VERSION) {
      outcome.status = 'baseline_version_mismatch';
      outcome.baselineVersion = baseline.version;
      logger?.warn?.(
        { component: 'audit-utc-baseline', version: baseline.version, expected: AUDIT_UTC_BASELINE_VERSION },
        'R161.16 audit UTC baseline version mismatch; skipping backfill'
      );
      return outcome;
    }

    if (baseline.offsetMinutes == null || baseline.boundaryAuditId == null) {
      outcome.status = 'no_legacy_basis';
      outcome.offsetMinutes = baseline.offsetMinutes ?? null;
      outcome.boundaryAuditId = baseline.boundaryAuditId ?? null;
      logger?.info?.(outcome, 'R161.16 audit UTC baseline: no legacy basis recorded; nothing to backfill');
      return outcome;
    }

    const backfill = await applyAuditUtcBackfill(db, baseline, logger);
    outcome.status = 'backfilled';
    outcome.offsetMinutes = baseline.offsetMinutes;
    outcome.boundaryAuditId = baseline.boundaryAuditId;
    outcome.backedUp = backfill.backedUp;
    outcome.shifted = backfill.shifted;
    return outcome;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
