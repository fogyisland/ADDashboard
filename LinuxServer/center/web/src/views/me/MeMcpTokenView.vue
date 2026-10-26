<!-- R158.104.2 (2026-10-14) — /me/mcp-token 独立全屏 page.
     1:1 平行 R158.104 UserWidget:96-148 view=mcp section +
     onMcpRotate (line 290) + onMcpReveal (line 302) + onCopyNewToken
     (line 320) + mcpState (line 205-209) + plaintext modal (line 131-147).
     0 commit button (R158.104 lesson #1 跨 user 影响隔离保留
     admin-only, me 端 0 commit). 跟 admin McpTokenView precedent
     1:1 平行 (state table + rotate/reveal + modal).

     R158.104.2.2 (2026-10-14) — 加 3 块 (1:1 抄 admin McpTokenView
     line 46-58 接入端点 + line 130-151 8 tool 列表) + AI Agent
     连接 setup 步骤说明 (Claude Desktop / Cursor JSON 配置示例).
     端点 URL 走 window.location.origin + '/mcp' runtime 拿, 0
     hard-coded. 8 tool 列表 1:1 平行 admin McpTokenView TOOLS
     (line 175-184), 0 重复造. -->
<template>
  <div class="me-view">
    <h4 class="me-view-title">🗝 MCP Token 申请</h4>
    <div v-if="mcpState.loading" class="muted">加载中…</div>
    <template v-else-if="mcpState.data">
      <table class="kv">
        <tbody>
          <tr><td>当前令牌</td>
            <td>
              <span v-if="mcpState.data.current_set" class="badge ok">已设置</span>
              <span v-else class="badge err">未设置</span>
            </td>
          </tr>
          <tr><td>旧令牌</td>
            <td>
              <span v-if="mcpState.data.previous_set" class="badge warn">有效 (overlap)</span>
              <span v-else class="badge mute">无</span>
            </td>
          </tr>
          <tr><td>版本</td><td><code>v{{ mcpState.data.version || 0 }}</code></td></tr>
        </tbody>
      </table>
      <div class="btn-row">
        <button class="btn primary" :disabled="mcpState.busyRotate" @click="onMcpRotate">🔁 轮换</button>
        <button class="btn ghost" :disabled="mcpState.busyReveal || !mcpState.data.current_set" @click="onMcpReveal">👁 读取</button>
      </div>
      <p v-if="mcpState.copyMsg" class="copy-msg">{{ mcpState.copyMsg }}</p>
      <p v-if="mcpState.error" class="err">{{ mcpState.error }}</p>
    </template>
    <p v-else class="err">{{ mcpState.error }}</p>

    <!-- R158.104.2.2 (2026-10-14) — 接入端点 (1:1 平行 admin
         McpTokenView line 46-58) + 健康检查 (no-auth). 端点 URL 走
         window.location.origin runtime 拿, 让本地 / 测试 / 生产环境
         自动适配. 0 hard-coded host:port. -->
    <section class="endpoint-card">
      <h5>接入端点</h5>
      <table class="kv">
        <tbody>
          <tr>
            <td>MCP 端点 (Streamable HTTP)</td>
            <td>
              <code data-test="mcp-endpoint">{{ mcpEndpoint }}</code>
              <button class="btn-mini" @click="copyText(mcpEndpoint, 'mcp-endpoint-copied')">📋 复制</button>
              <span v-if="copiedKey === 'mcp-endpoint-copied'" class="copy-mini-msg">已复制 ✓</span>
            </td>
          </tr>
          <tr>
            <td>健康检查 (no-auth)</td>
            <td>
              <code>{{ mcpHealthz }}</code>
              <span class="hint">返 { ok, tool_count: 12, protocol: 'streamable-http' }</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- R158.104.2.2 — AI Agent 连接 setup 步骤 (Claude Desktop /
         Cursor 1:1 平行 admin McpTokenView 8 tool 列表 R158.102
         ship 闭合). 用户复制 JSON 配置到 AI Agent config 即可连. -->
    <section class="setup-card">
      <h5>连接 AI Agent (Claude Desktop / Cursor)</h5>
      <ol class="setup-steps">
        <li>
          <strong>读取 / 轮换</strong> 上方 "👁 读取" 拿到当前 token (格式 <code>mcp_&lt;96 hex&gt;</code>)。
        </li>
        <li>
          <strong>复制 JSON 配置</strong> 把下面整段贴到 AI Agent 的 MCP 配置文件:
          <ul>
            <li>Claude Desktop: <code>%APPDATA%\Claude\claude_desktop_config.json</code> (Windows) / <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS)</li>
            <li>Cursor: <code>~/.cursor/mcp.json</code></li>
          </ul>
        </li>
        <li>
          <strong>替换占位符</strong>:
          <ul>
            <li><code>&lt;YOUR_MCP_TOKEN&gt;</code> → 粘贴你刚读到的 token</li>
          </ul>
        </li>
        <li>
          <strong>重启 AI Agent</strong> 让它加载新 MCP server。
        </li>
      </ol>
      <pre class="config-json" data-test="mcp-config-template">{{ configTemplate }}</pre>
      <div class="btn-row">
        <button class="btn ghost" @click="copyText(configTemplate, 'mcp-config-copied')">📋 复制完整 JSON</button>
        <span v-if="copiedKey === 'mcp-config-copied'" class="copy-mini-msg">已复制 ✓</span>
      </div>
    </section>

    <!-- R158.104.2.2 — 只读 tool 列表 (1:1 抄 admin McpTokenView
         line 130-151 + TOOLS line 175-184). 0 重复造, 跟 R158.102
         ship 闭合的 tool registration 1:1 平行. -->
    <section class="tools-card">
      <h5>暴露的 12 个只读工具</h5>
      <table class="t">
        <thead>
          <tr>
            <th>工具名</th>
            <th>用途</th>
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
        AI Agent 通过 <code>tools/call</code> JSON-RPC 方法调用, 参数 schema 走 Zod 验证。
      </p>
    </section>

    <!-- R158.104.2 — Plaintext modal 1:1 平行 UserWidget:131-147 +
         admin McpTokenView precedent. 仅 memory, 关闭即清空, 永远不写
         localStorage. -->
    <div v-if="mcpState.newToken" class="modal-backdrop" @click.self="mcpState.newToken = null">
      <div class="modal">
        <h3>新令牌 (v{{ mcpState.data?.version || 0 }})</h3>
        <p class="hint">此令牌仅显示 <strong>1 次</strong>。请立即复制到 AI Agent (Claude Desktop / Cursor) 的 MCP 配置中。旧令牌在管理员提交之前仍有效。</p>
        <textarea
          class="token-box"
          readonly
          rows="3"
          :value="mcpState.newToken"
          @click="$event.target.select()"
        />
        <div class="btn-row">
          <button class="btn primary" @click="onCopyNewToken">📋 复制</button>
          <button class="btn ghost" @click="mcpState.newToken = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// R158.104.2 — 1:1 平行 UserWidget mcpState + handler. 复用
