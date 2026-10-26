# agent/data/

运行时生成的数据目录,绿色包内**为空**。

## 运行时填入的子目录

- `packages/<name>/<version>/manifest.json + collect.ps1` — 由 `package-manager.js` 的 `syncFromCenter()` 从 center 拉取
- `packages/<name>/current.json` — 同上,记录当前激活版本
- `last-collect/<name>.json` — 最近一次 collect.ps1 的输出快照(供本地 dashboard 读)
- `report-queue.json` — center 离线时缓冲的上报结果
- `queue.db` — better-sqlite3 本地持久化队列

## 首次部署

agent 启动后第一次 heartbeat 触发 `syncFromCenter()`(约 30 秒内),
会从 center 拉当前 agent 启用的包列表。如果中心没启用任何包,
这个目录会保持为空(`packages/` 不存在)。

## 不要把此目录提交

`.gitignore` 应该包含 `data/`,只保留此 README。
