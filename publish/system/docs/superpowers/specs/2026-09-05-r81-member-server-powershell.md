# R81 — 成员服务器 PowerShell 命令执行

**Date:** 2026-09-05
**Status:** Delivered (12/12 sub-tasks, 11 commits + 1 sync, 0 operator-restart-required changes pending)
**Scope:** 中心排队 + agent 拉取 + 自由 PowerShell 在指定成员服务器上执行。Mirror R75 (AD user/group management) 模式但 target 从 DC 变成任意 member server。
**Spec layering:** 通用执行能力 + R75 同级安全护栏;真正的 sandbox 收紧策略 (R81.1 follow-up)。

## 1. Feature scope

### 1.1 Operator workflow (成员服务器命令)

| Capability | Operator workflow | 实现 |
|---|---|---|
| **执行 PowerShell** | 选 member server → 写 PowerShell 脚本 → 调超时(默认 30s) → 提交 → agent 拉取执行 → stdout/stderr/exitCode 回到 UI history drawer | 本 round |
| **查看历史** | 选 host → 最近 50 条命令 + 展开每条看 stdout/stderr/durationMs | 本 round |
| **Dry run** | "只 dry run 不提交" (仅 syntax check) | R81.1 follow-up (不现在做) |
| **预审脚本** | 选 operator 白名单脚本 (而非自由 PowerShell) | R81.1 follow-up (R81 先开放自由 PS) |

### 1.2 R81 边界 (本 round 不做)

- 真正的 sandbox(受限 RunAs 用户跑,不是 SYSTEM)— R81.1
- 脚本白名单 (operator 只能从 pre-approved 脚本里选)— R81.1
- 高危命令模式匹配阻断 (Stop-Service, Remove-Item -Recurse, Format-Volume)— R81.1
- 多 agent 并行执行同一条命令 — R81.1
- 异步 streaming output (实时 push stdout 到 UI)— R81.1

## 2. Architecture — center-staged + agent-pull (跟 R75 镜像)

完全复用 R75 模式:
1. operator → `POST /api/admin/member-commands` (admin route, userAuth `admin:users`)
2. center → `INSERT INTO ad_member_commands` (新表,迁移 025)
3. agent 轮询 → `GET /api/agent/member-commands?hostname=X` (agentMw,原子 2-step claim)
4. agent → PowerShell script `run-member-script.ps1` (-Script + -TimeoutSec)
5. agent → `POST /api/agent/member-commands/:id/result` (success + stdout + stderr + exitCode + durationMs)
6. center sweep setInterval (10s) — 30s 未结束的 `running` 命令 → `timeout` (复用 R75-T4 sweeper,新加 env `MEMBER_COMMAND_TIMEOUT_MS`)

### 2.1 DB table (迁移 025)

```sql
-- 025_create_ad_member_commands.sql
CREATE TABLE ad_member_commands (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,  -- MSSQL: INT IDENTITY
  hostname      VARCHAR(128) NOT NULL,                            -- 目标成员服务器 hostname
  command_type  VARCHAR(64)  NOT NULL,                            -- 现在只 'member_script',将来扩展
  params_json   JSON         NOT NULL,                            -- MSSQL: NVARCHAR(MAX) — { script, timeoutSec }
  status        VARCHAR(16)  NOT NULL DEFAULT 'queued',           -- queued|running|success|failed|timeout
  operator_id   BIGINT       NULL,                                -- sys_users.id
  result_json   JSON         NULL,                                -- { stdout, stderr, exitCode, durationMs } — 大小受限
  error_message NVARCHAR(2000) NULL,                              -- PS spawn / parse 错
  duration_ms   INT          NULL,
  created_at    DATETIME     NOT NULL,
  claimed_at    DATETIME     NULL,
  completed_at  DATETIME     NULL
);

CREATE INDEX ix_member_commands_host_status ON ad_member_commands(hostname, status);
CREATE INDEX ix_member_commands_status_created ON ad_member_commands(status, created_at);
CREATE INDEX ix_member_commands_operator ON ad_member_commands(operator_id, created_at);
```

MSSQL 变体: `BIGINT IDENTITY(1,1)` + `NVARCHAR(MAX)` for JSON + `ISJSON()` CHECK + `DATETIME2`。

### 2.2 Command types (本 round)

`member_script` (单 type,自由 PowerShell)— 将来可加 `download_and_run`, `install_msi` 等。

## 3. Safety guard rails (R81 与 R75 最大区别 — R75 是 whitelist, R81 是自由)

