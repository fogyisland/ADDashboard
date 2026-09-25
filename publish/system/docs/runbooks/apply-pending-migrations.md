# Runbook — 应用待执行的 migrations(operator handoff)

> **目的**: 让 operator 在重启 8080 NSSM 之前,先手动跑 `db/migrations/`
> 里尚未在 live MySQL 中标记为 `applied` 的 SQL 文件。**可选 — center 自己
> 在启动时会跑相同的 gap**(见 `center/src/services/migrations.js` 的
> `upgrade()`)。这个 runbook 只是给想"先把 DDL 落库,再启服务"的人用。
>
> **何时需要**:`schema_migrations.status != 'applied'`(任意一行)。
>
> **何时不需要**:全部 25 行都是 `applied`,或者 024/025 已经是 `applied` —
> **直接重启 NSSM 即可,什么也不用做**。

---

## Step 0 — 现场探查(1 次)

```powershell
cd D:\ToolDevelop\ADDashboard
node -e "const m=require('./center/node_modules/mysql2/promise');(async()=>{const c=await m.createConnection({host:'127.0.0.1',port:3306,user:'root',password:require('fs').readFileSync('center/appsettings.json','utf8').match(/\"password\":\"([^\"]+)\"/)[1],database:'addashboard'});const[r]=await c.query(\"SELECT version,status FROM schema_migrations WHERE version IN ('024','025')\");console.log(r);await c.end();})()"
```

期望看到两行 `status='applied'`。**如果都是 `applied` → 跳到 Step 4(直接重启 NSSM)**。
如果有 `pending` / `failed` / `missing` → 进 Step 1。

---

## Step 1 — 准备脚本

`scripts/apply-missing-migrations.ps1` 已生成。它会:

1. 从 `center/appsettings.json` 读连接参数(无内联密码)
2. 列举 `db/migrations/*.sql` 中所有 `schema_migrations` 标记缺失或失败的
3. 逐个执行,完成后在 `schema_migrations` 写入 `applied` + sha256
4. 失败时把 `status='failed'`,写入 `error_message`,中断后续

---

## Step 2 — 先 dry-run

```powershell
cd D:\ToolDevelop\ADDashboard
powershell -NoProfile -File .\scripts\apply-missing-migrations.ps1 -DryRun
```

期望看到 `=== Migration gap ===` 段。如果列出来的版本号 **正好是 024 + 025**,继续。
如果列出来的版本号 **不是 024 + 025**,说明 live DB 比代码老得多,**停下来**,
先看 git log 是不是从老分支部署的、然后再判断要不要升级 schema。

---

## Step 3 — 实跑

```powershell
powershell -NoProfile -File .\scripts\apply-missing-migrations.ps1
```

脚本会提示 "Apply N migration(s)? [y/N]"。输 `y` 回车。

预期输出:
- `Applying 024 :: ad-admin-commands.sql` → `✓ 024 applied`
- `Applying 025 :: ad-member-commands.sql` → `✓ 025 applied`
- 末尾绿字 `Done. Restart center NSSM service ...`

可能的中断:
| 失败 | 原因 | 修复 |
|---|---|---|
| `Cannot connect to MySQL` | password 错误 / MySQL 没起 | 查 `appsettings.json` 的 `db.mysql.password`,确认 `net start mysql` 已起 |
| `DROP TABLE ... FAILED` | 有人在用这张表 | 让 agent / center 先停掉 |
| `INSERT INTO schema_migrations FAILED` | 重复 key(checksum 改了) | UPDATE 现有行而不是 INSERT — 脚本下次跑会自己 upsert |

---

## Step 4 — 重启 center

⚠️ **永远不要让我(Claude)帮你执行这一步**。你要:

```powershell
nssm restart ADDashboardCenter
# 或
nssm stop ADDashboardCenter && nssm start ADDashboardCenter
```

观察启动日志:
```powershell
Get-Content D:\ToolDevelop\ADDashboard\logs\center.log -Tail 50 -Wait
```

期望看到:
- `startup auto-migration` 行无新增 gap(若有,说明上面有 step 没做)
- `service ready on port 8080`
- 无 `schema_migrations` 错误

---

## Step 5 — 验证表存在

任选一种:

**Web UI**:
- 浏览器打开 `http://127.0.0.1:8080/admin/ad-commands`(R75 用户管理 → 命令队列)
- 应看到空列表 + 新表格

**curl**:
```powershell
curl http://127.0.0.1:8080/api/admin/ad-commands -H "Authorization: Bearer <admin-jwt>"
# 期望:200 OK + JSON 数组
```

---

## 不要做的事

| ❌ 操作 | 为什么 |
|---|---|
| 直接跑整个 `db/migrations/` 目录 | 已经 applied 的会重新执行 — 虽然 idempotent 但 log 噪音大 |
| 手工 INSERT 到 `schema_migrations` | checksum / applied_at 不会被追踪,审计失败 |
| 跳过 Step 0 现场探查 | 你不知道是不是真的有 gap,跑空浪费时间 |
| 在 mysql CLI 里手敲 `CREATE TABLE` | schema_migrations 不会更新 — 下次启动又跑一遍 |

---

## 现场参考(2026-09-20 我探查到的状态)

```
schema_migrations 当前状态:
  001..025  全部 'applied'
  ad_admin_commands / ad_member_commands 表已存在,字段和索引完全匹配 024/025 的 DDL
```

**结论:live DB 已经 ready。这份 runbook 是给将来再有新 migration 时用的,
今天不需要执行任何 SQL,直接重启 NSSM 即可。**