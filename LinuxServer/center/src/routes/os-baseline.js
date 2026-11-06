// R116 — OS Baseline fleet view router.
//
// Access model (operator directive 2026-09-26): "我们不需要在admin后台看到,
// 直接在前台就可以看到" + "两个界面都没有出现" — this is auth-required
// (any logged-in user can see) with NO admin perm gate, mirroring the
// R112 eventlog router pattern exactly. Regular users see fleet OS
// baseline state; admin perm gates are NOT applied.
//
// Auth contract: caller passes a `requireAuth` thunk (same shape as
// dcsRouter / lockoutRouter / eventlogRouter use). The router factory
// returns a single Express Router that owns one endpoint:
//
//   GET /api/os-baseline?sinceHours=24
//     - Returns one row per agent_id (member-server), where each row
//       is the LATEST snapshot within `sinceHours` for that agent.
//     - sinceHours is clamped to [1, 168] (1 hour to 1 week) so the
//       page can offer 24h / 7d / 1w selects without exposing
//       unbounded time travel.
//     - Each row carries: agent_id, ts, cpu_pct, memory_pct,
//       disk_free (JSON string), disk_total (JSON string), services
//       (JSON string), events (JSON string) PLUS enriched site fields:
//       site_name, site_id, enabled, last_seen_at (LEFT JOIN from
//       ad_dcs → ad_sites; null on miss).
//     - The 磁盘已使用(%) logic is computed FRONT-END (not here) so the
//       back-end stays simple and the threshold colors can iterate
//       without DB migrations. JSON parse failures degrade gracefully
//       to N/A on the card.
//
// Errors: any DB error returns 500 with `{ error: 'internal' }` so the
// front-end can show a friendly banner without leaking driver internals.
// Reads are read-only — this router MUST NOT mutate the public tables.
// The metricstore ingest path + agent-side collect.ps1 are the only
// legitimate writers.

import { Router } from 'express';
import { getDb } from '../db/index.js';

const DEFAULT_SINCE_HOURS = 24;
const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168; // 1 week — covers 24h / 72h / 7d selectors