//   meApi.rotateMcpToken / revealMcpToken (api/me.js, R158.104
//   ship 闭合, 0 改).
//
// R158.104.2.2 — 加 mcpEndpoint (window.location.origin + /mcp,
//   runtime 拿, 0 hard-coded host:port) + configTemplate (AI Agent
//   JSON config, 8 tool 列表 1:1 抄 admin McpTokenView TOOLS).
import { onMounted, reactive, ref, computed } from 'vue';
import { meApi } from '../../api/me.js';
import { notifySuccess } from '../../lib/notify.js';

const mcpState = reactive({
  loading: false,
  data: null,
  error: '',
  busyRotate: false,
  busyReveal: false,
  copyMsg: '',
  newToken: null
});

// R158.104.2.2 — 端点 URL runtime 拿. 0 hard-coded 避免本地 / 测试 /
//   生产环境需要手动改. /mcp 是 R158.102 ship 闭合的 Streamable HTTP
//   端点 (server.js:792-803 mount).
//
// R158.X.117 (2026-10-26) — 端点地址改由**后端**给 (GET /api/me/mcp-endpoint).
//   旧实现用 `window.location.origin` —— 操作员如果是通过
//   `http://localhost:8080` 打开 center 的, 界面上所有路径都是
//   `http://localhost:8080/mcp`, 贴到**另一台机器**的 Claude Desktop /
//   Cursor 上必然连不上 (localhost 解析成客户端自己, 不是 center).
//   ⇒ 这段 config 模板要给的是**服务器地址**, 不是浏览器地址栏.
//   后端取: 访问域名 (system_config.access_domain, 本机地址视为未配)
//            否则服务器真实 IP (getPrimaryIPv4).
//   端点 0 可用 (DB 异常等) 时回落 window.location.origin —— 界面 0 空.
const mcpEndpointInfo = ref({ endpoint: '', healthz: '', serverIp: '', domain: '' });
const mcpEndpoint = computed(() => {
  if (mcpEndpointInfo.value.endpoint) return mcpEndpointInfo.value.endpoint;
  if (typeof window === 'undefined') return '/mcp';
  return `${window.location.origin}/mcp`;
});
const mcpHealthz = computed(() => {
  if (mcpEndpointInfo.value.healthz) return mcpEndpointInfo.value.healthz;
  return `${mcpEndpoint.value}/healthz`;
});

