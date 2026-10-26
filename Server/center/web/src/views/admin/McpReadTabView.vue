<template>
  <!--
    R158.113.b (2026-10-17) — MCP 只读集成子 tab view. 1:1 平行
    R158.87 FeatureFlagsView (system-settings 第 1 children) +
    R158.110 ReportCenterOverviewView (report-center '' child) + R158.111.a
    ReportCenterLockoutEventsView 模式: parent view 提供 chrome + tab
    + router-view, 本 view 只装本 tab 的 content (8 read-only tool 列表
    + 状态卡 + rotate/commit/reveal 操作按钮).

    操作员 directive "mcp 写入集成放进 MCP 集成, 以第二个 tab 实现" — 把原
    R158.102 McpTokenView (整页独立) 拆 1+1: parent (McpTokenView) 提供
    chrome + 2 tab + router-view, McpReadTabView 装原 8 read-only tool
    content (跟 McpWriteTokenView 第 2 tab 1:1 平行).

    0 改任何 8 read-only tool / admin.mcpToken.* wrapper / 4 endpoint
    (跟 R158.113 锁 1:1 平行).
  -->
  <section class="status-card">
    <h3>当前状态</h3>
    <table class="t">
      <tbody>
        <tr>
          <td class="key-label">当前令牌 (mcp_api_token_current)</td>
          <td>
            <span v-if="state.current_set" class="badge ok">已设置</span>
            <span v-else class="badge err">未设置 (需 generate)</span>
          </td>
        </tr>
        <tr>
          <td class="key-label">上一令牌 (mcp_api_token_previous)</td>
          <td>
            <span v-if="state.previous_set" class="badge warn">有效 (轮换过渡期)</span>
            <span v-else class="badge mute">无</span>
          </td>
        </tr>
        <tr>
          <td class="key-label">版本号 (mcp_api_token_version)</td>
          <td><code>v{{ state.version || 0 }}</code></td>
        </tr>
        <tr>
          <td class="key-label">上次轮换时间</td>
          <td>{{ state.rotatedAt ? formatDateTime(state.rotatedAt) : '—' }}</td>
        </tr>
        <tr>
          <td class="key-label">接入端点 (只读)</td>
          <td>
            <div class="endpoint-grid">
              <div class="endpoint-col">
                <div class="endpoint-col-head">域名</div>
                <div class="endpoint-col-body">
                  <code v-if="accessDomain.value">{{ mcpEndpointUrl }}</code>
                  <code v-else class="endpoint-empty">— (未配访问域名)</code>
                  <button
                    v-if="accessDomain.value"
                    class="btn-icon"
                    data-test="mcp-copy-domain"
                    title="复制域名端点"
                    @click="onCopyEndpoint(mcpEndpointUrl, '域名端点')">📋</button>
                </div>
              </div>
              <div class="endpoint-col">
                <div class="endpoint-col-head">IP 地址</div>
                <div class="endpoint-col-body">
                  <code>{{ mcpEndpointIpUrl }}</code>
                  <button
                    class="btn-icon"
                    data-test="mcp-copy-ip"
                    title="复制 IP 端点"
                    @click="onCopyEndpoint(mcpEndpointIpUrl, 'IP 端点')">📋</button>
                </div>
              </div>
            </div>
            <span class="hint">Streamable HTTP · JSON-RPC 2.0</span>
          </td>
        </tr>
        <tr>
          <td class="key-label">健康检查 (无需鉴权)</td>
          <td>
            <code>GET /mcp/healthz</code>
            <span class="hint">返回 ok 状态、工具数量 12、协议 streamable-http</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section class="actions">
    <h3>令牌操作</h3>
    <div class="btn-row">
      <button
        class="btn primary"
        :disabled="generating"
        data-test="mcp-rotate"
        @click="onRotate"
      >
        {{ generating ? '轮换中…' : '🔁 生成新令牌' }}
      </button>
      <button
        class="btn warn"
        :disabled="committing || !state.previous_set"
        data-test="mcp-commit"
        @click="onCommit"
      >
        {{ committing ? '提交中…' : '✅ 提交 (旧令牌立即失效)' }}
      </button>
      <button
        class="btn ghost"
        :disabled="revealing || !state.current_set"
        data-test="mcp-reveal"
        @click="onReveal"
      >
        {{ revealing ? '读取中…' : '👁 复制当前令牌' }}
      </button>
    </div>
    <p v-if="copyMsg" class="copy-msg">{{ copyMsg }}</p>
    <p v-if="lastError" class="error-banner">{{ lastError }}</p>
  </section>

  <div v-if="generatedNewToken" class="modal-backdrop" @click.self="closeModal">
    <div class="modal">
      <h3>新令牌 (v{{ state.version || 0 }})</h3>
      <p class="modal-hint">
        此令牌仅显示 <strong>1 次</strong>。请立即复制到 AI Agent (Claude Desktop / Cursor) 的 MCP 配置中。
        旧令牌在您点击 "提交" 之前仍然有效。
      </p>
      <textarea
        ref="newTokenTextarea"
        class="token-box"
        readonly
        rows="3"
        :value="generatedNewToken"
        @click="$event.target.select()"
      />
      <div class="btn-row">
        <button class="btn primary" data-test="mcp-copy" @click="onCopyNew">📋 复制</button>
        <button class="btn ghost" @click="closeModal">关闭</button>
      </div>
    </div>
  </div>

  <section class="tools-card">
    <h3>暴露的 12 个只读工具</h3>
    <table class="t">
      <thead>
        <tr>
          <th>工具名</th>
          <th>用途 (model 角度)</th>
          <th>1:1 包装</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in TOOLS" :key="t.name">
          <td><code>{{ t.name }}</code></td>
          <td>{{ t.purpose }}</td>
          <td><code class="muted">{{ t.endpoint }}</code></td>
        </tr>
      </tbody>
    </table>
    <p class="hint">
      AI Agent 通过 <code>tools/call</code> JSON-RPC 方法调用, 参数格式校验与网页端一致.
    </p>
  </section>
