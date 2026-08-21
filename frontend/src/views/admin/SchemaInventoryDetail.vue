<template>
  <div class="table-detail">
    <!-- Code references: where in center code this table is used. -->
    <div v-if="table.codeRefs && table.codeRefs.length" class="detail-section">
      <div class="detail-head">
        代码引用处 ({{ table.codeRefs.length }})
      </div>
      <ul class="ref-list">
        <li v-for="r in table.codeRefs.slice(0, 12)" :key="r">
          <code>{{ r }}</code>
        </li>
        <li v-if="table.codeRefs.length > 12" class="muted">
          ...另 {{ table.codeRefs.length - 12 }} 处
        </li>
      </ul>
    </div>

    <!-- Diff summary: only when there's drift. -->
    <div v-if="table.diff && hasDrift(table.diff)" class="diff-summary" data-test="diff-summary">
      <div v-if="table.diff.missingColumns.length" class="diff-block diff-missing">
        <div class="diff-block-head">缺列 ({{ table.diff.missingColumns.length }})</div>
        <ul>
          <li v-for="c in table.diff.missingColumns" :key="c.name">
            <code>{{ c.name }}</code>
            <span class="muted">期望: {{ c.expectedType }}</span>
          </li>
        </ul>
      </div>
      <div v-if="table.diff.extraColumns.length" class="diff-block diff-extra">
        <div class="diff-block-head">多列 ({{ table.diff.extraColumns.length }})</div>
        <ul>
          <li v-for="c in table.diff.extraColumns" :key="c.name">
            <code>{{ c.name }}</code>
            <span class="muted">实际: {{ c.actualType }}</span>
          </li>
        </ul>
      </div>
      <div v-if="table.diff.typeMismatches.length" class="diff-block diff-mismatch">
        <div class="diff-block-head">类型不符 ({{ table.diff.typeMismatches.length }})</div>
        <ul>
          <li v-for="c in table.diff.typeMismatches" :key="c.name">
            <code>{{ c.name }}</code>
            <span class="muted">
              期望 {{ c.expectedType }} / 实际 {{ c.actualType }}
            </span>
          </li>
        </ul>
      </div>
    </div>

    <!-- Missing in DB warning. -->
    <div v-if="table.status === 'missing_in_db'" class="missing-banner" data-test="missing-banner">
      数据库中没有这个表 — 代码期望 <code>{{ table.schema }}.{{ table.name }}</code>
      但 <code>information_schema.TABLES</code> 找不到。运行迁移或修复 SQL 后再刷新。
    </div>

    <!-- Side-by-side expected / actual columns. -->
    <div class="detail-section">
      <div class="detail-head">逐列对比</div>
      <table class="t-inner" data-test="cols-table">
        <thead>
          <tr>
            <th>列</th>
            <th>期望类型</th>
            <th>实际类型</th>
            <th>差异</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!table.expected && !table.actual.length">
            <td colspan="4" class="muted">无期望定义,DB 中也没有列。</td>
          </tr>
          <tr v-for="c in mergedColumns" :key="c.name" :class="rowClass(c)">
            <td><code>{{ c.name }}</code></td>
            <td>{{ c.expectedType || '—' }}</td>
            <td>{{ c.actualType || '—' }}</td>
            <td>
              <span v-if="c.kind === 'missing'" class="diff-missing">缺</span>
              <span v-else-if="c.kind === 'extra'" class="diff-extra">多</span>
              <span v-else-if="c.kind === 'mismatch'" class="diff-mismatch">类型不符</span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  table: { type: Object, required: true }
});

function hasDrift(diff) {
  return diff.missingColumns.length || diff.extraColumns.length || diff.typeMismatches.length;
}

const mergedColumns = computed(() => {
  const expected = props.table.expected || [];
  const actual = props.table.actual || [];
  const allNames = new Set();
  for (const c of expected) allNames.add(c.name);
  for (const c of actual) allNames.add(c.name);
  const out = [];
  for (const name of allNames) {
    const e = expected.find((x) => x.name === name);
    const a = actual.find((x) => x.name === name);
    let kind = 'match';
    if (!a) kind = 'missing';
    else if (!e) kind = 'extra';
    else if (!typesMatch(e.type, a.type)) kind = 'mismatch';
    out.push({
      name,
      expectedType: e?.type || null,
      actualType: a?.type || null,
      kind
    });
  }
  // Sort: drift rows first, then alphabetical.
  out.sort((x, y) => {
    if (x.kind === 'match' && y.kind !== 'match') return 1;
    if (x.kind !== 'match' && y.kind === 'match') return -1;
    return x.name.localeCompare(y.name);
  });
  return out;
});

function typesMatch(expected, actual) {
  if (!expected) return true;
  const e = String(expected).toLowerCase().replace(/\s*\(.*?\)\s*/g, '');
  const a = String(actual).toLowerCase().replace(/\s*\(.*?\)\s*/g, '');
  if (e === 'json') return ['json', 'nvarchar', 'varchar', 'text', 'longtext', 'ntext', 'char'].includes(a);
  if (e === 'varchar' && a === 'nvarchar') return true;
  if (e === 'nvarchar' && a === 'varchar') return true;
  return actual === expected;
}

function rowClass(c) {
  if (c.kind === 'missing') return 'row-missing';
  if (c.kind === 'extra') return 'row-extra';
  if (c.kind === 'mismatch') return 'row-mismatch';
  return '';
}
</script>

<style scoped>
.table-detail { padding: 12px 16px; }
.detail-section { margin-bottom: 16px; }
.detail-head {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.ref-list {
  margin: 0;
  padding: 0 0 0 16px;
  font-size: 11px;
  color: var(--text);
  max-height: 140px;
  overflow: auto;
}
.ref-list code {
  background: #0b1220;
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 10px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.missing-banner {
  background: #7f1d1d;
  color: #fde68a;
  padding: 8px 12px;
  border-radius: 3px;
  margin-bottom: 12px;
  font-size: 12px;
}
.missing-banner code {
  background: #0b1220;
  padding: 1px 4px;
  border-radius: 2px;
}

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
.diff-block-head { font-size: 11px; font-weight: 600; margin-bottom: 6px; }
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

.t-inner { width: 100%; border-collapse: collapse; font-size: 11px; }
.t-inner th, .t-inner td {
  padding: 4px 6px;
  border-bottom: 1px solid #1e293b;
  text-align: left;
  vertical-align: top;
}
.t-inner th { background: #0b1220; color: var(--muted); font-weight: 600; font-size: 10px; }
.t-inner code {
  background: #1e293b;
  padding: 1px 4px;
  border-radius: 2px;
  font-size: 10px;
  color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.row-missing td { color: #fca5a5; }
.row-extra td { color: #facc15; }
.row-mismatch td { color: #fb923c; }

.diff-missing { color: #fca5a5; }
.diff-extra { color: #facc15; }
.diff-mismatch { color: #fb923c; }
</style>