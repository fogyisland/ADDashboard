import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

function requestJson({ method, url, headers, body, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', ...headers },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch { resolve({ ok: false, status: res.statusCode, data }); }
      });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export function postReport({ centerUrl, agentToken, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${centerUrl}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: { agentId: snapshot.AgentId, collectedAt: snapshot.CollectedAt, data: snapshot.Entries }
  });
}

export function postHeartbeat({ centerUrl, agentToken, payload }) {
  return requestJson({
    method: 'POST',
    url: `${centerUrl}/api/agent/heartbeat`,
    headers: { 'X-Agent-Token': agentToken },
    body: payload
  });
}

export function fetchConfig({ centerUrl, agentToken }) {
  return requestJson({
    method: 'GET',
    url: `${centerUrl}/api/agent/config`,
    headers: { 'X-Agent-Token': agentToken }
  });
}