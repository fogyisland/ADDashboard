import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export function requestJson({ method, url, headers, body, timeoutMs = 30000 }) {
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
        // For 2xx, treat empty body as ok with null data; for non-2xx, return as failure.
        // Avoid swallowing 2xx-with-html as a transport failure.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) return resolve({ ok: true, status: res.statusCode, data: null });
          try { return resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
          catch (e) { return resolve({ ok: true, status: res.statusCode, data: null, error: `non-json body: ${e.message}` }); }
        }
        try { resolve({ ok: false, status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ ok: false, status: res.statusCode, data }); }
      });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// PS script emits entries in PascalCase (SourceDc, DestDc, ...); center's
// upsertStatus reads camelCase (sourceDc, destDc, ...). Convert at this boundary.
function toCamelEntry(e) {
  if (!e) return e;
  return {
    sourceDc: e.SourceDc ?? e.sourceDc ?? null,
    destDc: e.DestDc ?? e.destDc ?? null,
    sourceSite: e.SourceSite ?? e.sourceSite ?? null,
    destSite: e.DestSite ?? e.destSite ?? null,
    namingContext: e.NamingContext ?? e.namingContext ?? null,
    lastSuccessTime: e.LastSuccessTime ?? e.lastSuccessTime ?? null,
    lastAttemptTime: e.LastAttemptTime ?? e.lastAttemptTime ?? null,
    statusCode: e.StatusCode ?? e.statusCode ?? null,
    errorMessage: e.ErrorMessage ?? e.errorMessage ?? null
  };
}

export function postReport({ centerUrl, agentToken, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${centerUrl}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: {
      agentId: snapshot.AgentId ?? snapshot.agentId,
      collectedAt: snapshot.CollectedAt ?? snapshot.collectedAt,
      data: Array.isArray(snapshot.Entries) ? snapshot.Entries.map(toCamelEntry) : []
    }
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