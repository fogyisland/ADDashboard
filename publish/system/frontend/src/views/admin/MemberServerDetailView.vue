<template>
  <AdminLayout>
    <div class="back-row">
      <router-link to="/admin/member-servers">← 返回服务器列表</router-link>
    </div>

    <div v-if="loading" class="muted">加载中...</div>
    <div v-else-if="loadError" class="error">{{ loadError }}</div>
    <div v-else-if="!server" class="muted">未找到服务器 {{ hostname }}</div>

    <template v-else>
      <!-- §6.3 1. Header -->
      <section class="card">
        <h2>{{ server.hostname }}</h2>
        <div class="header-grid">
          <div><span class="k">所属站点</span><span class="v">{{ server.site_name || '未分配' }}</span></div>
          <div><span class="k">IP</span><span class="v">{{ server.ip_address || '-' }}</span></div>
          <div><span class="k">OS</span><span class="v">{{ server.os_version || '-' }}</span></div>
          <div>
            <span class="k">Agent 类型</span>
            <span class="v">
              <span class="badge">{{ server.agent_type || 'non-ad' }}</span>
            </span>
          </div>
          <div>
            <span class="k">启用</span>
            <span class="v">
              <span :class="['pill', server.enabled ? 'on' : 'off']">
                {{ server.enabled ? '是' : '否' }}
              </span>
            </span>
          </div>
          <div><span class="k">最近心跳</span><span class="v">{{ fmt(server.last_seen_at) }}</span></div>
          <div><span class="k">最近上报</span><span class="v">{{ fmt(server.last_report_at) }}</span></div>
          <div><span class="k">发现于</span><span class="v">{{ fmt(server.discovered_at) }}</span></div>
          <div><span class="k">发现方式</span><span class="v">{{ server.discovered_via || '-' }}</span></div>
        </div>
      </section>

      <!-- §6.3 2. 已启用包 -->
      <section class="card">
        <div class="card-head">
          <h3>已启用包</h3>
          <button class="primary" @click="openAddPackage">+ 添加包</button>
        </div>
        <table class="t" v-if="packages.length">
          <thead>
            <tr>
              <th>包名</th>
              <th>版本</th>
              <th>类型</th>
              <th>已启用</th>
              <th>最近执行</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in packages" :key="p.package_name">
              <td><code>{{ p.package_name }}</code></td>
              <td>{{ p.version || '-' }}</td>
              <td>{{ p.type || '-' }}</td>
              <td>
                <input
                  type="checkbox"
                  :checked="!!p.enabled"
                  @change="togglePackage(p, $event.target.checked)"
                />
              </td>
              <td><small>{{ fmt(p.last_run_at) }}</small></td>
              <td>
                <button @click="removePackage(p)">卸载</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">未绑定任何包 — 内置 ad-os-baseline 会由 agent self-register 自动加入</p>
      </section>

      <!-- §6.3 3. 告警规则 (filled in T14) -->
      <section class="card">
        <div class="card-head">
          <h3>告警规则 ({{ rules.length }})</h3>
          <button class="primary" @click="openNewRule">+ 新建规则</button>
        </div>
        <table class="t" v-if="rules.length">
          <thead>
            <tr>
              <th>规则名</th>
              <th>持续 / 冷却</th>
              <th>收件人</th>
              <th>启用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rules" :key="r.rule_id">
              <td>{{ r.name }}</td>
              <td><small>{{ r.for_minutes }}m / {{ r.cooldown_minutes }}m</small></td>
              <td><small>{{ r.recipients || '默认' }}</small></td>
              <td>
                <span :class="['pill', r.enabled ? 'on' : 'off']">{{ r.enabled ? '是' : '否' }}</span>
              </td>
              <td>
                <button @click="onDeleteRule(r)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">尚未配置告警规则 — 点击"新建规则"开始</p>
      </section>

      <!-- §6.3 4. 活动告警 / 历史 (filled in T14) -->
      <section class="card">
        <div class="card-head">
          <h3>活动告警 / 历史</h3>
          <div class="tab-toggle">
            <button :class="{ on: alertTab === 'active' }" @click="alertTab = 'active'">
              活动 ({{ activeAlerts.length }})
            </button>
            <button :class="{ on: alertTab === 'history' }" @click="alertTab = 'history'">
              历史 ({{ historicalAlerts.length }})
            </button>
          </div>
        </div>
        <table class="t" v-if="displayedAlerts.length">
          <thead>
            <tr>
              <th>时间</th>
              <th>事件</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in displayedAlerts" :key="e.id">
              <td><small>{{ fmt(e.created_at) }}</small></td>
              <td>
                <span :class="['pill', e.event === 'fired' ? 'on' : 'off']">{{ e.event }}</span>
              </td>
              <td><small>{{ e.detail || '-' }}</small></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">
          {{ alertTab === 'active' ? '无活动告警' : '无历史告警事件' }}
        </p>
      </section>

      <!-- §6.3 5. 基线指标 (filled in T14) -->
      <section class="card">
        <h3>基线指标</h3>
        <div v-if="!baseline" class="muted">尚无基线数据 — 等待 agent 上报 metrics 后显示</div>
        <div v-else class="baseline-tiles">
          <div class="tile">
            <div class="tile-k">CPU 使用率</div>
            <div class="tile-v">{{ pctOrDash(baseline.cpu_pct) }}%</div>
          </div>
          <div class="tile">
            <div class="tile-k">内存使用率</div>
            <div class="tile-v">{{ pctOrDash(baseline.memory_pct) }}%</div>
          </div>
          <div class="tile">
            <div class="tile-k">磁盘剩余 (总览)</div>
            <div class="tile-v">{{ diskFreeSummary(baseline.disk_free) }}</div>
          </div>
          <div class="tile">
            <div class="tile-k">采集时间</div>
            <div class="tile-v">{{ fmt(baseline.ts) }}</div>
          </div>
          <div class="tile wide" v-if="baseline.services">
            <div class="tile-k">服务列表</div>
            <div class="tile-v">
              <ul class="svc-list">
                <li v-for="(v, k) in baseline.services" :key="k">
                  <code>{{ k }}</code>: {{ v }}
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- Add Package dialog -->
    <div v-if="addOpen" class="modal-bg" @click.self="addOpen = false">
      <div class="modal">
        <h3>添加包绑定</h3>
        <div class="row">
          <label>包名</label>
          <input v-model="addPkgName" placeholder="ad-os-baseline" />
        </div>
        <div class="row">
          <label>启用</label>
          <input type="checkbox" v-model="addPkgEnabled" />
        </div>
        <div v-if="addError" class="error">{{ addError }}</div>
        <div class="actions">
          <button @click="addOpen = false">取消</button>
          <button class="primary" :disabled="addBusy" @click="submitAddPackage">
            {{ addBusy ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Rule editor dialog -->
    <RuleEditorDialog
      v-if="ruleEditorOpen"
      :rule="{ hostname }"
      @save="onRuleSaved"
      @cancel="ruleEditorOpen = false"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AdminLayout from '../../components/AdminLayout.vue';
import RuleEditorDialog from './RuleEditorDialog.vue';
import { adminApi } from '../../api/admin.js';

const route = useRoute();
const hostname = computed(() => decodeURIComponent(String(route.params.hostname || '')));

const server = ref(null);
const packages = ref([]);
const rules = ref([]);
const alerts = ref([]);
const baseline = ref(null);
const loading = ref(true);
const loadError = ref('');

const addOpen = ref(false);
const addPkgName = ref('');
const addPkgEnabled = ref(true);
const addBusy = ref(false);
const addError = ref('');

const ruleEditorOpen = ref(false);
const alertTab = ref('active'); // 'active' | 'history'

const activeAlerts = computed(() => alerts.value.filter((e) => e.event === 'fired'));
const historicalAlerts = computed(() => alerts.value); // history = everything (capped 200 server-side)
const displayedAlerts = computed(() => alertTab.value === 'active' ? activeAlerts.value : historicalAlerts.value);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const s = await adminApi.getMemberServer(hostname.value);
    server.value = s.data || null;
    if (server.value) {
      const pkgs = await adminApi.listMemberServerPackages(hostname.value);
      packages.value = pkgs.data?.items || [];
      // T14: load rules + alerts + baseline in parallel (each fails independently).
      const [r, a, b] = await Promise.all([
        adminApi.listAlertRules(hostname.value).catch(() => ({ data: { items: [] } })),
        adminApi.listMemberServerAlerts(hostname.value).catch(() => ({ data: { items: [] } })),
        adminApi.getMemberServerBaseline(hostname.value).catch(() => ({ data: { latest: null } }))
      ]);
      rules.value = r.data?.items || [];
      alerts.value = a.data?.items || [];
      baseline.value = b.data?.latest || null;
    }
  } catch (e) {
    loadError.value = e.response?.data?.error || e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function togglePackage(p, enabled) {
  await adminApi.setMemberServerPackageEnabled(hostname.value, p.package_name, enabled);
  await load();
}

async function removePackage(p) {
  if (!confirm(`卸载包 ${p.package_name}? ad-os-baseline 卸载会写一条 audit (disable_builtin_ad_os_baseline)。`)) return;
  await adminApi.removeMemberServerPackage(hostname.value, p.package_name);
  await load();
}

function openAddPackage() {
  addPkgName.value = '';
  addPkgEnabled.value = true;
  addError.value = '';
  addOpen.value = true;
}

async function submitAddPackage() {
  addError.value = '';
  if (!addPkgName.value.trim()) {
    addError.value = '包名必填';
    return;
  }
  addBusy.value = true;
  try {
    await adminApi.setMemberServerPackageEnabled(hostname.value, addPkgName.value.trim(), addPkgEnabled.value);
    addOpen.value = false;
    await load();
  } catch (e) {
    addError.value = e.response?.data?.error || e.message || String(e);
  } finally {
    addBusy.value = false;
  }
}

function openNewRule() { ruleEditorOpen.value = true; }

async function onRuleSaved() {
  ruleEditorOpen.value = false;
  await load();
}

async function onDeleteRule(r) {
  if (!confirm(`删除告警规则 "${r.name}"? 已触发的 alert_events 也会通过 FK CASCADE 清掉。`)) return;
  try {
    await adminApi.deleteAlertRule(r.rule_id);
    await load();
  } catch (e) {
    loadError.value = e.response?.data?.error || e.message || String(e);
  }
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function pctOrDash(v) {
  if (v === null || v === undefined) return '-';
  return Number(v).toFixed(1);
}
function diskFreeSummary(diskFree) {
  if (!diskFree || typeof diskFree !== 'object') return '-';
  const keys = Object.keys(diskFree);
  if (!keys.length) return '-';
  // Take first drive as a summary; full per-drive breakdown would be a future tile.
  const first = diskFree[keys[0]];
  if (typeof first === 'number') return `${keys[0]}: ${first} MB`;
  return `${keys.length} 个盘`;
}

onMounted(load);
</script>

<style scoped>
.back-row { margin-bottom: 12px; }
.back-row a { color: var(--accent); text-decoration: none; font-size: 13px; }
.card { background: var(--panel); border: 1px solid #1e293b; border-radius: 6px; padding: 16px; margin-bottom: 16px; }
.card h2 { margin: 0 0 12px; }
.card h3 { margin: 0 0 12px; }
.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.header-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 24px; }
.header-grid .k { display: inline-block; width: 96px; color: var(--muted); font-size: 12px; }
.header-grid .v { color: var(--text); font-size: 13px; }
.badge { background: var(--accent); color: #0b1220; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.pill { padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
.pill.on { background: var(--accent); color: #0b1220; }
.pill.off { background: #334155; color: var(--muted); }
.t { width: 100%; border-collapse: collapse; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
code { background: #0b1220; padding: 1px 4px; border-radius: 2px; }
.muted { color: var(--muted); font-size: 13px; }
.error { color: var(--red); font-size: 13px; margin: 8px 0; }
small { color: var(--muted); }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 420px; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.row label { width: 80px; color: var(--muted); font-size: 13px; }
.row input { flex: 1; background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 6px 8px; border-radius: 3px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.primary { background: var(--accent); color: white; }
.tab-toggle button { background: var(--panel); color: var(--text); border: 1px solid #1e293b; padding: 4px 12px; cursor: pointer; font-size: 12px; }
.tab-toggle button:first-child { border-radius: 3px 0 0 3px; }
.tab-toggle button:last-child { border-radius: 0 3px 3px 0; border-left: 0; }
.tab-toggle button.on { background: var(--accent); color: #0b1220; }
.baseline-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.tile { background: #0b1220; border: 1px solid #1e293b; border-radius: 3px; padding: 8px 12px; }
.tile.wide { grid-column: 1 / -1; }
.tile-k { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.tile-v { color: var(--text); font-size: 16px; font-weight: 600; }
.svc-list { list-style: none; padding: 0; margin: 0; font-size: 12px; font-weight: 400; }
.svc-list li { padding: 2px 0; border-bottom: 1px solid #1e293b; }
.svc-list li:last-child { border-bottom: none; }
</style>