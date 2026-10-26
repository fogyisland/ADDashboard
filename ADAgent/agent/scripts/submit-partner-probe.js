// 读上一次 cmd /c powershell 跑的输出（agent 上数据），POST 到 centre
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const scriptPath = 'C:\\agentInstall\\agent\\data\\packages\\ad_partner_ports_probe\\1.0.0\\collect.ps1';

// 在 admin 上下文跑一次（cmd /c powershell 会继承当前 user 凭据）。
const stdout = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
  encoding: 'utf8', windowsHide: true,
});
const trimmed = stdout.trim();
console.log('--- collect.ps1 stdout ---');
console.log(trimmed);
let parsed;
try { parsed = JSON.parse(trimmed); }
catch (e) { console.error('parse failed:', e.message); process.exit(1); }

const metrics = parsed?.metrics;
console.log('peers count:', metrics?.peers?.length);
if (!metrics?.peers?.length) { console.error('still empty, abort'); process.exit(1); }

const startedAt = new Date().toISOString();
const runRecord = {
  packageName: 'ad_partner_ports_probe',
  version: '1.0.0',
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs: 0,
  exitCode: 0,
  timedOut: false,
  metrics,
  stdoutPreview: trimmed.slice(-2000),
  stderrPreview: '',
};

const r = await signedRequestJson({
  method: 'POST',
  url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/api/agent/packages/report`,
  headers: {},
  body: { source: 'manual-trigger', runs: [runRecord] },
  timeoutMs: 30000,
  agentToken: cfg.agentToken,
  hostname: cfg.hostname || cfg.agentId,
  agentId: cfg.agentId,
});
console.log('\nPOST /api/agent/packages/report:', { ok: r.ok, status: r.status });
console.log('response:', JSON.stringify(r.data).slice(0, 500));

writeFileSync('C:\\agentInstall\\agent\\data\\partner-probe-submit.json', JSON.stringify({
  submittedAt: new Date().toISOString(),
  runRecord,
  post: { ok: r.ok, status: r.status, body: r.data },
}, null, 2));
console.log('\nsaved to C:\\agentInstall\\agent\\data\\partner-probe-submit.json');
process.exit(r.ok ? 0 : 1);