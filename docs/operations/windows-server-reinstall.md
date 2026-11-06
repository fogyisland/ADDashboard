# Runbook — Windows Server 重装（卸载 → 清理 → 重装 → 验证）

> **目的**: 把一台已经装过 AD Dashboard 的 Windows Server 恢复成"干净可重装"的状态，
> 或者在**不动数据库**的前提下只换程序文件。
>
> **何时需要**:
> - 装坏了，要推倒重来（安装链中途失败、服务起不来、dist 缺文件）
> - 要换数据库 / 换机器 / 重新初始化（init 向导要重跑）
> - 要做"程序升级但保留数据"的滚动替换
>
> **何时不需要**:
> - 只是改前端或后端代码 ⇒ 走 `Server/scripts/upgrade-center.ps1` 或
>   `Server/scripts/update-center.ps1`（**不要**卸载重装，卸载会丢运行期状态）
> - 只是要补跑数据库迁移 ⇒ 走 `docs/runbooks/apply-pending-migrations.md`
> - 仅仅是服务起不来 ⇒ 先看 `Server/center/Logs/center.<date>.<n>.log`，
>   重装会**掩盖**真正的错误
>
> **本文覆盖的组件**（本机装了什么，就只做哪几节）:

> | 组件 | Windows 服务名 | 装它的脚本 | 卸载脚本 |
> |---|---|---|---|
> | 中心端 Center | `ADDashboardCenter` | `Server/scripts/install-center.ps1`<br>`Server/center/deploy/install-service.ps1` | `Server/scripts/uninstall-center.ps1`<br>`Server/center/deploy/uninstall-service.ps1` |
> | 探针 Agent | `ADReplicationAgent` | `ADAgent/install-agent.ps1`<br>`MemberAgent/install-agent.ps1`<br>`Server/scripts/install-agent.ps1` | `ADAgent/uninstall-agent.ps1`<br>`MemberAgent/uninstall-agent.ps1`<br>`Server/scripts/uninstall-agent.ps1` |
> | 日志清理计划任务 | —（计划任务） | `ADAgent/Register-ADDashboardAgent.ps1`<br>`MemberAgent/Register-ADDashboardAgent.ps1` | **无**（★ 见 Step 1.3，必须手工摘） |

> ⚠️ **两个绿包用的是同一个服务名 `ADReplicationAgent`** ⇒ 同一台机器上
> `ADAgent/` 和 `MemberAgent/` **不能共存**，装第二个会把第一个顶掉。
> 一台机器只装一个。

---

## 目录约定

本文用**服务器上的落地路径**说话。开发树 `D:\ToolDevelop\ADDashboard` 的布局是
`Server/` `LinuxServer/` `ADAgent/` `MemberAgent/`；发到服务器上的**中心端绿色包**
根目录记作 `<ROOT>`，本文用：

| 记号 | 含义 | 默认值 |
|---|---|---|
| `<ROOT>` | 中心端绿色包根（`scripts/` 的上一级） | 例如 `D:\ADDashboardCenter` |
| `<INSTALL>` | Center 服务的 AppDirectory | `<ROOT>\Center` |
| `<AGENT>` | Agent 服务的 AppDirectory | 绿包内的 `agent/` 目录 |

> ⚠️ **Windows 大小写不敏感** ⇒ `<ROOT>\Center` 与 `<ROOT>\center` 是**同一个物理目录**。
> 开发树里中心端源码就在 `Server\center\`，默认安装路径是 `Server\Center\`
> —— 两者指向同一处。这条是后面 Step 2「卸载后文件还在」的根本原因。

---

## Step 0 — 现场探查（先查，别先删）

在**目标服务器**上以管理员 PowerShell 执行。先看清楚装了什么，再决定删什么。

```powershell
# 0.1 —— 两个 Windows 服务
Get-Service -Name 'ADDashboardCenter','ADReplicationAgent' -ErrorAction SilentlyContinue |
  Select-Object Name, Status, StartType

