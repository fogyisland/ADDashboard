# AD Dashboard 中心服务器 —— Linux / 宝塔部署说明

本包是 `D:\Implementation\Server`（Windows 部署版）的 Linux 可运行版本，**仅含中心端**（不含 agent 树）。

---

## 0. 部署流程速查

**完整部署没有 build 步骤 —— 前端产物已随包交付。**

```
① 上传   把整个 LinuxServer/ 目录传到服务器（如 /www/server/ADDashboard）
② 装依赖 cd /www/server/ADDashboard && npm ci --omit=dev
③ 启动   宝塔面板配 Node 项目 → 浏览器开 /init 走向导
```

| 步骤 | 在哪 | 命令 / 操作 |
|---|---|---|
| ① 上传 | 任意 | 把 `LinuxServer/` **整个目录**传上去 |
| ② 装依赖 | **根目录** `ADDashboard/` | `npm ci --omit=dev`（或 `bash scripts/install.sh`） |
| ③ 配宝塔 | 宝塔面板 | 项目目录 = `ADDashboard/center`，启动文件 = `server.js`，端口 = `8080` |
| ④ 初始化 | 浏览器 | `http://<服务器IP>:8080/init` → 走向导 |

> 不想用宝塔面板的话，包里带了等价的 PM2 脚本（装 / 起 / 停 / 自检 / 卸），
> 见**第 9 节**。装完依赖后建议先跑一次 `bash scripts/verify.sh` 自检。

### ❌ 部署时**不要**执行 `npm run build`

**前端产物 `center/dist/` 已经构建好、随包交付**（27 个文件 / 2.90 MB）。
服务器直接把它当静态文件发，不需要重新编译。

而且**也跑不了**：第 ② 步用的是 `npm ci --omit=dev`，故意不装 dev 依赖
（vite / esbuild / rollup），`npm run build:web` 会报 `vite: not found`。

> 本项目**从来没有 `build` script** —— 只有 `build:web`（`vite build`）。
> `npm run build` 会报 `Missing script: "build"`。

**唯一需要构建的场景**：你改了前端源码。那就**在本地**跑

```bash
cd D:\dashboard\center
npm run build:web
```

再把新的 `center/dist/` 覆盖上传。**不要在服务器上构建。**

---

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **22 或更高** | 硬依赖：`ldapts` 声明 `engines.node >= 22`。Node 20 会装不上或运行报错 |
| 数据库 | MSSQL 2019+ 或 MySQL 8+ | 建表脚本两种方言都内置，启动时自动 apply |
| 系统 | 任意 x86_64 Linux（CentOS / Ubuntu / Debian / OpenCloudOS…） | 不需要 build-essential / python3 —— 22 个生产依赖 **0 个需要原生编译** |
| 服务管理 | 宝塔面板（PM2） | 本包不含 systemd unit，也不含 NSSM 脚本 |

---

## 2. 上传

把整个 `LinuxServer/` 目录传到服务器，例如：

```
/www/server/ADDashboard/
├── package.json
├── package-lock.json          ← ★ 唯一的 lock（根目录这份，workspaces lock）
├── build-manifest.json
├── ecosystem.config.cjs       ← PM2 进程定义
├── scripts/                   ← 生命周期脚本（install/start/stop/verify/uninstall）
│   ├── common.sh              ← 公共函数库（删除守卫在这里）
│   ├── install.sh  start.sh  stop.sh  verify.sh  uninstall.sh
│   └── tests/test-guard.sh    ← 删除守卫的自测（30 个用例）
├── db/                        ← baseline SQL（启动时自动建表）
│   └── migrations/{mysql,mssql}/1.0.0-baseline.sql
└── center/                    ← ★ 项目目录填这个
    ├── server.js
    ├── package.json
    ├── appsettings.json.example
    ├── src/
    ├── dist/                  ← 前端产物，已构建好，服务器不需要再 build
    ├── web/                   ← 前端源码（改前端时本地 build 后覆盖 dist/ 即可）
    ├── logs/                  ← 运行期日志（随包是空的）
    └── data/packages/         ← 内置包 payload（agent 要跑的 collect.ps1 在这）
```

