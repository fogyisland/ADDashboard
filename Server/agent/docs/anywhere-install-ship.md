# 任意 install 根 Member Server Ship 流程 (R158.96, 2026-10-13)

**真因**: 未来 member server 部署根是**任意路径** (`D:\noadagentinstall\` / `E:\member\` / `/opt/member-agent/` / 任何 D 盘 E 盘 Linux 路径). R158.94 已闭合 ROOT 方案 (agent 端 `__dirname` runtime derive + 中心端 `install_root` 列持久化) — 任何 install 路径自动正确, 0 写死, 0 必改 ship, 0 必走 R158.96 specific 目录.

**R158.96 范畴**: 0 改 ship 内容, 0 改中心端, 0 改前端, 0 走 migration. 唯一交付 = 本 doc 4 步 operator ship 流程 (跟 install 根路径**解耦**, 用 `<install_root>` 占位符).

---

## 前置条件 (跟 C 盘 35 DC 1:1 平行)

1. D 盘 source `D:\dashboard\agent\` 是 ship staging source of truth (R158.86.6 5 维度 lesson 永远适用: version.inf + agent.js + build-manifest.json + src/ + publish/)
2. Node.js 装在 `C:\Program Files\nodejs\node.exe` (跟 C 盘 35 DC 1:1 平行)
3. NSSM 在 PATH (跟 C 盘 `memberServiceAgent` 1:1 平行)
4. 中心端 `ADDashboardCenter` 服务在跑 (`http://localhost:8080` API 可达, R158.94 后 self-register 端点 8 placeholders 加载好)
5. C 盘 `appsettings.json` 的 `agentToken` 跟 `centerUrl` 必复制 (跟 C 盘 35 DC precedent 1:1 平行 — 中心端 token 一致)
6. **操作员指定 install 根** = `<install_root>` (任意路径, R158.94 后 0 必是 D:\noadagentinstall 特定目录)

---

## Ship 4 步 (operator 手跑, 跟 R158.91 KDLFLPBISrv 1:1 平行)

### Step 1: Copy-Item D 盘 source → install 根

```powershell
# 跟 R158.86.6 5 维度 lesson 永远适用: D 盘 staging = source of truth
# 跟 C 盘 35 DC ship 1:1 平行 precedent (R158.87.6.5 ship 时 Copy-Item D → C 同 shape)
# <install_root> = 操作员指定的任意路径, e.g. D:\noadagentinstall\, E:\member\, /opt/member-agent/
$src = 'D:\dashboard\agent'
$dst = Join-Path '<install_root>' 'agent'   # 跟 C 盘 C:\MemberServer\agent\ 1:1 平行 (源根 + \agent\)
Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force
```

**`<install_root>` 任意路径都行** (R158.94 后 `__dirname` runtime derive 自动正确). **不**选择性 copy (R158.86.6 5 维度 lesson #3-5: `src/` + `publish/` + `version.inf` + `build-manifest.json` 5 file 漏 = ship 100% 失败).

### Step 2: NSSM install new service

```powershell
# 跟 C 盘 `memberServiceAgent` 1:1 平行, 但新 install 用 `<service_name>` (跟 R158.86.6
# member 命名空间 1:1 平行, 0 污染已存 C 盘 service 名)
# <service_name> = 操作员指定, e.g. memberServiceAgent, noadMemberServiceAgent, eMemberAgent
# 唯一约束 = 0 跟已存 service 名 collision
nssm.exe install <service_name> "C:\Program Files\nodejs\node.exe" "<install_root>\agent\agent.js"
```

### Step 3: NSSM set working dir + logs (跟 C 盘 1:1 平行)

```powershell
# AppDirectory 必设 <install_root>\agent\ (跟 C 盘 C:\MemberServer\agent\ 1:1 平行)
# 不然 __dirname 解析错 (R158.94 ROOT 闭合后 __dirname = NSSM AppDirectory)
nssm.exe set <service_name> AppDirectory <install_root>\agent
nssm.exe set <service_name> AppStdout <install_root>\agent\logs\service-stdout.log
nssm.exe set <service_name> AppStderr <install_root>\agent\logs\service-stderr.log
nssm.exe set <service_name> AppRotateFiles 1
nssm.exe set <service_name> AppRotateBytes 10485760
```

### Step 4: Start service (R158.87.6.5 lesson: 0 restart = 100% 不生效)

```powershell
# R158.87.6.5 critical lesson: ship 装 0.1.5+ 后必 restart agent 进程
# 0 restart = ship 100% 不生效 (R158.94 ship 后 KDLFLPBISrv 真 install 重启后 install_root 才上报)
Restart-Service <service_name>
```

---

## 30 秒后: agent 自动 self-register (R158.94 ROOT 已闭合)

agent 启动后 30s 内自动跑 `POST /api/agent/self-register` (R158.94 ship 改的 body):

```json
{
  "hostname": "<OS hostname>",
  "agentVersion": "0.1.8",
  "osVersion": "<osInfo.version>",
  "ipAddress": "<osInfo.ip>",
  "installRoot": "<install_root>\\agent"
}
```

`<install_root>` 任意路径 (R158.94 后 `__dirname` runtime derive 自动正确报) — 跟 C 盘 `C:\\MemberServer\\agent` 1:1 平行.

中心端 `routes/member-servers.js` self-register handler (R158.94 改的 8 placeholders + COALESCE) UPSERT 到 `ad_member_servers` 表:

```sql
INSERT INTO ad_member_servers
  (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via, install_root)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  install_root = COALESCE(VALUES(install_root), install_root),
  updated_at = UTC_TIMESTAMP()
```

前端 `MemberServersView` + `MemberServerDetailView` (R158.94 改的) 自动显示 "安装路径" = `<install_root>\agent` (跟 C 盘 `C:\MemberServer\agent` 1:1 平行).

---

## Verify 4 维度 (跟 R158.94 KDLFLPBISrv verify 1:1 平行)

1. **NSSM service 跑** (operator 端):
   ```powershell
   Get-Service <service_name> | Select-Object Status, Name
   # Status = Running
   ```

2. **agent 30s 内 self-register 上报** (operator 端):
   ```powershell
   Get-Content <install_root>\agent\logs\service-stderr.log -Tail 50 | Select-String "self-register"
   # 看到 "self-register ok" payload 含 installRoot: <install_root>\agent
   ```

3. **API 实证 installRoot** (operator 端):
   ```powershell
   $login = Invoke-RestMethod -Uri "http://localhost:8080/api/auth/login" -Method Post -Body (@{username="admin";password=$cfg.db.mssql.password} | ConvertTo-Json) -ContentType "application/json"
   $hdr = @{Authorization="Bearer $($login.token)"}
   $r = Invoke-RestMethod -Uri "http://localhost:8080/api/admin/member-servers" -Headers $hdr
   $r.items | Where-Object { $_.install_root -eq "<install_root>\agent" } | Select-Object hostname, install_root
   # 看到新 hostname + install_root = <install_root>\agent
   ```

4. **前端 hard refresh** (operator 端浏览器):
   - 打开 `/admin/member-servers`
   - Ctrl+Shift+R (R158.74.1 lesson: build 后 operator 必 hard refresh, cache 404 是 browser not server)
   - "安装路径" 列显示新 host `<install_root>\agent`

---

## 0 改清单 (跟 R158.94 0 改 1:1 平行)

- **0 改 ship 内容** (R158.94 ROOT 已闭合, `__dirname` 自动 derive, 任意 install 根自动正确)
- **0 改中心端** (R158.94 1.0.17 + UPSERT 8 placeholders + COALESCE 已 ship)
- **0 改前端** (R158.94 MemberServersView + DetailView 已显示 installRoot, 任意 install 根都显示)
- **0 走 migration** (DML/DDL 0 涉及, 跟 R158.95 1-shot script 范畴解耦 1:1 平行)
- **0 改 appsettings.json** (R158.94 后 `agentDataDir` 自动 fallback `__dirname/data`, R158.91 KDLFLPBISrv 显式 override 仍兼容)
- **0 必复用特定 NSSM service 名** (`<service_name>` 任意, 唯一约束 = 0 collision)
- **0 走 A 方案中心编排** (R158.88 directive 适用: 0 fleet 自动 ship 0 适用, 任意 install 根都必手 ship)

---

## `<install_root>` 跟 `<service_name>` 选型 (operator 端)

| 维度 | 约束 | 示例 |
|------|------|------|
| `<install_root>` | 任意路径 (R158.94 ROOT 闭合, 0 必 D:\noadagentinstall 特定目录) | `D:\noadagentinstall\` / `E:\member\` / `F:\` 根 / 任何盘任何目录 |
| `<service_name>` | Windows 服务名, 0 跟已存 collision | `memberServiceAgent` (跟 C 盘 1:1) / `noadMemberServiceAgent` / `eMemberAgent` |
| ship 根路径 | `<install_root>\agent\` (跟 C 盘 `C:\MemberServer\agent\` 1:1 平行, **永远加 `\agent\` 子目录**) | `D:\noadagentinstall\agent\` |

**关键**: `<install_root>` + `agent` 子目录 = `__dirname` runtime derive 路径 (跟 C 盘 1:1 平行 precedent). agent 启动时 `__dirname` = NSSM `AppDirectory` = `<install_root>\agent\`. R158.94 后任何 install 根路径自动正确.

---

## 关联 lesson (永远适用)

- **R158.86.6 enumerate 5 维度 lesson**: D 盘 staging source 5 file 必 1:1 同步 (version.inf + agent.js + build-manifest.json + src/ + publish/), 0 漏
- **R158.87.6.5 restart lesson**: ship 装 0.1.5+ 后必 restart agent 进程, 0 restart = 100% 不生效
- **R158.69.3 fleet 0 自动 lesson 3**: 永远 0 fleet 自动, 必 operator 手 ship + restart
- **R158.94 ROOT 闭合 lesson**: `__dirname` runtime derive + `install_root` 列持久化 = 任何 install 路径自动正确, 0 写死
- **R158.91 KDLFLPBISrv precedent**: C 盘真 install 跟任意 install 根 ship 1:1 平行, 唯一差异是 install 根路径
- **R158.74.1 hard refresh lesson**: 前端 build 后 operator 必 hard refresh, cache 404 是 browser not server

---

## 反 pattern (0 这么做)

- **0 直接搬 C 盘 `C:\MemberServer\agent\`** (跟 R158.94 ROOT 闭合 1:1 平行, 必 Copy-Item D 盘 staging source = source of truth)
- **0 在新 install 根直接 `git clone` 然后 ship** (跟 R158.86.6 5 维度 lesson 不一致, D 盘 staging = `D:\dashboard\agent\`, 0 是 `<install_root>\agent\`)
- **0 同时跑多个新 install (批量 ship)** (跟 R158.69.3 lesson 3 永远适用, 1 host = 1 operator 操作)
- **0 改 ship 内容 (`D:\dashboard\agent\`)** (R158.94 ROOT 已闭合, 改 ship 跟 R158.94 1:1 平行 ship 冲突)
- **0 中心端手改 `ad_member_servers.install_root`** (R158.94 闭合后 agent self-register 自动报, 中心端手改 = R158.86.5.2 COALESCE precedent 1:1 平行, agent 重发不覆盖, 但 0 必)
- **0 复用已存 NSSM service 名 (collision)** (新 install 必新 service 名, 跟 R158.86.6 member 命名空间 1:1 平行)

---

**Why**: R158.96 = R158.94 ROOT 闭合后 operator 端 ship 流程 doc, 0 改 ship, 0 改中心端, 0 改前端. **任意 install 根路径** (C 盘 / D 盘 / E 盘 / Linux / 任意位置) 1:1 平行 ship.

**How to apply**: 未来 ship 1 个新 install 走 4 步 (Copy-Item + nssm install + nssm set + Restart-Service). `<install_root>` 跟 `<service_name>` 操作员指定, 唯一约束 = 0 collision. 30s 内 self-register 自动报 hostname + installRoot, 中心端 + 前端 0 必动.
