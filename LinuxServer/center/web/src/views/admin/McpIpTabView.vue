<!--
  R158.X.99.28 (2026-10-19) — MCP 集成 3rd tab "IP 白名单" view. 1:1 平行
  McpReadTabView (R158.113.b) + R158.87 FeatureFlagsView (system-settings
  第 1 child) shape: parent 提供 chrome + tab 横向条 + router-view, 本 view
  只装本 tab 的 content (JSON textarea + 启用 toggle + save button +
  当前生效 status 提示). 0 改 McpReadTabView / McpWriteTokenView.

  操作员 directive (2026-10-19) "为MCP 访问添加IP地址限制白名单". 7 决策
  (R158.X.99.28 锁):
    D1: JSON 数组 (IPv4 / IPv6 / CIDR 混合)
    D2: enabled=0 旁路, enabled=1 + 空列表 fail-closed 拒全部
    D3: /mcp/healthz + /mcp-write/healthz public 短路, 0 必 IP
    D4: IP first (403 返 client_ip)
    D5: MCP 集成 3rd tab (本 view)
    D6: 复用 system_config KV (mcp_ip_whitelist + mcp_ip_whitelist_enabled)
    D7: 0 必轮换 mcp_/mcpw_ token (老 token 同等适用 IP 检查)

  1:1 平行 R158.87 FeatureFlagsView "保存" 按钮范式 (dirty 才 enabled),
  R158.113.c access_domain (空字符串放行), R158.AdminEmail admin_email
  (setConfig + sys_config_audit 留痕). 后端 cidr.js parseIpList 0 必前端
  verify IP 格式 (前端只 trim + 数组化).
-->
<template>
  <section class="status-card">
    <h3>MCP 访问 IP 白名单</h3>
    <p class="muted">
      限制只有指定 IP / 网段能访问 <code>/mcp</code> (读取) 与
      <code>/mcp-write</code> (写入) 端点。白名单外的请求返回
      <code>403 ip_not_allowed</code> (含 <code>client_ip</code> 提示)，
      并写入 <code>audit_logs</code> 分类 <code>mcp.auth.fail</code> /
      <code>mcp-write.auth.fail</code>。<code>/mcp/healthz</code> 与
      <code>/mcp-write/healthz</code> 公开短路，0 受白名单约束。
    </p>

    <table class="t">
      <tbody>
        <tr>
          <td class="key-label">白名单启用状态</td>
          <td>
            <label class="switch">
              <input
                type="checkbox"
                v-model="enabledLocal"
                data-test="mcp-ip-enabled"
                :disabled="saving"
              />
              <span>{{ enabledLocal ? '已启用' : '已禁用 (暂不生效)' }}</span>
            </label>
          </td>
        </tr>
        <tr>
          <td class="key-label">当前条目数</td>
          <td>
            <span v-if="enabledLocal && parsedList.length === 0" class="badge err">
              已启用但白名单为空 (fail-closed, 全部拒绝)
            </span>
            <span v-else class="badge mute">{{ parsedList.length }} 条</span>
            <span class="hint">支持 IPv4 / IPv6 / CIDR (例 <code>10.0.0.0/8</code>, <code>::1</code>, <code>192.168.1.5</code>)</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>

  <section class="actions">
    <h3>编辑白名单</h3>
    <p class="muted">
      <strong>一行一条</strong>，每行填 1 个 IP 或网段。支持
      <code>10.1.139.208</code> / <code>10.0.0.0/8</code> / <code>::1</code> /
      <code>2001:db8::/32</code>。空行与多余空格自动忽略，
      <code>#</code> 开头的行视为注释。保存后走
      <code>system_config.mcp_ip_whitelist</code> + 启用 toggle
      <code>system_config.mcp_ip_whitelist_enabled</code>，0 必重启服务
      (middleware 内存 cache invalidate)。
    </p>
    <textarea
      v-model="linesText"
      rows="12"
      class="ip-textarea"
      :placeholder="placeholder"
      data-test="mcp-ip-list-textarea"
      :disabled="saving"
      spellcheck="false"
    />
    <!-- 逐行校验反馈: 后端 cidr.js parseIpList 对非法 entry 是**静默跳过**,
         所以操作员拼错一个字符会以为存上了实际没生效. 前端必须显式指出哪一行
         有问题 (R158.X.99.28.b 同类问题的编辑层前置). -->
    <ul v-if="invalidLines.length" class="ip-warn">
      <li v-for="b in invalidLines" :key="b.line">
        第 {{ b.line }} 行 <code>{{ b.text }}</code> : {{ b.reason }}
      </li>
    </ul>
    <p class="hint">
      共 {{ parsedList.length }} 条有效
      <span v-if="invalidLines.length"> · {{ invalidLines.length }} 行无效 (保存时会被跳过)</span>
      · 草稿编辑中 (尚未保存)：{{ dirty ? '是' : '否' }}
    </p>
    <div class="btn-row">
      <button
        class="btn primary"
        :disabled="!dirty || saving"
        data-test="mcp-ip-save"
        @click="onSave"
      >{{ saving ? '保存中…' : '保存' }}</button>
      <button
        class="btn ghost"
        :disabled="!dirty || saving"
        data-test="mcp-ip-reset"
        @click="onReset"
      >重置</button>
    </div>
    <p v-if="lastError" class="error-banner">{{ lastError }}</p>
    <p v-if="lastSaved" class="copy-msg">已保存 {{ lastSaved }} (共 {{ savedCount }} 条)</p>
  </section>
