// R161.16 (2026-10-27) — 「/admin/audit 时间不对」的回归网
//
// ────────────────────────────────────────────────────────────────────────────
// 缺陷面
//
//   操作员报: /admin/audit 的「变更」「安全」两个 tab 时间不对 (其他 tab 对)。
//
//   真根因 (R161.16 取证三链互证):
//     MySQL 基线: audit_logs.created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
//       ⇒ MySQL 的 CURRENT_TIMESTAMP 取的是**会话时区**的墙钟。
//       R161.10 之前中心端没钉会话时区 (现在每条池化连接 SET time_zone='+00:00'),
//       于是"钉之前"写下的行存的是**服务器本地墙钟** (本机 CST = +480 分钟)。
//     MSSQL 基线: created_at DATETIME2 NOT NULL DEFAULT sysutcdatetime() ⇒ 恒 UTC。
//     前端统一把 naive DATETIME 当 UTC 解读 ⇒ 那批行整体晚 8 小时。
//
//   ★ 4 个 tab 共用同一张 audit_logs + 同一个 fmt() ⇒ 同一 fmt + 同一张表
//     ⇒ 差异只可能来自**行的写入基准** ⇒ 这是数据错, 不是渲染错。
//
// ────────────────────────────────────────────────────────────────────────────
// 本文件锁住的契约:
//
//   A. detectLegacyBasis() —— 纯函数的判定规则
//        A1 正常场景: 旧基准前缀 + UTC 后缀 ⇒ 判定出偏移与分界
//        A1d ★真库形态 (47 行): 切换后的行载荷里没有时刻 ⇒ 仍能判定 (v1 在此恒失败)
//        A1e ★载荷里引用的更早时刻 (rotatedAt) 产生的噪声差值不得被当成偏移
//        A2 全部行都是旧基准 ⇒ 分界 = 最后一行 id
//        A3 没有旧基准 ⇒ 判定为"没有旧基准" (status=no_legacy_proof)
//        A4 偏移有歧义 (两个候选证据数相同) ⇒ 拒绝
//        A5 旧基准与 UTC 交错 ⇒ 拒绝
//        A6 旧基准证据只有 1 行 ⇒ 拒绝
//        A7 偏移不是 15 的整数倍 ⇒ 不被当成候选
//        A8 空表 ⇒ status=empty
//        A10 两处回落 ⇒ 数据不自洽 ⇒ 拒绝
//        A11 重建后最新一行晚于当前时钟 ⇒ 拒绝
//        A12 分界由单调性不变式定夺 (回落点就是分界)
//   B. naive ↔ UTC 的换算与平移
//   C. 只认带时区标记的 ISO 时刻 (naive 串必须被忽略)
//   D. 回填的幂等性 (第二遍不二次平移) + 前像可逆
//   E. 迁移文件契约 (双方言都有备份表; 偏移不写死; DDL 前先设 lock_wait_timeout)
//   F. 向前修复: audit.write / config.upsert 必须**显式**写 UTC, 不靠列默认值
//   G. 启动期接线: server.js 必须调用 ensureAuditUtcBaseline
//   H. Linux 交付包的逐字节镜像 (本轮改过的文件在 LinuxServer/ 必须一致,
//      且漂移检测器必须比对 center/server.js —— 它不在任何目录树里,
//      R161.11 就是在那儿漏抄的)
//
// 放在 center/tests/ 顶层的原因:
//   center/package.json 的 "test" glob 是 `tests/*.test.js ...`, **不含
//   tests/audit/** ⇒ 放子目录 CI 根本不跑。而给 package.json 加 glob 会改掉
//   它的内容 ⇒ `.install-hash` 失配 ⇒ 目标机 (常常离线) 删 node_modules 重跑
//   npm install ⇒ 装机报废 ⇒ **package.json 不能动**。
//
// 用法: cd Server/center && node --test tests/audit-utc-baseline.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSql } from '../src/db/sql.js';
import {
  AUDIT_UTC_BACKUP_TABLE,
  AUDIT_UTC_BASELINE_KEY,
  applyAuditUtcBackfill,
  collectZonedIsoInstants,
  detectLegacyBasis,
  formatNaiveUtc,
  naiveToUtcMs,
  shiftNaiveUtc
} from '../src/services/audit-utc-baseline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.join(here, '..');
const SERVER_ROOT = path.join(CENTER_ROOT, '..');
const REPO_ROOT = path.join(SERVER_ROOT, '..');
const MYSQL_MIGRATIONS = path.join(SERVER_ROOT, 'db', 'migrations', 'mysql');
const MSSQL_MIGRATIONS = path.join(SERVER_ROOT, 'db', 'migrations', 'mssql');
const LINUX_MYSQL_MIGRATIONS = path.join(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mysql');
const LINUX_MSSQL_MIGRATIONS = path.join(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mssql');

// ---------------------------------------------------------------------------
// 合成数据集: 复刻操作员真库的形态
// ---------------------------------------------------------------------------

/**
 * 造一批 audit 行。
 *
 * @param {number} legacyCount  旧基准行数 (列值 = 真值 + offsetMinutes)
 * @param {number} utcCount     新基准行数 (列值 = 真值)
 * @param {number} offsetMinutes 旧基准偏移 (分钟)
 * @param {object} opts { withPayloadEvidence: 是否给每行塞一个带时区标记的 ISO 真值 }
 * @returns {Array<{id:number, createdAt:string, payload:object}>}
 */
function makeRows(legacyCount, utcCount, offsetMinutes, opts = {}) {
  const withEvidence = opts.withPayloadEvidence !== false;
  const rows = [];
  const baseMs = Date.UTC(2026, 9, 26, 6, 40, 59);
  let id = 1;
  for (let i = 0; i < legacyCount; i += 1) {
    const truthMs = baseMs + i * 1000;
    const storedMs = truthMs + offsetMinutes * 60000;
    const payload = withEvidence
      ? { generatedAt: new Date(truthMs).toISOString() }
      : { note: 'no embedded instant' };
    rows.push({ id: id++, createdAt: formatNaiveUtc(storedMs), payload });
  }
  for (let i = 0; i < utcCount; i += 1) {
    const truthMs = baseMs + (legacyCount + i) * 1000;
    const payload = withEvidence
      ? { generatedAt: new Date(truthMs).toISOString() }
      : { note: 'no embedded instant' };
    rows.push({ id: id++, createdAt: formatNaiveUtc(truthMs), payload });
  }
  return rows;
}

/**
 * 造一个只承载"旧基准行"的行集: 全部行都带 payload 真值, 列值 = 真值 + offset。
 *
 * @param {number} count
 * @param {number} offsetMinutes
 * @returns {Array<{id:number, createdAt:string, payload:object}>}
 */
function makeLegacyOnlyRows(count, offsetMinutes) {
  return makeRows(count, 0, offsetMinutes);
}

/**
 * 复刻**操作员真库**的 47 行形态 (R161.16 取证自审计库)。
 *
 * 形态特征 (每一条都是判定逻辑必须处理的真实形态):
 *   · id 1..41 = 旧基准 (会话时区 CST 墙钟, 列值 = 真值 + 480 分钟)
 *       - 只有 id 35 / 38 / 39 / 40 / 41 的载荷里嵌了**带时区标记**的 ISO 时刻
 *         (rotatedAt / revealedAt) ⇒ 这 5 行是偏移量的证据来源
 *       - 其余旧基准行 (登录类 / 脚本类事件) 的载荷里没有时刻 ⇒ 没有证据
 *   · id 42..47 = 新基准 (真 UTC)
 *       - 载荷里**没有**本行的写入时刻 ⇒ 没有任何一行能"自证 UTC"
 *       - id 42 的载荷里 rotatedAt 指的是**更早的**事件 (令牌轮转) ⇒ 它跟列值
 *         的差是 +60 分钟的**噪声**, 不是偏移
 *   · 列值在 id 41 → 42 之间**回落**约 8 小时 ⇒ 这就是基准切换的指纹
 *
 * @returns {Array<{id:number, createdAt:string, payload:object|null}>}
 */
function makeLiveShapeRows() {
  const rows = [];
  let nextId = 1;
  const add = (truthIso, payload, legacy) => {
    const truthMs = Date.parse(truthIso);
    rows.push({
      id: nextId++,
      createdAt: formatNaiveUtc(legacy ? truthMs + 480 * 60000 : truthMs),
      payload
    });
  };

  // id 1..33: 旧基准, 载荷里没有任何时刻
  for (let i = 0; i < 33; i += 1) {
    add(
      new Date(Date.UTC(2026, 9, 26, 6, 40, 59) + i * 1000).toISOString(),
      { name: 'seed', source: 'bootstrap' },
      true
    );
  }
  add('2026-10-26T06:45:03.000Z', null, true);                                  // id 34
  add('2026-10-26T07:45:21.943Z', { version: 2, rotatedAt: '2026-10-26T07:45:21.943Z' }, true); // 35
  add('2026-10-26T11:03:40.000Z', { transitions: [] }, true);                    // id 36
  add('2026-10-26T11:03:41.000Z', { transitions: [] }, true);                    // id 37
  add('2026-10-26T13:02:39.154Z', { version: 2, rotatedAt: '2026-10-26T13:02:39.154Z' }, true); // 38
  add('2026-10-26T13:02:46.217Z', { version: 2, rotatedAt: '2026-10-26T13:02:46.217Z' }, true); // 39
  add('2026-10-26T13:02:55.285Z', { version: 2, revealedAt: '2026-10-26T13:02:55.285Z' }, true); // 40
  add('2026-10-26T13:03:03.035Z', { version: 2, revealedAt: '2026-10-26T13:03:03.035Z' }, true); // 41

  // id 42: 新基准。载荷里的 rotatedAt 指的是 39 行那次轮转 (更早的事件) ⇒ 噪声差值
  add('2026-10-26T14:03:01.000Z', { graceMs: 60000, rotatedAt: '2026-10-26T13:02:46.217Z' }, false);
  add('2026-10-26T14:45:16.000Z', null, false);                                 // id 43
  add('2026-10-27T01:49:41.000Z', null, false);                                 // id 44
  add('2026-10-27T05:29:14.000Z', { transitions: [] }, false);                   // id 45
  add('2026-10-27T05:29:14.000Z', { transitions: [] }, false);                   // id 46
  add('2026-10-27T05:29:14.000Z', { transitions: [] }, false);                   // id 47

  return rows;
}

// ---------------------------------------------------------------------------
// A. detectLegacyBasis —— 判定规则
// ---------------------------------------------------------------------------

describe('A. detectLegacyBasis 的判定规则', () => {
  test('A1 旧基准前缀 + UTC 后缀 ⇒ 判定出偏移与分界', () => {
    const rows = makeRows(41, 6, 480);
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.boundaryAuditId, 41);
    assert.equal(r.legacyRowCount, 41);
    assert.ok(r.legacyEvidenceIds.length >= 2);
    assert.ok(r.utcEvidenceIds.length >= 1);
  });

  test('A1b 没有 payload 证据的行也归到正确的分界侧', () => {
    const rows = makeRows(41, 6, 480);
    // 把中间几行的 payload 证据抹掉 (模拟"那几行 payload 里没嵌时刻")
    for (const idx of [3, 4, 5, 30]) {
      rows[idx] = { ...rows[idx], payload: { note: 'no embedded instant' } };
    }
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.boundaryAuditId, 41);
  });

  test('A1c 偏移为负 (旧基准墙钟比真值早) 也能判定', () => {
    const rows = makeRows(10, 5, -300);
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, -300);
    assert.equal(r.boundaryAuditId, 10);
  });

  test('A1d ★真库形态: 切换之后的行载荷里没有时刻 ⇒ 仍能判定出分界 (v1 在这里恒失败)', () => {
    // 这是操作员真库的 47 行形态: 旧基准 id 1..41, 新基准 id 42..47,
    // 载荷里带时刻的只有旧基准那 5 行 (35/38/39/40/41), 切换之后的行
    // 载荷里**根本没有时间戳** (payload 是 {transitions} / {graceMs,rotatedAt})。
    //
    // ★ v1 要求"必须有一行能自证 UTC" ⇒ 在这份数据上恒定 no_utc_proof ⇒
    //   回填一次都跑不了 ⇒ 操作员重启服务也看不到任何变化。
    const rows = makeLiveShapeRows();
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.boundaryAuditId, 41);
    assert.equal(r.legacyRowCount, 41);
    assert.deepEqual(r.legacyEvidenceIds, [35, 38, 39, 40, 41]);
    assert.deepEqual(r.utcEvidenceIds, [], '新基准的行载荷里没有时刻, 不该有自证行');
  });

  test('A1e ★载荷里引用的更早时刻 (rotatedAt) 产生的噪声差值不得被当成偏移', () => {
    // 行 42 的载荷里 rotatedAt 指的是**更早的**事件 (令牌轮转), 不是本行的
    // 写入时刻 ⇒ 它跟列值的差是 +60 分钟的噪声。若实现草率地把"最大的差"
    // 或"最新的行"当偏移, 就会算成 60 ⇒ 把整表错 1 小时。
    const rows = makeLiveShapeRows();
    const r = detectLegacyBasis(rows);
    assert.equal(r.offsetMinutes, 480, '噪声差值 +60 不该被选成偏移');
    assert.equal(r.boundaryAuditId, 41);
    // 行 42 (噪声行的 id) 必须留在新基准侧
    assert.ok(r.boundaryAuditId < 42, '噪声行不得被拉进旧基准块');
  });

  test('A2 全部行都是旧基准 ⇒ 判定出偏移, 分界 = 最后一行 id', () => {
    const rows = makeLegacyOnlyRows(10, 480);
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.boundaryAuditId, 10);
    assert.equal(r.legacyRowCount, 10);
  });

  test('A2b 旧基准只有一部分行带证据 ⇒ 只平移被证实的块 (保守, 不猜)', () => {
    // 5 行带证据 + 2 行没证据, 全部都是旧基准。列值单调 ⇒ 不变式无法把
    // 后 2 行区分出来 ⇒ 只动被证实的 5 行。
    const rows = makeLegacyOnlyRows(7, 480);
    for (const idx of [5, 6]) {
      rows[idx] = { ...rows[idx], payload: { note: 'no embedded instant' } };
    }
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.boundaryAuditId, 5);
    assert.equal(r.legacyRowCount, 5);
  });

  test('A3 全是 UTC 基准 ⇒ 判定为"没有旧基准"', () => {
    const rows = makeRows(0, 10, 480);
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'no_legacy_proof');
    assert.equal(r.offsetMinutes, null);
  });

  test('A4 两个候选偏移证据数相同 ⇒ 拒绝判定 (不猜)', () => {
    const rows = makeRows(6, 6, 480);
    // 手工造 6 行"偏移 -60"的证据, 让它跟 +480 的证据数打平
    const baseMs = Date.UTC(2026, 9, 26, 6, 0, 0);
    for (let i = 0; i < 6; i += 1) {
      rows.push({
        id: 900 + i,
        createdAt: formatNaiveUtc(baseMs - 60 * 60000),
        payload: { generatedAt: new Date(baseMs).toISOString() }
      });
    }
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'ambiguous_offset');
    assert.equal(r.offsetMinutes, null);
  });

  test('A5 旧基准与 UTC 交错 ⇒ 拒绝判定', () => {
    const rows = makeRows(6, 6, 480);
    // 把第 8 行 (UTC 侧) 改写成旧基准 ⇒ 交错
    const truthMs = Date.UTC(2026, 9, 26, 6, 40, 59) + 7 * 1000;
    rows[7] = {
      id: 8,
      createdAt: formatNaiveUtc(truthMs + 480 * 60000),
      payload: { generatedAt: new Date(truthMs).toISOString() }
    };
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'interleaved_basis');
    assert.equal(r.offsetMinutes, null);
  });

  test('A6 旧基准证据只有 1 行 ⇒ 拒绝判定', () => {
    const rows = makeRows(1, 6, 480);
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'weak_legacy_evidence');
    assert.equal(r.offsetMinutes, null);
  });

  test('A7 非 15 分钟整数倍的偏移不被当成候选', () => {
    const rows = makeRows(6, 6, 7);
    const r = detectLegacyBasis(rows);
    // 7 分钟不是合法时区偏移 ⇒ 不能成为候选 ⇒ 判成"没有旧基准"
    assert.equal(r.status, 'no_legacy_proof');
    assert.equal(r.offsetMinutes, null);
  });

  test('A8 空表 ⇒ status=empty', () => {
    const r = detectLegacyBasis([]);
    assert.equal(r.status, 'empty');
    assert.equal(r.offsetMinutes, null);
  });

  test('A9 超过 UTC-14..UTC+14 的偏移不被当成候选', () => {
    const rows = makeRows(6, 6, 900);
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'no_legacy_proof');
    assert.equal(r.offsetMinutes, null);
  });

  test('A10 序列里有两处回落 ⇒ 数据不自洽 ⇒ 拒绝 (一行都不改)', () => {
    // 三行, 列值连续回落 (10:00 → 09:00 → 08:00)。任何分界都救不回单调性:
    // 回落只能由"基准切换"解释一次 ⇒ 两处回落 = 数据不自洽。
    const base = Date.UTC(2026, 9, 26, 2, 0, 0);
    const rows = [
      { id: 1, createdAt: '2026-10-26 10:00:00', payload: { at: new Date(base).toISOString() } },
      { id: 2, createdAt: '2026-10-26 09:00:00', payload: { at: new Date(base - 3600000).toISOString() } },
      { id: 3, createdAt: '2026-10-26 08:00:00', payload: { at: new Date(base - 7200000).toISOString() } }
    ];
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'inconsistent_sequence', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, null);
    assert.equal(r.boundaryAuditId, null);
  });

  test('A11 重建后的最新一行晚于当前时钟 ⇒ 拒绝 (说明新基准未必是 UTC)', () => {
    const rows = makeRows(41, 6, 480);
    // 假装"现在"是 2026-01-01 ⇒ 重建后的最新一行 (2026-10-26) 在未来
    const r = detectLegacyBasis(rows, Date.UTC(2026, 0, 1));
    assert.equal(r.status, 'future_newest_row', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, null);
    assert.equal(r.boundaryAuditId, null);
  });

  test('A12 分界由不变式定夺: 回落点就是分界 (与证据下界不一致时以不变式为准)', () => {
    // 旧基准 = id 1..5, 但只有 id 1..2 带证据 ⇒ 证据下界是 2, 而真实的
    // 回落点在 5 ⇒ 不变式给出的唯一合法分界是 5。
    const rows = makeRows(5, 5, 480);
    for (const idx of [2, 3, 4]) {
      rows[idx] = { ...rows[idx], payload: { note: 'no embedded instant' } };
    }
    const r = detectLegacyBasis(rows);
    assert.equal(r.status, 'detected', JSON.stringify(r.reasons));
    assert.equal(r.offsetMinutes, 480);
    assert.equal(r.boundaryAuditId, 5);
    assert.equal(r.legacyRowCount, 5);
  });
});