> 上传时**整个目录传**，不要漏 `db/` 和根目录的 `package.json` / `package-lock.json` /
> `build-manifest.json` —— 服务启动时要从那儿读版本信息和建表脚本。
> `center/node_modules/` **不要**传（目标机上自己 `npm ci` 装）。
>
> ⚠️ **包里没有 `.env`、也没有 `.env.example`** —— 本服务**不读任何环境变量**来配
> 数据库 / JWT / license。配置只有一处：`center/appsettings.json`（由初始化向导生成）。
> 详见第 8 节。

---

## 3. 安装依赖

**在安装根目录执行**（不是 `center/`）：

```bash
cd /www/server/ADDashboard
npm ci --omit=dev
```

> ⚠️ **为什么必须在根目录**：根 `package-lock.json` 是 workspaces lock，包含 `packages["center"]` 这一节。
> **包里只有这一份 lock**（R161 已删掉 `center/package-lock.json` —— 那份是旧的：
> 419 个包、缺 `@modelcontextprotocol/sdk`、缺 `zod`，在 `center/` 里跑 `npm ci`
> 会装出一棵 MCP 路由 import 不了的依赖树）。
> 如果你在 `center/` 里看到 `package-lock.json`，那是脏文件，**删掉它**；
> `scripts/verify.sh` 也会把这种情况报成 FAIL。

> ⚠️ **不要用 `npm install`**：`npm install` 会重算依赖树并改写 lock，把版本漂移引入生产。

### 这一步之后**不需要**再跑任何 build

`center/dist/`（前端构建产物）已随包交付，**服务器不需要编译前端**。

| 命令 | 部署时要不要跑 |
|---|---|
| `npm ci --omit=dev` | ✅ 就是这一步 |
| `npm run build` | ❌ 没有这个 script，会报 `Missing script: "build"` |
| `npm run build:web` | ❌ 跑不了 —— `--omit=dev` 没装 vite（`vite: not found`） |

参考实测：`npm ci --omit=dev` 装出 **301 个包 / 约 180 MB / 约 30 秒**。
`node_modules/@ad-dashboard/center` 是 workspace 软链，`mssql` / `mysql2` /
`@modelcontextprotocol/sdk` / `ldapts` 都在；`esbuild` / `rollup` / `vite`
**全部没装**（dev 依赖正确省略）—— 所以**目标机不需要 build-essential / python3**。

---

## 4. 宝塔面板配置

**宝塔 → 网站 → Node 项目 → 添加 Node 项目**：

| 字段 | 填什么 | 备注 |
|---|---|---|
| 项目目录 | `/www/server/ADDashboard/center` | **必须是 `center/`，不是 `ADDashboard/`** |
| 启动文件 | `server.js` | |
| 项目名称 | `ADDashboardCenter` | 与 `ecosystem.config.cjs` 的 `name` 一致 |
| Node 版本 | 22.x | 宝塔的 Node 版本管理器里选 |
| 运行用户 | `www` | |
| 端口 | `8080` | 与初始化向导里填的 listenPort 一致 |
| 环境变量 | `LANG=zh_CN.UTF-8`<br>`LC_ALL=zh_CN.UTF-8` | 让 DC 名 / site 名排序与 Windows 版一致（见第 7 节） |
| 开机自启 | ✅ 勾选 | |

> 若宝塔让你二选一（面板配置 / `ecosystem.config.cjs`），用 `ecosystem.config.cjs` —— 里面的
> `cwd` / `restart_delay` / `kill_timeout` 都是按 Windows 版 NSSM 参数 1:1 平移过来的。
> 面板里填的项目目录**必须**和 `ecosystem.config.cjs` 的 `cwd` 指向同一个目录。

### 权限

```bash
chown -R www:www /www/server/ADDashboard
```

