<!--
  R158.114 (2026-10-17) — operator directive "我的意思是 MCP 执行和操作日志
  放在运维日志的下面, 作为第四个子菜单存在". 1:1 平行 R158.46
  AdManagementLogView.vue 范式 (复用 /api/admin/audit?category=mcp 既有端点
  + adminApi.getAudit 既有 wrapper, 0 引新 endpoint, 0 引新 wrapper, 0 引新
  sql helper, 0 引新 perm).

  R158.X (2026-10-20) — operator directive 修正: "MCP 的执行日志和 AD 执行日志
  没有任何关系, 包含访问 API 的数据获取 / 接口调用 / 配置才是 MCP 的功能点,
  所以本身 MCP 和 AD 管理没有关系". 据此:
    - 删除第 2 个 getAudit({category:'ad_management'}) 并发请求
    - 删除顶部「AD 命令执行结果」panel (template + lifecycleRows + CSS 复用)
    - 删除 LIFECYCLE_ACTIONS 常量 (4 个 ad_command_*)
  现在单请求 category='mcp', 页面 = MCP 主体, AD 命令结果去
  /admin/ad-management-log 看 (那边本来就完整覆盖).

  同时补上 R158.X.99.28 遗留的 2 个 auth.fail action (mcp.auth.fail /
  mcp-write.auth.fail): server-side 早已归 'mcp' category 且被拉到, 但
  TAB_ACTIONS 没有对应 bucket, 在 byTab 循环里被静默丢弃. 现给「鉴权失败」
  sub-tab, 3 sub-tab 共 14 entry, 跟 audit-classifier.js ACTION_CATEGORY 的
  'mcp' category 成员数 1:1 对齐.

  0 改 McpTokenView 既有 2 sub-tab (R158.113.b 锁), 0 改 McpReadTabView /
  McpWriteTokenView (R158.113.b 锁), 0 改 ConfigView 既有 (R158.113.e 锁),
  0 改 AdManagementLogView / OperationsLogView 既有 (R158.46 锁).