// ---------------------------------------------------------------------------
// B. naive ↔ UTC 换算与平移
// ---------------------------------------------------------------------------

describe('B. naive ↔ UTC 的换算与平移', () => {
  test('B1 naive 串按 UTC 解读', () => {
    const ms = naiveToUtcMs('2026-10-26 06:40:59');
    assert.equal(new Date(ms).toISOString(), '2026-10-26T06:40:59.000Z');
  });

  test('B2 formatNaiveUtc 往返', () => {
    const ms = naiveToUtcMs('2026-10-26 21:03:03');
    assert.equal(formatNaiveUtc(ms), '2026-10-26 21:03:03');
  });

  test('B3 shiftNaiveUtc 往前平移 480 分钟', () => {
    assert.equal(shiftNaiveUtc('2026-10-26 21:03:03', 480), '2026-10-26 13:03:03');
  });

  test('B4 shiftNaiveUtc 负偏移往回平移', () => {
    assert.equal(shiftNaiveUtc('2026-10-26 01:03:03', -300), '2026-10-26 06:03:03');
  });

  test('B5 平移跨天跨月正确', () => {
    assert.equal(shiftNaiveUtc('2026-11-01 00:30:00', 480), '2026-10-31 16:30:00');
    assert.equal(shiftNaiveUtc('2026-03-01 00:30:00', 60), '2026-02-28 23:30:00');
  });

  test('B6 解析不了的输入返回 null (不猜)', () => {
    assert.equal(naiveToUtcMs('not-a-time'), null);
    assert.equal(naiveToUtcMs(null), null);
    assert.equal(naiveToUtcMs(undefined), null);
    assert.equal(shiftNaiveUtc('not-a-time', 480), null);
  });
});

