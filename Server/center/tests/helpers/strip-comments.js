// center/tests/helpers/strip-comments.js
// R161.6 (2026-10-26) — 注释剥离器 (供静态分析型测试共用)。
//
// ★ 为什么需要: 静态扫描"代码里在消费哪些 flag key"时, 源码注释里**大量**
//   描述着**已经删掉**的 gate。典型:
//     web/src/components/AppLayout.vue
//       <!-- R158.X.116.j — 删掉 `&& featureFlags.isEnabled(
//            'forest_registry.enabled')` … -->
//   不剥注释 ⇒ 扫描器把 'forest_registry.enabled' 当成"还在消费"
//   ⇒ 覆盖率断言误报"基线缺 seed 行"。
//
// ★ 为什么不会误伤 regex 字面量: 本仓所有含斜杠的 regex 都写成转义形式
//   (`\/` / `\*`), **相邻的** `//` 与 `/*` 只出现在真注释里。
//   (已全量核对 server/src 与 web/src 的 `\/` 出现处。)

/**
 * 去掉 JS / Vue 源码里的注释 (行注释、块注释、HTML 注释), 引号感知。
 *
 * @param {string} src 源码文本
 * @returns {string} 去掉注释后的文本 (字符串字面量内容原样保留)
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;      // '\'' | '"' | '`'
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;                                   // HTML 注释 (Vue template)
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;    // 行注释 (换行留给下一轮)
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;                                   // 块注释
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 去掉 SQL 里的行注释 (`--` 到行尾), 引号感知。
 *
 * ★ 前提: 描述字段里不含 `--` (已核对全部 9 条 flag seed 描述)。
 *   描述里**有**分号 (';') —— 所以调用方不能按 ';' 切语句。
 *
 * @param {string} sql SQL 文本
 * @returns {string} 去掉行注释后的文本
 */
export function stripSqlComments(sql) {
  const out = [];
  for (const line of sql.split(/\r?\n/)) {
    let inQuote = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "'") { inQuote = !inQuote; continue; }
      if (!inQuote && ch === '-' && line[i + 1] === '-') { cut = i; break; }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}
