// 验证 centre 的 /api/agent/replication-partners 是否真有数据
import { readFileSync } from 'node:fs';
import { signedRequestJson, baseUrl } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const hostname = 'KDLWXOFADSRV1';
const r = await signedRequestJson({
  method: 'GET',
  url: `${baseUrl({ centerUrl: cfg.centerUrl, port: 8081 })}/api/agent/replication-partners?hostname=${hostname}`,
  headers: {}, body: null, timeoutMs: 8000,
  agentToken: cfg.agentToken, hostname, agentId: cfg.agentId,
});
console.log('status:', r.status);
console.log('body:', JSON.stringify(r.data, null, 2).slice(0, 2000));