</template>

<script setup>
// R158.113.b (2026-10-17) — McpReadTabView 1:1 mirror R158.102 McpTokenView 既有
//   content. 0 改 8 tool 列表 / 0 改 4 操作按钮 / 0 改 admin.mcpToken.* wrapper.
//   McpWriteTokenView 写端 1:1 平行 (mcpw_ prefix + 6 write tool).
import { ref, onMounted, nextTick } from 'vue';
import { adminApi } from '../../api/admin.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';
import { formatDateTime } from '../../lib/timezone.js';

const state = ref({
  current_set: false,
  previous_set: false,
  rotatedAt: null,
  version: 0
});
// R158.113.c (2026-10-17) — 访问域名. value 操作员配, fallback 中心端 listen host:port 拼出.
// R158.X.117 (2026-10-26) — 加 ipBase (永远是服务器真实 IP 的完整 base).
const accessDomain = ref({ value: '', fallback: 'http://<center>:<port>', ipBase: '' });
const generating = ref(false);
const committing = ref(false);
const revealing = ref(false);
const generatedNewToken = ref(null);
const newTokenTextarea = ref(null);
const copyMsg = ref('');
const lastError = ref('');

// R158.113.c — 加载 access_domain + fallback, 渲染接入端点. 失败 0 抛, 走 fallback.
async function loadAccessDomain() {
  try {
    const r = await adminApi.getAccessDomain();
    if (r && typeof r === 'object') {
      accessDomain.value = {
        value: r.value || '',
        fallback: r.fallback || accessDomain.value.fallback,
        ipBase: r.ipBase || ''
      };
    }
  } catch (e) {
    // 静默 — 0 阻塞, 端点展示回 fallback
  }
}
// R158.113.d (2026-10-17) — 并列 2 列展示: 域名 + IP. 域名未配 → "— (未配访问域名)".
//   2 列都是 base + /mcp 后缀, base 来源不同 (value vs fallback).
//   0 改后端 / 0 改 wire shape / 0 改 parent McpTokenView (R158.113 + R158.113.c 锁 1:1 平行).
//
// R158.X.117 (2026-10-26) — IP 列改成**永远显示服务器真实 IP** (serverIp),
//   0 再用 fallback (fallback 现在 = 有域名时是域名, 无域名时才是 IP ——
//   配了域名后 2 列会显示一样的东西, 语义上不对, 而且域名没解析到本机时
//   用户复制到的地址连不上). fallback 保留为兜底 (后端字段缺失时).
const mcpEndpointUrl = ref('');        // 域名列: value (访问域名), 空 → "— (未配访问域名)"
const mcpEndpointIpUrl = ref('');      // IP 列: 永远显示服务器真实 IP
function refreshEndpoint() {
  // ipBase = 后端给的"永远是真 IP"的完整 base; 老后端没这字段时回落 fallback.
  const ipBase = accessDomain.value.ipBase || accessDomain.value.fallback;
  mcpEndpointIpUrl.value = `${ipBase}/mcp`;
  mcpEndpointUrl.value = accessDomain.value.value
    ? `${accessDomain.value.value}/mcp`
    : '';
}

