// Parses `-- verify: table X` / `-- verify: column X.Y` / `-- verify: index X.Y`
// / `-- verify: foreignkey X.Y` markers from the top of a SQL migration file.
// Returns an array of {kind, name} objects. Returns [] when no markers are present.
//
// Grammar (each kind takes exactly ONE name — use multiple lines for multiple
// artifacts; this keeps every marker trivially correct vs. a comma-list parser):
//
//   -- verify: table       <table_name>
//   -- verify: column      <table>.<column>
//   -- verify: index       <table>.<index_name>
//   -- verify: foreignkey  <table>.<constraint_name>
//   -- verify: columntype  <table>.<column> <type>
//
// Scan rules:
//   - only the first 50 non-empty lines (marker must live near the top so
//     reviewers see it before the body);
//   - lines inside /* ... */ block comments are ignored (the marker must be
//     outside any block-comment wrapping);
//   - the keyword is case-insensitive;
//   - whitespace between the tokens is collapsed.
//   - only singular `table` / `column` / `index` / `foreignkey` / `columntype`
//     keywords are accepted. Plural forms (`tables`, `columns`, `indexes`) and
//     comma-separated lists are intentionally rejected so the migration file
//     can't paper over a half-finished change with one lazy marker — split into
//     one marker per artifact instead.
//
// R161.18 (2026-10-28) — 新增 `foreignkey` 类型。
//   起因: 外键迁移 (R161.18 的 1.0.9) 建的产物是**外键约束**, 而契约里
//   只有 table/column/index 三种 ⇒ 写 `-- verify: foreignkey ...` 会被解析器
//   **整个忽略** ⇒ 该文件被当成"没有标记" ⇒ backfillMigrations **无条件**
//   登记成 applied 而从不执行 ⇒ 外键永远建不出来 (而且没有任何告警)。
//   这跟 R161.17 修掉的"1.0.2 没有标记 ⇒ 从未执行"是**同一个坑的两条腿**。
//
// R161.31 (2026-11-07) — 新增 `columntype` 类型。
//   起因: `column` 探针只查列**在不在**, 不查列的**类型**
//   (probe.column 没有 DATA_TYPE 条件)。而"把某列从 TINYINT 加宽到 INT"
//   这类迁移改的**就是类型** —— 列本来就存在 ⇒ column 探针**必然通过**
//   ⇒ backfillMigrations 把迁移**登记成 applied 而从不执行**
//   ⇒ 存量库的列永远是窄类型 ⇒ 那个"写不进 Windows 错误码 ⇒ 表恒 0 行"
//   的 bug 原样留着, 且零告警。
//   这跟 R161.17 是**同一个坑的第三种形状** (那次是"没标记 ⇒ 无条件登记";
//   这次是"标记了但探针分辨不出类型差异 ⇒ 照样登记")。
//   ⇒ `columntype` 标记带**两个**参数: `<table>.<column>` + 期望的类型名。
//     探针比对基本类型名 (MySQL 的 DATA_TYPE / MSSQL 的 sys.types.name),
//     两者都**不带显示宽度** ⇒ 两个方言之间可比。
const MAX_SCAN_LINES = 50;
const MARKER_RE = /^\s*--\s*verify:\s*(table|column|index|foreignkey|columntype)\s+(\S+)\s*$/i;
// columntype 是**唯一**带第二个参数的类型 (期望的类型名)。
//   ⚠ 必须锚定行尾 ($) —— 否则 `-- verify: columntype t.c int` 会被
//     columntype 规则吃掉, 而 `column` 规则本来也匹配不上 (列名里不能有空格)。
const COLUMNTYPE_RE = /^\s*--\s*verify:\s*columntype\s+(\S+)\s+(\S+)\s*$/i;

