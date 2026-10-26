// center/src/services/install-anchor.js
// R158.Trial-anchor (2026-10-22) — 安装锚点: 防"重装程序重置 30 天试用".
//
// === 问题 ===
// license-state.js computeTrial 的试用时钟真源 = appsettings.json.installedAt,
//   该文件由安装器写。重装程序 (install-center.ps1 覆盖 InstallPath) 会重写该字段
//   → 试用从 30 天重新开始。
//
// === 密钥材料 ===
//   HMAC 密钥 = appsettings.json.signature (32 hex), 经参数注入。
//   install-center.ps1:140 的 Copy-Item 带 -Exclude 'node_modules','tests',
//   'appsettings.json' —— 升级安装**不覆盖** appsettings.json, 所以 signature
//   在重装后保持不变 = reinstall-resistant。
//   ensureSignatureAndInstalledAt 幂等 (只在 signature 缺失/非法时才生成),
//   因此重复跑安装器不会轮换密钥。
//
//   选 signature 而非 instance_id: 后者位于 data/instance_id, 虽同样不被覆盖,
//   但它是 license-codec 的 PBKDF2 material, 语义归属 license 激活链; 复用会让
//   两处密钥耦合 (任一处轮换另一处失效)。signature 语义就是"本机身份指纹"。
//
// === 数据形态 ===
//   system_config 一行, config_key = 'install_anchor':
//     { v:1, at:'YYYY-MM-DD', machine:'<mac>', h:'<64hex>' }
//   h = HMAC-SHA256(key=本地sig, msg=`v1|${at}|${本地sig}|${machine}`)
//
//   **签名 sig 只存在于 appsettings.json, 绝不入库。** 密钥与它保护的数据
//   存在一起 = 机制归零: 有 DB 读权限者拿到 sig 即可伪造任意合法锚点。
//   parseAnchorValue 见到行里有 sig 直接返 legacy_sig_present 拒绝验签。
//
//   三重绑定:
//     at      — 防篡改日期 (改回今天 → hmac 破)
//     sig     — 防整行复制到另一台机 (换机后本地 sig 不同 → 必破)
//     machine — 锚定物理机, 同一 sig 在多机间复制 → machine 不同 → 破
//
// === 三态判定 (computeAnchoredStartedAt 的 date_source) ===
//   db_anchor_verified    — DB 有锚点, HMAC 通过 → 用 DB 的 at
//   db_anchor_missing     — DB 无锚点行 → 当新装 (操作员 directive "纯空无所谓"),
//                           走文件日期 + 幂等建锚
//   db_anchor_tampered    — DB 有行但 HMAC 失败 → fail-closed: 回落文件日期,
//                           且**不回写** (不覆盖证据), 记 warn 日志
//
//   db_anchor_missing 不 fail-closed 的理由: 全新部署必须能走通, 否则无法安装。
//   纯空库重装**防不住** —— 没有本地状态能在被完全删除后仍证明自己曾存在。
//
// === 与文件日期的关系 ===
//   DB 锚点是**下限**, 不是唯一真源。调用方取 min(db_at, file_at):
//   "改文件日期往后推"无效 (DB 仍是旧日期); "删 DB 行"落到 db_anchor_missing
//   而按文件日期走 —— 这正是 "纯空无所谓" 接受的边界。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { installAnchorSql } from '../db/sql/install-anchor.js';

// system_config 里锚点行的键名。与其他 system_config 键同表, 复用既有的
// 读写通道 (R158.X.99.36b: UPDATE 匹配 0 行不报错会虚报 written++, 必须 upsert)。
export const ANCHOR_KEY = 'install_anchor';

// 锚点格式版本。字段增删时 +1, 验签时版本不符 → tampered (不猜旧版语义)。
export const ANCHOR_VERSION = 1;

const ANCHOR_DESCRIPTION = '安装锚点 — 安装日期 + 本机 signature 的 HMAC, 防重装重置试用期';

// anchorMessage — 消息含版本前缀, 防止未来改字段名时旧签名被误判为有效。
function anchorMessage({ at, sig, mac }) {
  return `v${ANCHOR_VERSION}|${at}|${sig}|${mac}`;
}

