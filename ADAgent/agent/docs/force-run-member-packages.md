# Member Server 立即跑 member_eventlog_collector + member_os_baseline_collector (R158.98, 2026-10-13)

**真因**: R158.95 (10-13 15:02) 删 950 行 member_eventlog_collector + member_os_baseline_collector package_runs, 删 row 0 删 schedule. member server 0 schedule = 0 上报真因. R158.98 = 0 改 ship, 0 改中心端, 0 改前端, 0 走 migration, 0 schedule 0 必 ship 1.0.1. **唯一交付 = 1 NEW operator 跑 doc** (跟 R158.96 1:1 平行, 让 member server 立即跑 2 包, **0 AD**).

**0 改 ship 内容** (`D:\dashboard\agent\`)
**0 改中心端** (`D:\dashboard\center\`)
**0 改前端** (`D:\dashboard\center\web\`)
**0 走 migration** (DML/DDL 0 涉及)

---

## 前置条件 (跟 C 盘 KDLFLPBISrv 1:1 平行)

1. C 盘 `C:\MemberServer\agent\` 是 member server 真 install 根 (跟 R158.94 ROOT 闭合 1:1 平行, install_root 列持久化)
2. KDLFLPBISrv NSSM service `memberServiceAgent` 在跑 (跟 R158.96 1:1 平行)
3. 中心端 `ADDashboardCenter` 服务在跑 (`http://localhost:8080` + `http://10.170.140.23:8080` API 可达, R158.78 + R158.86 + R158.90 post-hook 端点已存)
4. member_eventlog_collector 1.0.0 + member_os_baseline_collector 1.0.1 ship content 0 必 (跟 R158.78 + R158.86.4 1:1 平行, ship 时已 ship 完)

---

## Operator 跑 3 步 (跟 R158.96 4 步 1:1 平行 precedent, 0 必改 ship)

### Step 1: RDP 到 KDLFLPBISrv (跟 R158.96 1:1 平行, 1 host = 1 operator 操作)

```powershell
# KDLFLPBISrv 上, 用域管理员登录
# 跟 R158.69.3 lesson 3 永远适用: 0 走 A 方案中心编排, 必 operator 手
mstsc /v:KDLFLPBISrv
```

### Step 2: 跑 2 包 collect.ps1 (0 AD, 0 改 ship)

```powershell
# KDLFLPBISrv 上 PowerShell ISE / 终端 admin 跑
# 跟 R158.78 + R158.86 + R158.90 post-hook 1:1 平行, member 包 0 AD 跑

# 2a. member_eventlog_collector 1.0.0 (跟 R158.78 1:1 平行)
$pkg1 = 'C:\MemberServer\agent\packages\member_eventlog_collector\1.0.0\collect.ps1'
& $pkg1

# 2b. member_os_baseline_collector 1.0.1 (跟 R158.86.4 1:1 平行)
$pkg2 = 'C:\MemberServer\agent\packages\member_os_baseline_collector\1.0.1\collect.ps1'
& $pkg2
```

### Step 3: 中心端 post-hook 自动收 (跟 R158.78 + R158.86 1:1 平行, 0 必操作)

```powershell
# 在 KDLFLPBISrv 上跑, 不必回中心端
# member 包 collect.ps1 跑完自动 POST 到中心端:
#   POST http://10.170.140.23:8080/api/agent/packages/report
# 中心端 services/member-eventlog.js + services/member-os-baseline.js post-hook 1:1 走
# 0 必走 AD (跟 R158.78 namespace 平行 ship 1:1 平行)
```

---

## 30 秒后: Verify 4 维度 (跟 R158.96 1:1 平行)

```powershell
# 1. package_runs 2 新行 (跟 R158.95 1:1 平行 verify)
node D:\dashboard\center\scripts\probe-r158-98-member-eventlog-collect-clear.mjs
# 期望:
#   member_eventlog_collector count >= 1 last 15:xx status=success
#   member_os_baseline_collector count >= 1 last 15:xx status=success

# 2. ad_member_eventlog_events 表新行 (跟 R158.78 1:1 平行)
node -e "import('mssql').then(async m => { const sql = m.default; const c = JSON.parse(require('fs').readFileSync('D:/dashboard/center/appsettings.json','utf8')).db.mssql; const p = await sql.connect(c); const r = await p.request().query('SELECT TOP 5 * FROM ad_member_eventlog_events ORDER BY collected_at DESC'); console.log(JSON.stringify(r.recordset, null, 2)); await p.close(); })"
# 期望: >= 1 行 (跟 R158.78 1:1 平行, channel/severity/hostname 全填)

# 3. ad_member_os_baseline 表新行 (跟 R158.86 1:1 平行)
node -e "import('mssql').then(async m => { const sql = m.default; const c = JSON.parse(require('fs').readFileSync('D:/dashboard/center/appsettings.json','utf8')).db.mssql; const p = await sql.connect(c); const r = await p.request().query('SELECT TOP 5 * FROM ad_member_os_baseline ORDER BY collected_at DESC'); console.log(JSON.stringify(r.recordset, null, 2)); await p.close(); })"
# 期望: >= 1 行 (跟 R158.86 + R158.86.4 1:1 平行, 19 字段全填)

# 4. audit_log 实证 2 新 run
node -e "import('mssql').then(async m => { const sql = m.default; const c = JSON.parse(require('fs').readFileSync('D:/dashboard/center/appsettings.json','utf8')).db.mssql; const p = await sql.connect(c); const r = await p.request().query(\"SELECT TOP 5 * FROM package_runs WHERE package_name IN ('member_eventlog_collector', 'member_os_baseline_collector') ORDER BY started_at DESC\"); console.log(JSON.stringify(r.recordset, null, 2)); await p.close(); })"
# 期望: 2 行, exit_code=0, status='success' (跟 R158.78 + R158.86 1:1 平行)
```

---

## 0 改清单 (跟 R158.96 0 改 1:1 平行)

- **0 改 ship 内容** (`D:\dashboard\agent\`)
- **0 改中心端** (`D:\dashboard\center\`)
- **0 改前端** (`D:\dashboard\center\web\`)
- **0 走 migration** (DML/DDL 0 涉及, 跟 R158.95 1-shot 1:1 平行)
- **0 改 appsettings.json**
- **0 走 A 方案中心编排** (R158.69.3 lesson 3 永远适用, 0 fleet 自动, 0 必中心编排)
- **0 走 AD** (跟 R158.78 namespace 平行 ship 1:1 平行, member 包 0 必 AD agent 跑)

---

## 反 pattern (0 这么做)

- **0 走 A 方案中心编排** (R158.69.3 fleet 0 自动 lesson 3 重现, 0 必)
- **0 在 AD agent 上跑 member 包** (R158.78 namespace 平行 ship 1:1 平行, AD 0 必跑 member 包, 跟 R158.86.6 enumerate 5 维度 lesson #7 1:1 平行)
- **0 改 ship 内容** (R158.78 + R158.86 + R158.90 ship 完, 改 ship 跟 R158.78 1:1 平行 ship 冲突)
- **0 改中心端** (R158.78 + R158.86 + R158.90 post-hook 1:1 平行, `services/member-eventlog.js` + `services/member-os-baseline.js` 已 ship 完)
- **0 改前端** (R158.78 + R158.86 + R158.90 前端 UI 1:1 平行, 已显示)
- **0 走 migration** (DML/DDL 0 涉及, 跟 R158.95 1-shot 1:1 平行)
- **0 必 schedule** (R158.95 删 950 行后 0 schedule = 0 必重 ship 1.0.1, 0 schedule 0 必 ship)

---

## 关联 lesson (永远适用)

- **R158.78 namespace 平行 ship**: member 包 0 AD, 跟 AD 包 0 member 1:1 平行 namespace 隔离
- **R158.86 enumerate 5 维度 lesson**: probe 必先 enumerate 5 维度 (schema/中心端 endpoint/前端 UI/agent 端 materialize/agent 端 execute)
- **R158.90 materialize 闭合**: agent 端 instantiate PackageManager 0 必 materialize + execute
- **R158.94 ROOT 闭合**: `__dirname` runtime derive + `install_root` 列持久化 = 任何 install 路径自动正确
- **R158.95 1-shot script**: 删数据走一次性 script, 0 走 migration, 0 走新 endpoint
- **R158.96 任意 install 根 ship 流程**: 4 步 operator ship (Copy-Item + nssm install + nssm set + Restart-Service)
- **R158.69.3 fleet 0 自动 lesson 3**: 永远 0 fleet 自动, 必 operator 手 ship + restart

---

**Why**: R158.95 删 950 行 member_eventlog_collector + member_os_baseline_collector package_runs. 删 row 0 删 schedule, member server 0 schedule = 0 上报真因. R158.98 = 0 改 ship, 0 改中心端, 0 改前端, 唯一交付 = 1 NEW operator 跑 doc, 3 步 RDP + 跑 2 包 collect.ps1 + verify 4 维度. 跟 R158.78 + R158.86 + R158.90 + R158.94 + R158.95 + R158.96 1:1 平行 precedent, 0 走 A 方案, 0 走 AD.

**How to apply**: 未来 member server 0 上报 = 0 schedule 真因, 0 schedule 0 必 ship 1.0.1. 0 必 ship, 0 必改中心端, 0 必改前端. 0 schedule = operator 0 必 RDP 到 member server 手跑 `collect.ps1` 2 包, 中心端 post-hook 自动收. 0 走 AD agent (跟 R158.78 namespace 平行 ship 1:1 平行).