const TOOLS = [
  { name: 'get_overview',          purpose: '整体运行状态 (连接状态 / 服务器数量 / 最近更新时间)',                          endpoint: 'GET /api/dashboard/overview' },
  { name: 'get_problem_agents',    purpose: '核心站点中 CPU、内存、磁盘超阈值的服务器列表',                            endpoint: 'GET /api/dashboard/problem-agents' },
  { name: 'query_eventlog',        purpose: 'Windows 事件日志查询 (可按域控、日志通道、级别、时间范围筛选)',              endpoint: 'GET /api/eventlog/events' },
  { name: 'eventlog_trend24h',     purpose: '域控近 24 小时五类日志的事件量趋势',                                        endpoint: 'GET /api/eventlog/trend' },
  { name: 'query_failed_logon',    purpose: '登录失败事件查询 (可指定时间范围与返回条数)',                              endpoint: 'GET /api/failed-logon/recent' },
  { name: 'heartbeat_report',      purpose: '服务器心跳与上报状态 (含全局配置)',                                          endpoint: 'GET /api/admin/heartbeat-report/agents' },
  { name: 'system_alerts_recent',  purpose: '最近的系统告警 (含触发中、已恢复、已确认三种状态)',                        endpoint: 'GET /api/admin/system-alerts/recent' },
  { name: 'member_eventlog_trend24h', purpose: '成员服务器近 24 小时三类事件量趋势',                                  endpoint: 'GET /api/dashboard/member-eventlog/trend' },
  { name: 'query_ad_users',        purpose: 'AD 用户查询 (可按登录名、显示名模糊匹配, 支持 OU 子树与数据新鲜度)',           endpoint: 'GET /api/admin/ad-users' },
  { name: 'query_ad_groups',       purpose: 'AD 组查询 (可按组名、登录名模糊匹配, 支持 OU 子树)',                        endpoint: 'GET /api/admin/ad-groups' },
  { name: 'query_ad_ous',          purpose: 'AD 组织单位列表 (按父级 DN 呈现层级, 不分页)',                            endpoint: 'GET /api/admin/ad-ous' },
  { name: 'query_ad_computers',    purpose: 'AD 计算机查询 (可按登录名、名称模糊匹配, 支持 OU 子树)',                    endpoint: 'GET /api/admin/ad-computers' }
];

