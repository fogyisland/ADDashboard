<!--
  2026-08-31 R75 — GroupManagementView.vue (AD 组管理).

  Per R75 spec §1.2 + §4.4. Same visual language as UserManagementView.

  Layout:
    1. Page header
    2. Toolbar — DC picker + Name filter + 查询 + 新建
    3. Results table (Name | Category | Scope | Description | Members | 操作)
    4. Right-side drawer
    5. Modals — GroupCreate, GroupProperties, GroupMembers, GroupDelete

  data-test contract (matched by tests/group-management-view.test.js):
    dc-picker              — DC select dropdown
    group-search-filter    — Name filter input
    group-search-button    — search submit
    group-create-button    — open new-group modal
    group-row-${name}      — each result row
    group-action-${action} — per-row action button
-->
<template>
  <AdminLayout>
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">OPERATIONS · AD 组管理</div>
        <h2 class="page-title">AD 组管理</h2>
        <p class="subtitle">
          搜索 / 创建 / 修改 / 删除 Active Directory 组 ·
          命令将在 DC-<span data-test="dc-banner">{{ selectedDc || '—' }}</span> 上执行（仅此 DC）
        </p>
      </div>
      <div class="page-meta">
        <button class="btn-secondary" data-test="refresh-btn" @click="refresh" :disabled="loading">
          {{ loading ? '加载中…' : '↻ 刷新' }}
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <section class="toolbar">
      <label class="form-label">
        <span>目标 DC</span>
        <select data-test="dc-picker" v-model="selectedDc" :disabled="loading">
          <option v-for="d in dcs" :key="d" :value="d">{{ d }}</option>
        </select>
      </label>
      <label class="form-label">
        <span>组名过滤 (支持通配符 *)</span>
        <input
          data-test="group-search-filter"
          v-model="filter"
          placeholder="例如 Sales 或 *Admins"
          :disabled="loading || !selectedDc"
          @keyup.enter="runSearch"
        />
      </label>
      <div class="toolbar-actions">
        <button
          class="btn-primary"
          data-test="group-search-button"
          @click="runSearch"
          :disabled="loading || !selectedDc"
        >{{ searching ? '搜索中…' : '查询' }}</button>
        <button
          class="btn-secondary"
          data-test="group-create-button"
          @click="openCreate"
          :disabled="!selectedDc"
        >+ 新建</button>
      </div>
    </section>

    <div v-if="!selectedDc" class="hint-block">请先选择目标 DC</div>
    <div v-else-if="searching && !results.length" class="hint-block">搜索中…</div>
    <div v-else-if="searchError" class="error-banner">{{ searchError }}</div>
    <div v-else-if="!results.length" class="empty-block">暂无搜索结果</div>
    <table v-else class="t">
      <thead>
        <tr>
          <th>名称</th>
          <th>类别</th>
          <th>范围</th>
          <th>成员数</th>
          <th>描述</th>
          <th class="actions-col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in results" :key="g.name" :data-test="`group-row-${g.name}`" class="group-row">
          <td><code class="sam">{{ g.name }}</code></td>
          <td>
            <span :class="['cat-pill', g.category === 'Security' ? 'sec' : 'dist']">
              {{ g.category || '—' }}
            </span>
          </td>
          <td>
            <span class="scope-pill">{{ g.scope || '—' }}</span>
          </td>
          <td>{{ g.memberCount ?? '—' }}</td>
          <td class="desc-cell" :title="g.description">{{ g.description || '—' }}</td>
          <td class="row-actions">
            <button :data-test="`group-action-properties-${g.name}`" @click="openProperties(g)">设置属性</button>
            <button :data-test="`group-action-members-${g.name}`" @click="openMembers(g)">成员管理</button>
            <button :data-test="`group-action-delete-${g.name}`" class="danger" @click="openDelete(g)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="lastBanner" :class="['action-banner', lastBanner.ok ? 'ok' : 'err']">
      {{ lastBanner.text }} <small v-if="lastBanner.commandId">· 命令 #{{ lastBanner.commandId }}</small>
    </div>

    <AdCommandHistoryDrawer :operator-id="currentUserId" />

    <!-- Modals -->
    <GroupCreateModal
      v-if="modal === 'create'"
      :target-dc="selectedDc"
      @close="modal = null"
      @submitted="onSubmitted('create', $event)"
    />
    <GroupPropertiesModal
      v-if="modal === 'properties' && modalTarget"
      :target-dc="selectedDc"
      :name="modalTarget.name"
      :initial="modalTarget"
      @close="modal = null"
      @submitted="onSubmitted('properties', $event)"
    />
    <GroupMembersModal
      v-if="modal === 'members' && modalTarget"
      :target-dc="selectedDc"
      :name="modalTarget.name"
      @close="modal = null"
      @changed="onSubmitted('members', $event)"
    />
    <GroupDeleteConfirmModal
      v-if="modal === 'delete' && modalTarget"
      :target-dc="selectedDc"
      :name="modalTarget.name"
      @close="modal = null"
      @deleted="onSubmitted('delete', $event)"
    />
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { adAdminApi } from '../../api/ad-admin.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';
import AdminLayout from '../../components/AdminLayout.vue';
import AdCommandHistoryDrawer from './AdCommandHistoryDrawer.vue';
import GroupCreateModal from '../../components/admin/GroupCreateModal.vue';
import GroupPropertiesModal from '../../components/admin/GroupPropertiesModal.vue';
import GroupMembersModal from '../../components/admin/GroupMembersModal.vue';
import GroupDeleteConfirmModal from '../../components/admin/GroupDeleteConfirmModal.vue';

