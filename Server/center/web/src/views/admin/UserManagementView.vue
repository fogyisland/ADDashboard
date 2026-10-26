<!--
  2026-08-31 R75 — UserManagementView.vue (AD 用户管理).
  R158.34 (2026-10-02) — DailyOpsView embedding (props.embedded / dc-prop).
  R158.35 (2026-10-03) — dataSource='snapshot' 走 LDAP 快照表.
  R158.36 (2026-10-03) — 三栏改造: 9 个 modal 全部移除,改成:
    - 行 click → emit('select-user', { dc, sam }) → 父 (DailyOpsView) 切
      selection 到 {kind:'user', dc, sam}, 右栏渲染 UserPropertyPanel
    - 工具栏「+ 新建」保留 (UserCreateModal 全屏, 唯一保留的 modal)
    - Bulk actions (启用/禁用/解锁/重置密码) 保留 (ad_admin_commands
      queueBatch 路径, 多账号批量)
    - 组查看 / 编辑属性 / 重置密码 / 删除 / 单个启用/禁用/解锁 — 全部
      移到右栏 UserPropertyPanel.vue

  data-test contract (matched by tests/user-management-view.test.js):
    dc-picker              — DC select dropdown
    user-search-filter     — sAMAccountName filter input
    user-search-button     — search submit
    user-create-button     — open new-user modal
    user-row-${sam}        — each result row (R158.36: 行 click 触发 emit)
    user-bulk-${sam}       — per-row bulk checkbox
