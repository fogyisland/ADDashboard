// 探 8080/8081/8082 三个端口
import { readFileSync } from 'node:fs';
import { signedRequestJson } from '../src/reporter.js';
const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';

const candidates = [
  'replication-partners', 'ports', 'partner-ports', 'partnerPortStatus',
  'destinations', 'replication-partner-ports', 'partner-ports-config', 'system-ports-config',
];

for (const port of [8080, 8081, 8082]) {
  console.log(`\n=== port ${port} ===`);
  for (const path of candidates) {
    const url = `http://10.170.140.23:${port}/api/agent/${path}?hostname=${hostname}`;
    try {
      const r = await signedRequestJson({
        method: 'GET', url, headers: {}, body: null, timeoutMs: 5000,
        agentToken: cfg.agentToken, hostname, agentId: cfg.agentId,
      });
      const preview = typeof r.data === 'string' ? r.data.slice(0, 100).replace(/\n/g, ' ').replace(/\s+/g, ' ') : JSON.stringify(r.data).slice(0, 100);
      console.log(`  ${r.status} ${path}: ${preview}`);
    } catch (e) {
      console.log(`  ERR ${path}: ${e.message?.slice(0,60)}`);
    }
  }
}