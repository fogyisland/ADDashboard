// R158.86 (2026-10-12) — ad_member_os_baseline* post-hook + read helpers.
// R158.86.4 (2026-10-12) — 扩 19 字段 (跟 ad_os_baseline 1.0.7 metricSchema 平行).
//
// Why this exists:
//   ad_member_os_baseline + ad_member_os_baseline_latest are MEMBER
//   tables (operator's R158.86 "member server 会有独立发包" directive).
//   The member_os_baseline_collector v1.0.1 package manifest omits its
//   `database` block so the v2 metricstore path never runs (same precedent
//   as ad_eventlog_collector 1.0.6 / R112 + R158.78 member_eventlog_collector +
//   ad_os_baseline 1.0.7 metricSchema path 平行). The runner post-hook
//   therefore writes to the member-os-baseline tables directly.
//
// R158.86.4 — 19 字段 (跟 ad 端 1.0.7 metricSchema 1:1 平行):
//   5 标量 (R158.86 v1.0.0 就有): cpu_pct/memory_pct/c_used_pct/disk_free_bytes/services_count
//   14 新 (R158.86.4 v1.0.1): disk_free/disk_total/disks[]/services/events[]/bios_info/cpu_brand/
//                              mem_total_bytes/system_info/network_info/memory_modules[]/
//                              motherboard/cpu/ips[]
//   13 JSON/object 列在 service 层 bound() JSON.stringify 序列化
//   (跟 metricstore.js:148 bound() 同 precedent, 不在 SQL 层做).
//
//   - dialect dispatch is BAKED INTO the SQL helpers
//     (db.sql.memberOsBaseline.* returns { sql, params } from the active
//     dialect), not in this module — keeps the service dialect-agnostic.
//   - per-record try/catch so one bad row doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summaries for the route log.

function pickField(o, camelKey, snakeKey) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (snakeKey && o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  return null;
}

function asDate(value, fallback) {
  if (value instanceof Date) return value;
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback ?? new Date();
}

