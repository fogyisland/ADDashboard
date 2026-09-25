import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
// 2026-09-09 S82 (security) — agent identity binding. Stamp every
// request with an HMAC-SHA256 of (hostname + agentId + sorted body)
// keyed by the shared token; the center recomputes and rejects when
// (hostname, agentId, body) don't agree with the token. Defense-in-depth
// against token theft + replay from a different hostname.
import { signRequest } from './lib/agent-identity.js';
// 2026-09-25 R93 — diagnostic logging for HTTP path. The agent has had
// `logLevel` in appsettings.json (config.js DEFAULTS) for ages, but the
// reporter module was completely silent — `info` and `debug` lines never
// landed, so operators hitting "401 invalid agent token" / "304 not
// modified" / connection errors had no breadcrumb to follow. Each helper
// below logs at the level that fits its purpose:
//   - requestJson:  info on every call (method+url+timeoutMs), debug on
//                   response (status + ms), error on transport failure or
//                   non-2xx (status + truncated body)
//   - signedRequestJson: debug on stamp (token/sig prefix only — never
//                   the body — so logs don't leak payload)
//   - postHeartbeat / postReport / fetchConfig: info on outcome (ok + ms)
// Pin logLevel from appsettings.json so the operator can flip to 'debug'
// and see full HTTP traffic without restarting anything else. NSSM
// captures stderr to its log file so nothing disappears on service stop.
import pino from 'pino';

// Single pino instance for the whole reporter module — `pino` is happy to
// be reused, and creating one per call would waste a fd + a sync dest per
// `requestJson`. Component tag lets operators filter by module in pino-pretty.
//
// Reporter is imported BEFORE agent.js reads appsettings.json (signRequest
// needs to be wired into all the wrappers). The level starts at the pino
// default 'info'; agent.js calls _refreshLogLevel(config.logLevel) right
// after loadConfig + createLogger, so the operator's `debug` setting
// kicks in before the first heartbeat fires.
let log = pino({
  level: 'info',
  base: { component: 'reporter' },
  timestamp: pino.stdTimeFunctions.isoTime,
}, pino.destination({ dest: 2, sync: true }));

export function _refreshLogLevel(level) {
  // Replace the bound level on the existing pino instance — pino re-reads
  // `level` per write so we don't need a new instance. Keep the same
  // destination + base so the component tag + ISO timestamps stay put.
  if (typeof level === 'string' && level.length > 0) {
    log.level = level;
  }
}

