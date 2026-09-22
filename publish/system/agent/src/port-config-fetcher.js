import { signedRequestJson } from './reporter.js';

// GET /api/agent/ports from center. NEVER throws -- returns [] on any error
// (network, 5xx, 401, malformed JSON). The caller logs the failure and runs
// the cycle with zero port probes.
//
// 2026-09-22 S82 — stamp X-Agent-Signature so the centre's identity-binding
// check passes after the 60s restart-grace window. Without this, real agents
// silently lose their port list after restart (axios swallows the 401 into
// the catch branch and the agent keeps running with an empty list).
export async function fetchPortList(centerUrl, agentToken, { hostname, agentId } = {}) {
  const url = `${String(centerUrl).replace(/\/+$/, '')}/api/agent/ports`;
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
