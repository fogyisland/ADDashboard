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

      <!-- §6.3 3. 告警规则 + 4. 活动告警/历史 + 5. 基线指标 -->
      <!-- T13 ships placeholders; the real widgets land in T14 (RuleEditorDialog)
           and T11's per-host alert hooks (which already exist backend-side). -->
      <section class="card">
        <h3>告警规则</h3>
        <p class="muted">规则编辑器在 T14 交付 — 当前可见 <code>alert_rules</code> 规则数: <b>{{ alertRuleCount }}</b>。编辑入口即将上线。</p>
      </section>

      <section class="card">
        <h3>活动告警 / 历史</h3>
        <p class="muted">告警事件展示在 T14 落地 — 后端 <code>alert_events</code> 已可写入。</p>
      </section>

      <section class="card">
        <h3>基线指标</h3>
        <p class="muted">读取自 <code>pkg_ad_os_baseline.metrics</code> 最近一次上报 — 当前无可视化数据展示组件。CPU / 内存 / 磁盘 free 将在该 tab 内 ECharts 网格渲染 (T14 范围)。</p>
      </section>
    </template>

    <!-- 简单 Add Package dialog: 输入包名(自由文本,backend 接受任意) -->
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
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const route = useRoute();
const hostname = computed(() => decodeURIComponent(String(route.params.hostname || '')));

const server = ref(null);
const packages = ref([]);
const alertRuleCount = ref(0);
const loading = ref(true);
const loadError = ref('');

const addOpen = ref(false);
const addPkgName = ref('');
const addPkgEnabled = ref(true);
const addBusy = ref(false);
const addError = ref('');

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const s = await adminApi.getMemberServer(hostname.value);
    server.value = s.data || null;
    if (server.value) {
      const pkgs = await adminApi.listMemberServerPackages(hostname.value);
      packages.value = pkgs.data?.items || [];
      // alertRuleCount is informational only — backend has a list route but the
      // editor lands in T14. We read it from a generic list call if available;
      // if the endpoint isn't on adminApi yet, just leave 0.
      try {
        const ar = await fetch(`${(import.meta?.env?.BASE_URL || '/')}api/admin/alert-rules?hostname=${encodeURIComponent(hostname.value)}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('ad_token') || ''}` }
        });
        if (ar.ok) {
          const j = await ar.json();
          alertRuleCount.value = (j.items || j || []).length;
        }
      } catch {
        alertRuleCount.value = 0;
      }
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

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

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
</style>
