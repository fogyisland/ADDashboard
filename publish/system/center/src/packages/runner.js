// Agent-facing REST endpoints for the package system.
//
// Endpoints (all require a valid x-agent-token via the agentMw middleware):
//   GET  /api/agent/packages              → list of enabled packages for
//                                            this agent (manifest + base64
//                                            script + baked
//                                            intervalSec/timeoutMs)
//   GET  /api/agent/packages/:name/script → base64 script for a single
//                                            enabled pkg
//   POST /api/agent/packages/report       → batch of run results; ingests
//                                            metrics and records runs in
//                                            package_runs
//
// R66 Task 8: data source switched from `installed_packages` +
// data/packages/<name>/<version>/collect.ps1 (on-disk) to a JOIN across
// `package_policies` + `package_scripts` (DB-only). The agent-side wire
// format is byte-identical — the same {packages:[{name,version,manifest,
// script,params}]} envelope, with policy.interval_sec/timeout_ms baked
// into manifest.agent.intervalSec / manifest.agent.timeoutMs.
//
// Errors: any thrown error collapses to 500 with
// `{ ok: false, error: { code, message } }`. The 400 path (non-array
// `runs`) and the 404 path (script or policy row missing / policy
// disabled) are explicit.

import express from 'express';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { packageRuns } from '../db/sql/package-runs.js';
import { metricstore } from './metricstore.js';

const STDOUT_PREVIEW_LIMIT = 2048;
const STDERR_PREVIEW_LIMIT = 2048;

// JOIN both tables. The agent only sees packages where policies.enabled = 1.
// The `?` placeholder is dialect-agnostic — the MSSQL driver wrapper
// rewrites it to @p1...@pn at execute() time. ORDER BY s.name keeps the
// wire shape stable across both drivers.
const JOIN_SELECT_MYSQL = `SELECT s.name, s.version, s.script_content, s.script_sha256,
  s.manifest_json, s.source, s.created_at, s.updated_at,
  p.interval_sec, p.timeout_ms, p.enabled, p.params_json, p.scope
FROM package_policies p
INNER JOIN package_scripts s ON s.name = p.name
WHERE p.enabled = 1
ORDER BY s.name`;

// Same SQL — `?` is dialect-portable via the mssql driver wrapper. Kept
// as a separate constant so the runner can dispatch by `db.dialect`
// (mirrors the established pattern across all R66 SQL helpers).
const JOIN_SELECT_MSSQL = JOIN_SELECT_MYSQL;

// bakeManifest — the single behavior change visible to the agent.
// The agent reads `pkg.manifest.agent.intervalSec` and
// `pkg.manifest.agent.timeoutMs` directly (see
// agent/src/package-manager.js `reschedule` and `runOnce`). The V0
// implementation produced these from the on-disk manifest + the
// `installed_packages` row's interval/timeout columns. R66 splits the
// row into `package_scripts` (manifest only) + `package_policies`
// (interval/timeout/enabled), so we now bake the policy values into the
// manifest here. The agent code does not change.
//
// Defensive (note 2): `baked.agent = baked.agent || {};` so a manifest
// without an `agent` block (custom user upload) still gets the policy
// values baked in, matching V0 behavior.
function bakeManifest(row) {
  // JSON.parse the manifest_json column if it's a string; the mysql2
  // driver may auto-parse it to an object on read (json column). The
  // mssql driver returns it as a JSON string. JSON.parse(JSON.stringify(...))
  // is a cheap deep clone so we don't mutate the hydrated row in place.
  const manifest = typeof row.manifest_json === 'string'
    ? JSON.parse(row.manifest_json)
    : row.manifest_json;
  const baked = JSON.parse(JSON.stringify(manifest));
  baked.agent = baked.agent || {};
  baked.agent.intervalSec = Number(row.interval_sec);
  baked.agent.timeoutMs = Number(row.timeout_ms);
  return baked;
}

// hydrateJoinRow — convert a raw JOIN row into the V0 agent envelope.
// All driver-specific quirks (mysql2 auto-parse, mssql JSON string)
// are normalized here so the rest of the runner deals with the same
// shape regardless of dialect.
function hydrateJoinRow(row) {
  const parseJson = (v) => v == null ? null
    : (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    name: row.name,
    version: row.version,
    script: Buffer.from(row.script_content, 'utf8').toString('base64'),
    manifest: bakeManifest(row),
    params: parseJson(row.params_json)
  };
}

