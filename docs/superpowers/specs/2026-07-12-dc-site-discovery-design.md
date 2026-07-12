# AD Dashboard - 站点/DC 发现与关联 (A+B 子项目)

> **创建日期：** 2026-07-12
> **状态：** 待用户审阅
> **目标读者：** 实施工程师
> **范围：** 子项目 A + B (AD 站点/DC 元数据采集 + 站点↔DC 关联管理)。其它子项目（C/D/E/F/G/H/I）不在本文档内。

---

## 1. 背景与目标

当前 `ad_sites` 和 `ad_dcs` 表结构存在但完全为空（0 行）。"当前可用站点"/"当前可用服务器"页面是从 `ad_replication_status` **派生**的，无法体现 AD 的真实拓扑，也无法支撑后续子项目：

- **C**：缺失检测（"预期有 N 个 DC，只 K 个 agent 在心跳"）
- **G**：Per-site / Per-DC 健康汇总
- **I**：多平台 MySQL+MSSQL（需要权威 schema 而不是派生 view）

本子项目目标：

1. **A**：agent 主动上报本地 DC 的元数据（OS、角色、创建时间、site hint），写入 `ad_dcs`
2. **B**：admin 通过 UI 维护站点清单（ad_sites CRUD），并将每个 DC 关联到站点

完成后的视图划分：

- **正在复制的站点 / 正在复制的域控**（派生，事实）
- **AD 站点清单 / AD 域控清单**（权威，应该）

---

## 2. 核心设计决策

| 决策点 | 选定方案 | 备选 |
|---|---|---|
| agent 上报范围 | 仅本地 DC | 整个 forest 所有 DC |
| 站点创建方式 | admin 手动 | agent 自动发现 |
| 站点↔DC 关联方式 | admin 手动 | 自动按 agent 报告的 site_hint |
| 上报通道 | 独立端点 `/api/agent/discover` | 复用 `/api/agent/report` |
| 采集频率 | 4h 定时 + 启动时一次（可配） | 跟随 polling 周期 / 仅启动 / 手动 |
| 多 agent 报同一 DC 冲突策略 | 后写赢（用户场景不出现） | 先写赢 / 多者认同 |
| drift 处理 | agent 报什么就是什么（无缺失标记） | is_missing 字段 / 两阶段提交 |
| 派生 vs 权威视图 | 两个并存，重命名派生视图 | 替换 / tab 合一 |
| SQL 方言 | MySQL native（封装在 service 层） | 提前抽象（推迟到 I 子项目） |

---

## 3. 数据流

```
┌─────────────────────────┐                     ┌────────────────────────┐
│ Agent (本地 DC)         │                     │ Center                 │
│                         │                     │                        │
│ collect-discovery.ps1   │                     │  POST /api/agent/      │
│   Get-ADDomainController│   POST JSON         │       discover         │
│   -Identity $env:       ├────────────────────►│                        │
│     COMPUTERNAME        │  {agentId,          │  upsertDiscoveredDc()  │
│                         │   collectedAt,      │  UPSERT ad_dcs         │
│ 输出 DC 元数据           │   dc: {...}}        │  (site_id 不动)        │
│ + 4h 定时器              │                     │                        │
└─────────────────────────┘                     └────────┬───────────────┘
                                                         │
                                              ┌──────────┴────────────┐
                                              ▼                       ▼
                                       ┌────────────┐         ┌────────────┐
                                       │ ad_dcs     │         │ ad_sites   │
                                       │ (UPSERT    │         │ (admin CRUD│
                                       │  from agent)│         │  via UI)   │
                                       └─────┬──────┘         └─────┬──────┘
                                             │                      │
                                             └────── site_id FK ────┘
                                                  (admin sets)
```

---

## 4. 数据库 Schema 变更

### 4.1 新建 migration 文件 `db/migrations/001-dc-site-discovery.sql`

幂等（MySQL 8 不支持 `ADD COLUMN IF NOT EXISTS`，用 stored procedure 兜底）：