// ---------------------------------------------------------------------------
// C. 只认带时区标记的 ISO 时刻
// ---------------------------------------------------------------------------

describe('C. ISO 时刻的采集', () => {
  test('C1 带 Z 的时刻被采集', () => {
    const out = collectZonedIsoInstants({ at: '2026-10-26T06:40:59.836Z' });
    assert.equal(out.length, 1);
    assert.equal(new Date(out[0]).toISOString(), '2026-10-26T06:40:59.836Z');
  });

  test('C2 naive 时刻被忽略 (没有独立真值)', () => {
    const out = collectZonedIsoInstants({ at: '2026-10-26T06:40:59' });
    assert.equal(out.length, 0);
  });

  test('C3 带偏移的时刻被采集', () => {
    const out = collectZonedIsoInstants({ at: '2026-10-26T14:40:59+08:00' });
    assert.equal(out.length, 1);
    assert.equal(new Date(out[0]).toISOString(), '2026-10-26T06:40:59.000Z');
  });

  test('C4 无冒号的偏移 (+0800) 也能解析', () => {
    const out = collectZonedIsoInstants({ at: '2026-10-26T14:40:59+0800' });
    assert.equal(out.length, 1);
    assert.equal(new Date(out[0]).toISOString(), '2026-10-26T06:40:59.000Z');
  });

  test('C5 嵌套结构里的时刻被递归采集', () => {
    const out = collectZonedIsoInstants({
      a: { b: [{ c: '2026-10-26T06:40:59Z' }] }
    });
    assert.equal(out.length, 1);
  });

  test('C6 payload 是 JSON 字符串时也能采集', () => {
    const out = collectZonedIsoInstants(JSON.stringify({ at: '2026-10-26T06:40:59Z' }));
    assert.equal(out.length, 1);
  });
});

