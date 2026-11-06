# Git 现状与本地 ⇄ 远程目录映射

> 建立于 2026-10-26。本地树此前**没有任何版本历史**（改文件靠手工备份到
> `D:\Temp\r161-isolated\`），本次建立 git 基线后，推送前的决策材料集中在这里。

## 一、当前本地仓库设置

| 项 | 值 |
|---|---|
| 仓库根 | `D:\ToolDevelop\ADDashboard` |
| 分支 | `main`（**无上游**，避免误 push） |
| 作者 / 提交者 | `fogyisland <10853913@qq.com>`（仓库级 `git config`，非只靠全局） |
| `origin` | `https://github.com/fogyisland/ADDashboard.git` |
| 基线提交 | `21dec2b` — 1483 文件 / 366677 行 / 19.5 MB |
| 是否已 push | **是**。operator 显式指示「推送更新」后，已推到 **`origin/server-lineage`**；远程 `main` / `publish` / `feat/*` 三个分支**逐字节未动** |

```powershell
# 看本地提交（不碰远程）
git log --oneline -5

# 看与远程的关系（需要先 fetch，但 fetch 不改工作树）
git fetch origin
git log --oneline origin/main
```

## 二、远程仓库现状（2026-10-26 实测）

远程有 3 个分支：

| 分支 | HEAD | 内容 |
|---|---|---|
| `main` | `b64d386`（2026-09-26） | **顶层 WPF 桌面应用**（`App.xaml` / `MainWindow.xaml` / `Views/` / `ViewModels/` / `Models/` …）+ 服务端子树 `center/` `agent/` `scripts/` `installer/` `publish/` `docs/` `db/` `data/` |
| `publish` | `08e4ad6` | **纯文档分支**：只有 `index.md` `operations/{deployment,runbook,troubleshooting}.md` `superpowers/{plans,specs}` |
| `feat/wpf-metric-centric-redesign` | `5cfa2c4` | WPF + `frontend/` |

`main` 的提交历史**全部**是服务端工作（`fix(center)` / `fix(agent)` / `fix(admin)`），
作者写的是 `AD Dashboard <ops@example.com>` 这个占位身份 —— 不是真实 GitHub 账号，
所以本仓库统一改成 `fogyisland`。

### 远程 `main` 已经落后很多

| 指标 | 远程 `main` | 本地树 |
|---|---|---|
| 最后提交 | 2026-09-26（R108.1.2） | 2026-10-26（R161.7） |
| `center/src/routes/*.js` | 13 个 | **35 个** |
| `center/src/routes/system-settings-v2.js` | 不存在 | 存在 |
| `center/web/src/lib/licenseStatus.js` | 不存在 | 存在（R161.7 新增） |

⇒ **远程不是本地树的镜像，是一棵落后的旁支。** 本地有约 50 轮迭代
（R109 ~ R161.7）从未进过版本控制。

## 三、目录映射（已按此表推送到 `server-lineage`）

| 本地 | 远程 | 说明 |
|---|---|---|
| `Server/center/` | `center/` | 中心端（Node/Express + Vue 前端） |
| `Server/scripts/` | `scripts/` | 安装/卸载/升级脚本链 |
| `Server/agent/` | `agent/` | agent 运行时 |
| `Server/noadagent/` | — | 远程无对应 |
| `ADAgent/agent/` | `agent/` | agent 运行时（与上一行是**两套**） |
| `ADAgent/`（绿包其余） | `installer/` | 绿色包构建与安装脚本 |
| `MemberAgent/` | — | 远程无对应 |
| `LinuxServer/` | `publish/system/` | 交付包（Baota 面板部署用） |
| `docs/` | `docs/` | 文档 |
| — | `App.xaml` `Views/` `ViewModels/` `Models/` `Common/` `Sandbox/` `Themes/` `Tests/` | **WPF 桌面应用，本地树没有** |
| — | `publish/`（非 system） | 远程的发布产物目录 |

⚠️ 映射不是 1:1 —— 本地 `Server/center/` 的一部分内容在远程 `center/`，
另一部分（如 `Server/agent/`、`Server/noadagent/`）在远程有别的落点。
**推送前必须逐目录核对，不能整目录覆盖。**

## 四、推送前要决定的三件事（**已全部定案，结论见 §9**）

1. **历史怎么处理**
   本地基线 `21dec2b` 与远程 `main`（`b64d386`）**无共同祖先**。
   三种走法：
   - *另开分支*：本地 `main` 推到 `origin/server-lineage`，远程 `main` 不动 ——
     最安全，两条历史并存，由人工决定何时合并。
   - *覆盖式强推*：`git push --force origin main` —— 会**丢掉远程 main 的全部
     WPF 应用历史**，且远程 `main` 的 `center/` 等目录与本地布局不同 ⇒ 强推后
     远程仓库的目录结构会被本地布局替换，WPF 那半边直接没了。**除非确定 WPF
     那条线已废弃，否则不要这么做。**
   - *重整历史*：先在临时分支上把本地树按映射表搬到远程布局，再以远程
     `b64d386` 为基底做真实 merge。工作量最大，但唯一能保留两条线历史的方式。

