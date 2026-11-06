<template>
  <div class="rc-overview">
    <header class="page-header">
      <div class="title-block">
        <h1>报表中心</h1>
        <p class="subtitle">
          安全/异常类流水 (3 张) · 数据走 <code>/api/report-center/*</code> admin-only 端点
          · 全部数据无窗 (默认物理全量) · 100 行/页
        </p>
      </div>
    </header>

    <div class="rc-grid">
      <router-link
        v-for="c in visibleCards"
        :key="c.path"
        class="rc-card"
        :to="c.path"
        :data-test="`rc-card-${c.slug}`"
      >
        <header class="rc-card-header">
          <h2>{{ c.title }}</h2>
          <span class="rc-card-meta">{{ c.meta }}</span>
        </header>
        <p class="rc-card-desc" v-html="c.desc"></p>
        <span class="rc-card-link">查看流水 →</span>
      </router-link>
    </div>
  </div>
</template>

<script setup>
// R158.110 (2026-10-16) — 报表中心总览 (admin-only). 3 卡片 grid (锁定账户
//   密码错误 账户变更), 共享 chartRange 24h/7d/全部 3-button toggle (跟
//   R158.108 EventlogView / R158.109.a FailedLogonView / R158.109.b
//   LockoutAccountsView 1:1 平行).
// R158.111.b (2026-10-16) — 改 3 top 聚合卡片 = 3 流水视图导航目录 (操作员
//   directive "3 个 top 视图在报表中心没有意义, 去掉"). 3 卡片纯 router-link
//   跳 3 流水视图, 0 调任何 top 端点 / 0 fetch. 0 改 .rc-* 既有 style (跟
//   R158.110 ship 1:1 平行). 0 改 3 流水 view, 0 改后端.
//
// R158.X.116.n (2026-10-23) — 3 卡片改数据驱动 + 逐卡 featureFlag gate.
//   为什么卡片也要 gate: sidebar 那 3 个 item 已各自挂了自己的子闸, 但总览
//   页是**另一个入口** —— 不 gate 的话, 关掉「锁定账户」后 sidebar 里它消失
//   了, 总览页那张卡片却还在, 点进去被 beforeEach 弹回首页, 成了「看得见
//   进不去」的死链接。两处入口对同一把开关必须给同一种表现。
//
//   ⚠ desc 用 v-html: 文案里的 <code> 是 R158.111.b 就有的内联标签, 搬进
//   数据数组后无法再用模板插值渲染。数据是**本文件内的字面量常量**, 不是
//   用户输入 / DB / API 返回, 所以不存在 XSS 面 (跟 R158.secfix.2026-10-21
//   那条「动态内容禁用 v-html」不冲突 —— 那条针对的是外部数据)。
import { computed } from 'vue';
import { useFeatureFlagsStore } from '../stores/featureFlags.js';

const featureFlags = useFeatureFlagsStore();

const CARDS = [
  {
    slug: 'lockout-events',
    path: '/report-center/lockout-events',
    flag: 'report_center.lockout.enabled',
    title: '锁定账户',
    meta: 'Security Event 4740',
    desc: '从 <code>ad_lockout_events</code> 拉物理全量锁定流水 — 账户/姓名/工作站/DC/时间, 默认 24h/7d/全部 3 段时间窗 + DC 筛选 + 账户前缀搜 + 100 行分页.'
  },
  {
    slug: 'failed-logon-events',
    path: '/report-center/failed-logon-events',
    flag: 'report_center.failed_logon.enabled',
    title: '密码错误',
    meta: 'Security Event 4625',
    desc: '从 <code>ad_failed_logon_events</code> 拉物理全量密码错误流水 — 账户/姓名/工作站/DC/时间, 跟锁定账户 1:1 平行, 同 3 段时间窗 + DC 筛选 + 前缀搜 + 100 行分页.'
  },
  {
    slug: 'account-change-events',
    path: '/report-center/account-change-events',
    flag: 'report_center.account_change.enabled',
    title: '账户变更',
    meta: '5 类动作 · 30d retention',
    desc: '从 <code>ad_account_change</code> 拉物理全量账户变更流水 — 5 类动作 (创建/修改/删除/启用/禁用) + 操作人, 跟前 2 张 1:1 平行, 30d 自然 cap 跟 <code>ad_mgmt_retention_days</code> 1:1.'
  }
];

const visibleCards = computed(() => CARDS.filter((c) => featureFlags.isEnabled(c.flag)));
</script>

<style scoped>
.rc-overview { padding: 16px; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; }
.title-block h1 { margin: 0 0 4px; font-size: 22px; }
.title-block .subtitle { margin: 0; color: var(--muted); font-size: 12px; }
.title-block code { background: var(--panel); padding: 1px 6px; border-radius: 3px; }
.rc-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.rc-card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; min-height: 200px; text-decoration: none; color: var(--text); transition: border-color 0.15s, transform 0.15s; }
.rc-card:hover { border-color: var(--accent); transform: translateY(-1px); }
.rc-card-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.rc-card-header h2 { margin: 0; font-size: 14px; color: var(--text); }
.rc-card-meta { color: var(--muted); font-size: 11px; }
.rc-card-desc { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 0 0 12px; }
.rc-card-desc code { background: var(--panel-2); padding: 1px 4px; border-radius: 3px; color: var(--text); }
.rc-card-link { margin-top: auto; color: var(--accent); font-size: 12px; }
.rc-card:hover .rc-card-link { text-decoration: underline; }
</style>
