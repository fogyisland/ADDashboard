// 2026-09-27 — 一次性手动触发脚本：读取本机已缓存的 packages，
// 跑每个 collect.ps1，把 run 结果直接 POST 到
// /api/agent/packages/report。不依赖 agent 进程的 PackageManager 状态，
// 避免 disk-queue / in-memory batch 竞态。运行结束后把结果落盘到
// C:\agentInstall\agent\data\manual-trigger-results.json 便于核对。

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

// R158.100 (2026-10-14) — appsettingsPath must be derived from environment
// rather than hard-coded. R158.86.6 split the member-server install root
// to C:\MemberServer\agent\ (was C:\agentInstall\agent\) for KDLFLPBISRV.
// The hard-coded path crashed the manual-trigger one-shot script the
// moment the operator tried to backfill a member package after a 24h
// cadence gap. Search in order: $env:AD_AGENT_APP_SETTINGS (explicit
// override), the R158.86.6 install root, the legacy R158.13 install
// root. This matches the resolution order agent.js uses to locate
// appsettings.json at boot — see agent.js:54-72.
const appsettingsPath = (() => {
  if (process.env.AD_AGENT_APP_SETTINGS) return process.env.AD_AGENT_APP_SETTINGS;
  const candidates = [
    'C:\\MemberServer\\agent\\appsettings.json',   // R158.86.6+ member-server
    'C:\\agentInstall\\agent\\appsettings.json',   // R158.13 legacy (pre-R158.86.6)
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return candidates[0];   // fall through, will throw on readFileSync
})();
const cfg = JSON.parse(readFileSync(appsettingsPath, 'utf8').replace(/^﻿/, ''));

const dataDir = cfg.agentDataDir;
const packagesDir = join(dataDir, 'packages');
const outFile = join(dataDir, 'manual-trigger-results.json');

if (!existsSync(packagesDir)) {
  console.error('packages dir missing:', packagesDir);
  process.exit(1);
}

// Enumerate installed packages (those with current.json)
const installed = readdirSync(packagesDir).filter((name) => {
  try { return existsSync(join(packagesDir, name, 'current.json')); } catch { return false; }
});
console.log('[info] installed packages:', installed);

// Build runOne tasks (parallel via Promise.allSettled, mirrors PackageManager.runAllNow)
async function runOne(name) {
  const currentPath = join(packagesDir, name, 'current.json');
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  const version = current.version;
  const scriptPath = join(packagesDir, name, version, 'collect.ps1');
  const manifestPath = join(packagesDir, name, version, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const params = manifest?.params || {};
  const timeoutMs = manifest?.agent?.timeoutMs || 30000;

  // Mirror package-runner.js: build param flag list, spawn powershell -File <script> <flags>
  const argList = [];
  for (const [k, v] of Object.entries(params)) {
    argList.push(`-${k}`);
    if (typeof v === 'object') argList.push(JSON.stringify(v));
    else argList.push(String(v));
  }

  const startedAt = new Date();
  const t0 = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...argList], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 2026-09-27 — buffer raw bytes; do NOT toString() with a fixed
    // encoding. PowerShell 5.1's pipe stdout is GBK (zh-CN system locale)
    // but the script may emit UTF-8 / UTF-16 BOM in the same stream
    // depending on which cmdlet produced each chunk. Decoding per-chunk
    // with utf-8 (the previous behaviour) silently corrupts GBK bytes
    // into U+FFFD, which then gets JSON.stringify'd as EF BF BD and
    // surfaces downstream as 锟斤拷-style mojibake. Storing raw bytes
    // (latin1 round-trip is the standard pattern for "treat string as
    // opaque bytes in JavaScript") and emitting Buffer.toString('utf8')
    // on read lets the *consumer* pick the right decoder. For ad-hoc
    // dumps we still want a readable string, so we attempt GBK first
    // (zh-CN default) and fall back to UTF-8. Centre POST uses raw
    // bytes via JSON.stringify(Buffer.from(...)) which preserves the
    // original encoding end-to-end.
    let stdoutBuf = [], stderrBuf = [];
    child.stdout.on('data', (d) => stdoutBuf.push(d));
    child.stderr.on('data', (d) => stderrBuf.push(d));
    const decodeBestEffort = (buf) => {
      if (!buf || buf.length === 0) return '';
      // BOM sniffing
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return buf.subarray(3).toString('utf8');
      }
      if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        return buf.subarray(2).toString('utf16le');
      }
      // Strict UTF-8 first; if it has no replacement chars, use it.
      try {
        const strict = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return strict;
      } catch {}
      // Fall back to GBK (zh-CN PowerShell pipe default)
      try {
        return new TextDecoder('gbk', { fatal: false }).decode(buf);
      } catch {}
      // Last resort: lossy UTF-8
      return buf.toString('utf8');
    };
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      const stdoutB = Buffer.concat(stdoutBuf);
      const stderrB = Buffer.concat(stderrBuf);
      resolve({
        exitCode: -1,
        stdout: decodeBestEffort(stdoutB),
        stderr: decodeBestEffort(stderrB) + `\n[timeout after ${timeoutMs}ms]`,
        timedOut: true,
      });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      const stdoutB = Buffer.concat(stdoutBuf);
      const stderrB = Buffer.concat(stderrBuf);
      resolve({
        exitCode: code ?? -1,
        stdout: decodeBestEffort(stdoutB),
        stderr: decodeBestEffort(stderrB),
        timedOut: false,
      });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      const stdoutB = Buffer.concat(stdoutBuf);
      const stderrB = Buffer.concat(stderrBuf);
      resolve({
        exitCode: -1,
        stdout: decodeBestEffort(stdoutB),
        stderr: decodeBestEffort(stderrB) + `\n[spawn error] ${err.message}`,
        timedOut: false,
      });
    });
  });
  const finishedAt = new Date();

  return {
    packageName: name,
    version,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - t0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
  };
}

console.log('[info] running', installed.length, 'packages in parallel…');
const settled = await Promise.allSettled(installed.map(runOne));
const runs = settled.map((r, i) => {
  if (r.status === 'fulfilled') return r.value;
  return { packageName: installed[i], error: String(r.reason?.message || r.reason) };
});

console.log('[info] all runs complete; posting batch to /api/agent/packages/report');
const r = await signedRequestJson({
  method: 'POST',
  url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/api/agent/packages/report`,
  headers: {},
  body: { source: 'manual-trigger', runs },
  timeoutMs: 30000,
  agentToken: cfg.agentToken,
  hostname: cfg.hostname || cfg.agentId,
  agentId: cfg.agentId,
});
console.log('[info] POST /api/agent/packages/report', { ok: r.ok, status: r.status });

writeFileSync(outFile, JSON.stringify({
  triggeredAt: new Date().toISOString(),
  count: runs.length,
  runs,
  post: { ok: r.ok, status: r.status, body: typeof r.data === 'string' ? r.data.slice(0, 500) : r.data },
}, null, 2));
console.log('[info] results saved to', outFile);

const failures = runs.filter((r) => r.exitCode !== 0 || r.timedOut);
console.log('[info] summary: total=%d, failures=%d', runs.length, failures.length);
if (failures.length > 0) {
  console.log('[warn] failures:', failures.map((r) => ({ name: r.packageName, exitCode: r.exitCode, timedOut: r.timedOut })));
}
process.exit(r.ok ? 0 : 1);