# 0.2 —— 计划任务（卸载脚本不会摘它，Step 1.3 要用）
Get-ScheduledTask -TaskName 'ADDashboardAgent-LogRetention' -ErrorAction SilentlyContinue |
  Select-Object TaskName, State

# 0.3 —— 端口占用（8080 是默认端口；被占 ⇒ 服务起来后探针必然失败）
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess

# 0.4 —— 找到 nssm.exe（卸载服务要用它）
$nssm = @(
  "$ROOT\nssm\nssm.exe",
  "$ROOT\scripts\..\nssm\nssm.exe",
  'C:\Tools\nssm\win64\nssm.exe',
  'C:\Tools\nssm-2.24\win64\nssm.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
"nssm: $nssm"
```

> ⚠️ **nssm 的 stdout 是 UTF-16LE**（实测字节 `53 00 45 00 52 00 ...`）。
> 所以 `nssm status <svc> | Select-String 'SERVICE_RUNNING'` 在 PowerShell 里
> **永远匹配不上** —— 那是编码问题，不是服务没跑。判断服务状态请用
> `Get-Service`，或者把 nssm 输出先转码：
> ```powershell
> $raw = & $nssm status ADDashboardCenter | Out-String
> $txt = [System.Text.Encoding]::Unicode.GetString(
>   [System.Text.Encoding]::Default.GetBytes($raw)).Trim([char]0)
> ```

**记下三件事**，Step 3 决定数据库去留时要用：
1. `<INSTALL>` 的实际路径（服务注册在哪）
2. 数据库连接指向哪个库（见 Step 3，**不要**把口令抄到本文档或截图里）
3. 这台机器上还有没有别的 AD Dashboard 组件

---

## Step 1 — 停止并卸载 Windows 服务

> 顺序很重要：**先卸载服务，再删文件**。反过来的话 NSSM 还在守护一个
> 不存在的目录，服务会以秒级节奏崩溃重启，直到你手工摘掉它。

### 1.1 Center 服务

**方式 A —— 走仓库里的卸载脚本（推荐）**

```powershell
cd <ROOT>\scripts
powershell -ExecutionPolicy Bypass -File .\uninstall-center.ps1
```

这个脚本会：摘服务（`Stop-ServiceSafe` + `nssm remove`）→ 判断安装路径是不是
源码树 → **不是**源码树才删目录。

> ⚠️ **默认情况下文件会留在盘上，这是设计如此，不是失败。**
> `uninstall-center.ps1` 的默认 `-InstallPath` 是 `<ROOT>\Center`，而它比对
> 的"源码树"是 `<ROOT>\center` —— Windows 大小写不敏感 ⇒ **判定为同一路径**
> ⇒ 走"保留文件"分支，只摘服务。要连目录一起清，**手工删**（Step 4）。
>
> 脚本会打印这一行来告诉你它走了哪条路：
> `kept: src/ web/ dist/ node_modules/ appsettings.json (green package stays intact; remove the folder by hand for a clean wipe)`
>
> **这正是 2026-10-25 那场事故的补丁**：旧实现无条件 `Remove-Item -Recurse`，
> 一次卸载把整个 `center\`（含 `dist/index.html`）删光。

**方式 B —— 走 deploy/ 那套 5 脚本周期**

```powershell
cd <INSTALL>\deploy
powershell -ExecutionPolicy Bypass -File .\uninstall-service.ps1 -Force
```

`-Force` 的差别：带 `-Force` 会连 `<INSTALL>\Logs` 一起删；不带则保留日志目录
（默认）。**这个脚本的 `-Force` 不删 `.env` / `node_modules` / `src` / `dist`**，
删目录仍然要手工（Step 4）。

**方式 C —— 纯手工（脚本不在手边时）**

```powershell
# 停
Stop-Service -Name 'ADDashboardCenter' -Force -ErrorAction SilentlyContinue
# 摘（★ confirm 是必需参数，漏了 nssm 会进入交互等待）
& $nssm remove ADDashboardCenter confirm
# 验证
Get-Service -Name 'ADDashboardCenter' -ErrorAction SilentlyContinue
```

> ⚠️ `nssm remove <svc> confirm` 的 `confirm` **不能省**。省掉它 nssm 会
> 弹一个交互式提问，在无人值守的脚本里就是**卡死在那儿等输入**。
> 仓库里的 `Service.psm1::Remove-ServiceSafe` 用的就是 `remove $Name confirm`。

### 1.2 Agent 服务

```powershell
# 绿包（ADAgent/ 或 MemberAgent/，二者取其一）
cd <AGENT>
powershell -ExecutionPolicy Bypass -File .\uninstall-agent.ps1

# 或者开发树侧的
cd <ROOT>\scripts
powershell -ExecutionPolicy Bypass -File .\uninstall-agent.ps1
```

手工版同上，服务名换成 `ADReplicationAgent`。

> 绿包的 `uninstall-agent.ps1` 与 center 版**同一条守卫**：安装路径 == 绿包自身
> 目录时，**只摘服务、文件保留**。这是为了不把 `install-agent.ps1` 自己删掉
> （删了就没法再装了）。

### 1.3 计划任务 ★ 必须手工摘

> ⚠️ **这是本 runbook 存在的原因之一**：仓库里 **5 个卸载脚本没有一個**
> 会摘 `ADDashboardAgent-LogRetention`（已逐个 grep 确认：均为 0 处）。
> 它由 `Register-ADDashboardAgent.ps1` 注册、由 `LogRetention.ps1` 执行，
> 卸载脚本只管 SCM 侧的服务，**不管任务计划**。
>
> 后果：重装后这个任务还在，按原计划跑 `LogRetention.ps1`，
> 而它指向的 `<AGENT>\Logs` 可能已经不存在 ⇒ 每次触发都报错，
> 事件查看器里刷一片失败记录。

```powershell
# 看清它指向哪
Get-ScheduledTask -TaskName 'ADDashboardAgent-LogRetention' -ErrorAction SilentlyContinue |
  Select-Object TaskName, State,
    @{n='Execute';e={$_.Actions.Execute}},
    @{n='Arguments';e={$_.Actions.Arguments}}

# 摘掉
Unregister-ScheduledTask -TaskName 'ADDashboardAgent-LogRetention' -Confirm:$false

# 验证
Get-ScheduledTask -TaskName 'ADDashboardAgent-LogRetention' -ErrorAction SilentlyContinue
# 期望: 无输出
```

---

## Step 2 — 删什么 / 留什么（决策表）

| 对象 | 路径 | 删? | 说明 |
|---|---|---|---|
| Center 服务注册 | SCM | ✅ 删 | Step 1.1 |
| Agent 服务注册 | SCM | ✅ 删 | Step 1.2 |
| 计划任务 | Task Scheduler | ✅ 删 | Step 1.3（**脚本不删**） |
| 程序目录 | `<INSTALL>\src` `web` `dist` `node_modules` | ✅ 删 | Step 4 |
| 依赖指纹 | `<INSTALL>\.install-hash` | ✅ 删 | 留着会让下次安装**跳过** `npm install` ⇒ 带着上一版依赖启动 ⇒ 崩溃重启循环 |
| 配置 | `<INSTALL>\appsettings.json` | ⚠️ 见下 | **含 `db.password` / `jwtSecret` / `agentToken` / `signature`** |
| 试用锚点 | `appsettings.json` 的 `installedAt` + `signature` | ⚠️ 见下 | 决定"本地送 30 天试用"从哪天算起 |
| 运行期状态 | `<INSTALL>\data\`（`instance_id` / `license-requests` / `packages` / `file-push`） | ⚠️ 见下 | `instance_id` **删了不能改**（与许可证绑定） |
| 日志 | `<INSTALL>\Logs\`（`center.<date>.<n>.log` / `APP\` / `FEATURE\`） | ⚠️ 可选 | 排查问题时先留着 |
| 绿包自身 | `<ROOT>\scripts` `common` `nssm` `node` | ❌ **别删** | 删了就没法重装了（除非你还有副本） |
| 数据库 | 见 Step 3 | ⚠️ 见下 | |
| Node.js | 系统级 | ❌ 别删 | 重装还要用 |

### 三个必须由人拍板的问题

**① `appsettings.json` 删不删？**

- **删** ⇒ 重装后走 init 向导重新填连接参数，**`installedAt`/`signature` 归零**
  ⇒ 30 天试用重新从今天算 ⇒ **等于白送一个新的试用周期**。
- **留** ⇒ 试用起点延续原锚点，不重送试用。

> ⚠️ `appsettings.json` 里有 `db.password` / `jwtSecret` / `agentToken`。
> 删之前**先把它备份到目标机之外的地方**（或者你确定要全部重来），
> 并且**不要**把内容贴进聊天记录 / 工单 / 截图。

**② `data\instance_id` 删不删？**

这是这台机器的**身份**。它跟许可证绑定，也参与 agent 注册。删了它 =
这台机器在 center 侧变成一台**新机器** ⇒ 已发的许可证可能对不上。
除非你就是要把它当新机器，否则**保留**。

**③ 数据库留不留？** → Step 3。

---

## Step 3 — 数据库处置

> ⚠️ 这一节**没有一键脚本**，因为"删库"和"删表"的代价差三个数量级。
> 下面每条命令都要求**先备份**。

### 3.1 先看现状（不打印任何口令值）

```powershell
# 连接参数从 appsettings.json 读，口令不落在命令行、不进历史、不进日志
cd <INSTALL>
node -e "const m=require('mysql2/promise');(async()=>{
  const fs=require('fs');
  const cfg=JSON.parse(fs.readFileSync('appsettings.json','utf8')).db;
  const c=await m.createConnection({host:cfg.mysql.host,port:cfg.mysql.port,user:cfg.mysql.user,password:cfg.mysql.password,database:cfg.mysql.database});
  const [v]=await c.query('SELECT VERSION() v');
  const [t]=await c.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=?',[cfg.mysql.database]);
  const [m2]=await c.query('SELECT version,status FROM schema_migrations ORDER BY version');
  console.log('server  :',v[0].v);
  console.log('tables  :',t[0].n);
  console.log('migrat. :',m2.map(r=>r.version+'='+r.status).join(' '));
  await c.end();
})().catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```

> 注意 **`SELECT VERSION()`** —— 操作员当前的真库是 **MySQL 5.7.44**。
> 本项目的历史基线锁在 MSSQL，MySQL 分支**从未在生产跑过**，5.7 上有一批
> 语法不兼容（窗口函数 / CTE / `ADD COLUMN IF NOT EXISTS`）。
> **新建库**之前先看这个版本号，别拿 5.7 当 8.0 用。

### 3.2 三种处置

| 方案 | 做什么 | 适用 |
|---|---|---|
| **A. 保留库，只换程序**（最常用） | 什么都不动，只重装程序 | 换代码 / 修 bug / 改前端 |
| **B. 保留数据，重置 schema** | 删业务表，保留库和账号 | 想要干净 schema 但不想重建库和授权 |
| **C. 整个库删掉重来** | `DROP DATABASE` + 重建 | 真的要彻底重置（init 向导重跑） |

**方案 A —— 保留库**（默认，强烈推荐先走这条）

什么数据库命令都不用执行。装完直接走 Step 5，init 向导会检测到库已存在，
跳过建库，只做迁移。

**方案 B —— 只删表**（MySQL 5.7 语法）

```sql
-- ★ 先备份！mysqldump 出来再动
-- mysqldump -h <host> -P <port> -u <user> -p <database> > backup_<date>.sql

