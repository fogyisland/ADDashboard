import { readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestJson } from './reporter.js';
import { runPackageScript } from './package-runner.js';

// Mirrors the center's package installer: pulls enabled packages, runs their
// collect.ps1 on a per-package interval, and posts results to the center. On
// HTTP failure the batch is persisted to disk; the on-disk queue is capped at
// MAX_QUEUE to prevent unbounded growth when center is offline for long
// periods.
const MAX_QUEUE = 1000;
const FLUSH_BATCH_THRESHOLD = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

export class PackageManager {
  constructor({
    agentId,
    agentVersion,
    centerBaseUrl,
    agentToken,
    dataDir,
    logger,
    scheduler,        // accepted for API parity with the brief, currently unused
    fetchJson,        // inject for tests; defaults to requestJson
    runScriptFn,      // inject for tests; defaults to runPackageScript
    powerShellPath = 'powershell.exe',
    syncIntervalMs = 5 * 60_000,
    flushIntervalMs = 5_000
  }) {
    this.agentId = agentId;
    this.agentVersion = agentVersion;
    this.centerBaseUrl = (centerBaseUrl || '').replace(/\/$/, '');
    this.agentToken = agentToken;
    this.dataDir = dataDir;
    this.logger = logger;
    this.powerShellPath = powerShellPath;
    this.cacheDir = join(dataDir, 'packages');
    this.queueFile = join(dataDir, 'report-queue.json');
    this.syncIntervalMs = syncIntervalMs;
    this.flushIntervalMs = flushIntervalMs;
    this.queue = [];        // persisted (failed flush)
    this.reportBatch = [];  // in-memory pending flush
    this.tasks = new Map(); // name -> { timer, intervalMs }
    this.packages = [];     // last synced package list (used by runAllNow)
    this._fetchJson = fetchJson || defaultFetchJson;
    this._runPackageScript = runScriptFn || runPackageScript;
    this._syncTimer = null;
    this._flushTimer = null;
    mkdirSync(this.cacheDir, { recursive: true });
    this.loadQueue();
  }

  // Pulls enabled packages from center. Writes manifest/script to disk and
  // (re)schedules per-package timers. Removes any locally cached package
  // that's no longer in the enabled set.
  async syncFromCenter() {
    const r = await this._fetchJson({
      method: 'GET',
      url: `${this.centerBaseUrl}/api/agent/packages`,
      headers: { 'X-Agent-Token': this.agentToken },
      timeoutMs: 30_000
    });
    if (!r.ok) {
      this.logger?.warn({ status: r.status, error: r.error }, 'package sync failed');
      return { ok: false, error: r.error || `HTTP ${r.status}` };
    }
    const packages = Array.isArray(r.data?.packages) ? r.data.packages : [];
    const enabledNames = new Set(packages.map(p => p.name));

    // Remove cache for packages no longer enabled
    for (const local of this.listLocal()) {
      if (!enabledNames.has(local)) this.removeCache(local);
    }

    // Write new packages
    for (const pkg of packages) {
      const dir = join(this.cacheDir, pkg.name, pkg.version);
      mkdirSync(dir, { recursive: true });
      const manifest = pkg.manifest || {};
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const scriptBytes = pkg.script ? Buffer.from(pkg.script, 'base64') : Buffer.alloc(0);
      writeFileSync(join(dir, 'collect.ps1'), scriptBytes);
      mkdirSync(join(this.cacheDir, pkg.name), { recursive: true });
      writeFileSync(
        join(this.cacheDir, pkg.name, 'current.json'),
        JSON.stringify({ version: pkg.version })
      );
    }

    this.reschedule(packages);
    // 2026-08-25 round-12 report-now fan-out: keep the latest synced list so
    // runAllNow() can re-run every package on operator demand (heartbeat
    // reportRequested=true). Without this, only the periodic timers + a
    // future sync would know what's installed; report-now has no other way
    // to enumerate packages. Storing the list here (rather than re-reading
    // disk) keeps the fan-out cheap and avoids stale-cache issues mid-sync.
    this.packages = packages;
    return { ok: true, count: packages.length };
  }