// computeAnchorHmac — 算锚点的 h 值。export 供回填脚本与测试复用。
export function computeAnchorHmac({ at, sig, mac }) {
  return createHmac('sha256', Buffer.from(String(sig), 'utf8'))
    .update(anchorMessage({ at, sig, mac }))
    .digest('hex');
}

// primaryMac — 取第一个非内部网卡的 MAC (跳过 loopback / 全 0)。
//   仅作锚点的辅助材料, 取不到就存空串 —— 空串同样参与 HMAC, 不影响校验
//   确定性 (两侧算的是同一个空串)。此处不抛错: 取不到 MAC 的部署
//   (容器 / 精简系统) 仍应能走通安装流程。
export function primaryMac() {
  const ifaces = networkInterfaces() || {};
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      const isV4 = addr.family === 'IPv4' || addr.family === 4;
      if (!isV4 || addr.internal) continue;
      const mac = String(addr.mac || '').toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00') continue;
      return mac;
    }
  }
  return '';
}

// buildAnchorValue — 组一条合法的锚点 JSON 字符串。
//
//   **签名 sig 绝不入库。** 它是 HMAC 的密钥材料, 落进 system_config 等于
//   把密钥和它保护的数据存在一起: 任何有 DB 读权限的人 (SQL 注入 / 备份
//   泄露 / 只读账号) 拿到 sig 后就能自己算出任意日期的合法 h, 伪造锚点,
//   整个防篡改机制归零。密钥只存在于 appsettings.json (安装器 -Exclude
//   保证重装不覆盖), 验签时由调用方传入。
//
//   行里的 machine 字段只放 MAC (非秘密的机具标识), 供操作员诊断"这行是
//   哪台机写的"。它参与 HMAC 但不可单独用于伪造 —— 没有 sig 就算不出 h。
export function buildAnchorValue({ at, sig, mac }) {
  const payload = { v: ANCHOR_VERSION, at, sig, mac: mac || '' };
  return JSON.stringify({
    v: ANCHOR_VERSION,
    at,
    machine: mac || '',
    h: computeAnchorHmac(payload)
  });
}

// parseAnchorValue — 解析 DB 里的锚点行, 用本地 sig 验签。
//   返 { ok:true, at, sig, mac } 或 { ok:false, reason }。
//
//   任何形状不符都算 ok:false —— parse 失败与 hmac 失败同样导向 tampered,
//   不给"格式坏了就当没锚点"留后门 (那正是删行想达到的效果)。
export function parseAnchorValue(raw, expectedSig) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty' };
  if (typeof expectedSig !== 'string' || !/^[0-9a-f]{32}$/i.test(expectedSig)) {
    // 没有本地签名就没法验签 —— 此时**必须**拒绝, 不能"跳过验签当合法的看"。
    return { ok: false, reason: 'no_local_signature' };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'json_parse_failed' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' };
  if (obj.v !== ANCHOR_VERSION) return { ok: false, reason: 'version_mismatch' };
  if (typeof obj.at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.at)) {
    return { ok: false, reason: 'bad_installed_at' };
  }
  if (typeof obj.h !== 'string' || !/^[0-9a-f]{64}$/i.test(obj.h)) {
    return { ok: false, reason: 'bad_hmac_field' };
  }
  if ('sig' in obj) {
    // 老版本行里存过 sig。读到就说明是旧数据, 且**拒用**它验签 (自证漏洞),
    // 同时明确要求回填脚本按新格式重写 —— 留在库里本身就是泄漏。
    return { ok: false, reason: 'legacy_sig_present' };
  }
  const machine = typeof obj.machine === 'string' ? obj.machine : '';
  // 验签**必须**用本地 expectedSig。行里不含 sig, 因此不存在自证可能,
  // 也不存在"整行复制到另一台机"能用的情况 (换机后本地 sig 不同 → 失败)。
  const expected = computeAnchorHmac({ at: obj.at, sig: expectedSig, mac: machine });
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(obj.h, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'hmac_mismatch' };
  }
  return { ok: true, at: obj.at, machine };
}

// resolveAnchorSql — 取当前 dialect 的 SQL 对。
function resolveAnchorSql(db) {
  const dialect = db?.dialect;
  if (dialect === 'mysql' || dialect === 'mssql') return installAnchorSql[dialect];
  return null;
}