-->
<template>
  <!-- R158.34.4 / R158.36 — DailyOpsView 嵌入调用时 (props.embedded=true)
       跳过 AdminLayout chrome; 直接渲染页面内容 (header + toolbar + 表格)。
       双 root (template + v-else div), 同一份 children 复用。-->
  <template v-if="!props.embedded">
    <AdminLayout>
      <header class="page-header">
        <div class="page-titles">
          <div class="eyebrow">运维管理 · AD 用户管理</div>
          <h2 class="page-title">AD 用户管理</h2>
          <p class="subtitle">
            搜索 / 创建 / 修改 / 删除域控上的用户账号 ·
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

      <!-- Toolbar -->
      <section class="toolbar">
        <label class="form-label">
          <span>目标 DC</span>
          <select data-test="dc-picker" v-model="selectedDc" :disabled="loading">
            <option v-for="d in dcs" :key="d" :value="d">{{ d }}</option>
          </select>
        </label>
        <label class="form-label">
          <span>登录名过滤 (支持通配符 *)</span>
          <input
            data-test="user-search-filter"
            v-model="filter"
            placeholder="例如 jdoe 或 ad*"
            :disabled="loading || !selectedDc"
            @keyup.enter="runSearch"
          />
        </label>
        <div class="toolbar-actions">
          <button
            class="btn-primary"
            data-test="user-search-button"
            @click="runSearch"
            :disabled="loading || !selectedDc"
          >{{ searching ? '搜索中…' : '查询' }}</button>
          <button
            class="btn-secondary"
            data-test="user-create-button"
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
                data-test="user-bulk-master"
                :checked="allSelected"
                :indeterminate.prop="someSelected && !allSelected"
                @change="toggleAll"
              />
            </th>
            <th>sAMAccountName</th>
            <th>显示名称</th>
            <th>启用</th>
            <th>上次登录</th>
            <th>描述</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in results" :key="m.sam" :data-test="`user-row-${m.sam}`"
              class="user-row" @click="emit('select-user', { dc: selectedDc, sam: m.sam })">
            <td class="checkbox-col" @click.stop>
              <input
                type="checkbox"
                :data-test="`user-bulk-${m.sam}`"
                :checked="selectedSams.has(m.sam)"
                @change="toggleSam(m.sam)"
              />
            </td>
            <td><code class="sam">{{ m.sam }}</code></td>
            <td>{{ m.displayName || '—' }}</td>
            <td>
              <span :class="['status-pill', m.enabled ? 'ok' : 'err']">
                <span class="dot"></span>{{ m.enabled ? '启用' : '禁用' }}
              </span>
            </td>
            <td>{{ m.lastLogon ? fmt(m.lastLogon) : '—' }}</td>
            <td class="desc-cell" :title="m.description">{{ m.description || '—' }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Bulk-action bar (R76): appears when >=1 row is selected. -->
      <div v-if="selectedSams.size > 0" class="bulk-bar" data-test="user-bulk-bar">
        <span class="bulk-count" data-test="user-bulk-count">已选 {{ selectedSams.size }} 个账号</span>
        <div class="bulk-actions">
          <button data-test="user-bulk-enable"   :disabled="!selectedDc || bulkInFlight" @click="bulkConfirm('user_enable')">启用</button>
          <button data-test="user-bulk-disable"  :disabled="!selectedDc || bulkInFlight" @click="bulkConfirm('user_disable')">禁用</button>
          <button data-test="user-bulk-unlock"   :disabled="!selectedDc || bulkInFlight" @click="bulkSend('user_unlock')">解锁</button>
          <button data-test="user-bulk-reset"    :disabled="!selectedDc || bulkInFlight" @click="openBatchPasswordReset">重置密码</button>
          <button data-test="user-bulk-clear"    :disabled="bulkInFlight" @click="clearSelection">取消选择</button>
        </div>
      </div>

      <div v-if="lastBanner" :class="['action-banner', lastBanner.ok ? 'ok' : 'err']">
        {{ lastBanner.text }} <small v-if="lastBanner.commandId">· 命令 #{{ lastBanner.commandId }}</small>
      </div>

      <AdCommandHistoryDrawer :operator-id="currentUserId" />

      <!-- Modals — R158.36 只保留 UserCreateModal. 其他写动作搬右栏
           UserPropertyPanel. -->
      <UserCreateModal
        v-if="modal === 'create'"
        :target-dc="selectedDc"
        @close="modal = null"
        @submitted="onSubmitted('create', $event)"
      />
      <BatchPasswordResetModal
        v-if="modal === 'batchPasswordReset'"
        :sams="Array.from(selectedSams)"
        @close="modal = null"
        @submit="onBatchPasswordResetSubmit"
      />
    </AdminLayout>
  </template>

  <!-- embedded=true: 跳过 AdminLayout, 直接渲染页面内容 (header + toolbar +
       表格 + bulk-bar + banner + drawer + create modal). 跟宿主 (日常管理)
       topbar/content 融为一体, 不重复 sidebar/topbar. -->
  <div v-else class="embedded-host">
    <header class="page-header">
      <div class="page-titles">
        <div class="eyebrow">运维管理 · AD 用户管理</div>
        <h2 class="page-title">AD 用户管理</h2>
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
      <!-- R158.35 — snapshot badge: shows when dataSource='snapshot' AND
           a snapshot row exists. Reuses the same staleness styling as
           EventlogView (fresh≤30s/warn≤120s/red>120s). Operators see
           at-a-glance "the data was synced N min ago" without leaving
           DailyOpsView. -->
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
        <span>登录名过滤 (支持通配符 *)</span>
        <input
          data-test="user-search-filter"
          v-model="filter"
          placeholder="例如 jdoe 或 ad*"
          :disabled="loading || !selectedDc"
          @keyup.enter="runSearch"
        />
      </label>
      <div class="toolbar-actions">
        <button
          class="btn-primary"
          data-test="user-search-button"
          @click="runSearch"
          :disabled="loading || !selectedDc"
        >{{ searching ? '搜索中…' : '查询' }}</button>
        <button
          class="btn-secondary"
          data-test="user-create-button"
          @click="openCreate"
          :disabled="!selectedDc"
        >+ 新建</button>
      </div>
    </section>

    <div v-if="!selectedDc" class="hint-block">请先选择目标 DC</div>
    <div v-else-if="searching && !results.length" class="hint-block">搜索中…</div>
    <div v-else-if="searchError" class="error-banner">{{ searchError }}</div>
    <div v-else-if="!results.length" class="empty-block">暂无搜索结果 · 在右栏 + 新建 → UserCreateModal 创建</div>
    <table v-else class="t">
      <thead>
        <tr>
          <th class="checkbox-col">
            <input
              type="checkbox"
              data-test="user-bulk-master"
              :checked="allSelected"
              :indeterminate.prop="someSelected && !allSelected"
              @change="toggleAll"
            />
          </th>
          <th>sAMAccountName</th>
          <th>显示名称</th>
          <th>启用</th>
          <th>上次登录</th>
          <th>描述</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in results" :key="m.sam" :data-test="`user-row-${m.sam}`"
            :class="['user-row', { active: props.selectedSam === m.sam }]"
            @click="emit('select-user', { dc: selectedDc, sam: m.sam })">
          <td class="checkbox-col" @click.stop>
            <input
              type="checkbox"
              :data-test="`user-bulk-${m.sam}`"
              :checked="selectedSams.has(m.sam)"
              @change="toggleSam(m.sam)"
            />
          </td>
          <td><code class="sam">{{ m.sam }}</code></td>
          <td>{{ m.displayName || '—' }}</td>
          <td>
            <span :class="['status-pill', m.enabled ? 'ok' : 'err']">
              <span class="dot"></span>{{ m.enabled ? '启用' : '禁用' }}
            </span>
          </td>
          <td>{{ m.lastLogon ? fmt(m.lastLogon) : '—' }}</td>
          <td class="desc-cell" :title="m.description">{{ m.description || '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="selectedSams.size > 0" class="bulk-bar" data-test="user-bulk-bar">
      <span class="bulk-count" data-test="user-bulk-count">已选 {{ selectedSams.size }} 个账号</span>
      <div class="bulk-actions">
        <button data-test="user-bulk-enable"   :disabled="!selectedDc || bulkInFlight" @click="bulkConfirm('user_enable')">启用</button>
        <button data-test="user-bulk-disable"  :disabled="!selectedDc || bulkInFlight" @click="bulkConfirm('user_disable')">禁用</button>
        <button data-test="user-bulk-unlock"   :disabled="!selectedDc || bulkInFlight" @click="bulkSend('user_unlock')">解锁</button>
        <button data-test="user-bulk-reset"    :disabled="!selectedDc || bulkInFlight" @click="openBatchPasswordReset">重置密码</button>
        <button data-test="user-bulk-clear"    :disabled="bulkInFlight" @click="clearSelection">取消选择</button>
      </div>
    </div>

    <div v-if="lastBanner" :class="['action-banner', lastBanner.ok ? 'ok' : 'err']">
      {{ lastBanner.text }} <small v-if="lastBanner.commandId">· 命令 #{{ lastBanner.commandId }}</small>
    </div>

    <AdCommandHistoryDrawer :operator-id="currentUserId" />

    <UserCreateModal
      v-if="modal === 'create'"
      :target-dc="selectedDc"
      @close="modal = null"
      @submitted="onSubmitted('create', $event)"
    />
    <BatchPasswordResetModal
      v-if="modal === 'batchPasswordReset'"
      :sams="Array.from(selectedSams)"
      @close="modal = null"
      @submit="onBatchPasswordResetSubmit"
    />
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
import UserCreateModal from '../../components/admin/UserCreateModal.vue';
import BatchPasswordResetModal from '../../components/admin/BatchPasswordResetModal.vue';

const auth = useAuthStore();
const currentUserId = computed(() => auth.user?.id);

// R158.34 (2026-10-02) — props for DailyOpsView embedding. When `:dc-prop`
// is passed (DailyOpsView passes the selected hostname), selectedDc gets
// pre-populated + the DC picker is disabled. `:embedded=true` skips the
// page-header chrome (DailyOpsView already provides its own header + tabs).
//
// R158.35 (2026-10-03) — dataSource='live' (default) keeps the
// agent-mediated user_search path (queueCommand + poll). dataSource=
// 'snapshot' switches to read-only LDAP snapshot (ad_users_snapshot)
// populated by DirectorySyncView's manual/auto triggers; this is what
// DailyOpsView uses so the daily-management surface renders in <2s
// without round-tripping each agent. **Write actions still go through
// ad_admin_commands** regardless of dataSource — they're writes, not
// reads.
//
// R158.36 (2026-10-03) — emit('select-user', { dc, sam }) when a row is
// clicked so DailyOpsView can flip its selection to {kind:'user', dc, sam}
// and render UserPropertyPanel in the right pane. `:selectedSam` makes the
// active row get a highlight class (visual feedback for the right pane).
// R158.40 (2026-10-03) — ouDnProp: OU-scoped drill-down. When set, only
// users whose parent OU matches ouDnProp are returned (snapshot-side
// `ou_dn = ?` filter; Phase A added the parameter to the route). Empty
// = full-DC list (R158.35 behavior). watcher re-runs runSearch on change.
const props = defineProps({
  dcProp: { type: String, default: '' },
  // R158.45.15 fix — domain FQDN, OU 视图下 dc 可能为空.
  domain: { type: String, default: '' },
  embedded: { type: Boolean, default: false },
  dataSource: { type: String, default: 'live' },
  selectedSam: { type: String, default: '' },
  ouDnProp: { type: String, default: '' }
});
const emit = defineEmits(['select-user']);

const dcs = ref([]);
const selectedDc = ref(props.dcProp || '');
const filter = ref('');
const results = ref([]);
const loading = ref(false);
const searching = ref(false);
const error = ref('');
const searchError = ref('');
const lastBanner = ref(null);

const modal = ref(null);

// R158.35 — snapshot metadata (when dataSource='snapshot'). Lets the
// embedded toolbar badge render "📦 YYYY-MM-DD HH:mm 同步数据". Nullable
// when the snapshot is empty / never synced for the selected DC.
const snapshotMeta = ref({ snapshotAt: null, snapshotRunId: null, total: 0 });

// 2026-09-02 R76 — bulk-action selection state. Set keyed by sam; cleared
// on every fresh search (results array changes), and on modal open.
const selectedSams = ref(new Set());
const bulkInFlight = ref(false);

const allSelected = computed(() =>
  results.value.length > 0 && selectedSams.value.size === results.value.length
);
const someSelected = computed(() => selectedSams.value.size > 0);

function toggleSam(sam) {
  // Vue's reactivity doesn't track Set mutations, so swap to a new Set
  // whenever we add or remove. Mirrors the pattern used elsewhere in the
  // R75 views (Map cache with explicit replace).
  const next = new Set(selectedSams.value);
  if (next.has(sam)) next.delete(sam);
  else next.add(sam);
  selectedSams.value = next;
}

function toggleAll() {
  if (allSelected.value) {
    selectedSams.value = new Set();
  } else {
    selectedSams.value = new Set(results.value.map(m => m.sam));
  }
}

function clearSelection() {
  selectedSams.value = new Set();
}

// Reset selection whenever results are replaced (e.g. fresh search).
watch(results, () => {
  selectedSams.value = new Set();
});

// R158.34 — when dc-prop changes from parent (operator clicks a different
// DC in the tree), update selectedDc + re-run search so the embedded view
// stays in sync. No-op when dc-prop is empty (standalone mode).
// R158.35 — re-run also fires when dataSource flips so the badge + table
// re-derive (operator might toggle live ↔ snapshot in a future AdminLayout
// control; for now DailyOpsView is the only caller and it's static).
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

// ── Bulk operations ──────────────────────────────────────────────────────
// Two patterns depending on whether the command is destructive:
//   - bulkSend: fires immediately (enable / unlock are non-destructive)
//   - bulkConfirm: shows confirm() first (disable is destructive — covers
//     R76 §2 ruling about avoiding bulk-mis-click footguns)
// The user_password_reset variant opens BatchPasswordResetModal.
async function bulkSend(commandType) {
  if (!selectedDc.value || selectedSams.value.size === 0) return;
  const sams = Array.from(selectedSams.value);
  bulkInFlight.value = true;
  try {
    const resp = await adAdminApi.queueBatch({
      targetDc: selectedDc.value,
      commandType,
      paramsList: sams.map(sam => ({ sam }))
    });
    const queued = resp.data?.queued?.length ?? 0;
    const errors = resp.data?.errors?.length ?? 0;
    lastBanner.value = {
      ok: errors === 0,
      text: errors === 0
        ? `已批量 ${labelFor(commandType)} ${queued} 个账号`
        : `批量 ${labelFor(commandType)} 部分失败 — 成功 ${queued} / 失败 ${errors}`,
      commandId: null
    };
    if (errors === 0) clearSelection();
  } catch (e) {
    lastBanner.value = {
      ok: false,
      text: `批量 ${labelFor(commandType)} 失败 — ${e?.response?.data?.error || e?.message}`,
      commandId: null
    };
  } finally {
    bulkInFlight.value = false;
    setTimeout(runSearch, 2500);
  }
}

function bulkConfirm(commandType) {
  if (!selectedDc.value || selectedSams.value.size === 0) return;
  const n = selectedSams.value.size;
  const verb = labelFor(commandType);
  const ok = window.confirm(`确认${verb} ${n} 个账号?`);
  if (!ok) return;
  return bulkSend(commandType);
}

function labelFor(commandType) {
  switch (commandType) {
    case 'user_enable': return '启用';
    case 'user_disable': return '禁用';
    case 'user_unlock': return '解锁';
    case 'user_password_reset': return '重置密码';
    default: return commandType;
  }
}

function openBatchPasswordReset() {
  if (selectedSams.value.size === 0) return;
  modal.value = 'batchPasswordReset';
}

async function onBatchPasswordResetSubmit(payload) {
  const { sams, newPassword, mustChangePassword, unlockAccount } = payload;
  bulkInFlight.value = true;
  modal.value = null;
  try {
    const resp = await adAdminApi.queueBatch({
      targetDc: selectedDc.value,
      commandType: 'user_password_reset',
      paramsList: sams.map(sam => ({ sam, newPassword, mustChangePassword, unlockAccount }))
    });
    const queued = resp.data?.queued?.length ?? 0;
    const errors = resp.data?.errors?.length ?? 0;
    lastBanner.value = {
      ok: errors === 0,
      text: errors === 0
        ? `已批量重置密码 ${queued} 个账号`
        : `批量重置密码 部分失败 — 成功 ${queued} / 失败 ${errors}`,
      commandId: null
    };
    if (errors === 0) clearSelection();
  } catch (e) {
    lastBanner.value = {
      ok: false,
      text: `批量重置密码 失败 — ${e?.response?.data?.error || e?.message}`,
      commandId: null
    };
  } finally {
    bulkInFlight.value = false;
    setTimeout(runSearch, 2500);
  }
}

// Shared polling composable for the inline search. The view's runSearch
// calls polling.start() after queueCommand; the watcher below reads
// command.value.result on terminal state.
const polling = useCommandPolling(null, { intervalMs: 1500, timeoutMs: 35_000 });
watch(polling.isTerminal, (terminal) => {
  if (!terminal) return;
  const r = polling.command.value;
  if (!r) return;
  if (r.status === 'success') {
    results.value = r.result?.users || [];
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
    // Flatten to unique DC list (nodes carry sites + DCs in mixed order).
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
  // Cancel any in-flight search before kicking off a new one.
  polling.stop();
  searching.value = true;
  searchError.value = '';
  // R158.35 — snapshot dataSource short-circuits the agent round-trip
  // and reads ad_users_snapshot directly. Keep the same `results`
  // array shape so the table renders identically.
  // R158.45.15 fix (2026-10-05) — OU 视图下 selectedDc 可能为空 (R158.45.10
  // OU 树按域加载, dc 不是必填). 优先用 props.domain 走 listAdUsersByDomain
  // 跳过 hostname→FQDN 转换, 后端 400 'dc or domain required' 不再触发.
  if (props.dataSource === 'snapshot') {
    try {
      let r;
      if (props.domain) {
        r = await adminApi.listAdUsersByDomain({
          domain: props.domain,
          filter: filter.value.trim(),
          limit: 200,
          offset: 0,
          ouDn: props.ouDnProp || ''
        });
      } else {
        r = await adminApi.listAdUsers({
          dc: selectedDc.value,
          filter: filter.value.trim(),
          limit: 200,
          offset: 0,
          ouDn: props.ouDnProp || ''
        });
      }
      results.value = r.data?.users || [];
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
      commandType: 'user_search',
      params: { filter: filter.value.trim(), limit: 50 }
    });
    const id = resp.data?.id;
    if (!id) {
      results.value = [];
      searching.value = false;
      return;
    }
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
  // Defer re-search so the agent's result lands in the table.
  setTimeout(runSearch, 2000);
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—'; }

// R158.35 — snapshot helpers. fmtSnapshotTime uses the same UTC→+8
// formatter as DirectorySyncView's `fmt` so DailyOpsView and the admin
// page agree on the displayed timestamp. snapshotStaleCls piggybacks
// the EventlogView palette: fresh ≤ 30s, warn ≤ 120s, red > 120s.
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

/* R158.35 — snapshot staleness badge. Color follows the EventlogView
   / PartnerPortHealthView palette: green ≤ 30s, yellow ≤ 120s, red
   after that. Empty state shows a neutral grey with a clock emoji so
   operators immediately know "no data yet, go trigger a sync". */
.snapshot-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 3px; font-size: 12px;
  border: 1px solid var(--border); background: var(--input-bg);
}
.snapshot-badge-fresh { color: #22c55e; border-color: rgba(34, 197, 94, 0.4); background: rgba(34, 197, 94, 0.10); }
.snapshot-badge-warn  { color: #f59e0b; border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.10); }
.snapshot-badge-stale { color: #ef4444; border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.10); }
.snapshot-badge-empty { color: var(--muted); }

.t { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.t th, .t td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
.t th { background: var(--input-bg); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
/* R158.45.17 (2026-10-05) — operator "中栏需要滚轮": 表格嵌入 DailyOpsView
   中栏 .list-panel (overflow: hidden + flex) 时, thead sticky 让滚动时列名
   仍可见, ADUC 风格. 父容器需 overflow: auto 才生效. */
.t thead th { position: sticky; top: 0; z-index: 1; }
.t .sam { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--accent); }
.t .desc-cell { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-row { cursor: pointer; }
.user-row:hover { background: var(--row-hover); }
.user-row.active { background: rgba(96, 165, 250, 0.18); }
.user-row.active td { color: var(--accent); }
.row-actions { display: flex; gap: 4px; flex-wrap: wrap; }

.status-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-pill.ok { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--status-pill-fg-ok); }
.status-pill.err { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--status-pill-fg-err); }

/* 2026-09-02 R76 — bulk-action checkboxes + sticky bulk-action bar. */
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
