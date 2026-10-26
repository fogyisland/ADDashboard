// 不在命令中显示 token。读 appsettings.json 后通过 signedRequestJson 调。
import { readFileSync } from 'node:fs';
import { signedRequestJson } from '../src/reporter.js';
const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));

for (const url of [
  'http://10.170.140.23:8080/api/agent/replication-partners?hostname=KDLWXOFADSRV1',
  'http://10.170.140.23:8081/api/agent/replication-partners?hostname=KDLWXOFADSRV1',
]) {
  const r = await signedRequestJson({
    method: 'GET', url, headers: {}, body: null, timeoutMs: 8000,
    agentToken: cfg.agentToken, hostname: 'KDLWXOFADSRV1', agentId: cfg.agentId,
  });
  console.log(`${r.status} ${url}: ${typeof r.data === 'string' ? r.data.slice(0,200) : JSON.stringify(r.data).slice(0,200)}`);
}