-- 用 information_schema 生成 DROP 语句（只删当前库的表，不碰别的库）
SELECT CONCAT('DROP TABLE IF EXISTS `', table_name, '`;')
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE';

-- 把上面查出来的语句逐条执行，或导出到 .sql 再跑
```

> ⚠️ 别用 `DROP DATABASE` 之后再 `CREATE DATABASE` 的方式做方案 B ——
> 那会把授权/权限一起干掉，MySQL 的库级授权是绑在库名上的。

**方案 C —— 整个库删掉**

```sql
DROP DATABASE <database_name>;
CREATE DATABASE <database_name> CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

删完**必须**重新给账号授权（用户还在，库级授权没了）：

```sql
GRANT ALL PRIVILEGES ON <database_name>.* TO '<user>'@'<host>';
FLUSH PRIVILEGES;
```

> ⚠️ `DROP DATABASE` 之后，center 的 `schema_migrations` 表也没了 ⇒
> 迁移会**从头重跑**全部 migration + baseline。这是重置，不是"跳过"。
> 确认过再执行。

---

## Step 4 — 清理文件目录

前提：Step 1 的服务**已经摘干净**（`Get-Service` 查不到）。

```powershell
# 4.1 —— 确认服务确实没了（必须无输出）
Get-Service -Name 'ADDashboardCenter','ADReplicationAgent' -ErrorAction SilentlyContinue

# 4.2 —— 确认计划任务没了（必须无输出）
Get-ScheduledTask -TaskName 'ADDashboardAgent-LogRetention' -ErrorAction SilentlyContinue

# 4.3 —— 删程序目录
#      ⚠️ 路径务必写全、写死，不要用变量拼盘根
Remove-Item -LiteralPath '<INSTALL>' -Recurse -Force
```