以下路径运行期需要写权限（`www` 用户）：

```
center/logs/            center/logs/APP/       center/logs/FEATURE/
center/data/packages/   center/data/file-push/ center/data/license-requests/
center/.env             center/appsettings.json
```

> `center/logs/` 下的三个子目录（`logs/`、`logs/APP/`、`logs/FEATURE/`）已随包带上，
> 但**必须是空的** —— 目标机上首次启动会自己建轮转文件。

---

## 5. 初始化（首次启动）

宝塔启动项目后，浏览器打开：

```
http://<服务器IP>:8080/init
```

向导步骤：测库 → 应用建表 → 创建管理员 → 写入配置。

向导最后会 **写好 `center/appsettings.json` 并 `process.exit(0)`** —— PM2 随即自动拉起进程，
这次就是正常模式（不再是 init 模式）。**这一步是自动的，不需要手工重启。**

之后：

- 管理后台：`http://<服务器IP>:8080/`
- 健康检查：`http://<服务器IP>:8080/api/health`

---

## 6. 排错

```bash
pm2 status                       # 看进程状态
pm2 logs ADDashboardCenter       # 看 stdout/stderr
pm2 restart ADDashboardCenter    # 改完 src/ 必须重启（module cache stale）
```

业务日志不在 PM2 里，在文件里（pino-roll 按日期轮转，文件名带日期）：

```
center/logs/center.<YYYY-MM-DD>.<序号>.log   ← 主日志（每日轮转）
center/logs/APP/<模块>.<YYYY-MM-DD>.<序号>.log      ← 分模块（agent / heartbeat / init / web）
center/logs/FEATURE/<功能>.<YYYY-MM-DD>.<序号>.log  ← 分功能（os_baseline / eventlog / lockout / …）
```

> 找最新日志：`ls -t center/logs/center.*.log | head -1`
> ⚠️ 文件名**不含** `center.log` 这个字面量 —— pino-roll 会自动加日期和序号后缀。

### 常见现象

| 现象 | 原因 | 处理 |
|---|---|---|
| `seedBuiltinPackages: source not found in any candidate` | 宝塔「项目目录」没指向 `center/` | 改成 `/www/server/ADDashboard/center` 后重启 |
| `agent-upgrade-source: agent directory missing`（WARN） | **正常** —— 本包不含 agent 树 | 无需处理。只影响「中心一键升级 agent」这一个功能 |
| 页面 404 / 空白 | `staticDir` 相对 cwd，`cwd` 错了 | 同上第一条 |
| `init marker present but config missing — refusing to start` | 初始化标记在，但 `appsettings.json` 没了 | 恢复 `appsettings.json`；要重跑向导必须**同时**删 `.env` 和 `appsettings.json` |
| `Cannot find module '@modelcontextprotocol/sdk'` | 在 `center/` 目录跑了 `npm ci` | 到安装根目录重跑 `npm ci --omit=dev` |
| ESM 报 `ERR_MODULE_NOT_FOUND` 指向某个 `src/` 文件 | 复制不完整 | 重新上传整个 `center/src/` |
| `Cannot find package 'zod'` | 依赖没装全，或用的是 R161 之前的旧包（那时 `zod` 只靠 MCP SDK 的传递依赖，SDK 一升级就没了） | 确认 `center/package.json` 里有 `"zod": "^4.6.7"`，然后在**根目录**重跑 `npm ci --omit=dev`；`npm ls zod` 应能看到 zod@4 |
| 找不到 `center/logs/center.log` | pino-roll 按日期轮转，文件名带日期后缀 | `ls -t center/logs/center.*.log \| head -1` |
| `bash scripts/verify.sh` 报「端口 8080 没有监听」 | 服务没起，或 `appsettings.json` 的 `listenPort` 不是 8080 | `bash scripts/start.sh`；端口以 `center/appsettings.json` 的 `listenPort` 为准 |
| `bash scripts/start.sh` 报「PID 变了 / 重启了 N 次」 | **崩溃循环** —— 脚本不会把崩溃当成"启动成功" | 看 `pm2 logs ADDashboardCenter` 的错误尾巴 + `center/logs/center.*.log` |
| agent 收不到内置包（如 `ad_os_baseline`） | `center/data/packages/` 不完整，或版本与源树不一致 | 重新上传整个 `center/data/packages/`；维护者跑 `check-linux-package-sync.mjs` 的 C8 检查 |
| `npm ci` 报 `EUSAGE: npm ci can only install with an existing package-lock.json` | 在 `center/` 目录里跑的 | 到**安装根目录**重跑 `npm ci --omit=dev` |
| `Missing script: "build"` | 本项目没有 `build` script | **正常** —— 部署不需要 build，`dist/` 已随包（见第 0 节） |
| `vite: not found` | 跑了 `npm run build:web`，但 `--omit=dev` 没装 vite | **不用管** —— 服务不依赖构建。要重建前端就在本地跑（见第 0 节） |

