<!-- R158.77 (2026-10-11) — member-server 应用端口 sub-tab. Read-only
     mirror of admin/MemberServersView.vue ports-tab (R158.74). CRUD
     stays in /admin/member-servers — "dashboard 展示用的, 其他都在
     后台设定".

     R158.84 (2026-10-12) — added two live-probe columns. The endpoint
     now actively probes each (host, port) via centre-initiated
     net.Socket on every load; the 30 s setInterval already wired
     below re-probes automatically, so the table latency column
     ticks over without user action. -->
<template>
  <div class="ms-ports">
    <header class="page-header">
      <div class="title-block">
        <h2>业务端口</h2>
        <p class="subtitle">
          业务端口注册表 — 写操作在 <a href="/admin/member-servers" class="link">/admin/member-servers</a>
        </p>
      </div>
      <div class="header-actions">
        <span class="last-update" v-if="lastUpdated">最后更新：{{ formatTime(lastUpdated) }}</span>
        <button class="refresh-btn" :disabled="loading" @click="load" data-test="refresh">刷新</button>
      </div>
    </header>

    <main>
      <div v-if="loading && items.length === 0" class="loading">加载中…</div>
      <div v-else-if="error" class="error-banner">
        <span>应用端口加载失败</span>
        <button @click="load">重试</button>
      </div>
      <div v-else-if="items.length === 0" class="empty-state">
        暂无业务端口 — 在 <a href="/admin/member-servers" class="link">/admin/member-servers</a> 添加
      </div>
      <div v-else class="ports-table-wrap">
        <table class="ports-table" data-test="ms-ports-table">
          <thead>
            <tr>
              <th>主机名</th>
              <th>端口</th>
              <th>服务类型</th>
              <th>探测状态</th>
              <th>耗时</th>
              <th>备注</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in sortedItems"
              :key="`${row.hostname}-${row.port}`"
              :data-test="`ms-port-row-${row.hostname}-${row.port}`"
            >
              <td class="host-cell">
                <span class="host">{{ row.hostname }}</span>
              </td>
              <td class="port-cell mono">{{ row.port }}</td>
              <td>
                <span class="service-tag" :class="serviceTagClass(row.serviceType)">
                  {{ serviceLabel(row.serviceType) }}
                </span>
              </td>
              <td>
                <span class="service-tag" :class="probeTagClass(row.probeStatus)" :data-test="`ms-port-probe-${row.hostname}-${row.port}`">
                  {{ probeLabel(row.probeStatus) }}
                </span>
              </td>
              <td class="mono">{{ formatLatency(row.probeLatencyMs) }}</td>
              <td class="note-cell">{{ row.note || '—' }}</td>
              <td class="mono muted">{{ formatRelative(toMs(row.updatedAt)) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { memberServerApi } from '../../api/member-server.js';
import { formatDateTimeIso } from '../../lib/timezone.js';

const POLL_INTERVAL_MS = 30 * 1000;

const items = ref([]);     // [{hostname, port, serviceType, note, updatedAt}]
const loading = ref(false);
const error = ref(null);
const lastUpdated = ref(null);
let pollHandle = null;

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await memberServerApi.getPorts();
    const payload = r && r.data ? r.data : r;
    items.value = Array.isArray(payload?.items) ? payload.items : [];
    lastUpdated.value = new Date();
  } catch (e) {
    error.value = e;
    if (items.value.length === 0) items.value = [];
  } finally {
    loading.value = false;
  }
}

const sortedItems = computed(() => {
  return [...items.value].sort((a, b) => {
    const h = (a.hostname || '').localeCompare(b.hostname || '');
    if (h !== 0) return h;
    return (a.port || 0) - (b.port || 0);
  });
});