// ---------------------------------------------------------------------------
// D. 回填的幂等性 + 前像可逆
// ---------------------------------------------------------------------------

/**
 * 假 db: 只实现 audit-utc-baseline 用到的那几个查询/写入。
 * 内存里存一张 audit_logs 和一张备份表, 用来验证"跑第二遍不二次平移"。
 */
function makeFakeDb(dialect, auditRows) {
  const state = {
    audit: new Map(auditRows.map((r) => [r.id, { ...r }])),
    backup: new Map(),
    executed: []
  };
  const db = {
    dialect,
    sql: buildSql(dialect),
    state,
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes(`FROM ${AUDIT_UTC_BACKUP_TABLE}`)) {
        return { rows: [...state.backup.values()].map((b) => ({ audit_id: b.audit_id })) };
      }
      if (text.includes('FROM audit_logs a')) {
        const boundary = Number(params[0]);
        const rows = [...state.audit.values()]
          .filter((r) => (Number.isFinite(boundary) ? r.id <= boundary : true))
          .sort((x, y) => x.id - y.id)
          .map((r) => ({ id: r.id, createdAt: r.createdAt }));
        return { rows };
      }
      return { rows: [] };
    },
    async execute(sql, params = []) {
      const text = String(sql);
      state.executed.push({ sql: text, params: [...params] });
      if (text.includes(`INSERT INTO ${AUDIT_UTC_BACKUP_TABLE}`)) {
        for (let i = 0; i < params.length; i += 5) {
          const [auditId, original, shifted, offsetMinutes, baselineVersion] = params.slice(i, i + 5);
          state.backup.set(Number(auditId), {
            audit_id: Number(auditId),
            original_created_at: original,
            shifted_created_at: shifted,
            offset_minutes: offsetMinutes,
            baseline_version: baselineVersion
          });
        }
        return { affectedRows: params.length / 5, rowsAffected: params.length / 5 };
      }
      if (text.includes('UPDATE')) {
        let affected = 0;
        for (const b of state.backup.values()) {
          const row = state.audit.get(b.audit_id);
          if (!row) continue;
          row.createdAt = b.shifted_created_at;
          affected += 1;
        }
        return { affectedRows: affected, rowsAffected: affected };
      }
      return { affectedRows: 0, rowsAffected: 0 };
    }
  };
  return db;
}

