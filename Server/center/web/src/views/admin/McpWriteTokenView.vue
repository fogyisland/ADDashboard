<template>
  <!--
    R158.113.b (2026-10-17) — MCP 写入集成 child view. 操作员 directive
    "mcp 写入集成放进 MCP 集成, 以第二个 tab 实现" 后, 改 = McpTokenView
    (parent) 的 'write' children. 0 <AdminLayout> wrapper (parent 提供),
    0 <header class="page-head"> (parent 已经有, 跟 R158.87 LicenseView
    1:1 平行, 跟 R158.110 ReportCenterLockoutEventsView 1:1 平行).

    1:1 平行 R158.113 McpReadTabView 既有 content 范式 (只读 12 tool → 写入
    5 tool). R158.X.99.36 (2026-10-22) 摘掉第 6 个 mcp_write_ad_user_delete
    (底层节点已不存在, 该能力永不可用) —— 详见下方 TOOLS 数组上方注释.
    0 改后端其余 5 write tool / 0 改 admin.mcpWriteToken.* wrapper /
    0 改 audit / 0 改 wire shape.
  -->

    <!--
    R158.113 (2026-10-17) — MCP write token 状态卡. 1:1 平行 McpTokenView.vue
    status-card (R158.102 锁). 唯一差异: mcp_ → mcpw_, /mcp → /mcp-write,
    5 tool 替 12 tool (R158.X.99.36 摘掉删除用户后). NEVER 展示 token 明文,
    除非 operator 主动点击 reveal.
  -->
    <section class="status-card">
      <h3>当前状态</h3>
      <table class="t">
        <tbody>
          <tr>
            <td class="key-label">当前写入令牌 (mcp_write_token_current)</td>
            <td>
              <span v-if="state.current_set" class="badge ok">已设置</span>
              <span v-else class="badge err">未设置 (需 generate)</span>
            </td>
          </tr>
          <tr>
            <td class="key-label">上一写入令牌 (mcp_write_token_previous)</td>
            <td>
              <span v-if="state.previous_set" class="badge warn">有效 (轮换过渡期)</span>
              <span v-else class="badge mute">无</span>
            </td>
          </tr>
          <tr>
            <td class="key-label">版本号 (mcp_write_token_version)</td>
            <td><code>v{{ state.version || 0 }}</code></td>
          </tr>
          <tr>
            <td class="key-label">上次轮换时间</td>
            <td>{{ state.rotatedAt ? new Date(state.rotatedAt).toLocaleString() : '—' }}</td>
          </tr>
          <tr>
            <td class="key-label">接入端点 (写端)</td>
            <td>
              <div class="endpoint-grid">
                <div class="endpoint-col">
                  <div class="endpoint-col-head">域名</div>
                  <div class="endpoint-col-body">
                    <code v-if="accessDomain.value">{{ mcpWriteEndpointUrl }}</code>
                    <code v-else class="endpoint-empty">— (未配访问域名)</code>
                    <button
                      v-if="accessDomain.value"
                      class="btn-icon"
                      data-test="mcp-write-copy-domain"
                      title="复制域名端点"
                      @click="onCopyEndpoint(mcpWriteEndpointUrl, '域名端点')">📋</button>
                  </div>
                </div>
                <div class="endpoint-col">
                  <div class="endpoint-col-head">IP 地址</div>
                  <div class="endpoint-col-body">
                    <code>{{ mcpWriteEndpointIpUrl }}</code>
                    <button
                      class="btn-icon"
                      data-test="mcp-write-copy-ip"
                      title="复制 IP 端点"
                      @click="onCopyEndpoint(mcpWriteEndpointIpUrl, 'IP 端点')">📋</button>
                  </div>
                </div>
              </div>
              <span class="hint">Streamable HTTP · JSON-RPC 2.0</span>
            </td>
          </tr>
          <tr>
            <td class="key-label">健康检查 (无需鉴权)</td>
            <td>
              <code>GET /mcp-write/healthz</code>
              <span class="hint">返回 ok 状态、工具数量 6、操作范围为域控写入</span>
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
          data-test="mcp-write-rotate"
          @click="onRotate"
        >
          {{ generating ? '轮换中…' : '🔁 生成新写入令牌' }}
        </button>
        <button
          class="btn warn"
          :disabled="committing || !state.previous_set"
          data-test="mcp-write-commit"
          @click="onCommit"
        >
          {{ committing ? '提交中…' : '✅ 提交 (旧令牌立即失效)' }}
        </button>
        <button
          class="btn ghost"
          :disabled="revealing || !state.current_set"
          data-test="mcp-write-reveal"
          @click="onReveal"
        >
          {{ revealing ? '读取中…' : '👁 复制当前写入令牌' }}
        </button>
      </div>
      <p v-if="copyMsg" class="copy-msg">{{ copyMsg }}</p>
      <p v-if="lastError" class="error-banner">{{ lastError }}</p>
    </section>

    <div v-if="generatedNewToken" class="modal-backdrop" @click.self="closeModal">
      <div class="modal">
        <h3>新写入令牌 (v{{ state.version || 0 }})</h3>
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
          <button class="btn primary" data-test="mcp-write-copy" @click="onCopyNew">📋 复制</button>
          <button class="btn ghost" @click="closeModal">关闭</button>
        </div>
      </div>
    </div>

    <!--
      R158.113 — 6 tool 列表. 1:1 平行 routes/mcp-write.js tool registration.
      6 write tool 跟 3 on-demand 包 1:1 映射 (ad_ad_users_write / ad_ad_groups_write
      / ad_ad_account_quickfix), 0 改 agent binary (R158.69.3 锁).
    -->
    <section class="tools-card">
      <h3>暴露的 6 个写入工具</h3>
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
        AI Agent 通过 <code>tools/call</code> JSON-RPC 方法调用, 参数格式自动校验.
        站点关键字模糊匹配站点名, 未匹配到则默认落到 Hub 核心站点.
        <!-- R158.X.99.36: 原此处有 "confirm=true 强制 (mcp_write_ad_user_delete 防误删)" 说明.
             该 tool 已摘除 (底层节点已不存在, 该能力永不可用), 故一并移除.
             删除类能力保留在 HTTP 端点层, 由 UI 走 UserDeleteConfirmModal 显式确认. -->
      </p>
    </section>