> ⚠️ **`Remove-Item -LiteralPath 'D:\' -Recurse -Force` 是灾难性的。**
> 仓库的卸载脚本里有盘根护栏（`ConvertTo-ComparablePath` + `^[a-z]:$` 匹配就
> `throw`），但那是脚本护栏 —— **手工敲命令没有这层保护**。
> 执行前把路径念一遍，确认不是盘根、不是 `C:\`、不是 `D:\`。

### 要不要删 `data\` 和 `Logs\`？

- `Logs\` —— **先别删**。它是这次重装唯一的排障证据（服务为什么没起来、
  初始化卡在哪一步）。重装成功之后再删。
- `data\` —— 按 Step 2 的问题②定。`instance_id` 建议留。

---

## Step 5 — 重装

### 5.1 前置检查

```powershell
# Node.js —— 中心端**必须在 PATH 上**
#   install-center.ps1:139 做的是 (Get-Command node.exe -ErrorAction Stop)
#   start.ps1:185-186 同理，找不到就 exit 1
node -v
# nssm
Get-ChildItem 'C:\Tools\nssm*\win64\nssm.exe','<ROOT>\nssm\nssm.exe' -ErrorAction SilentlyContinue
```

> **中心端必须预装 Node.js**。开发树的 `Server/node/` 里**只有 corepack，
> 没有 `node.exe`** ⇒ 中心端没有自带运行时，`install-center.ps1:139` 的
> `Get-Command node.exe` 只能从 PATH 上找。
> **Agent 端不需要** —— Agent 绿包自带**完整**的 Node 20 LTS 在 `<green>/node/`
> （含 `node.exe`），自包含。
>
> 中心端构建前端需要 **vite**，它在 `node_modules` 里且是 devDependency ——
> 生产机上如果只跑过 `npm install --omit=dev`，vite 会被剪掉 ⇒
> `npm run build:web` 报 "vite: not found"。`install-center.ps1` 会自动补装
> `npm install --workspace=center --include=dev`，但**离线机**上这一步会失败
> ⇒ 离线机请预置好 `node_modules` 或本地 npm 缓存。

### 5.2 装中心端

**推荐入口：`start.ps1`**（一个命令装或更新，脚本自己判断当前状态）

```powershell
cd <ROOT>                      # 绿色包根（含 start.ps1 / scripts/ / center/）
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

