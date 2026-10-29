# agent/data/

运行时生成的数据目录,绿色包内**为空**。

## 运行时填入的子目录

- `packages/<name>/<version>/collect.ps1` — 中心下发的**非 AD 包**
  (`agent.type='non-ad'` + `scope='agent_type:non-ad'` + `platforms` 含
  `'windows'`,三个条件缺一不可)。由 `src/non-ad-scheduler.js` 排程、
  `src/package-runner.js` 执行。落盘路径**只能**在
  `<agentDataDir>\packages` 之内(agent.js 的 packagesRoot +
  `src/lib/path-safety.js` 的 safeJoin 双重约束)。
- `upgrade-history.json` — 自动升级审计流水。每成功套用一份新 bundle 追加一条
  (`src/upgrade-delivery.js` Stage 6)。

> 本血统**没有** `queue.db`(better-sqlite3 队列)、没有 `last-collect/`、
> 没有 `report-queue.json` —— 那些都是 AD 采集线的产物,R161.23 已从
> 成员绿色包里连根删除。

## 首次部署

agent 启动后第一次心跳触发包清单拉取(约 30 秒内)。如果中心没有下发任何
非 AD 包,这个目录会保持为空(`packages/` 不存在)。

## 不要把此目录提交

`.gitignore` 应该包含 `data/`,只保留此 README。
