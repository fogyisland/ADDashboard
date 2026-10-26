// 列 centre 8080 上所有 /api/agent/* 路由
import { readFileSync } from 'node:fs';
import { signedRequestJson } from '../src/reporter.js';
const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const base = cfg.centerUrl;

const candidates = [
  '/api/agent/replication-partners',
  '/api/agent/replication-partners?hostname=KDLWXOFADSRV1',
  '/api/agent/replicationPeers',
  '/api/agent/partner-ports',
  '/api/agent/partners',
  '/api/agent/ports',
  '/api/agent/system-ports',
  '/api/agent/replication-partner-ports',
];

for (const url of candidates) {
  try {
    const r = await signedRequestJson({
      method: 'GET',
      url: `${base}${url}`,
      headers: {}, body: null, timeoutMs: 10000,
      agentToken: cfg.agentToken, hostname: cfg.hostname || cfg.agentId, agentId: cfg.agentId,
    });
    const preview = typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data).slice(0, 200);
    console.log(`${r.status} ${url}: ${preview}`);
  } catch (e) {
    console.log(`ERR ${url}: ${e.message}`);
  }
}