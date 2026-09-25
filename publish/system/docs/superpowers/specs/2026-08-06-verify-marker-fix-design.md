---
name: 2026-08-06 verify-marker root-cause fix design
description: bootstrapMigrations 不再盲填 — 每个 migration 文件头部加 verify marker，backfill 探 DB 后再 backfill
type: project
---

# Verify-Marker Root-Cause Fix Design

## Goal

修 `bootstrapMigrations()` 的盲 backfill 缺陷：之前无论 DB 是否真的运行过某个 migration 文件，`backfillMigrations()` 都把全部文件标成 `applied`。当部署 DB 实际缺失某个 migration 的 artifact（如 `sys_config_audit` 表），admin API 在该 artifact 上 500。

**修复**：每个 migration 文件头部声明它产生的 artifact（`-- verify: table X` 或 `-- verify: column X.Y`）；`backfillMigrations()` 在 upsert row 之前探 DB——marker 全部存在才 backfill；任一缺失则 warn + skip 该文件，admin migrations 页上该文件显示为 pending 等运维补 apply。

## Non-Goals (YAGNI)

- ❌ apply 路径 probe（apply 本身 CREATE/ADD COLUMN IF MISSING 已自检；defect 只发生在 bootstrap 路径）
- ❌ DROP-only migration 的 negative-probe（marker 语义是 verify artifact 存在；DROP 后 artifact 不在）
- ❌ 自动从文件 SQL 推断 marker（手工加，简单可控）
- ❌ 改 marker 语法（SQL line comment 是最便携的；mysql/mssql 通用）
- ❌ 改 admin migrations UI（pending 文件自然从 filesystem vs DB row diff 显示）
- ❌ 改 schema-applier.js 的 applyAll 流程

## Current State (snapshot)

- `center/src/init/schema-applier.js:165-193` — `backfillMigrations()` 当前**逐文件 upsert row**，无任何 DB 探测。`if (f.startsWith('009-')) continue;` 是为了避免"009 创建 schema_migrations 后立即给自己写 row"的循环。
- `center/src/init/schema-applier.js:210-224` — `bootstrapMigrations()`：probe schema_migrations → 不存在则 apply 009 + `backfillMigrations()`。这个 apply-then-backfill 流程是 defect 入口：009 跑了但 005/008 没跑也无所谓——backfill 都标 applied。
- `db/migrations/001-009-*.sql` × 9 文件——目前无任何 marker。当前部署若 005 没真跑，DB 缺 `sys_config_audit`，admin API `/api/admin/config/audit` 仍能查（因为 audit 视图读 `sys_config_audit`，表缺失时 query 抛错），返回 500。
- `center/src/db/sql.js:208-225 / 451-...` — `schemaMigrations` SQL 块（list / findByVersion / upsert / deleteFailed）。`probe.*` 块尚无。

## Approach

**Marker-based verification**：每个 migration 文件头部用 SQL line comment 声明 artifact；`backfillMigrations()` 在 upsert row 前调 `verifyMarkers(db, markers, dialect)`。

新文件 `center/src/init/verify-marker.js` 暴露两个纯函数：
- `parseVerifyMarker(sql)` → `Marker[]`，无 marker 返回 `[]`
- `verifyMarkers(db, markers, dialect)` → `{ ok, missing }`

`db.sql.probe.{table, column}` 新加（mysql + mssql 各一份）。

`schema-applier.js`：
- 删 `if (f.startsWith('009-')) continue;`——009 的 marker `verify: table schema_migrations` 自然通过，circular skip 不再需要
- `backfillMigrations(dialect, db, opts)` 接受 `opts.logger`（兼容旧调用无 logger），探 DB 后决定 backfill 或 warn+skip

## Marker 规则

**可选 marker**：文件有 marker → 必须 probe 通过才 backfill；无 marker → 按旧逻辑直接 backfill。

理由：006 是 DELETE-only migration（清 `system_config` 里 dead rows），无 CREATE/ALTER；marker "verify" 语义对它不适用。无 marker 走原路径保留 idempotency。如果担心 006 没真跑——它只删 dead rows，admin API 不依赖，不属于 defect 范畴。

