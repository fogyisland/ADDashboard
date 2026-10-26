// 试着在 hostname 参数下探测
import { readFileSync } from 'node:fs';
import { signedRequestJson } from '../src/reporter.js';
const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const base = cfg.centerUrl;
const hostname = 'KDLWXOFADSRV1';

const candidates = [
  // partner-ports 数据的可能来源
  `/api/agent/replication-partners?hostname=${hostname}`,
  `/api/agent/ports?hostname=${hostname}`,
  `/api/agent/partner-ports?hostname=${hostname}`,
  `/api/agent/partnerPortStatus?hostname=${hostname}`,
  `/api/agent/destinations?hostname=${hostname}`,
  `/api/agent/replication-partner-ports?hostname=${hostname}`,
  // 心跳端口
  `/api/agent/heartbeat`,
];

for (const url of candidates) {
  try {
    const r = await signedRequestJson({
      method: 'GET',
      url: `${base}${url}`,
      headers: {}, body: null, timeoutMs: 8000,
      agentToken: cfg.agentToken, hostname, agentId: cfg.agentId,
    });
    const preview = typeof r.data === 'string' ? r.data.slice(0, 150).replace(/\n/g, ' ').replace(/\s+/g, ' ') : JSON.stringify(r.data).slice(0, 150);
    console.log(`${r.status} ${url}: ${preview}`);
  } catch (e) {
    console.log(`ERR ${url}: ${e.message?.slice(0,80)}`);
  }
}