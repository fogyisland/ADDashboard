<!--
  2026-08-31 R75 — GroupManagementView.vue (AD 组管理).
  2026-09-03 R77 — add batch operations (add/remove members to/from N groups).
  R158.34 (2026-10-02) — DailyOpsView embedding (props.embedded / dc-prop).
  R158.35 (2026-10-03) — dataSource='snapshot' 走 LDAP 快照表.
  R158.36 (2026-10-03) — 三栏改造: 4 个 modal 全部移除 (GroupProperties/
    GroupMembers/GroupDeleteConfirm/BatchAddMembers),改成:
    - 行 click → emit('select-group', { dc, name }) → 父切 selection 到
      {kind:'group', dc, name}, 右栏渲染 GroupPropertyPanel
    - 工具栏「+ 新建」保留 (GroupCreateModal 全屏, 唯一保留的 modal)
    - Bulk actions (添加成员 / 移除成员) 保留 (ad_admin_commands
      queueBatch 路径, 多组批量)

  data-test contract (matched by group-management-bulk.test.js):
    dc-picker              — DC select dropdown
    group-search-filter    — Name filter input
    group-search-button    — search submit
    group-create-button    — open new-group modal
    group-row-${name}      — each result row (R158.36: 行 click 触发 emit)
    group-bulk-${name}     — per-row checkbox
    group-bulk-bar         — sticky bulk-action bar