</template>

<script setup>
// R158.X.99.28 (2026-10-19) — McpIpTabView 业务逻辑. 1:1 平行 McpReadTabView
// loadState / save 范式 (R158.113.b 锁). 0 改 McpReadTabView / McpWriteTokenView.
// 0 装 element-plus (R158.111.b "项目 0 装 element-plus" 锁), 通知走原生
// copy-msg / error-banner 状态栏 (跟 McpReadTabView 1:1 平行).
// API 走 adminApi 命名空间 (line 2 export const adminApi = { ... }), 1:1 平行
// McpReadTabView:170 import { adminApi } 范式.
import { ref, computed, onMounted, watch } from 'vue';
import { adminApi } from '../../api/admin.js';
import { formatTimeOnly } from '../../lib/timezone.js';

const loading = ref(false);
const saving = ref(false);
const lastError = ref('');
const lastSaved = ref('');
const savedCount = ref(0);

const enabledLocal = ref(false);
const linesText = ref('');
const savedLines = ref('');
const savedEnabled = ref(false);

// R158.X.99.28.c (2026-10-22) — 编辑层从 JSON 数组改成**一行一条**.
//   操作员 directive: 「改成列表, 一行代表一个数据, 支持 ip/子网, 针对普通
//   用户设置引号也是不对的」.
//
//   为什么改 (JSON 数组在编辑层是错的抽象):
//     JSON 是**存储格式**, 不是**输入格式**. 让操作员为一条 IP 手写引号和逗号
//     是把存储细节泄漏到编辑层. 实际踩到的坑: 输 `10.1.139.208` (裸 IP, 无引号)
//     → `JSON.parse` 在 position 5 抛 "Expected ',' or ']' after array element"
//     → 整个保存被前端拦下, 请求根本没发出. 而这个报错**只出现在点保存后**,
//     textarea 内 0 提示, 0 实时校验.
//
//   **wire shape 0 改**: 存储仍是 system_config.mcp_ip_whitelist = JSON 数组字符串,
//   请求仍是 PUT { list: [...], enabled }. 只换浏览器端的输入/呈现方式, 后端
//   (system-settings-v2.js:690) + cidr.js 0 动 —— 存储格式归存储, 编辑格式归编辑.
//
//   为什么前端必须校验 (不能全交给后端):
//     cidr.js parseIpList (src/utils/cidr.js:104-121) 对非法 entry 是**静默跳过**
//     (continue), 不报错. 所以一个拼错的行会被后端悄悄丢掉, 操作员看着"保存成功"
//     以为生效了, 实际那条根本没进去. 编辑层必须显式指出哪一行有问题.
const placeholder = [
  '# 一行一条, 支持 IP 或网段. 以 # 开头的行是注释.',
  '10.1.139.208',
  '10.0.0.0/8',
  '::1',
  '2001:db8::/32'
].join('\n');

