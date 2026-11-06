// R158.84 (2026-10-12) — member-ports live probe service.
//
// Wraps the existing `tcpProbe` helper from port-probe-scheduler.js
// (R114, centre-side remote port probe) for the member-server fleet.
// Each `GET /api/dashboard/member-ports` call awaits Promise.all of
// tcpProbe across every registered (hostname, port) row, then maps
// tcpProbe's 5-way internal error vocabulary to the 4-way contract
// the dashboard UI expects: open | closed | timeout | error.
//
// Why reuse tcpProbe:
//   - already handles the net.Socket race (settle-once guard),
//     timeout, ENOTFOUND/ECONNREFUSED/EHOSTUNREACH/ETIMEDOUT.
//   - independently proven in production (R114, 60 s DC cycle).
//   - The DC-fleet scheduler (startPortProbeScheduler) and this
//     member endpoint are independent code paths — the scheduler
//     targets system_ports × ad_dcs; this targets
//     ad_member_server_ports × ad_member_servers. No double-probe
//     risk for any given (host, port).
//
// 4-way collapse rationale:
//   - 'refused'   → 'closed'  (port actively answering RST)
//   - 'timeout'   → 'timeout' (no SYN/ACK, no RST within budget)
//   - 'dns'       → 'error'   (unresolvable — different from "port
//                            is down" because the host doesn't exist)
//   - 'unreachable' / unknown code → 'error'  (catch-all)
//
// Concurrency:
//   - 6 rows × 2 s budget serial = 12 s worst case. With Promise.all
//     the entire probe phase completes in ceil(max latency) ≈ 2 s.
//   - No per-row semaphore needed at this scale (6 typical, 100 cap).
//   - If a future scale-up crosses ~200 rows, swap to a per-host
//     semaphore like startPortProbeScheduler (lines 60-65).

import { tcpProbe } from './port-probe-scheduler.js';

// Probe-budget default. Override via ?timeoutMs=N on the endpoint;
// the route layer clamps to [100, 10000].
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Probe a list of SQL rows in parallel. Each row must have a non-empty
 * `hostname` and a numeric `port`. Returns the same rows augmented
 * with three runtime fields (probeStatus, probeLatencyMs, probeAt).
 *
 * @param {Array<{hostname:string, port:number}>} rows  SQL rows from
 *        ad_member_server_ports (caller already lowercased if needed).
 * @param {{ timeoutMs?: number, log?: { warn, error } }} [opts]
 * @returns {Promise<Array>}  same rows + probeStatus/probeLatencyMs/probeAt
 */
export async function probeMemberServerPorts(rows, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS;
  const probeAt = new Date().toISOString();

  const results = await Promise.all(rows.map(async (row) => {
    const host = String(row.hostname || '').trim();
    const port = Number(row.port ?? row.PORT);
    if (!host || !Number.isFinite(port) || port <= 0) {
      return {
        ...row,
        probeStatus: 'error',
        probeLatencyMs: null,
        probeAt,
        // Surface why we didn't probe — useful for the operator
        // to distinguish "host actually has port 0" from "row
        // was malformed". Cheap to include.
        probeError: 'invalid-host-or-port'
      };
    }
    try {
      const r = await tcpProbe(host, port, timeoutMs);
      return { ...row, ...collapseProbeResult(r), probeAt };
    } catch (e) {
      // tcpProbe resolves (never throws) thanks to its settle-once
      // guard, so this catch only fires for programmer-error paths
      // (e.g. a stub passed in via dependency injection throwing).
      if (opts.log?.error) {
        opts.log.error('member-server-port-probe: unexpected', { host, port, message: e?.message });
      }
      return {
        ...row,
        probeStatus: 'error',
        probeLatencyMs: null,
        probeAt,
        probeError: 'probe-threw'
      };
    }
  }));

  return results;
}

// Exported for unit tests so the mapping table can be exercised
// without spinning up real sockets.
export function collapseProbeResult(r) {
  if (r && r.ok === true) {
    return {
      probeStatus: 'open',
      probeLatencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null
    };
  }
  const err = r && r.error;
  if (err === 'refused') return { probeStatus: 'closed', probeLatencyMs: null };
  if (err === 'timeout') return { probeStatus: 'timeout', probeLatencyMs: null };
  // dns | unreachable | unknown code | undefined
  return { probeStatus: 'error', probeLatencyMs: null };
}