```sql
-- ad_sites: 增列
ALTER TABLE ad_sites
  ADD COLUMN description VARCHAR(256) NULL,
  ADD COLUMN created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- ad_dcs: 增列（agent 上报的元数据 + 站点关联状态）
ALTER TABLE ad_dcs
  ADD COLUMN when_created             DATETIME NULL,
  ADD COLUMN is_gc                    TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_rid_master            TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_schema_master         TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_domain_naming_master  TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_infrastructure_master TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN site_hint                VARCHAR(64) NULL,
  ADD COLUMN discovered_at            DATETIME NULL,
  ADD COLUMN discovered_by_agent_id   VARCHAR(64) NULL;

-- 新增 config: discovery 间隔
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('discovery_interval_hours', '4', 'Agent 上报本地 DC 元数据的时间间隔 (小时)');
```

不可改字段：`dc_name` (PK)、`site_id` (admin 管)、`is_pdc`、`os_version`（已存在，继续由 agent 写）。

### 4.2 注意

- MySQL 8 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，对全新部署可以执行，对已部署的需要 catch error code 1060 (duplicate column) 跳过。
- `install-center.ps1` 需更新：先跑 `db/schema/01-tables.sql`、`02-seed-roles.sql`，再依次跑 `db/migrations/*.sql`。

---

## 5. Agent 改动

### 5.1 新 PS 脚本 `agent/scripts/collect-discovery.ps1`

输入：`$env:COMPUTERNAME`
输出（stdout JSON）：
```json
{
  "name": "DC-BJ-01",
  "siteHint": "Beijing-Site",
  "osVersion": "Windows Server 2019 Datacenter",
  "whenCreated": "2024-03-15T08:00:00.000Z",
  "isPdc": false,
  "isGc": true,
  "isRidMaster": false,
  "isSchemaMaster": false,
  "isDomainNamingMaster": false,
  "isInfrastructureMaster": false
}
```

逻辑：
1. `Import-Module ActiveDirectory`
2. `Get-ADDomainController -Identity $env:COMPUTERNAME`
3. 字段映射：`$dc.Name → name`、`$dc.SiteObjectName → siteHint`、`$dc.OperatingSystem → osVersion`、`$dc.whenCreated → whenCreated`、`$dc.IsPDC → isPdc`、`$dc.IsGlobalCatalog → isGc`、`$dc.RIDMasterRole → isRidMaster`、`$dc.SchemaMasterRole → isSchemaMaster`、`$dc.DomainNamingMasterRole → isDomainNamingMaster`、`$dc.InfrastructureRole → isInfrastructureMaster`
4. `[Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))`

退出码：成功 0，模块缺失 2，DC 找不到 3。

### 5.2 新 Node 模块 `agent/src/discovery.js`

```js
export function runDiscovery({ powerShellPath, psScriptPath }) { /* spawn + parse JSON */ }
export function postDiscovery({ centerUrl, agentToken, payload }) { /* POST /api/agent/discover */ }
export function startDiscoveryScheduler({ intervalHours, run, logger }) {
  // 立即跑一次；之后每 N 小时跑一次；stop() 清理
}
```

模式与 `agent/src/heartbeat.js` / `agent/src/scheduler.js` 一致。

### 5.3 `agent/agent.js` 接线

```js
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from './src/discovery.js';

// ... 既有 heartbeat / scheduler 之后:

const discovery = startDiscoveryScheduler({
  intervalHours: config.discoveryIntervalHours,
  run: async () => {
    const snap = await runDiscovery({
      powerShellPath: config.powerShellPath,
      psScriptPath: config.psScriptPath  // 复用，但后面会拆
    });
    if (!snap) return;
    await postDiscovery({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      payload: {
        agentId: config.agentId,
        collectedAt: new Date().toISOString(),
        dc: snap
      }
    });
  },
  logger
});
```

shutdown 时 `discovery.stop()`。

**注**：本 spec 不重构现有 `psScriptPath`。新增 `psDiscoveryScriptPath`（默认 `collect-discovery.ps1`），与 replication 分开。两个 PS 脚本可独立演进。

### 5.4 新 config 字段

