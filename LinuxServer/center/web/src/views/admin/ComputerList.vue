<!--
  R158.45.15 (2026-10-05) — ComputerList.vue
  OU-scoped 电脑列表 (轻量组件). 跟 UserManagementView / GroupManagementView
  不同的复杂度: 电脑列表不需要 bulk action / create modal / search high-level;
  只需要: 头部 (snapshot badge + filter) + 表格 + 分页器 + 行 click emit.

  Props:
    dcProp      — 当前 DC hostname
    ouDnProp    — 当前 OU DN (父 DailyOpsView selection.dn 透传)
    dataSource  — 'snapshot' | 'live' (DailyOpsView 总是 'snapshot' 模式)

  Emits:
    select-computer({ dc, sam }) — 行 click → 父切 selection.computer

  R158.45.16 (2026-10-05) — operator "电脑按页分数据, 一页 100 个, 提供滚轮效果":
  改: 加分页 (PAGE_SIZE=100), 上一页/下一页按钮 + 页码跳转. OU/DC/filter 任一
  变化 → 重置到 page=0. OU 树 virtual-leaf 一次最多约 3865 台 (单 OU), 100/页
  ≈ 39 页, 走按钮分页清晰.

  OU 切换自动 reload: watch ouDnProp + dcProp + filter 三元组变化触发 fetch.
  Vue watch 默认 lazy, 用 { immediate: true } 让首次挂载就拉 (R158.45.15 lesson
  — UserManagementView 没 immediate, 默认 tab 改成 users 会首次进 OU 空).

  持久 lesson (R158.37.3): 整文件 Write, 纯 UTF-8 无 BOM.
