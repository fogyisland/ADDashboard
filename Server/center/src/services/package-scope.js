// package-scope — package_policies.scope 的**唯一事实源**
//
// R158.86.5 (2026-10-12) 起, 中心端用 package_policies.scope 区分
// 「这个包该给哪一类代理跑」:
//
//   'agent_type:ad'     → 只给 DC 代理 (ad_* 包)
//   'agent_type:non-ad' → 只给成员代理 (member_* 包)
//   'global'            → 不按 agent 类型分流 (on-demand command 包,
//                          走 ad_admin_commands 生命周期, 不随包列表下发)
//
// 为什么单独一个模块 (R161.21, 2026-10-29):
//
//   1. **零依赖** —— 本模块不许 import 任何东西。回归网
//      tests/agent-packages-scope.test.js 要拿这张表当唯一事实源驱动
//      断言, 而 builtin-packages.js 会连带 import script-service →
//      db facade → mysql2/mssql (本机 center/node_modules 是空的,
//      装不上) ⇒ 测试会整个跑不起来。所以这张表必须能被**独立** import。
//   2. **单一事实源** —— 之前这张表内嵌在 builtin-packages.js 里,
//      builtin-packages.js 又 import 了 DB 相关模块 ⇒ 任何想断言
//      「哪些包该给成员代理」的测试都只能硬编码包名 = 第二份真相 =
//      迟早漂移 (R158.86.5 → R158.87.6.5 → R161.21 连续复发就是证据)。
//
// ★ 关于 manifest.agent.type: **不可信**。ad_os_baseline 的
//   manifest.agent.type 至今仍写着 'non-ad', 但它的 scope 是
//   'agent_type:ad'。判定归属永远看 scope, 不看 manifest。
//
// 口径: 18 条 (DC 15 + member 3)。加/减包时**必须**同步改这里,
//   否则那个包会落回 'global' ⇒ 两端都不下发 ⇒ 静默不跑。

export const SCOPE_AD = 'agent_type:ad';
export const SCOPE_NON_AD = 'agent_type:non-ad';
export const SCOPE_GLOBAL = 'global';

/**
 * 18 条白名单。DC 15 + member 3。
 * R158.86.5 起的写法: 不用 manifest.json 的 agent.type 推断
 * (ad_os_baseline 1.0.7 manifest.agent.type='non-ad' 错例, R158.56c
 * 时代遗留), 中心端 invariant 强。全列出来 operator 一眼看, 比改
 * manifest 稳。
 */
export const SCOPE_OVERRIDE = {
  // ---- DC-only 15 包 ----
  'ad_os_baseline':              SCOPE_AD,
  'ad_replication_status_probe': SCOPE_AD,
  'ad_account_change':           SCOPE_AD,
  'ad_dc_overview':              SCOPE_AD,
  'ad_dc_probe_inbound':         SCOPE_AD,
  // R158.X.116.d (2026-10-22) — 'ad_dc_probe_outbound' 已从
  //   BUILTIN_PACKAGES 移除, 所以这里**没有**它的条目 (曾经有过,
  //   删除时连白名单一起删干净了)。
  'ad_eventlog_collector':       SCOPE_AD,
  'ad_failed_logon_collector':   SCOPE_AD,
  'ad_lockout_list':             SCOPE_AD,
  'ad_lockout_summary':          SCOPE_AD,
  'ad_admin_members':            SCOPE_AD,
  'ad_partner_inbound_discover': SCOPE_AD,
  'ad_partner_ports_probe':      SCOPE_AD,
  'ad_ad_account_quickfix':      SCOPE_AD,
  'ad_ad_users_write':           SCOPE_AD,
  'ad_ad_groups_write':          SCOPE_AD,
  // ---- member-only 3 包 (公共表 mode, FK ad_member_servers 防 AD host 误写) ----
  'member_os_baseline_collector': SCOPE_NON_AD,
  'member_eventlog_collector':    SCOPE_NON_AD,
  // R158.100 (2026-10-13) — member-server 本地管理员组成员
  //   (BUILTIN\Administrators + Remote Desktop Users + Power Users)。
  //   Get-LocalGroupMember (0 AD RSAT)。24h cadence, MERGE dedup on
  //   (hostname, group_name, member_sid)。
  'member_admin_groups':          SCOPE_NON_AD
};

/**
 * 取某个包该有的 scope。未登记的包一律 'global'
 * (= 两端都不随包列表下发, 只走 on-demand command 通道)。
 *
 * @param {string} name 包名
 * @returns {string} scope 字符串
 */
export function scopeOfPackage(name) {
  return SCOPE_OVERRIDE[name] || SCOPE_GLOBAL;
}

/** 该包是不是成员代理该跑的 (scope 精确匹配, 不做前缀/包含匹配)。 */
export function isNonAdScoped(name) {
  return scopeOfPackage(name) === SCOPE_NON_AD;
}