async function loadState() {
  try {
    const r = await adminApi.getMcpTokenState();
    state.value = r.data || state.value;
  } catch (e) {
    lastError.value = `加载状态失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  }
}

async function onRotate() {
  if (generating.value) return;
  if (!window.confirm('轮换将立即让当前令牌失效(旧令牌进入轮换过渡期, 直至此页面 "提交")。\n请确认 AI Agent 端能在过渡期内拿到新令牌。\n继续?')) {
    return;
  }
  generating.value = true;
  lastError.value = '';
  try {
    const r = await adminApi.rotateMcpToken();
    const newToken = r.data?.newToken;
    state.value = {
      current_set: true,
      previous_set: true,
      rotatedAt: r.data?.rotatedAt || new Date().toISOString(),
      version: r.data?.version || 0
    };
    if (newToken) {
      generatedNewToken.value = newToken;
      await nextTick();
      newTokenTextarea.value?.focus?.();
    }
    notifySuccess(`已轮换至 v${state.value.version}`);
  } catch (e) {
    lastError.value = `轮换失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  } finally {
    generating.value = false;
  }
}

async function onCommit() {
  if (committing.value) return;
  if (!window.confirm('提交后旧令牌立即失效。\n请确认所有 AI Agent 已配置新令牌。\n继续?')) {
    return;
  }
  committing.value = true;
  lastError.value = '';
  try {
    const r = await adminApi.commitMcpToken();
    if (r.data?.didCommit) {
      state.value = { ...state.value, previous_set: false, rotatedAt: null };
      notifySuccess('已提交, 旧令牌已失效');
    } else {
      notifySuccess('无需提交 (无旧令牌)');
    }
  } catch (e) {
    lastError.value = `提交失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  } finally {
    committing.value = false;
  }
}

async function onReveal() {
  if (revealing.value) return;
  revealing.value = true;
  lastError.value = '';
  try {
    const r = await adminApi.revealMcpToken();
    const tok = r.data?.token;
    const ver = r.data?.version ?? state.value.version;
    if (!tok) throw new Error('服务端未返回令牌');
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(tok);
        copyMsg.value = `已复制 ✓ (v${ver})`;
      } catch {
        copyMsg.value = `已读取令牌 (v${ver}) — 剪贴板不可用, 请手动复制`;
      }
    } else {
      copyMsg.value = `已读取令牌 (v${ver}) — 剪贴板不可用, 请手动复制`;
    }
    setTimeout(() => { copyMsg.value = ''; }, 3000);
  } catch (e) {
    lastError.value = `读取令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  } finally {
    revealing.value = false;
  }
}

async function onCopyNew() {
  const tok = generatedNewToken.value;
  if (!tok) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tok);
    } else {
      newTokenTextarea.value?.select?.();
      document.execCommand?.('copy');
    }
    copyMsg.value = `已复制新令牌 ✓ (v${state.value.version})`;
    setTimeout(() => { copyMsg.value = ''; }, 3000);
  } catch (e) {
    copyMsg.value = '剪贴板不可用, 请手动复制';
  }
}

// R158.113.d (2026-10-17) — 并列 2 列的复制按钮. 跟 onCopyNew 1:1 平行但参数化 (R158.111.a 复制按钮 1:1).
//   0 必新加 copyMsg (复用既有 0 改). 失败时 0 阻塞, 走同一 copyMsg 显示 "剪贴板不可用".
async function onCopyEndpoint(text, label) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      document.execCommand?.('copy');
    }
    copyMsg.value = `已复制${label} ✓`;
    setTimeout(() => { copyMsg.value = ''; }, 3000);
  } catch (e) {
    copyMsg.value = `复制${label}失败, 剪贴板不可用, 请手动复制`;
  }
}

function closeModal() {
  generatedNewToken.value = null;
}

onMounted(async () => {
  await loadAccessDomain();
  refreshEndpoint();
  await loadState();
});
</script>

<style scoped>
/* 0 scoped styles — 跟 McpWriteTokenView 1:1 平行, 全部 CSS 跟 parent
   McpTokenView (parent layout) 共享. parent 提供 chrome + 2 tab, 本
   view 0 必自带 border / padding (跟 R158.87 FeatureFlagsView 1:1
   平行, 跟 R158.110 ReportCenterLockoutEventsView 1:1 平行). */
</style>
