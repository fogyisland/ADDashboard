// R112 — eventlog router.
//
// Access model (revised by operator 2026-09-26 after the original "public
// page" directive): "其实也是需要登录到普通用户界面，普通用户界面可以看到
// DC基本情况，后台可以进行管理而已". So this router is mounted with
// `requireAuth` (regular user auth, NOT admin perm). Regular users see DC
// basic state — overview / eventlog / sites — and only admins (the
// `admin:users` perm) hit the management surfaces.
//
// Concretely:
//   - `requireAuth` is a pre-built userAuth middleware thunk (same shape
//     as dcsRouter / lockoutRouter use).
//   - There is NO `requirePerm` — any authenticated user can read the
//     eventlog. Adding an admin gate here would silently lock out the
//     operators the user explicitly wants to grant access.
//
// Two endpoints back the front-end:
//
//   GET /api/eventlog/summary?sinceHours=24
//     - Returns one row per (dc_name, channel) for the latest summary
//       within the retention window. Drives the 4-channel counter grid.
//     - Each row: { dcName, channel, warningCount, errorCount, collectedAt }.
//     - sinceHours is clamped to [1, 24] — the page is hard-coded to 24h.
//
//   GET /api/eventlog/events?dc=DC-X&channel=System&sinceHours=24&limit=200&severity=error
//     - Drill-down events for one (dc, channel). severity is optional —
//       omit/empty to return warnings + errors.
//     - limit is clamped to [1, 500].
//
// Both endpoints are best-effort: any DB error returns 500 with
// `{ error: 'internal' }` so the front-end can show a friendly banner
// without leaking driver internals. Reads are read-only — they MUST NOT
// mutate the public tables. Retention is the runner post-hook + hourly
// retention loop's job (NOT this router).

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getLatestSummary, queryEvents, trend24h, dailyAggregate, trendByBucketMinutes } from '../services/eventlog.js';

const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 2; // R154 — page is hard-coded to 2h scan window
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

// Channel whitelist — the 5 columns the page renders (R154 added
// 'Security'). Anything outside this set is rejected with 400 so a
// malformed/garbage ?channel=... can't drive unbounded queries against
// the index-less `(channel)` set on ad_eventlog_events. Mirrors the
// operator's exact wording for the original 4 channels plus the new
// 安全日志 column.
const CHANNEL_KEYS = new Set(['System', 'Application', 'ADWeb', 'DFSR', 'Security']);

