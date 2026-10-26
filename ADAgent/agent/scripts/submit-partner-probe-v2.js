// 从 centre 8081 拿真实 peers + ports，组合成 metrics，POST 到 8082
import { readFileSync, writeFileSync } from 'node:fs';
import { signedRequestJson, baseUrl } from '../src/reporter.js';
import net from 'node:net';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';

// 1. 拿真实 peers
const peersResp = await signedRequestJson({
  method: 'GET',
  url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/replication-partners?hostname=${hostname}`,
  headers: {}, body: null, timeoutMs: 10000,
  agentToken: cfg.agentToken, hostname, agentId: cfg.agentId,
});
console.log('peers fetch:', peersResp.status, JSON.stringify(peersResp.data).slice(0, 200));
const peers = peersResp.data?.partners || [];
console.log('peers:', peers.length);

// 2. 拿真实 port 配置
const portsResp = await signedRequestJson({
  method: 'GET',
  url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/ports?hostname=${hostname}`,
  headers: {}, body: null, timeoutMs: 10000,
  agentToken: cfg.agentToken, hostname, agentId: cfg.agentId,
});
console.log('ports fetch:', portsResp.status);
const ports = Array.isArray(portsResp.data) ? portsResp.data : (portsResp.data?.ports || []);
console.log('ports:', ports.length, 'sample:', ports.slice(0, 2));

// 3. 探测每个 (peer × port)
const probePort = (host, port, timeoutMs = 2000) => new Promise((resolve) => {
  const client = new net.Socket();
  const start = Date.now();
  let settled = false;
  const finish = (ok, latency) => {
    if (settled) return;
    settled = true;
    try { client.destroy(); } catch {}
    resolve({ ok, latency });
  };
  client.setTimeout(timeoutMs);
  client.once('connect', () => finish(true, Date.now() - start));
  client.once('timeout', () => finish(false, null));
  client.once('error', () => finish(false, null));
  client.connect(port, host);
});

const peersPayload = [];
for (const peer of peers) {
  const destDc = peer.destDc;
  if (!destDc) continue;
  const portResults = [];
  for (const port of ports) {
    const portNum = Number(port.port);
    if (!Number.isFinite(portNum) || portNum <= 0) {
      portResults.push({ port: null, ok: false, latency: null });
      continue;
    }
    const r = await probePort(destDc, portNum);
    portResults.push({ port: portNum, ok: r.ok, latency: r.latency });
  }
  peersPayload.push({ destDc, ports: portResults });
}

const metrics = {
  agent_id: cfg.hostname || cfg.agentId,
  collected_at: new Date().toISOString(),
  peers: peersPayload,
};

const runRecord = {
  packageName: 'ad_partner_ports_probe',
  version: '1.0.0',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 0,
  exitCode: 0,
  timedOut: false,
  triggeredBy: 'manual',
  pushed: true,
  stdoutPreview: JSON.stringify(metrics).slice(0, 2000),
  stderrPreview: '',
  metrics,
};

console.log('\n=== composed metrics ===');
console.log(JSON.stringify(metrics, null, 2));

// 4. POST
const r = await signedRequestJson({
  method: 'POST',
  url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/api/agent/packages/report`,
  headers: {},
  body: { source: 'manual-trigger', runs: [runRecord] },
  timeoutMs: 30000,
  agentToken: cfg.agentToken, hostname, agentId: cfg.agentId,
});
console.log('\nPOST /api/agent/packages/report:', { ok: r.ok, status: r.status });
console.log('response:', JSON.stringify(r.data).slice(0, 500));

writeFileSync('C:\\agentInstall\\agent\\data\\partner-probe-submit.json', JSON.stringify({
  submittedAt: new Date().toISOString(),
  runRecord,
  post: { ok: r.ok, status: r.status, body: r.data },
}, null, 2));
process.exit(r.ok ? 0 : 1);