2. **`gh` 认证**
   `gh` CLI 当前报 `The token in keyring is invalid` ⇒ 不能用 gh 走 API。
   `git ls-remote` 可匿名工作（仓库公开），但**推送需要凭据** ⇒ 需
   `gh auth login` 重新认证，或配置 PAT/SSH key。

3. **推哪棵树**
   远程 `publish` 是纯文档分支 —— 如果目标只是把**文档**发上去（runbook /
   operations），那条分支没有冲突，风险最低。

## 五、`.gitignore` 里的关键判定

判定口径照搬远程 `origin/main:.gitignore`（本项目既有规范），路径按本地布局改写。

**必须入库（容易被误排除）**

| 路径 | 为什么 |
|---|---|
| `Server/center/data/packages/` | `server.js` 的 `resolveBuiltinSourceDir()` 在本地布局下解析到此处 —— **seeder 的唯一内置包源**（19 个包）。排除则换机无源可 seed，seed 静默失败（曾发生，R161.5） |
| `LinuxServer/center/data/packages/` | 交付包内同一份包源（与上者内容一致） |
| `LinuxServer/center/dist/` | 随包发布的构建产物。远程同一口径（`!publish/system/center/dist/`），理由：避免服务器重建漂移 |

**必须排除**

| 路径 | 为什么 |
|---|---|
| `Server/center/appsettings.json` | 含 `db.mysql.password` / `jwtSecret` / `agentToken` / `signature` |
| `Server/center/.env` | 含初始化标记 |
| `Server/center/data/instance_id` | 机器身份，与许可证绑定 |
| `当前数据库结构.sql` | MSSQL **生产库** dump，含生产实例的内部安装路径 |
| `Implementation.zip` | 123 MB 整包快照 |
| `Server/node_modules/` `ADAgent/node/` `MemberAgent/node/` | 依赖与便携 Node 运行时（`ADAgent/node/` 单目录 85 MB） |
| `ADAgent/nssm/` `MemberAgent/nssm/` | 下载来的 nssm 二进制 |
| `*/agent/data/packages/*` | agent 侧运行时产物（从中心端 `syncFromCenter` 拉下来的），子级 `.gitignore` 只保留 `.gitkeep` + `README.md` |

> ★ 绿包目录（`ADAgent/` `MemberAgent/`）**自带子级 `.gitignore`**，
> 负责 `node_modules` / `Logs` / `data/packages` / `appsettings` 等；
> 根 `.gitignore` 只管 `Server/` 与 `LinuxServer/` 这两棵没有子级规则的树。
> 改 ignore 规则时两边都要看。

## 六、索引已做凭据扫描

基线提交前，1483 个 blob 逐块（在内存里比对，**不落盘、不进命令行**）与
`db.mysql.password` / `agentToken` / `jwtSecret` / `signature` / `db` 用户名
比对 ⇒ **命中 0**。