- **服务未注册** ⇒ 首次安装：`npm run build:web` 重建 dist
  （**包内没有 `center/web/` 源码时会跳过重建**，直接用随包 dist）→
  `install-center.ps1 -InPlace`（服务直接指向 `<ROOT>\center`，**不复制文件**）→
  启动 → 探针 `/api/init/status`
- **服务已注册** ⇒ 更新：重建 dist → `POST /api/system/update`
  （应用待执行迁移 + 干净退出，NSSM 带新代码和新 dist 重启）
  探针不可达时回落到"直接重启服务"，迁移由服务自身启动时补上

> 构建脚本名按包根 `package.json` 探测，顺序是 `build` → `build:web` →
> `build:frontend`（`Server/` 与 `LinuxServer/` 都是 `build:web`）。

**直接调安装脚本**（不走统一入口时）

```powershell
cd <ROOT>\scripts
powershell -ExecutionPolicy Bypass -File .\install-center.ps1 -InPlace -ListenPort 8080
```

不带 `-InPlace` 时脚本走**完整部署流程**：建目录 → 校验 node → 构建前端（缺 vite 时
先补装 dev 依赖）→ **停旧服务** → 拷文件（排除 `node_modules` / `tests` /
`appsettings.json` / `.install-hash` / `Logs`）→ 装依赖 → 写 `signature`+`installedAt`
→ 注册 NSSM → 配服务恢复策略 → 启动 → 探针。