describe('D. 回填的幂等性与前像', () => {
  for (const dialect of ['mysql', 'mssql']) {
    test(`D1 ${dialect}: 旧基准行被平移到真 UTC`, async () => {
      const rows = makeRows(5, 2, 480);
      const db = makeFakeDb(dialect, rows);
      const r = await applyAuditUtcBackfill(
        db,
        { offsetMinutes: 480, boundaryAuditId: 5 },
        null
      );
      assert.equal(r.backedUp, 5);
      assert.equal(r.shifted, 5);
      // id 1: 真值 06:40:59 ⇒ 平移后必须是 06:40:59
      assert.equal(db.state.audit.get(1).createdAt, '2026-10-26 06:40:59');
      // id 6 (UTC 侧) 不该被动
      assert.equal(db.state.audit.get(6).createdAt, '2026-10-26 06:41:04');
    });

    test(`D2 ${dialect}: 跑第二遍不二次平移 (幂等)`, async () => {
      const rows = makeRows(5, 2, 480);
      const db = makeFakeDb(dialect, rows);
      const baseline = { offsetMinutes: 480, boundaryAuditId: 5 };
      await applyAuditUtcBackfill(db, baseline, null);
      const afterFirst = db.state.audit.get(1).createdAt;
      const second = await applyAuditUtcBackfill(db, baseline, null);
      assert.equal(second.backedUp, 0, '第二遍不应再往前像');
      assert.equal(db.state.audit.get(1).createdAt, afterFirst);
      assert.equal(afterFirst, '2026-10-26 06:40:59');
    });

    test(`D3 ${dialect}: 前像表留住了原值 (可逆)`, async () => {
      const rows = makeRows(3, 1, 480);
      const db = makeFakeDb(dialect, rows);
      await applyAuditUtcBackfill(db, { offsetMinutes: 480, boundaryAuditId: 3 }, null);
      const backup = db.state.backup.get(1);
      assert.equal(backup.original_created_at, '2026-10-26 14:40:59');
      assert.equal(backup.shifted_created_at, '2026-10-26 06:40:59');
      assert.equal(backup.offset_minutes, 480);
    });

    test(`D4 ${dialect}: 非法偏移直接抛错, 不动数据`, async () => {
      const db = makeFakeDb(dialect, makeRows(3, 1, 480));
      await assert.rejects(
        () => applyAuditUtcBackfill(db, { offsetMinutes: 'abc', boundaryAuditId: 3 }, null),
        /偏移/
      );
      await assert.rejects(
        () => applyAuditUtcBackfill(db, { offsetMinutes: 480, boundaryAuditId: -1 }, null),
        /分界/
      );
      assert.equal(db.state.executed.length, 0);
    });
  }
});