以后新增文件时建议重跑同一套扫描（脚本思路见
`D:\Temp\r161-audit\` 下的历史脚本），尤其是新增 `appsettings*.json` 变体时。

## 七、已知的一次性差异：PS1 行尾

`.gitattributes` 与远程一致：`* text=auto eol=lf` + `*.ps1 text eol=crlf`。

- **索引里**存的永远是 LF（本次基线即是）
- **工作区**里 PS1 在 `git checkout` / `git restore` / `git clone` 后会变成 **CRLF**
- 但**当前工作树**里的 PS1 是 **LF + UTF-8 BOM**（BOM 是本项目额外要求，
  见 `PS 5.1 compat + BOM`）

⇒ 下次执行任何 checkout 类操作时，233 个 `.ps1` 会被静默改写成 CRLF。
这是**收敛到项目规范**（PS 5.1 对 LF-only 脚本有历史性解析问题），不是错误，
但 diff 会很吵。执行前先确认没有别的会话正在写这棵树。

## 八、附带纠错：中心端没有自带 Node 运行时

排查行尾时顺带核实：`Server/node/` 里**只有 corepack**（`CHANGELOG.md`
`LICENSE` `corepack` `corepack.cmd` `install_tools.bat`），**没有 `node.exe`**
⇒ 中心端确实必须预装 Node.js 并在 PATH 上（`install-center.ps1:139`）。

`ADAgent/node/` 才有完整的 Node 20（含 `node.exe`，85 MB）⇒ Agent 绿包自包含。
两处别混。

## 九、推送定案 + 公开面清点

### 9.1 三个决策的最终结论

| 决策 | 结论 |
|---|---|
| 历史怎么处理 | **另开分支** —— 本地 `main` 推到 `origin/server-lineage`；远程 `main` / `publish` / `feat/wpf-metric-centric-redesign` **逐字节未动**。理由：远程 `main` 是一棵**落后的旁支**（R108 状态，13 个 route vs 本地 35 个），本地是 R161.9；两棵无共同祖先，强推会毁掉远程的 WPF 桌面应用那半边 |
| `gh` 认证 | `gh` token 失效（`The token in keyring is invalid`）⇒ 走 `git push` + Git Credential Manager。**不影响推送**，只影响走 API 的那几条路 |
| 推哪棵树 | 推本地树到新分支 `server-lineage`（1490+ 文件）。**没有**推到 `publish`（那是纯文档分支） |

### 9.2 已推送分支里的内部标识清点（`git grep origin/server-lineage` 实测）

> ⚠ **本文档只记"类别 + 命中量"，不记字面值。**
> 字面值（私网 IP / 客户 AD 域名 / 域控主机名）留在内部记录里
> （`C:\Users\徐鹏\.claude\projects\D--ToolDevelop-ADDashboard\memory\`）。
> 理由：源码里**零散**出现是一回事；专门做一份"客户 AD 拓扑索引"是另一回事 ——
> 后者等于把散落的线索整理成目录，是净增量的暴露，且必然落在**公开**分支上。
> 复现命令：`git grep -cIE '<pattern>' origin/server-lineage`。

| 标识类别 | 命中行 / 文件 | 性质 |
|---|---|---|
| 中心服务器私网 IP（RFC 1918 10/8） | 30 / 22 | 私网，**公网不可路由** |
| 客户 AD 域名 | 22 / 20 | 客户 AD 基础设施标识 |
| 客户 AD 域控 / 成员服务器主机名 | 394 / 191 | 客户 AD 基础设施标识 |
| 生产库 dump 路径（`MSSQL15` / `D:\SQL\DATA\...`） | **0 / 0** | ✅ **没**被推上去 |
| 部署路径（`D:\Implementation` / `D:\dashboard` / `C:\MemberServer`） | **0 / 0** | ✅ **没**被推上去 |
| 凭据（`db.mysql.password` / `jwtSecret` / `agentToken` / `signature`） | **0** | ✅ **没**被推上去 |

⇒ **公网上没有可路由的资产地址、没有生产库路径、没有部署路径、没有凭据。**
剩下的敏感面 = 私网 IP + 客户 AD 域名 + 域控主机名目录。
这三样**都不是凭据**，也**都不能从公网连过去**（域控名只在客户 AD 域内解析）。

⚠ 这些值**已经**在远程分支的源码/注释里（推送前的第一次推送就带过去了）。
本节的意义是**记账**：哪一类、多少、哪些已确认没出去。
要真正抹掉需要重写历史（`git filter-repo`）+ 强推 + 通知所有克隆者 ——
那是**不可逆**操作，须 operator 明确决定后再做。

### 9.3 怎么判断一个私网 IP 是"真环境"还是"文档示例"

★ **"都是私网地址"这个事实本身区分不了真假** —— 文档示例里的
`192.168.1.5,10.0.0.1`（`collect.ps1` 注释中的 EventData proxy-chain 格式示例）
和实测的中心服务器网卡地址**都是 RFC 1918**。判据要用：

| 判据 | 真环境 | 文档示例 |
|---|---|---|
| 是否被 `getPrimaryIPv4()` 实测 | `system-settings-v2.js:106` 注明「本机实测 = <私网 IP>」 | — |
| 是否与真实 AD 域名同源 | 同目录有客户 AD 域名 | 孤立出现 |
| 上下文标注 | 实测 / 真实引用 | `# 中心地址（按实际）`（模板）、注释里的 URL **形状** |
| 是否是**代码路径上的取值** | `getPrimaryIPv4()` 运行时算 | 注释 / 文档 / 探针脚本 |

★ **注释里的示例值 ≠ 代码路径上的常量。** 判"是否泄露"前必须先追到**取值点** ——
例如 `web/src/api/me.js:37` 看着像硬编码兜底 IP，实际是注释里写的响应字段**形状**，
真值由 `GET /api/me/mcp-endpoint` 运行时算：配了 `access_domain` 就用**域名**，
没配才用 `getPrimaryIPv4()` 的**本机真实 IP**。⇒ 代码里**没有任何写死的 IP 兜底**。

### 9.4 唯一一处"硬编码 IP 出现在运行代码里"（R161.8 已修）

`ADAgent/start-dashboard.ps1` / `MemberAgent/start-dashboard.ps1` 的端口冲突预检，
原来把本机网卡地址写死成一个具体地址。换机后监听在 `192.168.x.x` 等
**本机具体网卡地址**上的同名端口进程**检不出来** ⇒ 预检放行 ⇒ 真 bind 时才崩。
R161.8 改为**运行时枚举本机所有单播地址** + 回环/通配符字面量。
回归脚本见 `D:\Temp\r161-audit\port-precheck-regression.ps1`：
在本机**真实网卡地址**上起一个 TCP 监听（既非 `127.0.0.1` 也非 `0.0.0.0`）→
**老逻辑命中 0 / 新逻辑命中 1**，exit=0。