-->
<template>
  <div class="computer-list">
    <header class="cl-toolbar">
      <span
        v-if="snapshotMeta.snapshotAt"
        class="cl-badge"
        :title="`同步运行 #${snapshotMeta.snapshotRunId} · 共 ${snapshotMeta.total} 条`"
      >📦 {{ fmtTime(snapshotMeta.snapshotAt) }} 同步数据 ({{ snapshotMeta.total }} 条)</span>
      <span v-else class="cl-badge-empty">⓳ 暂无同步数据</span>
      <input
        v-model="filter"
        class="cl-filter"
        data-test="computer-search-filter"
        placeholder="过滤 (登录名 / 计算机名 / 描述)"
      />
      <span v-if="loading" class="cl-loading">⏳ 加载中…</span>
    </header>

    <div v-if="!results.length && !loading" class="empty-hint">该 OU 下没有电脑</div>
    <table v-else class="cl-table">
      <thead>
        <tr>
          <th>sAMAccountName</th>
          <th>CN</th>
          <th>OS</th>
          <th>启用</th>
          <th>Server</th>
          <th>最近登录</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="c in results"
          :key="c.samAccountName"
          :class="['cl-row', { active: props.selectedSam === c.samAccountName }]"
          :data-test="`computer-row-${c.samAccountName}`"
          @click="emit('select-computer', { dc: props.dcProp, sam: c.samAccountName })"
        >
          <td class="cl-sam">{{ c.samAccountName }}</td>
          <td>{{ c.cn }}</td>
          <td class="cl-os">{{ c.operatingSystem }}</td>
          <td>{{ c.enabled === null ? '—' : c.enabled ? '✅' : '❌' }}</td>
          <td>{{ c.isServer ? '🖥️' : '💻' }}</td>
          <td class="cl-fmt">{{ fmtTime(c.lastLogon) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- R158.45.16 (2026-10-05) — 上一页/下一页 分页器. 一页 100 条.
         totalPages 用 Math.max(1, ...) 避免 0 页时按钮全部 disabled 后无法
         恢复 (例如切换 OU 时新 OU 有数据但 total 还在旧值). -->
    <footer v-if="snapshotMeta.total > 0" class="cl-pager">
      <button
        class="pager-btn"
        data-test="computer-pager-prev"
        :disabled="page === 0 || loading"
        @click="page = Math.max(0, page - 1)"
      >‹ 上一页</button>
      <span class="pager-info">
        第 <strong>{{ page + 1 }}</strong> / {{ totalPages }} 页 ·
        显示 {{ rangeStart }}–{{ rangeEnd }} 共 {{ snapshotMeta.total }}
      </span>
      <button
        class="pager-btn"
        data-test="computer-pager-next"
        :disabled="page >= totalPages - 1 || loading"
        @click="page = Math.min(totalPages - 1, page + 1)"
      >下一页 ›</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { adminApi } from '../../api/admin.js';

const PAGE_SIZE = 100; // R158.45.16 (2026-10-05) — operator "一页 100 个".

const props = defineProps({
  dcProp: { type: String, default: '' },
  // R158.45.15 fix — domain FQDN, 优先于 dcProp (OU 视图下 dc 可能为空).
  domain: { type: String, default: '' },
  ouDnProp: { type: String, default: '' },
  dataSource: { type: String, default: 'snapshot' },
  selectedSam: { type: String, default: '' }
});
const emit = defineEmits(['select-computer']);

const filter = ref('');
const results = ref([]);
const snapshotMeta = ref({ snapshotAt: null, snapshotRunId: null, total: 0 });
const loading = ref(false);

// R158.45.16 — 分页状态. OU / DC / filter 变化 → 重置到 page=0.
const page = ref(0);

const totalPages = computed(() => Math.max(1, Math.ceil(snapshotMeta.value.total / PAGE_SIZE)));
const rangeStart = computed(() => snapshotMeta.value.total === 0 ? 0 : page.value * PAGE_SIZE + 1);
const rangeEnd = computed(() => Math.min((page.value + 1) * PAGE_SIZE, snapshotMeta.value.total));

// R158.45.16 — OU / DC / filter 任一变化触发 fetch. page 单独 watch.
async function fetchComputers() {
  if (props.dataSource !== 'snapshot') {
    results.value = [];
    return;
  }
  // R158.45.15 fix — operator "电脑没有列出来" (2026-10-05):
  //   OU 视图下 selection.dc 可能为空 (R158.45.10 OU 树按域加载, operator
  //   只选森林和域不选 site/dc). 走 listAdComputers({ dc: '' }) 后端 400.
  //   改用 listAdComputersByDomain({ domain, ouDn }), 跟 OU 树下 view 由
  //   loadOuTree 拉数据走同一路径, 跳过 hostname→FQDN 转换.
  if (!props.dcProp && !props.domain) {
    results.value = [];
    return;
  }
  loading.value = true;
  try {
    let r;
    const offset = page.value * PAGE_SIZE;
    if (props.domain) {
      r = await adminApi.listAdComputersByDomain({
        domain: props.domain,
        filter: filter.value.trim(),
        ouDn: props.ouDnProp || '',
        limit: PAGE_SIZE,
        offset
      });
    } else {
      r = await adminApi.listAdComputers({
        dc: props.dcProp,
        filter: filter.value.trim(),
        ouDn: props.ouDnProp || '',
        limit: PAGE_SIZE,
        offset
      });
    }
    results.value = r.data?.computers || [];
    snapshotMeta.value = {
      snapshotAt: r.data?.snapshotAt || null,
      snapshotRunId: r.data?.snapshotRunId || null,
      total: Number(r.data?.total || 0)
    };
  } catch {
    results.value = [];
    snapshotMeta.value = { snapshotAt: null, snapshotRunId: null, total: 0 };
  } finally {
    loading.value = false;
  }
}

// R158.45.16 — OU/DC/filter 变化 → page 重置 0 (新查询从头开始).
watch(
  () => [props.ouDnProp, props.dcProp, props.domain, filter.value],
  () => { page.value = 0; },
  { immediate: false }
);
// page 变化或 scope 变化 → fetch.
watch(
  () => [page.value, props.ouDnProp, props.dcProp, props.domain, filter.value],
  () => { fetchComputers(); },
  { immediate: true }
);

function fmtTime(s) {
  if (!s) return '—';
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
</script>

<style scoped>
.computer-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.cl-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.cl-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 3px;
}
.cl-badge-empty {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--input-bg);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 3px;
}
.cl-filter {
  flex: 1 1 auto;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
}
.cl-filter:focus { outline: none; border-color: #3b82f6; }
.cl-loading {
  font-size: 11px;
  color: var(--muted);
}
.cl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.cl-table th {
  text-align: left;
  padding: 6px 8px;
  background: var(--input-bg);
  color: var(--muted);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* R158.45.17 (2026-10-05) — ADUC 风格 sticky 表头. */
.cl-table thead th { position: sticky; top: 0; z-index: 1; }
.cl-row {
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.12s ease;
}
.cl-row:hover { background: rgba(96, 165, 250, 0.08); }
.cl-row.active {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
  font-weight: 600;
}
.cl-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.cl-sam {
  font-family: monospace;
  font-size: 11px;
  color: #f59e0b;
}
.cl-os {
  font-size: 11px;
  color: var(--muted);
}
.cl-fmt {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.empty-hint {
  padding: 14px;
  color: var(--muted);
  font-size: 12px;
}
/* R158.45.16 (2026-10-05) — 上一页/下一页 分页器. 跟整体配色协调. */
.cl-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--border);
}
.pager-btn {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--input-bg);
  color: var(--text);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.pager-btn:hover:not(:disabled) {
  background: rgba(96, 165, 250, 0.1);
  color: #60a5fa;
  border-color: #3b82f6;
}
.pager-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pager-info {
  font-size: 11px;
  color: var(--muted);
}
.pager-info strong {
  color: var(--text);
  font-weight: 600;
}
</style>
