// 查 centre 上 partner_port_status 表的数据
import { readFileSync } from 'node:fs';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';
const headers = {};
const agentToken = cfg.agentToken;
const agentId = cfg.agentId;

// 试探多个可能的 endpoint
const probes = [
  // 8082 上 admin 视图
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/api/admin/partner-port-status?hostname=${hostname}`, label: '8082 admin/partner-port-status' },
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/api/admin/partner-ports?hostname=${hostname}`, label: '8082 admin/partner-ports' },
  // 8080 上 admin
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/admin/partner-port-status?hostname=${hostname}`, label: '8080 admin/partner-port-status' },
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/admin/partner-ports?hostname=${hostname}`, label: '8080 admin/partner-ports' },
  // agent view
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/partner-port-status?hostname=${hostname}`, label: '8081 agent/partner-port-status' },
  // packages report history
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/api/admin/packages/runs?packageName=ad_partner_ports_probe&hostname=${hostname}&limit=5`, label: '8082 packages runs' },
  // agent packages
  { url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/packages?hostname=${hostname}`, label: '8081 packages' },
];

for (const p of probes) {
  try {
    const r = await signedRequestJson({
      method: 'GET',
      url: p.url,
      headers,
      body: null,
      timeoutMs: 8000,
      agentToken, hostname, agentId,
    });
    const txt = (typeof r.data === 'string') ? r.data : JSON.stringify(r.data);
    console.log(`\n=== ${p.label} ===`);
    console.log(`status: ${r.status}`);
    console.log(txt ? txt.slice(0, 1500) : '(empty)');
  } catch (e) {
    console.log(`\n=== ${p.label} === ERROR: ${e.message}`);
  }
}