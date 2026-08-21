<template>
  <div class="schema-detail">
    <!-- System schemas: no expected, just dump the actual tables. -->
    <template v-if="schema.source === 'system'">
      <div class="detail-section">
        <div class="detail-head">实际表 ({{ schema.actual.length }})</div>
        <div v-if="schema.actual.length === 0" class="empty">空 schema。</div>
        <table v-else class="t-inner">
          <thead>
            <tr><th>表</th><th>列数</th><th>列</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in schema.actual" :key="t.name">
              <td><code>{{ t.name }}</code></td>
              <td>{{ t.columns.length }}</td>
              <td class="col-list">
                <span v-for="c in t.columns" :key="c.name" class="col-chip">
                  {{ c.name }}<span class="col-type">{{ c.type }}</span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Package schemas: show expected vs actual side by side per table. -->
    <template v-else>
      <div class="detail-section">
        <div class="detail-head">
          来源: <code>{{ schema.source }}</code>
        </div>
      </div>

      <!-- Diff summary (only when there's drift). -->
      <div v-if="schema.diff" class="diff-summary" data-test="diff-summary">
        <div v-if="schema.diff.missingTables.length" class="diff-block diff-missing">
          <div class="diff-block-head">缺表 ({{ schema.diff.missingTables.length }})</div>
          <ul>
            <li v-for="t in schema.diff.missingTables" :key="t.name">
              <code>{{ t.name }}</code>
              <span v-if="t.columns.length" class="muted">
                — 期望列: {{ t.columns.join(', ') }}
              </span>
            </li>
          </ul>
        </div>
        <div v-if="schema.diff.extraTables.length" class="diff-block diff-extra">
          <div class="diff-block-head">多表 ({{ schema.diff.extraTables.length }})</div>
          <ul>
            <li v-for="t in schema.diff.extraTables" :key="t">
              <code>{{ t }}</code>
            </li>
          </ul>
        </div>
        <div v-if="schema.diff.missingColumns.length" class="diff-block diff-missing">
          <div class="diff-block-head">缺列 ({{ schema.diff.missingColumns.length }})</div>
          <ul>
            <li v-for="c in schema.diff.missingColumns" :key="`${c.table}.${c.name}`">
              <code>{{ c.table }}.{{ c.name }}</code>
              <span class="muted">期望: {{ c.expectedType }}</span>
            </li>
          </ul>
        </div>
        <div v-if="schema.diff.extraColumns.length" class="diff-block diff-extra">
          <div class="diff-block-head">多列 ({{ schema.diff.extraColumns.length }})</div>
          <ul>
            <li v-for="c in schema.diff.extraColumns" :key="`${c.table}.${c.name}`">
              <code>{{ c.table }}.{{ c.name }}</code>
              <span class="muted">实际: {{ c.actualType }}</span>
            </li>
          </ul>
        </div>
        <div v-if="schema.diff.typeMismatches.length" class="diff-block diff-mismatch">
          <div class="diff-block-head">类型不符 ({{ schema.diff.typeMismatches.length }})</div>
          <ul>
            <li v-for="c in schema.diff.typeMismatches" :key="`${c.table}.${c.name}`">
              <code>{{ c.table }}.{{ c.name }}</code>
              <span class="muted">期望: {{ c.expectedType }} / 实际: {{ c.actualType }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- Per-table layout: every actual table + matching expected. -->
      <div class="detail-section">
        <div class="detail-head">逐表对比</div>
        <table class="t-inner">
          <thead>
            <tr>
              <th>表</th>
              <th>期望列</th>
              <th>实际列</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="t in schema.actual"
              :key="t.name"
              :data-test="`row-${t.name}`"
            >
              <td><code>{{ t.name }}</code></td>
              <td>
                <span
                  v-for="c in expectedColsFor(t.name)"
                  :key="c.name"
                  class="col-chip"
                >{{ c.name }}<span class="col-type">{{ c.type }}</span></span>
                <span v-if="expectedColsFor(t.name).length === 0" class="muted">—</span>
              </td>
              <td>
                <span
                  v-for="c in t.columns"
                  :key="c.name"
                  :class="['col-chip', colChipClass(t.name, c.name, c.type)]"
                >{{ c.name }}<span class="col-type">{{ c.type }}</span></span>
              </td>
            </tr>
            <tr
              v-for="et in missingExpectedTables"
              :key="`missing-${et.name}`"
              class="row-missing"
            >
              <td><code>{{ et.name }}</code> <span class="muted">(缺)</span></td>
              <td>
                <span v-for="c in et.columns" :key="c.name" class="col-chip">
                  {{ c.name }}<span class="col-type">{{ c.type }}</span>
                </span>
              </td>
              <td class="muted">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  schema: { type: Object, required: true }
});

const expectedByTable = computed(() => {
  const map = new Map();
  for (const t of props.schema.expected || []) map.set(t.name, t);
  return map;
});

function expectedColsFor(tableName) {
  return expectedByTable.value.get(tableName)?.columns || [];
}

function colChipClass(tableName, colName, actualType) {
  const expected = expectedColsFor(tableName).find((c) => c.name === colName);
  if (!expected) return 'col-extra';
  if (expected.type !== actualType) return 'col-mismatch';
  return '';
}

const missingExpectedTables = computed(() => {
  if (props.schema.status === 'system') return [];
  return (props.schema.expected || []).filter((t) => {
    return !props.schema.actual.some((a) => a.name === t.name);
  });
});
</script>

<style scoped>
.schema-detail { padding: 12px 16px; }
.detail-section { margin-bottom: 16px; }
.detail-head {
  font-size: 12px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}
.detail-head code {
  background: #0b1220;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 11px;
  color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.empty { color: var(--muted); padding: 8px 0; font-size: 12px; }
.t-inner { width: 100%; border-collapse: collapse; font-size: 12px; }
.t-inner th, .t-inner td {
  padding: 6px 8px;
  border-bottom: 1px solid #1e293b;
  text-align: left;
  vertical-align: top;
}
.t-inner th { background: #0b1220; color: var(--muted); font-weight: 600; font-size: 11px; }
.t-inner code {
  background: #1e293b;
  padding: 1px 6px;
  border-radius: 2px;
  font-size: 11px;
  color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.col-list { display: flex; flex-wrap: wrap; gap: 4px; }
.col-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  background: #1e293b;
  padding: 2px 6px;
  border-radius: 2px;
  font-size: 11px;
  color: var(--text);
  border: 1px solid transparent;
}
.col-chip .col-type { color: var(--muted); font-size: 10px; font-family: ui-monospace, Menlo, Consolas, monospace; }
.col-extra { border-color: #facc15; }
.col-mismatch { border-color: #fb923c; }
.row-missing td { color: #fca5a5; }

.diff-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.diff-block {
  background: #1e293b;
  padding: 8px 12px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.diff-block-head { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.diff-missing .diff-block-head { color: #fca5a5; }
.diff-extra .diff-block-head { color: #facc15; }
.diff-mismatch .diff-block-head { color: #fb923c; }
.diff-block ul { margin: 0; padding: 0 0 0 16px; font-size: 11px; }
.diff-block li { margin-bottom: 2px; }
.diff-block code {
  background: #0b1220;
  padding: 1px 4px;
  border-radius: 2px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.muted { color: var(--muted); font-size: 11px; }
</style>