-->
<template>
  <template v-if="!props.embedded">
    <AdminLayout>
      <header class="page-header">
        <div class="page-titles">
          <div class="eyebrow">运维管理 · AD 组管理</div>
          <h2 class="page-title">AD 组管理</h2>
          <p class="subtitle">
            搜索 / 创建 / 修改 / 删除域控上的组 ·
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
            <th class="checkbox-col">
              <input
                type="checkbox"
                data-test="group-bulk-master"
                :checked="allSelected"
                :indeterminate.prop="someSelected && !allSelected"
                @change="toggleAll"
              />
            </th>
            <th>名称</th>
            <th>类别</th>
            <th>范围</th>
            <th>成员数</th>
            <th>描述</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in results" :key="g.name" :data-test="`group-row-${g.name}`"
              class="group-row" @click="emit('select-group', { dc: selectedDc, name: g.name })">
            <td class="checkbox-col" @click.stop>
              <input
                type="checkbox"
                :data-test="`group-bulk-${g.name}`"
                :checked="selectedNames.has(g.name)"
                @change="toggleName(g.name)"
              />
            </td>
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
          </tr>
        </tbody>
      </table>

      <div v-if="selectedNames.size > 0" class="bulk-bar" data-test="group-bulk-bar">
        <span class="bulk-count" data-test="group-bulk-count">已选 {{ selectedNames.size }} 个组</span>
        <div class="bulk-actions">
          <button data-test="group-bulk-add"    :disabled="!selectedDc || bulkInFlight" @click="openBatchAddMembers">添加成员</button>
          <button data-test="group-bulk-remove" :disabled="!selectedDc || bulkInFlight" @click="openBatchRemoveMembers">移除成员</button>
          <button data-test="group-bulk-clear"  :disabled="bulkInFlight" @click="clearSelection">取消选择</button>
        </div>
      </div>

      <div v-if="lastBanner" :class="['action-banner', lastBanner.ok ? 'ok' : 'err']">
        {{ lastBanner.text }} <small v-if="lastBanner.commandId">· 命令 #{{ lastBanner.commandId }}</small>
      </div>

      <AdCommandHistoryDrawer :operator-id="currentUserId" />

      <GroupCreateModal v-if="modal === 'create'" :target-dc="selectedDc" @close="modal = null" @submitted="onSubmitted('create', $event)" />
      <BatchAddMembersModal v-if="modal === 'batchAdd' || modal === 'batchRemove'" :mode="modal === 'batchRemove' ? 'remove' : 'add'" :groups-count="selectedNames.size" @close="modal = null" @submit="onBatchMembersSubmit" />
    </AdminLayout>
  </template>

  <div v-else class="embedded-host">
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">运维管理 · AD 组管理</div>
        <h2 class="page-title">AD 组管理</h2>
        <p class="subtitle">
          点击行 → 右侧显示属性 + 操作 ·
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
      <span class="embedded-dc-chip" data-test="dc-banner">目标 DC: {{ selectedDc }}</span>
      <span
        v-if="props.dataSource === 'snapshot' && snapshotMeta.snapshotAt"
        :class="['snapshot-badge', snapshotStaleCls]"
        :title="`同步运行 #${snapshotMeta.snapshotRunId} · 共 ${snapshotMeta.total} 条`"
      >📦 {{ fmtSnapshotTime(snapshotMeta.snapshotAt) }} 同步数据 ({{ snapshotMeta.total }} 条)</span>
      <span
        v-else-if="props.dataSource === 'snapshot'"
        class="snapshot-badge snapshot-badge-empty"
        title="该 DC 尚无同步快照, 请到 /admin/directory-sync 触发同步"
      >⓳ 暂无同步数据</span>
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
        <button class="btn-primary" data-test="group-search-button" @click="runSearch" :disabled="loading || !selectedDc">{{ searching ? '搜索中…' : '查询' }}</button>
        <button class="btn-secondary" data-test="group-create-button" @click="openCreate" :disabled="!selectedDc">+ 新建</button>
      </div>
    </section>

    <div v-if="!selectedDc" class="hint-block">请先选择目标 DC</div>
    <div v-else-if="searching && !results.length" class="hint-block">搜索中…</div>
    <div v-else-if="searchError" class="error-banner">{{ searchError }}</div>
    <div v-else-if="!results.length" class="empty-block">暂无搜索结果 · 在右栏 + 新建 → GroupCreateModal 创建</div>
    <table v-else class="t">
      <thead>
        <tr>
          <th class="checkbox-col">
            <input type="checkbox" data-test="group-bulk-master" :checked="allSelected" :indeterminate.prop="someSelected && !allSelected" @change="toggleAll" />
          </th>
          <th>名称</th>
          <th>类别</th>
          <th>范围</th>
          <th>成员数</th>
          <th>描述</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in results" :key="g.name" :data-test="`group-row-${g.name}`"
            :class="['group-row', { active: props.selectedName === g.name }]"
            @click="emit('select-group', { dc: selectedDc, name: g.name })">
          <td class="checkbox-col" @click.stop>
            <input type="checkbox" :data-test="`group-bulk-${g.name}`" :checked="selectedNames.has(g.name)" @change="toggleName(g.name)" />
          </td>
          <td><code class="sam">{{ g.name }}</code></td>
          <td><span :class="['cat-pill', g.category === 'Security' ? 'sec' : 'dist']">{{ g.category || '—' }}</span></td>
          <td><span class="scope-pill">{{ g.scope || '—' }}</span></td>
          <td>{{ g.memberCount ?? '—' }}</td>
          <td class="desc-cell" :title="g.description">{{ g.description || '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="selectedNames.size > 0" class="bulk-bar" data-test="group-bulk-bar">
      <span class="bulk-count" data-test="group-bulk-count">已选 {{ selectedNames.size }} 个组</span>
      <div class="bulk-actions">
        <button data-test="group-bulk-add"    :disabled="!selectedDc || bulkInFlight" @click="openBatchAddMembers">添加成员</button>
        <button data-test="group-bulk-remove" :disabled="!selectedDc || bulkInFlight" @click="openBatchRemoveMembers">移除成员</button>
        <button data-test="group-bulk-clear"  :disabled="bulkInFlight" @click="clearSelection">取消选择</button>
      </div>
    </div>

    <div v-if="lastBanner" :class="['action-banner', lastBanner.ok ? 'ok' : 'err']">
      {{ lastBanner.text }} <small v-if="lastBanner.commandId">· 命令 #{{ lastBanner.commandId }}</small>
    </div>

    <AdCommandHistoryDrawer :operator-id="currentUserId" />

    <GroupCreateModal v-if="modal === 'create'" :target-dc="selectedDc" @close="modal = null" @submitted="onSubmitted('create', $event)" />
    <BatchAddMembersModal v-if="modal === 'batchAdd' || modal === 'batchRemove'" :mode="modal === 'batchRemove' ? 'remove' : 'add'" :groups-count="selectedNames.size" @close="modal = null" @submit="onBatchMembersSubmit" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { adAdminApi } from '../../api/ad-admin.js';
import { adminApi } from '../../api/admin.js';
import { useCommandPolling } from '../../composables/useCommandPolling.js';
import AdminLayout from '../../components/AdminLayout.vue';
import AdCommandHistoryDrawer from './AdCommandHistoryDrawer.vue';
import GroupCreateModal from '../../components/admin/GroupCreateModal.vue';
import BatchAddMembersModal from '../../components/admin/BatchAddMembersModal.vue';

const auth = useAuthStore();
const currentUserId = computed(() => auth.user?.id);

const dcs = ref([]);

// R158.36 — emit('select-group', { dc, name }) when a row is clicked
// so DailyOpsView can flip its selection to {kind:'group', dc, name} and
// render GroupPropertyPanel in the right pane. `:selectedName` makes the
// active row get a highlight class.
// R158.40 (2026-10-03) — ouDnProp: OU-scoped drill-down. When set, only
// groups whose DN ends with the OU DN are returned (server-side LIKE
// `%,OU_DN` filter; Phase A added the parameter). Empty = full-DC list.
const props = defineProps({
  dcProp: { type: String, default: '' },
  // R158.45.15 fix — domain FQDN, OU 视图下 dc 可能为空.
  domain: { type: String, default: '' },
  embedded: { type: Boolean, default: false },
  dataSource: { type: String, default: 'live' },
  selectedName: { type: String, default: '' },
  ouDnProp: { type: String, default: '' }
});
const emit = defineEmits(['select-group']);

const selectedDc = ref(props.dcProp || '');
const filter = ref('');
const results = ref([]);
const loading = ref(false);
const searching = ref(false);
const error = ref('');
const searchError = ref('');
const lastBanner = ref(null);

const modal = ref(null);

const snapshotMeta = ref({ snapshotAt: null, snapshotRunId: null, total: 0 });

const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 35_000 });

