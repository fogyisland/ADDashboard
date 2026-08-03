<template>
  <div class="metric-dashboard">
    <aside class="sidebar">
      <h3>包</h3>
      <ul v-if="store.installed.length">
        <li
          v-for="pkg in store.installed"
          :key="pkg.name"
          :class="{ active: selected === pkg.name }"
          @click="select(pkg)"
        >
          <span class="pkg-name">{{ pkg.name }}</span>
          <span class="pkg-meta">
            <span class="tag" :class="`tag-${pkg.type}`">{{ pkg.type }}</span>
            <span class="tag" :class="pkg.enabled ? 'tag-on' : 'tag-off'">
              {{ pkg.enabled ? '运行' : '停' }}
            </span>
          </span>
        </li>
      </ul>
      <p v-else class="empty">尚未安装任何包</p>
    </aside>

    <main class="content">
      <div v-if="selectedPkg">
        <header class="header">
          <div>
            <h2>{{ selectedPkg.name }}</h2>
            <p class="desc">{{ selectedPkg.manifest.description || '(无描述)' }}</p>
          </div>
        </header>

        <div class="filters">
          <label>
            <span>时间窗</span>
            <select v-model="timeWindow" @change="loadMetrics">
              <option value="1h">1h</option>
              <option value="6h">6h</option>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
            </select>
          </label>
          <label>
            <span>DC</span>
            <select v-model="agentFilter" @change="loadMetrics">
              <option value="all">所有</option>
              <option v-for="a in agents" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
        </div>

        <p v-if="loadError" class="error">{{ loadError }}</p>

        <div class="tiles">
          <component
            v-for="m in selectedPkg.manifest.metrics || []"
            :key="m.key"
            :is="tileComponent(selectedPkg.type)"
            :metric="m"
            :current-value="summary[m.key]?.value"
            :delta="summary[m.key]?.delta ?? 0"
            :data="timeseries[m.key] || []"
            :status="status[m.key]?.status"
            :message="status[m.key]?.message"
          />
          <p v-if="!(selectedPkg.manifest.metrics || []).length" class="empty">
            本包未声明任何 metric。
          </p>
        </div>
      </div>
      <p v-else class="empty">请选择左侧包以查看指标。</p>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import axios from 'axios';
import { usePackagesStore } from '../stores/packages.js';
import GaugeTile from '../components/metrics/GaugeTile.vue';
import CounterTile from '../components/metrics/CounterTile.vue';
import TimeseriesTile from '../components/metrics/TimeseriesTile.vue';
import StatusTile from '../components/metrics/StatusTile.vue';

const store = usePackagesStore();
const selected = ref(null);
const selectedPkg = computed(() => store.installed.find((p) => p.name === selected.value));
const summary = ref({});
const timeseries = ref({});
const status = ref({});
const timeWindow = ref('1h');
const agentFilter = ref('all');
const agents = ref([]);
const loadError = ref(null);

const TILE_MAP = { gauge: GaugeTile, counter: CounterTile, timeseries: TimeseriesTile, status: StatusTile };
function tileComponent(type) { return TILE_MAP[type] || GaugeTile; }

onMounted(async () => {
  await store.fetchInstalled();
  if (store.installed.length) select(store.installed[0]);
});

async function select(pkg) {
  selected.value = pkg.name;
  await loadMetrics();
}

function metricIdFor(metricKey) {
  return `${selected.value}.${metricKey}`;
}

function timeRange() {
  const ms = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 }[timeWindow.value] || 3600e3;
  const to = new Date();
  const from = new Date(Date.now() - ms);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function loadMetrics() {
  if (!selected.value) return;
  loadError.value = null;
  summary.value = {};
  timeseries.value = {};
  status.value = {};
  const params = { packageName: selected.value };
  if (agentFilter.value !== 'all') params.agentId = agentFilter.value;
  try {
    const r = await axios.get('/api/dashboard/metrics/summary', { params });
    const data = r.data || {};
    // The endpoint returns a flat list (gauge + counter + status merged) per
    // metricstore.summary's contract. We discriminate by table-specific
    // columns.
    const allRows = Array.isArray(data.rows) ? data.rows : [];
    const s = {};
    const st = {};
    for (const row of allRows) {
      const id = row.metric_id || '';
      const key = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
      if ('status' in row) {
        st[key] = { status: row.status, message: row.message ?? null };
      } else if ('delta' in row) {
        s[key] = { value: Number(row.value), delta: Number(row.delta ?? 0) };
      } else {
        s[key] = { value: Number(row.value), delta: 0 };
      }
    }
    summary.value = s;
    status.value = st;

    // Collect agent ids seen (for the filter dropdown)
    const set = new Set();
    for (const row of allRows) if (row.agent_id) set.add(row.agent_id);
    agents.value = Array.from(set).sort();

    // Now load timeseries for each declared metric (only useful for
    // type=timeseries packages, but harmless to call otherwise).
    const { from, to } = timeRange();
    for (const m of (selectedPkg.value?.manifest?.metrics || [])) {
      const id = metricIdFor(m.key);
      const tsParams = { metricId: id, from, to };
      if (agentFilter.value !== 'all') tsParams.agentId = agentFilter.value;
      else tsParams.agentId = 'all'; // server expects a value; use 'all' to mean "any"
      try {
        const tr = await axios.get('/api/dashboard/metrics/timeseries', { params: tsParams });
        const pts = Array.isArray(tr.data?.points) ? tr.data.points : [];
        timeseries.value = { ...timeseries.value, [m.key]: pts };
      } catch (_) {
        // Timeseries may be empty / not applicable; skip silently.
        timeseries.value = { ...timeseries.value, [m.key]: [] };
      }
    }
  } catch (e) {
    loadError.value = e.response?.data?.error?.message || e.message;
  }
}
</script>

<style scoped>
.metric-dashboard { display: grid; grid-template-columns: 240px 1fr; min-height: calc(100vh - 80px); }
.sidebar { background: #0b1220; padding: 20px; color: var(--text); }
.sidebar h3 { color: var(--accent); margin: 0 0 16px; font-size: 14px; }
.sidebar ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sidebar li { padding: 8px 10px; border-radius: 4px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.sidebar li:hover { background: #1e293b; }
.sidebar li.active { background: #1e293b; }
.pkg-name { font-weight: 500; }
.pkg-meta { display: flex; gap: 4px; }
.content { padding: 20px; overflow: auto; }
.header h2 { margin: 0; }
.desc { color: var(--muted); margin: 4px 0 16px; }
.filters { display: flex; gap: 16px; margin-bottom: 20px; align-items: center; }
.filters label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.filters select { background: #1e293b; color: var(--text); border: 1px solid #334155; border-radius: 4px; padding: 4px 8px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
.error { color: var(--red); }
.empty { color: var(--muted); padding: 24px; text-align: center; }

.tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; }
.tag-gauge { background: #0e3a2f; color: #67c23a; }
.tag-counter { background: #3a2f0e; color: #e6a23c; }
.tag-timeseries { background: #0e2a3a; color: #409eff; }
.tag-status { background: #2f1e3a; color: #909399; }
.tag-on { background: #0e3a2f; color: #67c23a; }
.tag-off { background: #1e293b; color: var(--muted); }
</style>