> ⚠️ **它会先停掉正在跑的服务**再覆盖文件。旧实现不停服 ⇒ `server.js` /
> `dist` 被就地覆盖而进程还在跑 ⇒ **跑的还是旧代码**，但脚本照样打印
> "service started"、探针照样返 200 ⇒ 全绿而新版从未生效。
> 现在这一步是先做停服，做不到就**拒绝覆盖**。

**走 deploy/ 5 脚本周期**（另一种等价链）

```powershell
cd <INSTALL>\deploy
powershell -ExecutionPolicy Bypass -File .\install-service.ps1
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Wait
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

### 5.3 装 Agent（如果这台机器要跑探针）

**推荐入口：`start.ps1`**（交互式问 CenterUrl / AgentToken，token 不回显）

```powershell
cd <AGENT>            # ADAgent/ 或 MemberAgent/，取其一
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

**非交互调用**（脚本化 / 机群装机）

```powershell
cd <AGENT>
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 `
  -ComputerName localhost `
  -CenterUrl 'http://<center-host>:8080' `
  -AgentToken '<token>' `
  -AgentType ad
```

> ⚠️ **`-ComputerName` 是必填参数**。传 `localhost` / `.` / 本机主机名
> ⇒ 走本地安装分支（`install-agent.ps1:357-359`）；传别的机器名 ⇒ 走
> `New-PSSession` + WinRM 远程安装（需要 WinRM 可达 + 凭据）。
>
> ⚠️ **`-AgentType` 两个绿包都默认 `'ad'`**（DC 采集器）。
> 装 **MemberAgent（会员服务器）必须显式写 `-AgentType non-ad`**，
> 否则装成 DC 采集器 —— 服务能起来、能注册，但采的是 DC 复制数据。
> `ad` ⇒ DisplayName "AD Replication Agent (on <host>)"；
> `non-ad` ⇒ "AD Dashboard Agent (Member)"，并把 agentType 写进 appsettings.json。
>
> `AgentToken` 必须跟 center 端 `appsettings.json` 里的 `agentToken` 一致，
> 否则 agent 上来会被 401（**"missing token"** 的指纹）。
>
> Agent 绿包**自带 Node.js 20 LTS**（`<green>/node/`），目标机不必预装 Node；
> 但**需要能访问 npm registry**（绿包不打包 `node_modules`，装的时候现场
> `npm install --omit=dev`）。空气隔离环境请先配好内网镜像或 `.npmrc`。

### 5.4 重装后首次初始化

浏览器打开 `http://<host>:8080/init`，走 init 向导。

- 库已存在（方案 A）⇒ 向导**跳过建库**，只做迁移 + 建管理员
- 库被删了（方案 C）⇒ 向导**从头建**，5.7 上注意语法兼容

---

## Step 6 — 验证清单

重装完逐条打勾。**任何一条不过，先看日志，不要立刻再装一遍**（重装会掩盖错误）。