export function requestJson({ method, url, headers, body, timeoutMs = 30000 }) {
  const started = Date.now();
  log.info({ method, url, timeoutMs, hasBody: body !== undefined && body !== null }, 'http request');
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); }
    catch (e) {
      log.error({ method, url, err: e.message }, 'http request: bad URL');
      return resolve({ ok: false, status: 0, error: `bad url: ${e.message}` });
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', ...headers },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ms = Date.now() - started;
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
          log.debug({ method, url, status: 304, ms, etag }, 'http response: 304 not modified');
          return resolve({ ok: true, status: 304, data: null, etag });
        }
        // For 2xx, treat empty body as ok with null data; for non-2xx, return as failure.
        // Avoid swallowing 2xx-with-html as a transport failure.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) {
            log.debug({ method, url, status: res.statusCode, ms, etag }, 'http response: 2xx empty body');
            return resolve({ ok: true, status: res.statusCode, data: null, etag });
          }
          try {
            const parsed = JSON.parse(data);
            log.debug({ method, url, status: res.statusCode, ms, etag, bytes: data.length }, 'http response: 2xx');
            return resolve({ ok: true, status: res.statusCode, data: parsed, etag });
          }
          catch (e) {
            // 2xx but body isn't JSON — surface as success with an error
            // annotation so the caller can decide what to do (requestJson
            // never auto-fails on a non-JSON 2xx because some endpoints
            // legitimately return text).
            log.debug({ method, url, status: res.statusCode, ms, etag, err: e.message, bytes: data.length }, 'http response: 2xx non-json');
            return resolve({ ok: true, status: res.statusCode, data: null, etag, error: `non-json body: ${e.message}` });
          }
        }
        // Non-2xx — log the first 500 chars of body so the operator can
        // see WHY (auth, validation, 5xx) without unbounded log spam.
        const snippet = String(data).slice(0, 500);
        log.error({ method, url, status: res.statusCode, ms, body: snippet }, 'http response: non-2xx');
        try { resolve({ ok: false, status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ ok: false, status: res.statusCode, data }); }
      });
    });
    req.on('error', err => {
      const ms = Date.now() - started;
      log.error({ method, url, err: err.message, ms }, 'http request: transport error');
      resolve({ ok: false, status: 0, error: err.message });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 2026-09-22 S82 followup — `requestJson` above doesn't auto-stamp the
// signature header. Every caller that talks to the centre MUST include an
// X-Agent-Signature after the 60s restart-grace window, otherwise the
// centre rejects with 401 'identity mismatch'.
// `signedRequestJson` wraps `requestJson` so callers only need to pass
// the identity triple (agentToken, hostname, agentId) — the helper stamps
// all four identity headers (X-Agent-Token + X-Agent-Signature +
// X-Agent-Id + X-Agent-Hostname) for them.
//
// 2026-09-25 R93.2 — postHeartbeat and postReport now use this helper
// instead of bare requestJson + manual signature. The previous manual
// path was correct for the signature itself but missed X-Agent-Hostname
// (R93.1 only added the helper-side stamp) and the body field didn't
// carry hostname either, so the centre hashed with `hostname=''` while
// the agent hashed with the real hostname → HMAC mismatch → 401 after
// the 60s grace window. Same pattern applies to package-manager's
// flushReportQueue POST. fetchConfig is intentionally kept on
// requestJson (the /config.json endpoint expects hostname=agentId=''
// and there's no body to bind).
export function signedRequestJson({
  method, url, headers = {}, body, timeoutMs,
  agentToken, hostname, agentId
}) {
  const stamped = { ...headers };
  if (typeof agentToken === 'string' && agentToken.length > 0) {
    stamped['X-Agent-Token'] = agentToken;
    if (typeof hostname === 'string' && typeof agentId === 'string') {
      stamped['X-Agent-Signature'] = signRequest({
        hostname, agentId, body: body ?? null, token: agentToken
      });
      // X-Agent-Id lets the centre's middleware skip the body-first lookup
      // when body is empty (mirror of the agent-side convention).
      stamped['X-Agent-Id'] = agentId;
      // R93.1 — centre's middleware (agent-token.js:171) reads hostname
      // from `req.body?.hostname || req.headers['x-agent-hostname'] || ''`.
      // For GET requests body is null so the first lookup misses; without
      // X-Agent-Hostname the centre hashes with `hostname=''` while we
      // hashed with the real hostname — HMAC mismatch → 401 'identity
      // mismatch'. KDLFLOFADSRV2 stderr showed exactly this on every
      // drainer poll. Stamp the hostname header so both sides hash over
      // the same triple.
      stamped['X-Agent-Hostname'] = hostname;
    }
  }
  // Token/signature prefix only — never log the full token or body. The
  // prefix is enough to correlate "this is the same request across logs"
  // without leaking credentials into stderr (which NSSM captures).
  log.debug({
    method,
    url,
    tokenPrefix: typeof stamped['X-Agent-Token'] === 'string'
      ? stamped['X-Agent-Token'].slice(0, 8)
      : null,
    sigPrefix: typeof stamped['X-Agent-Signature'] === 'string'
      ? stamped['X-Agent-Signature'].slice(0, 8)
      : null,
    hasBody: body !== undefined && body !== null,
  }, 'signed request');
  return requestJson({ method, url, headers: stamped, body, timeoutMs });
}

// Build base URL: if `port` is truthy, strip trailing :digits from centerUrl
// and append the override port. Otherwise return centerUrl as-is.
// R93.2 — exported so callers (discovery.js, package-manager.js) that
// previously sent to the wrong port (e.g. /api/agent/discover on the web
// port which never has that route) can pick the right port the same way
// postHeartbeat / postReport do. Previously discovery sent to
// `${centerUrl}/api/agent/discover` and centre has that endpoint only on
// mount: 'report' (8082), so the request always 404'd on the web port.
export function baseUrl({ centerUrl, port }) {
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
    //
    // 2026-08-28 round-58.4 (CRITICAL): mock-snapshot.mjs emits the field
    // as PascalCase-with-underscore (`_RealNamingContext` — matching the
    // rest of its PascalCase keys like SourceDc/NamingContext). Real
    // agent's collect-replication.ps1 emits it PascalCase-without-underscore
    // (`RealNamingContext`). toCamelEntry must accept BOTH shapes or the
    // mock's __history__:% rows bind a null naming_context → ER_BAD_NULL_ERROR
    // on every report (the bug filled the centre log with 1900+ "Column
    // 'naming_context' cannot be null" failures since R42-T9).
    _realNamingContext: e._realNamingContext ?? e._RealNamingContext ?? e.RealNamingContext ?? null
  };
}

export function postHeartbeat({ centerUrl, agentToken, port, payload, hostname, agentId }) {
  // R93.2 — use signedRequestJson so the helper stamps the full identity
  // header quartet (X-Agent-Token + X-Agent-Signature + X-Agent-Id +
  // X-Agent-Hostname) in one place. Caller (agent.js) supplies hostname +
  // agentId explicitly so the HMAC triple matches the centre's middleware
  // resolution order (`req.body.hostname || X-Agent-Hostname || ''`). The
  // body still carries hostname too (some centre code paths read it from
  // body first), but the header is the load-bearing one for GET-style
  // endpoints and for cases where express.json() ran before the body field
  // was wired.
  const hbHostname = String(hostname || payload?.hostname || '');
  const hbAgentId  = String(agentId  || payload?.agentId  || '');
  const bodyWithSource = { source: 'heartbeat', ...payload };
  return signedRequestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/heartbeat`,
    headers: {},
    body: bodyWithSource,
    timeoutMs: 30000,
    agentToken,
    hostname: hbHostname,
    agentId: hbAgentId
  }).then((r) => {
    log.info({ ok: r.ok, status: r.status, agentId: hbAgentId, endpoint: 'heartbeat' }, 'heartbeat POST complete');
    return r;
  });
}

export function postReport({ centerUrl, agentToken, port, snapshot, hostname }) {
  // R93.2 — same migration to signedRequestJson as postHeartbeat. The
  // snapshot itself only carries AgentId (no top-level hostname field),
  // so the HMAC hostname is taken from the explicit `hostname` argument
  // (caller passes `config.hostname || osInfo.hostname`); when omitted,
  // fall back to agentId so the legacy convention (hostname === agentId)
  // keeps working for non-AD callers.
  const agentId = snapshot.AgentId ?? snapshot.agentId;
  const reportHostname = String(hostname || agentId || '');
  const body = {
    source: 'collect-replication',
    agentId,
    collectedAt: snapshot.CollectedAt ?? snapshot.collectedAt,
    data: Array.isArray(snapshot.Entries) ? snapshot.Entries.map(toCamelEntry) : []
  };
  const started = Date.now();
  return signedRequestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/report`,
    headers: {},
    body,
    timeoutMs: 60000,
    agentToken,
    hostname: reportHostname,
    agentId
  }).then((r) => {
    log.info({
      ok: r.ok,
      status: r.status,
      agentId,
      endpoint: 'report',
      entryCount: body.data.length,
      ms: Date.now() - started,
    }, 'report POST complete');
    return r;
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
  // S82: GET requests have no body, but we still stamp a signature
  // derived from an empty body so the center can reject unsigned-for-1-
  // minute-after-restart requests from older agents in the field.
  headers['X-Agent-Signature'] = signRequest({ hostname: '', agentId: '', body: null, token: agentToken });
  return requestJson({
    method: 'GET',
    url: `${centerUrl}/config.json`,
    headers
  }).then((r) => {
    log.info({
      ok: r.ok,
      status: r.status,
      endpoint: 'config',
      notModified: r.status === 304,
    }, 'config GET complete');
    return r;
  });
}