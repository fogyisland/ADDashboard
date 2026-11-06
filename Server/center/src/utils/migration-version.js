// R161.19 (2026-10-28) — 迁移版本号的解析与排序 (MySQL / MSSQL 双方言共用)。
//
// ★★ 为什么必须单独抽一个模块 (而不是留在 services/migrations.js 里):
//   src/services/migrations.js 已经 import 了 src/init/schema-applier.js
//   (要用它的 splitSqlStatements) ⇒ schema-applier.js **不能**再反向 import
//   services/migrations.js, 否则成环。而 schema-applier.js 的
//   backfillMigrations() 同样需要按版本序遍历迁移文件 ⇒ 两边都要用 ⇒ 放共享 utils。
//
// ★★ 为什么不能用文件名字典序:
//   字典序下 '1.0.10-xxx.sql' 排在 '1.0.2-xxx.sql' **前面**
//   ('1.0.1' 是 '1.0.10' 的前缀, 而 '-' (0x2D) < '0' (0x30))。
//   ⇒ 版本号一旦进到两位数, 遍历顺序就与语义顺序相反。
//   后果不是"列表排得难看", 是**执行顺序错**:
//     · upgrade() —— 会先执行 1.0.10, 再执行 1.0.2 ~ 1.0.9。
//       而 1.0.5 的唯一索引**依赖** 1.0.4 建出来的 hash 计算列 ⇒ 顺序反了就建不出来。
//     · applyUpTo('1.0.9') —— 遍历到 1.0.10 时 compareVersions('1.0.10','1.0.9') > 0
//       ⇒ break ⇒ 1.0.2 ~ 1.0.9 **一个都不会被执行**。
//   R161.18 把 MSSQL 编号迁移排到 1.0.9 ⇒ 下一个迁移就是 1.0.10 ⇒
//   这个坑就摆在下一个文件上等着, 所以在它发生之前把排序换掉。

// R158.42 — semver-aware compare. '1.0.10' > '1.0.2' (lexicographic
// would put it the other way). Also handles legacy '053' vs '1.0.0'
// (treats single-segment as [n, 0, 0]).
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

// R158.42 — semver-aware filename match. Accepts both legacy 3-digit
// prefix ('053-foo.sql') and semver ('1.0.0-foo.sql' / '1.0.0.sql').
// 契约与旧的 services/migrations.js 里那份**逐字一致**: 只认 .sql,
// .js 文件走 resolveJsFile / backfillMigrations 的独立分支。
export function parseFileMeta(filePath) {
  const fileName = String(filePath).split(/[/\\]/).pop();
  const m = fileName.match(/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i);
  return m ? { version: m[1], description: m[2] || null } : null;
}

// 排序用的宽松版: .sql 与 .js 都认 (backfillMigrations 要按版本序遍历两种文件)。
const SORT_FILE_RE = /^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.(?:sql|js)$/i;

// 按**语义版本**排序迁移文件名 (不改入参, 返回新数组)。
//   · 认不出版本号的名字 (不是 NNN[-desc].sql/js) 排到最后, 彼此按名字字典序
//     ⇒ 排序结果稳定、可复现, 不会因为某个外来文件让整表顺序抖动。
//   · 同版本不同文件名 (理论上不该出现) 按名字字典序兜底。
export function sortMigrationFiles(files) {
  return [...files].sort((a, b) => {
    const ma = SORT_FILE_RE.exec(String(a).split(/[/\\]/).pop());
    const mb = SORT_FILE_RE.exec(String(b).split(/[/\\]/).pop());
    if (!ma && !mb) return a < b ? -1 : a > b ? 1 : 0;
    if (!ma) return 1;
    if (!mb) return -1;
    const c = compareVersions(ma[1], mb[1]);
    if (c !== 0) return c;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