## Marker 清单（写入各文件顶部，before DELIMITER/SQL）

| 文件 | Markers |
|---|---|
| 001-dc-site-discovery.sql | `verify: column ad_sites.description` × `ad_sites.created_at` × `ad_sites.updated_at` × `ad_dcs.when_created` × `ad_dcs.is_gc` × `ad_dcs.is_rid_master` × `ad_dcs.is_schema_master` × `ad_dcs.is_domain_naming_master` × `ad_dcs.is_infrastructure_master` × `ad_dcs.site_hint` × `ad_dcs.discovered_at` × `ad_dcs.discovered_by_agent_id`（12 个 column marker） |
| 002-permissions-table.sql | `verify: table role_permissions`（1 个） |
| 003-port-healthcheck.sql | `verify: table system_ports` × `ad_agent_port_status`（2 个） |
| 004-package-system.sql | `verify: table installed_packages` × `metric_gauge` × `metric_counter` × `metric_timeseries` × `metric_status` × `package_runs`（6 个） |
| 005-sys-config-audit.sql | `verify: table sys_config_audit`（1 个） |
| 006-drop-public-host-port.sql | **无 marker**（DELETE-only） |
| 007-dc-card-counters.sql | `verify: column ad_replication_status.users_count` × `ad_replication_status.groups_count` × `ad_replication_status.gpos_count` × `ad_replication_status.locked_count`（4 个） |
| 008-lockout-events.sql | `verify: table ad_lockout_events`（1 个） |
| 009-schema-migrations.sql | `verify: table schema_migrations`（1 个） |

合计 28 个 markers 跨 8 个文件（006 无）。

## Data Model

`Marker = { kind: 'table'|'column', name: '<name>' }`

- `kind='table'` → `name` 是表名
- `kind='column'` → `name` 格式 `<table>.<col>`，parseVerifyMarker 拆出 table + col 传给 probe

## Components

### `center/src/init/verify-marker.js`（新）

```js
export function parseVerifyMarker(sql) {
  // 扫描 SQL 字符串，每行匹配 /^\s*--\s*verify:\s*(table|column)\s+(\S+)\s*$/i
  // 只扫文件前 50 行（marker 必须靠前，方便 reviewer 看到）
  // 跳过 '/* ... */' block comment 包裹的行
  // 返回 Marker[]: [{ kind, name }, ...]
  // 无 marker → []
}

export async function verifyMarkers(db, markers, dialect) {
  // 遍历 markers
  //   kind='table' → db.query(db.sql.probe.table, [name])
  //   kind='column' → 拆 name 为 table+col，db.query(db.sql.probe.column, [table, col])
  // 任一 query 返回 0 行 → push missing，continue
  // 返回 { ok: missing.length===0, missing: ['table sys_config_audit', 'column ad_dcs.is_pdc', ...] }
}
```

### `center/src/db/sql.js`（修改，两 dialect 都加）

