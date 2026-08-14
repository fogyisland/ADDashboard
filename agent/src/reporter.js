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

// Build base URL: if `port` is truthy, strip trailing :digits from centerUrl
// and append the override port. Otherwise return centerUrl as-is.
function baseUrl({ centerUrl, port }) {
  const trimmed = String(centerUrl).replace(/\/+$/, '');
  if (!port) return trimmed;
  return trimmed.replace(/:\d+$/, '') + ':' + Number(port);
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

export function postHeartbeat({ centerUrl, agentToken, port, payload }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/heartbeat`,
    headers: { 'X-Agent-Token': agentToken },
    body: payload,
  });
}

export function postReport({ centerUrl, agentToken, port, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: {
      agentId: snapshot.AgentId ?? snapshot.agentId,
      collectedAt: snapshot.CollectedAt ?? snapshot.collectedAt,
      data: Array.isArray(snapshot.Entries) ? snapshot.Entries.map(toCamelEntry) : []
    },
  });
}

export function fetchConfig({ centerUrl, agentToken }) {
  // Bootstrap endpoint lives on the web port. Fetching from centerUrl
  // (which now points at the web port, e.g. http://localhost:8080) means
  // we always know where to look without a port override. The legacy
  // /api/agent/config on the report port is kept around for backward
  // compat with older agents — this code path doesn't use it anymore.
  return requestJson({
    method: 'GET',
    url: `${centerUrl}/config.json`,
    headers: { 'X-Agent-Token': agentToken }
  });
}