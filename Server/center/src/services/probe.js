// center/src/services/probe.js
// 1 Hz self-probe loop. Probes each of the three center listening ports via
// /healthz and upserts a row into probe_state per port. Status transitions
// (healthy↔degraded) write one audit entry; every-tick writes are noise we
// don't want in audit_logs.
//
// Consumed by server.js bootstrap (Task 4): start() after buildServerApps,
// stop() in the SIGINT/SIGTERM shutdown handler.

const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 2000;
const PROBE_MISSING_TABLE_RE = /probe_state.*(doesn't|does not) exist|Invalid object name 'probe_state'/i;

export function createProbeLoop({ db, ports, logger, writeAudit, fetchImpl }) {
  const log = logger.child({ component: 'probe' });
  const fetchFn = fetchImpl || ((url, opts) => fetch(url, opts));
  let interval = null;
  let inFlight = null;

  async function probePort(portRole, port) {
    const t0 = Date.now();
    try {
      const res = await fetchFn(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      const latencyMs = Date.now() - t0;
      return {
        portRole,
        status: res.ok ? 'healthy' : 'degraded',
        latencyMs,
        lastProbeAt: new Date(),
        lastUpAt: new Date()
      };
    } catch (e) {
      return {
        portRole,
        status: 'degraded',
        latencyMs: null,
        lastProbeAt: new Date(),
        lastUpAt: new Date()
      };
    }
  }

  async function readPrev(portRole) {
    const { rows } = await db.query(db.sql.probeState.getAll);
    return rows.find(r => r.port_role === portRole) || null;
  }

  async function tick() {
    // Bootstrap fail-fast: surface a clear error if migration 012 wasn't applied.
    try {
      await db.query(db.sql.probeState.getAll);
    } catch (e) {
      if (PROBE_MISSING_TABLE_RE.test(e.message)) {
        throw new Error('probe_state table missing — apply migration 012');
      }
      throw e;
    }

    const results = await Promise.all([
      probePort('web',       ports.web),
      probePort('heartbeat', ports.heartbeat),
      probePort('report',    ports.report)
    ]);

    // Collect per-port transitions first; emit ONE audit per tick that has any
    // flip (aggregated across ports). Writing per-port would multiply audit
    // noise: an outage that flips all 3 ports simultaneously would emit 3
    // entries for what is conceptually a single event.
    const transitions = [];
    for (const r of results) {
      const prev = await readPrev(r.portRole);
      const prevStatus = prev?.status ?? 'unknown';
      const consecutiveFailures = r.status === 'healthy'
        ? 0
        : (Number(prev?.consecutive_failures) || 0) + 1;
      const lastUpAt = r.status === 'healthy'
        ? r.lastUpAt
        : (prev?.last_up_at ? new Date(prev.last_up_at) : null);

      await db.execute(db.sql.probeState.upsertRow(), [
        r.portRole,
        r.status,
        r.latencyMs,
        r.lastProbeAt,
        lastUpAt,
        consecutiveFailures
      ]);

      if (prevStatus !== r.status) {
        transitions.push({
          port: r.portRole,
          prev: prevStatus,
          next: r.status,
          latencyMs: r.latencyMs,
          consecutiveFailures
        });
      }
    }

    if (transitions.length > 0) {
      await writeAudit({
        action: 'probe_state_changed',
        target: 'probe_state',
        payload: { transitions }
      }).catch(() => { /* best-effort */ });
    }
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) => log.error({ err: e.message }, 'probe tick failed'));
    }, PROBE_INTERVAL_MS);
  }

  async function stop() {
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => interval !== null
  };
}