function toMs(v) {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}
// R161.11 — 手搓 getFullYear/... 取的是浏览器本地时区 ⇒ 换机器就变;
//   现在统一按显示时区渲染 (默认 Asia/Shanghai ⇒ 与迁移前逐字相同)。
function formatTime(d) {
  return formatDateTimeIso(d, { fallback: '—' });
}
function formatRelative(ms) {
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// Service-type whitelist (mirrors R158.74 memberServerPorts service).
const SERVICE_LABELS = {
  'file-server': '文件服务器',
  'web':         'Web 服务',
  'database':    '数据库',
  'app-server':  '应用服务',
  'custom':      '自定义'
};
function serviceLabel(t) { return SERVICE_LABELS[t] || t || '—'; }
function serviceTagClass(t) {
  switch (t) {
    case 'database':    return 'tag-danger';
    case 'web':         return 'tag-accent';
    case 'file-server': return 'tag-info';
    case 'app-server':  return 'tag-warn';
    default:            return 'tag-muted';
  }
}

// R158.84 — live probe status (centre-initiated net.Socket, 30 s
// refresh). 4-way contract from member-server-port-probe service.
const PROBE_LABELS = {
  open:    '开放',
  closed:  '关闭',
  timeout: '超时',
  error:   '错误'
};
function probeLabel(s) { return PROBE_LABELS[s] || '—'; }
function probeTagClass(s) {
  switch (s) {
    case 'open':    return 'tag-info';
    case 'closed':  return 'tag-danger';
    case 'timeout': return 'tag-warn';
    case 'error':   return 'tag-muted';
    default:        return 'tag-muted';
  }
}
function formatLatency(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

onMounted(() => {
  load();
  pollHandle = setInterval(load, POLL_INTERVAL_MS);
});
onBeforeUnmount(() => {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
});
</script>

<style scoped>
.ms-ports { padding: 16px 0; }
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.title-block h2 { margin: 0 0 4px; font-size: 20px; color: var(--accent); }
.subtitle { margin: 0; font-size: 12px; color: var(--muted); }
.subtitle a { color: var(--accent); text-decoration: underline; }
.link { color: var(--accent); text-decoration: underline; }
.header-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.last-update { font-size: 12px; color: var(--muted); font-family: monospace; }
.refresh-btn { padding: 6px 14px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; font-size: 13px; }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.loading { padding: 24px; text-align: center; color: var(--muted); }
.error-banner { padding: 16px; background: color-mix(in srgb, var(--red, var(--danger-bg)) 30%, transparent); border: 1px solid var(--red, var(--danger-bg)); border-radius: 4px; display: flex; align-items: center; gap: 12px; color: var(--text); }
.error-banner button { padding: 4px 12px; background: var(--accent); color: var(--sidebar-bg); border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
.empty-state { padding: 40px; text-align: center; color: var(--muted); }
.empty-state a { color: var(--accent); text-decoration: underline; }

.ports-table-wrap {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.ports-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ports-table thead th {
  text-align: left;
  padding: 10px 14px;
  background: color-mix(in srgb, var(--panel-alt) 50%, transparent);
  color: var(--muted);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  border-bottom: 1px solid var(--border);
}
.ports-table tbody td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
.ports-table tbody tr:last-child td { border-bottom: none; }
.ports-table tbody tr:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }

.host-cell .host { font-weight: 600; }
.port-cell { font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace; font-weight: 700; color: var(--accent); }
.note-cell { color: var(--muted); font-size: 12px; max-width: 360px; word-break: break-word; }
.mono { font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace; }
.muted { color: var(--muted); }

.service-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
}
.tag-accent { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
.tag-info   { background: color-mix(in srgb, #38bdf8 18%, transparent); color: #38bdf8; border-color: color-mix(in srgb, #38bdf8 50%, transparent); }
.tag-warn   { background: color-mix(in srgb, var(--hub-gold) 18%, transparent); color: var(--hub-gold); border-color: color-mix(in srgb, var(--hub-gold) 50%, transparent); }
.tag-danger { background: color-mix(in srgb, var(--severity-critical-text) 18%, transparent); color: var(--severity-critical-text); border-color: color-mix(in srgb, var(--severity-critical-text) 50%, transparent); }
.tag-muted  { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); border-color: color-mix(in srgb, var(--muted) 50%, transparent); }
</style>