export function parseVerifyMarker(sql) {
  const lines = sql.split('\n').slice(0, MAX_SCAN_LINES);
  const out = [];
  let inBlockComment = false;
  for (const line of lines) {
    if (inBlockComment) {
      const closeIdx = line.indexOf('*/');
      if (closeIdx >= 0) {
        // resume after */
        const rest = line.slice(closeIdx + 2);
        inBlockComment = false;
        // process the rest of this line as if it were a new line
        if (rest.trim().length > 0) {
          // recurse via a one-shot: extract marker from `rest`
          const ct = COLUMNTYPE_RE.exec(rest);
          if (ct) {
            out.push({ kind: 'columntype', name: ct[1], type: ct[2] });
          } else {
            const m = MARKER_RE.exec(rest);
            if (m) out.push({ kind: m[1].toLowerCase(), name: m[2] });
          }
        }
      }
      continue;
    }
    // Look for block-comment start
    const bcStart = line.indexOf('/*');
    const beforeBc = bcStart >= 0 ? line.slice(0, bcStart) : line;
    // columntype 先判 (它的名字更长更具体, 但两条正则互斥 —— columntype
    // 的第一个参数里不能有空格, 所以 `column t.c` 不会被 columntype 吃掉)。
    const ct = COLUMNTYPE_RE.exec(beforeBc);
    if (ct) {
      out.push({ kind: 'columntype', name: ct[1], type: ct[2] });
    } else {
      const m = MARKER_RE.exec(beforeBc);
      if (m) out.push({ kind: m[1].toLowerCase(), name: m[2] });
    }
    if (bcStart >= 0 && line.indexOf('*/', bcStart + 2) < 0) {
      inBlockComment = true;
    }
  }
  return out;
}

// Probes each marker against the live DB. Returns {ok, missing}, where
// `missing` is a human-readable array like ['table sys_config_audit',
// 'column ad_dcs.is_pdc', 'index ad_replication_history.ix_hist_pair_time']
// in marker order.
//
// `db.sql` is the already dialect-resolved registry built by buildSql() at
// db.init() time, so the probe SQL is read from db.sql.probe — the dialect is
// baked into the strings, not selected here.
//
//   kind='table'      -> probe.table  with params [name]
//   kind='column'     -> probe.column with params [table, column]
//                        (the marker name is '<table>.<column>', split on first '.')
//   kind='index'      -> probe.index  with params [table, index_name]
//                        (same dotted convention as 'column'; an unqualified
//                        index name is reported missing rather than guessed at)
//   kind='foreignkey' -> probe.foreignKey with params [table, constraint_name]
//                        ('<child_table>.<constraint_name>' —— 约束挂在**子表**上)
//   kind='columntype' -> probe.columnType with params [table, column, type]
//                        ('<table>.<column>' + 期望的基本类型名, 大小写不敏感)
export async function verifyMarkers(db, markers) {
  const probe = db.sql.probe;
  const missing = [];
  for (const m of markers) {
    if (m.kind === 'table') {
      const { rows } = await db.query(probe.table, [m.name]);
      if (!rows || rows.length === 0) missing.push(`table ${m.name}`);
    } else if (m.kind === 'column') {
      const dot = m.name.indexOf('.');
      if (dot < 0) {
        // A column marker without a table qualifier can't be probed. Treat it
        // as missing so the migration is skipped rather than blindly backfilled.
        missing.push(`column ${m.name} (malformed)`);
        continue;
      }
      const { rows } = await db.query(probe.column, [m.name.slice(0, dot), m.name.slice(dot + 1)]);
      if (!rows || rows.length === 0) missing.push(`column ${m.name}`);
    } else if (m.kind === 'columntype') {
      // R161.31 — 比对**类型**, 不是存在性。
      const dot = m.name.indexOf('.');
      if (dot < 0) {
        missing.push(`columntype ${m.name} (malformed)`);
        continue;
      }
      if (!m.type) {
        missing.push(`columntype ${m.name} (malformed — 缺期望的类型名)`);
        continue;
      }
      const { rows } = await db.query(
        probe.columnType,
        [m.name.slice(0, dot), m.name.slice(dot + 1), m.type]
      );
      if (!rows || rows.length === 0) {
        missing.push(`columntype ${m.name} = ${m.type}`);
      }
    } else if (m.kind === 'index') {
      const dot = m.name.indexOf('.');
      if (dot < 0) {
        // Same defence-in-depth as column: an unqualified index name can't be
        // resolved against the live DB, so report missing rather than probe
        // a wrong table.
        missing.push(`index ${m.name} (malformed)`);
        continue;
      }
      const { rows } = await db.query(probe.index, [m.name.slice(0, dot), m.name.slice(dot + 1)]);
      if (!rows || rows.length === 0) missing.push(`index ${m.name}`);
    } else if (m.kind === 'foreignkey') {
      const dot = m.name.indexOf('.');
      if (dot < 0) {
        // 约束名必须带表限定 —— 否则探针没法知道该查哪张表的约束。
        missing.push(`foreignkey ${m.name} (malformed)`);
        continue;
      }
      const { rows } = await db.query(probe.foreignKey, [m.name.slice(0, dot), m.name.slice(dot + 1)]);
      if (!rows || rows.length === 0) missing.push(`foreignkey ${m.name}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
