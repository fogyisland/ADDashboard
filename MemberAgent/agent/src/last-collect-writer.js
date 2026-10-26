// src/last-collect-writer.js — 把每次 collect.ps1 成功结果落到本地
//
// 用途: dashboard 通过读取这些文件来展示"最近报表",无需每次打开浏览器都
//       去问 center 拉数据,也不依赖 agent 是否在运行。
//
// 设计:
//   - 每个包只保留最近一次结果(覆盖式)
//   - 原子写(tmp + rename),dashboard 读时绝不会看到半个文件
//   - 失败只 warn 不 throw,落盘失败不影响主流程(上报给 center 仍正常)
//   - 文件名 sanitization:<name>.json,name 里只允许 [A-Za-z0-9._-]
//
// 调入点: package-runner.js 在 child.on('exit') 末尾、且 metrics 解析成功时调用。

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

function safeName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`unsafe package name: ${name}`);
  }
  return name;
}

export async function writeLastCollect(agentDataDir, packageName, result) {
  const dir = join(agentDataDir, 'last-collect');
  const safe = safeName(packageName);
  const finalPath = join(dir, `${safe}.json`);
  const tmpPath = join(dir, `${safe}.json.tmp`);

  await fs.mkdir(dir, { recursive: true });

  // 把 result 序列化成稳定 JSON,再写盘
  const payload = JSON.stringify({
    packageName: safe,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    exitCode: result.exitCode,
    metrics: result.metrics,
    error: result.error,
    writtenAt: new Date().toISOString()
  }, null, 2);

  await fs.writeFile(tmpPath, payload, 'utf8');
  // rename 在同一文件系统上是原子的(Windows NTFS 保证)
  await fs.rename(tmpPath, finalPath);
}

// 给 dashboard 端枚举用(扫描目录读所有 .json)
export async function listLastCollect(agentDataDir) {
  const dir = join(agentDataDir, 'last-collect');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name.endsWith('.tmp')) continue;
    const name = e.name.slice(0, -5);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    try {
      const st = await fs.stat(join(dir, e.name));
      out.push({ name, mtime: st.mtime, size: st.size });
    } catch (e) { /* ignore */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
