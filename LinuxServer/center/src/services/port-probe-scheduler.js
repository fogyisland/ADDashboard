// R114 — centre-side port probe scheduler.
//
// Spec: docs/superpowers/specs/2026-09-26-r114-centre-remote-port-probe-design.md §3
//
// Replaces the agent-side 127.0.0.1 probe data path (R113) with a centre-side
// active probe: every cycle, the scheduler reads (a) the registered DC list
// from `ad_dcs` and (b) the port catalogue from `system_ports`, then runs
// `tcpProbe(dc, port)` for each pair and upserts the result into
// `ad_remote_port_probe`.
//
// Cadence: 60_000 ms by default, overridable via
// `system_settings.r114_probe_interval_ms` (range-clamped to [5000, 3_600_000]
// ms). The override is re-read at the start of every cycle so admin-side
// edits take effect on the next cycle without a centre restart.
//
// Re-entrancy: a single boolean `running` guard prevents overlapping cycles
// — if the previous cycle is still in flight (large fleet × slow probes) the
// next cycle short-circuits with a warn-level log entry. This is intentional:
// under load we lose cycle fidelity rather than doubling the DB write rate.
//
// tcpProbe is exported separately so tests can inject a deterministic stub
// without needing real network. The default implementation uses Node's
// `net.Socket` with `setTimeout` and error-code mapping (ENOTFOUND/ECONNREFUSED
// /EHOSTUNREACH/ETIMEDOUT → dns/refused/unreachable/timeout).

import net from 'node:net';
import { toMysqlDatetime } from '../utils/datetime.js';

export async function tcpProbe(host, port, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const finalize = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) { /* already destroyed */ }
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finalize({ ok: true, latencyMs: Date.now() - startedAt, error: null }));
    sock.once('timeout', () => finalize({ ok: false, latencyMs: null, error: 'timeout' }));
    sock.once('error', (e) => {
      const code = e.code || 'unknown';
      const map = {
        ENOTFOUND: 'dns',
        ECONNREFUSED: 'refused',
        EHOSTUNREACH: 'unreachable',
        ETIMEDOUT: 'timeout'
      };
      finalize({ ok: false, latencyMs: null, error: map[code] || code });
    });
    sock.connect(port, host);
  });
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 3_600_000;

// S8 (2026-09-30) — per-DC port probe concurrency. Each DC's (catalogue)
// probes run in parallel via Promise.all, but DC ordering stays serial so
// a single slow DC doesn't block the next. 20 concurrent probes per DC
// is plenty (catalogue is typically 4–12 entries) and stays well below
// socket fd limits even on a 100-DC fleet.
const PER_DC_PROBE_CONCURRENCY = 20;

