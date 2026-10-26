// 跑一次 collect.ps1 然后把结果 POST 到 centre 的 /api/agent/packages/report
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const appsettingsPath = 'C:\\agentInstall\\agent\\appsettings.json';
const cfg = JSON.parse(readFileSync(appsettingsPath, 'utf8').replace(/^﻿/, ''));
const scriptPath = 'C:\\agentInstall\\agent\\data\\packages\\ad_partner_ports_probe\\1.0.0\\collect.ps1';

const startedAt = new Date();
const t0 = Date.now();

// spawn collect.ps1
const stdoutChunks = [];
const stderrChunks = [];
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => stdoutChunks.push(d));
child.stderr.on('data', (d) => stderrChunks.push(d));

const decode = (buf) => {
  if (!buf || buf.length === 0) return '';
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return strict;
  } catch {}
  try { return new TextDecoder('gbk', { fatal: false }).decode(buf); } catch {}
  return buf.toString('utf8');
};

child.on('exit', async (code) => {
  const finishedAt = new Date();
  const stdoutB = Buffer.concat(stdoutChunks);
  const stderrB = Buffer.concat(stderrChunks);
  const stdout = decode(stdoutB);
  const stderr = decode(stderrB);

  let metrics = null;
  try {
    const parsed = JSON.parse(stdout.trim());
    metrics = parsed?.metrics ?? null;
  } catch (e) {
    console.error('parse stdout failed:', e.message);
    console.error('stdout:', stdout.slice(0, 500));
    process.exit(1);
  }

  const runRecord = {
    packageName: 'ad_partner_ports_probe',
    version: '1.0.0',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - t0,
    exitCode: code ?? -1,
    timedOut: false,
    metrics,
    stdoutPreview: stdout.slice(-2000),
    stderrPreview: stderr.slice(-2000),
  };

  console.log('collect.ps1 exit:', code);
  console.log('peers count:', metrics?.peers?.length);
  if (metrics?.peers?.[0]) {
    console.log('peer[0]:', JSON.stringify(metrics.peers[0]));
  }

  // POST to centre
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
  console.log('POST /api/agent/packages/report:', { ok: r.ok, status: r.status });
  console.log('response:', JSON.stringify(r.data).slice(0, 500));

  writeFileSync('C:\\agentInstall\\agent\\data\\partner-probe-submit.json', JSON.stringify({
    submittedAt: new Date().toISOString(),
    runRecord,
    post: { ok: r.ok, status: r.status, body: r.data },
  }, null, 2));
  console.log('saved to C:\\agentInstall\\agent\\data\\partner-probe-submit.json');
  process.exit(r.ok ? 0 : 1);
});