`agent/src/config.js` DEFAULTS：
```js
discoveryIntervalHours: 4,
psDiscoveryScriptPath: 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1'
```

`agent/appsettings.example.json`：
```json
"discoveryIntervalHours": 4,
"psDiscoveryScriptPath": "C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1"
```

---

## 6. Center 改动

### 6.1 新 service `center/src/services/discovery.js`

```js
const DISCOVERY_UPSERT = `
INSERT INTO ad_dcs (
  dc_name, site_hint, os_version, when_created,
  is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master,
  discovered_at, discovered_by_agent_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
ON DUPLICATE KEY UPDATE
  site_hint                = VALUES(site_hint),
  os_version               = VALUES(os_version),
  when_created             = VALUES(when_created),
  is_pdc                   = VALUES(is_pdc),
  is_gc                    = VALUES(is_gc),
  is_rid_master            = VALUES(is_rid_master),
  is_schema_master         = VALUES(is_schema_master),
  is_domain_naming_master  = VALUES(is_domain_naming_master),
  is_infrastructure_master = VALUES(is_infrastructure_master),
  discovered_at            = NOW(),
  discovered_by_agent_id   = VALUES(discovered_by_agent_id)
`.trim();

export async function upsertDiscoveredDc(pool, { agentId, collectedAt, dc }) {
  await pool.execute(DISCOVERY_UPSERT, [
    dc.name,
    dc.siteHint ?? null,
    dc.osVersion ?? null,
    dc.whenCreated ?? null,
    dc.isPdc ? 1 : 0,
    dc.isGc ? 1 : 0,
    dc.isRidMaster ? 1 : 0,
    dc.isSchemaMaster ? 1 : 0,
    dc.isDomainNamingMaster ? 1 : 0,
    dc.isInfrastructureMaster ? 1 : 0,
    collectedAt,
    agentId
  ]);
}
```

**关键约束**：`site_id` 不在 INSERT/UPDATE 列表里 — 永远只由 admin UI 改。

### 6.2 新 route `center/src/routes/agent.js`

```js
import { upsertDiscoveredDc } from '../services/discovery.js';

// 既有 heartbeat/report 之后:
r.post('/api/agent/discover', agentMw, async (req, res) => {
  const { agentId, collectedAt, dc } = req.body || {};
  if (!agentId || !collectedAt || !dc?.name) {
    return res.status(400).json({ error: 'missing agentId/collectedAt/dc.name' });
  }
  try {
    await upsertDiscoveredDc(pool, { agentId, collectedAt, dc });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e, agentId }, 'discover failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

### 6.3 新 admin routes `center/src/routes/admin.js`

新增 5 个 handler，全部走 `auth` 中间件（userAuth + requirePerm('admin:users')）：

| 端点 | 方法 | SQL | 行为 |
|---|---|---|---|
| `/api/admin/sites-catalog` | GET | `SELECT s.site_id AS id, s.site_name AS siteName, s.region_code AS regionCode, s.is_hub AS isHub, s.description, s.created_at AS createdAt, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM ad_dcs d WHERE d.site_id = s.site_id) AS dcCount FROM ad_sites s ORDER BY s.site_name` | 列表（含 DC 数） |
| `/api/admin/sites-catalog` | POST | `INSERT INTO ad_sites (site_name, region_code, is_hub, description) VALUES (?, ?, ?, ?)` | 新建，捕获 ER_DUP_ENTRY (1062) → 409 |
| `/api/admin/sites-catalog/:id` | PUT | `UPDATE ad_sites SET <set clause> WHERE site_id = ?` | 改任意字段 |
| `/api/admin/sites-catalog/:id` | DELETE | 事务：`UPDATE ad_dcs SET site_id=NULL WHERE site_id=?; DELETE FROM ad_sites WHERE site_id=?;` | 删除前 nullify 关联 |
| `/api/admin/dcs-catalog` | GET | `SELECT d.dc_name AS dcName, d.site_id AS siteId, s.site_name AS siteName, d.site_hint AS siteHint, d.os_version AS osVersion, d.when_created AS whenCreated, d.is_pdc AS isPdc, d.is_gc AS isGc, d.is_rid_master AS isRidMaster, d.is_schema_master AS isSchemaMaster, d.is_domain_naming_master AS isDomainNamingMaster, d.is_infrastructure_master AS isInfrastructureMaster, d.discovered_at AS discoveredAt, d.discovered_by_agent_id AS discoveredByAgentId FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id=s.site_id ORDER BY d.dc_name` | 列表（camelCase） |
| `/api/admin/dcs-catalog/:dc_name/site` | PUT | body `{siteId}` → 若 siteId 非空校验存在；`UPDATE ad_dcs SET site_id=? WHERE dc_name=?` | 分配/解绑 |

### 6.4 `center/src/services/sites-catalog.js`（可选抽象）

可以把 6.3 的 SQL 集中到这里。**本 spec 暂不强制** — 直接 inline 在 admin.js 也可。后续 I 子项目抽 dialect 时一起改。

---

## 7. Frontend 改动

### 7.1 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `frontend/src/views/admin/SitesView.vue` | **重命名** → `ActiveSitesView.vue` | 标题改"正在复制的站点"；路由路径不变 `/admin/sites` |
| `frontend/src/views/admin/DcsView.vue` | **重命名** → `ActiveDcsView.vue` | 标题改"正在复制的域控"；路由路径不变 `/admin/dcs` |
| `frontend/src/views/admin/SitesCatalogView.vue` | **新增** | 站点清单 CRUD |
| `frontend/src/views/admin/DcsCatalogView.vue` | **新增** | DC 清单 + 站点分配 |
| `frontend/src/views/admin/SiteReplicationMatrixView.vue` | **新增 (G)** | 站点内 DC×DC 复制矩阵 + 自动轮询 |
| `frontend/src/components/SiteEditModal.vue` | **新增** | 创建/编辑 site 模态 |
| `frontend/src/components/DcSiteAssignModal.vue` | **新增** | 分配站点模态（也可改用 inline select） |
| `frontend/src/router.js` | **改** | 加 `/admin/sites-catalog`、`/admin/dcs-catalog`、`/admin/site-replication-matrix`；routes 引用新文件名 |
| `frontend/src/components/AppLayout.vue` | **改** | 侧边导航加 3 项（站点清单、域控清单、复制矩阵）+ 重命名 2 项 |
| `frontend/src/api/admin.js` | **改** | 加 `listSitesCatalog / createSite / updateSite / deleteSite / listDcsCatalog / assignDcSite` |
| `frontend/src/api/dashboard.js` | **改 (G)** | 加 `getSiteReplicationMatrix(siteName)` |

### 7.2 关键页面布局（描述）

**SitesCatalogView**：标题 + 表格（siteName | regionCode | isHub 徽章 | description | DC 数 | 操作按钮 [编辑][删除]）+ 新建按钮。

**DcsCatalogView**：标题 + 表格（dcName | siteName [未分配时显示 dropdown 触发分配] | siteHint | osVersion | 角色徽章 [PDC][GC][RID][Schema][Naming][Infra] | discoveredAt | discoveredByAgentId）。

### 7.3 重命名策略

git mv 旧文件到新文件名；保留路由 path 不变（`/admin/sites` → 仍指 ActiveSitesView.vue 的代码，只是文件名变）。这是为避免老链接/书签失效。

### 7.4 前端不实现的功能

- DC 删除按钮（不在本 spec；缺失检测是 C 范围）
- Site 重命名（PUT 实现，但不在 UI 强调 — admin 可用）
- 历史 audit（不在本 spec）

---

## 8. 测试

### 8.1 Agent 测试

| 文件 | 用例 |
|---|---|
| `agent/scripts/tests/collect-discovery.test.ps1` (Pester) | mock `Get-ADDomainController`，断言 JSON 输出字段 |
| `agent/tests/discovery.test.js` | `runDiscovery` 解析 PS stdout；`postDiscovery` HTTP body shape |
| `agent/tests/config.test.js` | `discoveryIntervalHours` 默认 4；`psDiscoveryScriptPath` 默认值 |
| `agent/tests/scheduler.test.js` | 新增 case: discovery 定时器到点调用 run；stop() 清理 |

### 8.2 Center 测试

| 文件 | 用例 |
|---|---|
| `center/tests/agent.test.js` | 新增：`POST /api/agent/discover` 200/400/401；UPSERT 字段不含 site_id；discovered_at 用 NOW() |
| `center/tests/admin.test.js` | 新增：sites-catalog CRUD；dcs-catalog GET；assign site；delete site 前 nullify |
| `center/tests/dashboard.test.js`（新建, G） | `GET /api/dashboard/site-replication-matrix`：站点不存在 → 404；空站点 → 空数组；正常站点 → 返回 dcs + links；500 on DB error |

### 8.3 Frontend 测试

| 文件 | 用例 |
|---|---|
| `frontend/src/views/admin/SitesCatalogView.spec.js` | 渲染表格；调用 listSitesCatalog；点击新建触发 modal |
| `frontend/src/views/admin/DcsCatalogView.spec.js` | 渲染表格；调用 listDcsCatalog；点击 assign 触发 PUT |
| `frontend/src/views/admin/SiteReplicationMatrixView.spec.js` (G) | 渲染 site dropdown；切换 site 触发重新拉数据；setInterval cleanup on unmount |

### 8.4 手动 e2e（可选）

1. 在已部署的 agent 上手动触发 discovery 一次（重启 service）
2. 浏览器打开 `/admin/dcs-catalog`，看到新 DC 行（siteName=未分配）
3. 点击 dropdown 选 site，PUT 成功
4. 刷新页面，siteName 变成所选 site

---

## 9. 风险与已知限制

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | SQL 是 MySQL native (`ON DUPLICATE KEY UPDATE`, TINYINT) | I 子项目需重写 | 已封装在 `services/discovery.js`；I 时改这一层 |
| 2 | DC 在 AD 删除后 ad_dcs 行不消失 | 误导运维 | C 子项目用心跳对比识别缺失 |
| 3 | MySQL 8 无 `ADD COLUMN IF NOT EXISTS` | 重复跑 migration 报错 | 改用 stored procedure 或脚本里 catch 1060 |
| 4 | ad_dcs 与 ad_replication_status 解耦 | 无法直接 JOIN 看 DC 视角的复制状态 | 两表通过 dc_name 隐式关联；后续可补 JOIN view |
| 5 | agent 进程崩溃在两次 discovery 之间 | ad_dcs 数据 4h 内不更新 | 下次启动立即跑一次；4h 周期可改小 |
| 6 | 多 agent 报同一 DC | 当前部署不存在 | `ON DUPLICATE KEY UPDATE` 幂等；将来若改部署需重新设计 |

---

## 10. 验收标准

1. `npm test` 在 `center/`, `agent/`, `frontend/` 全部通过
2. Pester `agent/scripts/tests/collect-discovery.test.ps1` 通过
3. 手动：本地 MySQL `ad_monitoring` 库执行 `001-dc-site-discovery.sql` 后，新列存在
4. 手动：跑一次 agent discovery → `ad_dcs` 新增一行（含全部 12 个 agent 字段）
5. 手动：浏览器 `/admin/dcs-catalog` 显示新 DC，可分配 site，刷新后持久
6. 手动：浏览器 `/admin/sites-catalog` 可新建/编辑/删除 site
7. 现有 `/admin/sites`, `/admin/dcs` 行为不变（页面标题改为"正在复制的..."）
8. (G) 手动：浏览器 `/admin/site-replication-matrix` 下拉选站点，矩阵显示 DC×DC 复制状态，每 10s 自动刷新，组件卸载后无遗留请求
9. (G) 手动：分配新 DC 到某站点后，矩阵新行/新列出现
10. (G) 手动：站点未分配 DC 时矩阵显示"暂无 DC"占位而非报错

---

## 11. 后续子项目

不在本文档，待用户确认后单独 spec：

- **C** 缺失检测（ad_dcs 行 vs heartbeat 表对比）
- **D** 进一步站点/DC UI 增强（如拖拽分配、批量操作）
- **E** 拓扑/错误链路筛选
- **F** ISTG（Inter-Site Topology Generator）
- **H** discovery 间隔后台可调（admin UI 改 system_config）
- **I** 多平台 MySQL + SQL Server

---

## 12. 子项目 G：Per-Site 复制矩阵（自动轮询页面）

> 本节由用户于 2026-07-12 提出，合并到 A+B spec 内一起实施。

### 12.1 目标

新增一个管理页面，按站点展示**站点内 DC×DC 的复制状况**，并自动定时刷新，让运维一眼看清"哪两个 DC 之间复制坏了"。

**强依赖 A**：必须先有 `ad_dcs.site_id`（admin 手动分配）才能确定"站点内的 DC"。如果站点未分配 DC，矩阵显示"该站点暂无 DC"。

### 12.2 数据流

```
浏览器                              Center
┌──────────────────────────────┐    ┌─────────────────────────────┐
│ SiteReplicationMatrixView    │    │ GET /api/dashboard/         │
│   选择站点 (下拉)             │    │     site-replication-matrix │
│   拉取 DC×DC 复制矩阵         │───►│     ?site=<site_name>       │
│                              │    │                             │
│   setInterval(refresh, 10s)  │    │ 查 ad_dcs.site_id = X       │
│   onUnmounted: clearInterval │    │ 查 ad_replication_status    │
│                              │    │   WHERE source/dest DC IN   │
└──────────────────────────────┘    │   (该站点的 DCs)            │
                                     └─────────────────────────────┘
