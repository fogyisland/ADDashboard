// 探测 centre 上 admin page 列表，看看前端 partner-ports 页面从哪儿拿数据
import { readFileSync } from 'node:fs';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';
const agentToken = cfg.agentToken;
const agentId = cfg.agentId;

// 1) 试 admin 页面（web 8080 上）
const webProbes = [
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/admin`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/admin/partner-ports`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/admin/partners`,
  `${baseUrl({ centerUrl: cfg.centerUrl, port: 8080 })}/api/admin`,
];

for (const url of webProbes) {
  try {
    const r = await signedRequestJson({
      method: 'GET', url, headers: {}, body: null, timeoutMs: 6000,
      agentToken, hostname, agentId,
    });
    console.log(`\n=== ${url} ===\nstatus: ${r.status}, length: ${(JSON.stringify(r.data) || '').length}`);
    if (r.status === 200 && r.data) {
      const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      // 找 page-render 的 marker (admin/partner-ports 可能 SSR)
      const m = body.match(/partner[-_]?port[s]?/gi);
      console.log('partner-port matches:', m ? m.length : 0);
    }
  } catch (e) { console.log(`\n=== ${url} === ERR ${e.message}`); }
}

// 2) 试 8082 列出所有 routes (express 通常没这接口，但 /404 提示可以)
console.log('\n--- 8082 root ---');
const r2 = await signedRequestJson({
  method: 'GET', url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8082 })}/`, headers: {}, body: null, timeoutMs: 6000,
  agentToken, hostname, agentId,
});
console.log('status:', r2.status, 'len:', (JSON.stringify(r2.data) || '').length);