// packageRunner — Express router factory. The caller wires the
// agent-token middleware (this factory does not build it internally any
// more — the V0 inline build coupled the runner to `config.agentToken`,
// which silently 503'd when the bundle lived in DB only).
//
// Required deps:
//   db       — db facade (must expose execute(query, params) → {rows})
//   agentMw  — pre-built agentToken middleware thunk
//   getLogger — () => pino-like logger (info/warn/error/debug) or null
//
// Optional: config (no longer read by the runner itself — kept out of
// the signature for clarity; the caller is free to ignore it).
export function packageRunner({ db, agentMw, getLogger }) {
  const r = express.Router();

  // GET /api/agent/packages — list of enabled packages with base64 script.
  // The JOIN filters on policies.enabled = 1 so the agent never sees a
  // disabled package. ORDER BY s.name gives a stable wire shape.
  r.get('/api/agent/packages', agentMw, async (req, res) => {
    try {
      const sql = db.dialect === 'mssql' ? JOIN_SELECT_MSSQL : JOIN_SELECT_MYSQL;
      const { rows } = await db.execute(sql, []);
      const packages = rows.map(hydrateJoinRow);
      res.json({ packages });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent packages list failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // GET /api/agent/packages/:name/script — fetch the script for a single
  // enabled package. Two SELECTs (note 3): single-name lookups are rare
  // and the policy `enabled` check is a single-row filter, so two simple
  // SELECTs are clearer than a one-off JOIN. Returns 404 when the
  // script row is missing, the policy row is missing, OR the policy
  // row is disabled — the agent must not be able to fetch a script
  // for a disabled package.
  r.get('/api/agent/packages/:name/script', agentMw, async (req, res) => {
    try {
      const scriptRow = await packageScripts.get(db, req.params.name);
      const policyRow = await packagePolicies.getByName(db, req.params.name);
      // `packagePolicies.getByName` hydrates `enabled` to a boolean (see
      // package-policies.js hydrate()). `!policyRow.enabled` works for
      // both the boolean (true/false) shape and the raw 1/0 (if the
      // helper ever changes its hydrate contract).
      if (!scriptRow || !policyRow || !policyRow.enabled) {
        return res.status(404).json({ error: 'not found' });
      }
      // Note 1 — `packageScripts.get()` returns `scriptContent`
      // (camelCase) per the hydrate at package-scripts.js:97. Do NOT
      // read `script_content` from the helper's output.
      const scriptB64 = Buffer.from(scriptRow.scriptContent, 'utf8').toString('base64');
      res.json({ name: scriptRow.name, version: scriptRow.version, script: scriptB64 });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent package script fetch failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/agent/packages/report — agent posts an array of run results.
  // Each `run` becomes one package_runs row, and the embedded `metrics`
  // payload flows through the metricstore so gauge / counter / timeseries /
  // status tables are updated.
  //
  // agentId comes from the x-agent-id header (the agent-token middleware
  // does not stamp req.agentId; we read the header directly here).
  r.post('/api/agent/packages/report', agentMw, async (req, res) => {
    const { runs } = req.body || {};
    if (!Array.isArray(runs)) {
      return res.status(400).json({ error: 'runs must be array' });
    }

    const agentId = req.headers['x-agent-id'] || null;
    // 2026-08-25 round-12 observability: log every package-report batch
    // with the run list and per-run exit code so the operator can see
    // whether the agent is actually executing the package scripts and
    // which ones are landing vs erroring. source='package-manager' is
    // stamped by agent/src/package-manager.js flushReportQueue.
    // round-13 fix: use the route's logger (matches the `getLogger ?
    // getLogger() : null` idiom used by the other handlers in this file)
    // instead of `req.log`, which is only populated when pino-http
    // middleware is wired — but server.js does not wire it, so every
    // agent request was throwing "Cannot read properties of undefined
    // (reading 'info')" before this line could return.
    const log = getLogger ? getLogger() : null;
    if (log) log.info({
      event: 'agent.packages.report',
      source: req.body?.source ?? 'unknown',
      agentId,
      runsCount: runs.length,
      packages: runs.map(r => `${r.packageName}:${r.exitCode ?? 'n/a'}`).slice(0, 20)
    }, 'agent packages report received');

    const result = { processed: 0, errors: [] };
    for (const run of runs) {
      try {
        // Note 1 (cont.): packageScripts.get() returns the hydrated row
        // with `manifest` (parsed JSON), `scriptContent`, etc. The
        // metricstore.ingestRun call passes `manifest` straight through.
        const scriptRow = await packageScripts.get(db, run.packageName);
        if (!scriptRow) {
          result.errors.push({
            packageName: run.packageName,
            error: 'package not installed'
          });
          continue;
        }
        // Record run (always, even on error — this is the audit trail).
        await packageRuns.insert(db, {
          agentId,
          packageName: run.packageName,
          startedAt: new Date(run.startedAt),
          finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
          exitCode: run.exitCode ?? null,
          stdoutPreview: run.metrics
            ? JSON.stringify(run.metrics).slice(0, STDOUT_PREVIEW_LIMIT)
            : null,
          stderrPreview: run.stderr ? run.stderr.slice(0, STDERR_PREVIEW_LIMIT) : null,
          error: run.error ?? null
        });
        // Ingest metrics only when the script ran cleanly. metricstore
        // reads `manifest.database.metricSchema` for v2 packages and
        // `manifest.metrics` for v1 — same contract as the V0 runner.
        if (run.metrics && !run.error) {
          await metricstore.ingestRun(db, {
            agentId,
            packageName: run.packageName,
            manifest: scriptRow.manifest,
            runs: [run]
          });
        }
        result.processed++;
      } catch (e) {
        result.errors.push({ packageName: run.packageName, error: e.message });
      }
    }
    res.json(result);
  });

  return r;
}