// R158.104.2.2 — Claude Desktop / Cursor MCP config JSON 模板.
//   用户复制后只需替换 <YOUR_MCP_TOKEN> 占位符. 1:1 平行 Anthropic
//   官方 MCP Streamable HTTP config 格式. Streamable HTTP transport
//   + Authorization header (跟 mcpToken middleware auth 1:1 对齐).
const configTemplate = computed(() => `{
  "mcpServers": {
    "dashboard": {
      "type": "http",
      "url": "${mcpEndpoint.value}",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_TOKEN>"
      }
    }
  }
}`);

// R158.104.2.2 — 1:1 抄 admin McpTokenView TOOLS (line 175-184).
//   12 tool 跟 routes/mcp.js tool registration (R158.102 的 8 个 + AD 目录 4 个)
//   1:1 对齐. 0 重复造, 0 创新.
const TOOLS = [
  { name: 'get_overview',             purpose: '整体运行状态 (连接状态 / 服务器数量 / 最近更新时间)',                        endpoint: 'GET /api/dashboard/overview' },
  { name: 'get_problem_agents',       purpose: '核心站点中 CPU、内存、磁盘超阈值的服务器列表',                              endpoint: 'GET /api/dashboard/problem-agents' },
  { name: 'query_eventlog',           purpose: 'Windows 事件日志查询 (可按域控、日志通道、级别、时间范围筛选)',                endpoint: 'GET /api/eventlog/events' },
  { name: 'eventlog_trend24h',        purpose: '域控近 24 小时五类日志的事件量趋势',                                          endpoint: 'GET /api/eventlog/trend' },
  { name: 'query_failed_logon',       purpose: '登录失败事件查询 (可指定时间范围与返回条数)',                                endpoint: 'GET /api/failed-logon/recent' },
  { name: 'heartbeat_report',         purpose: '服务器心跳与上报状态 (含全局配置)',                                            endpoint: 'GET /api/admin/heartbeat-report/agents' },
  { name: 'system_alerts_recent',     purpose: '最近的系统告警 (含触发中、已恢复、已确认三种状态)',                          endpoint: 'GET /api/admin/system-alerts/recent' },
  { name: 'member_eventlog_trend24h', purpose: '成员服务器近 24 小时三类事件量趋势',                                  endpoint: 'GET /api/dashboard/member-eventlog/trend' },
  { name: 'query_ad_users',           purpose: 'AD 用户查询 (可按登录名、显示名模糊匹配, 支持 OU 子树与数据新鲜度)',           endpoint: 'GET /api/admin/ad-users' },
  { name: 'query_ad_groups',          purpose: 'AD 组查询 (可按组名、登录名模糊匹配, 支持 OU 子树)',                            endpoint: 'GET /api/admin/ad-groups' },
  { name: 'query_ad_ous',             purpose: 'AD 组织单位列表 (按父级 DN 呈现层级, 不分页)',                                endpoint: 'GET /api/admin/ad-ous' },
  { name: 'query_ad_computers',       purpose: 'AD 计算机查询 (可按登录名、名称模糊匹配, 支持 OU 子树)',                        endpoint: 'GET /api/admin/ad-computers' }
];