```powershell
# 6.1 服务在跑
Get-Service -Name 'ADDashboardCenter' -ErrorAction SilentlyContinue |
  Select-Object Name, Status, StartType
# 期望: Status = Running, StartType = Automatic

# 6.2 HTTP 起来了
Invoke-WebRequest 'http://localhost:8080/api/init/status' -UseBasicParsing | Select-Object StatusCode
# 期望: 200

# 6.3 日志有内容（说明 pino 在写，不是空目录）
Get-ChildItem '<INSTALL>\Logs\center.*.log' | Select-Object Name, Length, LastWriteTime
# 期望: 有文件且 Length > 0

# 6.4 计划任务状态正确
Get-ScheduledTask -TaskName 'ADDashboardAgent-LogRetention' -ErrorAction SilentlyContinue |
  Select-Object TaskName, State
# 期望: 装了 agent 就有 (State = Ready); 没装 agent 就没有
```

浏览器侧（**硬刷新 Ctrl+F5**，前端 dist 变了要刷）：

- [ ] `http://<host>:8080/` 打得开
- [ ] 功能开关页能看到全部开关，且**打开「活动目录日常管理」后首页出现对应入口**
      （开关语义是 fail-open：缺 key = 放行，不是关闭）
- [ ] 许可证页的「当前许可证状态」显示**正式授权**和**本地试用**两行
      （默认安装自动送 30 天试用，试用起点锚在 `installedAt`）
- [ ] 前台页面有数据（不是空表）

---

## 常见坑（都是真踩过的）

| # | 现象 | 真因 | 处理 |
|---|---|---|---|
| 1 | 卸载完**目录还在**，像没卸 | 卸载脚本的"源码树守卫"：安装路径 == 源码树时**故意保留文件**（防误删） | 手工删目录（Step 4） |
| 2 | 卸载脚本**一条日志都没落盘** | 日志目录设在待删目录内部 ⇒ `Add-Content` 抛 `DirectoryNotFound` | 现在的脚本已把日志目录挪到删除范围外；老版本脚本仍需手工看控制台 |
| 3 | `nssm set <svc> AppStderr ''` 报错退出 | **NSSM 2.24 没有空值语法** | 用 `nssm reset <svc> AppStderr`（= 不重定向） |
| 4 | `nssm status` 明明在跑，`-match 'SERVICE_RUNNING'` 永远为假 | nssm 的 stdout 是 **UTF-16LE** | 转码后再匹配；或直接用 `Get-Service` |
| 5 | 服务起不来，报 **"vite: not found"** | `npm install --omit=dev` 把根 `node_modules` 里的 vite 剪掉了 | 装之前先 `npm install --workspace=center --include=dev` |
| 6 | 服务起来了但跑的是**旧代码** | 覆盖文件前没停服，node 已把模块 require 完 | 现在的安装链会先停服；老脚本请手工先停 |
| 7 | 重装后**依赖没装**（带着上一版依赖启动 → 崩溃循环） | `.install-hash` 被源树副本覆盖 ⇒ 新旧哈希恒等 ⇒ `needsInstall` 恒 false | 删 `<INSTALL>\.install-hash`；拷贝时排除它 |
| 8 | 卸载后**计划任务还在** | 5 个卸载脚本**都不**摘任务 | 手工 `Unregister-ScheduledTask`（Step 1.3） |
| 9 | `nssm remove` 卡住不动 | 漏了 `confirm` 参数 ⇒ nssm 在等交互输入 | `nssm remove <svc> confirm` |
| 10 | 装 `MemberAgent` 把 `ADAgent` 顶掉了 | 两个绿包**共用**服务名 `ADReplicationAgent` | 一台机器只装一个 |
| 11 | 装了 MemberAgent 却采的是 DC 数据 | `-AgentType` 两个绿包**都默认 `'ad'`** | 会员服务器显式写 `-AgentType non-ad` |
| 12 | `install-agent.ps1` 报"缺少必填参数 ComputerName" | `-ComputerName` 是必填 | 本机装传 `-ComputerName localhost` |
| 13 | init 报 **ER_DUP_FIELDNAME (1060)** | 并发 apply（探针与 ALTER 非原子） | 串行重跑；前端 timeout 要 > 后端长任务耗时 |
| 14 | init 报 **errno 150** | 内联外键的父表还没建 | 按 `check-fk-order.mjs` 的顺序排 |
| 15 | init 报 **key was too long (3072B)** | 声明宽度超限（空表都建不出来） | 双方言改哈希列 `BINARY(32)` |
| 16 | `INSERT` 报 **ER 1292** | MySQL DATETIME 列绑了 ISO 字符串 | 调用侧用 `toMysqlDatetime()`（**不要**在 driver 层兜底） |
| 17 | agent 上来就 **401 missing token** | token 与 center 端不一致，或 center 跑的是旧二进制 | 核对 `agentToken`；核对 center 版本 |
| 18 | 服务起来但探针一直不通 | 8080 被别的进程占了 | `Get-NetTCPConnection -LocalPort 8080` |
| 19 | 改了 `center/package.json` 之后离线机重装报废 | `.install-hash` 机制 ⇒ 目标机删 `node_modules` 重跑 `npm install`（离线机挂） | **不要动 `center/package.json`** |