export function startPortProbeScheduler({
  db,
  log,
  intervalMs = DEFAULT_INTERVAL_MS,
  // S8 — default timeout trimmed from 3_000 → 1_500 ms. A 3 s budget ×
  // 100 (dc × port) pairs = 300 s worst case in serial mode, blowing the
  // 60 s cycle interval. With per-DC parallel probes a 1.5 s budget caps
  // the per-DC slice at 1.5 s, keeping the full cycle well under the
  // interval even at 100 DCs.
  timeoutMs = 1_500,
  tcpProbe: tcpProbeOverride
} = {}) {
  const probe = tcpProbeOverride || tcpProbe;
  let timer = null;
  let running = false;
  let effectiveIntervalMs = intervalMs;

  async function readCadenceOverride() {
    try {
      const r = await db.execute(db.sql.systemSettings.get, ['r114_probe_interval_ms']);
      const v = Number(r.rows?.[0]?.setting_value);
      if (Number.isFinite(v) && v >= MIN_INTERVAL_MS && v <= MAX_INTERVAL_MS) {
        return v;
      }
    } catch (_) {
      // system_settings might not exist on first boot (migration hasn't run
      // yet); that's fine, we just keep the default cadence.
    }
    return DEFAULT_INTERVAL_MS;
  }

  async function cycle() {
    if (running) {
      log?.warn?.({ event: 'port_probe.cycle.skip' }, 'previous cycle still running, skipping');
      return;
    }
    running = true;
    const startedAt = Date.now();

    // Re-read cadence override every cycle. Admin-side edits take effect
    // on the next cycle (not the currently-running one) without restart.
    const override = await readCadenceOverride();
    if (override !== effectiveIntervalMs) {
      effectiveIntervalMs = override;
      // Re-arm the interval to reflect the new cadence.
      if (timer) {
        clearInterval(timer);
        timer = setInterval(() => { void cycle(); }, effectiveIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }

    // Read DC list + port catalogue in parallel.
    let targets = [];
    let catalogue = [];
    try {
      const [targetRes, catRes] = await Promise.all([
        db.execute(db.sql.remotePortProbe.dcList),
        db.execute(db.sql.ports.list)
      ]);
      targets = (targetRes.rows || []).map(r => r.dc_name).filter(Boolean);
      catalogue = catRes.rows || [];
    } catch (e) {
      log?.error?.({ event: 'port_probe.read.fail', err: e.message }, 'failed to read dc list / catalogue');
      running = false;
      return;
    }

    if (targets.length === 0) {
      log?.info?.({ event: 'port_probe.cycle.empty_dcs' }, 'no registered DCs, skipping probe cycle');
      running = false;
      return;
    }
    if (catalogue.length === 0) {
      log?.info?.({ event: 'port_probe.cycle.empty_catalogue' }, 'system_ports empty, skipping probe cycle');
      running = false;
      return;
    }

    // R161.5 (2026-10-26) — MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串。
    //   ad_remote_port_probe.probe_at 是 DATETIME NOT NULL (MySQL 基线) ⇒
    //   绑 ISO 会 ER 1292 ⇒ 整个 upsert 批次失败 ⇒ 端口探测结果一条都存不进去。
    //   MSSQL 侧 datetime2 接受 ISO ⇒ 只在 MySQL 分支转。
    const probeAtIso = new Date().toISOString();
    const probeAt = db.dialect === 'mssql' ? probeAtIso : toMysqlDatetime(probeAtIso);
    let okCount = 0;
    let failCount = 0;

    // S8 (2026-09-30) — fan out per-DC (dc × port) probes concurrently
    // up to PER_DC_PROBE_CONCURRENCY. The previous serial loop at 100
    // pairs × 3 s timeout = 300 s worst case, blowing the 60 s cycle
    // and never letting subsequent ticks fire. Per-DC concurrency caps
    // wall-clock at ~max(probeLatencies) per DC × N DCs, dropping a
    // healthy 100-DC × 5-port fleet from 300 s worst case to ~5 s
    // wall-clock (assuming sub-second LAN RTTs).
    //
    // Why not Promise.all across all (dc × port) pairs at once: at 100
    // DCs × 5 ports = 500 concurrent sockets on a Windows Server box
    // is risky (ephemeral port range, TIME_WAIT). PER_DC chunks keep
    // the in-flight socket count bounded at ~20 per DC.
    for (const dc of targets) {
      const tasks = catalogue.map((portRow) => async () => {
        let r;
        try {
          r = await probe(dc, portRow.port, timeoutMs);
        } catch (e) {
          r = { ok: false, latencyMs: null, error: e.message || 'probe-error' };
        }
        try {
          await db.execute(db.sql.remotePortProbe.upsertOne, [
            probeAt,
            dc,
            portRow.port,
            r.ok ? 1 : 0,
            r.latencyMs,
            r.error
          ]);
          if (r.ok) okCount++; else failCount++;
        } catch (e) {
          log?.error?.({
            event: 'port_probe.upsert.fail',
            dc,
            port: portRow.port,
            err: e.message
          }, 'failed to upsert probe result');
        }
      });
      // Chunk catalogue into PER_DC_PROBE_CONCURRENCY-sized groups so we
      // don't open all sockets at once on a large port list.
      for (let i = 0; i < tasks.length; i += PER_DC_PROBE_CONCURRENCY) {
        const chunk = tasks.slice(i, i + PER_DC_PROBE_CONCURRENCY);
        await Promise.allSettled(chunk.map((fn) => fn()));
      }
    }

    log?.info?.({
      event: 'port_probe.cycle.complete',
      okCount,
      failCount,
      dcCount: targets.length,
      portCount: catalogue.length,
      durationMs: Date.now() - startedAt
    }, 'port probe cycle complete');

    running = false;
  }

  function start() {
    if (timer) return; // idempotent
    timer = setInterval(() => { void cycle(); }, effectiveIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    // First cycle runs after a short delay so the centre has time to settle
    // (DB pool warm, routes wired) before we start hitting external DCs.
    setTimeout(() => { void cycle(); }, 5_000);
    log?.info?.({
      event: 'port_probe.scheduler.start',
      intervalMs: effectiveIntervalMs,
      timeoutMs
    }, 'port probe scheduler started');
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
      log?.info?.({ event: 'port_probe.scheduler.stop' }, 'port probe scheduler stopped');
    }
  }

  return {
    start,
    stop,
    cycle,
    _readCadenceOverride: readCadenceOverride
  };
}