// ---------------------------------------------------------------------------
// E. 迁移文件契约
// ---------------------------------------------------------------------------

describe('E. 迁移文件契约', () => {
  const mysqlFile = path.join(MYSQL_MIGRATIONS, '1.0.2-audit-utc-baseline.sql');
  const mssqlFile = path.join(MSSQL_MIGRATIONS, '1.0.2-audit-utc-baseline.sql');

  test('E1 双方言的迁移文件都在', () => {
    assert.ok(fs.existsSync(mysqlFile), `缺 ${mysqlFile}`);
    assert.ok(fs.existsSync(mssqlFile), `缺 ${mssqlFile}`);
  });

  test('E2 MySQL 迁移建出前像备份表, 且列齐全', () => {
    const sql = fs.readFileSync(mysqlFile, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS\s+audit_logs_utc_baseline_backup/i);
    for (const col of [
      'audit_id',
      'original_created_at',
      'shifted_created_at',
      'offset_minutes',
      'baseline_version'
    ]) {
      assert.ok(sql.includes(col), `备份表缺列 ${col}`);
    }
    assert.match(sql, /PRIMARY KEY\s*\(audit_id\)/i);
  });

  test('E3 MySQL 迁移: DDL 之前必须先设 lock_wait_timeout', () => {
    const sql = fs.readFileSync(mysqlFile, 'utf8');
    const lockIdx = sql.indexOf('lock_wait_timeout');
    const ddlIdx = sql.search(/CREATE\s+TABLE/i);
    assert.ok(lockIdx >= 0, '缺 SET SESSION lock_wait_timeout');
    assert.ok(ddlIdx >= 0, '缺 CREATE TABLE');
    assert.ok(lockIdx < ddlIdx, 'SET SESSION lock_wait_timeout 必须在 DDL 之前');
  });

  test('E4 偏移绝不写死在迁移里 (它是部署相关的量, 不是产品常量)', () => {
    for (const file of [mysqlFile, mssqlFile]) {
      const sql = fs.readFileSync(file, 'utf8');
      // 去掉注释后再找 —— 注释里可以写"本机实测 +480"
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      assert.ok(!/INTERVAL\s+480/i.test(code), `${file} 把偏移写死成了 480`);
      assert.ok(!/480\s*\*\s*60/i.test(code), `${file} 把偏移写死成了 480`);
    }
  });

  test('E5 MSSQL 迁移建出同构的备份表', () => {
    const sql = fs.readFileSync(mssqlFile, 'utf8');
    assert.match(sql, /OBJECT_ID\('\[audit_logs_utc_baseline_backup\]'/i);
    for (const col of [
      'audit_id',
      'original_created_at',
      'shifted_created_at',
      'offset_minutes',
      'baseline_version'
    ]) {
      assert.ok(sql.includes(col), `备份表缺列 ${col}`);
    }
  });

  test('E6 MSSQL 迁移不得改动 audit_logs 的列定义 (它的 DEFAULT 本来就是 UTC)', () => {
    const sql = fs.readFileSync(mssqlFile, 'utf8');
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/ALTER\s+TABLE\s+\[?audit_logs\]?/i.test(code), 'MSSQL 迁移不许 ALTER audit_logs');
  });

  test('E7 单一真源的 key 稳定', () => {
    assert.equal(AUDIT_UTC_BASELINE_KEY, 'audit_utc_baseline');
    assert.ok(AUDIT_UTC_BASELINE_KEY.length <= 64, 'config_key 是 VARCHAR(64)');
  });
});

