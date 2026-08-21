<template>
  <AdminLayout>
    <div class="schema-inventory-view">
      <header class="page-head">
        <h2>Schema 库存与对比</h2>
        <p class="page-summary">
          扫描 center 代码实际引用的 SQL 表,逐表比对期望形状(来自迁移 CREATE TABLE + 包 manifest)与 DB 实际形状,列出缺失/多余/类型不符的列。
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
      <p v-else-if="schemas.length === 0" class="empty">
        扫描完成 — 代码中没有引用任何 SQL 表,无需对比。
      </p>

      <div v-else class="schema-list">
        <section v-for="sc in schemas" :key="sc.name" class="schema-section">
          <header class="schema-head">
            <code class="schema-name">{{ sc.name }}</code>
            <span class="schema-summary">
              {{ sc.tables.length }} 张表 —
              在同步 {{ countByStatus(sc, 'in_sync') }} ·
              漂移 {{ countByStatus(sc, 'drift') }} ·
              DB 缺失 {{ countByStatus(sc, 'missing_in_db') }}
            </span>
          </header>

          <table class="t">
            <thead>
              <tr>
                <th></th>
                <th>表</th>
                <th>来源</th>
                <th>状态</th>
                <th>引用处</th>
                <th>期望 / 实际</th>
                <th>差异</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="t in sc.tables" :key="t.name">
                <tr :class="['table-row', `status-${t.status}`, { expanded: expanded === t.schema + '.' + t.name }]">
                  <td class="expand-cell">
                    <button
                      class="expand-btn"
                      :data-test="`expand-${t.schema}.${t.name}`"
                      @click="toggle(t.schema + '.' + t.name)"
                      :aria-label="isExpanded(t.schema + '.' + t.name) ? '收起' : '展开'"
                    >{{ isExpanded(t.schema + '.' + t.name) ? '▾' : '▸' }}</button>
                  </td>
                  <td><code class="table-name">{{ t.name }}</code></td>
                  <td>
                    <span :class="['source-badge', `source-${t.source}`]">
                      {{ t.source === 'package' ? '包 manifest' : '代码 + 迁移' }}
                    </span>
                  </td>
                  <td>
                    <span :class="['status-badge', `status-${t.status}`]">
                      {{ statusLabel(t.status) }}
                    </span>
                  </td>
                  <td class="refs-cell">
                    <span v-if="t.codeRefs && t.codeRefs.length" class="ref-count">
                      {{ t.codeRefs.length }} 处
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="shape-cell">
                    <span class="shape-expected">
                      期望 {{ t.expected ? t.expected.length : '—' }}
                    </span>
                    <span class="shape-actual">
                      实际 {{ t.actual ? t.actual.length : '—' }}
                    </span>
                  </td>
                  <td class="diff-cell">
                    <span v-if="t.status === 'in_sync'" class="diff-zero">—</span>
                    <span v-else-if="t.status === 'missing_in_db'" class="diff-missing">
                      DB 缺失
                    </span>
                    <span v-else-if="t.diff" class="diff-counts">
                      <span v-if="t.diff.missingColumns.length" class="diff-missing">
                        缺列 {{ t.diff.missingColumns.length }}
                      </span>
                      <span v-if="t.diff.extraColumns.length" class="diff-extra">
                        多列 {{ t.diff.extraColumns.length }}
                      </span>
                      <span v-if="t.diff.typeMismatches.length" class="diff-mismatch">
                        类型不符 {{ t.diff.typeMismatches.length }}
                      </span>
                    </span>
                  </td>
                </tr>
                <tr v-if="isExpanded(t.schema + '.' + t.name)" class="detail-row">
                  <td colspan="7">
                    <SchemaInventoryDetail :table="t" />
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>
      </div>
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
const expanded = ref(new Set());

const stats = computed(() => {
  const allTables = schemas.value.flatMap((s) => s.tables);
  if (allTables.length === 0) return '';
  const inSync = allTables.filter((t) => t.status === 'in_sync').length;
  const drift = allTables.filter((t) => t.status === 'drift').length;
  const missing = allTables.filter((t) => t.status === 'missing_in_db').length;
  return `共 ${allTables.length} 张被代码引用的表 — 在同步 ${inSync} · 漂移 ${drift} · DB 缺失 ${missing}`;
});

function statusLabel(status) {
  if (status === 'in_sync') return '在同步';
  if (status === 'drift') return '漂移';
  if (status === 'missing_in_db') return 'DB 缺失';
  return status;
}

function countByStatus(sc, status) {
  return sc.tables.filter((t) => t.status === status).length;
}

function isExpanded(key) {
  return expanded.value.has(key);
}

function toggle(key) {
  if (expanded.value.has(key)) expanded.value.delete(key);
  else expanded.value.add(key);
  expanded.value = new Set(expanded.value);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await adminApi.getSchemaInventory();
    schemas.value = r.data?.schemas || [];
    // Default: every row expanded so the operator sees column shape up front.
    const keys = [];
    for (const sc of schemas.value) {
      for (const t of sc.tables) keys.push(`${sc.name}.${t.name}`);
    }
    expanded.value = new Set(keys);
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

.schema-list { display: flex; flex-direction: column; gap: 16px; }
.schema-section { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 12px; }
.schema-head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.schema-name {
  background: #0b1220;
  padding: 2px 8px;
  border-radius: 2px;
  font-size: 13px;
  color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.schema-summary { color: var(--muted); font-size: 12px; }

.t { width: 100%; border-collapse: collapse; }
.t th, .t td { padding: 6px 8px; border-bottom: 1px solid #1e293b; text-align: left; font-size: 12px; vertical-align: top; }
.t th { background: #0b1220; color: var(--muted); font-size: 11px; font-weight: 600; }
.table-row:hover { background: rgba(255, 255, 255, 0.02); }
.expand-cell { width: 28px; }
.expand-btn {
  width: 22px; height: 22px; padding: 0;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
}
.table-name {
  background: #0b1220;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 11px;
  color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.source-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 10px;
  border: 1px solid var(--border);
}
.source-code { background: #1e293b; color: #93c5fd; }
.source-package { background: #1e293b; color: #c4b5fd; }

.status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid var(--border);
}
.status-in_sync { background: #052e16; color: #4ade80; border-color: #166534; }
.status-drift { background: #7f1d1d; color: #fca5a5; border-color: #b91c1c; }
.status-missing_in_db { background: #7f1d1d; color: #fde68a; border-color: #b45309; }

.refs-cell { font-size: 11px; color: var(--muted); }
.ref-count { color: var(--text); }

.shape-cell { display: flex; gap: 8px; font-size: 11px; }
.shape-expected { color: #93c5fd; }
.shape-actual { color: #4ade80; }

.diff-cell { font-size: 11px; }
.diff-zero { color: var(--muted); }
.diff-counts { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.diff-missing { color: #fca5a5; }
.diff-extra { color: #facc15; }
.diff-mismatch { color: #fb923c; }

.detail-row td { background: #0b1220; padding: 0; }

/* Row-level color cues mirror the badge so the operator can scan a long list. */
.status-in_sync td { border-left: 3px solid #4ade80; }
.status-drift td { border-left: 3px solid #fca5a5; }
.status-missing_in_db td { border-left: 3px solid #fde68a; }
</style>