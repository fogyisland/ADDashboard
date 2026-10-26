// 列 centre 上实际存在的 agent 路由（探测几个常见 endpoint）
import { readFileSync } from 'node:fs';
import { signedRequestJson } from '../src/reporter.js';
const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const base = cfg.centerUrl;

const candidates = [
  // 已知存在的
  '/api/agent/ad-commands',
  '/api/agent/file-push',
  '/api/agent/member-commands',
  '/api/agent/packages',
  '/api/agent/packages/list',
  '/api/agent/diagnostics',
  '/api/agent/health',
  '/api/agent/discovery',
  // 没见过的
  '/api/agent/partnerPortStatus',
  '/api/agent/system-ports?hostname=KDLWXOFADSRV1',
  '/api/agent/systemPorts',
  '/api/agent/replication-partner-status',
  '/api/agent/destinations',
];

for (const url of candidates) {
  try {
    const r = await signedRequestJson({
      method: 'GET',
      url: `${base}${url}`,
      headers: {}, body: null, timeoutMs: 8000,
      agentToken: cfg.agentToken, hostname: cfg.hostname || cfg.agentId, agentId: cfg.agentId,
    });
    const preview = typeof r.data === 'string' ? r.data.slice(0, 120).replace(/\n/g, ' ').replace(/\s+/g, ' ') : JSON.stringify(r.data).slice(0, 120);
    console.log(`${r.status} ${url}: ${preview}`);
  } catch (e) {
    console.log(`ERR ${url}: ${e.message?.slice(0,80)}`);
  }
}