// ---------------------------------------------------------------------------
// F. 向前修复: 写入必须显式带 UTC
// ---------------------------------------------------------------------------

describe('F. 向前修复 (写入显式 UTC, 不靠列默认值)', () => {
  test('F1 audit.write 必须显式写 created_at (双方言)', () => {
    const mysql = buildSql('mysql');
    const mssql = buildSql('mssql');
    assert.match(mysql.audit.write, /created_at/i, 'MySQL 版没显式写 created_at');
    assert.match(mysql.audit.write, /UTC_TIMESTAMP\(\)/i, 'MySQL 版必须用 UTC_TIMESTAMP()');
    assert.match(mssql.audit.write, /created_at/i, 'MSSQL 版没显式写 created_at');
    assert.match(mssql.audit.write, /SYSUTCDATETIME\(\)/i, 'MSSQL 版必须用 SYSUTCDATETIME()');
  });

  test('F2 audit.write 的占位符个数仍是 4 (两边一致, 不改调用方契约)', () => {
    const countQ = (sql) => (sql.match(/\?/g) || []).length;
    assert.equal(countQ(buildSql('mysql').audit.write), 4);
    assert.equal(countQ(buildSql('mssql').audit.write), 4);
  });

  test('F3 audit.write 不再依赖列默认值 (SQL 里不能出现裸 INSERT 4 列形态)', () => {
    const mysql = buildSql('mysql');
    assert.ok(
      !/INSERT INTO audit_logs \(user_id, action, target, payload\) VALUES/i.test(mysql.audit.write),
      'MySQL audit.write 还在靠 DEFAULT CURRENT_TIMESTAMP'
    );
  });

  test('F4 config.upsert 的插入路径也必须显式写 updated_at', () => {
    const mysql = buildSql('mysql');
    const mssql = buildSql('mssql');
    assert.match(mysql.config.upsert, /updated_at/i);
    assert.match(mysql.config.upsert, /UTC_TIMESTAMP\(\)/i);
    assert.match(mssql.config.upsert, /updated_at/i);
    assert.match(mssql.config.upsert, /SYSUTCDATETIME\(\)/i);
  });

  test('F5 config.upsert 的占位符个数不变 (2 个)', () => {
    const countQ = (sql) => (sql.match(/\?/g) || []).length;
    assert.equal(countQ(buildSql('mysql').config.upsert), 2);
    assert.equal(countQ(buildSql('mssql').config.upsert), 2);
  });
});

// ---------------------------------------------------------------------------
// G. 启动期接线
// ---------------------------------------------------------------------------

