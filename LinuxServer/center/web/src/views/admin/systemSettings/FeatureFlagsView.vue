<!--
  R158.87 (2026-10-12) — FeatureFlagsView (功能开关 child).
  7 default flag 列表 + enable/disable 开关 (PUT feature-flags).
  30s polling reload (R158.68 SystemAlertsView 1:1 pattern, 但不依赖 subTab).
  fail-closed 行为: API 失败 → 保持上次的 state, 不更新 → isEnabled 默认 false.
-->
<template>
  <div class="ff-view">
    <div class="ff-toolbar">
      <button @click="reload" :disabled="loading" class="ff-refresh-btn">
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
      <span class="ff-meta">共 {{ rows.length }} 个 flag · 最后刷新: {{ lastReloadLabel }}</span>
    </div>

    <table class="ff-table" data-test="ff-table">
      <thead>
        <tr>
          <th class="ff-col-desc">功能</th>
          <th class="ff-col-key">Key</th>
          <th class="ff-col-value">当前值</th>
          <th class="ff-col-toggle">开关</th>
          <th class="ff-col-updated">更新时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :data-test="`ff-row-${row.key}`">
          <td class="ff-col-desc">{{ row.description || '-' }}</td>
          <td class="ff-col-key"><code>{{ row.key }}</code></td>
          <td class="ff-col-value">
            <span :class="['ff-badge', isEnabled(row.key) ? 'on' : 'off']">
              {{ isEnabled(row.key) ? '启用' : '禁用' }}
            </span>
          </td>
          <td class="ff-col-toggle">
            <button
              @click="toggle(row)"
              :disabled="saving === row.key"
              :class="['ff-switch', isEnabled(row.key) ? 'on' : 'off']"
              :aria-checked="isEnabled(row.key)"
              role="switch"
              :data-test="`ff-switch-${row.key}`"
            >
              <span class="ff-switch-knob"></span>
            </button>
          </td>
          <td class="ff-col-updated">{{ formatUpdated(row.updated_at) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { adminApi } from '../../../api/admin.js';
import { useFeatureFlagsStore } from '../../../stores/featureFlags.js';
// R161.6 — 判定走公共实现 (web/src/lib/featureFlag.js), 与后端口径一致。
import { isFlagValueEnabled } from '../../../lib/featureFlag.js';

const rows = ref([]);
const loading = ref(false);
const saving = ref(null);  // 当前保存中的 key
const lastReloadAt = ref(0);
const ffStore = useFeatureFlagsStore();

const lastReloadLabel = computed(() => {
  if (!lastReloadAt.value) return '从未';
  const ago = Math.floor((Date.now() - lastReloadAt.value) / 1000);
  if (ago < 60) return `${ago}s 前`;
  return `${Math.floor(ago / 60)}m 前`;
});

// R161.6 — 语义: 缺 key ⇒ 未配置 ⇒ 放行 (true); '1'/1/true ⇒ 放行;
//   其它值 ('0'/0/false/脏值) ⇒ 拦截。旧实现是 fail-closed (缺 key ⇒ false),
//   与后端 readFeatureFlag 的"缺行 ⇒ 放行"相反。
function isEnabled(key) {
  return isFlagValueEnabled(ffStore.flags[key]);
}

// R158.X.116.g (2026-10-23) — 这两个 key **不是**布尔开关, 是 agent 升级
//   发布闸门 (rollout strategy + canary 比例), 从本表隐藏。
//   隐藏原因 (2 条, 都是实际踩到的坑):
//     1. 语义错配: 本表 isEnabled() 只认 '1'/1/true, 而它们的值是
//        'full' / '100' —— 两者都不是 '1', 于是永远显示"禁用"。
//        而 full + 100 恰恰是**最宽松**的组合 (全量放行升级),
//        界面在说反话, operator 会据此做出错误判断。
//     2. 写路径危险: 本表 Toggle 只能写 '0'/'1', 而 strategy 的合法值
//        是 full|canary|paused。写 '0' 会 fallthrough 回 'full',
//        看似"禁用"实则**完全没生效**, 还把配置写脏了。
//   正确操作入口是 rollout 专有端点 (POST /api/admin/rollout +
//   /pause + /resume), 见 src/routes/rollout.js。
//   ⚠ 只过滤**显示**, 不过滤 store: ffStore.flags 必须保留全部 key,
//     否则 sidebar gate (useFeatureFlagsStore) 会读到缺 key 的 map。
//
// R158.X.116.j (2026-10-23) — 追加隐藏 5 个已废弃的 sidebar gate key。
//   operator directive: 域和森林 / 复制矩阵 / 包管理 / 成员服务器 这些
//   功能"不需要开关" —— 它们是系统的结构性组成, 不是可插拔特性。
//   对应改动: AppLayout.vue 的 5 处 nav-group v-if 已删掉 flag 判断,
//   入口常显 (v-if="isAd" / "!isAd" 的 AD/NoAD 互斥**原样保留**)。
//   其中 member_eventlog.enabled / member_os_baseline.enabled 本来就
//   没有任何代码消费 (grep 全仓无命中), 这次一并清掉显示。
//   DB 行**保留不删**: 存量库里它们还在, 删行不改变任何行为, 只丢审计痕迹;
//   且若将来重新引入 gate, 行还在就不用再 seed。
//   本表因此只剩 ad_management.enabled 一行真实可开关项。
const HIDDEN_KEYS = new Set([
  'agent_upgrade_rollout_strategy',
  'agent_upgrade_canary_ratio',
  'forest_registry.enabled',
  'replication_matrix.enabled',
  'packages.enabled',
  'member_server.enabled',
  'member_eventlog.enabled',
  'member_os_baseline.enabled'
]);

async function reload() {
  loading.value = true;
  try {
    const r = await adminApi.getFeatureFlags();
    const items = r.items || [];
    rows.value = items.filter((it) => !HIDDEN_KEYS.has(it.key));
    lastReloadAt.value = Date.now();
    // 同步 store (让 sidebar gate 看到 latest) —— 用**未过滤**的 items
    const map = {};
    for (const item of items) map[item.key] = item.value;
    ffStore.flags = map;
    ffStore.loadedAt = Date.now();
  } catch (e) {
    // keep last state
  } finally {
    loading.value = false;
  }
}

async function toggle(row) {
  const currentlyOn = isEnabled(row.key);
  const newValue = currentlyOn ? '0' : '1';
  const name = row.description || row.key;
  // R158.X.116.f (2026-10-22) — 开与关**都要**确认. 功能开关直接改变
  //   后端行为 (sidebar gate / API gate), 误点代价高于一次点击成本,
  //   所以不做"只有开启才确认"的非对称处理。
  const verb = currentlyOn ? '关闭' : '开启';
  const tail = currentlyOn
    ? '关闭后, 依赖该开关的功能会立即从界面消失。'
    : '开启后, 对应功能会立即出现, 可能影响现有页面布局。';
  if (!confirm(`${verb}功能「${name}」?\n\nkey: ${row.key}\n${tail}`)) return;

  saving.value = row.key;
  try {
    await adminApi.updateFeatureFlags({ [row.key]: newValue });
    // 重新拉一次拿 updated_at / updated_by
    await reload();
  } catch (e) {
    alert(`保存失败: ${e?.response?.data?.error || e.message}`);
  } finally {
    saving.value = null;
  }
}

function formatUpdated(s) {
  if (!s) return '-';
  try {
    const d = new Date(s);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch { return s; }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(reload, 30000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

onMounted(async () => {
  await reload();
  startPolling();
});
onUnmounted(stopPolling);
</script>

<style scoped>
.ff-view { width: 100%; }
.ff-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.ff-refresh-btn { padding: 6px 12px; border: 1px solid var(--border); background: var(--panel); border-radius: 4px; cursor: pointer; color: var(--text); }
.ff-meta { color: var(--muted); font-size: 12px; }
.ff-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ff-table th, .ff-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
.ff-table th { background: var(--panel); color: var(--muted); font-weight: 500; font-size: 12px; }
.ff-col-key { width: 26%; }
.ff-col-key code { font-family: monospace; font-size: 12px; color: var(--accent, #3b82f6); }
.ff-col-desc { color: var(--text); }
.ff-col-value { width: 100px; }
.ff-col-toggle { width: 70px; }
.ff-col-updated { width: 160px; color: var(--muted); font-size: 12px; }
.ff-badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.ff-badge.on { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
.ff-badge.off { background: rgba(156, 163, 175, 0.15); color: #6b7280; }
/* R158.X.116.f — Toggle 开关 (替代原 .ff-toggle 文字按钮) */
.ff-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: rgba(156, 163, 175, 0.35);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  vertical-align: middle;
}
.ff-switch.on { background: rgba(34, 197, 94, 0.55); border-color: rgba(34, 197, 94, 0.7); }
.ff-switch-knob {
  position: absolute;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s ease;
}
.ff-switch.on .ff-switch-knob { transform: translateX(18px); }
.ff-switch:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
