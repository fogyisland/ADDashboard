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
        // I8: capture the ETag header (if any) on every response so callers
        // can round-trip it back as If-None-Match on the next request.
        // res.headers keys are lower-cased by Node's HTTP layer.
        const etag = res.headers && typeof res.headers.etag === 'string'
          ? res.headers.etag
          : null;
        // I8: 304 Not Modified is a success (the server is telling us our
        // cached body is still current). Body is empty by RFC 7232 §4.1,
        // so we report `data: null` and let the caller compare etag. Only
        // 4xx/5xx (and 3xx other than 304) are failures.
        if (res.statusCode === 304) {
          return resolve({ ok: true, status: 304, data: null, etag });
        }
        // For 2xx, treat empty body as ok with null data; for non-2xx, return as failure.
        // Avoid swallowing 2xx-with-html as a transport failure.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) return resolve({ ok: true, status: res.statusCode, data: null, etag });
          try { return resolve({ ok: true, status: res.statusCode, data: JSON.parse(data), etag }); }
          catch (e) { return resolve({ ok: true, status: res.statusCode, data: null, etag, error: `non-json body: ${e.message}` }); }
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
//
// 2026-08-28 round-46: partnerPortStatus field restored (R45 deletion undone
// for 复制日志监控 view). The 16-column ad_replication_status INSERT shape
// now includes partner_port_status again — bound at position 16, NULL for
// non-partner-port rows. The route's portHealthByPair map reads
// row.partnerPortStatus off these rows. Real agent emits PascalCase
// (PartnerPortStatus) per buildReplicationStatusRows; mock emits
// PartnerPortStatus via buildPartnerPortEntries (R46-T5/T6).
export function toCamelEntry(e) {
  if (!e) return e;
  return {
    collectedAt: e.CollectedAt ?? e.collectedAt ?? null,
    agentId: e.AgentId ?? e.agentId ?? null,
    sourceDc: e.SourceDc ?? e.sourceDc ?? null,
    destDc: e.DestDc ?? e.destDc ?? null,
    sourceSite: e.SourceSite ?? e.sourceSite ?? null,
    destSite: e.DestSite ?? e.destSite ?? null,
    namingContext: e.NamingContext ?? e.namingContext ?? null,
    lastSuccessTime: e.LastSuccessTime ?? e.lastSuccessTime ?? null,
    lastAttemptTime: e.LastAttemptTime ?? e.lastAttemptTime ?? null,
    statusCode: e.StatusCode ?? e.statusCode ?? null,
    errorMessage: e.ErrorMessage ?? e.errorMessage ?? null,
    usersCount: e.UsersCount ?? e.usersCount ?? null,
    groupsCount: e.GroupsCount ?? e.groupsCount ?? null,
    gposCount: e.GposCount ?? e.gposCount ?? null,
    lockedCount: e.LockedCount ?? e.lockedCount ?? null,
    // 2026-08-27 round-42 (复制日志监控): history table now carries
    // attempt_duration_ms + objects_transferred. Forward both camelCase
    // aliases — the real agent's collect-replication.ps1 emits them in
    // camelCase (PowerShell AST converts AttemptDurationMs → attemptDurationMs
    // automatically via ConvertTo-Json) and the mock's PascalCase form
    // falls back to the `?.` chain. Centre's historyParams reads them
    // off `row.attemptDurationMs` / `row.objectsTransferred`.
    attemptDurationMs: e.AttemptDurationMs ?? e.attemptDurationMs ?? null,
    objectsTransferred: e.ObjectsTransferred ?? e.objectsTransferred ?? null,
    partnerPortStatus: e.PartnerPortStatus ?? e.partnerPortStatus ?? null,
    // Mock-only forwarder — lets mock-snapshot.mjs ship a synthetic
    // `__history__:<hash>` NamingContext while preserving the real link
    // NC alongside. The centre's historyParams strips the prefix and
    // binds _realNamingContext instead so the stored row matches the
    // link's NC (which the dashboard's historyByPair lookup joins on).
    // Real agents never set this — the prefix-strip then becomes a no-op
    // and the literal namingContext is bound.
    _realNamingContext: e._realNamingContext ?? e.RealNamingContext ?? null
  };
}

export function postHeartbeat({ centerUrl, agentToken, port, payload }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/heartbeat`,
    headers: { 'X-Agent-Token': agentToken },
    body: { source: 'heartbeat', ...payload },
  });
}

export function postReport({ centerUrl, agentToken, port, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: {
      source: 'collect-replication',
      agentId: snapshot.AgentId ?? snapshot.agentId,
      collectedAt: snapshot.CollectedAt ?? snapshot.collectedAt,
      data: Array.isArray(snapshot.Entries) ? snapshot.Entries.map(toCamelEntry) : []
    },
  });
}

export function fetchConfig({ centerUrl, agentToken, ifNoneMatch = null }) {
  // Bootstrap endpoint lives on the web port. Fetching from centerUrl
  // (which now points at the web port, e.g. http://localhost:8080) means
  // we always know where to look without a port override. The legacy
  // /api/agent/config on the report port is kept around for backward
  // compat with older agents — this code path doesn't use it anymore.
  //
  // I8: if the caller has a previously-seen ETag, send it back as
  // If-None-Match. The server replies 304 (no body) when its current
  // fingerprint matches, in which case the caller treats its cached
  // config as still current and the etag from this response as the new
  // "last seen" value.
  const headers = { 'X-Agent-Token': agentToken };
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  return requestJson({
    method: 'GET',
    url: `${centerUrl}/config.json`,
    headers
  });
}