  listLocal() {
    if (!existsSync(this.cacheDir)) return [];
    return readdirSync(this.cacheDir).filter((f) => {
      try {
        return existsSync(join(this.cacheDir, f, 'current.json'));
      } catch {
        return false;
      }
    });
  }

  removeCache(name) {
    const dir = join(this.cacheDir, name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const t = this.tasks.get(name);
    if (t) {
      clearInterval(t.timer);
      this.tasks.delete(name);
    }
  }

  reschedule(packages) {
    // Clear existing timers
    for (const t of this.tasks.values()) clearInterval(t.timer);
    this.tasks.clear();

    for (const pkg of packages) {
      const intervalSec = pkg.manifest?.agent?.intervalSec;
      if (!intervalSec || intervalSec <= 0) {
        this.logger?.warn({ name: pkg.name }, 'package manifest missing agent.intervalSec; skipping schedule');
        continue;
      }
      const intervalMs = intervalSec * 1000;
      const timer = setInterval(() => {
        // Fire and forget — errors already captured in runOne
        this.runOne(pkg).catch((e) => {
          this.logger?.warn({ err: e.message, name: pkg.name }, 'runOne crashed');
        });
      }, intervalMs);
      // Don't keep the process alive solely for these timers
      if (typeof timer.unref === 'function') timer.unref();
      this.tasks.set(pkg.name, { timer, intervalMs });
    }
  }

  async runOne(pkg) {
    const scriptPath = join(this.cacheDir, pkg.name, pkg.version, 'collect.ps1');
    const params = pkg.params || {};
    const timeoutMs = pkg.manifest?.agent?.timeoutMs || DEFAULT_TIMEOUT_MS;
    const startedAt = new Date();
    const r = await this._runPackageScript({
      scriptPath,
      params,
      timeoutMs,
      logger: this.logger,
      powerShellPath: this.powerShellPath,
      // Allow tests to inject their own spawnFn via PackageManager ctor in a
      // future change; for now runPackageScript uses node:child_process.spawn
      // directly with no injection.
    });
    // 2026-08-25 round-12 report-now fan-out: emit a per-package local log
    // line so an operator can confirm "this package ran, posted at <ts>".
    // runOne() is also called from the periodic timer, not only runAllNow();
    // the same per-run log is useful there too. Format kept stable so any
    // future log-shipping tooling can match by `event=package.run`.
    this.logger?.info({
      event: 'package.run',
      package: pkg.name,
      version: pkg.version,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: r.exitCode,
      pushed: true,
      triggeredBy: this._triggeredBy || 'timer'
    }, 'package run complete');
    this.reportBatch.push({ packageName: pkg.name, ...r });
    if (this.reportBatch.length >= FLUSH_BATCH_THRESHOLD) {
      await this.flushReportQueue();
    }
  }

  // 2026-08-25 round-12 report-now fan-out: re-run every installed package
  // right now (operator clicked 回报 in the heartbeat monitor). Each package
  // is independent — runs in parallel via Promise.allSettled, each writes
  // its own batch entry + log line. No global "all done" gate; if one
  // package's PS script times out, the others still complete and post.
  //
  // Concurrency model: the periodic setInterval timers in `tasks` keep
  // firing on schedule. runAllNow() is additive — it does NOT cancel or
  // reschedule the timers, and it does NOT skip a periodic fire that's
  // already in flight. A click-and-timer race is fine: both paths push
  // results into the same reportBatch, which the periodic flush pulls
  // every 5s. Worst case = one extra run for the user (already idempotent
  // for the metricstore via single-row UPSERT + a per-cycle primary key).
  //
  // Returns: { count, results } — count = packages attempted,
  // results = Promise.allSettled raw output (for tests).
  async runAllNow({ triggeredBy = 'report-now' } = {}) {
    const pkgs = Array.isArray(this.packages) ? this.packages : [];
    if (pkgs.length === 0) {
      this.logger?.info({ event: 'package.runAllNow', count: 0, triggeredBy }, 'no packages to run');
      return { count: 0, results: [] };
    }
    // Tag every runOne() call so the per-package log lines identify which
    // fan-out fired them (operator-initiated vs periodic timer). Reset on
    // exit so the next periodic tick logs `triggeredBy=timer` again.
    const prevTag = this._triggeredBy;
    this._triggeredBy = triggeredBy;
    const startedAt = new Date();
    this.logger?.info({
      event: 'package.runAllNow',
      count: pkgs.length,
      startedAt: startedAt.toISOString(),
      packages: pkgs.map(p => p.name),
      triggeredBy
    }, 'package fan-out started');
    try {
      const results = await Promise.allSettled(pkgs.map(pkg => this.runOne(pkg)));
      const finishedAt = new Date();
      const summary = results.map((r, i) => ({
        package: pkgs[i].name,
        status: r.status,
        exitCode: r.status === 'fulfilled' ? r.value?.exitCode : null,
        error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null
      }));
      this.logger?.info({
        event: 'package.runAllNow',
        count: pkgs.length,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        summary,
        triggeredBy
      }, 'package fan-out complete');
      // Best-effort flush — even if the periodic 5s timer hasn't fired, get
      // the freshly-collected batch to center before the heartbeat reports
      // done. Failures here are absorbed by the existing flushReportQueue
      // path (persists to report-queue.json), so this is purely an
      // optimization, not a correctness gate.
      if (this.reportBatch.length > 0) {
        await this.flushReportQueue().catch((e) =>
          this.logger?.warn({ err: e.message, triggeredBy }, 'runAllNow flush crashed (queue persisted)')
        );
      }
      return { count: pkgs.length, results };
    } finally {
      this._triggeredBy = prevTag;
    }
  }

  async flushReportQueue() {
    const all = [...this.queue, ...this.reportBatch];
    if (all.length === 0) return { ok: true, sent: 0 };
    const r = await this._fetchJson({
      method: 'POST',
      url: `${this.centerBaseUrl}/api/agent/packages/report`,
      headers: { 'X-Agent-Token': this.agentToken },
      body: { source: 'package-manager', runs: all },
      timeoutMs: 30_000
    });
    if (r.ok) {
      this.queue = [];
      this.reportBatch = [];
      this.saveQueue();
      return { ok: true, sent: all.length };
    }
    // Failure: persist batch to disk. Keep the most recent MAX_QUEUE items
    // so the file doesn't grow unbounded when center is offline for long
    // periods.
    this.logger?.warn({ status: r.status, error: r.error }, 'report flush failed, queueing to disk');
    this.queue.push(...this.reportBatch);
    this.reportBatch = [];
    if (this.queue.length > MAX_QUEUE) this.queue = this.queue.slice(-MAX_QUEUE);
    this.saveQueue();
    return { ok: false, error: r.error || `HTTP ${r.status}` };
  }

  loadQueue() {
    if (existsSync(this.queueFile)) {
      try {
        const raw = readFileSync(this.queueFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.queue = parsed;
      } catch (e) {
        this.logger?.warn({ err: e.message }, 'failed to load report queue, starting empty');
        this.queue = [];
      }
    }
  }

  saveQueue() {
    try {
      writeFileSync(this.queueFile, JSON.stringify(this.queue));
    } catch (e) {
      this.logger?.warn({ err: e.message }, 'failed to save report queue');
    }
  }

  // Lifecycle helpers for the wiring code in agent.js
  start() {
    // Initial sync (fire-and-forget; errors already logged in syncFromCenter)
    this.syncFromCenter().catch((e) => {
      this.logger?.warn({ err: e.message }, 'initial package sync crashed');
    });
    this._syncTimer = setInterval(() => {
      this.syncFromCenter().catch((e) => {
        this.logger?.warn({ err: e.message }, 'periodic package sync crashed');
      });
    }, this.syncIntervalMs);
    if (typeof this._syncTimer.unref === 'function') this._syncTimer.unref();

    this._flushTimer = setInterval(() => {
      this.flushReportQueue().catch((e) => {
        this.logger?.warn({ err: e.message }, 'periodic flush crashed');
      });
    }, this.flushIntervalMs);
    if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  stop() {
    if (this._syncTimer) clearInterval(this._syncTimer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    for (const t of this.tasks.values()) clearInterval(t.timer);
    this.tasks.clear();
  }
}

async function defaultFetchJson({ method, url, headers, body, timeoutMs }) {
  return requestJson({ method, url, headers, body, timeoutMs });
}