export function eventlogRouter({ requireAuth }) {
  const r = Router();

  // Apply the auth thunk to all eventlog GETs. The auth run is scoped
  // to /api/eventlog/* via the middleware path so unrelated GETs that
  // bubble up to this router (because earlier routers didn't match)
  // don't get a blanket 401 — the path-scope mirrors the osBaselineRouter
  // fix below. Pre-fix this was a path-less `r.use(requireAuth)` which
  // made the router an effective global interceptor, swallowing
  // /api/admin/agent/packages-for-host and every other un-claimed GET
  // with a 401 'missing token' (user-auth.js:56) before the agent-
  // facing router could ever respond.
  //
  // R126 fix: removed `r.use('/api/eventlog', 404)` catch-all that
  // previously sat between requireAuth and the GET handlers. Because
  // `r.use(path)` matches every HTTP method and prefix, the catch-all
  // ran AFTER requireAuth passed and returned 404 *before* the GET
  // handlers (line 74 / 86 below) ever ran — anonymous probes saw 401
  // (auth rejected first) which masked the bug, but logged-in users
  // got 404 for both /api/eventlog/summary and /api/eventlog/events.
  // Removing the catch-all is safe: the two `r.get` handlers are the
  // only paths this router serves, express's default 404 covers
  // unmatched paths/methods, and the SPA fallback in src/app.js
  // excludes /api/* so requests fall through to the next mounted
  // router instead of landing on index.html.
  r.use('/api/eventlog', requireAuth);

  r.get('/api/eventlog/summary', async (req, res) => {
    try {
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const db = getDb();
      const rows = await getLatestSummary(db, { sinceHours });
      // Re-shape to camelCase for the front-end (snake_case is the DB
      // wire shape; camelCase is the JS shape consumed by EventlogView).
      const out = rows.map((row) => ({
        dcName:       row.dc_name,
        channel:      row.channel,
        warningCount: Number(row.warning_count ?? 0),
        errorCount:   Number(row.error_count ?? 0),
        // R154 — audit-failure count surfaces in the Security column.
        // Other channels always return 0 (DEFAULT 0 on the column).
        auditFailureCount: Number(row.audit_failure_count ?? 0),
        collectedAt:  row.collected_at,
        // R142 — site grouping wire shape (mirrors R140 dashboard.agents).
        // Non-breaking: existing fields keep their names and shapes.
        // Frontend groups by siteName, falls back to UNGROUPED_LABEL
        // (see EventlogView.vue) when null.
        siteId:       row.site_id ?? null,
        siteName:     row.site_name ?? null,
        regionCode:   row.region_code ?? null,
        siteHint:     row.site_hint ?? null
      }));
      res.json(out);
    } catch (e) {
      req.log?.error?.({
        event: 'eventlog.summary_failed',
        err: e?.message || String(e)
      }, 'eventlog summary read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/api/eventlog/events', async (req, res) => {
    try {
      const dcName  = String(req.query.dc  ?? '').trim();
      const channel = String(req.query.channel ?? '').trim();
      if (!dcName || !channel) {
        return res.status(400).json({ error: 'dc and channel are required' });
      }
      if (!CHANNEL_KEYS.has(channel)) {
        return res.status(400).json({ error: `channel must be one of: ${[...CHANNEL_KEYS].join(', ')}` });
      }
      const severityRaw = String(req.query.severity ?? '').trim();
      const severity = severityRaw === '' ? null : severityRaw;
      if (severity !== null && severity !== 'warning' && severity !== 'error') {
        return res.status(400).json({ error: 'severity must be "warning" or "error"' });
      }
      const sinceHours = clampInt(req.query.sinceHours, MIN_SINCE_HOURS, MAX_SINCE_HOURS);
      const limit = clampInt(req.query.limit, MIN_LIMIT, MAX_LIMIT);
      // R154 — `auditOnly=true` is meaningful only for the Security
      // channel (other channels never produce audit_failure=1 rows in
      // practice); we accept the param on any channel and let the SQL
      // filter downstream so the URL stays uniform.
      const auditOnly = String(req.query.auditOnly ?? '').trim() === 'true';

      const db = getDb();
      const rows = await queryEvents(db, { dcName, channel, severity, sinceHours, limit, auditOnly });
      // Same camelCase re-shape as the summary endpoint.
      const out = rows.map((row) => ({
        collectedAt: row.collected_at,
        dcName:      row.dc_name,
        channel:     row.channel,
        severity:    row.severity,
        eventId:     Number(row.event_id),
        recordId:    Number(row.record_id),
        message:     row.message,
        ts:          row.ts,
        // R154 — audit_failure flag on the event row. Frontend uses it
        // to badge 4625/4776 rows in the Security drill-down drawer.
        auditFailure: Number(row.audit_failure ?? 0)
      }));
      res.json(out);
    } catch (e) {
      req.log?.error?.({
        event: 'eventlog.events_failed',
        err: e?.message || String(e)
      }, 'eventlog events read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // R158.54 (2026-10-08) — 24h hourly event log trend for the /eventlog
  // line chart. 5 channel × 24 hour bucket × COUNT(*). Auth-required
  // (requireAuth applied above), NO admin perm (same access tier as
  // /summary and /events). Event log source — different from
  // ad_eventlog_summary (gauge-style rollup) which is point-in-time
  // counts per (dc, channel); trend24h is the event-log accumulation
  // over 24h × 1h buckets. R158.50.7n lesson: chart and grid use the
  // same event-log semantic (warning + error COUNT) so the line
  // aligns with the per-cell totals.
  //
  // R158.108 (2026-10-16) — 24h/7d/全部 toggle. 0 改 endpoint path,
  // 0 改 response shape, 接受 ?windowHours&days&grain. 1:1 平行
  // failed-logon route (?sinceHours=24|168) 范式. 24h 行为 0 改
  // (R158.54 1:1 平行, default=hourly). 7d/全部 走 daily bucket
  // (R158.107 retention 30d 边界自动跟). 24h 仍走 hourly (R158.54
  // 行为保留).
  const TREND_DEFAULT_HOURS = 24;
  const TREND_MAX_HOURS     = 168;   // 7d hourly 上限
  const TREND_MAX_DAYS      = 365;   // 1y daily hard cap
  const TREND_ALLOWED_GRAIN = new Set(['hourly', 'daily', 'bucket5m', 'bucket4h']);

  r.get('/api/eventlog/trend', async (req, res) => {
    try {
      const hoursRaw = req.query.windowHours;
      const daysRaw  = req.query.days;
      const grainRaw = String(req.query.grain ?? '').trim().toLowerCase();

      const grain = grainRaw === '' ? 'hourly' : grainRaw;
      if (!TREND_ALLOWED_GRAIN.has(grain)) {
        return res.status(400).json({ error: `grain must be one of: ${[...TREND_ALLOWED_GRAIN].join(', ')}` });
      }

      const db = getDb();
      let rows;
      if (grain === 'daily') {
        // 7d/全部走 daily. days 默认 7, 跟 toggle "7d" 按钮 1:1. "全部" 按钮
        // 前端传 ad_mgmt_retention_days (R158.107 retention 边界, 默认 30).
        const days = clampInt(daysRaw, 1, TREND_MAX_DAYS, 7);
        rows = await dailyAggregate(db, { days }, req.log);
      } else if (grain === 'bucket5m') {
        // R158.X.99.33 (2026-10-19) — 24h 走 5min bucket-by-ts (288 段/24h).
        // bucket 边界走 `ts` (Windows TimeGenerated) 不是 `collected_at`,
        // 所以走的是"24h 内真实发生的事件" 5min 视角, 操作员原意.
        // hours ∈ [1, 168]. bucketMinutes 写死 5 (UI 0 出 1min/15min 选项,
        // R158.X+UI.lock "0 改 working frontend 文案").
        const hours = clampInt(hoursRaw, 1, TREND_MAX_HOURS, TREND_DEFAULT_HOURS);
        rows = await trendByBucketMinutes(db, { hours, bucketMinutes: 5 }, req.log);
      } else if (grain === 'bucket4h') {
        // R158.X.99.34 (2026-10-19) — 7d 走 4h bucket-by-ts (42 段/7d).
        // 跟 24h bucket5m 范式 1:1, 唯一区别 bucketMinutes=240. 全部仍 daily.
        // R158.X.99.34.fix (2026-10-19) — daysRaw 而非 hoursRaw (前端传
        // `days=7`, hoursRaw 默认 24 = 只看 24h). days 转 hours = days*24,
        // hard cap TREND_MAX_HOURS=168.
        const days  = clampInt(daysRaw, 1, Math.floor(TREND_MAX_HOURS / 24), 7);
        const hours = clampInt(days * 24, 1, TREND_MAX_HOURS, days * 24);
        rows = await trendByBucketMinutes(db, { hours, bucketMinutes: 240 }, req.log);
      } else {
        // 24h hourly (R158.54 行为 0 改)
        const hours = clampInt(hoursRaw, 1, TREND_MAX_HOURS, TREND_DEFAULT_HOURS);
        rows = await trend24h(db, { hours }, req.log);
      }
      res.json(rows);
    } catch (e) {
      req.log?.error?.({
        event: 'eventlog.trend_failed',
        err: e?.message || String(e)
      }, 'eventlog trend read failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}

// R158.108 (2026-10-16) — clampInt overload: clampInt(raw, min, max, defaultValue)
// 旧 3 参 (raw, min, max) 仍 work, 缺省 = min 行为 0 改 (跟 R158.54 1:1 平行).
// 4 参 overload: 不传 / 非数 / < min 返 defaultValue, > max 返 max. 跟 R158.50
// 范式 1:1 (clampInt 4 参已存在多个 service, 此处 0 引入新 pattern).
function clampInt(raw, min, max, defaultValue) {
  if (raw === undefined || raw === null || raw === '') {
    return defaultValue !== undefined ? defaultValue : min;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return defaultValue !== undefined ? defaultValue : min;
  if (n > max) return max;
  return n;
}