// 浏览器版 IP 校验 — 自足实现, 0 引新依赖 (前端拿不到 node:net isIP).
// 判定口径 1:1 对齐后端 cidr.js parseIpList:
//   - 无 '/': 合法 IPv4 或 IPv6
//   - 有 '/': IP 合法 + 位数是整数且在 family 上限内 (v4<=32, v6<=128)
function isValidIpv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    if (Number(p) > 255) return false;
  }
  return true;
}

function isValidIpv6(s) {
  if (!s.includes(':')) return false;
  const dcIdx = s.indexOf('::');
  if (dcIdx !== -1 && s.indexOf('::', dcIdx + 1) !== -1) return false; // '::' 只能 1 次
  const halves = s.split(':');
  const groups = [];
  if (dcIdx !== -1) {
    // '::' 至少要代表 1 个全 0 组 ('::' 本身合法 = ::)
    const left = halves.slice(0, dcIdx).filter(g => g !== '');
    const right = halves.slice(dcIdx + 1).filter(g => g !== '');
    if (left.length + right.length > 7) return false;
    groups.push(...left, ...right);
  } else {
    groups.push(...halves);
    if (groups.length !== 8) return false;
  }
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  return true;
}

function isIpValid(s) {
  return isValidIpv4(s) || isValidIpv6(s);
}

// 校验单行 → { ok, reason }. reason 给操作员看, 说清差在哪 (不只说"非法").
function validateEntry(raw) {
  const s = String(raw).trim();
  if (!s) return { ok: false, reason: '空行' };
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return { ok: false, reason: '网段只允许一个 "/"' };
    const [ip, bitsStr] = parts;
    if (!isIpValid(ip)) return { ok: false, reason: '不是合法的 IP 地址' };
    if (!/^\d{1,3}$/.test(bitsStr)) {
      return { ok: false, reason: '子网掩码必须是 0~32 / 0~128 的数字' };
    }
    const bits = Number(bitsStr);
    const max = isValidIpv4(ip) ? 32 : 128;
    if (bits > max) return { ok: false, reason: `子网掩码超出范围 (最大 /${max})` };
    return { ok: true, value: s };
  }
  if (!isIpValid(s)) {
    return { ok: false, reason: '不是合法的 IP 地址 (IPv4 4 段 0~255, IPv6 用 :: 缩写)' };
  }
  return { ok: true, value: s };
}

// 文本 → { valid: [标准化后的条目], invalid: [{line, text, reason}] }.
// 逐行处理: 空行跳过, '#' 开头当注释跳过. 0 必整体 parse 成功 —— 一行错
// 0 影响其他行 (操作员改一行不会丢另外 200 行).
const parsed = computed(() => {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  const lines = linesText.value.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const s = line.trim();
    if (!s) return;                 // 空行忽略
    if (s.startsWith('#')) return;   // 注释行忽略
    const r = validateEntry(s);
    if (!r.ok) {
      invalid.push({ line: idx + 1, text: s, reason: r.reason });
      return;
    }
    if (seen.has(r.value)) return;   // 去重: 同一 IP 写两遍只留一条
    seen.add(r.value);
    valid.push(r.value);
  });
  return { valid, invalid };
});

const parsedList = computed(() => parsed.value.valid);
const invalidLines = computed(() => parsed.value.invalid);

// 后端返的 JSON 数组 → 一行一条文本.
// 1:1 反向 of onSave 的发法 (发的是数组, parseIpList 接受数组见 cidr.js:89).
const fromWireJson = (list) => (Array.isArray(list) ? list.map(String).join('\n') : '');

// R158.X.99.28.b 的 semantic compare 思想保留, 换成行模式的规范化:
// 顺序差异 / 多余空行 / 末尾空行 / 重复行 都被 normalize 掉, 真 dirty 真闭.
// (原实现是 JSON.parse + JSON.stringify; 行模式下等价物是去空白+去重后的数组.)
//
// 0 复用 parsed.value — 必须对**任意文本**做规范化, 因为 savedLines 是后端
// 回的基线, 不在 linesText 里. 抽成纯函数而不是 computed 的读值.
function normalizeLines(text) {
  const valid = [];
  const seen = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const r = validateEntry(s);
    if (!r.ok || seen.has(r.value)) continue;
    seen.add(r.value);
    valid.push(r.value);
  }
  return valid.join('\n');
}

