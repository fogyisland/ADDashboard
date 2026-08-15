import axios from 'axios';

// GET /api/agent/ports from center. NEVER throws -- returns [] on any error
// (network, 5xx, 401, malformed JSON). The caller logs the failure and runs
// the cycle with zero port probes.
export async function fetchPortList(centerUrl, agentToken) {
  const url = `${String(centerUrl).replace(/\/+$/, '')}/api/agent/ports`;
  try {
    const r = await axios.get(url, {
      headers: { 'x-agent-token': agentToken },
      timeout: 5000,
      validateStatus: () => true
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