---

## 7. 已知差异（与 Windows 版的区别）

| 项 | Windows 版 | Linux 版 |
|---|---|---|
| 初始化标记 | 双写：`.env` + 注册表 `HKLM\SOFTWARE\ADDashboard` | **只有 `.env`**（见下方风险提示） |
| 服务管理 | NSSM | PM2（宝塔）；另有包内 `scripts/*.sh` 一套等价命令（第 9 节） |
| 一键升级 agent | 可用（有 `agent/` 树） | **不可用**（本包不含 agent 树，其余功能不受影响） |
| 内置包 `platforms: ["windows"]` | 派发给 Windows agent 执行 | **完全一样** —— 中心只负责派发，DC fleet 行为不变 |
| 日志目录 | `center/logs/` | `center/logs/`（同一套） |
| 排序（DC 名 / site 名） | 跟随 Windows 区域设置（本机 `zh-CN`） | 跟随服务器 `LANG`（无 `LANG` 时为 ICU root；见下方说明） |

### ⚠ 已知差异：locale 依赖的排序（低影响）

中心有 **12 处 `localeCompare()` 没有指定 locale**（`dashboard.js` 的 `dcName` / `peerDc`、
`reports.js` 的 `siteName`、`dcs.js` 的 `dcHost` 等）。Node 的 `localeCompare` 走 ICU，
排序结果**跟随运行时的默认 locale**。

实测结论（`zh-CN` vs `en-US` 对比）：

| 被排序的名字 | 是否受影响 |
|---|---|
| 纯 ASCII（`DC01` / `Site-A` / `AD-DC-10`） | **不受影响** —— 各 locale 排序完全相同 |
| 含中文（`DC-上海-01` / `dc-北京-02`） | **受影响** —— `zh-CN` 与 `en-US` 顺序不同 |

**触发条件**：宝塔机器的 `LANG` 是 `en_US.UTF-8`（或类似非中文 locale）**且** 有 DC 名字含中文。
DC 名在 AD 里通常是 `DC01` / `DC-bj-01` 这类 ASCII，所以**实际影响很小**。

**处置建议（推荐）**：在启动前固定 locale，让行为与 Windows 版一致：

```bash
# 宝塔 → Node 项目 → 环境变量, 加一行
LANG=zh_CN.UTF-8
LC_ALL=zh_CN.UTF-8
```

> 这只是**排序口径**的差异，**不影响任何数据正确性、不影响 agent 上报、不影响报表数值**。
>
> 代码里 `dashboard.js:1343` / `dashboard.js:1950` 的 `peerSite` 排序**已经**显式写了
> `localeCompare(x, "zh")` —— 说明上游本来就打算统一用中文排序，只是有几处漏了。
> 这是**上游的不一致**，Windows 版同样存在，不是 Linux 引入的。
> 数字格式化（`toLocaleString()`）经实测各 locale 千分位都是 `1,234,567`，**无差异**。

### 上游遗留（Windows 版同样存在，非 Linux 引入）