const dirty = computed(() => {
  if (enabledLocal.value !== savedEnabled.value) return true;
  return normalizeLines(linesText.value) !== normalizeLines(savedLines.value);
});

// R158.X.99.28.b (2026-10-19) — 1-click 修 F12.a MEDIUM finding: dirty 改
// semantic compare. R158.X.99.28.c (2026-10-22) 换成行模式: 规范化 = 逐行
// trim + 去注释 + 去重后 join. 顺序差异 / 多余空行 / 末尾空行 / 重复行
// 都被 normalize 掉, 真 dirty 真闭.

async function loadState() {
  loading.value = true;
  lastError.value = '';
  try {
    const res = await adminApi.getMcpIpWhitelist();
    enabledLocal.value = !!res.enabled;
    // 后端返的 list 是已 normalize 的 JSON 数组 → 摊成一行一条.
    linesText.value = fromWireJson(res.list);
    savedLines.value = linesText.value;
    savedEnabled.value = enabledLocal.value;
    savedCount.value = res.count ?? res.list?.length ?? 0;
  } catch (e) {
    lastError.value = '加载失败: ' + (e?.response?.data?.error || e?.message || String(e));
  } finally {
    loading.value = false;
  }
}

async function onSave() {
  // 前端只把**有效行**发上去; 无效行已在 UI 里逐条标出 (invalidLines).
  // 0 必在这里 fail-closed: 后端 parseIpList 对非法 entry 是静默跳过, 若前端
  // 把垃圾一起发过去, 操作员会看到"保存成功"但那些行根本没生效. 有无效行时
  // 直接拦下并提示, 逼操作员先改对 —— 这正是换掉 JSON 编辑层的主要目的之一.
  if (invalidLines.value.length) {
    lastError.value = '有 ' + invalidLines.value.length + ' 行无法识别 (见上方红色提示), 请修正后再保存';
    return;
  }
  saving.value = true;
  lastError.value = '';
  try {
    // wire shape 0 改: 仍发数组 (后端 parseIpList 接受数组, cidr.js:89).
    const res = await adminApi.updateMcpIpWhitelist({
      list: parsedList.value,
      enabled: enabledLocal.value
    });
    // 后端返 { list, enabled, count } — 同步 saved baseline
    enabledLocal.value = !!res.enabled;
    linesText.value = fromWireJson(res.list);
    savedLines.value = linesText.value;
    savedEnabled.value = enabledLocal.value;
    savedCount.value = res.count ?? res.list?.length ?? 0;
    lastSaved.value = formatTimeOnly(new Date().toISOString());
  } catch (e) {
    lastError.value = '保存失败: ' + (e?.response?.data?.error || e?.message || String(e));
  } finally {
    saving.value = false;
  }
}

function onReset() {
  enabledLocal.value = savedEnabled.value;
  linesText.value = savedLines.value;
  lastError.value = '';
}

onMounted(loadState);

// 启 / 禁 toggle 改 → 提醒用户点保存. 1:1 平行 McpReadTabView rotate 时
// 必 commit 范式. UI hint 走 dirty 标记.
watch([enabledLocal, linesText], () => {
  // 仅清 lastSaved/error 提示, 0 必自动 save (操作员 lock).
  if (lastSaved.value) lastSaved.value = '';
});
</script>

<style scoped>
.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.switch input { width: 16px; height: 16px; cursor: pointer; }
code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 0.9em; }
.ip-textarea {
  width: 100%;
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  resize: vertical;
  background: var(--input-bg);
  color: var(--text);
  box-sizing: border-box;
}
/* R158.X.99.28.c — 逐行无效提示. 必须显眼: 这类错误过去只在点保存后
   变成一行红字, textarea 内 0 反馈 (操作员输裸 IP 看不到任何提示). */
.ip-warn {
  margin: 8px 0;
  padding: 8px 12px 8px 28px;
  list-style: disc;
  border-left: 3px solid #d32f2f;
  background: rgba(211, 47, 47, 0.06);
  color: #d32f2f;
  font-size: 0.85em;
  line-height: 1.7;
}
.ip-warn code {
  background: rgba(211, 47, 47, 0.1);
}
</style>
