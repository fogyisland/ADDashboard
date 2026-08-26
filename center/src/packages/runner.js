// Agent-facing REST endpoints for the package system.
//
// Endpoints (all require a valid x-agent-token):
//   GET  /api/agent/packages              → list of enabled packages for
//                                            this agent (manifest + base64
//                                            script)
//   GET  /api/agent/packages/:name/script → base64 script for a single
//                                            enabled pkg
//   POST /api/agent/packages/report       → batch of run results; ingests
//                                            metrics and records runs in
//                                            package_runs
//
// Errors: PkgError thrown by helper modules are caught and returned with
// the status code that `errors.js.statusFor` maps for the code; everything
// else collapses to 500 with `{ ok: false, error: { code, message } }`.

import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedPackages } from '../db/sql/installed-packages.js';
import { packageRuns } from '../db/sql/package-runs.js';
import { metricstore } from './metricstore.js';
import { PkgError } from './errors.js';
import { agentToken } from '../auth/agent-token.js';

const STDOUT_PREVIEW_LIMIT = 2048;
const STDERR_PREVIEW_LIMIT = 2048;

export function packageRunner({ db, getLogger, config }) {
  const r = express.Router();
  // Per-route agent-token middleware (same pattern as agentRouter in
  // src/routes). Express does not propagate per-route auth from a sibling
  // Router, so we wire it here directly.
  // I3: agentToken now resolves the bundle at request time via the db
  // facade (so a rotate+commit takes effect on the very next request).
  // Passing the old `config.agentToken` string would silently 503 every
  // request — Task 1 introduced this signature and Task 5 propagates it
  // to every caller. Tests pass `db` directly via packageRunner({ db }),
  // so use the same db the handler uses rather than getDb(). The logger is
  // resolved here (same `getLogger ? getLogger() : null` idiom the handlers
  // below use) so a previous-token match emits the spec §5 warn.
  const agentMw = agentToken({ db, logger: getLogger ? getLogger() : null });

  // GET /api/agent/packages — agent pulls the list of enabled packages.
  // For each enabled row, the on-disk `collect.ps1` is base64-encoded so
  // the agent can ship it across platforms without binary-safe concerns.
  r.get('/api/agent/packages', agentMw, async (req, res) => {
    try {
      const installed = await installedPackages.list(db, { enabledOnly: true });
      const packages = installed.map((p) => {
        const scriptPath = join(
          process.cwd(),
          'data',
          'packages',
          p.name,
          p.version,
          'collect.ps1'
        );
        const scriptB64 = readFileSync(scriptPath).toString('base64');
        return {
          name: p.name,
          version: p.version,
          manifest: p.manifest,
          script: scriptB64,
          params: p.params
        };
      });
      res.json({ packages });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent packages list failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // GET /api/agent/packages/:name/script — fetch the script for a single
  // enabled package. Returns 404 when the package is missing or disabled.
  r.get('/api/agent/packages/:name/script', agentMw, async (req, res) => {
    try {
      const pkg = await installedPackages.get(db, req.params.name);
      if (!pkg || !pkg.enabled) {
        return res.status(404).json({ error: 'not found' });
      }
      const scriptPath = join(
        process.cwd(),
        'data',
        'packages',
        pkg.name,
        pkg.version,
        'collect.ps1'
      );
      const scriptB64 = readFileSync(scriptPath).toString('base64');
      res.json({ name: pkg.name, version: pkg.version, script: scriptB64 });
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
    // round-13 fix: use the route's logger (matches the `getLogger ? getLogger() : null`
    // idiom used by the other handlers in this file) instead of `req.log`,
    // which is only populated when pino-http middleware is wired — but
    // server.js does not wire it, so every agent request was throwing
    // "Cannot read properties of undefined (reading 'info')" before this
    // line could return.
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
        const pkg = await installedPackages.get(db, run.packageName);
        if (!pkg) {
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
        // Ingest metrics only when the script ran cleanly.
        if (run.metrics && !run.error) {
          await metricstore.ingestRun(db, {
            agentId,
            packageName: run.packageName,
            manifest: pkg.manifest,
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