// R158.104.2.2 — 复制提示反馈. copiedKey 单一变量, 复制端点或
// JSON 时显示 "已复制 ✓" 3s 后自动清空. 0 走全局 notify.
const copiedKey = ref('');
function copyText(text, key) {
  copiedKey.value = key;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      setTimeout(() => { if (copiedKey.value === key) copiedKey.value = ''; }, 3000);
    }).catch(() => {
      // 剪贴板不可用, 用户可手动复制 pre/code 内容
    });
  }
}

async function loadMcpState() {
  mcpState.loading = true;
  mcpState.error = '';
  mcpState.data = null;
  try {
    const r = await meApi.getMcpTokenState();
    mcpState.data = r.data;
  } catch (e) {
    mcpState.error = e?.response?.data?.error || e?.message || '加载失败';
  } finally {
    mcpState.loading = false;
  }
}

async function onMcpRotate() {
  mcpState.error = '';
  mcpState.busyRotate = true;
  try {
    const r = await meApi.rotateMcpToken();
    mcpState.newToken = r.data?.newToken;
    notifySuccess(`已轮换至 v${r.data?.version || 0}`);
    await loadMcpState();
  } catch (e) {
    mcpState.error = e?.response?.data?.error || e?.message || '轮换失败';
  } finally {
    mcpState.busyRotate = false;
  }
}

async function onMcpReveal() {
  mcpState.error = '';
  mcpState.busyReveal = true;
  mcpState.copyMsg = '';
  try {
    const r = await meApi.revealMcpToken();
    const tok = r.data?.token;
    if (!tok) throw new Error('服务端未返回令牌');
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(tok);
        mcpState.copyMsg = '已复制 ✓';
      } catch {
        mcpState.copyMsg = '已读取 — 剪贴板不可用, 请手动复制';
      }
    } else {
      mcpState.copyMsg = '已读取 — 剪贴板不可用, 请手动复制';
    }
    setTimeout(() => { mcpState.copyMsg = ''; }, 3000);
  } catch (e) {
    mcpState.error = e?.response?.data?.error || e?.message || '读取失败';
  } finally {
    mcpState.busyReveal = false;
  }
}

async function onCopyNewToken() {
  const tok = mcpState.newToken;
  if (!tok) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(tok);
    else { /* user can still see the textarea */ }
    mcpState.copyMsg = '已复制新令牌 ✓';
    setTimeout(() => { mcpState.copyMsg = ''; }, 3000);
  } catch {
    mcpState.copyMsg = '剪贴板不可用, 请手动复制';
  }
}

onMounted(loadMcpState);

// R158.X.117 (2026-10-26) — 加载服务器端点地址 (跨机可访问).
//   失败 0 阻塞 —— mcpEndpoint 回落 window.location.origin.
onMounted(async () => {
  try {
    const r = await meApi.getMcpEndpoint();
    const d = r?.data;
    if (d && typeof d === 'object') {
      mcpEndpointInfo.value = {
        endpoint: d.endpoint || '',
        healthz: d.healthz || '',
        serverIp: d.serverIp || '',
        domain: d.domain || ''
      };
    }
  } catch {
    // 静默 — 回落 window.location.origin
  }
});
</script>