</template>

<script setup>
// R158.113.b (2026-10-17) — McpWriteTokenView 改 = McpTokenView (parent)
//   的 'write' children. 0 AdminLayout import (parent 提供 chrome).
//   跟 McpReadTabView 1:1 平行 (script setup 同结构: ref + onMounted +
//   nextTick + adminApi + notify).
import { ref, onMounted, nextTick } from 'vue';
import { adminApi } from '../../api/admin.js';
import { notifyError, notifySuccess } from '../../lib/notify.js';

const state = ref({
  current_set: false,
  previous_set: false,
  rotatedAt: null,
  version: 0
});
// R158.113.c (2026-10-17) — 访问域名. 跟 McpReadTabView 1:1 平行.
// R158.113.d (2026-10-17) — 并列 2 列: 域名 + IP. 跟 McpReadTabView 1:1 平行.
// R158.X.117 (2026-10-26) — 加 ipBase (永远是服务器真实 IP 的完整 base).
//   跟 McpReadTabView 1:1 平行.
const accessDomain = ref({ value: '', fallback: 'http://<center>:<port>', ipBase: '' });
const mcpWriteEndpointUrl = ref('');     // 域名列
const mcpWriteEndpointIpUrl = ref('');   // IP 列
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
    // 静默 — 0 阻塞
  }
}
function refreshEndpoint() {
  // ipBase = 后端给的"永远是真 IP"的完整 base; 老后端没这字段时回落 fallback.
  const ipBase = accessDomain.value.ipBase || accessDomain.value.fallback;
  mcpWriteEndpointIpUrl.value = `${ipBase}/mcp-write`;
  mcpWriteEndpointUrl.value = accessDomain.value.value
    ? `${accessDomain.value.value}/mcp-write`
    : '';
}
const generating = ref(false);
const committing = ref(false);
const revealing = ref(false);
const generatedNewToken = ref(null);
const newTokenTextarea = ref(null);
const copyMsg = ref('');
const lastError = ref('');