```

### 12.3 新增端点 `GET /api/dashboard/site-replication-matrix?site=<site_name>`

挂在 `center/src/routes/dashboard.js`，使用现有 `auth` 中间件。

参数：
- `site` (required) — `ad_sites.site_name`

返回（camelCase）：
```json
{
  "site": {
    "siteId": 1,
    "siteName": "Beijing-Site",
    "regionCode": "BJ",
    "isHub": true,
    "description": "..."
  },
  "dcs": [
    { "dcName": "DC-BJ-01", "osVersion": "...", "isPdc": false, "isGc": true, "discoveredAt": "..." }
  ],
  "links": [
    { "source": "DC-BJ-01", "target": "DC-BJ-02", "namingContext": "DC=contoso,DC=com", "statusCode": 0, "lastSuccessTime": "...", "lastAttemptTime": "...", "durationMinutes": 5 }
  ],
  "siteRefreshSeconds": 10
}
```

SQL（两次查询，分别拿 DC 列表和链路列表）：

```sql
-- DCs in site
SELECT dc_name, os_version, is_pdc, is_gc, is_rid_master, is_schema_master, is_domain_naming_master, is_infrastructure_master, discovered_at, discovered_by_agent_id
FROM ad_dcs WHERE site_id = ? ORDER BY dc_name;

