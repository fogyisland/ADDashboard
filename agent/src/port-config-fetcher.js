import { signedRequestJson, baseUrl } from './reporter.js';

// GET /api/agent/ports from center. NEVER throws -- returns [] on any error
// (network, 5xx, 401, malformed JSON). The caller logs the failure and runs
// the cycle with zero port probes.
//
// 2026-09-22 S82 — stamp X-Agent-Signature so the centre's identity-binding
// check passes after the 60s restart-grace window. Without this, real agents
// silently lose their port list after restart (axios swallows the 401 into
// the catch branch and the agent keeps running with an empty list).
//
// 2026-09-25 R93.3 — accept `port` and route through `baseUrl({ centerUrl, port })`.
// /api/agent/ports is mounted only on `mount: 'heartbeat'` (8081). The previous
// version sent to `${centerUrl}/api/agent/ports` verbatim, which on KDLFLOFADSRV2
// hit the web port (8080) and got 404 HTML. Caller (agent.js:refreshPortList)
// now passes `cachedPorts.heartbeatPort`. `port` defaults to null so callers
// without an explicit port override keep the legacy "send to centerUrl as-is"
// behavior — same fallback rule as `baseUrl` itself.
export async function fetchPortList(centerUrl, agentToken, { hostname, agentId, port = null } = {}) {
  const url = `${baseUrl({ centerUrl, port })}/api/agent/ports`;
  try {
    const r = await signedRequestJson({
      method: 'GET',
      url,
      headers: {},
      agentToken,
      hostname,
      agentId,
      timeoutMs: 5000
    });
    if (r.status !== 200 || !Array.isArray(r.data)) return [];
    // Trim to the fields the agent actually uses.
    return r.data
      .filter(p => p && Number.isFinite(Number(p.port)))
      .map(p => ({ port: Number(p.port), label: String(p.label ?? ''), sortOrder: Number(p.sortOrder ?? 0) }));
  } catch {
    return [];
  }
}