| Guard | 实现 | 拒因 |
|---|---|---|
| Hostname must be a registered agent | queueCommand 时 JOIN ad_agents 验证 last_heartbeat_at >= UTC - 5min | 防对未 heartbeating 的 host 排队 |
| script size ≤ 32KB | service 层 `JSON.stringify(params).length > 32 * 1024` 拒 400 | 防 payload 撑爆 |
| timeout 范围 [5, 60] | service 校验,默认 30 | 防止忘记设超时 |
| stdout 截断 32KB | service 写入 result_json 前 `slice(0, 32768)` | 防大输出爆库 |
| stderr 截断 8KB | service `slice(0, 8192)` | 同上 |
| Rate limit per host | service 在 60s 窗口内 queued + running count > 5 → 429 | 防误操作/恶意灌爆 |
| audit 完整持久化 | `ad_member_command_queued` (params) + `*_succeeded`/`_failed`/`_timed_out` (result + durationMs) 4 个 entry | 全审计 |
| params_json 持久化 | service 写入(operator 写什么留什么底) | 审计 |
| 密码 redact | service 写 result_json 前 strip 'password'/'newPassword'/'token' 三个 key (跟 R75 一样) | 防误带密码 |

## 4. Mock-first (R75-T8/T9/T10 镜像)

- `center/mock-member-commands.mjs` — 17 (划掉) 1 个 dispatchers + 内置 seed (3 个 free-PS 例子)
- `center/mock-multi-agent.mjs` + `center/mock-heartbeat-daemon.mjs` 加 `processMemberCommands(agentId)`
- `center/mock-member-commands-e2e.mjs` — 端到端 + 审计 + 脚本大小验证

## 5. Real agent (R75-T11 镜像)

- `agent/scripts/run-member-script.ps1` — 接收 -Script + -TimeoutSec,run,返回 stdout/stderr/exitCode/durationMs
- `agent/src/dispatchers/member-commands.js` — 跟 `dispatchAdCommand` 同构
- `agent/src/member-commands-drainer.js` — 跟 `ad-commands-drainer.js` 同构
- `agent/agent.js` — wire 进 `makeSendCallback`,每次心跳跑(不依赖回报 click)

## 6. Frontend (R75-T12 镜像)

- `center/web/src/api/member-commands.js` — queueCommand, listCommands, getCommand, listAgents
- `center/web/src/views/admin/MemberCommandsView.vue` — host picker + PS editor + 提交按钮 + history drawer
- `center/web/src/components/admin/ExecuteCommandModal.vue` (新)— 跟 R75 UserCreateModal 类似的 modal
- `center/web/src/components/admin/MemberCommandHistoryDrawer.vue` (新)— 跟 R75 AdCommandHistoryDrawer 类似
- 3 测试文件: member-commands-view.test.js + execute-command-modal.test.js + member-command-history-drawer.test.js

## 7. Audit classifier entries (新 4 个)

- `ad_member_command_queued` — params 摘要 (script 前 256 字符 + timeoutSec)
- `ad_member_command_succeeded` — durationMs + result 摘要
- `ad_member_command_failed` — errorMessage + exitCode
- `ad_member_command_timed_out` — 跟 failed 类似,标记 timeout

## 8. T-list (12 sub-tasks,4-6 小时)

1. **T1 — DB migration 025** ad_member_commands
2. **T2 — SQL helpers** (mysql + mssql)
3. **T3 — member-commands service module** (queueCommand, claim, completeCommand, rate limit, redact)
4. **T4 — server.js sweeper 加 MEMBER_COMMAND_TIMEOUT_MS**
5. **T5 — audit-classifier entries** 4 个
6. **T6 — admin routes** (POST/GET single/list) + agent routes (GET claim + POST result)
7. **T7 — backend tests** (service + admin + agent routes)
8. **T8 — mock** (store + dispatchers + e2e)
9. **T9 — real agent PS1 + JS dispatcher + drainer**
10. **T10 — agent.js wire 进 heartbeat-callbacks**
11. **T11 — frontend views + modals + history drawer**
12. **T12 — frontend tests + verify + commit**

每个 T 一个 commit。

## 9. Standing directives applied

- "代码一定要紧贴实际的agent" — R81 镜像 R75 模式,从 mock 写到 real agent
- "先做mock 到时候agent 按照mock方案改造就好了" — mock-first (T8 在 T9 之前)
- "本机默认就是8080端口,不要随意更改" — no port changes
- "后续就在8080端口,重启服务告诉我 我手动来重启" — **NEVER auto-restart 8080 NSSM**
- "Commit locally only. No git push unless explicitly asked."

## 10. Operator pending actions (R81 完成后累积)

- Apply migration 025 (R81 ad_member_commands) — 跟 R75 一样 operator 在 live MySQL 上跑
- 重启 8080 NSSM (lands R73.1 + R74 + R75 + R76 + R77 + R78 + R80 + R81)
- 部署 agent installer (让 R78 + R81 的 drainer 生效)
- `git push` (15+ commits 现在)