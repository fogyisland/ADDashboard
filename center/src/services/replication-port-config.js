// Replication-port probe config — list of TCP ports that
// collect-replication.ps1 probes for each replication partner.
//
// Round-17 simplification (2026-08-26): the probe-port list is now sourced
// from the operator-managed `system_ports` table (the same table that backs
// the `/admin/ports` UI). Operators who want to add or remove a probe port
// add/remove it via `/admin/ports`; the partner-port probe picks up the
// change on the next agent cycle, with no separate write endpoint and no
// separate audit row.
//
// The previous design kept a dedicated `replication.partner_probe_ports` row
// in `system_config` with its own admin editor. Operators found the
// duplication confusing — "which page edits the probe ports?" — and the two
// lists could drift apart (one would say 135/445, the other 22/389/636)
// without the system noticing. Single source of truth: `system_ports`.
//
// The function name `getReplicationPortList` is preserved so the call sites
// in routes/agent.js and routes/admin.js don't have to change. The shape of
// the return value is the same sorted int[] it always was.

import { listPorts } from './ports.js';

// Default ports used when `system_ports` is empty (no operator has ever added
// a port row). Mirrors the legacy hardcoded default so an agent with no
// operator-configured port list still gets a sensible answer.
const DEFAULT_PARTNER_PROBE_PORTS = Object.freeze([135, 445, 50001, 50002, 50003]);

// Read the operator-defined port list. Returns the port numbers from
// `system_ports`, sorted ascending. If the table is empty (no operator-
// configured ports), returns the hardcoded default so a freshly-installed
// center still has a usable probe list. Never throws — the agent path
// calls this and needs a usable answer in any DB state.
export async function getReplicationPortList() {
  try {
    const rows = await listPorts();
    const nums = rows
      .map((r) => Number(r.port))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    nums.sort((a, b) => a - b);
    return nums.length > 0 ? nums : [...DEFAULT_PARTNER_PROBE_PORTS];
  } catch {
    return [...DEFAULT_PARTNER_PROBE_PORTS];
  }
}

export const DEFAULT_PARTNER_PROBE_PORTS_PUBLIC = DEFAULT_PARTNER_PROBE_PORTS;