| 项 | 说明 |
|---|---|
| `center/db/migrations/transfer-r158-68.mjs` | **R161 已删除**（Linux 包与 Windows 源树都删了）。它是一次性数据迁移脚本，import 了**未声明**的 `dotenv`（直接 `ERR_MODULE_NOT_FOUND`），而且 `getDb()` 之前没 `init(config)`（"db not initialized"）。更根本的问题是：它住在 `center/db/migrations/` 下，而迁移引擎只扫 `<repoRoot>/db/migrations/{mysql,mssql}/` —— **这个目录从来不会被读**；它操作的 `alert_email_outbox` 表在 R158.X.116.d 已从基线删除（实测生产库 4 张表都不存在），`src/` 里对它也只有注释、没有任何 SQL。留着它只是让下一个人以为"迁移脚本在这儿" |
| `zod` | `src/routes/mcp.js` / `mcp-write.js` import 了 `zod`。**Linux 包已在 R161 修好**：`center/package.json` 显式声明 `"zod": "^4.6.7"`，根 lock 同步（包数不变，301 个），并由 `check-linux-package-sync.mjs` 的 C6 检查（"import 了但没声明 ⇒ 目标机装不上"）守住。**Windows 源树仍没改** —— 改它会让目标机 `.install-hash` 失效、触发 `npm install --omit=dev` 重装（离线机直接挂），属于要单独决策的事，见第 9 节 |

### ⚠️ 风险提示：初始化标记在 Linux 上是单存储

Windows 版把「初始化已完成」双写到两处：

1. `center/.env` 里的 `ADDASHBOARD_INITIALIZED=1`（跨平台）
2. Windows 注册表 `HKLM\SOFTWARE\ADDashboard\Initialized`（**仅 Windows**）

设计意图是「任一处被擦除都不能单独重触发初始化向导」。Linux 没有注册表，**只剩 `.env` 一处**。

**实际风险低于原设计**：`appsettings.json` 还在时，`center/server.js` 会**拒绝启动**（exit 2），而不是重跑向导：

```bash
# 只擦 .env (不动 appsettings.json) → 拒绝启动, 不是重跑向导
# 要重跑向导, 必须同时删 .env AND appsettings.json
rm -f  center/.env center/appsettings.json
```

即 Linux 上退化成「单写 + 配置文件互锁」。

---

## 8. 敏感配置

| 位置 | 里面有什么 | 说明 |
|---|---|---|
| `center/appsettings.json` | DB 连接串（**含口令**）、`jwtSecret`、`agentToken`、`listenPort`、`staticDir`、`logLevel` | **由 `/init` 向导在目标机上生成**，本包不含该文件。它是**唯一**的配置源 |
| `center/appsettings.json.example` | 同上的模板 | 里面全是 `REPLACE_WITH_*` 占位，**不要**往里填真口令再打包 |
| `center/.env` | `ADDASHBOARD_INITIALIZED=1` + 初始化时间戳 | **不是凭据文件** —— 它是"初始化已完成"的**标记**，由程序自己写、由程序自己读 |
| `ecosystem.config.cjs` 的 `env` | 只有 `NODE_ENV` / `LANG` / `LC_ALL` | **没有**任何 DB 密码 / JWT secret / agent token |

> ⚠️ **本包没有 `.env`，也没有 `.env.example`**（R161 删掉了 `.env.example`）。
> 应用**不读任何环境变量**来配数据库 / JWT / license —— 只读 `center/appsettings.json`。
> 之前那份 `.env.example` 里的 `DB_PWD` 之类字段**根本不会被读取**，
> 照着它填一遍不会生效，只会造成"我明明配了密码"的错觉。
>
> 保护建议：
>
> ```bash
> chmod 600 center/appsettings.json      # 只有运行用户能读
> chown www:www center/appsettings.json
> ```
>
> 备份 / 交接 / 二次分发时**先删掉** `center/appsettings.json` 和 `center/.env`。

---

