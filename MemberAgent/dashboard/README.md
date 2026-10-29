# Dashboard

本地只读监控面板 — 用浏览器看 `D:\agentInstall\` 的:
- 采集计划(包定义 + 调度 + manifest)
- 采集脚本(collect.ps1 源码)
- 最近报表(每个包最近一次 collect 的输出)
- 运行日志(`Logs/` + `agent/Logs/`)
- 服务状态(`Get-Service memberServiceAgent`)

零第三方依赖(Node 20+ 内置 `http` / `fs` / `crypto` / `child_process`)。
单文件 `server.js`,前端 HTML/CSS/JS 内嵌。

## 启动

```powershell
cd D:\agentInstall
.\start-dashboard.ps1
```

默认端口、用户名、密码在 `agent/appsettings.json` 中定义:

```json
{
  "username": "admin",
  "password": "YWRtaW4=",    // base64('admin')
  "port": 8080,
  "dashboardEnabled": true
}
```

启动器优先级: `start-dashboard.ps1 -Port N` > `appsettings.json` 的 `port` > 默认 8080。

## 修改默认密码

### 浏览器改密码

登录后在顶部 **密码** tab 里:
1. 输入当前密码
2. 输入新密码(4-128 字符)
3. 再次输入新密码
4. 点 **保存**

成功后立即生效,不需要重启 agent 也不需要重新登录。底层把新密码 base64
编码后原子写回 `agent/appsettings.json` 的 `password` 字段,其他字段(端口、
center URL、agentId 等)保持不变。

### 命令行改密码

```powershell
$plain = 'YourStrongPassword'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain))
# 把 $b64 写到 agent/appsettings.json 的 password 字段
```

> 也可以直接用 `node`:
> ```js
> const fs = require('fs/promises');
> const p = 'D:/agentInstall/agent/appsettings.json';
> const o = JSON.parse(await fs.readFile(p, 'utf8'));
> o.password = Buffer.from('YourStrongPassword', 'utf8').toString('base64');
> await fs.writeFile(p, JSON.stringify(o, null, 2));
> ```

⚠️ **base64 不是真正的加密** — 它只是掩饰,任何能读到这个文件的人都能解码。
dashboard 默认绑定 `127.0.0.1`,不暴露到 LAN,所以风险有限;但生产环境如要
LAN 访问,请:
1. 改用更强密码
2. 在 dashboard 前加 reverse-proxy (HTTPS + 真正的 auth)

## 首次访问

1. 浏览器打开 `http://127.0.0.1:8080/`
2. 跳到登录页,输入 `admin` / `admin`(或你改过的密码)
3. 登录后 30 秒自动刷新整页(简单粗暴)

## 显示的内容

### 概览

- 服务状态(运行 / 停止 / 未安装)
- 包计数(总包数 / 已激活版本数)
- 最近报表数(来自 `agent/data/last-collect/`)
- centerUrl / agentId / 启动时间

### 密码

- 修改 dashboard 登录密码,直接写回 `agent/appsettings.json` 的 `password` 字段
- 长度 4-128 字符,需提供当前密码校验
- 即时生效(写盘后 in-memory 也同步)

### 采集计划

10 个采集包卡片,每张卡片显示:
- 当前激活版本
- 所有版本号
- 调度(`agent.intervalSec` → "15 分钟"等)
- 脚本名
- 是否已有最近报表

点击卡片弹出详情:每个版本的 manifest.json + 该版本的脚本列表。

### 最近报表

每个有落盘结果的包显示一张卡片,点开后看到完整 JSON 输出。

> **agent 何时落盘?** 每次 `collect.ps1` 成功退出且 stdout 能解析为 JSON 时,
> agent 会把结果写到 `agent/data/last-collect/<name>.json`。该行为由
> `appsettings.json` 的 `dashboardEnabled` 字段控制(默认 `true`)。
> 写盘失败不影响上报给 center 的主流程。

### 日志

`Logs/` 和 `agent/Logs/` 下所有 `.log` / `.txt` / `.err` / `.out` 文件。
点开后看到末尾 500 行。

## 设计原则

1. **零 API** — 所有数据在页面加载时 inline 进 HTML,前端不需要 fetch 任何端点。
   只有 5 个路由:`/login`、`/logout`、`/password`、`/script`、`/log`。
2. **零依赖** — 不引入 Express / Vite / Tailwind / 任何东西。HTML/CSS/JS 用
   模板字符串拼起来,直接 res.end()。
3. **本地优先** — 读磁盘,不打 center。center 不可达时 dashboard 仍能用,
   只是"最近报表"会停在最后一次成功收集时的快照。
4. **默认安全** — loopback binding,base64 密码掩饰,HttpOnly cookie,
   SameSite=Strict,30 秒整页刷新。
5. **可嵌入** — 导出 `startDashboard({ config, installRoot, agentDir, logger })`
   让 `agent/agent.js` 在同进程里启动 dashboard(共用 Node 进程、事件循环、
   文件句柄),不需要 IPC 也不需要文件通知。

## 与 memberServiceAgent 服务的关系

- 不启停 `memberServiceAgent`
- 不改任何文件(只读)
- agent 把收集结果落盘到 `agent/data/last-collect/` 是**独立的功能**,
  即使 dashboard 没启动,agent 也会照常运行和落盘

**dashboard 不再是独立服务** — `dashboard/server.js` 作为 ESM 模块被
`agent/agent.js` 通过 `startDashboard()` **in-process** 调用,共用一个 Node
进程、共用一个事件循环。改密码写到 `agent/appsettings.json` 也是同进程操作,
不需要 IPC、不需要走文件系统通知。

## 文件结构

```
dashboard\
├── package.json              零依赖 ESM
├── server.js                 全部逻辑(路由 + 渲染 + 认证,内嵌 HTML/CSS/JS)
└── README.md
```

启动器:`start-dashboard.ps1`(在 `D:\agentInstall/` 根)。