---

## 附：本文的事实来源

写这份文档时，脚本与配置是**逐个核对过的**，不是照着旧文档抄的：

| 事实 | 出处 |
|---|---|
| 服务名 `ADDashboardCenter` | `Server/scripts/install-center.ps1:296`、`Server/center/deploy/install-service.ps1:25` |
| 服务名 `ADReplicationAgent` | `ADAgent/Register-ADDashboardAgent.ps1:133`、`MemberAgent/Register-ADDashboardAgent.ps1:133`、`Server/scripts/Register-ADDashboardAgent.ps1:154` |
| 计划任务名 `ADDashboardAgent-LogRetention` | `ADAgent/Register-ADDashboardAgent.ps1:275` |
| 卸载不摘计划任务 | 5 个卸载脚本 grep `ScheduledTask` 均为 0 处 |
| 源码树守卫（卸载保留文件） | `Server/scripts/uninstall-center.ps1:91`（`Test-SamePath`） |
| 盘根护栏 | `Server/scripts/uninstall-center.ps1:96-99` |
| `nssm remove ... confirm` | `Server/scripts/common/Service.psm1:313` |
| nssm 查找顺序 | `Server/scripts/common/NSSM.psm1:68-75` |
| `AppStderr` 空值不存在 | `Server/scripts/install-center.ps1:304-320` |
| 端口 8080 | `Server/center/appsettings.json:12`、`install-center.ps1:9` |
| 两绿包同服务名 | `ADAgent/` 与 `MemberAgent/` 的 `Register-ADDashboardAgent.ps1:133` |
| `-ComputerName` 必填 / 本地 vs 远程分流 | `ADAgent/install-agent.ps1:5`（Mandatory）、`:357-359`（`localhost`/`.`/本机名 ⇒ 本地分支） |
| `-AgentType` 默认 `'ad'` | `ADAgent/install-agent.ps1:15`、`MemberAgent/install-agent.ps1:15` |
| 中心端 Node 必须在 PATH | `Server/scripts/install-center.ps1:139`、`Server/start.ps1:185` |
| 中心端无自带 node.exe | `Server/node/`（仅 corepack，**无** `node.exe`）；`ADAgent/node/` 才有 `node.exe` |
| 构建脚本探测顺序 | `Server/start.ps1`（`Get-BuildScriptName`：`build` → `build:web` → `build:frontend`） |
| 统一入口 `start.ps1`（装 or 更新） | `Server/start.ps1`（`:211` 调 `install-center.ps1 -InPlace`） |
| Agent 统一入口 `start.ps1` | `ADAgent/README-green-install.md:11-24` |
| Agent 绿包自带 Node 20 | `ADAgent/README-green-install.md:34` |
| appsettings 键名 | `Server/center/appsettings.json`（`db.*` / `jwtSecret` / `agentToken` / `signature` / `installedAt`） |
| 30 天试用 | `Server/center/src/services/license-state.js:38`（`TRIAL_DAYS = 30`） |