## 9. 生命周期脚本（scripts/）

包里带了一套完整的生命周期脚本，**等价于宝塔面板的"装依赖 / 启动 / 停止 / 卸载"**，
但更适合自动化和排错。

| 脚本 | 作用 | 常用参数 |
|---|---|---|
| `scripts/install.sh` | 装依赖 + 建可写目录 + 可选 PM2 启动 | `--pm2`（顺带起服务）、`--user <运行用户>`（root 时 chown）、`--skip-deps` |
| `scripts/start.sh` | 启动 / 重启 PM2 进程，**并验证它真的活着** | `--wait <秒>`（观察窗口，默认 10） |
| `scripts/stop.sh` | 停服务，**并确认进程真的没了** | `--timeout <秒>`（默认 15）、`--force`（真 `kill -9`）、`--purge`（连 PM2 名单一起删） |
| `scripts/verify.sh` | 环境与运行状态自检（10 组检查，PASS / WARN / FAIL） | `--json`（机器读） |
| `scripts/uninstall.sh` | 停服务 + **把安装根移走**（可恢复） | `--target <目录>`、`--purge`（真删）、`--yes`（免交互）、`--keep-pm2` |
| `scripts/tests/test-guard.sh` | 删除守卫的自测（30 个用例） | — |

```bash
cd /www/server/ADDashboard
bash scripts/install.sh            # 装依赖（等价于第 3 节）
bash scripts/verify.sh             # 自检，有问题会逐条列出来
bash scripts/start.sh              # 启动（会等 10 秒确认没崩）
bash scripts/stop.sh               # 停止
```

### 为什么"启动成功"不看 `pm2 status`

R160 在 Windows 侧栽过这个坑：NSSM 的 `AppExit Default Restart` 让服务状态一直是
`Running`，而 `node.exe` 在它下面一秒崩一次 —— 装完脚本照样打印 "started"、退出码 0，
实际是个崩溃循环。

`start.sh` 因此不看状态字段，而是：启动后等 N 秒，然后要求
**PID 没变 + 累计重启次数没暴涨 + 进程还活着**；不满足就打印 pm2 错误日志尾巴
并以非 0 退出。`stop.sh` 同理：`pm2 stop` 之后轮询确认 PID 真的消失，
`--force` 会真的 `kill -9`（Windows 版的 `-Force` 曾是个空开关）。

### 删除守卫（重要）

`uninstall.sh` 的删除守卫（`common.sh` 里的 `assert_safe_install_root`）是**活代码**，
不是摆设。目标必须同时满足 4 条：

1. 不是 `/`
2. 不是系统顶层目录（`/root` `/home` `/usr` `/var` `/etc` `/opt` `/srv` `/www` `/tmp` …）
3. 不是 HOME 本身、也不是 HOME 的上级目录
4. **必须含 `center/package.json` 且 `name == "@ad-dashboard/center"`**

第 4 条最强：前三层就算全被绕过，目标不是本产品的安装根，照样拒绝。
Windows 版同款守卫曾经是**死代码**（跑起来会把整盘删光）—— 所以这里配了实跑覆盖：

```bash
bash scripts/tests/test-guard.sh     # 30 个用例：22 个系统路径 / HOME / 形状不对 / 正常安装根
```

> 默认**不删**：把整个安装根移到同级的 `ADDashboard.uninstalled.<时间戳>/`，
> 确认没问题再手工 `rm -rf`。`--purge` 才真删 —— 但**守卫照样生效**。

---

## 10. PM2 崩溃循环不变式（别随手改数字）

`ecosystem.config.cjs` 里那组数字是有推导的，**不是随手填的**：

- pm2 7.1.1 判定一次重启"不稳定"要**同时**满足：子进程存活时长 < `min_uptime`
  （默认 1000 ms）**且** 进程被创建的时间 < `min_uptime × max_restarts`。
- `unstable_restarts >= max_restarts` 时，pm2 把状态置为 `errored` 并**永远不再拉起**
  —— 也就是"达到重启上限"= 服务彻底死掉，不是"重试若干次后放弃保护"。