mysql `probe` block:
```js
probe: {
  table:  `SELECT 1 AS ok FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
  column: `SELECT 1 AS ok FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`
}
```

mssql `probe` block:
```js
probe: {
  table:  `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?`,
  column: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`
}
```

### `center/src/init/schema-applier.js`（修改）

`backfillMigrations(dialect, db, opts)` 改写：

```js
export async function backfillMigrations(dialect, db, opts = {}) {
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');
  const dir = resolveMigrationsDir(repoRoot, dialect);
  if (!existsSync(dir)) return { count: 0, skipped: [] };
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const appliedAt = new Date().toISOString();
  const logger = opts.logger ?? console;
  let count = 0;
  const skipped = [];
  for (const f of files) {
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    const version = m[1];
    const content = readFileSync(join(dir, f), 'utf8');
    const markers = parseVerifyMarker(content);
    if (markers.length > 0) {
      const { ok, missing } = await verifyMarkers(db, markers, dialect);
      if (!ok) {
        logger.warn?.({ file: f, version, missing }, 'verify markers missing — skipping backfill');
        skipped.push({ file: f, version, missing });
        continue;
      }
    }
    const checksum = sha256(content);
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, m[2], 'sql', f, checksum,
      appliedAt, 0, 'system-init', 'applied', null
    ]);
    count++;
  }
  return { count, skipped };
}
```

**关键删除**：`if (f.startsWith('009-')) continue;`——009 的 marker `verify: table schema_migrations` 在 backfill 跑时已经存在（bootstrap 路径刚 apply 过；init wizard 路径 applyAll 也跑过），marker probe 自然通过，不再需要 circular 跳过。

**返回签名变化**：原来返回 `number`（count），现返回 `{ count, skipped }`。调用方（bootstrapMigrations + init wizard）暂不读 `skipped`，向后兼容——但破坏 ABI，需要更新调用方。`bootstrapMigrations` 当前不读返回值，所以无需改。Init wizard 调用 backfill 是为统计，原代码也没读返回值。只需更新测试。

### 9 个 migration 文件（修改）

每个文件顶部（在 DELIMITER / SQL 前）加 marker block：

例 001-dc-site-discovery.sql：
```sql
-- 001-dc-site-discovery.sql
-- verify: column ad_sites.description
-- verify: column ad_sites.created_at
-- verify: column ad_sites.updated_at
-- verify: column ad_dcs.when_created
-- verify: column ad_dcs.is_gc
-- verify: column ad_dcs.is_rid_master
-- verify: column ad_dcs.is_schema_master
-- verify: column ad_dcs.is_domain_naming_master
-- verify: column ad_dcs.is_infrastructure_master
-- verify: column ad_dcs.site_hint
-- verify: column ad_dcs.discovered_at
-- verify: column ad_dcs.discovered_by_agent_id

-- AD Dashboard DC/Site Discovery migration ...
```

（每行 `-- verify:` 紧贴 marker 列表上方，作为 SQL line comment）

006-drop-public-host-port.sql：不加 marker，保留原状。

## Behavior

| 场景 | 行为 |
|---|---|
| Fresh DB init wizard（applyAll → backfill） | 9 个 marker 全部 probe 通过 → 全部 backfill → 无 warn |
| 部署从 pre-009 升级（schema_migrations 缺失） | bootstrap apply 009 → backfill 001-009 → 全部 marker 通过 → 全部 backfill |
| 部署 DB 缺 005（sys_config_audit 不存在） | bootstrap apply 009 → backfill → 005 marker probe 失败 → warn + skip 005 → 其余 backfill → admin 页 005 显示 pending，运维点击 apply 修复 |
| DROP-only migration（006） | 无 marker → 按旧逻辑 backfill（保留 idempotency） |
| 重复 bootstrap | 第二次：probe schema_migrations 存在 → no-op |

## File Changes

| 类型 | 路径 | 内容 |
|---|---|---|
| 新增 | `center/src/init/verify-marker.js` | parseVerifyMarker + verifyMarkers |
| 修改 | `center/src/db/sql.js` | 加 `db.sql.probe.{table, column}`（mysql + mssql） |
| 修改 | `center/src/init/schema-applier.js` | backfillMigrations 用 marker probe；删 009 circular skip；返回 `{count, skipped}` |
| 修改 | `db/migrations/001-dc-site-discovery.sql` | 加 12 个 column markers |
| 修改 | `db/migrations/002-permissions-table.sql` | 加 1 个 table marker |
| 修改 | `db/migrations/003-port-healthcheck.sql` | 加 2 个 table markers |
| 修改 | `db/migrations/004-package-system.sql` | 加 6 个 table markers |
| 修改 | `db/migrations/005-sys-config-audit.sql` | 加 1 个 table marker |
| 修改 | `db/migrations/007-dc-card-counters.sql` | 加 4 个 column markers |
| 修改 | `db/migrations/008-lockout-events.sql` | 加 1 个 table marker |
| 修改 | `db/migrations/009-schema-migrations.sql` | 加 1 个 table marker |
| 新增 | `center/tests/verify-marker.test.js` | parseVerifyMarker + verifyMarkers 单测（~10 tests） |
| 新增 | `center/tests/backfill-verify.test.js` | backfillMigrations 集成测试：marker 通过、marker 缺失 skip+warn、无 marker 跳过 probe（~5 tests） |
| Mirror | `publish/center/src/init/verify-marker.js` | cp |
| Mirror | `publish/center/src/db/sql.js` | cp |
| Mirror | `publish/center/src/init/schema-applier.js` | cp |
| Mirror | `publish/db/migrations/001-009-*.sql` × 8（006 无 marker 不动） | cp |

无 frontend / router / spec changes；无新 npm dep。

## Tests

### `center/tests/verify-marker.test.js`（新）

1. **parses table marker**: `-- verify: table sys_config_audit` → `[{kind:'table', name:'sys_config_audit'}]`
2. **parses column marker**: `-- verify: column ad_dcs.is_pdc` → `[{kind:'column', name:'ad_dcs.is_pdc'}]`
3. **parses multiple markers in same file** → returns array
4. **returns empty for SQL with no markers**
5. **stops scanning after 50 lines**（放 marker 在第 51 行 → 不解析）
6. **ignores markers inside block comments**（`/* -- verify: table x */` 不解析）
7. **case-insensitive** (`-- VERIFY: TABLE foo`)
8. **whitespace tolerant** (`--  verify:  table foo`)

### `center/tests/backfill-verify.test.js`（新，集成）

用 `buildMockDb({ match: ..., rows: ... })` 模式（参 `center/tests/helpers/db-mock.js`）：

1. **all markers present → backfill all rows**: mock probe.table/column 全部返回 `{rows:[{ok:1}]}` → 9 个 row upsert
2. **005 marker missing → skip 005 + warn, others backfilled**: mock sys_config_audit 不存在 → 005 skipped, 001-004 + 006-009 backfilled
3. **006 has no markers → backfilled without probe**: 不调 probe → 006 直接 upsert
4. **multiple markers on same file, one missing → skip entire file**（001 缺 ad_dcs.is_pdc → 001 全 skip）
5. **returns `{count, skipped}` shape** with skipped array shape
6. **no 009 circular skip needed**: 即使 009 在 list 里，也走 marker probe + backfill 路径

## Verification

1. `cd center && npm test` — 既有 431 + 新 ~15 = ~446 expected (0 regressions)
2. 手动 smoke（init wizard 路径）：fresh DB → applyAll → backfill → schema_migrations 9 行都在，0 warn
3. 手动 smoke（bootstrap 路径）：mock 缺 sys_config_audit → bootstrap → backfill skip 005 → admin `/api/admin/migrations` 列 005 为 pending
4. `cp` 4 个 source 文件 → publish/ mirror
5. `git push origin main`

## Risks

1. **009 marker 需要 schema_migrations 存在才能 probe** — bootstrap 路径里 009 是先 apply 再 backfill，存在；init wizard 路径 applyAll 跑 009 在 backfill 前，存在。**无风险**。
2. **mssql 探针语法差异** — 已有 `existsProbeSql` 函数处理 dialect 分发，verifyMarkers 接受 dialect 参数，db.sql.probe 块同样按 dialect 分发。沿用现有 pattern。
3. **首次部署 migration 005 marker 失败** — 如果用户 DB 真的缺 005，admin 会看到 005 pending 列表。这是 defect 的**正确**行为（之前是 500 silent error；现在是有可见的 pending 待 apply）。用户体验从 hidden error → visible signal。
4. **006 (DELETE-only) 没 marker** — 如果 006 没真跑，DB 残留 dead rows 不影响 admin API，**non-defect**。接受旧行为。
5. **parseVerifyMarker 扫前 50 行** — marker 故意靠前，方便 reviewer。50 行上限防 marker 散落在长文件里。
6. **`backfillMigrations` 返回值 ABI 变化** — `number → {count, skipped}`。已检查所有调用点：bootstrapMigrations 不读返回值；init wizard 不读返回值。**零破坏**。

## Out of Scope

- apply 路径 probe
- DROP 迁移的 negative-probe
- marker 自动生成
- marker 语法升级（XML、YAML frontmatter 等）
- admin migrations UI 变化
- schema-applier.js applyAll 改动