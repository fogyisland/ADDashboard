#!/usr/bin/env node
// R161.25 (2026-10-29 部署审计) — 读**本进程真实监听**的端口。
//
// ★ 端口的真值表 (源: Server/center/src/config.js 的注释):
//
//   | 来源 | 含义 | 谁写 |
//   |---|---|---|
//   | appsettings.json `listenPort` | 期望端口 (下次启动要绑的端口) | 初始化向导 / 启动期回写 |
//   | system_config `listenPort` | 期望端口的镜像 (管理后台可改) | 启动期对账 / 管理后台 |
//   | system_config `listenPort_source` | 镜像来源: 'appsettings' \| 'admin' | 同上 |
//   | system_config `center_listen_port_bound` | **当前进程实际绑定的端口** | 每次正常模式启动 |
//
// ★ 为什么必须读 `center_listen_port_bound`, 而不是 `listenPort`:
//   `listenPort` 是**期望**端口 —— 管理后台改了端口但还没重启时, 它是**新**
//   端口, 而服务还在**旧**端口上跑。此时自检脚本去探新端口 ⇒ 把一个完全
//   健康的服务报成 "端口没有监听 (FAIL)" + "健康检查连不上 (WARN)"。
//   ⇒ 自检要探的是"服务现在在哪个端口", 那是 bound 行。
//
// ★ 为什么拿不到 bound 行时不回退到 `listenPort`:
//   老版本中心不写 bound 行, 而老 seed 往库里写死过 8080 (文件里可能是
//   8090) ⇒ 用 `listenPort` 会探错端口。拿不到就**不输出**, 让调用方回退到
//   appsettings.json —— 老版本中心绑的正是文件里的那个值。
//
// 用法: node resolve-listen-port.js [appsettings.json 路径]
// 输出: 一个端口号写到 stdout (只写 bound 行里的值)。
// 退出码: 0 = 读到了; 2 = appsettings.json 读不了/解析失败; 3 = 数据库读不到
//   或没有 bound 行。读不到时**不输出任何内容**。
//
// 只读, 不写任何东西: 连接建立后立刻 close(), 不 seed、不 bootstrap 迁移
// (bootstrapMigrations 传空实现 —— init() 默认会跑一遍迁移 bootstrap,
// 那是有副作用的, 一个"查端口"的脚本绝不能干)。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const centerRoot = resolve(scriptDir, '..', 'center');
const configPath = process.argv[2] || resolve(centerRoot, 'appsettings.json');

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  process.exit(2);
}

let dbModule;
try {
  dbModule = await import(pathToFileURL(resolve(centerRoot, 'src', 'db', 'index.js')).href);
} catch {
  process.exit(3);
}

try {
  // bootstrapMigrations 传空实现 = 跳过迁移 bootstrap (那会建表/改表)。
  await dbModule.init(config, { bootstrapMigrations: async () => {} });
  const db = dbModule.getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'center_listen_port_bound'"
  );
  const port = Number(rows?.[0]?.config_value);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    process.stdout.write(String(port));
    await dbModule.close().catch(() => {});
    process.exit(0);
  }
} catch {
  // 数据库不可达 / 凭据不对 / 表还不存在 —— 全部走回退路径, 不打印噪声。
}

await dbModule.close().catch(() => {});
process.exit(3);
