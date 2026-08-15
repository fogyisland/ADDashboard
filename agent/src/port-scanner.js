// agent/src/port-scanner.js — parallel port discovery for the center's web port.
//
// Used when fetchConfig(/config.json) fails (operator changed web port in
// admin UI but agent's appsettings.json still points at the old port). Scans
// priority ports [80, 443, 8080] then a numeric range, returning the first
// port whose /config.json responds with 2xx + parseable JSON body. Worker-pool
// model with bounded concurrency and early-exit on first hit.
//
// NEVER throws — returns null on total miss. Caller is responsible for
// rewriting appsettings.json + retrying fetchConfig.

import { requestJson } from './reporter.js';

function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

async function probeOnce({ host, port, agentToken, perPortTimeoutMs }) {
  const r = await requestJson({
    method: 'GET',
    url: `http://${host}:${port}/config.json`,
    headers: { 'X-Agent-Token': agentToken },
    timeoutMs: perPortTimeoutMs
  });
  // Match: 2xx AND body parsed as object (requestJson returns data:null when
  // JSON.parse fails on non-JSON 2xx — reporter.js line 22).
  if (!r.ok) return null;
  if (!r.data || typeof r.data !== 'object') return null;
  return r;
}

async function mapWithConcurrency(items, concurrency, mapper, shouldStop) {
  const results = new Array(items.length);
  let next = 0;
  const total = Math.min(concurrency, items.length);
  const workers = Array.from({ length: total }, async () => {
    while (next < items.length && !shouldStop()) {
      const idx = next++;
      results[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverCenterPort({
  host,
  agentToken,
  priorityPorts = [80, 443, 8080],
  rangeStart = 10000,
  rangeEnd = 60000,
  concurrency = 50,
  perPortTimeoutMs = 300,
  logger = null,
  signal = null
}) {
  if (typeof host !== 'string' || !host) {
    if (logger) logger.error({ host }, 'discoverCenterPort: invalid host');
    return null;
  }

  // Build target list — priority first, then range. PriorityPorts dedup is
  // not needed (operators rarely list duplicates); range() dedups naturally
  // when rangeStart > rangeEnd (yields empty array).
  const targets = [
    ...priorityPorts.filter(p => Number.isFinite(Number(p))).map(p => ({ port: Number(p), source: 'priority' })),
    ...range(rangeStart, rangeEnd + 1).map(p => ({ port: p, source: 'range' }))
  ];

  if (targets.length === 0) {
    if (logger) logger.warn({ host }, 'discoverCenterPort: no targets (empty priority + empty range)');
    return null;
  }

  const startMs = Date.now();
  if (logger) logger.info({
    host, total: targets.length, concurrency, perPortTimeoutMs
  }, 'port scan starting');

  // Early-exit: when one probe matches, mark stopped so workers abandon.
  // In-flight requests complete but no new ones are dispatched.
  let stopped = false;
  const results = await mapWithConcurrency(
    targets,
    concurrency,
    async ({ port }) => {
      if (signal?.aborted) return null;
      const result = await probeOnce({ host, port, agentToken, perPortTimeoutMs });
      if (result) stopped = true;
      return result;
    },
    () => stopped
  );

  // Find first match (in target order — priority before range).
  for (let i = 0; i < results.length; i++) {
    if (results[i] !== null && results[i] !== undefined) {
      const probedIn = Date.now() - startMs;
      const hit = {
        port: targets[i].port,
        source: targets[i].source,
        probedIn
      };
      if (logger) logger.info({
        host, port: hit.port, source: hit.source, probedIn: hit.probedIn
      }, 'port scan hit');
      return hit;
    }
  }

  if (logger) logger.error({
    host, portsProbed: targets.length, durationMs: Date.now() - startMs
  }, 'port scan missed');
  return null;
}