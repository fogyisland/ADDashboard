// 探测 centre SPA 调用的 partner-port-status API（前端用 webpack chunk 加载，但常见命名模式）
import { readFileSync } from 'node:fs';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';
const agentToken = cfg.agentToken;
const agentId = cfg.agentId;

const probes = [
  // web mount (8080) admin namespace
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/admin/partner-port-status?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/admin/partner-ports?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/admin/replication-partners?hostname=${hostname}`,
  // heartbeat mount (8081)
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/admin/partner-port-status?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/admin/partner-ports?hostname=${hostname}`,
  // 可能 SPA 直接走 partner-port-status json
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/partner-port-status?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/partner-ports?hostname=${hostname}`,
];

for (const url of probes) {
  const r = await signedRequestJson({
    method: 'GET', url, headers: {}, body: null, timeoutMs: 5000,
    agentToken, hostname, agentId,
  });
  const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  console.log(`${r.status} ${url.replace(cfg.centerUrl, '')} → ${body.slice(0, 200)}`);
}