-- Replication links between these DCs
SELECT source_dc, dest_dc, naming_context, status_code, last_success_time, last_attempt_time,
       TIMESTAMPDIFF(MINUTE, last_success_time, last_attempt_time) AS duration_minutes
FROM ad_replication_status
WHERE source_dc IN (SELECT dc_name FROM ad_dcs WHERE site_id = ?)
  AND dest_dc IN (SELECT dc_name FROM ad_dcs WHERE site_id = ?)
ORDER BY source_dc, dest_dc, naming_context;
```

校验：
- `site` 不存在 → 404 `{error: "site not found"}`
- `site` 未分配 DC → 返回 `{site, dcs:[], links:[]}`（不是错误）

错误处理沿用 dashboard.js 现有 try/catch → 500 `{error: "internal"}`。

### 12.4 新增 config `site_matrix_refresh_seconds`

`db/migrations/001-dc-site-discovery.sql` 追加：
```sql
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('site_matrix_refresh_seconds', '10', '站点复制矩阵页面自动刷新间隔 (秒)');
```

`center/src/services/config.js` `getAgentConfig` 不动 — 这不是 agent 配置。需要在 dashboard 端读取，写一个 `getDashboardConfig(pool)` helper（或在 dashboard.js 内联 SELECT）。

简单做法：dashboard.js 直接 `SELECT config_value FROM system_config WHERE config_key='site_matrix_refresh_seconds'`，未配置默认 10。

### 12.5 前端 `SiteReplicationMatrixView.vue`

路径：`frontend/src/views/admin/SiteReplicationMatrixView.vue`
路由：`/admin/site-replication-matrix`
权限：`meta: { perm: 'admin:users' }`

布局（HTML 描述，frontend-design 后续细化）：
```
┌─────────────────────────────────────────────────────┐
│ 站点复制矩阵                                         │
│ 站点: [Beijing-Site ▼]   自动刷新: 10s  ●  ●  ●  ●   │
├─────────────────────────────────────────────────────┤
│         │ DC-BJ-01 │ DC-BJ-02 │ DC-BJ-03 │          │
│ DC-BJ-01│    -     │   ●OK    │   ●ERR   │          │
│ DC-BJ-02│   ●OK    │    -     │   ●OK    │          │
│ DC-BJ-03│   ●OK    │   ●OK    │    -     │          │
├─────────────────────────────────────────────────────┤
│ DC-BJ-01 → DC-BJ-03 (DC=contoso,DC=com)             │
│   status_code=2  last_success=...  duration=15min    │
└─────────────────────────────────────────────────────┘
```

颜色规范：
- 绿 (#22c55e) status_code=0
- 黄 (#f59e0b) status_code=1
- 红 (#ef4444) status_code>=2
- 灰 (#475569) 对角线（自己到自己）

行为：
- 顶部下拉改变 site → 立即重新拉数据
- 每 10s 自动拉一次（间隔由后端配置 `site_matrix_refresh_seconds` 返回）
- 显示当前拉数据状态指示（"● ● ● ●" 四个点循环）
- `onUnmounted` 必须 `clearInterval`
- 单元格点击 → 下方详情面板展开显示该 link 的 naming_context + 时间

### 12.6 路由 + 侧边导航

`frontend/src/router.js`：
```js
{ path: '/admin/site-replication-matrix', component: SiteReplicationMatrixView, meta: { perm: 'admin:users' } }
```

`frontend/src/components/AppLayout.vue` 侧边导航（管理分组下，加在"AD 域控清单"之后）：
- 站点复制矩阵 → `/admin/site-replication-matrix`

### 12.7 测试

| 文件 | 用例 |
|---|---|
| `center/tests/dashboard.test.js`（新建） | 站点不存在 → 404；站点无 DC → 空数组；正常站点 → 返回 dcs + links；500 on DB error |
| `frontend/src/views/admin/SiteReplicationMatrixView.spec.js`（新建） | 渲染 site dropdown；切换 site 触发重新拉数据；setInterval cleanup on unmount |

### 12.8 风险与限制（增量）

| # | 风险 | 缓解 |
|---|---|---|
| 7 | 站点无 DC 时显示空矩阵 vs 隐藏站点 | 显示空矩阵 + "暂无 DC"占位（一致性优先） |
| 8 | 站点分配了 DC 但 DC 从未上报 discovery → ad_dcs 中行存在但 discovered_at 为 NULL | 矩阵仍显示 DC，但前端标 "尚未上报元数据" |
| 9 | 自动刷新时如果上一次请求还没回来 → race condition | 用 ref 跟踪当前 siteId，新请求覆盖前 abort 旧的 |
| 10 | setInterval 不清理 → 组件卸载后内存泄漏 | onUnmounted clearInterval（强制要求） |

### 12.9 验收增量

- 8. 手动：浏览器 `/admin/site-replication-matrix`，下拉选站点，矩阵显示
- 9. 手动：观察指示灯，每 10s 拉一次，组件卸载后无遗留请求
- 10. 手动：分配新 DC 到某站点，等 4h 后看矩阵是否包含新 DC

---

## 13. 文档版本

- 2026-07-12 v1: 初版（A+B 子项目）
- 2026-07-12 v2: 合并 G 子项目（站点复制矩阵 + 自动轮询页面）