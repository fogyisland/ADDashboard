// 2026-10-29 R161.23 — non-AD 血统的「一次性把所有包跑一遍」脚本。
//
// ── 为什么这个文件跟 AD 端同名文件内容完全不同 (血统隔离, 不能照抄) ──────
//   AD 端 (Server/agent/scripts/trigger-all-packages-once.js) 实例化
//   src/package-manager.js 的 PackageManager, 调 runAllNow()。
//
//   ★ non-AD 血统里**根本没有 package-manager.js** —— R158.75 fork 删掉了
//     它 (它带 better-sqlite3 原生依赖 + AD 专属的磁盘队列), noad 端用的是
//     src/non-ad-scheduler.js (定时器 + 谓词) + src/package-runner.js (执行)。
//     ⇒ 之前这里照抄 AD 端的那句
//         import { PackageManager } from '../src/package-manager.js';
//     在 noad 树里是 **ERR_MODULE_NOT_FOUND** —— 操作员手动跑这个脚本
//     100% 崩在第 10 行, 一个字都跑不出来。
//
//   现在这份实现与 agent.js 的 runNonAdRuntime **同源同契约**:
//     1. 读 appsettings.json —— 路径相对本脚本定位 (scripts/ 的上一级),
//        **不写死** C:\agentInstall (绿色包可以装在任意目录)。
//     2. GET /api/admin/agent/packages-for-host?hostname=... (签名 GET,
//        带 X-Agent-Token / X-Agent-Signature / X-Agent-Hostname)。
//     3. 用**同一个** shouldRunPackageForNonAd 谓词过滤 —— 跟运行期
//        (agent.js → non-ad-scheduler.applyPackageList) 1:1, 不允许
//        脚本跑一批运行期不会跑的包。
//     4. 脚本路径按 <agentDataDir>\packages\<name>\<version>\collect.ps1
//        **本地派生** (isSafeSegment + safeJoin), 跟 agent.js 的安全契约
//        1:1 —— 中心给的 scriptPath 只在它落在包目录内时才被采纳。
//     5. runPackageScript 跑一次 → postPackagesReport 回传中心
//        (POST /api/agent/packages/report, R161.21 修好的那个路由)。
//
// ── 用法 ──────────────────────────────────────────────────────────────────
//   node scripts/trigger-all-packages-once.js
//   注意：运行期间不要重启 memberServiceAgent 服务 —— 进程内的定时器
//   (non-ad-scheduler 的 localTasks) 与磁盘上的包目录会互相覆盖。
//
// ── 退出码 ────────────────────────────────────────────────────────────────
//   0 = 全部包都尝试过 (单包失败不算整体失败, 失败明细打在 stdout)
//   1 = 致命失败 (appsettings 读不到 / 包清单拉不到 / 参数不全)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signedRequestJson, postPackagesReport, fetchConfig } from '../src/reporter.js';
import { runPackageScript } from '../src/package-runner.js';
import { shouldRunPackageForNonAd } from '../src/non-ad-scheduler.js';
import { isSafeSegment, safeJoin } from '../src/lib/path-safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// appsettings.json 就在 agent/ 根下 (本脚本在 agent/scripts/ 里)。
const AGENT_ROOT = resolve(__dirname, '..');
const APPSETTINGS_CANDIDATES = [
  join(AGENT_ROOT, 'appsettings.json'),
  'C:\\agentInstall\\agent\\appsettings.json',
];

function fail(message) {
  console.error('[error] ' + message);
  process.exit(1);
}

function readAppsettings() {
  for (const candidate of APPSETTINGS_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, 'utf8').replace(/^﻿/, '');
      return { path: candidate, cfg: JSON.parse(raw) };
    } catch (err) {
      fail(`appsettings.json at '${candidate}' is not valid JSON: ${err.message}`);
    }
  }
  fail(
    'appsettings.json not found. Tried: ' + APPSETTINGS_CANDIDATES.join(', ')
    + ' — run this script from the installed agent directory.'
  );
  return null; // unreachable (fail() exits), keeps the linter happy
}

const { path: appsettingsPath, cfg } = readAppsettings();

const centerUrl = String(cfg.centerUrl || '').trim();
const agentToken = String(cfg.agentToken || '').trim();
const agentId = String(cfg.agentId || '').trim();
const hostname = String(cfg.hostname || cfg.agentId || '').trim();
const agentDataDir = String(cfg.agentDataDir || join(AGENT_ROOT, 'data')).trim();
const powerShellPath = String(cfg.powerShellPath || 'powershell.exe').trim();

if (!centerUrl) fail('appsettings.json has no centerUrl — cannot reach the centre.');
if (!agentToken) fail('appsettings.json has no agentToken — the request would be rejected as anonymous.');
if (!hostname) fail('appsettings.json has neither hostname nor agentId — the signed request has no identity.');

