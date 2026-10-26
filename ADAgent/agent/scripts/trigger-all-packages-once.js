// 2026-09-27 — 一次性触发脚本：实例化 PackageManager，调用 runAllNow()，
// 立即让所有 enabled 包并行跑一次并把结果 flush 到中心。
//
// 触发方式：node scripts/trigger-all-packages-once.js
// 注意：运行期间不要重启 ADReplicationAgent 服务，避免与进程内
// PackageManager 的 disk-queue / current.json 互相覆盖。

import { readFileSync } from 'node:fs';
import { config as loadEnv } from 'node:process';
import { PackageManager } from '../src/package-manager.js';

const appsettingsPath = 'C:\\agentInstall\\agent\\appsettings.json';
const raw = readFileSync(appsettingsPath, 'utf8').replace(/^﻿/, '');
const cfg = JSON.parse(raw);

// Minimal console-only logger so we can watch progress without depending
// on the agent's pino instance.
const log = {
  debug: (...a) => console.log('[debug]', ...a.map(safeJson)),
  info:  (...a) => console.log('[info]', ...a.map(safeJson)),
  warn:  (...a) => console.warn('[warn]', ...a.map(safeJson)),
  error: (...a) => console.error('[error]', ...a.map(safeJson)),
  child: () => log,
};
function safeJson(v) {
  if (v === null || typeof v !== 'object') return String(v);
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}

const pm = new PackageManager({
  agentId: cfg.agentId,
  agentVersion: 'manual-trigger',
  centerBaseUrl: cfg.centerUrl,
  agentToken: cfg.agentToken,
  hostname: cfg.hostname || cfg.agentId,
  dataDir: cfg.agentDataDir,
  logger: log,
  powerShellPath: cfg.powerShellPath || 'powershell.exe',
  // R93.5 — packages endpoint lives on report app (8082). We don't have
  // access to agent.js's cachedPorts here; pass snapshot from appsettings
  // or fall back to env var. The centre has been observed to publish
  // reportApp on 8082.
  getReportPort: () => Number(process.env.REPORT_PORT) || 8082,
});

console.log('[info] trigger: manual fan-out start, dataDir=', cfg.agentDataDir);
const started = Date.now();
const result = await pm.runAllNow({ triggeredBy: 'manual-trigger' });
const finishedAt = new Date();
console.log('[info] trigger: manual fan-out complete', {
  count: result.count,
  ms: finishedAt - started,
  summary: result.results.map((r, i) => ({
    status: r.status,
    exitCode: r.status === 'fulfilled' ? r.value?.exitCode : null,
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
  })),
});
process.exit(0);