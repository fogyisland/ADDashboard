// R161.7 (2026-10-26) — 许可证状态的**唯一判定实现** (前端侧)。
//
// ★ 为什么要抽出来 (operator 2026-10-26 原话):
//   「当前默认安装后的本地送 30 的激活状态没有显示, 是不需要还是没有激活呢?」
//
//   "本地送 30" = 默认安装自动授予的 **30 天试用** (服务端 TRIAL_DAYS=30,
//   installed_at 锚点, 放在 license-state envelope 的 trial 字段里)。
//   答案是: **试用是有的**, 不是"不需要" —— 之前没显示是因为许可证页的
//   「当前许可证状态」卡片**只读 localStorage** (base32_license_status_v1),
//   完全没读服务端 envelope。三个后果:
//     ① 「未激活」徽标讲的是"base32 正式授权没录入过" —— 默认安装下这是事实,
//        但它把"本地送 30 天"这件事整个吞掉了 (只在登录页 banner 里出现过);
//     ② 真正激活过也会显示「未激活」 (换浏览器 / 清缓存 ⇒ localStorage 空),
//        因为 localStorage 从来不是激活事实的真源;
//     ③ 服务端 DB 异常时 (status='unknown') 若照抄 has_license:false, 会把
//        "查不到"显示成"未激活" —— 谎报事实。
//
// ★ 判定优先级 (单一真源, 模板只读本函数的结果, 0 在模板里现算):
//     ① serverState.has_license === true   → 已激活 (正式授权)
//     ② 服务端可信 且 trial.days_remaining >= 0  → 试用中 (还剩 N 天)
//     ③ 服务端可信 且 trial.days_remaining < 0   → 试用已过期 N 天
//     ④ 服务端可信 且 没授权也没试用信息        → 未激活
//     ⑤ 服务端**不可信** (status='unknown' 的 DB 异常, 或端点压根没拿到)
//        → 状态未知 —— **不**谎报「未激活」, 也**不**拿「试用中」冒充许可证状态
//          (试用确实还在跑, 但"有没有正式授权"查不到, 用试用徽标会误导)。
//          试用剩余天数仍在「本地试用」那一行单独呈现 (试用不依赖 DB)。
//          localStatus 里若有激活记录, 仍可升级成「已激活」(= 旧行为, 0 回归)。
//
// ★ 服务端可信 = serverState 存在 且 status !== 'unknown'。status='unknown'
//   是服务端自己 fail-closed 的结果 (DB 异常), 这时它的 has_license:false
//   **不是事实**。
//
// ★ 数据源分工:
//     服务端 envelope = 激活**事实** (has_license / status / expires_at /
//       instance_id / license_kind / trial) —— 唯一真源。
//     localStorage   = **本地回显**, 只补服务端给不出的字段: 许可证密钥掩码
//       (服务端只存 hash, 存不了明文) 与激活时间。
//
// 回归网: center/tests/license-status-view.test.js
//   (与后端 src/services/license-state.js 的 envelope 形状 1:1 对齐;
//    改这份判定时**必须**同时改那边。)

/**
 * @typedef {object} ServerLicenseState
 * @property {boolean} has_license
 * @property {string} status              'active' | 'expiring_soon' | 'expired' | 'none' | 'unknown'
 * @property {number|null} days_remaining
 * @property {string|null} expires_at
 * @property {string|null} instance_id
 * @property {string|null} license_kind
 * @property {object|null} trial
 */

/**
 * @typedef {object} LocalLicenseStatus
 * @property {boolean} [has_license]
 * @property {string} [license_key_masked]
 * @property {string} [license_kind]
 * @property {string} [activated_at]
 * @property {string} [expires_at]
 * @property {string} [instance_id]
 * @property {string} [request_id]
 */

/**
 * @typedef {object} LicenseView
 * @property {{text: string, cls: string}} badge      状态徽标
 * @property {object|null} detail                     详情行数据源
 * @property {object|null} trial                      服务端 trial envelope
 * @property {boolean} trialKnown                     days_remaining 是否是有限数
 * @property {number|null} daysRemaining
 * @property {boolean} hasLicense                     有没有正式授权
 * @property {boolean} serverKnown                    服务端状态是否**可信**
 *   (status==='unknown' ⇒ 不可信, has_license:false 不是事实)
 */

/**
 * 许可证状态视图的单一真源判定。
 *
 * @param {object} input
 * @param {ServerLicenseState|null} [input.serverState] 服务端 license-state envelope
 * @param {LocalLicenseStatus|null} [input.localStatus] 本地缓存 (localStorage) 回显
 * @returns {LicenseView}
 */
export function resolveLicenseView({ serverState, localStatus } = {}) {
  const server = serverState ?? null;
  const local = localStatus ?? null;

  // status === 'unknown' = 服务端自己 fail-closed 了 (DB 异常) ⇒ 它的
  // has_license:false **不是事实**, 不能据此说"未激活"。
  const serverKnown = !!server && server.status !== 'unknown';

  const hasLicense = serverKnown
    ? server.has_license === true
    : (local?.has_license === true);

  const trial = server?.trial ?? null;
  const daysRemaining = Number(trial?.days_remaining);
  const trialKnown = Number.isFinite(daysRemaining);

  let badge;
  if (hasLicense) {
    badge = { text: '已激活', cls: 'active' };
  } else if (serverKnown && trialKnown && daysRemaining >= 0) {
    badge = { text: `试用中 · 剩 ${daysRemaining} 天`, cls: 'trial' };
  } else if (serverKnown && trialKnown) {
    badge = { text: `试用已过期 ${Math.abs(daysRemaining)} 天`, cls: 'expired' };
  } else if (serverKnown) {
    badge = { text: '未激活', cls: 'inactive' };
  } else {
    badge = { text: '状态未知', cls: 'inactive' };
  }

  // 详情行数据源: 服务端字段优先, 本地缓存补服务端没有的 (掩码密钥 / 激活时间)。
  const detail = hasLicense
    ? {
        ...(local || {}),
        has_license: true,
        expires_at: serverKnown ? (server.expires_at ?? null) : (local?.expires_at ?? null),
        instance_id: serverKnown ? (server.instance_id ?? null) : (local?.instance_id ?? null),
        license_kind: serverKnown ? (server.license_kind ?? null) : (local?.license_kind ?? null),
        days_remaining: serverKnown ? (server.days_remaining ?? null) : null
      }
    : (local || null);

  return {
    badge,
    detail,
    trial,
    trialKnown,
    daysRemaining: trialKnown ? daysRemaining : null,
    hasLicense,
    serverKnown
  };
}
