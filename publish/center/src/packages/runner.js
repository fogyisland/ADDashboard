// Agent-facing REST endpoints for the package system. Mounted at root in
// server.js (same pattern as agentRouter) so that auth wiring happens in
// the calling code, and these handlers focus on the package layer.
//
// Endpoints:
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

const STDOUT_PREVIEW_LIMIT = 2048;
const STDERR_PREVIEW_LIMIT = 2048;

export function packageRunner({ db, getLogger }) {
  const r = express.Router();

  // GET /api/agent/packages — agent pulls the list of enabled packages.
  // For each enabled row, the on-disk `collect.ps1` is base64-encoded so
  // the agent can ship it across platforms without binary-safe concerns.
  r.get('/api/agent/packages', async (req, res) => {
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
  r.get('/api/agent/packages/:name/script', async (req, res) => {
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
  // agentId comes from the agent token identity; we read it from req
  // (the agent-token middleware should populate `req.agentId`, but when
  // the middleware is bypassed in tests we fall back to a header so the
  // endpoint still works end-to-end).
  r.post('/api/agent/packages/report', async (req, res) => {
    const { runs } = req.body || {};
    if (!Array.isArray(runs)) {
      return res.status(400).json({ error: 'runs must be array' });
    }

    // Prefer req.agentId (set by agent-token middleware); fall back to
    // header for tests / older clients.
    const agentId = req.agentId || req.headers['x-agent-id'] || null;

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