// R158.86.4 — bound() helper: 把 object/array 列 序列化成 JSON string
// (跟 metricstore.js:148 同 precedent, metricSchema path 一样做).
// 已经 string 化的 (PS1 端 ConvertTo-Json 已经做了 disk_free/disk_total map)
// 直接透传, 不用重复 stringify.
function bound(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

function normalizeMetrics(metrics, fallbackHostname) {
  if (!metrics || typeof metrics !== 'object') return null;
  const hostname = pickField(metrics, 'hostname') || pickField(metrics, 'agentId', 'agent_id') || fallbackHostname || null;
  if (!hostname) return null;

  // 5 标量 (R158.86 1.0.0 已有)
  const cpuPct        = pickField(metrics, 'cpuPct', 'cpu_pct');
  const memoryPct     = pickField(metrics, 'memoryPct', 'memory_pct');
  const cUsedPct      = pickField(metrics, 'cUsedPct', 'c_used_pct');
  const diskFreeBytes = pickField(metrics, 'diskFreeBytes', 'disk_free_bytes');
  const servicesCount = Number(pickField(metrics, 'servicesCount', 'services_count')) || 0;
  // 14 新字段 (R158.86.4 1.0.1)
  const diskFree       = pickField(metrics, 'diskFree', 'disk_free');
  const diskTotal      = pickField(metrics, 'diskTotal', 'disk_total');
  const disks          = pickField(metrics, 'disks');
  const services       = pickField(metrics, 'services');
  const events         = pickField(metrics, 'events');
  const biosInfo       = pickField(metrics, 'biosInfo', 'bios_info');
  const cpuBrand       = pickField(metrics, 'cpuBrand', 'cpu_brand');
  const memTotalBytes  = pickField(metrics, 'memTotalBytes', 'mem_total_bytes');
  const systemInfo     = pickField(metrics, 'systemInfo', 'system_info');
  const networkInfo    = pickField(metrics, 'networkInfo', 'network_info');
  const memoryModules  = pickField(metrics, 'memoryModules', 'memory_modules');
  const motherboard    = pickField(metrics, 'motherboard');
  const cpu            = pickField(metrics, 'cpu');
  const ips            = pickField(metrics, 'ips');

  return {
    agentId:        pickField(metrics, 'agentId', 'agent_id') || hostname,
    hostname:       String(hostname),
    collectedAt:    asDate(pickField(metrics, 'collectedAt', 'collected_at')),
    cpuPct,
    memoryPct,
    cUsedPct,
    diskFreeBytes,
    servicesCount,
    // 14 新字段 — bound() JSON 序列化在 upsertMetrics 喂 SQL helper 前做
    diskFree,
    diskTotal,
    disks,
    services,
    events,
    biosInfo,
    cpuBrand,
    memTotalBytes,
    systemInfo,
    networkInfo,
    memoryModules,
    motherboard,
    cpu,
    ips
  };
}

// ── write (post-hook) ────────────────────────────────────────────────────
// R158.86 — both metrics (time-series) and latest (per-host) tables upsert
// from the same wire payload. 1 run = 1 row in each table.
// R158.86.4 — 19 字段 upsert.
export async function upsertMetrics(db, metrics, fallbackHostname = null, log = null) {
  const normalized = normalizeMetrics(metrics, fallbackHostname);
  if (!normalized) {
    return { ok: false, reason: 'missing hostname in wire payload' };
  }
  // R158.86.4 — 13 JSON/object 列 bound() 序列化 (跟 metricstore.js:148 同 precedent).
  // 注意: disk_free/disk_total 来自 PS1 已经是 ConvertTo-Json 后的 string ({"C:":...}),
  // bound() 透传; disks/services/events/memory_modules/ips 是 array → JSON.stringify;
  // bios_info/system_info/network_info/motherboard/cpu 是 object → JSON.stringify.
  const boundMetrics = {
    collectedAt:    normalized.collectedAt,
    agentId:        normalized.agentId,
    hostname:       normalized.hostname,
    cpuPct:         normalized.cpuPct,
    memoryPct:      normalized.memoryPct,
    cUsedPct:       normalized.cUsedPct,
    diskFreeBytes:  normalized.diskFreeBytes,
    servicesCount:  normalized.servicesCount,
    diskFree:       bound(normalized.diskFree),
    diskTotal:      bound(normalized.diskTotal),
    disks:          bound(normalized.disks),
    services:       bound(normalized.services),
    events:         bound(normalized.events),
    biosInfo:       bound(normalized.biosInfo),
    cpuBrand:       normalized.cpuBrand,
    memTotalBytes:  normalized.memTotalBytes,
    systemInfo:     bound(normalized.systemInfo),
    networkInfo:    bound(normalized.networkInfo),
    memoryModules:  bound(normalized.memoryModules),
    motherboard:    bound(normalized.motherboard),
    cpu:            bound(normalized.cpu),
    ips:            bound(normalized.ips)
  };
  const builtMetrics = db.sql.memberOsBaseline.upsertMetrics(boundMetrics);
  const builtLatest  = db.sql.memberOsBaseline.upsertLatest(boundMetrics);
  const errors = [];
  let metricsOk = false;
  let latestOk = false;
  try {
    await db.execute(builtMetrics.sql, builtMetrics.params);
    metricsOk = true;
  } catch (e) {
    log?.error?.({
      event: 'member_os_baseline.upsert_metrics_failed',
      hostname: normalized.hostname,
      err: e?.message || String(e)
    }, 'member-os-baseline metrics upsert failed');
    errors.push({ table: 'ad_member_os_baseline', error: e?.message || String(e) });
  }
  try {
    await db.execute(builtLatest.sql, builtLatest.params);
    latestOk = true;
  } catch (e) {
    log?.error?.({
      event: 'member_os_baseline.upsert_latest_failed',
      hostname: normalized.hostname,
      err: e?.message || String(e)
    }, 'member-os-baseline latest upsert failed');
    errors.push({ table: 'ad_member_os_baseline_latest', error: e?.message || String(e) });
  }
  return {
    ok:    metricsOk && latestOk,
    hostname: normalized.hostname,
    metricsOk,
    latestOk,
    errors
  };
}

// ── reads (front-end driven) ────────────────────────────────────────────
// Latest by hostname (single row). Drives the /memberServer "OS 基线" tab
// first paint.
// R158.86.4 — 19 字段 read 反射成 camelCase (跟 AD 端 os-baseline.js:138-164 平行).
export async function getLatest(db, { hostname }) {
  if (!hostname) return null;
  const built = db.sql.memberOsBaseline.latestByHostname({ hostname });
  const { rows } = await db.execute(built.sql, built.params);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  return {
    collectedAt:    r.collected_at ?? r.COLLECTED_AT,
    agentId:        r.agent_id ?? r.AGENT_ID,
    hostname:       r.hostname ?? r.HOSTNAME,
    cpuPct:         r.cpu_pct ?? r.CPU_PCT,
    memoryPct:      r.memory_pct ?? r.MEMORY_PCT,
    cUsedPct:       r.c_used_pct ?? r.C_USED_PCT,
    diskFreeBytes:  r.disk_free_bytes ?? r.DISK_FREE_BYTES,
    servicesCount:  r.services_count ?? r.SERVICES_COUNT,
    diskFree:       r.disk_free ?? r.DISK_FREE,
    diskTotal:      r.disk_total ?? r.DISK_TOTAL,
    disks:          r.disks ?? r.DISKS,
    services:       r.services ?? r.SERVICES,
    events:         r.events ?? r.EVENTS,
    biosInfo:       r.bios_info ?? r.BIOS_INFO,
    cpuBrand:       r.cpu_brand ?? r.CPU_BRAND,
    memTotalBytes:  r.mem_total_bytes ?? r.MEM_TOTAL_BYTES,
    systemInfo:     r.system_info ?? r.SYSTEM_INFO,
    networkInfo:    r.network_info ?? r.NETWORK_INFO,
    memoryModules:  r.memory_modules ?? r.MEMORY_MODULES,
    motherboard:    r.motherboard ?? r.MOTHERBOARD,
    cpu:            r.cpu ?? r.CPU,
    ips:            r.ips ?? r.IPS
  };
}

// Timeseries drilldown for one hostname within the retention window.
// Returns rows in DESC collected_at order. Front-end flips to ASC for
// chart rendering.
// R158.86.4 — 19 字段 read.
export async function getTimeseries(db, { hostname, hours = 24, limit = 500 }) {
  if (!hostname) return [];
  const built = db.sql.memberOsBaseline.queryByHostname({ hostname, hours, limit });
  const { rows } = await db.execute(built.sql, built.params);
  return (rows ?? []).map(r => ({
    collectedAt:    r.collected_at ?? r.COLLECTED_AT,
    cpuPct:         r.cpu_pct ?? r.CPU_PCT,
    memoryPct:      r.memory_pct ?? r.MEMORY_PCT,
    cUsedPct:       r.c_used_pct ?? r.C_USED_PCT,
    diskFreeBytes:  r.disk_free_bytes ?? r.DISK_FREE_BYTES,
    servicesCount:  r.services_count ?? r.SERVICES_COUNT,
    diskFree:       r.disk_free ?? r.DISK_FREE,
    diskTotal:      r.disk_total ?? r.DISK_TOTAL,
    disks:          r.disks ?? r.DISKS,
    services:       r.services ?? r.SERVICES,
    events:         r.events ?? r.EVENTS,
    biosInfo:       r.bios_info ?? r.BIOS_INFO,
    cpuBrand:       r.cpu_brand ?? r.CPU_BRAND,
    memTotalBytes:  r.mem_total_bytes ?? r.MEM_TOTAL_BYTES,
    systemInfo:     r.system_info ?? r.SYSTEM_INFO,
    networkInfo:    r.network_info ?? r.NETWORK_INFO,
    memoryModules:  r.memory_modules ?? r.MEMORY_MODULES,
    motherboard:    r.motherboard ?? r.MOTHERBOARD,
    cpu:            r.cpu ?? r.CPU,
    ips:            r.ips ?? r.IPS,
    siteId:         r.site_id ?? r.SITE_ID ?? null,
    siteName:       r.site_name ?? r.SITE_NAME ?? null
  }));
}

// ── retention ────────────────────────────────────────────────────────────
// R158.86 — 7d retention for time-series; latest rows pruned by stale
// ad_member_servers.last_seen_at (> retention).
// R158.86.2 — 10d retention. R158.86.4 — 不变 (整行 drop, JSON 在内).
export async function purgeOlderThan(db, { cutoffIso }, log = null) {
  const built = db.sql.memberOsBaseline.purgeOlderThan({ cutoffIso });
  const out = { tsDeleted: 0, latestDeleted: 0, errors: [] };
  try {
    const r = await db.execute(built.sql, built.params);
    out.tsDeleted = r?.affectedRows ?? r?.rowCount ?? 0;
  } catch (e) {
    out.errors.push({ table: 'ad_member_os_baseline', error: e?.message || String(e) });
    log?.error?.({ event: 'member_os_baseline.purge_failed', table: 'ad_member_os_baseline', err: e?.message }, 'member-os-baseline metrics purge failed');
  }
  return out;
}

export async function purgeLatestByStaleServer(db, { cutoffIso }, log = null) {
  const built = db.sql.memberOsBaseline.purgeLatestByStaleServer({ cutoffIso });
  const out = { latestDeleted: 0, errors: [] };
  try {
    const r = await db.execute(built.sql, built.params);
    out.latestDeleted = r?.affectedRows ?? r?.rowCount ?? 0;
  } catch (e) {
    out.errors.push({ table: 'ad_member_os_baseline_latest', error: e?.message || String(e) });
    log?.error?.({ event: 'member_os_baseline.purge_latest_failed', err: e?.message }, 'member-os-baseline latest purge failed');
  }
  return out;
}

// Re-export for tests.
export { normalizeMetrics, bound };

// ── 10-day retention loop factory ─────────────────────────────────────────
//
// Mirrors createMemberEventlogRetentionLoop shape (Global Constraint #8):
// start() schedules a setInterval with an inFlight guard; tick() runs a
// single purgeOlderThan + purgeLatestByStaleServer sweep; stop() clears
// the interval and waits for the in-flight tick so a shutdown can't
// strand a half-written DELETE. Cadence is hard-coded at 1 hour —
// coarse-grained background work, no per-tick interval knob. To run a
// purge on demand (operator command, test), call `tick()` directly.
// R158.86.2 (2026-10-12) — operator directive "数据保留10天", 默认从 7d → 10d.
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
//   retentionDays 参数保留作 fallback (跟 R158.86 兼容, server.js 传 undefined
//   则走 getSystemConfig). 0 = 永久保留 (return). 默认 30d.
const MEMBER_OS_BASELINE_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MEMBER_OS_BASELINE_DEFAULT_RETENTION_DAYS = 30;

export function createMemberOsBaselineRetentionLoop({ db, getSystemConfig, logger, retentionDays }) {
  let interval = null;
  let inFlight = null;

  async function tick() {
    let days;
    try {
      // R158.107 — 优先读 ad_mgmt_retention_days (8 service 统一单点);
      // retentionDays 显式传时优先, 兼容 R158.86 server.js 旧调用.
      if (retentionDays != null) {
        days = Math.max(1, Number(retentionDays) || MEMBER_OS_BASELINE_DEFAULT_RETENTION_DAYS);
      } else {
        const cfg = (await getSystemConfig?.()) || {};
        const raw = cfg.ad_mgmt_retention_days;
        const parsed = Number(raw);
        if (raw == null || raw === '') {
          days = MEMBER_OS_BASELINE_DEFAULT_RETENTION_DAYS;
        } else if (Number.isFinite(parsed) && parsed <= 0) {
          return { skipped: true, reason: 'ad_mgmt_retention_days <= 0 (retention disabled)' };
        } else if (Number.isFinite(parsed) && parsed > 0) {
          days = Math.floor(parsed);
          // R158.X.99.32 (2026-10-19) — defensive floor guard
          if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; }
        } else {
          logger?.warn?.({ ad_mgmt_retention_days: raw },
            'member-os-baseline retention days is non-numeric, using default');
          days = MEMBER_OS_BASELINE_DEFAULT_RETENTION_DAYS;
        }
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'member-os-baseline retention: getSystemConfig failed (best-effort)');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    const tsCutoff = new Date(Date.now() - days * 24 * 3600_000);
    const latestCutoff = new Date(Date.now() - days * 24 * 3600_000);
    const tsOut = await purgeOlderThan(db, { cutoffIso: tsCutoff }, logger);
    const latestOut = await purgeLatestByStaleServer(db, { cutoffIso: latestCutoff }, logger);
    const out = {
      tsDeleted:      tsOut.tsDeleted,
      latestDeleted:  latestOut.latestDeleted,
      errors:         [...tsOut.errors, ...latestOut.errors],
      days
    };
    logger?.info?.({
      sweep: `member-os-baseline ${days}d`,
      tsDeleted: out.tsDeleted,
      latestDeleted: out.latestDeleted,
      errorCount: out.errors.length
    }, 'member-os-baseline retention sweep complete');
    return out;
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) =>
        logger?.warn?.({ err: e?.message || String(e) }, 'member-os-baseline retention tick failed (best-effort)')
      );
    }, MEMBER_OS_BASELINE_RETENTION_INTERVAL_MS);
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
