// 探测 packages list 端点 — 用户在"包"页面看到了上报数据
import { readFileSync } from 'node:fs';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';
const agentToken = cfg.agentToken;
const agentId = cfg.agentId;

const probes = [
  // web 8080 — SPA 用的端点（无 /api 前缀）
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/packages?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/packages/ad_partner_ports_probe?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/package-runs?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/package-runs?hostname=${hostname}&packageName=ad_partner_ports_probe`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/runs?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/runs?hostname=${hostname}&packageName=ad_partner_ports_probe`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/packages?hostname=${hostname}`,
  // 8081 heartbeat
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/packages?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/packages/ad_partner_ports_probe?hostname=${hostname}`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/packages/runs?hostname=${hostname}&packageName=ad_partner_ports_probe`,
];

for (const url of probes) {
  const r = await signedRequestJson({
    method: 'GET', url, headers: {}, body: null, timeoutMs: 6000,
    agentToken, hostname, agentId,
  });
  const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  console.log(`${r.status} ${url.replace(cfg.centerUrl, '')}`);
  console.log(`  ${body ? body.slice(0, 500) : '(null)'}`);
}