export function osBaselineRouter({ requireAuth }) {
  const r = Router();

  // Apply the auth thunk to /api/os-baseline only — the path-scoping
  // matches the eventlogRouter fix. Pre-fix `r.use(requireAuth)` (no
  // path) turned this router into a blanket GET 401, swallowing
  // /api/admin/agent/packages-for-host and every other GET that hadn't
  // matched an earlier router. Registered BEFORE the GET handler so
  // authenticated users reach the handler, not a 404 catch-all.
  //
  // R126 fix: removed `r.use('/api/os-baseline', 404)` catch-all that
  // previously sat between requireAuth and the GET handler. Because
  // `r.use(path)` matches every HTTP method and prefix, the catch-all
  // ran AFTER requireAuth passed and returned 404 *before* the GET
  // handler ever ran — anonymous probes saw 401 (auth rejected first)
  // which masked the bug, but logged-in users got 404. Removing the
  // catch-all is safe: `r.get('/api/os-baseline', ...)` is the only
  // path this router serves, express's default 404 covers unmatched
  // paths/methods, and the SPA fallback in src/app.js excludes /api/*
  // so requests fall through to the next mounted router instead of
  // landing on index.html.
  // R158.29 — apply requireAuth to BOTH the list endpoint (cards) and
  // the timeseries endpoint (per-agent 24h CPU/memory chart data). The
  // file-header contract says "any logged-in user can see" the OS
  // baseline fleet state; the chart data is the same fleet state in
  // time-series form, so both paths must enforce the same auth gate.
  // Without this r.use('/api/os-baseline/timeseries', ...) would be
  // publicly readable (P1-1 from R158.29 code review).
  r.use('/api/os-baseline', requireAuth);
  r.use('/api/os-baseline/timeseries', requireAuth);

  r.get('/api/os-baseline', async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS, DEFAULT_SINCE_HOURS);
      const db = getDb();
      // db.sql is the dialect-flattened view produced by buildSql(dialect)
      // — each domain (`osBaselineMetrics`, `replication`, ...) is already
      // shaped for the active dialect, so we don't slice on `.mysql` /
      // `.mssql` here. Picking the wrong shape was the source of the
      // pre-fix 500s. R158.68 — alertMetrics 删, 改 osBaselineMetrics.
      const helper = db.sql.osBaselineMetrics.listLatestPerAgent;
      const sql = typeof helper === 'function'
        ? helper({ sinceHours })
        : helper;
      // listLatestPerAgent is template-shaped (sinceHours interpolated
      // as a sanitised int), so no params array is needed here.
      const result = await db.query(sql);
      const rows = Array.isArray(result) ? result : (result.rows ?? []);

      // Enrich each row with site info from ad_dcs + ad_sites. One batched
      // SELECT with IN(...) keyed by agent_id (which equals ad_dcs.dc_name).
      //
      // R131 fix: corrected the column names in the enrichment SELECT. The
      // R116 original wrote `d.hostname / d.enabled / d.last_seen_at`, but
      // the actual ad_dcs schema (verified via INFORMATION_SCHEMA.COLUMNS)
      // has `dc_name / is_gc / discovered_at` — and no `enabled` /
      // `last_seen_at` columns at all. The wrong column names caused a
      // 500 on every /api/os-baseline?sinceHours=N call, blanking the
      // whole OS Baseline front-end page. Map to the real columns:
      //   d.hostname     → d.dc_name      (agent hostname ↔ DC name)
      //   d.enabled      → null           (no such column — keep enabled
      //                                    null so the front-end's
      //                                    `card.enabled === false`
      //                                    branch never fires; the chip
      //                                    always reads "已启用")
      //   d.last_seen_at → d.discovered_at (best available proxy for
      //                                    when the centre first learned
      //                                    about the DC; agent_id's
      //                                    own `ts` (line 113) is the
      //                                    per-snapshot fresh metric.)
      const hosts = Array.from(new Set(
        rows.map((r) => r.agent_id).filter((h) => typeof h === 'string' && h.length > 0)
      ));
      let enrichMap = new Map();
      if (hosts.length > 0) {
        const placeholders = hosts.map(() => '?').join(',');
        const enrichSql = `SELECT d.dc_name, d.site_id, d.discovered_at, s.site_name
                          FROM ad_dcs d
                          LEFT JOIN ad_sites s ON s.site_id = d.site_id
                          WHERE d.dc_name IN (${placeholders})`;
        const enrichResult = await db.query(enrichSql, hosts);
        const enrichRows = Array.isArray(enrichResult) ? enrichResult : (enrichResult.rows ?? []);
        for (const e of enrichRows) {
          enrichMap.set(e.dc_name, {
            site_name:     e.site_name ?? null,
            site_id:       e.site_id ?? null,
            discovered_at: e.discovered_at ?? null
          });
        }
      }

      // Re-shape to camelCase + merge enrichment. Disk / services / events
      // stay as their wire JSON strings — front-end parses lazily per card.
      const out = rows.map((row) => {
        const enrich = enrichMap.get(row.agent_id) ?? {};
        return {
          agentId:       row.agent_id,
          ts:            row.ts,
          cpuPct:        row.cpu_pct == null ? null : Number(row.cpu_pct),
          memoryPct:     row.memory_pct == null ? null : Number(row.memory_pct),
          diskFree:      row.disk_free ?? null,
          diskTotal:     row.disk_total ?? null,
          services:      row.services ?? null,
          events:        row.events ?? null,
          // R147 — hardware identity + per-drive + C-used%
          biosInfo:      row.bios_info ?? null,
          cpuBrand:      row.cpu_brand ?? null,
          memTotalBytes: row.mem_total_bytes == null ? null : Number(row.mem_total_bytes),
          disks:         row.disks ?? null,
          cUsedPct:      row.c_used_pct == null ? null : Number(row.c_used_pct),
          // R158.30 — 3 new JSON columns: system manufacturer / network IPs / memory modules.
          // bios_info gained serial_number in-place (front-end parses lazily); disks[] elements
          // gained model + bus_type in-place. Old 1.0.3 rows get NULL on these 3 columns until
          // the agent re-runs (intervalSec=60, ~5 min rollout window).
          systemInfo:    row.system_info ?? null,
          networkInfo:   row.network_info ?? null,
          memoryModules: row.memory_modules ?? null,
          siteName:      enrich.site_name ?? null,
          siteId:        enrich.site_id ?? null,
          // No enabled column on ad_dcs — the chip stays "已启用" by
          // design (front-end check is `enabled === false`). R131 fix.
          enabled:       null,
          lastSeenAt:    enrich.discovered_at ?? null
        };
      });

      res.json({ items: out, sinceHours });
    } catch (e) {
      req.log?.error?.({
        event: 'os_baseline.list_failed',
        err: e?.message || String(e)
      }, 'os-baseline list read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.29 — per-agent 24h CPU + memory time-series for the OS baseline
  // front-end dual-line chart. Same data source (pkg_ad_os_baseline.metrics)
  // as the latest-per-agent list above, but returns bucketed time-series
  // instead of one row per agent. Auth is applied via the parent r.use at
  // the top of this factory (r.use('/api/os-baseline/timeseries', requireAuth)).
  //
  // Wire shape:
  //   { hours, bucketMinutes, ts, agentCount, sampleCount,
  //     seriesByAgent: { [agentId]: { cpu: [{ts,value}], memory: [{ts,value}] } } }
  //
  // Three differences from the hub-resources endpoint (routes/dashboard.js:476):
  //   1. NO ad_sites.is_hub=1 filter — OS baseline front-end shows ALL sites
  //      (R140 site grouping), not just hubs.
  //   2. NO disk_free/disk_total JSON walk — the chart is dual-line
  //      (CPU + memory only); disk is shown as a text tile on the card.
  //   3. hours cap is [1, 24] not [1, 48] — front-end only ever asks for 24h.
  //      (5-min bucket × 24h = 288 points per series × 2 series = ~580
  //       points per agent. 30+ agents × 580 = ~17k JSON points total,
  //       well under echarts canvas limits.)
  r.get('/api/os-baseline/timeseries', async (req, res) => {
    try {
      const MIN_HOURS = 1;
      const MAX_HOURS = 24;
      const DEFAULT_HOURS = 24;
      const bucketMinutes = 5;
      const hours = clampInt(req.query.hours, MIN_HOURS, MAX_HOURS, DEFAULT_HOURS);
      const sinceMinutes = hours * 60;

      const db = getDb();

      // 1. enumerate agent_ids = same set the cards endpoint returns.
      //    Use listLatestPerAgent with the same sinceHours window so the
      //    chart set stays in sync with the card set: if a card disappears
      //    from /api/os-baseline, its chart disappears here too.
      //    R158.68 — alertMetrics 删, 改 osBaselineMetrics.
      const latestHelper = db.sql.osBaselineMetrics.listLatestPerAgent;
      const latestSql = typeof latestHelper === 'function'
        ? latestHelper({ sinceHours: hours })
        : latestHelper;
      const latestResult = await db.query(latestSql);
      const latestRows = Array.isArray(latestResult) ? latestResult : (latestResult.rows ?? []);
      const agentIds = Array.from(new Set(
        latestRows.map((r) => r.agent_id).filter((h) => typeof h === 'string' && h.length > 0)
      ));

      if (agentIds.length === 0) {
        return res.json({
          ts: new Date().toISOString(),
          hours,
          bucketMinutes,
          agentCount: 0,
          sampleCount: 0,
          seriesByAgent: {}
        });
      }

      // 2. fetch raw rows for the window. agentIds bound via `?` placeholders
      //    (safe). sinceMinutes interpolated as sanitised int (MSSQL
      //    DATEADD first arg can't bind reliably — set the precedent at
      //    hub-resources).
      //
      // R158.29 root cause: db.sql.osBaselineTimeseries is registered as a
      // {mysql, mssql} DICTIONARY (not a flat SQL string) because the helper
      // factory needs to take runtime args (agentIds + sinceMinutes).
      // Picking `db.sql.osBaselineTimeseries[db.dialect]` gives the dialect-
      // specific SQL factory; calling it with `{ agentIds, sinceMinutes }`
      // returns the final SQL with the inline placeholder list + the
      // sanitised INTERVAL/DATEADD numeric.
      const tsDict = db.sql.osBaselineTimeseries;
      const tsHelper = tsDict && tsDict[db.dialect];
      const tsSql = typeof tsHelper === 'function'
        ? tsHelper({ agentIds, sinceMinutes })
        : tsHelper;
      const result = await db.query(tsSql, agentIds);
      const rows = Array.isArray(result) ? result : (result.rows ?? []);

      // 3. bucket into 5-min windows. Adapted from routes/dashboard.js:540-594
      //    but simplified — only cpu_pct + memory_pct, no disk_free/total
      //    JSON walk. Per-agent bucketing (no fleet aggregation since the
      //    front-end renders one chart per card).
      const bucketSizeMs = bucketMinutes * 60 * 1000;
      const epochStart = Date.now() - hours * 3600 * 1000;
      const bucketsByAgent = new Map();
      const newSlot = () => ({ cpuSum: 0, cpuN: 0, memSum: 0, memN: 0 });
      for (const r of rows) {
        const tsMs = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
        if (!Number.isFinite(tsMs) || tsMs < epochStart) continue;
        const b = Math.floor((tsMs - epochStart) / bucketSizeMs) * bucketSizeMs + epochStart;
        let m = bucketsByAgent.get(r.agent_id);
        if (!m) { m = new Map(); bucketsByAgent.set(r.agent_id, m); }
        let slot = m.get(b);
        if (!slot) { slot = newSlot(); m.set(b, slot); }
        const cpu = Number(r.cpu_pct);
        if (Number.isFinite(cpu)) { slot.cpuSum += cpu; slot.cpuN++; }
        const mem = Number(r.memory_pct);
        if (Number.isFinite(mem)) { slot.memSum += mem; slot.memN++; }
      }

      // 4. emit per-agent seriesByAgent. Empty buckets are skipped (no
      //    push) — echarts `type: 'category'` will line-break on missing
      //    buckets, which is the existing hub-resources convention.
      const seriesByAgent = {};
      const agentIdsSorted = Array.from(bucketsByAgent.keys()).sort();
      for (const agentId of agentIdsSorted) {
        const m = bucketsByAgent.get(agentId);
        const dCpu = [], dMem = [];
        const keys = Array.from(m.keys()).sort((a, b) => a - b);
        for (const k of keys) {
          const s = m.get(k);
          const ts = new Date(k).toISOString();
          if (s.cpuN) dCpu.push({ ts, value: Math.round((s.cpuSum / s.cpuN) * 10) / 10 });
          if (s.memN) dMem.push({ ts, value: Math.round((s.memSum / s.memN) * 10) / 10 });
        }
        seriesByAgent[agentId] = { cpu: dCpu, memory: dMem };
      }

      res.json({
        ts: new Date().toISOString(),
        hours,
        bucketMinutes,
        agentCount: agentIds.length,
        sampleCount: rows.length,
        seriesByAgent
      });
    } catch (e) {
      req.log?.error?.({
        event: 'os_baseline.timeseries_failed',
        err: e?.message || String(e)
      }, 'os-baseline timeseries read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}

function clampInt(raw, min, max, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return min;
  if (n > max) return max;
  return n;
}