-->
<template>
  <AdminLayout>
    <header class="head">
      <h2>MCP 执行和操作日志</h2>
      <div class="head-right">
        <!-- R158.60.14 (2026-10-09) — operator "执行完成希望马上看到结果".
             时间范围筛选: 10 分钟 / 1 小时 / 全部, 默认 10 分钟.
             server-side /api/admin/audit?from=ISO 过滤, 不拉无关历史.
             1:1 平行 AdManagementLogView.vue:9-16. -->
        <nav class="time-range-tabs" data-test="time-range-tabs">
          <button v-for="r in timeRanges" :key="r.key"
                  :class="['time-range-tab', { active: timeRange === r.key }]"
                  :data-test="`time-range-${r.key}`"
                  @click="onTimeRange(r.key)">
            {{ r.label }}
          </button>
        </nav>
        <div class="refresh">
          <span class="refresh-dot">
            <span :class="['dot', polling ? 'on' : 'off']"></span>
            <span>每 {{ refreshSeconds }}s 刷新</span>
          </span>
          <select v-model.number="refreshSeconds">
            <option :value="5">5 秒</option>
            <option :value="10">10 秒</option>
            <option :value="30">30 秒</option>
            <option :value="0">关闭</option>
          </select>
        </div>
      </div>
    </header>

    <p class="hint">
      MCP 端点 <code>/mcp</code> 读取调用 + <code>/mcp-write</code> 写入调用 +
      mcp_api_token / mcp_write_token 4 段生命周期 (seed/rotate/commit/reveal) +
      IP 白名单鉴权失败, 共 3 子 tab 拆 14 类操作。AD 命令执行结果不在本页,
      请看「AD 管理日志」。
    </p>
    <!-- R158.X.99.38 (2026-10-22) — 「来源 IP」列新增 + 「工具 / 命令」列新增.
         原表有「用户」列, 但 MCP 调用行的 user_id 恒为 NULL (token 是全局单值,
         0 per-user 映射 —— 详见 script 里 R158.X.99.38 注释), 该列对调用行恒显
         「-」, 留着只会让人以为系统故障. 故移除, 换来对回溯真正有用的 IP 列.
         token 生命周期行 (seed/rotate/reveal) 仍有用户名, 在抽屉里可见. -->
    <p class="hint">
      <strong>关于「谁」</strong>: MCP token 是<strong>全系统共享的一把</strong>,
      不是每个用户一把 —— 所以本日志按<strong>来源 IP</strong>追溯, 而不是用户名。
      token 生命周期操作(签发/轮换/查看)有真实操作者记录, 在详情抽屉里可见。
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <!-- R158.X (2026-10-20) — 顶部「AD 命令执行结果」panel 已删除.
         operator directive: MCP 执行日志 = MCP API 访问 / 工具调用 / 配置,
         跟 AD 管理日志无关. AD 命令生命周期结果请去 /admin/ad-management-log.
         MCP 现在是页面唯一主体, 3 sub-tab: 读取 / 写入 / 鉴权失败. -->

    <!-- R158.114 — 主体 panel: MCP 操作 (14 类) 走 3 sub-tab 客户端切分.
         1:1 平行 AdManagementLogView.vue:69-99 ad-mgmt-block (3 sub-tab
         USER/GROUP/OBJECT 客户端切分), R158.114 简化为:
         读取 (6 mcp.*) / 写入 (6 mcp.write.*) / 鉴权失败 (2 auth.fail).
         Counts 显示当前 timeRange 内 sub-tab 行数 (跟 R158.46 1:1 平行). -->
    <section class="block" data-test="mcp-op-block">
      <h3>MCP 操作 <small>(当前 sub-tab 最近 {{ rows.length }} 条)</small></h3>
      <nav class="mcp-op-tabs">
        <button v-for="t in tabs" :key="t.key"
                :class="['mcp-op-tab', { active: active === t.key }]"
                :data-test="`mcp-op-tab-${t.key}`"
                @click="onTab(t.key)">
          {{ t.icon }} {{ t.label }} <span class="badge">{{ counts[t.key] ?? 0 }}</span>
        </button>
      </nav>
      <table class="t">
        <thead>
          <tr><th>时间</th><th>来源 IP</th><th>动作</th><th>工具 / 命令</th><th>目标</th><th>严重性</th><th>MCP 类别</th></tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="7" class="empty">暂无 {{ activeTabLabel }} 操作记录</td>
          </tr>
          <tr v-for="r in rows" :key="`mcpop-${r.id}`"
              :class="['row', `sev-${r.severity}`]"
              data-test="mcp-op-row"
              @click="openDrawer(r)">
            <td>{{ fmt(r.createdAt) }}</td>
            <td><code v-if="ipOf(r)">{{ ipOf(r) }}</code><span v-else class="muted">-</span></td>
            <td>{{ r.actionLabel }}</td>
            <td>
              <span v-if="toolOf(r)">{{ toolOf(r) }}</span>
              <span v-if="commandOf(r)" class="muted"> · {{ commandOf(r) }}</span>
              <span v-if="!toolOf(r) && !commandOf(r)" class="muted">-</span>
            </td>
            <td>{{ targetOf(r) }}</td>
            <td><span :class="['sev-chip', `sev-chip-${r.severity}`]">{{ sevIcon(r.severity) }} {{ sevLabel(r.severity) }}</span></td>
            <td><span :class="['cat-chip', `cat-chip-${categoryOf(r)}`]">{{ categoryOf(r) }}</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 1:1 平行 AdManagementLogView.vue:101-112 detail drawer + inline PayloadTree.
         R158.114 复用同样的 drawer UX, 让操作员点击 row 看 payload 全文 (mcp_token_reveal
         看 sessionId+method+path+duration_ms, ad_command_queued 看 tool+commandId+dc
         +source+params, 跟 R158.46 1:1 平行 "payload 字段名混杂, 1 row 1 action 1
         payload shape, 1:1 平行 inline PayloadTree JSON render"). -->
    <aside v-if="selected" class="drawer" @click.self="selected = null">
      <div class="drawer-body">
        <header>
          <h3>{{ selected.actionLabel }} <small>#{{ selected.id }}</small></h3>
          <button class="close" @click="selected = null">×</button>
        </header>
        <p><b>{{ selected.username ?? selected.userId ?? '-' }}</b> · {{ fmt(selected.createdAt) }}</p>
        <p v-if="ipOf(selected)">来源 IP: <code>{{ ipOf(selected) }}</code></p>
        <p v-if="toolOf(selected)">工具: <b>{{ toolOf(selected) }}</b><span v-if="commandOf(selected)"> · {{ commandOf(selected) }}</span></p>
        <h4>payload</h4>
        <PayloadTree v-if="selected.payload" :value="selected.payload" />
        <p v-else class="muted">无 payload</p>
      </div>
    </aside>
  </AdminLayout>
</template>

<script setup>
// R158.114 (2026-10-17) — McpOperationLogView. 1:1 平行 R158.46
//   AdManagementLogView.vue 范式 (复用 /api/admin/audit 既闭合端点 +
//   adminApi.getAudit 既有 wrapper). 0 引新 endpoint, 0 引新 sql helper,
//   0 引新 wrapper, 0 引新 perm, 0 引新 sidebar group, 0 改 McpTokenView
//   既有 2 sub-tab (R158.113.b 锁), 0 改 ConfigView (R158.113.e 锁).
//   0 改 AdManagementLogView / OperationsLogView / AuditView 既有.

import { ref, computed, onMounted, onBeforeUnmount, watch, h } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';
import { notifyError } from '../../lib/notify.js';

// R158.114 — 12 mcp.* action (R158.102 6 老 + R158.113 6 新). 1:1 平行
//   listMcpOperations sql helper IN list 23 entry 里的 12 mcp.* 段 (sql.js
//   既闭合, 0 必加 entry). 客户端切 2 sub-tab: 读取 (R158.102 8 tool)
//   / 写入 (R158.113 6 tool).
// 跟 AdManagementLogView.vue:127-141 USER/GROUP/OBJECT 1:1 平行 Object.freeze.
const READ_TOKEN_ACTIONS = Object.freeze([
  'mcp_token_seed', 'mcp_token_rotate', 'mcp_token_commit', 'mcp_token_reveal'
]);
const READ_CALL_ACTIONS = Object.freeze([
  'mcp.request', 'mcp.request.failed'
]);
const WRITE_TOKEN_ACTIONS = Object.freeze([
  'mcp_write_token_seed', 'mcp_write_token_rotate', 'mcp_write_token_commit', 'mcp_write_token_reveal'
]);
const WRITE_CALL_ACTIONS = Object.freeze([
  'mcp.write.request', 'mcp.write.request.failed'
]);
// R158.X (2026-10-20) — operator directive "MCP 的执行日志和 AD 执行日志没有
//   任何关系... 本身 MCP 和 AD 管理没有关系". Removed the 'ad_management'
//   lifecycle panel + its 2nd getAudit({category:'ad_management'}) request.
//   This page now serves ONLY category='mcp' rows.
//
//   AUTH_FAIL_ACTIONS: the 2 IP-whitelist denials added in R158.X.99.28.
//   They were already classified 'mcp' server-side (audit-classifier.js:234-235)
//   and therefore already fetched — but no TAB_ACTIONS bucket claimed them, so
//   they were silently dropped in the byTab loop. Give them a real tab so auth
//   failures stop being invisible.
const AUTH_FAIL_ACTIONS = Object.freeze([
  'mcp.auth.fail', 'mcp-write.auth.fail'
]);
const ALL_ACTIONS = Object.freeze([
  ...READ_TOKEN_ACTIONS, ...READ_CALL_ACTIONS,
  ...WRITE_TOKEN_ACTIONS, ...WRITE_CALL_ACTIONS,
  ...AUTH_FAIL_ACTIONS
]);
// R158.114 — 2 sub-tab 客户端切分 (跟 AdManagementLogView TAB_ACTIONS 1:1 平行).
//   读取 tab: 4 mcp_token_* (R158.102 token lifecycle) + 2 mcp.request*
//   (R158.102 8 read tool 调用 audit). 合计 6 entry.
//   写入 tab: 4 mcp_write_token_* (R158.113 token lifecycle) + 2
//   mcp.write.request* (R158.113 6 write tool 调用 audit). 合计 6 entry.
//   鉴权失败 tab: 2 auth.fail (R158.X.99.28 IP 白名单拒绝). 合计 2 entry.
//   总计 14 entry, 跟 audit-classifier.js ACTION_CATEGORY 的 'mcp' category
//   成员数 1:1 对齐 (2026-10-20 核对: 208-213 / 223-228 / 234-235 = 14).
const TAB_ACTIONS = Object.freeze({
  read:       [...READ_TOKEN_ACTIONS, ...READ_CALL_ACTIONS],
  write:      [...WRITE_TOKEN_ACTIONS, ...WRITE_CALL_ACTIONS],
  authFailed: [...AUTH_FAIL_ACTIONS]
});

const tabs = [
  { key: 'read',       icon: '📖', label: '读取操作' },
  { key: 'write',      icon: '✏️', label: '写入操作' },
  { key: 'authFailed', icon: '🔒', label: '鉴权失败' }
];

const active = ref('read');
const rows = ref([]);
const counts = ref({ read: 0, write: 0, authFailed: 0 });
const activeTabLabel = computed(() => tabs.find(t => t.key === active.value)?.label || '');

// R158.60.14 (2026-10-09) — 时间范围筛选. minutes=null 表示不传 from,
//   让 /api/admin/audit 走全量 (size=100 cap 之内). 默认 10 分钟 —
//   operator "执行完成希望马上看到结果". 1:1 平行 AdManagementLogView.vue:177-181.
const timeRanges = [
  { key: '10m', label: '最近 10 分钟', minutes: 10 },
  { key: '1h',  label: '最近 1 小时',  minutes: 60 },
  { key: 'all', label: '全部',         minutes: null }
];
const timeRange = ref('10m');
function fromIsoForTimeRange() {
  const cfg = timeRanges.find(r => r.key === timeRange.value);
  if (!cfg || cfg.minutes == null) return null;
  return new Date(Date.now() - cfg.minutes * 60 * 1000).toISOString();
}

const refreshSeconds = ref(10);
const polling = ref(false);
const error = ref('');
const selected = ref(null);

const pageSize = 30;
// 服务端 /api/admin/audit size cap 是 100, 我们一次拉满 100 然后 client-side
// 切 2 sub-tab (each tab cap pageSize). 1:1 平行 AdManagementLogView.vue:197.
const fetchSize = 100;
let timer = null;

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function sevIcon(s)  { return s === 'high' ? '🔴' : s === 'medium' ? '🟡' : s === 'info' ? 'ℹ️' : '🔵'; }
function sevLabel(s) { return s === 'high' ? '高' : s === 'medium' ? '中' : s === 'info' ? '信息' : '低'; }
// R158.114 — MCP 类别 chip. 1:1 平行 AdManagementLogView sev-chip 渲染但分 read / write.
//   跟 audit-classifier 'mcp' category 闭合 (R158.113 + R158.114 共 12 entry 都
//   归 'mcp' category, 0 走 'ad_management'). chip color 区分读 / 写两端.
function categoryOf(r) {
  if (r.category === 'mcp') {
    // R158.X.99.28 IP 白名单拒绝 — 2 个 action 名都不以 mcp_write_ / mcp.write.
    //   开头, 不特判的话会掉进 'read' 分支, 被误标成「读取操作」.
    if (r.action === 'mcp.auth.fail' || r.action === 'mcp-write.auth.fail') return 'authFailed';
    if (r.action.startsWith('mcp_write_') || r.action.startsWith('mcp.write.')) return 'write';
    return 'read';
  }
  return r.category || 'ops';
}

// R158.X (2026-10-20) — deleted 4 dead helpers that only the removed
//   「AD 命令执行结果」panel used: isCommandLifecycle / commandResultClass /
//   commandResultLabel / taskIdOf. They referenced LIFECYCLE_ACTIONS, which no
//   longer exists — leaving them would have been a ReferenceError on module
//   eval. AD 命令任务 ID / 结果列 lives in /admin/ad-management-log.
// 「目标」列抽 payload 里更精确的上下文, 跟 AdManagementLogView 1:1 平行.
//   mcp_token_seed/rotate/reveal → payload.length (token 长度) 优先, 否则 target.
//   mcp.request / mcp.write.request → payload.sessionId 优先 (R158.110 SDK 1.x
//   sessionId, 让操作员一眼看出"哪个 AI 客户端调过这条 read 端"), 否则 method.
function targetOf(r) {
  const p = r.payload || {};
  return p.sessionId || p.method || p.sam || p.name || p.targetDc || p.targetDn || p.commandId || r.target || '-';
}

// R158.X.99.38 (2026-10-22) — 操作员需求:
//   「因为每个用户都可以申请自己的 mcp token 能否记录申请谁用MCP服务器做了什么读取操作.
//     但是写入则需要记录IP地址」+「简单的八」→ 接受「谁」追不到, 只把已有的
//     IP / 工具名**显性化出来**.
//
//   为什么「谁」追不到 (调查结论, 非未填字段):
//     mcp_ / mcpw_ token 是**全局单值**, 不是 per-user (me-mcp.js:41-44 注释
//     明写 "SINGLE GLOBAL value, not per-user. 自己的 token was never true").
//     token 是 randomBytes(48) 纯随机, 0 嵌入标识, 0 token→user 映射表.
//     且 /mcp 只挂了 mcpToken 没挂 userAuth (server.js:900), JWT 与 mcp token
//     抢同一个 Authorization 头 → 请求里根本没有用户上下文.
//     所以 userId 硬编码 null 是当前架构下**唯一可能的值**, 不是遗漏.
//     本次**不改 token 签发粒度** (那要新建 token 表 + 迁移存量 AI Agent 配置,
//     超出「简单一点」的范围). 日后要 per-user 再单独立项.
//
//   本次做什么 (0 新端点 / 0 新 SQL helper / 0 改后端):
//     IP 早在 payload 里 (mcp.js:824 / mcp-write.js:394 都调了 _clientIp(req)),
//     工具名也早就在 (mcp-write.js:127 payload.tool). 只是 targetOf() 优先取
//     sessionId 把它们挤掉了, 且 IP 没有任何列承载 —— 都要点开抽屉才看得见.
//     现在把它们提到表格列上, 0 改任何 wire shape.
const TOOL_LABEL = {
  mcp_write_ad_user_password_reset: '重置用户密码',
  mcp_write_ad_user_create:         '新建用户',
  mcp_write_ad_group_create:        '新建组',
  mcp_write_ad_user_unlock:         '解锁用户',
  mcp_write_ad_user_enable_disable: '启用/禁用用户'
};

// 读端工具名 (mcp.read.request 的 payload 0 带 tool 名 —— 读路径 auditMeta 只有
// method/path/sessionId/clientIp/duration_ms, 见 mcp.js:820). 读端只能靠 method
// 区分, 这里如实显示, 0 编造工具名.
function toolOf(r) {
  const p = r.payload || {};
  if (p.tool) return TOOL_LABEL[p.tool] || p.tool;
  return null;
}

// 来源 IP. 读端 auditMeta 用 camelCase clientIp (mcp.js:824); 鉴权失败路径
// (mcp-token.js:160) 用 snake_case client_ip. 两种都认, 避免漏显.
function ipOf(r) {
  const p = r.payload || {};
  return p.clientIp || p.client_ip || null;
}

// 写操作额外的操作对象 (SAM / 组名 / 目标 DC). 用户要「哪些命令」的可见性.
function commandOf(r) {
  const p = r.payload || {};
  if (!p.tool) return null;
  const bits = [];
  if (p.dc) bits.push(p.dc);
  const params = p.params || {};
  if (params.sam) bits.push(params.sam);
  else if (params.name) bits.push(params.name);
  return bits.join(' @ ') || null;
}
// R158.X (2026-10-20) — deleted taskIdOf, last of the 4 AD-only helpers.
//   AD 任务 ID 列 lives in /admin/adManagementLog; MCP rows have no taskId.

async function load() {
  if (polling.value) return;
  polling.value = true;
  try {
    // R158.X (2026-10-20) — operator directive: MCP 日志页只显示 MCP, 不碰 AD.
    //   原 R158.114 并发发第 2 个 getAudit({category:'ad_management'}) 拉 ad_command_*
    //   lifecycle, 渲染成顶部「AD 命令执行结果」面板 —— 那是 AD 管理日志的同一批行.
    //   现在单请求 category='mcp', 14 entry 全归 MCP.
    //   R158.60.14 — server-side from 过滤, 减少不相关行占用 100 cap 配额.
    const from = fromIsoForTimeRange();
    const actionFilter = ALL_ACTIONS.join(',');
    const mcpRes = await adminApi.getAudit({
      category: 'mcp',
      action: actionFilter,
      page: 1,
      size: fetchSize,
      from
    });
    const mcpAll = mcpRes.data?.rows || [];

    // MCP 操作 sub-tab 切分 (14 entry 走 read / write / authFailed).
    const byTab = { read: [], write: [], authFailed: [] };
    for (const r of mcpAll) {
      if (TAB_ACTIONS.read.includes(r.action))            byTab.read.push(r);
      else if (TAB_ACTIONS.write.includes(r.action))      byTab.write.push(r);
      else if (TAB_ACTIONS.authFailed.includes(r.action)) byTab.authFailed.push(r);
    }
    rows.value = (byTab[active.value] || []).slice(0, pageSize);
    counts.value = {
      read:       byTab.read.length,
      write:      byTab.write.length,
      authFailed: byTab.authFailed.length
    };

    error.value = '';
  } catch (e) {
    error.value = e?.message || '加载失败';
    notifyError(`MCP 执行和操作日志加载失败: ${e?.message || '未知错误'}`);
  } finally {
    polling.value = false;
  }
}
function onTab(key) {
  active.value = key;
  load();
}
// R158.60.14 — 切时间范围立刻重新拉, 跟 onTab 一致模式
function onTimeRange(key) {
  if (timeRange.value === key) return;
  timeRange.value = key;
  load();
}
function startTimer() {
  stopTimer();
  if (refreshSeconds.value > 0) timer = setInterval(load, refreshSeconds.value * 1000);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

function openDrawer(r) { selected.value = r; }

// Inline PayloadTree (跟 AdManagementLogView / OperationsLogView / AuditView 同样 UX).
// 1:1 抄 AdManagementLogView.vue:301-319.
const PayloadTree = {
  props: ['value'],
  setup(props) {
    return () => renderNode(props.value, 0);
  }
};
function renderNode(value, depth) {
  if (value == null) return h('span', { class: 'json-null' }, 'null');
  if (typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    return h('ul', { class: 'json-tree', style: `padding-left:${depth * 12}px` },
      entries.map(([k, v]) => h('li', {}, [
        h('span', { class: 'json-key' }, String(k) + ': '),
        renderNode(v, depth + 1)
      ])));
  }
  return h('span', { class: `json-${typeof value}` }, JSON.stringify(value));
}

onMounted(async () => {
  try { await load(); } catch {}
  finally { startTimer(); }
});
onBeforeUnmount(stopTimer);
watch(refreshSeconds, startTimer);
</script>

<style scoped>
/* R158.114 (2026-10-17) — McpOperationLogView scoped CSS. 1:1 抄
   AdManagementLogView.vue:329-420 + 加 1 组 .mcp-op-tabs/.mcp-op-tab
   (跟 .ad-mgmt-tabs 1:1 平行, 名字必带 mcp-op- prefix 跟
   AdManagementLogView 的 ad-mgmt- prefix 区分, R158.77.3 跨 fleet
   命名 1:1 锁), 加 1 组 .cat-chip / .cat-chip-read / .cat-chip-write
   (MCP 类别 chip, 跟 .sev-chip 1:1 平行但分 read / write 端).
   0 改 McpTokenView 既有 CSS (R158.113.b 锁), 0 改全局 CSS. */
.head { display: flex; justify-content: space-between; align-items: center; }
.head-right { display: flex; gap: 16px; align-items: center; }
/* R158.60.14 (2026-10-09) — 时间范围 tab (10m / 1h / all), 跟
   ad-mgmt-tabs 同样 segmented control 风格, active = accent. */
.time-range-tabs { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; background: var(--panel); }
.time-range-tab {
  padding: 4px 10px;
  background: var(--panel);
  color: var(--text);
  border: none;
  border-right: 1px solid var(--border);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.time-range-tab:last-child { border-right: none; }
.time-range-tab:hover { background: var(--border); }
.time-range-tab.active { background: var(--accent, #3b82f6); color: #fff; }
.time-range-tab.active:hover { background: var(--accent, #3b82f6); filter: brightness(1.12); }

.refresh { display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 13px; }
.refresh select { background: var(--sidebar-bg); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; border-radius: 3px; }
.refresh-dot { display: flex; gap: 6px; align-items: center; }
.hint { color: var(--muted); font-size: 12px; margin: 4px 0 16px; }
.hint code { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.error-banner { background: var(--danger-bg); color: var(--severity-critical-text); padding: 10px 14px; margin-bottom: 12px; border-radius: 4px; border: 1px solid var(--status-pill-fg-err); font-size: 13px; }

.block { padding: 16px; border: 1px solid var(--border); border-radius: 4px; background: var(--panel); }
.block h3 { margin: 0 0 12px; font-size: 15px; color: var(--text); }
.block h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; font-weight: 400; }

/* R158.114 — 2 sub-tab strip (读取 / 写入). 1:1 平行 .ad-mgmt-tabs 渲染
   (gap / border-bottom / active 蓝线), 名字带 mcp-op- prefix. */
.mcp-op-tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
.mcp-op-tab {
  background: transparent; color: var(--muted); border: none;
  padding: 8px 14px; font-size: 13px; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.mcp-op-tab:hover { color: var(--text); }
.mcp-op-tab.active { color: var(--text); border-bottom-color: var(--accent); }
.mcp-op-tab .badge {
  margin-left: 6px; padding: 1px 6px; background: var(--sidebar-bg);
  border-radius: 8px; font-size: 11px; color: var(--muted);
}

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--sidebar-bg); color: var(--muted); font-size: 12px; font-weight: 600; }
.row { border-left: 3px solid transparent; }
.row:hover { background: var(--border); }
.row.sev-high   { border-left-color: var(--danger-bg); }
.row.sev-medium { border-left-color: var(--status-pill-fg-warn); }
.row.sev-low    { border-left-color: var(--info-bg); }
.row.sev-info   { border-left-color: var(--sidebar-bg); }

.sev-chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
.sev-chip-high   { background: var(--danger-bg); color: var(--severity-critical-text); }
.sev-chip-medium { background: var(--warning-bg); color: var(--gold-border); }
.sev-chip-low    { background: var(--info-bg); color: var(--severity-info-text); }
.sev-chip-info   { background: var(--sidebar-bg); color: var(--muted); }

/* R158.114 — MCP 类别 chip. 读取 蓝, 写入 橙 (跟 R158.102 / R158.113
   8 read tool / 6 write tool 1:1 平行). 跟 .sev-chip 1:1 平行但独立
   一组避免跟 .sev-chip 颜色撞色. */
.cat-chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; }
.cat-chip-read  { background: var(--info-bg); color: var(--severity-info-text); }
.cat-chip-write { background: var(--warning-bg); color: var(--gold-border); }
.cat-chip-ops   { background: var(--sidebar-bg); color: var(--muted); }
/* R158.X (2026-10-20) — 「鉴权失败」chip. IP 白名单拒绝 (R158.X.99.28),
   用 danger 语义色跟 read/write 区分开. */
.cat-chip-authFailed { background: var(--danger-bg); color: var(--severity-critical-text); }

/* R158.X (2026-10-20) — deleted .cmd-pill{,.ok,.pending,.fail,.timeout,.unknown}
   and .task-id{}. Both were used ONLY by the removed 「AD 命令执行结果」panel
   (AD 命令结果 pill + 任务 ID 列). MCP 主体 panel uses .sev-chip / .cat-chip.
   Kept out rather than left as dead CSS. */

.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.dot.on  { background: var(--green); }
.dot.off { background: var(--muted); }
.empty { text-align: center; color: var(--muted); padding: 18px; }

.drawer { position: fixed; inset: 0 0 0 auto; width: 40%; min-width: 320px; background: var(--panel); border-left: 1px solid var(--border); padding: 20px; overflow: auto; z-index: 10; }
.drawer-body header { display: flex; justify-content: space-between; align-items: center; }
.drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; }
.drawer-body .close { background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; }
.json-tree { list-style: none; padding-left: 12px; }
.json-key { color: var(--accent); }
.json-string { color: var(--severity-ok-text); }
.json-number { color: var(--hub-gold); }
.json-boolean { color: var(--chip-purple-fg); }
.json-null { color: var(--muted); font-style: italic; }
.muted { color: var(--muted); }
</style>