// readClaimedAt — **不验签**地读出行里声称的安装日期, 仅供展示。
//
//   为什么不复用 parseAnchorValue: 它在 hmac 失败时返 { ok:false, reason },
//   不透出 at —— 而展示恰恰最需要这个值 (让操作员看见"记录说哪天, 实际不符")。
//   这个值**永远不能**当计时器输入; 只有 parseAnchorValue 成功后的 at 才进
//   license-state 的日期计算。
//
//   解析不出来 (坏 JSON / 缺字段 / 格式不对) → 返 null, 前端显示 '—'。
export function readClaimedAt(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.at)) return null;
  return obj.at;
}

// computeAnchoredStartedAt — 读 DB 锚点, 返 { at, date_source, reason? }。
//   at 为 null 表示"无可用 DB 锚点", 调用方 (license-state.js) 回落文件日期。
//
//   localSig: 调用方从 appsettings 读到的 signature (readSignature 已封装
//   文件读取 + 32 hex 格式校验)。此处不自行读盘 —— 让配置读取保持单一入口。
//
//   绝不抛: 锚点是加固措施, DB 挂了不该让 license 页 500。
export async function computeAnchoredStartedAt(db, localSig, logger) {
  const sql = resolveAnchorSql(db);
  if (!sql) return { at: null, date_source: 'db_unavailable' };
  if (!localSig) {
    logger?.warn?.({}, 'install-anchor: local signature unavailable — cannot verify');
    return { at: null, date_source: 'db_anchor_no_local_sig' };
  }
  let rows;
  try {
    const r = await db.query(sql.getAnchor, [ANCHOR_KEY]);
    rows = r?.rows;
  } catch (err) {
    logger?.warn?.({ err: err?.message }, 'install-anchor: query failed — falling back to file date');
    return { at: null, date_source: 'db_query_failed' };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { at: null, date_source: 'db_anchor_missing' };
  }
  const parsed = parseAnchorValue(rows[0]?.config_value, localSig);
  if (!parsed.ok) {
    logger?.warn?.({ reason: parsed.reason }, 'install-anchor: failed verification — fail-closed, not rewriting');
    // at 仍然返回行里**能解析出的**日期 (即使验签失败)。调用方 license-state.js
    //   不会把它当作时钟使用 (tampered 时回落文件日期), 只把它透给前端做展示,
    //   让操作员看到"记录里的日期是哪天" 与 "实际不符" 时能警觉。
    //   若这里返 null, 前端只能显示文件日期 —— 而那正是攻击者改过的值,
    //   等于把篡改痕迹藏起来 (操作员 directive 2026-10-22: "验证这一串值能够
    //   解析成安装日期就显示你已经试用过, 安装日期为哪一天").
    const claimedAt = readClaimedAt(rows[0]?.config_value);
    return {
      at: null,
      claimed_at: claimedAt,
      date_source: 'db_anchor_tampered',
      reason: parsed.reason
    };
  }
  return { at: parsed.at, date_source: 'db_anchor_verified' };
}

// ensureAnchorRow — 幂等建锚: DB 无行时写入, 已有行则**不覆盖**。
//   覆盖 = 把篡改/过期状态洗回"干净", 等于给攻击者擦除痕迹。
//   故 SQL 用 WHEN NOT MATCHED THEN INSERT (无 MATCHED 分支), 不用 upsert。
//
//   预检查 (SELECT 先看有没有) 不是为了正确性 —— SQL 本身已幂等 —— 而是
//   为了能区分 written / already_present 返回值, 供调用方记账。
export async function ensureAnchorRow(db, localSig, logger, { at, mac } = {}) {
  const sql = resolveAnchorSql(db);
  if (!sql) return { written: false, reason: 'db_unavailable' };
  if (!at || !/^\d{4}-\d{2}-\d{2}$/.test(at)) return { written: false, reason: 'bad_installed_at' };
  if (!localSig || !/^[0-9a-f]{32}$/i.test(localSig)) {
    return { written: false, reason: 'bad_signature' };
  }
  const value = buildAnchorValue({ at, sig: localSig, mac });
  try {
    await db.query(sql.insertAnchorIfAbsent, [
      ANCHOR_KEY,
      value,
      ANCHOR_DESCRIPTION,
      'install-anchor'
    ]);
  } catch (err) {
    logger?.warn?.({ err: err?.message }, 'install-anchor: insert failed — non-fatal');
    return { written: false, reason: 'insert_failed' };
  }
  return { written: true, value };
}