const selectedNames = ref(new Set());
const bulkInFlight = ref(false);

const allSelected = computed(() =>
  results.value.length > 0 && selectedNames.value.size === results.value.length
);
const someSelected = computed(() => selectedNames.value.size > 0);

function toggleName(name) {
  const next = new Set(selectedNames.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedNames.value = next;
}

function toggleAll() {
  if (allSelected.value) {
    selectedNames.value = new Set();
  } else {
    selectedNames.value = new Set(results.value.map(g => g.name));
  }
}

function clearSelection() {
  selectedNames.value = new Set();
}

watch(results, () => {
  selectedNames.value = new Set();
});

watch(() => props.dcProp, (newDc) => {
  if (newDc && newDc !== selectedDc.value) {
    selectedDc.value = newDc;
    runSearch();
  }
});
watch(() => props.dataSource, () => { runSearch(); });
// R158.40 — re-run on OU change. Embedded callers flip ouDnProp when
// the operator clicks another OU node in the left tree.
// R158.45.15 (2026-10-05) — 加 immediate: true. 默认 tab 改成 users 后, 首次
// 进 OU 选中状态时 (Vue watch 默认 lazy 不触发) 列表必须拉. OU 维度变化也
// 走这条 watch, immediate 只影响首次挂载.
watch(() => props.ouDnProp, () => { runSearch(); }, { immediate: true });
// R158.45.15 fix — domain 变化也触发 reload (OU 切到不同域).
watch(() => props.domain, () => { runSearch(); });

function openBatchAddMembers() {
  if (selectedNames.value.size === 0) return;
  modal.value = 'batchAdd';
}

function openBatchRemoveMembers() {
  if (selectedNames.value.size === 0) return;
  modal.value = 'batchRemove';
}

async function onBatchMembersSubmit(payload) {
  const { sams } = payload;
  const commandType = modal.value === 'batchRemove' ? 'group_remove_member' : 'group_add_member';
  const groups = Array.from(selectedNames.value);
  bulkInFlight.value = true;
  modal.value = null;
  try {
    const resp = await adAdminApi.queueBatch({
      targetDc: selectedDc.value,
      commandType,
      paramsList: groups.map(name => ({ name, members: sams }))
    });
    const queued = resp.data?.queued?.length ?? 0;
    const errors = resp.data?.errors?.length ?? 0;
    const verb = commandType === 'group_remove_member' ? '移除成员' : '添加成员';
    lastBanner.value = {
      ok: errors === 0,
      text: errors === 0
        ? `已批量 ${verb} ${queued} 个组`
        : `批量 ${verb} 部分失败 — 成功 ${queued} / 失败 ${errors}`,
      commandId: null
    };
    if (errors === 0) clearSelection();
  } catch (e) {
    const verb = commandType === 'group_remove_member' ? '移除成员' : '添加成员';
    lastBanner.value = {
      ok: false,
      text: `批量 ${verb} 失败 — ${e?.response?.data?.error || e?.message}`,
      commandId: null
    };
  } finally {
    bulkInFlight.value = false;
    setTimeout(runSearch, 2500);
  }
}
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
  // R158.45.15 fix — OU 视图下 selectedDc 可能为空, 优先用 domain.
  if (!selectedDc.value && !props.domain) return;
  polling.stop();
  searching.value = true;
  searchError.value = '';
  // R158.35 — snapshot dataSource short-circuits the agent round-trip.
  // R158.45.15 fix — 优先用 props.domain 走 listAdGroupsByDomain (OU 视图
  // 下 dc 可能为空). 后端 400 'dc or domain required' 不再触发.
  if (props.dataSource === 'snapshot') {
    try {
      let r;
      if (props.domain) {
        r = await adminApi.listAdGroupsByDomain({
          domain: props.domain,
          filter: filter.value.trim(),
          ouDn: props.ouDnProp || '',
          limit: 200,
          offset: 0
        });
      } else {
        r = await adminApi.listAdGroups({
          dc: selectedDc.value,
          filter: filter.value.trim(),
          limit: 200,
          offset: 0,
          ouDn: props.ouDnProp || ''
        });
      }
      results.value = r.data?.groups || [];
      snapshotMeta.value = {
        snapshotAt: r.data?.snapshotAt || null,
        snapshotRunId: r.data?.snapshotRunId || null,
        total: Number(r.data?.total || 0)
      };
    } catch (e) {
      searchError.value = e?.response?.data?.error || e?.message || '同步快照读取失败';
      results.value = [];
      snapshotMeta.value = { snapshotAt: null, snapshotRunId: null, total: 0 };
    } finally {
      searching.value = false;
    }
    return;
  }
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

function openCreate() { modal.value = 'create'; }

function onSubmitted(kind, cmd) {
  lastBanner.value = {
    ok: cmd?.status === 'success',
    text: `${kind} 已提交`,
    commandId: cmd?.id
  };
  setTimeout(runSearch, 2000);
}

function fmtSnapshotTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const snapshotStaleCls = computed(() => {
  if (!snapshotMeta.value.snapshotAt) return 'snapshot-badge-empty';
  const ageMs = Date.now() - new Date(snapshotMeta.value.snapshotAt).getTime();
  if (ageMs <= 30_000) return 'snapshot-badge-fresh';
  if (ageMs <= 120_000) return 'snapshot-badge-warn';
  return 'snapshot-badge-stale';
});

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
.snapshot-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 3px; font-size: 12px;
  border: 1px solid var(--border); background: var(--input-bg);
}
.snapshot-badge-fresh { color: #22c55e; border-color: rgba(34, 197, 94, 0.4); background: rgba(34, 197, 94, 0.10); }
.snapshot-badge-warn  { color: #f59e0b; border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.10); }
.snapshot-badge-stale { color: #ef4444; border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.10); }
.snapshot-badge-empty { color: var(--muted); }
.btn-primary, .btn-secondary {
  padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 13px;
  border: 1px solid var(--border); background: var(--input-bg); color: var(--text);
}
.btn-primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.error-banner { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--status-pill-fg-err); padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); }
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
/* R158.45.17 (2026-10-05) — ADUC 风格 sticky 表头 (跟 UserManagementView 一致). */
.t thead th { position: sticky; top: 0; z-index: 1; }
.t .sam { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--accent); }
.t .desc-cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-row { cursor: pointer; }
.group-row:hover { background: var(--row-hover); }
.group-row.active { background: rgba(96, 165, 250, 0.18); }
.group-row.active td { color: var(--accent); }
.row-actions { display: flex; gap: 4px; flex-wrap: wrap; }

