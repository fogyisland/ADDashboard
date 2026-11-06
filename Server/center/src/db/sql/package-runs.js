// SQL helpers for the package_runs table.
//
// package_runs is an audit log: one row per package execution on an
// agent. There is no UNIQUE constraint — each run is a new row.
// `listRecent` is the only read query and supports filtering by agent
// and/or package name with a configurable LIMIT (default 20).
//
// `insert` returns the new row id. The mysql2 driver returns insertId
// on the OkPacket; the mssql driver returns a `rows[0].id` row from the
// SCOPE_IDENTITY() select appended after the INSERT (see the mssql
// driver wrapper). The caller reads either field.
//
// 2026-09-29 R154.5 — added `script_version` (VARCHAR(32) NULL). The
// centre runner captures package_scripts.version at the moment each
// package_runs row is recorded so the 包执行状态 view can show the
// actual version each row executed under (pre-fix only the per-card
// header showed the current centre version). Older rows stay NULL.
//
// 2026-09-30 R157.1 — added `recentRunExists(db, { agentId, packageName,
// startedAt })`. The /api/agent/packages/report envelope can carry up to
// ~1000 runs from a single flushReportQueue (see agent
// src/package-manager.js). When the agent is replaying its disk queue
// after a service restart or centre downtime, MANY of those runs are
// the same agent+package+started_at that the centre has already
// recorded (no UNIQUE constraint on package_runs). Without this guard,
// a single envelope could INSERT 1000+ duplicate rows + trigger 1000+
// ETL branches, drowning the MSSQL pool and pushing the centre into a
// 4 GB OOM loop (R157 root-cause analysis). The check is a 60-second
// fingerprint: if a row with the same (agent_id, package_name,
// started_at within 60s) already exists, runner.js skips the INSERT +
// metricstore ingest + post-hook ETL for that run, returning a
// `deduplicated: true` flag to the agent so the next flush doesn't
// keep replaying it. The 60s window is generous enough to absorb
// millisecond-level clock skew between agent and centre without
// masking legitimate retries (e.g. an agent that genuinely re-ran a
// package after 90s should NOT be deduped).

const INSERT_MYSQL = `INSERT INTO package_runs
  (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error, script_version, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// The mssql driver wrapper auto-appends `SELECT CAST(SCOPE_IDENTITY() AS bigint)
