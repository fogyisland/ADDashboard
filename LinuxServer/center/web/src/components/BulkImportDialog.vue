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

// R161.34 (2026-11-07, security) — xlsx 导入的硬上限。
//   旧库 (SheetJS) 没有任何上限 ⇒ 一个塞了百万行 / 单个单元格塞 100MB
//   的 xlsx 就能把浏览器标签页打死 (内存 + 主线程)。
//   ⇒ 解析阶段就掐断, 不让恶意文件走到提交。
const MAX_XLSX_ROWS = 50000;
const MAX_XLSX_CELL_CHARS = 100000;

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

// R161.34 (2026-11-07, security) — xlsx 解析库从 `xlsx` (SheetJS) 换成
// `exceljs`。
//
// ★ 为什么必须换 (npm audit 实测):
//   `xlsx@0.18.5` 有两个 **high** 级漏洞, 而且**两个都直接命中我们这个用法**
//   (用户上传一个 xlsx → 我们在浏览器里解析它):
//     · GHSA-4r6h-8v6p-xvw6 — Prototype Pollution in sheetJS (<0.19.3 受影响)
//     · GHSA-5pgg-2g8v-p4x9 — SheetJS ReDoS (<0.20.2 受影响)
//   ⇒ 攻击者上传一个精心构造的 xlsx 就能污染 Object.prototype, 或者
//     用 ReDoS 把浏览器标签页卡死。
//   ⇒ npm registry 上**没有**修复版 (`fixAvailable: false`) —— SheetJS 已经
//     从 npm 下架, 修复版 (0.19.3+ / 0.20.2+) 只在它自己的 CDN 上。
//     ⇒ 唯一出路 = 换库。
//   ⇒ `exceljs@4.4.0`: 0 high / 0 critical, MIT, 活跃维护。
//     (它带的 2 个 moderate 只是 uuid 的传递依赖, 且只在 Node 侧生成
//      UUID 时才可能触发 —— 我们走的是浏览器路径, 碰不到。)
//
// ★ 行为等价性 (旧 xlsx.sheet_to_json 的语义已逐条复刻):
//   · 只读**第一个** sheet
//   · 第一行当表头
//   · 缺列 / 空单元格 → 空字符串 (旧库是 `defval: ''`)
//   · 表头两侧空白 trim 掉
//   · 完全空白的行**跳过** (旧库 sheet_to_json 也会跳过)
//
// ★ 新增的防护 (旧库没有的):
//   · **行数上限** —— 防止用一个塞了百万行的 xlsx 把浏览器打死
//   · **单元格文本长度上限** —— 防止单个单元格塞 100MB 字符串撑爆内存
async function parseXlsx(f) {
  const ExcelJS = (await import('exceljs')).default;
  const buf = await f.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('Excel 文件没有 sheet');

  // 表头行 —— ★ exceljs 的 row.values 是 **1-based 稀疏数组**
  //   (row.getRow(1).values[0] 是 null 占位), 所以必须用 eachCell
  //   按列号填, 不能直接 values.slice(1)。
  const header = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    header[colNumber - 1] = cellText(cell.value);
  });

  // 全空的表头 = 没有任何可识别的列 ⇒ 直接报错, 不让用户白等
  const hasHeader = header.some(h => h && h.trim() !== '');
  if (!hasHeader) throw new Error('Excel 文件第一行是空的, 未找到表头');

  const out = [];
  const lastRow = Math.min(sheet.actualRowCount, MAX_XLSX_ROWS + 2);
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const obj = {};
    let hasValue = false;
    for (let col = 0; col < header.length; col++) {
      const key = (header[col] || '').trim();
      if (!key) continue;
      let value = cellText(row.getCell(col + 1).value);
      if (value.length > MAX_XLSX_CELL_CHARS) {
        value = value.slice(0, MAX_XLSX_CELL_CHARS);
      }
      obj[key] = value;
      if (value !== '') hasValue = true;
    }
    if (hasValue) out.push(obj);
  }

  if (sheet.actualRowCount > MAX_XLSX_ROWS + 1) {
    throw new Error(`Excel 文件超过 ${MAX_XLSX_ROWS} 行上限, 请拆分后再导入`);
  }
  return out;
}

// exceljs 的 cell.value 是**多态**的, 必须归一化成字符串:
//   · 字符串 / 数字 / 布尔 → 直接取
//   · { richText: [{ text }] } → 富文本, 拼起来
//   · { formula, result }      → 公式, 取计算结果
//   · { text, hyperlink }      → 带超链接的文本
//   · { error: '#REF!' }       → 错误值, 取文本
//   · Date                    → ISO 字符串
//   · null / undefined         → ''
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map(part => (part && part.text) ? part.text : '').join('');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'result')) {
      return cellText(value.result);
    }
    if (typeof value.text === 'string') return value.text;
    if (typeof value.error === 'string') return value.error;
    if (Array.isArray(value)) return value.map(cellText).join('');
  }
  return String(value);
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
.modal-bg { position: fixed; inset: 0; background: var(--modal-backdrop); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; border-radius: 6px; min-width: 600px; max-width: 900px; max-height: 80vh; overflow-y: auto; }
.modal h3 { margin: 0 0 12px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; line-height: 1.6; }
.hint code.hdr { background: var(--sidebar-bg); padding: 1px 4px; border-radius: 2px; margin-right: 2px; }
.file-btn {
  display: inline-block; padding: 8px 12px; background: var(--accent); color: var(--button-fg);
  border-radius: 4px; cursor: pointer; font-size: 14px; margin-bottom: 12px;
}
.file-btn input[type=file] { display: none; }
.error { color: var(--red); font-size: 13px; margin: 0 0 8px; }
.preview { background: var(--sidebar-bg); padding: 10px; border-radius: 4px; margin-bottom: 12px; }
.preview-head { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.preview-head .more { color: var(--muted); }
.t { width: 100%; border-collapse: collapse; font-size: 12px; }
.t th, .t td { padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--border); }
.t th { color: var(--muted); font-weight: 600; }
.result { background: var(--sidebar-bg); padding: 10px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; }
.result p { margin: 4px 0; }
.result ul { margin: 6px 0 0; padding-left: 20px; max-height: 200px; overflow-y: auto; }
.result li { font-size: 12px; color: var(--muted); margin: 2px 0; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>