.cat-pill, .scope-pill {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
}
.cat-pill.sec { background: color-mix(in srgb, var(--role-gc-fg) 15%, transparent); color: var(--role-gc-fg); }
.cat-pill.dist { background: var(--chip-purple-bg); color: var(--chip-purple-fg); }
.scope-pill { background: rgba(107, 114, 128, 0.15); color: var(--muted); }

/* 2026-09-03 R77 — bulk-action checkboxes + sticky bulk-action bar.
   Identical to the R76 user-side styling so operators get one
   consistent UX between the user and group admin views. */
.checkbox-col { width: 32px; text-align: center; }
.bulk-bar {
  position: sticky;
  bottom: 0;
  margin-top: 12px;
  padding: 10px 16px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  box-shadow: 0 -2px 8px var(--modal-backdrop);
}
.bulk-count { font-size: 13px; color: var(--accent); font-weight: 600; }
.bulk-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.bulk-actions button {
  padding: 5px 12px;
  font-size: 12px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  cursor: pointer;
  color: var(--text);
}
.bulk-actions button:hover { background: var(--border); }
.bulk-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

.action-banner {
  margin-top: 12px; padding: 8px 12px; border-radius: 4px; font-size: 12px;
  border: 1px solid var(--border);
}
.action-banner.ok { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--status-pill-fg-ok); border-color: color-mix(in srgb, var(--green) 30%, transparent); }
.action-banner.err { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--status-pill-fg-err); border-color: color-mix(in srgb, var(--red) 30%, transparent); }

@media (max-width: 1280px) {
  .page-header { padding-right: 340px; }
}
</style>
