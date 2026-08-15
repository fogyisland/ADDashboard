<template>
  <AdminLayout>
    <div class="audit-page">
      <header class="head">
        <h2>审计日志</h2>
        <div class="export-btns">
          <button data-test="export-json" @click="onExport('json')">导出 JSON</button>
          <button data-test="export-csv"  @click="onExport('csv')">导出 CSV</button>
        </div>
      </header>

      <nav class="tabs">
        <button v-for="t in tabs" :key="t.key"
                :class="['tab', { active: active === t.key }]"
                @click="active = t.key">
          {{ t.icon }} {{ t.label }} <span class="badge">{{ badges[t.key] ?? 0 }}</span>
        </button>
      </nav>

      <div class="filters">
        <select v-model="filters.timePreset" @change="onFilterChange">
          <option value="">全部时间</option>
          <option value="1h">1 小时</option>
          <option value="24h">24 小时</option>
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
        </select>
        <input v-model.number="filters.userId" placeholder="用户 ID" @change="onFilterChange" />
        <select v-model="filters.severity" multiple @change="onFilterChange">
          <option value="high">🔴 高</option>
          <option value="medium">🟡 中</option>
          <option value="low">🔵 低</option>
        </select>
      </div>

      <table class="t">
        <thead>
          <tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>严重性</th></tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0"><td colspan="5" class="empty">暂无数据</td></tr>
          <tr v-for="r in rows" :key="r.id"
              :class="['row', `sev-${r.severity}`]"
              data-test="row"
              @click="selected = r">
            <td>{{ fmt(r.createdAt) }}</td>
            <td>{{ r.username ?? (r.userId ?? '-') }}</td>
            <td>{{ r.actionLabel }}</td>
            <td>{{ r.targetLabel || r.target || '-' }}</td>
            <td><span :class="['sev-chip', `sev-chip-${r.severity}`]">{{ sevIcon(r.severity) }} {{ sevLabel(r.severity) }}</span></td>
          </tr>
        </tbody>
      </table>

      <footer class="pager">
        <button :disabled="page <= 1" @click="page--">« 上一页</button>
        <span>第 {{ rangeStart }} - {{ rangeEnd }} / 共 {{ total }}</span>
        <button :disabled="rangeEnd >= total" @click="page++">下一页 »</button>
      </footer>

      <aside v-if="selected" class="drawer" @click.self="selected = null">
        <div class="drawer-body">
          <header>
            <h3>{{ selected.actionLabel }} <small>#{{ selected.id }}</small></h3>
            <button class="close" @click="selected = null">×</button>
          </header>
          <p><b>{{ selected.username ?? selected.userId ?? '-' }}</b> · {{ fmt(selected.createdAt) }}</p>
          <h4>payload</h4>
          <PayloadTree v-if="selected.payload" :value="selected.payload" />
          <p v-else class="muted">无 payload</p>
        </div>
      </aside>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, watch, h } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const tabs = [
  { key: 'security', icon: '🔒', label: '安全' },
  { key: 'changes',  icon: '📝', label: '变更' },
  { key: 'ops',      icon: '⚙', label: '运维' }
];

const active = ref('security');
const page = ref(1);
const size = 100;
const rows = ref([]);
const total = ref(0);
const badges = ref({ security: 0, changes: 0, ops: 0 });
const filters = ref({ timePreset: '', userId: null, severity: [] });
const selected = ref(null);

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function sevIcon(s)  { return s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🔵'; }
function sevLabel(s) { return s === 'high' ? '高' : s === 'medium' ? '中' : '低'; }

const rangeStart = computed(() => total.value === 0 ? 0 : (page.value - 1) * size + 1);
const rangeEnd   = computed(() => Math.min(page.value * size, total.value));

function onFilterChange() { page.value = 1; load(); }

watch([active, page], load);

async function load() {
  const { from, to } = timeRangeToFromTo(filters.value.timePreset);
  const { data } = await adminApi.getAudit({
    category: active.value,
    page: page.value,
    size,
    userId: filters.value.userId || undefined,
    severities: filters.value.severity,
    from, to
  });
  rows.value = data.rows;
  total.value = data.total;
  await refreshBadges();
}

async function refreshBadges() {
  const results = await Promise.all(tabs.map(t => adminApi.getAuditBadge(t.key)));
  for (const r of results) badges.value[r.category] = r.count;
}

async function onExport(format) {
  const { from, to } = timeRangeToFromTo(filters.value.timePreset);
  const blob = await adminApi.exportAudit(format, {
    category: active.value,
    userId: filters.value.userId || undefined,
    severities: filters.value.severity,
    from, to
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${active.value}-${Date.now()}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

function timeRangeToFromTo(preset) {
  if (!preset) return { from: undefined, to: undefined };
  const now = new Date();
  const ms = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 }[preset];
  return { from: new Date(now - ms).toISOString(), to: now.toISOString() };
}

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

load();
</script>

<style scoped>
.audit-page { display: grid; grid-template-rows: auto auto auto 1fr auto; gap: 12px; min-height: 100%; position: relative; }
.head { display: flex; justify-content: space-between; align-items: center; }
.export-btns button { margin-left: 8px; padding: 6px 12px; background: #1e293b; color: var(--text); border: 1px solid #334155; cursor: pointer; border-radius: 3px; }
.export-btns button:hover { background: #334155; }
.tabs { display: flex; gap: 0; border-bottom: 1px solid #1e293b; }
.tab { padding: 8px 16px; background: transparent; color: var(--muted); border: none; border-bottom: 2px solid transparent; cursor: pointer; font-size: 14px; }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.tab .badge { margin-left: 6px; padding: 1px 6px; background: #1e293b; border-radius: 8px; font-size: 12px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 8px 0; }
.filters select, .filters input { padding: 4px 8px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.row { border-left: 3px solid transparent; cursor: pointer; }
.row:hover { background: #1e293b; }
.row.sev-high   { border-left-color: #7f1d1d; }
.row.sev-medium { border-left-color: #ca8a04; }
.row.sev-low    { border-left-color: #1e3a8a; }
.sev-chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
.sev-chip-high   { background: #7f1d1d; color: #fecaca; }
.sev-chip-medium { background: #78350f; color: #fde68a; }
.sev-chip-low    { background: #1e3a8a; color: #bfdbfe; }
.empty { text-align: center; color: var(--muted); padding: 30px; }
.pager { display: flex; gap: 12px; justify-content: center; align-items: center; padding: 8px 0; color: var(--muted); }
.pager button { padding: 4px 12px; background: #1e293b; color: var(--text); border: 1px solid #334155; cursor: pointer; border-radius: 3px; }
.pager button:disabled { opacity: 0.4; cursor: not-allowed; }
.drawer { position: fixed; inset: 0 0 0 auto; width: 40%; min-width: 320px; background: var(--panel); border-left: 1px solid #1e293b; padding: 20px; overflow: auto; z-index: 10; }
.drawer-body header { display: flex; justify-content: space-between; align-items: center; }
.drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; }
.drawer-body .close { background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; }
.json-tree { list-style: none; padding-left: 12px; }
.json-key { color: var(--accent); }
.json-string { color: #86efac; }
.json-number { color: #fbbf24; }
.json-boolean { color: #c084fc; }
.json-null { color: var(--muted); font-style: italic; }
.muted { color: var(--muted); }
</style>