<style scoped>
/* R158.104.2.2 — 在 R158.104.2 ship 闭合 CSS 基础上加 endpoint-card
   / setup-card / tools-card / t / btn-mini / copy-mini-msg CSS,
   1:1 平行 admin McpTokenView .status-card / .tools-card /
   .key-label / .t / .hint / .muted / .modal (R158.102 ship 闭合).

   R158.104.2.3 (2026-10-14) — operator directive "界面为宽幅": 0
   限 max-width, 让 .me-view 全宽铺满 content area. 整个 dashboard
   operator 工作面板都走宽幅 (OsBaselineView grid / EventlogView
   matrix 都不限 max-width), 0 走 R53 的 "max-width 720/820"
   narrow surface 形态. 8 tool 表格 + JSON config 模板在宽屏
   一次性展示全, 0 必 horizontal scroll. */
.me-view {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px 18px;
  width: 100%;
}
.me-view-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--accent);
  font-weight: 600;
}
.muted { color: var(--muted); font-size: 12px; }
.err { color: var(--red); font-size: 12px; margin: 6px 0; }
.copy-msg { color: #16a34a; font-size: 11px; margin: 6px 0 0; }
.kv { width: 100%; border-collapse: collapse; font-size: 13px; }
.kv td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.kv td:first-child { color: var(--muted); width: 200px; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 500; }
.badge.ok { background: rgba(16,185,129,0.15); color: #10b981; }
.badge.warn { background: rgba(245,158,11,0.15); color: #f59e0b; }
.badge.err { background: rgba(239,68,68,0.15); color: #ef4444; }
.badge.mute { background: var(--border); color: var(--muted); }
.btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.btn { padding: 5px 12px; border-radius: 3px; border: 1px solid var(--border); background: var(--input-bg); color: var(--text); cursor: pointer; font-size: 13px; }
.btn:hover:not(:disabled) { filter: brightness(1.1); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
.btn.ghost { background: var(--input-bg); }
.btn-mini {
  margin-left: 6px; padding: 1px 8px; font-size: 11px;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text); cursor: pointer;
}
.btn-mini:hover { filter: brightness(1.1); }
.copy-mini-msg { color: #16a34a; font-size: 11px; margin-left: 6px; }
.hint { color: var(--muted); font-size: 11px; margin: 6px 0 0; }

/* R158.104.2.2 — endpoint / setup / tools 3 段 card, 跟 admin
   McpTokenView .status-card / .tools-card 1:1 平行. */
.endpoint-card, .setup-card, .tools-card {
  margin-top: 18px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--panel-alt) 50%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.endpoint-card h5, .setup-card h5, .tools-card h5 {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--accent);
  font-weight: 600;
}

/* R158.104.2.2 — setup 步骤 ol/ul/pre 样式, 让步骤清晰可读. */
.setup-steps {
  margin: 0 0 12px;
  padding-left: 20px;
  font-size: 13px;
  color: var(--text);
  line-height: 1.6;
}
.setup-steps li { margin-bottom: 6px; }
.setup-steps ul { margin-top: 4px; padding-left: 18px; }
.setup-steps code {
  background: var(--input-bg);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}
.config-json {
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
  margin: 0 0 8px;
}

/* R158.104.2.2 — 8 tool 列表 table, 跟 admin McpTokenView .t 1:1 平行. */
.t { width: 100%; border-collapse: collapse; font-size: 12px; }
.t th, .t td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.t th { background: var(--input-bg); font-weight: 600; color: var(--muted); }
.t code { font-size: 11px; }
.t .muted { color: var(--muted); }

/* R158.104.2 — modal 1:1 平行 UserWidget:442-445 */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 18px; max-width: 480px; width: 90%; color: var(--text); }
.modal h3 { margin: 0 0 6px; font-size: 14px; color: var(--accent); }
.token-box { width: 100%; font-family: ui-monospace, monospace; font-size: 11px; padding: 6px; border: 1px solid var(--border); border-radius: 3px; background: var(--input-bg); color: var(--text); resize: vertical; word-break: break-all; margin: 6px 0; }
code { background: var(--input-bg); padding: 1px 6px; border-radius: 3px; font-size: 12px; }
</style>