// AS id` after any INSERT (see center/src/db/drivers/mssql.js). The insertId
// field on the result object is what callers should consume.
//
// R158.47.3 (2026-10-07) — added `status` column. Pre-fix this INSERT path
// only wrote 9 columns (no status), so every package_runs row had
// status=NULL even on exit_code=0 success. The two sibling inline INSERT
// paths in cron-scheduler.js:202 and trigger-queue.js:156-158 already
// include status. UI /api/dashboard/packages-runs endpoint surfaces
// status for operator visibility — must be populated. Idempotent: backfill
// + new rows from this path now consistent.
const INSERT_MSSQL = `INSERT INTO package_runs
  (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error, script_version, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function buildListSql({ dialect, agentId, packageName, limit }) {
  // LIMIT is integer-only — we coerce at the JS layer because the mssql
  // driver does not support `LIMIT ?`. The mysql driver accepts both
  // `LIMIT <int>` and `LIMIT ?`.
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 1000));
  const where = [];
  const params = [];
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  if (packageName) { where.push('package_name = ?'); params.push(packageName); }
  // R158.87.6.1 (2026-10-12) — /packages-runs 过滤 member-server agent (预防性 ship).
  //   member-server 0 当前行 (R158.86.5 域隔离) 但未来开启 packages 时 (R158.72 ad_account_change
  //   之后) 必污染. 跟 /agents 页面 (R158.87.6) 同 precedent. NOT IN subquery + IS NOT NULL
  //   guard 防 mssql 经典 NULL bug (R158.86.5.1 lesson).
  where.push(`agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL)`);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // mysql uses LIMIT <n>; mssql uses TOP <n> (placed after SELECT).
  if (dialect === 'mssql') {
    const sql = `SELECT TOP ${safeLimit} * FROM package_runs ${whereClause} ORDER BY started_at DESC`;
    return { sql, params };
  }
  const sql = `SELECT * FROM package_runs ${whereClause} ORDER BY started_at DESC LIMIT ${safeLimit}`;
  return { sql, params };
}

export const packageRunsSql = {
  insert: { mysql: INSERT_MYSQL, mssql: INSERT_MSSQL }
  // listRecent is built dynamically per call (LIMIT/TOP is integer-only).
  // Use packageRuns.listRecent(db, opts) below.
};

export const packageRuns = {
  async insert(db, { agentId, packageName, startedAt, finishedAt, exitCode, stdoutPreview, stderrPreview, error, scriptVersion = null, status = null }) {
    const sql = db.dialect === 'mssql' ? INSERT_MSSQL : INSERT_MYSQL;
    const params = [
      agentId,
      packageName,
      startedAt,
      finishedAt ?? null,
      exitCode ?? null,
      stdoutPreview ?? null,
      stderrPreview ?? null,
      error ?? null,
      scriptVersion ?? null,
      // R158.47.3 (2026-10-07) — write status alongside exit_code so
      // /api/dashboard/packages-runs can show 'success'/'failed'/'running'
      // per row. Caller decides: success on exit_code=0 && !error,
      // failed on exit_code!=0 or error present, 'running' when finishedAt
      // is null. null falls through if caller doesn't supply.
      status
    ];
    const result = await db.execute(sql, params);
    // Both drivers surface the new id via `insertId` on the execute()
    // result object:
    //   mysql2 — OkPacket.insertId
    //   mssql  — populated from the SCOPE_IDENTITY() batch that the
    //            driver wrapper auto-appends (see drivers/mssql.js).
    if (result.insertId != null) return Number(result.insertId);
    return undefined;
  },

  async listRecent(db, { agentId, packageName, limit } = {}) {
    const { sql, params } = buildListSql({ dialect: db.dialect, agentId, packageName, limit });
    const { rows } = await db.execute(sql, params);
    return rows;
  },

  // R158.25 (2026-10-02) — UPDATE package_runs.stderr_preview AFTER all
  // post-hook ETL branches have run, so the audit row carries a
  // traceback `linear` line per hook (e.g. `[R158.25 ingest]
  // lockout.upserted=8/8 skipped=0 errors=0`). Why a second write?
  // The original INSERT at runner.js:546 happens BEFORE the metricstore
  // dispatch + every post-hook branch (lines 599-921). The ETL
  // outcomes are not yet known at INSERT time — we only know them
  // after a few hundred ms of async work. To avoid forcing a
  // complex multi-statement transactional construct, we do two
  // writes (INSERT then UPDATE) on the same id. UPDATE is best-effort:
  // if it throws, we do NOT fail the envelope (we already pushed
  // every run to result.processed; the audit row keeps its original
  // banner-only stderr_preview which is still informative).
  //
  // Bound parameters: id (NUMBER → bigint) + stderrPreview (NVARCHAR
  // length ≤ STDERR_PREVIEW_LIMIT 2KB). Both dialects use ? placeholders
  // so the driver wrapper handles @pN rewriting.
  async updateStderr(db, { id, stderrPreview }) {
    if (id == null) return null;
    const sqlText = 'UPDATE package_runs SET stderr_preview = ? WHERE id = ?';
    await db.execute(sqlText, [
      stderrPreview == null ? null : String(stderrPreview),
      id
    ]);
    return id;
  },

  // R158.17.6 (2026-10-01) -- summary24hByName. Used by the
  // /api/dashboard/packages-runs endpoint. Replaces a single
  // `listRecent(limit=200)` snapshot that was 100% consumed by
  // ad_partner_inbound_discover (288k rows / 24h across 35 agents,
  // 5-min cadence), leaving the other 9 packages with no rows in
  // the 200-row window. GROUP BY returns one row per package with
  // counts + last_run_at. Bound parameter is the 24h floor (Date),
  // NOT user-controlled so no injection surface.
  async summary24hByName(db, { since }) {
    const summarySql = db.sql?.packageRuns?.summary24hByName;
    if (typeof summarySql !== 'string') {
      throw new Error('packageRuns.summary24hByName SQL not registered');
    }
    const { rows } = await db.execute(summarySql, [since]);
    return rows;
  },

  // R158.99.3 (2026-10-13) -- MEMBER-side mirror of summary24hByName.
  // Uses the `db.sql.packageRuns.memberSummary24hByName` SQL registered
  // in db/sql.js (the IN-flipped sibling of summary24hByName, with
  // ad_member_heartbeat as the source-of-truth for "is a member-server").
  // Returns the same shape as summary24hByName so the member-side
  // /api/dashboard/member-packages-runs route can drop in as a
  // 1:1 replacement. Operator report 2026-10-13: "包执行状态为什么没有
  // 反馈到成员服务器l的包执行状态中?" — the route was using
  // summary24hByName (NOT IN), which excluded all member rows from
  // the projection. New helper flips to IN.
  async memberSummary24hByName(db, { since }) {
    const summarySql = db.sql?.packageRuns?.memberSummary24hByName;
    if (typeof summarySql !== 'string') {
      throw new Error('packageRuns.memberSummary24hByName SQL not registered');
    }
    const { rows } = await db.execute(summarySql, [since]);
    return rows;
  },

  // R158.17.6 (2026-10-01) -- recentByName. Replaces the per-package
  // slice from listRecent(limit=200). Handler calls this N times
  // (one per package, N typically 10) so each card gets up to 10
  // recent runs regardless of how busy any one package is. LIMIT/TOP
  // is integer-coerced at the JS layer (mysql LIMIT <int>, mssql
  // TOP <int>).
  //
  // R158.X+UI.since (2026-10-19) — 24h/7d/全部 window 透传 since. 修
  // 折线图 24h 切片不闭合的真因: 原 SQL 只 filter package_name + agent_id,
  // 0 控时间窗, 导致 24h 窗口的低频包 (e.g. ad_account_change 1/天) 在
  // limit=10 时, recent[] 撑到过去 7-10 天, X 轴 auto min/max 越过 24h
  // 边界. 1:1 平行 summary24hByName (sql.js:1686/4784) 的 WHERE started_at >= ?
  // 范式. 老 caller 路径 (无 since 入参) 0 破: since=null 时不加 AND 子句 +
  // 不 bind, 走原行为.
  async recentByName(db, { packageName, limit = 10, since = null }) {
    const safeLimit = Math.max(1, Math.min(1000, parseInt(limit, 10) || 10));
    // R158.87.6.1 (2026-10-12) — /packages-runs 过滤 member-server agent (预防性 ship).
    //   跟 buildListSql + summary24hByName 同 precedent (R158.86.5.1 NOT IN IS NOT NULL guard).
    const sinceClause = since != null ? ' AND started_at >= ?' : '';
    const recentSql = db.dialect === 'mssql'
      ? `SELECT TOP ${safeLimit} * FROM package_runs WHERE package_name = ?${sinceClause} AND agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) ORDER BY started_at DESC`
      : `SELECT * FROM package_runs WHERE package_name = ?${sinceClause} AND agent_id NOT IN (SELECT agent_id FROM ad_member_heartbeat WHERE agent_id IS NOT NULL) ORDER BY started_at DESC LIMIT ${safeLimit}`;
    const params = since != null ? [packageName, since] : [packageName];
    const { rows } = await db.execute(recentSql, params);
    return rows;
  },

  // 2026-10-20 perf — batched variant of recentByName. The handler used
  // to call recentByName in a for-loop (one query per package, N=10–14),
  // which meant /api/dashboard/packages-runs timeline mode did 14 serial
  // round-trips ≈ 1.6s. The factory returns a single CTE+ROW_NUMBER()
  // query that yields the same rows ordered (package_name, rn), letting
  // the handler populate the Map in one pass. Falls back to per-name
  // recentByName on any failure so a single bad package never 500s.
  async recentByNames(db, { names, limit = 10, since = null }) {
    if (!Array.isArray(names) || names.length === 0) {
      return new Map();
    }
    const factory = db.sql?.packageRuns?.recentByNames;
    if (typeof factory !== 'function') {
      // Soft-fallback to the old N round-trips if factory not registered.
      const out = new Map();
      for (const name of names) {
        try {
          const rows = await this.recentByName(db, { packageName: name, limit, since });
          out.set(name, rows || []);
        } catch { out.set(name, []); }
      }
      return out;
    }
    const { sql, params } = factory(names, limit, since);
    const { rows } = await db.execute(sql, params);
    const byName = new Map();
    for (const r of rows || []) {
      const k = r.package_name || r.PACKAGE_NAME;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(r);
    }
    return byName;
  },

  // 2026-10-20 perf — MEMBER-side batched mirror of recentByNames. Used
  //   by the /api/dashboard/member-packages-runs endpoint (member-side
  //   agent filter). Identical CTE/ROW_NUMBER shape; only the agent_id
  //   flip differs (IN vs NOT IN — see memberSummary24hByName).
  async memberRecentByNames(db, { names, limit = 10, since = null }) {
    if (!Array.isArray(names) || names.length === 0) {
      return new Map();
    }
    const factory = db.sql?.packageRuns?.memberRecentByNames;
    if (typeof factory !== 'function') {
      const out = new Map();
      for (const name of names) {
        try {
          const rows = await this.memberRecentByName(db, { packageName: name, limit, since });
          out.set(name, rows || []);
        } catch { out.set(name, []); }
      }
      return out;
    }
    const { sql, params } = factory(names, limit, since);
    const { rows } = await db.execute(sql, params);
    const byName = new Map();
    for (const r of rows || []) {
      const k = r.package_name || r.PACKAGE_NAME;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(r);
    }
    return byName;
  },

  // R158.99.3 (2026-10-13) — MEMBER-side mirror of recentByName. Same
  // IN vs NOT IN flip as memberSummary24hByName; uses the
  // db.sql.packageRuns.memberRecentByName SQL factory (mysql LIMIT
  // or mssql TOP, sanitised via Math.max/min). Operator report
  // 2026-10-13: member packages-runs endpoint returned 0 recent runs
  // because the route was calling recentByName (NOT IN) — the same
  // projection that already filtered out the rows. New sibling
  // excludes only AD rows.
  async memberRecentByName(db, { packageName, limit = 10, since = null }) {
    const recentSqlFactory = db.sql?.packageRuns?.memberRecentByName;
    if (typeof recentSqlFactory !== 'function') {
      throw new Error('packageRuns.memberRecentByName SQL not registered');
    }
    // R158.X+UI.since (2026-10-19) — member mirror of AD recentByName
    // since 透传. 修 /member-packages-runs 折线图 24h 同 bug.
    const recentSql = recentSqlFactory(limit, since);
    const params = since != null ? [packageName, since] : [packageName];
    const { rows } = await db.execute(recentSql, params);
    return rows;
  },

  // R157.1 (2026-09-30) — idempotency check for the /api/agent/packages/report
  // path. Returns true if a package_runs row already exists for this
  // (agent_id, package_name) with started_at within ±60s of `startedAt`.
  // The 60s window absorbs agent/centre clock skew without masking legitimate
  // retries. Both dialects use a single-parameter `started_at` parameter so
  // the driver wrapper's ? → @pN rewriting is the only translation needed.
  //
  // 2026-09-30 R157.X — MSSQL compatibility fix. R157.1 originally shipped
  // this with unconditional `LIMIT 1`, which MSSQL rejects with
  // "Incorrect syntax near 'LIMIT'". Because runner.js's per-run catch
  // (runner.js:844-846) only pushes to result.errors without logging,
  // every envelope silently failed its dedup step and the centre looked
  // healthy while DB stayed at zero rows from 14:20 onward. Now branch on
  // db.dialect: MSSQL uses `SELECT TOP 1` (T-SQL — TOP goes after SELECT
  // and before the column list, NOT at the end of the statement),
  // MySQL keeps `LIMIT 1`. Mirrors the `buildListSql` precedent at
  // lines 49-66 in this file and the documented R93.4 / R101 design
  // that driver-level LIMIT/TOP auto-rewrite is forbidden
  // (see db/sql.js:1388, 1871, 2335 etc.).
  async recentRunExists(db, { agentId, packageName, startedAt }) {
    // R157.9 — tightened dedup fingerprint (code review M12). Pre-fix
    // used a 60-second ±window on started_at, which silently dropped
    // legitimate re-runs of high-cadence packages (< 60s interval).
    // Post-fix: dedup on (agent_id, package_name, started_at_minute)
    // — same minute ⇒ same logical run. Two distinct runs in the
    // same minute by the same agent/package collide (rare in
    // practice; flag a soft warn at the runner layer). This is
    // stricter than the 60s window for short-cadence packages but
    // strictly better at capturing exact replays (same minute is the
    // right dedup granularity for cron-triggered runs which always
    // land on the minute boundary).
    //
    // Normalise to a Date — the centre's runner.js hands us a Date
    // already (line 372: new Date(run.startedAt)), but tests / direct
    // callers might pass an ISO string. SQL driver expects a Date.
    const started = startedAt instanceof Date ? startedAt : new Date(startedAt);
    if (isNaN(started.getTime())) return false;
    // Truncate to the minute floor. driver-side the BETWEEN comparison
    // works on both dialects (started_at is DATETIME/DATETIME2).
    const minuteFloor = new Date(
      started.getFullYear(), started.getMonth(), started.getDate(),
      started.getHours(), started.getMinutes(), 0, 0
    );
    const minuteCeil = new Date(minuteFloor.getTime() + 60_000);
    // 2026-09-30 R157.X — MSSQL uses `SELECT TOP 1` (T-SQL position rule:
    // TOP goes immediately after SELECT, before the column list, NOT at
    // the end of the statement). MySQL keeps `LIMIT 1` at the end.
    const probeSql = db?.dialect === 'mssql'
      ? `SELECT TOP 1 1 AS hit FROM package_runs
           WHERE agent_id = ? AND package_name = ?
             AND started_at >= ? AND started_at < ?
             AND status != 'pending_trigger'`
      : `SELECT 1 AS hit FROM package_runs
           WHERE agent_id = ? AND package_name = ?
             AND started_at >= ? AND started_at < ?
             AND status != 'pending_trigger'
           LIMIT 1`;
    const { rows } = await db.execute(probeSql, [agentId, packageName, minuteFloor, minuteCeil]);
    return Array.isArray(rows) && rows.length > 0;
  },

  // R158.Y (2026-10-16) — for the /admin/packages-schedule "上次触发完成"
  // column. Returns the most recent cron-driven trigger row's timestamp +
  // completion stats for the runs that landed in its minute window.
  //
  // Pairing model: cron writes a `pending_trigger` row at minute M
  // (agent_id='__cron__', status='pending_trigger'). Agents claim it on
  // their next heartbeat (≤60s), runOne, and INSERT real run rows in
  // the same minute M (started_at within [M, M+1)). This helper looks
  // up the latest trigger row per package, counts the real runs that
  // landed in the same minute window, and returns a small per-package
  // summary so the front-end can render "完成 34/34" pills.
  //
  // The 120-minute window bounds the lookup so a package that hasn't
  // been triggered in 2h returns null (front-end shows "—") instead of
  // surfacing a stale 5min-cadence cron row from 12 hours ago.
  //
  // @param {object} db
  // @param {string} packageName
  // @param {object} [opts]
  // @param {number} [opts.sinceMinutes=120]
  // @returns {Promise<{lastTriggeredAt: string, completion: {total, success, partial, failed, running}} | null>}
  async lastTriggeredRunsByName(db, packageName, { sinceMinutes = 120 } = {}) {
    if (typeof packageName !== 'string' || packageName.length === 0) return null;
    const since = new Date(Date.now() - sinceMinutes * 60_000);
    // Branch on dialect — same precedent as recentRunExists above
    // (T-SQL SELECT TOP 1 vs MySQL LIMIT 1 at the end of the statement).
    // R158.69 — "复用既有 helper" 1:1 范式.
    // R158.X.99.21 (2026-10-18) — 加 SELECT trigger_once 列, 让前端
    //   "上次触发完成" 列能区分最近一次 fire 是"trigger once" (单次触发
    //   按钮) 还是"schedule" (中心端 cron 拍). 1:1 平行 trigger-queue.js:82
    //   wire shape, 复用同 boolean 转换范式.
    const triggerSql = db?.dialect === 'mssql'
      ? `SELECT TOP 1 started_at, trigger_once
           FROM package_runs
           WHERE agent_id = '__cron__'
             AND status = 'pending_trigger'
             AND package_name = ?
             AND started_at >= ?
           ORDER BY started_at DESC`
      : `SELECT started_at, trigger_once
           FROM package_runs
           WHERE agent_id = '__cron__'
             AND status = 'pending_trigger'
             AND package_name = ?
             AND started_at >= ?
           ORDER BY started_at DESC
           LIMIT 1`;
    const { rows } = await db.execute(triggerSql, [packageName, since]);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const triggerRow = rows[0];
    const triggerAt = triggerRow.started_at instanceof Date
      ? triggerRow.started_at
      : new Date(triggerRow.started_at);
    if (isNaN(triggerAt.getTime())) return null;
    // Count real runs in the trigger's minute window. We count
    // EVERY non-pending_trigger status (success / partial / failed /
    // running / NULL) so a still-in-flight trigger shows "running"
    // and the operator can see fleet progress.
    const minuteFloor = new Date(
      triggerAt.getFullYear(), triggerAt.getMonth(), triggerAt.getDate(),
      triggerAt.getHours(), triggerAt.getMinutes(), 0, 0
    );
    // R158.X.99.9 (2026-10-17) — widen completion window from 1 minute
    //   to 30 minutes. Pre-fix, minuteCeil = minuteFloor + 60s. Trigger-
    //   now path ships agent.runTriggersNow on next heartbeat (≤ 60s
    //   latency for ad_partner_inbound_discover / 5min cadence packs)
    //   so 1 minute was sufficient. But ad_account_change (daily 2am,
    //   Jitter 0~30min per-DC, R158.72.x.5) measured 8 minute pickup
    //   latency from trigger-now POST to first success row on 2026-10-17
    //   — the agent-side setInterval(24h) hasn't fired yet so it relies
    //   on the heartbeat-trigger fan-out which R158.X.99.8 just re-
    //   enabled. Widening the window to 30min captures both the 5min
    //   cron cadence fan-out and the slower daily-cadence fan-out
    //   without pulling in the next cron tick (ad_partner_inbound_discover
    //   fires every 5min so 30min would pull in 6 ticks; but we only
    //   count rows with agent_id != '__cron__' so the cron rows are
    //   excluded automatically). 0 schema change / 0 wire shape change
    //  / 0 agent change / 0 endpoint change. Single-line 60_000 → 30*60_000.
    const minuteCeil = new Date(triggerAt.getTime() + 30 * 60_000);
    const countSql = db?.dialect === 'mssql'
      ? `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
          FROM package_runs
          WHERE package_name = ?
            AND agent_id != '__cron__'
            AND started_at >= ? AND started_at < ?`
      : `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
          FROM package_runs
          WHERE package_name = ?
            AND agent_id != '__cron__'
            AND started_at >= ? AND started_at < ?`;
    const { rows: counts } = await db.execute(countSql, [packageName, minuteFloor, minuteCeil]);
    const c = (counts && counts[0]) || {};
    return {
      lastTriggeredAt: triggerAt.toISOString(),
      // R158.X.99.21 (2026-10-18) — 操作员 directive "在包执行计划写上
      //   trigger once, 如果是 schedule 则写上 schedule". 让前端
      //   PackageScheduleView "上次触发完成" 列加 pill 区分两种 mode.
      //   1:1 平行 trigger-queue.js:82 (1 === 1 || true === true)
      //   双 wire shape 兼容.
      triggerOnce: triggerRow.trigger_once === 1 || triggerRow.trigger_once === true,
      completion: {
        total: Number(c.total ?? 0),
        success: Number(c.success ?? 0),
        partial: Number(c.partial ?? 0),
        failed: Number(c.failed ?? 0),
        running: Number(c.running ?? 0)
      }
    };
  }
};