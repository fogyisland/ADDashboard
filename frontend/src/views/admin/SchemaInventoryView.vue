<template>
  <AdminLayout>
    <div class="schema-inventory-view">
      <header class="page-head">
        <h2>Schema 库存与对比</h2>
        <p class="page-summary">
          Center 数据库所有 schemas 的实际表/列布局、pkg_* 包对应的期望定义、以及二者差异。
        </p>
      </header>

      <div class="actions-bar">
        <button class="refresh" @click="load" :disabled="loading">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
        <span class="hint">{{ stats }}</span>
      </div>

      <div v-if="loading && schemas.length === 0" class="loading">加载中...</div>
      <div v-else-if="error" class="error-banner">
        加载失败: {{ error }} <button @click="load">重试</button>
      </div>
      <p v-else-if="schemas.length === 0" class="empty">数据库中暂无 schemas。</p>

      <table v-else class="t">
        <thead>
          <tr>
            <th></th>
            <th>Schema</th>
            <th>来源</th>
            <th>状态</th>
            <th>表数</th>
            <th>差异</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="s in schemas" :key="s.name">
            <tr :class="['schema-row', `status-${s.status}`, { expanded: expanded === s.name }]">
              <td class="expand-cell">
                <button
                  class="expand-btn"
                  :data-test="`expand-${s.name}`"
                  @click="toggle(s.name)"
                  :aria-label="expanded === s.name ? '收起' : '展开'"
                >{{ expanded === s.name ? '▾' : '▸' }}</button>
              </td>
              <td><code class="schema-name">{{ s.name }}</code></td>
              <td class="source-cell">{{ s.source }}</td>
              <td>
                <span :class="['status-badge', `status-${s.status}`]" :data-test="`status-${s.name}`">
                  {{ statusLabel(s.status) }}
                </span>
              </td>
              <td>{{ s.actual.length }}</td>
              <td class="diff-cell">
                <span v-if="s.status === 'in_sync'" class="diff-zero">—</span>
                <span v-else-if="s.status === 'system'" class="diff-zero">—</span>
                <span v-else class="diff-counts">
                  <span v-if="s.diff.missingTables.length" class="diff-missing">
                    缺表 {{ s.diff.missingTables.length }}
                  </span>
                  <span v-if="s.diff.extraTables.length" class="diff-extra">
                    多表 {{ s.diff.extraTables.length }}
                  </span>
                  <span v-if="s.diff.missingColumns.length" class="diff-missing">
                    缺列 {{ s.diff.missingColumns.length }}
                  </span>
                  <span v-if="s.diff.extraColumns.length" class="diff-extra">
                    多列 {{ s.diff.extraColumns.length }}
                  </span>
                  <span v-if="s.diff.typeMismatches.length" class="diff-mismatch">
                    类型不符 {{ s.diff.typeMismatches.length }}
                  </span>
                </span>
              </td>
            </tr>
            <tr v-if="expanded === s.name" class="detail-row">
              <td colspan="6">
                <SchemaInventoryDetail :schema="s" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import SchemaInventoryDetail from './SchemaInventoryDetail.vue';
import { adminApi } from '../../api/admin.js';
import { notifyError } from '../../lib/notify.js';

const schemas = ref([]);
const loading = ref(false);
const error = ref('');
const expanded = ref(null);

const stats = computed(() => {
  if (schemas.value.length === 0) return '';
  const total = schemas.value.length;
  const drift = schemas.value.filter((s) => s.status === 'drift').length;
  const inSync = schemas.value.filter((s) => s.status === 'in_sync').length;
  const system = schemas.value.filter((s) => s.status === 'system').length;
  return `共 ${total} 个 schema — 在同步 ${inSync} · 漂移 ${drift} · 系统 ${system}`;
});

function statusLabel(status) {
  if (status === 'in_sync') return '在同步';
  if (status === 'drift') return '漂移';
  if (status === 'system') return '系统';
  return status;
}

function toggle(name) {
  expanded.value = expanded.value === name ? null : name;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await adminApi.getSchemaInventory();
    schemas.value = r.data?.schemas || [];
  } catch (e) {
    error.value = e?.response?.data?.error || e?.message || '未知错误';
    notifyError(`加载 Schema 库存失败: ${error.value}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.page-head { margin-bottom: 12px; }
.page-head h2 { margin: 0 0 4px; }
.page-summary { margin: 0; color: var(--muted); font-size: 13px; }
.actions-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.refresh {
  padding: 6px 14px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 13px;
}
.refresh:hover:not(:disabled) { background: var(--accent); color: var(--accent-text); }
.refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.hint { color: var(--muted); font-size: 12px; }
.loading, .empty { color: var(--muted); padding: 16px 0; text-align: center; }
.error-banner {
  background: #7f1d1d;
  color: #fee2e2;
  padding: 10px 14px;
  border-radius: 3px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.error-banner button { padding: 4px 10px; background: #0b1220; color: var(--text); border: 1px solid #b91c1c; border-radius: 3px; cursor: pointer; }

.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 8px 10px; border-bottom: 1px solid #1e293b; text-align: left; font-size: 13px; vertical-align: top; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; font-weight: 600; }
.schema-row:hover { background: rgba(255, 255, 255, 0.02); }
.schema-row.expanded { background: rgba(255, 255, 255, 0.04); }
.expand-cell { width: 32px; }
.expand-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.schema-name {
  background: #0b1220;
  padding: 2px 8px;
  border-radius: 2px;
  font-size: 12px;
  color: var(--text);
}
.source-cell { color: var(--muted); font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--border);
}
.status-in_sync { background: #052e16; color: #4ade80; border-color: #166534; }
.status-drift { background: #7f1d1d; color: #fca5a5; border-color: #b91c1c; }
.status-system { background: #0b1220; color: var(--muted); }

.diff-cell { font-size: 12px; }
.diff-zero { color: var(--muted); }
.diff-counts { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.diff-missing { color: #fca5a5; }
.diff-extra { color: #facc15; }
.diff-mismatch { color: #fb923c; }

.detail-row td { background: #0b1220; padding: 0; }

/* Row-level color cues mirror the badge so the operator can scan a long list. */
.status-in_sync td { border-left: 3px solid #4ade80; }
.status-drift td { border-left: 3px solid #fca5a5; }
.status-system td { border-left: 3px solid var(--muted); }
</style>
