// 直查 centre 的两个 endpoint 验证数据是否真的为空
import { readFileSync } from 'node:fs';
import { signedRequestJson } from '../src/reporter.js';

const cfg = JSON.parse(readFileSync('C:\\agentInstall\\agent\\appsettings.json', 'utf8').replace(/^﻿/, ''));
const base = cfg.centerUrl;

console.log('cfg keys:', Object.keys(cfg));
console.log('agentToken prefix:', cfg.agentToken?.slice(0, 8));
console.log('hostname:', cfg.hostname, 'agentId:', cfg.agentId);
console.log('centerUrl:', cfg.centerUrl);

for (const url of [
  '/api/agent/replication-partners?hostname=KDLWXOFADSRV1',
  '/api/agent/ports?hostname=KDLWXOFADSRV1',
  '/api/agent/replication-partners',
  '/api/agent/ports',
]) {
  try {
    const r = await signedRequestJson({
      method: 'GET',
      url: `${base}${url}`,
      headers: {},
      body: null,
      timeoutMs: 10000,
      agentToken: cfg.agentToken,
      hostname: cfg.hostname || cfg.agentId,
      agentId: cfg.agentId,
    });
    console.log(`\n${url}:`);
    console.log('  status:', r.status, 'ok:', r.ok);
    console.log('  data:', JSON.stringify(r.data).slice(0, 800));
  } catch (e) {
    console.log(`\n${url}: ERROR ${e.message}`);
  }
}