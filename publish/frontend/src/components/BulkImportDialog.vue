<template>
  <div class="modal-bg" @click.self="close">
    <div class="modal">
      <h3>{{ title }}</h3>

      <p class="hint">
        支持 CSV / Excel (xlsx)。请准备一个文件,首行为表头。可接受以下列名(任一):
        <code v-for="(c, i) in columns" :key="c.key" class="hdr">
          {{ [c.key, ...(c.aliases || [])].join(' / ') }}<span v-if="i < columns.length - 1">、</span>
        </code>
      </p>

      <label class="file-btn">
        <input type="file" accept=".csv,.xlsx" @change="onFile" :disabled="busy" />
        <span v-if="!file">{{ file ? file.name : '选择文件...' }}</span>
        <span v-else>{{ file.name }} ({{ formatBytes(file.size) }})</span>
      </label>

      <div v-if="parseError" class="error">{{ parseError }}</div>

      <div v-if="rows.length" class="preview">
        <div class="preview-head">
          共 <b>{{ rows.length }}</b> 行 — 预览前 {{ Math.min(rows.length, 20) }} 行
          <span v-if="rows.length > 20" class="more">…</span>
        </div>
        <table class="t">
          <thead>
            <tr><th v-for="c in columns" :key="c.key">{{ c.label }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, idx) in previewRows" :key="idx">
              <td v-for="c in columns" :key="c.key">{{ formatCell(r[c.key]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="result" class="result">
        <p v-if="result.imported != null"><b>{{ result.imported }}</b> imported</p>
        <p v-if="result.assigned != null"><b>{{ result.assigned }}</b> assigned<span v-if="result.unassigned"> / {{ result.unassigned }} unassigned</span></p>
        <p v-if="result.skipped"><b>{{ result.skipped }}</b> skipped</p>
        <ul v-if="result.errors && result.errors.length">
          <li v-for="(e, i) in result.errors" :key="i">
            行 {{ e.rowIndex + 1 }}<span v-if="e.siteName || e.dcName"> ({{ e.siteName || e.dcName }})</span>: {{ e.reason }}
          </li>
        </ul>
      </div>

      <div class="actions">
        <button @click="close" :disabled="busy">{{ result ? '关闭' : '取消' }}</button>
        <button v-if="!result" @click="onSubmit" :disabled="!canSubmit">{{ busy ? '处理中...' : `确认导入 ${rows.length || ''}行` }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import Papa from 'papaparse';

const props = defineProps({
  title: { type: String, required: true },
  columns: { type: Array, required: true },
  submit: { type: Function, required: true }
});
const emit = defineEmits(['close', 'done']);

const file = ref(null);
const rows = ref([]);
const parseError = ref('');
const result = ref(null);
const busy = ref(false);

const previewRows = computed(() => rows.value.slice(0, 20));
const canSubmit = computed(() => !!file.value && rows.value.length > 0 && !busy.value);

function close() { emit('close'); }
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
function formatCell(v) {
  if (v === undefined || v === null || v === '') return '-';
  return String(v);
}

function buildAliasMap() {
  const m = new Map();
  for (const c of props.columns) {
    m.set(c.key.toLowerCase(), c.key);
    for (const a of c.aliases || []) m.set(a.toLowerCase(), c.key);
  }
  return m;
}

function normalizeRow(raw, aliasMap) {
  const out = {};
  for (const k of Object.keys(raw)) {
    const target = aliasMap.get(k.trim().toLowerCase());
    if (target) out[target] = raw[k];
  }
  return out;
}

async function onFile(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  file.value = f;
  parseError.value = '';
  result.value = null;
  rows.value = [];
  busy.value = true;
  try {
    const aliasMap = buildAliasMap();
    let parsed = [];
    if (f.name.toLowerCase().endsWith('.csv')) {
      parsed = await parseCsv(f);
    } else if (f.name.toLowerCase().endsWith('.xlsx')) {
      parsed = await parseXlsx(f);
    } else {
      throw new Error('仅支持 .csv / .xlsx 文件');
    }
    rows.value = parsed.map(r => normalizeRow(r, aliasMap));
  } catch (err) {
    parseError.value = err.message || String(err);
  } finally {
    busy.value = false;
    // Reset so the same file can be re-picked
    ev.target.value = '';
  }
}

function parseCsv(f) {
  return new Promise((resolve, reject) => {
    Papa.parse(f, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim(),
      complete: (results) => {
        if (results.errors && results.errors.length) {
          const fatal = results.errors.find(e => e.code !== 'TooFewFields' && e.code !== 'TooManyFields');
          if (fatal) return reject(new Error(`${fatal.message} (行 ${fatal.row})`));
        }
        resolve(results.data || []);
      },
      error: (err) => reject(new Error(err.message || 'CSV 解析失败'))
    });
  });
}

async function parseXlsx(f) {
  const XLSX = await import('xlsx');
  const buf = await f.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('Excel 文件没有 sheet');
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  // Normalize header whitespace
  return json.map(row => {
    const out = {};
    for (const k of Object.keys(row)) out[k.trim()] = row[k];
    return out;
  });
}

async function onSubmit() {
  if (!canSubmit.value) return;
  busy.value = true;
  try {
    const r = await props.submit(rows.value);
    result.value = r || {};
    emit('done', result.value);
  } catch (err) {
    parseError.value = err.response?.data?.error?.message || err.message || String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 600px; max-width: 900px; max-height: 80vh; overflow-y: auto; }
.modal h3 { margin: 0 0 12px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; line-height: 1.6; }
.hint code.hdr { background: #0b1220; padding: 1px 4px; border-radius: 2px; margin-right: 2px; }
.file-btn {
  display: inline-block; padding: 8px 12px; background: var(--accent); color: white;
  border-radius: 4px; cursor: pointer; font-size: 14px; margin-bottom: 12px;
}
.file-btn input[type=file] { display: none; }
.error { color: var(--red); font-size: 13px; margin: 0 0 8px; }
.preview { background: #0b1220; padding: 10px; border-radius: 4px; margin-bottom: 12px; }
.preview-head { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.preview-head .more { color: var(--muted); }
.t { width: 100%; border-collapse: collapse; font-size: 12px; }
.t th, .t td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { color: var(--muted); font-weight: 600; }
.result { background: #0b1220; padding: 10px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; }
.result p { margin: 4px 0; }
.result ul { margin: 6px 0 0; padding-left: 20px; max-height: 200px; overflow-y: auto; }
.result li { font-size: 12px; color: var(--muted); margin: 2px 0; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>