console.log('[info] trigger: non-AD fan-out start', {
  appsettings: appsettingsPath,
  centerUrl,
  hostname,
  agentId,
  agentDataDir,
});

// ── 1. 端口探测 (report 端口) ─────────────────────────────────────────────
// packages/report 挂在 report app 上 (R93.5), 端口来自 /api/agent/ports。
// 拿不到就用 centerUrl 原样 (web app 上也注册了这条路由, 兜底不 404)。
let reportPort = null;
try {
  const cfgRes = await fetchConfig({ centerUrl, agentToken });
  if (cfgRes?.ok && cfgRes.data) {
    reportPort = Number(cfgRes.data.reportPort) || null;
  }
} catch (err) {
  console.warn('[warn] /api/agent/ports probe failed:', err.message);
}
console.log('[info] trigger: report port =', reportPort ?? '(fallback: centerUrl as-is)');

// ── 2. 拉本机的包清单 ──────────────────────────────────────────────────────
const listUrl = `${centerUrl}/api/admin/agent/packages-for-host?hostname=${encodeURIComponent(hostname)}`;
const listRes = await signedRequestJson({
  method: 'GET',
  url: listUrl,
  agentToken,
  hostname,
  agentId,
  timeoutMs: 30_000
});
if (!listRes?.ok) {
  fail(`packages-for-host failed: ok=${listRes?.ok} status=${listRes?.status} error=${listRes?.error}`);
}
const items = Array.isArray(listRes.data?.items) ? listRes.data.items : [];
console.log('[info] trigger: centre returned', items.length, 'package(s)');

// ── 3. 用与运行期同一个谓词过滤 ────────────────────────────────────────────
const accepted = items.filter(shouldRunPackageForNonAd);
const rejected = items.filter((p) => !shouldRunPackageForNonAd(p));
for (const p of rejected) {
  console.log('[info] trigger: skipped (not a non-ad/windows package)', {
    name: p?.name,
    scope: p?.scope ?? null,
    agentType: p?.agent?.type ?? null,
  });
}
console.log('[info] trigger: running', accepted.length, 'package(s)');

// ── 4. 逐个跑一遍 ──────────────────────────────────────────────────────────
const packagesRoot = join(agentDataDir, 'packages');
const runs = [];

for (const pkg of accepted) {
  // 路径派生与 agent.js 的 runPackage 1:1: 中心显式给的 scriptPath 只在
  // 落在包目录内时采纳, 否则按 name/version 本地派生。
  let scriptPath = null;
  if (pkg.scriptPath) {
    const resolved = resolve(packagesRoot, pkg.scriptPath);
    const rootResolved = resolve(packagesRoot);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
      console.warn('[warn] trigger: package rejected (scriptPath escapes package root)', {
        name: pkg.name,
        scriptPath: pkg.scriptPath,
      });
      continue;
    }
    scriptPath = resolved;
  } else if (isSafeSegment(pkg.name) && isSafeSegment(pkg.version)) {
    scriptPath = safeJoin(packagesRoot, pkg.name, pkg.version, 'collect.ps1');
  } else {
    console.warn('[warn] trigger: package skipped (no usable scriptPath, unsafe name/version)', {
      name: pkg?.name ?? null,
      version: pkg?.version ?? null,
    });
    continue;
  }

  if (!existsSync(scriptPath)) {
    console.warn('[warn] trigger: package script not materialized locally, skipping', {
      name: pkg.name,
      scriptPath,
    });
    continue;
  }

  const result = await runPackageScript({
    scriptPath,
    params: pkg.params || {},
    timeoutMs: pkg.agent?.timeoutMs || 30_000,
    logger: console,
    powerShellPath
  });
  runs.push({
    packageName: pkg.name,
    hostname,
    ...result
  });
  console.log('[info] trigger: package finished', {
    name: pkg.name,
    ok: result?.ok ?? result?.success ?? null,
    exitCode: result?.exitCode ?? null,
    ms: result?.durationMs ?? null,
  });
}

// ── 5. 回传中心 ───────────────────────────────────────────────────────────
if (runs.length > 0) {
  const reportRes = await postPackagesReport({
    centerUrl,
    agentToken,
    port: reportPort,
    runs,
    hostname,
    agentId
  });
  console.log('[info] trigger: packages/report', {
    ok: reportRes?.ok ?? false,
    status: reportRes?.status ?? null,
    count: runs.length,
  });
} else {
  console.log('[info] trigger: nothing to report (no package produced a result)');
}

console.log('[info] trigger: non-AD fan-out complete', {
  requested: items.length,
  accepted: accepted.length,
  ran: runs.length,
});
process.exit(0);