// R158.X.99.36 (2026-10-22) — 摘掉第 6 个 tool mcp_write_ad_user_delete.
//   操作员 directive: 「去掉这个删除，因为系统已经删除了删除操作」+「已经不存在
//   节点，我们也不需要这个危险功能」—— 底层 DC 节点已不存在, 该能力永不可用.
//   1:1 平行后端 mcp-write.js 的 tool_count: 6 → 5. 其余 5 条 0 动.
//   底层 HTTP 端点 / COMMAND_TYPES / validators / agent 端 PS 脚本**全部保留**
//   (摘 tool = 收窄暴露面, 删端点 = 删能力, 两者不是一回事).
const TOOLS = [
  { name: 'mcp_write_ad_user_password_reset',  purpose: '重置 AD 用户密码 (min 12 chars, unlockAccount 可选)',                    endpoint: 'POST /api/admin/ad-commands (commandType=user_password_reset)' },
  { name: 'mcp_write_ad_user_create',          purpose: '新建 AD 用户 (sam + password 必, givenName/surname/displayName/upn/ouPath 可选)', endpoint: 'POST /api/admin/ad-commands (commandType=user_create)' },
  { name: 'mcp_write_ad_group_create',         purpose: '新建 AD 组 (name + category Security/Distribution + scope DomainLocal/Global/Universal 必)', endpoint: 'POST /api/admin/ad-commands (commandType=group_create)' },
  { name: 'mcp_write_ad_user_unlock',          purpose: '解锁 AD 用户 (仅 sam 必)',                                          endpoint: 'POST /api/admin/ad-commands (commandType=user_unlock)' },
  { name: 'mcp_write_ad_user_enable_disable',  purpose: '启用或禁用 AD 用户 (enabled boolean 路由 2 commandType)',              endpoint: 'POST /api/admin/ad-commands (commandType=user_enable | user_disable)' }
];

async function loadState() {
  try {
    const r = await adminApi.getMcpWriteTokenState();
    state.value = r.data || state.value;
  } catch (e) {
    lastError.value = `加载状态失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  }
}

async function onRotate() {
  if (generating.value) return;
  if (!window.confirm('轮换将立即让当前写入令牌失效(旧令牌进入轮换过渡期, 直至此页面 "提交")。\n请确认 AI Agent 端能在过渡期内拿到新令牌。\n继续?')) {
    return;
  }
  generating.value = true;
  lastError.value = '';
  try {
    const r = await adminApi.rotateMcpWriteToken();
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
    notifySuccess(`已轮换写入令牌至 v${state.value.version}`);
  } catch (e) {
    lastError.value = `轮换失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
  } finally {
    generating.value = false;
  }
}

async function onCommit() {
  if (committing.value) return;
  if (!window.confirm('提交后旧写入令牌立即失效。\n请确认所有 AI Agent 已配置新令牌。\n继续?')) {
    return;
  }
  committing.value = true;
  lastError.value = '';
  try {
    const r = await adminApi.commitMcpWriteToken();
    if (r.data?.didCommit) {
      state.value = { ...state.value, previous_set: false, rotatedAt: null };
      notifySuccess('已提交, 旧写入令牌已失效');
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
    const r = await adminApi.revealMcpWriteToken();
    const tok = r.data?.token;
    const ver = r.data?.version ?? state.value.version;
    if (!tok) throw new Error('服务端未返回令牌');
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(tok);
        copyMsg.value = `已复制 ✓ (v${ver})`;
      } catch {
        copyMsg.value = `已读取写入令牌 (v${ver}) — 剪贴板不可用, 请手动复制`;
      }
    } else {
      copyMsg.value = `已读取写入令牌 (v${ver}) — 剪贴板不可用, 请手动复制`;
    }
    setTimeout(() => { copyMsg.value = ''; }, 3000);
  } catch (e) {
    lastError.value = `读取写入令牌失败: ${e?.response?.data?.error || e?.message || '未知错误'}`;
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
    copyMsg.value = `已复制新写入令牌 ✓ (v${state.value.version})`;
    setTimeout(() => { copyMsg.value = ''; }, 3000);
  } catch (e) {
    copyMsg.value = '剪贴板不可用, 请手动复制';
  }
}

// R158.113.d (2026-10-17) — 并列 2 列的复制按钮. 跟 McpReadTabView.onCopyEndpoint 1:1 平行.
//   复用既有 copyMsg (R158.102 + R158.113 锁 0 改). 失败 0 阻塞.
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

<!--
  R158.113.b (2026-10-17) — 0 <style scoped>. McpWriteTokenView 改 = parent
  McpTokenView 的 'write' children, 全部 CSS (status-card / actions /
  tools-card / btn / modal / table) 跟 parent McpTokenView 共享 (parent
  <style> 全局样式 .tab-content .xxx). 1:1 平行 R158.87 LicenseView
  (system-settings 第 2 children, 0 自带 style) + R158.111.a
  ReportCenterLockoutEventsView 0 自带 style. 0 视觉跟老 McpWriteTokenView
  独立 page 1:1 平行, 0 改颜色 / 0 改 padding / 0 改 border-radius.
-->
