<!--
  R158.36 (2026-10-03) — DcOverviewPanel.vue
  右栏 DC 概览面板. 选中 DC 节点但没具体 user/group 时渲染.

  内容:
    - DC hostname + 心跳 dot + 状态文本
    - 同步数据 staleness (snapshot/24h-stale hint)
    - 锁定账户数 (lockedCount from /api/dashboard/agents)
    - 最近 quickfix run (从 ad-account/quickfix-history 取一行)
    - 简易「说点什么」提示 — 引导操作员去中间列表选用户/组
-->
<template>
  <div class="dc-overview-panel">
    <header class="do-head">
      <h3>{{ props.hostname }}</h3>
      <span :class="['status-pill', statusClass]" data-test="do-status">
        <span class="dot"></span>{{ statusText }}
      </span>
    </header>

    <table class="do-meta">
      <tbody>
        <tr><th>心跳</th><td>{{ heartbeatText }}</td></tr>
        <tr><th>站点</th><td>{{ siteName || '—' }}</td></tr>
        <tr><th>锁定账户</th>
          <td>
            <span :class="lockedCount > 0 ? 'locked-num' : 'muted'">
              {{ lockedCount > 0 ? `🔒 ${lockedCount} 个` : '无锁定' }}
            </span>
          </td>
        </tr>
        <tr><th>同步数据</th>
          <td>
            <span v-if="!directoryConfigured" class="hint">未配置 — 实时模式</span>
            <span v-else-if="directoryStale" class="hint staleness-warn">
              ⓳ 超过 24h — {{ directoryLastRun ? fmtTs(directoryLastRun) : '从未' }}
            </span>
            <span v-else class="staleness-ok">
              ✓ {{ directoryLastRun ? fmtTs(directoryLastRun) : '已配置' }}
            </span>
          </td>
        </tr>
        <tr><th>最近重置</th>
          <td>{{ lastQuickfixAt ? fmtRelative(lastQuickfixAt) : '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div class="do-hint">
      <!-- R158.45.20 (2026-10-05) — DC 视图 4 tab 已跟 /admin/ad-users 路由一起下线.
           引导 operator 用「日常管理」OU 视图: 选 OU → 中栏 unified list → 点行 →
           右栏出属性 + 操作 (重置密码 / 编辑 / 删除 等). -->
      <p class="hint">切到 <strong>左侧 OU 树</strong> (选 OU 节点) → <strong>中栏</strong> 列出该 OU 下所有对象 (用户 / 组 / 电脑 / 子 OU) → 点击行 → <strong>右栏</strong> 出现属性 + 写动作 (重置密码 / 编辑 / 启用 / 删除 等).</p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import api from '../../api/client.js';
import { formatDateTimeIso } from '../../lib/timezone.js';

const props = defineProps({
  hostname: { type: String, required: true }
});

const heartbeat = ref('unknown');
const lockedCount = ref(0);
const siteName = ref('');
const lastQuickfixAt = ref(null);
const directoryConfigured = ref(false);
const directoryLastRun = ref(null);
const directoryStale = ref(false);
let pollTimer = null;

async function refresh() {
  try {
    const r = await api.get('/api/dashboard/agents');
    const agents = r.data.agents || [];
    const me = agents.find(a => (a.hostname || a.dcName) === props.hostname);
    if (me) {
      heartbeat.value = me.status || 'unknown';
      lockedCount.value = Number(me.lockedCount || 0);
      siteName.value = me.siteName || '';
      lastQuickfixAt.value = me.lastQuickfixAt || null;
    }
  } catch { /* noop */ }
  try {
    const r = await api.get('/api/admin/directory-sync/status');
    directoryConfigured.value = Boolean(r.data?.configured);
    directoryLastRun.value = r.data?.lastRun?.startedAt || null;
    if (directoryLastRun.value) {
      const ageMs = Date.now() - new Date(directoryLastRun.value).getTime();
      directoryStale.value = ageMs > 24 * 60 * 60 * 1000;
    } else {
      directoryStale.value = true;
    }
  } catch {
    directoryConfigured.value = false;
    directoryStale.value = true;
  }
}

const statusText = computed(() => {
  switch (heartbeat.value) {
    case 'online': return '在线';
    case 'warn': return '告警';
    case 'offline': return '离线';
    default: return '未知';
  }
});
const statusClass = computed(() => {
  switch (heartbeat.value) {
    case 'online': return 'ok';
    case 'warn': return 'warn';
    case 'offline': return 'err';
    default: return 'unknown';
  }
});
const heartbeatText = computed(() => {
  if (heartbeat.value === 'online') return '绿 — 60s 内有心跳';
  if (heartbeat.value === 'warn') return '黄 — 心跳延迟';
  if (heartbeat.value === 'offline') return '红 — 心跳超时';
  return '灰 — 未知 / 首次心跳未到';
});

function fmtTs(iso) {
  if (!iso) return '—';
  return formatDateTimeIso(iso, { fallback: iso });
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

watch(() => props.hostname, () => { refresh(); });
onMounted(() => {
  refresh();
  pollTimer = setInterval(refresh, 30000);
});
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<style scoped>
.dc-overview-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.do-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.do-head h3 { margin: 0; font-size: 15px; }
.status-pill {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600;
}
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ok { background: rgba(34, 197, 94, 0.14); color: #22c55e; }
.status-pill.warn { background: rgba(245, 158, 11, 0.14); color: #f59e0b; }
.status-pill.err { background: rgba(239, 68, 68, 0.14); color: #ef4444; }
.status-pill.unknown { background: rgba(107, 114, 128, 0.18); color: var(--muted); }

.do-meta { width: 100%; border-collapse: collapse; font-size: 13px; }
.do-meta th, .do-meta td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.do-meta th { color: var(--text-muted); width: 100px; font-weight: 600; }
.locked-num { color: #f87171; font-weight: 600; }
.staleness-ok { color: #22c55e; }
.staleness-warn { color: #f59e0b; }
.muted { color: var(--muted); }
.hint { color: var(--muted); font-size: 11px; }

.do-hint {
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.do-hint .hint { font-size: 12px; line-height: 1.6; }
.do-hint strong { color: var(--text); }
</style>