describe('G. 启动期接线', () => {
  test('G1 server.js 必须调用 ensureAuditUtcBaseline', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'server.js'), 'utf8');
    assert.ok(src.includes('ensureAuditUtcBaseline'), 'server.js 没有接 audit-utc-baseline');
    assert.ok(src.includes('audit-utc-baseline.js'), 'server.js 没 import audit-utc-baseline');
  });

  test('G2 启动期调用必须包在 try/catch 里 (回填失败不该阻断启动)', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'server.js'), 'utf8');
    const idx = src.indexOf('ensureAuditUtcBaseline({ logger })');
    assert.ok(idx > 0, '找不到启动期调用');
    const before = src.slice(Math.max(0, idx - 400), idx);
    const after = src.slice(idx, idx + 400);
    assert.ok(/try\s*\{/.test(before), '启动期调用必须包在 try 里');
    assert.ok(/catch\s*\(/.test(after), '启动期调用必须包在 catch 里');
  });
});

// ---------------------------------------------------------------------------
// H. Linux 交付包的逐字节镜像
//
// LinuxServer/ 是**手抄副本**, 不是构建产物 ⇒ 抄漏一处 = 目标机跑旧代码。
// R161.16 实测: R161.11 给邮件路由接 logger 时只抄了 center/src/**,
// 漏了 center/server.js (进程的入口, 不在任何一棵被比对的目录下)
// ⇒ 交付包里的邮件链路仍然零日志, 也就是 R161.11 要修的症状原样复发。
//
// 本套件锁死: 本轮改过的每个文件, 在交付包里必须逐字节一致。
// ---------------------------------------------------------------------------

describe('H. Linux 交付包的逐字节镜像', () => {
  const MIRROR_PAIRS = [
    {
      rel: 'center/server.js',
      from: path.join(CENTER_ROOT, 'server.js'),
      to: path.join(REPO_ROOT, 'LinuxServer', 'center', 'server.js')
    },
    {
      rel: 'center/src/db/sql.js',
      from: path.join(CENTER_ROOT, 'src', 'db', 'sql.js'),
      to: path.join(REPO_ROOT, 'LinuxServer', 'center', 'src', 'db', 'sql.js')
    },
    {
      rel: 'center/src/services/audit-utc-baseline.js',
      from: path.join(CENTER_ROOT, 'src', 'services', 'audit-utc-baseline.js'),
      to: path.join(REPO_ROOT, 'LinuxServer', 'center', 'src', 'services', 'audit-utc-baseline.js')
    },
    {
      rel: 'db/migrations/mysql/1.0.2-audit-utc-baseline.sql',
      from: path.join(MYSQL_MIGRATIONS, '1.0.2-audit-utc-baseline.sql'),
      to: path.join(LINUX_MYSQL_MIGRATIONS, '1.0.2-audit-utc-baseline.sql')
    },
    {
      rel: 'db/migrations/mssql/1.0.2-audit-utc-baseline.sql',
      from: path.join(MSSQL_MIGRATIONS, '1.0.2-audit-utc-baseline.sql'),
      to: path.join(LINUX_MSSQL_MIGRATIONS, '1.0.2-audit-utc-baseline.sql')
    }
  ];

  test('H1 每个镜像对的两侧都存在', () => {
    for (const pair of MIRROR_PAIRS) {
      assert.ok(fs.existsSync(pair.from), `源树缺 ${pair.rel}`);
      assert.ok(fs.existsSync(pair.to), `交付包缺 ${pair.rel}`);
    }
  });

  test('H2 每个镜像对逐字节一致 (抄漏 = 目标机跑旧代码)', () => {
    for (const pair of MIRROR_PAIRS) {
      const source = fs.readFileSync(pair.from);
      const linux = fs.readFileSync(pair.to);
      assert.ok(
        source.equals(linux),
        `${pair.rel} 在交付包里与源树不一致 —— 交付包会跑旧代码`
      );
    }
  });

  test('H3 漂移检测器必须把 center/server.js 纳入比对 (它不在任何目录树里)', () => {
    const checker = fs.readFileSync(
      path.join(SERVER_ROOT, 'scripts', 'audit', 'check-linux-package-sync.mjs'),
      'utf8'
    );
    assert.ok(checker.includes('FILE_PAIRS'), '漂移检测器没有单文件比对机制');
    assert.ok(
      /join\(SOURCE,\s*'center',\s*'server\.js'\)/.test(checker),
      '漂移检测器没有比对 center/server.js —— 这正是 R161.11 漏抄的那一处'
    );
    assert.ok(checker.includes('checkFilePairDrift()'), '单文件比对函数没有被调用');
  });

  test('H4 漂移检测器必须真的调用 C1b (不是定义了就完事)', () => {
    const checker = fs.readFileSync(
      path.join(SERVER_ROOT, 'scripts', 'audit', 'check-linux-package-sync.mjs'),
      'utf8'
    );
    const callIdx = checker.indexOf('checkFilePairDrift();');
    assert.ok(callIdx > 0, 'C1b 没有被调用');
    assert.ok(
      checker.indexOf('function checkFilePairDrift') < callIdx,
      'C1b 的调用出现在定义之前'
    );
  });
});

