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
// This must forward ALL 16 fields of the ad_replication_status INSERT shape
// (see center/src/services/replication.js rowParams). Any field omitted here
// is silently dropped on the wire and lands as NULL in the DB — that was the
// bug that kept partnerPortStatus and the 4 counters from ever reaching the
// centre. collectedAt/agentId are forwarded for symmetry: postReport currently
// takes them from the snapshot envelope, but per-entry values are the source
// of truth in the PS1 rows.
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
    // PS1 emits this already ConvertTo-Json'd (a string). Forward verbatim;
    // the centre's rowParams JSON.stringify's non-null values, so a string
    // stays a string end-to-end.
    partnerPortStatus: e.PartnerPortStatus ?? e.partnerPortStatus ?? null
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