- 本文件 `restart_delay = 5000 > min_uptime = 1000` ⇒ 两次重启至少隔 5 秒 ⇒
  子进程要活满 10 秒才算"稳定" ⇒ 10 秒窗口里最多塞进 2 次不稳定重启
  ⇒ **`max_restarts = 10` 这道阈值根本够不着** ⇒ 崩溃时无限重启
  ⇒ 与 Windows 版 NSSM（`AppExit Default Restart` + `AppRestartDelay 5000`）行为一致。

| 改错的后果 | 现象 |
|---|---|
| `restart_delay <= min_uptime`（例如 500） | 10 秒窗口塞得进 20 次 ⇒ 第 10 次就判死 ⇒ **服务永远起不来**（比崩溃循环更糟） |
| `max_restarts = 0` | **不是**"无限重启"：0 >= 0 恒真 ⇒ 第一次退出就 errored ⇒ 服务永远起不来 |
| 写 `Infinity` | `JSON.stringify` 后变成 `null`，`~/.pm2/dump.pm2` 里是坏的 |

要表达"无限重启"，保持 `max_restarts = 10` + `restart_delay = 5000` 这组数字即可 ——
阈值本来就够不着。

> `max_memory_restart = '512M'` 是 **Linux 独有的不对称项**（Windows 的 NSSM 没有内存上限）。
> 512M 是保守值；生产实测 RSS 更高时（`ps -o rss,pid -p <pm2 pid>` 或 `pm2 monit`）可以调大，
> 调小没有好处 —— 宁可 OOM 崩一次也不要无限重启。

---

## 11. 源树 ↔ Linux 包同步（维护者看）

`LinuxServer/` 是 Windows 源树 `Server/` 的**手工副本**。R160 在绿色包上已经证明过
手抄的代价：源树里修好的东西悄悄到不了客户机，而且手抄还会顺手带进源树没有的陈旧文件、
漏掉源树有的文件 —— 而且**没有任何东西会告诉你**。

R161 起有检测器兜底（脚本在**源树**里，不随包发布）：

```bash
node Server/scripts/audit/check-linux-package-sync.mjs
```

它逐文件 sha256 比对六棵子树（`center/src`、`center/web`、`center/dist`、
`center/scripts`、`db`、`center/data/packages`），并检查：

| 检查 | 内容 |
|---|---|
| C1 | 六棵子树逐字节一致（例外只有白名单，**每条都必须带理由**） |
| C2 | 必需文件都在（`server.js` / `dist/index.html` / 两份 baseline SQL / 6 个脚本 …） |
| C3 | 每个 `.sh`：无 BOM、无 CRLF、第 1 行是 shebang、入口脚本开 `set -u`+`pipefail`；被 source 的库**不能**开 `set -e`（会改掉调用方的语义，守卫自测依赖这点） |
| C4 | 不该出现的文件没出现（`.env.example` / `center/package-lock.json` / `center/db` / `center/.env` / `center/appsettings.json` / `center/.install-hash`） |
| C5 | 根 manifest 与根 lock 的 `workspaces` 一致；lock 里有 `zod` |
| C6 | `center/src` 里每个裸 import 都在 `center/package.json` 的 `dependencies` 里声明过 |
| C7 | PM2 不变式：`restart_delay > min_uptime`、`max_restarts` 是正有限数、`cwd` 指向 `center/`、env 里没有凭据 |
| C8 | 14 个内置包的 `name/version/manifest.json` 都在包里 |
| C9 | 包里没有凭据值 |

有 error 时退出码为 1，机器可读报告写到 `Server/scripts/audit/linux-package-sync.json`。

**改了源树之后**：把对应子树重新同步到 `LinuxServer/`，再跑一遍检测器 ——
白名单之外的差异一律当 error 处理。检测器本身有 5 条负向测试（人为注入漂移必须报错），
改检测器时记得重跑。