const auth = useAuthStore();
const currentUserId = computed(() => auth.user?.id);

const dcs = ref([]);
const selectedDc = ref('');
const filter = ref('');
const results = ref([]);
const loading = ref(false);
const searching = ref(false);
const error = ref('');
const searchError = ref('');
const lastBanner = ref(null);

const modal = ref(null);
const modalTarget = ref(null);

const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 35_000 });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    results.value = r.result?.groups || [];
  } else {
    searchError.value = r.errorMessage || `命令${r.status}`;
    results.value = [];
  }
  searching.value = false;
});

async function loadDcs() {
  loading.value = true;
  error.value = '';
  try {
    const r = await adAdminApi.listDcs();
    const nodes = Array.isArray(r.data?.nodes) ? r.data.nodes : [];
    const set = new Set();
    for (const n of nodes) if (n.type === 'dc' && n.name) set.add(n.name);
    dcs.value = Array.from(set);
    if (dcs.value.length && !selectedDc.value) selectedDc.value = dcs.value[0];
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '加载 DC 列表失败';
  } finally {
    loading.value = false;
  }
}

async function runSearch() {
  if (!selectedDc.value) return;
  polling.stop();
  searching.value = true;
  searchError.value = '';
  try {
    const resp = await adAdminApi.queueCommand({
      targetDc: selectedDc.value,
      commandType: 'group_search',
      params: { filter: filter.value.trim(), limit: 50 }
    });
    const id = resp.data?.id;
    if (!id) { results.value = []; searching.value = false; return; }
    polling.start(resp.data);
  } catch (e) {
    searchError.value = e?.response?.data?.error || e?.message || '搜索失败';
    searching.value = false;
  }
}

function refresh() {
  loadDcs();
  if (selectedDc.value) runSearch();
}

function openCreate() { modal.value = 'create'; modalTarget.value = null; }
function openProperties(g) { modal.value = 'properties'; modalTarget.value = g; }
function openMembers(g) { modal.value = 'members'; modalTarget.value = g; }
function openDelete(g) { modal.value = 'delete'; modalTarget.value = g; }

function onSubmitted(kind, cmd) {
  lastBanner.value = {
    ok: cmd?.status === 'success',
    text: `${kind} 已提交`,
    commandId: cmd?.id
  };
  setTimeout(runSearch, 2000);
}

onMounted(async () => {
  await loadDcs();
});
</script>

<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; padding-right: 400px; }
.page-titles { display: flex; flex-direction: column; gap: 4px; }
.eyebrow { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.page-title { margin: 0; font-size: 22px; font-weight: 600; }
.subtitle { margin: 0; color: var(--muted); font-size: 13px; }
.page-meta { display: flex; gap: 8px; }
.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 13px;
  border: 1px solid var(--border); background: var(--input-bg); color: var(--text);
}
.btn-primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.error-banner { background: rgba(239, 68, 68, 0.15); color: #dc2626; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; border: 1px solid rgba(239, 68, 68, 0.3); }
.empty-block, .hint-block { background: var(--panel); padding: 16px; border-radius: 4px; border: 1px solid var(--border); color: var(--muted); }

.toolbar {
  display: flex; gap: 12px; align-items: flex-end;
  background: var(--panel); padding: 12px 16px; border-radius: 4px;
  border: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap;
}
.toolbar .form-label { display: flex; flex-direction: column; gap: 4px; min-width: 200px; flex: 1; }
.toolbar .form-label > span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.toolbar .form-label input, .toolbar .form-label select {
  padding: 5px 8px; border: 1px solid var(--border); border-radius: 3px;
  background: var(--input-bg); color: var(--text); font-size: 13px;
}
.toolbar-actions { display: flex; gap: 8px; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.t th, .t td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--input-bg); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.t .sam { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--accent); }
.t .desc-cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-row:hover { background: var(--row-hover); }
.row-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.row-actions button {
  padding: 3px 8px; font-size: 11px;
  background: var(--input-bg); border: 1px solid var(--border); border-radius: 3px;
  cursor: pointer; color: var(--text);
}
.row-actions button.danger { color: var(--red); }
.row-actions button:hover { background: var(--border); }

.cat-pill, .scope-pill {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
}
.cat-pill.sec { background: rgba(96, 165, 250, 0.15); color: #60a5fa; }
.cat-pill.dist { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
.scope-pill { background: rgba(107, 114, 128, 0.15); color: #94a3b8; }

.actions-col { width: 240px; }

.action-banner {
  margin-top: 12px; padding: 8px 12px; border-radius: 4px; font-size: 12px;
  border: 1px solid var(--border);
}
.action-banner.ok { background: rgba(34, 197, 94, 0.15); color: #16a34a; border-color: rgba(34, 197, 94, 0.3); }
.action-banner.err { background: rgba(239, 68, 68, 0.15); color: #dc2626; border-color: rgba(239, 68, 68, 0.3); }

@media (max-width: 1280px) {
  .page-header { padding-right: 340px; }
}
</style>