// R158.89 (2026-10-13) — startMemberPortProbeScheduler factory. 跟 R114
//   DC port-probe scheduler (server.js:1179 startR114Schedulers) 1:1 平行
//   shape: 周期 cadence + boot offset + inFlight guard + .unref() 不挡
//   process exit. R158.86.6 enumerate 5 维度 lesson #6 闭合: R158.84
//   "按需 probe" 接口只 enumerate 接口层, 0 enumerate scheduler 层.
//   本 factory enumerate = cadence + boot offset + inFlight + tick log
//   + write-back DB + 4-way status mapping (跟 probeMemberServerPorts
//   1:1 平行, 复用同一 probe helper, 0 重写 socket 逻辑).
//
//   Cadence default 15 min (跟 user 报 "/memberServer/ports 15min 一次"
//   1:1 平行). Boot offset 8s 跟 R158.87.2 cron 5min race condition
//   lesson 1:1 平行 (避整点 5min 群撞). 实际 15min cadence, 8s boot
//   offset 是 8s + N×15min, 跟 R158.87.3 daily cron 2:00 改法 1:1.
//
//   0 改 R158.74 admin CRUD updated_at (跟 R158.84 接口层解耦,
//   前端能区分 admin update vs probe tick).
export function startMemberPortProbeScheduler({ db, log, intervalMs } = {}) {
  const _log = log || { info: () => {}, warn: () => {}, error: () => {} };
  const _intervalMs = Number.isFinite(intervalMs) && intervalMs >= 5_000
    ? Math.min(intervalMs, 3_600_000)
    : 15 * 60_000;
  const BOOT_OFFSET_MS = 8_000;  // 8s 跟 R158.87.2 race condition lesson 1:1

  // R158.89 — system_settings 可配 cadence (跟 R114 r114_probe_interval_ms
  //   1:1 平行). Range [5000, 3_600_000] ms = 5s ~ 1h, 跟 R114 precedent
  //   1:1 平行. Operator 不 restart 改频率, 下 1 个 cycle 自动 re-arm.
  //   R158.78 lesson 平行: lazy-insert first read 时把 default 写回
  //   system_settings (跟 R158.87 system_feature_flags 同 idiom),
  //   让 admin 端 永远看到当前生效值.
  const SETTINGS_KEY = 'member_port_probe_interval_ms';
  const MIN_INTERVAL_MS = 5_000;
  const MAX_INTERVAL_MS = 3_600_000;
  const DEFAULT_INTERVAL_MS = 15 * 60_000;  // 15min 跟 user 报期望 1:1 平行

  let timer = null;
  let bootTimer = null;
  let inFlight = false;
  let stopped = false;
  let effectiveIntervalMs = _intervalMs;

  // R158.89 — 跟 R114 port-probe-scheduler.js:84 readCadenceOverride 1:1
  //   平行. read-write 不分离: lazy-insert default 一次性, 之后只读.
  async function readCadenceOverride() {
    try {
      const r = await db.execute(db.sql.systemSettings.get, [SETTINGS_KEY]);
      const v = Number(r.rows?.[0]?.setting_value);
      if (Number.isFinite(v) && v >= MIN_INTERVAL_MS && v <= MAX_INTERVAL_MS) {
        return v;
      }
    } catch (_) {
      // system_settings 0 row 时 (1.0.0 baseline + 0 lazy-insert yet)
      // 不 throw, fallback default. R114 precedent 1:1.
    }
    // lazy-insert default 一次, 之后 admin 端 永远看到生效值
    try {
      // systemSettings.upsert 只有 2 槽位 [key, value], updated_at 由 SQL 内联
      // (mysql: UTC_TIMESTAMP(), mssql: SYSUTCDATETIME()) —— 两方言同序.
      // 之前传了第 3 个 new Date().toISOString() → 多余参数被 driver 丢弃,
      // 但语义上把"这里自己算时间戳"和"DB 端算"混了两套时钟.
      await db.execute(db.sql.systemSettings.upsert, [
        SETTINGS_KEY, String(effectiveIntervalMs)
      ]);
    } catch (e) {
      // 并发重复 INSERT 时不致命 (upsert 幂等), 但留痕便于排查
      _log.warn({ err: e?.message, key: SETTINGS_KEY },
        'systemSettings.upsert lazy-insert failed (non-fatal)');
    }
    return effectiveIntervalMs;
  }

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const tickAt = new Date().toISOString();
    try {
      const result = await db.query(db.sql.memberServerPorts.listAll);
      const rows = (Array.isArray(result) ? result : (result.rows ?? [])) || [];
      if (rows.length === 0) {
        _log.info?.({ event: 'member.port.probe.tick', n: 0, tickAt }, 'member port probe tick: 0 rows');
        return;
      }
      // Normalize SQL row → probeMemberServerPorts input shape (跟
      // member-servers-public.js:501-507 1:1 平行, 0 改接口).
      const baseItems = rows.map(r => ({
        hostname: r.hostname || r.HOSTNAME,
        port: Number(r.port ?? r.PORT ?? 0),
        serviceType: r.service_type || r.SERVICE_TYPE || null,
        note: r.note || r.NOTE || null
      }));
      const items = await probeMemberServerPorts(baseItems, { log: _log });
      // 串行 write-back (跟 R158.48 last_upgrade_event 1:1 平行,
      // 6-12 row 1:1 Promise.all 不必, serial 简单, 失败 best-effort)
      let written = 0;
      for (const it of items) {
        try {
          await db.execute(db.sql.memberServerPorts.updateProbe, [
            it.probeStatus, it.probeLatencyMs, it.hostname, it.port
          ]);
          written += 1;
        } catch (e) {
          _log.warn?.({ err: e.message, hostname: it.hostname, port: it.port }, 'member port probe write-back failed');
        }
      }
      const openN = items.filter(i => i.probeStatus === 'open').length;
      const closedN = items.filter(i => i.probeStatus === 'closed').length;
      const timeoutN = items.filter(i => i.probeStatus === 'timeout').length;
      const errorN = items.filter(i => i.probeStatus === 'error').length;
      _log.info?.({
        event: 'member.port.probe.tick',
        n: items.length, written, tickAt,
        counts: { open: openN, closed: closedN, timeout: timeoutN, error: errorN }
      }, 'member port probe tick');
    } catch (e) {
      _log.warn?.({ err: e.message, tickAt }, 'member port probe tick failed (best-effort)');
    } finally {
      // R158.89 — re-arm cadence 跟 R114 port-probe-scheduler.js:108-117 1:1
      //   平行. 每个 tick 末尾 re-read system_settings.member_port_probe_interval_ms,
      //   admin 改了下 cycle 自动生效, 0 restart. 跟 R158.78 system_settings
      //   lazy-insert idiom 1:1 闭合. readCadenceOverride 自身 catch 兜底
      //   失败返 default, 不会 throw 出 finally.
      const override = await readCadenceOverride();
      if (override !== effectiveIntervalMs) {
        const prev = effectiveIntervalMs;
        effectiveIntervalMs = override;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(tick, effectiveIntervalMs);
          if (timer.unref) timer.unref();
        }
        _log.info?.({
          event: 'member.port.probe.cadence.changed',
          from: prev, to: effectiveIntervalMs
        }, 'member port probe cadence re-armed');
      }
      inFlight = false;
    }
  };

  timer = setInterval(tick, effectiveIntervalMs);
  if (timer.unref) timer.unref();
  // 8s boot offset: 1 次冷启动探活, 之后 15min cadence.
  // 跟 R158.87.2 race condition lesson 1:1: 8s 让其它 5min cadence
  // scheduler 跑完先, member port probe 后跑避免群撞.
  bootTimer = setTimeout(tick, BOOT_OFFSET_MS);
  if (bootTimer.unref) bootTimer.unref();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (bootTimer) clearTimeout(bootTimer);
    }
  };
}
