import { readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { requestJson, signedRequestJson, baseUrl, postPackagesReport } from './reporter.js';
import { runPackageScript } from './package-runner.js';
import { signRequest } from './lib/agent-identity.js';
// 2026-10-21 (security) — 中心下发的 pkg.name / pkg.version 直接参与
// cacheDir 下的路径拼接并最终被 spawn(powershell -File <path>) 执行,
// 必须挡住 ".." 逃逸。与 file-push 共用同一守卫(见 lib/path-safety.js 注释)。
import { isSafeSegment, safeJoin } from './lib/path-safety.js';

// Mirrors the center's package installer: pulls enabled packages, runs their
// collect.ps1 on a per-package interval, and posts results to the center. On
// HTTP failure the batch is persisted to disk; the on-disk queue is capped at
// MAX_QUEUE to prevent unbounded growth when center is offline for long
// periods.
const MAX_QUEUE = 1000;
const FLUSH_BATCH_THRESHOLD = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
// 2026-09-30 — R157.1 OOM 治理。flushReportQueue 之前把 `queue +
// reportBatch` 整个 merge 成 `runs: all` 一次性 POST。在 centre OOM 反复
// 重启期间,agent NSSM 重启 + flush 失败累积 → queue.db 写入 1000+ 个
// discover run → 重启后一次 flushReportQueue 把 1000+ run 推到 centre,
// centre runner.js 收到 1000+ runs 一次性插入 1000+ 行 package_runs +
// 1000+ 次 ETL,直接把 MSSQL pool 打满。修复: flushReportQueue 改为
// chunked — 每次最多 CHUNK_SIZE=50 个,失败只保留这 50 个 retry,剩余
// 保留在 queue 等下次心跳周期再分批推。CHUNK_SIZE=50 跟 R150 hub-resources
// 5min 桶 + dashboard 30s 轮询对齐,确保 agent → centre 的 envelope 体积
// 不会超过 centre 一次 request 的 ~5s 处理窗口(centre pool.max=25,
// 50 runs × 1 round-trip ≈ 2 round-trip × 25 connections = <2s)。
const CHUNK_SIZE = 50;

export class PackageManager {
  constructor({
    agentId,
    agentVersion,
    centerBaseUrl,
    agentToken,
    hostname,
    dataDir,
    logger,
    scheduler,        // accepted for API parity with the brief, currently unused
    fetchJson,        // inject for tests; defaults to requestJson (POST /api/agent/packages/report)
    signedFetchJson,  // inject for tests; defaults to signedRequestJson (GET /api/agent/packages)
    runScriptFn,      // inject for tests; defaults to runPackageScript
    // R93.5 — port-override knobs. Live getter takes precedence over
    // the snapshot so the 5min config refresh mutating
    // agent.js's `cachedPorts.reportPort` is observed without a
    // service restart. Both default to null (= no port override,
    // legacy behaviour: URL falls back to centerBaseUrl verbatim).
    reportPort = null,
    getReportPort = null,
    powerShellPath = 'powershell.exe',
    syncIntervalMs = 5 * 60_000,
    flushIntervalMs = 5_000
  }) {
    this.agentId = agentId;
    this.agentVersion = agentVersion;
    this.centerBaseUrl = (centerBaseUrl || '').replace(/\/$/, '');
    this.agentToken = agentToken;
    // 2026-09-22 S82 — hostname is stamped into the GET signature for
    // syncFromCenter. Defaults to agentId so existing call sites that
    // don't pass hostname keep working (matches the convention used by
    // reporter.js postHeartbeat/postReport where hostname === agentId).
    this.hostname = (typeof hostname === 'string' && hostname.length > 0) ? hostname : (agentId || '');
    this.dataDir = dataDir;
    this.logger = logger;
    this.powerShellPath = powerShellPath;
    this.cacheDir = join(dataDir, 'packages');
    this.queueFile = join(dataDir, 'report-queue.json');
    this.syncIntervalMs = syncIntervalMs;
    this.flushIntervalMs = flushIntervalMs;
    this.queue = [];        // persisted (failed flush)
    this.reportBatch = [];  // in-memory pending flush
    // R93.7 — value.pkg 持有当前 sync 看到的 pkg 引用。timer callback 不
    // 再 closure-capture pkg，而是从 this.tasks.get(name)?.pkg 取最新
    // 引用。下一次 sync 在 KEEP 路径下覆盖 existing.pkg 实现"版本刷新但
    // timer 不打断"。
    this.tasks = new Map(); // name -> { timer, intervalMs, pkg }
    this.packages = [];     // last synced package list (used by runAllNow)
    this._fetchJson = fetchJson || defaultFetchJson;
    this._signedFetchJson = signedFetchJson || defaultSignedFetchJson;
    // R93.5 — port-override backing store. _resolvePort() prefers the
    // live getter so a 5min config refresh mutating the parent
    // `cachedPorts.reportPort` is picked up without rebuilding
    // PackageManager.
    this._reportPortSnapshot = Number(reportPort) || null;
    this._getReportPort = typeof getReportPort === 'function' ? getReportPort : null;
    this._runPackageScript = runScriptFn || runPackageScript;
    this._syncTimer = null;
    this._flushTimer = null;
    // R158.87.6.5 (2026-10-12) — 显式保存 config 引用, syncFromCenter
    //   用 this.config.agentType 调中心端拼 ?agentType= query. 0.1.4 之前
    //   PackageManager 不持有 config, 只取 agentId/agentVersion/... 7
    //   字段. 加 this.config 是为了 0.1.5 syncFromCenter 能拿到 agentType.
    //   AD bundle 默认 'ad' (D:\dashboard\agent\src\config.js:31).
    //   noad bundle 默认 'non-ad' (D:\dashboard\noadagent\src\config.js:39),
    //   跟 noadagent 独立 source tree 1:1 (R158.86.6 修正 + R158.75 fork).
    //   防止 AD agent 错拿 member_* 包 (24h 1468 行污染真因).
    this.config = { agentType: 'ad' };  // default; config.js 注入覆盖
    mkdirSync(this.cacheDir, { recursive: true });
    this.loadQueue();
  }

  // R93.5 — resolve the report-port override. Live getter wins over
  // the ctor snapshot so config rotation propagates without a service
  // restart. JS is single-threaded; cachedPorts is a mutable object
  // whose only mutator (refreshAgentPorts) writes primitive numbers,
  // so a getter call mid-tick observes a consistent value.
  _resolvePort() {
    if (this._getReportPort) {
      const live = this._getReportPort();
      const n = Number(live);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return this._reportPortSnapshot;
  }

  // Pulls enabled packages from center. Writes manifest/script to disk and
  // (re)schedules per-package timers. Removes any locally cached package
  // that's no longer in the enabled set.
  async syncFromCenter() {
    // R93.5 — packages endpoint is mounted only on reportApp (8082);
    // web app (8080) 401s with `missing token` (no agentMw path there).
    // Resolve the port override via _resolvePort() and build the URL
    // through reporter.baseUrl so the port-strip behaviour stays
    // consistent with postHeartbeat / postReport.
    // 2026-09-22 S82 — use a signed GET so the centre's identity-binding
    // check passes after the 60s restart-grace window. _signedFetchJson
    // defaults to signedRequestJson; tests inject a stub to avoid real
    // HTTP.
    // R93.2 — flushReportQueue (POST /api/agent/packages/report) now also
    // uses _signedFetchJson for the same reason; previously the POST
    // path used _fetchJson with only X-Agent-Token, which 401'd after
    // the grace window because centre's HMAC triple couldn't bind.
    // R158.87.6.5 (2026-10-12) — L2 真修: agent 端 syncFromCenter URL 加
    //   ?agentType= query. 改前漏发 query → server 端 L1 (R158.87.6.4 修前
    //   + R158.87.6.5 修后) 都走 query null. 改前 AD agent 拿 13 包 (含 2
    //   member_*, 24h 错跑 1468 行); 改后 AD agent 显式发 ?agentType=ad
    //   → server L1 11 包 (R158.87.6.5 兜底) + 0 member 错跑.
    //   this.config.agentType 跟 D:\dashboard\agent\src\config.js:31
    //   对齐 (默认 'ad'). encodeURIComponent 防御未来 agentType 含特殊字符.
    const agentType = String(this.config?.agentType || 'ad').toLowerCase();
    const r = await this._signedFetchJson({
      method: 'GET',
      url: `${baseUrl({ centerUrl: this.centerBaseUrl, port: this._resolvePort() })}/api/agent/packages?agentType=${encodeURIComponent(agentType)}`,
      headers: {},
      agentToken: this.agentToken,
      hostname: this.hostname,
      agentId: this.agentId,
      timeoutMs: 30_000
    });
    if (!r.ok) {
      this.logger?.warn({ status: r.status, error: r.error }, 'package sync failed');
      return { ok: false, error: r.error || `HTTP ${r.status}` };
    }
    const rawPackages = Array.isArray(r.data?.packages) ? r.data.packages : [];

    // 2026-10-21 (security) — 在这里一次性过滤掉 name/version 非法的包。
    //
    // pkg.name / pkg.version 完全由中心下发(agent.js syncFromCenter),此前
    // 直接进 join(cacheDir, name, version, 'collect.ps1') 再 spawn
    // powershell -File <该路径>(runOne line ~439)。中心若下发
    // name="..\..\..\Windows\System32",agent 就会把脚本写到任意目录并
    // 以 SYSTEM 权限执行 —— 跟 run-member-script 的 Invoke-Expression 串成
    // 完整链。lib/path-safety.js 原先只服务 file-push,这里接上同一套守卫。
    //
    // 放在这一层(而不是每个拼接点)的原因:下游 removeCache / listLocal /
    // runOne / reschedule 全都吃这两个字段,入口过滤一次即全覆盖;
    // 单点校验则容易在新增调用点时漏掉。
    const packages = rawPackages.filter(p => {
      if (!p || !isSafeSegment(p?.name) || !isSafeSegment(p?.version)) {
        this.logger?.warn(
          { name: p?.name, version: p?.version },
          'package rejected: unsafe name/version (path traversal guard)'
        );
        return false;
      }
      return true;
    });
    if (packages.length !== rawPackages.length) {
      this.logger?.warn(
        { dropped: rawPackages.length - packages.length },
        'package sync dropped packages with unsafe name/version'
      );
    }
    const enabledNames = new Set(packages.map(p => p.name));

    // Remove cache for packages no longer enabled
    for (const local of this.listLocal()) {
      if (!enabledNames.has(local)) {
        // R158.17.1 (2026-10-01) — wrap removeCache in try/catch so a
        // transient EBUSY on Windows (PowerShell still holding a handle
        // to a child file under the cache directory) doesn't abort the
        // rest of sync. Pre-fix, KDLDLOFADSRV1 hit EBUSY every 5min on
        // ad_partner_outbound_discover/1.1.0 and the entire sync crashed
        // before re-writing any other package's collect.ps1. The cache
        // directory gets cleaned up on the next successful sync; in the
        // meantime the orphaned dir is harmless — collect.ps1 is no
        // longer being scheduled for that name.
        try {
          this.removeCache(local);
        } catch (e) {
          this.logger?.warn?.({
            event: 'package_sync.remove_cache_failed',
            name: local,
            err: e?.message || String(e),
            code: e?.code
          }, 'removeCache failed; continuing sync');
        }
      }
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

    // R93.11 — ad_partner_ports_probe override: the centre-published
    // script (R125) reads the peer list from /api/agent/replication-
    // partners, which derives peers from ad_replication_status. That
    // table is empty on freshly-installed agents or after a dashboard
    // DB reset, so the probe always emits peers:[] regardless of what
    // the agent actually sees on the wire. We rewrite the script on
    // disk after sync to use local Get-ADReplicationPartnerMetadata
    // — same cmdlet the real-agent's collect-replication.ps1:669
    // trusts. The override source-of-truth is a sibling file shipped
    // with the package (ad_partner_ports_probe.collect.ps1 in agent/
    // data), so a future operator upgrade to a fixed centre-published
    // script is one delete away.
    const probeOverrides = {
      'ad_partner_ports_probe': join(this.dataDir, 'ad_partner_ports_probe.collect.ps1')
    };
    for (const [pkgName, overridePath] of Object.entries(probeOverrides)) {
      if (!existsSync(overridePath)) continue;
      const pkg = packages.find((p) => p.name === pkgName);
      if (!pkg) continue;
      const dir = join(this.cacheDir, pkgName, pkg.version);
      writeFileSync(join(dir, 'collect.ps1'), readFileSync(overridePath));
      this.logger?.info({ pkg: pkgName, from: overridePath }, 'package script override applied (R93.11)');
    }

    this.reschedule(packages);
    // 2026-09-27 — diagnostic breadcrumb. Without this line, a 200 sync that
    // fails to install timers (e.g. setInterval swallowed, broken pkg
    // iteration, wrong `this.tasks` reference) leaves no trace. Pair with
    // PackageManager.reschedule debug logs to confirm the timer map.
    this.logger?.info({ count: packages.length, names: packages.map(p => p.name) }, 'PackageManager.syncFromCenter: reschedule invoked');
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
    // 纵深防御:本函数会 rmSync({recursive:true}) 删整棵目录树,逃逸后果
    // 比读文件严重得多(中心下发 name="..\..\.." 即可删 cacheDir 之外任意
    // 目录)。safeJoin 抛错时直接返回,不做任何删除。
    let dir;
    try {
      dir = safeJoin(this.cacheDir, name);
    } catch (err) {
      this.logger?.warn({ name, error: err.message }, 'removeCache skipped: unsafe package name');
      return;
    }
    if (existsSync(dir)) {
      // R158.17.1 (2026-10-01) — Windows NTFS EBUSY hardening. On
      // Windows, rmSync(..., force:true) throws EBUSY when a child
      // collect.ps1 (or its spawned powershell.exe) still holds a
      // handle to a file in the cache directory. KDLDLOFADSRV1 hit
      // this every 5min on ad_partner_outbound_discover/1.1.0 — the
      // directory was previously enabled, the agent bundle is pre-R155
      // so it still references it, and a recent sync's PowerShell
      // process leaked an open handle. Sync aborts on EBUSY, which
      // means the agent never re-installs / writes the cache for any
      // package — including the live ones — until the operator restarts
      // the agent. Retry with a short backoff (3 attempts × 250 ms),
      // then fall through to a best-effort cleanup so the next sync
      // has a clean slate even if the handle is genuinely stuck.
      const { execFileSync } = require('node:child_process');
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) {
            // Brief pause + retry. 250ms × 2 retries covers the typical
            // "PowerShell exit + handle close" window on Windows.
            const ms = 250 * attempt;
            const busySleepUntil = Date.now() + ms;
            while (Date.now() < busySleepUntil) { /* spin */ }
          }
        }
      }
      if (lastErr) {
        this.logger?.warn?.({
          err: lastErr.message, name, dir, code: lastErr.code
        }, 'removeCache: rmSync failed after retries; falling back to per-entry unlink');
        // Best-effort fallback: walk the cache dir and unlink each file,
        // then rmdir the empty subtrees. Some handles may still leak
        // (then the agent retries next sync), but the most common
        // case (collect.ps1 closed, only the .ps1 file lingering
        // because of an ETW trace handle) clears here.
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const sub = join(dir, entry.name);
            try {
              rmSync(sub, { recursive: true, force: true });
            } catch (e2) {
              this.logger?.warn?.({ err: e2.message, name, sub, code: e2.code },
                                      'removeCache: per-entry unlink failed; will retry next sync');
            }
          }
          // Final rmdir of the now-empty package directory.
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        } catch (e3) {
          this.logger?.error?.({ err: e3.message, name, dir, code: e3.code },
                                       'removeCache: per-entry fallback failed; package dir still present');
        }
      }
    }
    const t = this.tasks.get(name);
    if (t) {
      clearInterval(t.timer);
      this.tasks.delete(name);
    }
  }

  reschedule(packages) {
    // 2026-09-27 — diagnostic breadcrumb (保留). See R93.7 below for
    // the timer-preservation semantics change.
    this.logger?.debug({ count: packages.length }, 'PackageManager.reschedule: entry');

    // 2026-09-27 R93.7 — FIX: previously this method unconditionally
    // clearInterval'd every timer and setInterval'd new ones every time
    // syncFromCenter fired (every 5min). For packages with interval >
    // syncInterval, the timer was reset to 0 before it could fire —
    // ad_lockout_list (900s) NEVER
    // ran in 1.5h of production. The fix is set-difference: keep timers
    // whose (name, intervalMs) is unchanged, only churn the add/update/
    // remove deltas.
    //
    // R158.X.99.13 (2026-10-18) — 真因闭合. 真因链 (R158.X.99.10):
    //   中心端把 aac/aam package_policies.interval_sec 从 3600 改成 0 (跟
    //   cron_expr='0 2 * * *' daily 2am 范式配对, R158.72.x.13 锁). 老
    //   `if (!intervalSec) continue` 范式理论上 0 setInterval, 但 fleet
    //   0.1.7 binary (跟 git source 不同步, R158.69.3 锁 "永远不自动升级")
    //   还在跑老 setInterval(60_000) = 1min 1 拍 残留. 实测 10-17 18:00~18:30
    //   30 分钟内 aac 跑 1033 次 / aam 跑 1032 次 (R158.X.99.10 真因 5 步链
    //   验, 1:1 平行 R158.Y.12). fix: skip 时主动 `removeCache(pkg.name)`
    //   把老 timer 残留清掉 (跟 line 308-313 setInterval clearInterval +
    //   tasks.delete 范式 1:1 平行, 但走 pkg name 不走 task name).
    //   0 改 R93.7 set-difference 主路径. 0 改 R158.60.10 + R158.72.x.11 锁守.
    //   必 1h+24h+72h probe ≥80% cadence 收敛 (R158.86).
    //
    // Build the desired set first so we can compute diffs.
    const desired = [];
    for (const pkg of packages) {
      const intervalSec = pkg.manifest?.agent?.intervalSec;
      const cronExpr = pkg.manifest?.agent?.cronExpr;
      if (!intervalSec || intervalSec <= 0) {
        // R158.X.99.13 (2026-10-18) — 真闭合: skip 时主动 removeCache 清
        // 老 timer 残留 (line 308-313 removeCache 范式 1:1 平行). cronExpr
        // 非空场景 = R158.72.x.13 daily 2am 范式, agent 端 0.1.7 binary
        // 没 cron 解析器, 这种场景必须 0 setInterval, 主动 removeCache.
        this.logger?.warn({
          name: pkg.name, intervalSec, cronExpr: cronExpr || null
        }, 'package manifest missing/zero agent.intervalSec; removing any stale timer (R158.X.99.13)');
        try {
          this.removeCache(pkg.name);
        } catch (e) {
          this.logger?.warn?.({ err: e?.message, name: pkg.name, code: e?.code },
            'removeCache during reschedule skip failed; continuing');
        }
        continue;
      }
      desired.push({ name: pkg.name, intervalMs: intervalSec * 1000, pkg });
    }

    // 1) REMOVE: tasks whose name no longer appears in `desired`.
    //    Reuse removeCache() so disk + timer are both cleaned. This is
    //    defence-in-depth on top of syncFromCenter's pre-clear (line 122-124);
    //    if reschedule is called from any other caller (tests, future), the
    //    orphan-cleanup contract still holds. removeCache is idempotent
    //    (existsSync + if(t)) so a second pass is a no-op when syncFromCenter
    //    already cleared.
    let removed = 0;
    const incomingNames = new Set(desired.map((d) => d.name));
    for (const oldName of [...this.tasks.keys()]) {
      if (!incomingNames.has(oldName)) {
        this.removeCache(oldName);
        removed++;
      }
    }

    // 2/3) KEEP / UPDATE / ADD — for each desired entry, reuse the timer
    //      when name + intervalMs both match. Mutating `existing.pkg`
    //      (pointer swap) keeps the callback's reference fresh so a
    //      version bump in the next sync is observed without restarting
    //      the timer.
    let kept = 0, rescheduled = 0, added = 0;
    for (const d of desired) {
      const existing = this.tasks.get(d.name);
      if (existing && existing.intervalMs === d.intervalMs) {
        // KEEP: timer stays alive. Just refresh pkg ref so the callback
        // picks up version/params changes on the next tick.
        existing.pkg = d.pkg;
        kept++;
        continue;
      }
      if (existing) {
        // UPDATE: intervalSec changed (e.g. operator retuned schedule).
        // Old timer must die so the new intervalMs takes effect from now.
        clearInterval(existing.timer);
        rescheduled++;
      } else {
        added++;
      }
      const timer = setInterval(() => {
        // Pull pkg from this.tasks (not closure) so a later sync's pkg
        // swap is honoured by the next tick. `?.pkg ?? d.pkg` covers the
        // theoretical case where the entry was deleted between scheduling
        // and firing — fall back to the captured desired entry.
        const cur = this.tasks.get(d.name);
        const pkgToRun = cur?.pkg ?? d.pkg;
        this.runOne(pkgToRun).catch((e) => {
          this.logger?.warn({ err: e.message, name: d.name }, 'runOne crashed');
        });
      }, d.intervalMs);
      this.tasks.set(d.name, { timer, intervalMs: d.intervalMs, pkg: d.pkg });
      this.logger?.debug({
        name: d.name,
        intervalMs: d.intervalMs,
        action: existing ? 'rescheduled' : 'added'
      }, 'package scheduled');
    }

    this.logger?.debug(
      { kept, rescheduled, added, removed, total: this.tasks.size },
      'PackageManager.reschedule: done'
    );
  }

  async runOne(pkg, opts = {}) {
    // R158.72.x.12 B' (2026-10-17) — triggerOnce wire 真实现. opts.onceOnly
    //   = true 时跑完 1 次 主动 clearInterval 包对应 timer (跟 R158.60.10
    //   intervalSec<=0 skip idiom + removeCache line 308-312 范式 1:1
    //   平行, 走"clearInterval + 不启 setInterval" 同一动作但触发条件
    //   不同 — 一个由 manifest.agent.intervalSec 决定 (R158.60.10), 一个
    //   由 wire t.triggerOnce 决定 (R158.72.x.12 B')). 0 改 reschedule
    //   主路径 (R158.60.10 + R158.72.x.11 锁守).
    const onceOnly = opts.onceOnly === true;
    // 纵深防御:同步入口(syncFromCenter)已过滤掉非法 name/version,这里在
    // 真正的执行点再挡一次 —— 本函数是 spawn(powershell -File <scriptPath>)
    // 的唯一出处,万一将来有别的调用方绕过入口过滤,也不至于拼出逃逸路径。
    let scriptPath;
    try {
      scriptPath = safeJoin(this.cacheDir, pkg.name, pkg.version, 'collect.ps1');
    } catch (err) {
      this.logger?.warn(
        { name: pkg?.name, version: pkg?.version, error: err.message },
        'runOne aborted: unsafe package path'
      );
      return { ok: false, error: `unsafe package path: ${err.message}` };
    }
    const params = pkg.params || {};
    const timeoutMs = pkg.manifest?.agent?.timeoutMs || DEFAULT_TIMEOUT_MS;
    const startedAt = new Date();
    // R158.11.2 — surface the on-disk script path + sha16 so the centre
    // can see *which* cache file the agent actually executed (instead of
    // blindly stamping package_scripts.version into package_runs.script_version
    // even when the agent cache holds an old c49a9969 fallback). The
    // pre-fix code path only logged this in the agent's local logger;
    // the centre-side package_runs row never reflected it, so a fleet-
    // wide 1.1.1 rollout looked "successful" in the UI even though half
    // the agents were still running 1.0.0 fallback copies. We attach
    // scriptPath + scriptSha256 to the envelope; the centre runner
    // promotes them into package_runs fields so operators can grep for
    // sha mismatches between the row's script_version (centre's view)
    // and the agent-reported scriptSha256 (cache's reality).
    let scriptSha256 = null;
    let scriptSize = null;
    try {
      if (existsSync(scriptPath)) {
        const buf = readFileSync(scriptPath);
        scriptSha256 = createHash('sha256').update(buf).digest('hex');
        scriptSize = statSync(scriptPath).size;
      }
    } catch (e) {
      this.logger?.warn({ err: e.message, scriptPath }, 'runOne: failed to hash script');
    }
    // 2026-09-27 — diagnostic: confirms the setInterval callback actually
    // fires (vs being silently dropped by libuv). Helps separate "timer
    // never schedules" from "timer schedules but runOne throws before
    // hitting the script". Remove once stable.
    this.logger?.info({ event: 'package.runOne.entry', name: pkg.name, version: pkg.version, scriptPath, timeoutMs }, 'runOne entered');
    const r = await this._runPackageScript({
      scriptPath,
      params,
      timeoutMs,
      logger: this.logger,
      powerShellPath: this.powerShellPath,
      // 2026-09-28 R93.9 — package-manager now computes the HMAC signature
      // the centre's agentMw middleware requires and injects it as
      // AGENT_AUTH_SIGNATURE. collect.ps1 reads $env:AGENT_AUTH_SIGNATURE
      // verbatim (R125 authoritative version — linter repeatedly reverts
      // edits to it) and sets X-Agent-Signature on its outgoing GET. The
      // message is `${hostname}:${agentId}:` (empty body for GET, matches
      // signRequest's `body == null ? ''` branch). Without this env var,
      // /api/agent/ports and /api/agent/replication-partners return 401
      // and collect.ps1 silently emits peers=[].
      // 2026-09-28 R93.10 — collect.ps1's GETs hit /api/agent/ports and
      // /api/agent/replication-partners, both mounted only on the heartbeat
      // app (port 8081, see port-config-fetcher.js:13-14). appsettings.json's
      // centerUrl points at the web app (8080) for /config.json; using it
      // verbatim returns 404. Strip the trailing :digits and substitute
      // 8081. If the operator's centerUrl already has a non-default port
      // (single-app deploy) the override target is still "the heartbeat
      // app" — the operator configured the host and we trust it.
      env: {
        CENTER_URL: this.centerBaseUrl.replace(/:\d+$/, '') + ':8081',
        // R158.15 (2026-10-01) — collect.ps1 读 $env:DASHBOARD_CENTER_PORT 解析
        // 心跳端口 (默认 8081). 不注入 → PowerShell 展开为 $null → centre
        // endpoint 调用 silently no-op → metrics.probes=[] 空跑 15min 周期.
        // 从 this.centerBaseUrl 动态解析尾端口, 不在 env 写死.
        DASHBOARD_CENTER_PORT: (() => {
          const m = String(this.centerBaseUrl || '').match(/:(\d+)$/);
          if (m) return m[1];
          // 单 app deploy (heartbeat 跟 web 同端口): 默认 8081, 但 fallback 到
          // '8080' 让 collect.ps1 走 web 路径 (注: web 8080 不 mount agent-facing
          // endpoint, 仍 404; 真实场景必须 heartbeat 8081 才行).
          return '8081';
        })(),
        AGENT_AUTH_TOKEN: this.agentToken,
        AGENT_HOSTNAME: this.hostname,
        AGENT_AGENT_ID: this.agentId,
        AGENT_AUTH_SIGNATURE: signRequest({
          hostname: this.hostname,
          agentId: this.agentId,
          body: null,
          token: this.agentToken
        })
      }
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
    this.reportBatch.push({ packageName: pkg.name, scriptPath, scriptSha256, scriptSize, ...r });
    if (this.reportBatch.length >= FLUSH_BATCH_THRESHOLD) {
      await this.flushReportQueue();
    }
    // R158.72.x.12 B' (2026-10-17) — triggerOnce=true 跑完 1 次 主动
    //   clearInterval 包对应 timer, 防止 5min cadence 包被 cron 兜底
    //   路径再启 setInterval (跟 removeCache line 308-312 范式 1:1 平行).
    //   "1 click 1 跑 0 启 setInterval" 注释此前是真, 代码这次真实现.
    if (onceOnly) {
      const t = this.tasks.get(pkg.name);
      if (t) {
        clearInterval(t.timer);
        this.tasks.delete(pkg.name);
        this.logger?.info({
          event: 'package.runOne.triggerOnce',
          name: pkg.name,
          version: pkg.version,
          action: 'clearInterval',
          reason: 'wire t.triggerOnce=true — 1 click 1 跑 0 启 setInterval'
        }, 'triggerOnce: timer cleared, package removed from scheduler');
      } else {
        // Reschedule 0 entry (R158.60.10 intervalSec<=0 skip 范式, 跟
        //   cronExpr='0 2 * * *' + R158.72.x.11 self-interval anchor 范式
        //   1:1 平行). wire 仍标 triggerOnce=true 即可, 0 启 timer.
        this.logger?.info({
          event: 'package.runOne.triggerOnce',
          name: pkg.name,
          version: pkg.version,
          action: 'noop',
          reason: 'no scheduled timer (R158.60.10 on-demand skip / R158.72.x.13 cronExpr daily 2:00 / 中心端 cron 兜底) — 0 启 setInterval'
        }, 'triggerOnce: no scheduled timer to clear (1 跑 0 启 setInterval by-design)');
      }
    }
    // 2026-09-27 R93.8 — return r so callers (runAllNow via allSettled,
    // and the manual-trigger script) can read metrics/stdout. Previously
    // the implicit `return undefined` made trigger-all-packages-once.js's
    // `r.value?.metrics` always undefined, blocking env-injection verification.
    return r;
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

  // R158 (2026-09-30) — pending-trigger fan-out. Heartbeat callback
  // invokes this with the `packagesTriggers` array the centre shipped
  // in its response (≤ 5 entries per heartbeat, see services/trigger-
  // queue.js DEFAULT_LIMIT). We run ONLY the packages named — never
  // the full set — to avoid a 5x run amplification when the cron
  // triggers happen to overlap with a click-triggered package.
  //
  // `triggeredBy` is stamped onto the per-run log so the operator
  // dashboard can tell cron-triggered (every 5 min) apart from
  // operator-triggered (POST /api/admin/packages/:name/trigger-now)
  // apart from interval-driven (`timer`). Default is 'heartbeat-trigger'
  // to disambiguate from the existing 'report-now' / 'timer' tokens.
  //
  // Idempotency: a duplicate trigger (e.g. centre replay) re-runs the
  // same package again. Centre's runner.js dedups via
  // recentRunExists / M12 minute-floor, so the agent can be dumb here
  // and just run what's asked. This matches the runAllNow contract
  // (run is best-effort, dedup is server-side).
  //
  // Returns: { count, results, skipped } — count = attempted (incl.
  // skipped), results = Promise.allSettled raw output, skipped = names
  // the agent doesn't have installed (caller may want to log).
  async runTriggersNow(triggers, { triggeredBy = 'heartbeat-trigger' } = {}) {
    const list = Array.isArray(triggers) ? triggers : [];
    if (list.length === 0) {
      return { count: 0, results: [], skipped: [] };
    }
    const known = new Map((this.packages || []).map((p) => [p.name, p]));
    const targets = [];
    const skipped = [];
    for (const t of list) {
      const name = t && (t.packageName || t.name);
      if (!name) continue;
      const local = known.get(name);
      if (!local) {
        skipped.push({ name, reason: 'not_installed' });
        continue;
      }
      // R158.72.x.12 B' (2026-10-17) — wire t.triggerOnce 1:1 平行
      //   center 端 trigger-queue.js:74-82 rows.map 加的 triggerOnce
      //   字段. triggerOnce=true 1 click 1 跑 0 启 setInterval (跟
      //   R158.60.10 intervalSec<=0 skip idiom 1:1 平行). 老 wire
      //   (无 triggerOnce 字段) 默认 false, 0 改老路径.
      targets.push({ pkg: local, onceOnly: t.triggerOnce === true });
    }
    const prevTag = this._triggeredBy;
    this._triggeredBy = triggeredBy;
    const startedAt = new Date();
    this.logger?.info({
      event: 'package.runTriggersNow',
      count: targets.length,
      skipped: skipped.length,
      startedAt: startedAt.toISOString(),
      triggeredBy,
      requested: list.map((t) => t.packageName || t.name)
    }, 'trigger fan-out started');
    try {
      const results = await Promise.allSettled(targets.map((t) => this.runOne(t.pkg, { onceOnly: t.onceOnly })));
      const finishedAt = new Date();
      const summary = results.map((r, i) => ({
        // R158.72.x.12 B' (2026-10-17) — targets 元组 {pkg, onceOnly},
        //   走 targets[i].pkg.name 拿包名 (跟 line 671 list.map 平级).
        package: targets[i].pkg.name,
        status: r.status,
        exitCode: r.status === 'fulfilled' ? r.value?.exitCode : null,
        error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null
      }));
      this.logger?.info({
        event: 'package.runTriggersNow',
        count: targets.length,
        skipped: skipped.length,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        summary,
        triggeredBy
      }, 'trigger fan-out complete');
      if (this.reportBatch.length > 0) {
        await this.flushReportQueue().catch((e) =>
          this.logger?.warn({ err: e.message, triggeredBy }, 'runTriggersNow flush crashed (queue persisted)')
        );
      }
      return { count: targets.length + skipped.length, results, skipped };
    } finally {
      this._triggeredBy = prevTag;
    }
  }

  async flushReportQueue() {
    // R157.1 (2026-09-30) — chunked flush. Pre-fix merged `queue +
    // reportBatch` into a single `runs: all` array and POSTed in one
    // envelope. During centre OOM storms, queue.db accumulates 1000+
    // runs; after restart the first flushReportQueue dumps all of them
    // at once and the centre's runner.js walks through 1000+ INSERTs +
    // 1000+ ETL calls in a single handler — kills the MSSQL pool.
    // New shape: drain in CHUNK_SIZE slices. Each successful chunk
    // removes that slice from the front of the merged queue; each
    // failed chunk leaves its items at the front of `this.queue` (next
    // flush retry) and the remainder back in `this.reportBatch`.
    const merged = [...this.queue, ...this.reportBatch];
    if (merged.length === 0) return { ok: true, sent: 0 };

    // R93.5 — delegate to reporter.postPackagesReport so the URL gets
    // the same baseUrl({...}) treatment as syncFromCenter (lands on
    // reportApp 8082, not webApp 8080).
    // R93.2 — _signedFetchJson identity-binding (HMAC triple), per the
    // pre-fix 401 'identity mismatch' rationale.
    let totalSent = 0;
    let offset = 0;
    let lastError = null;
    while (offset < merged.length) {
      const chunk = merged.slice(offset, offset + CHUNK_SIZE);
      const r = await postPackagesReport({
        centerUrl: this.centerBaseUrl,
        agentToken: this.agentToken,
        port: this._resolvePort(),
        runs: chunk,
        hostname: this.hostname,
        agentId: this.agentId
      });
      if (!r.ok) {
        // Failure — only put THAT chunk back at the front of the
        // persisted queue, leave the remaining chunks (still in
        // reportBatch) alone so the next heartbeat retries the same
        // chunk first instead of skipping ahead. This bounds worst-case
        // queue growth: failed chunk returns, success chunk removes.
        lastError = r;
        this.logger?.warn({
          status: r.status,
          error: r.error,
          chunkSize: chunk.length,
          chunkOffset: offset,
          totalPending: merged.length - offset
        }, 'report flush chunk failed, will retry');
        break;
      }
      totalSent += chunk.length;
      offset += chunk.length;
    }

    // Splice the successfully-sent prefix out of merged:
    //   - this.queue came first, then this.reportBatch.
    //   - consumed prefix length = offset.
    if (offset >= this.queue.length) {
      // Consumed all of this.queue plus some of this.reportBatch.
      const fromBatch = offset - this.queue.length;
      this.queue = [];
      this.reportBatch = this.reportBatch.slice(fromBatch);
    } else if (offset > 0) {
      // Consumed only a prefix of this.queue (failed before draining it).
      this.queue = this.queue.slice(offset);
    }
    if (this.queue.length > MAX_QUEUE) this.queue = this.queue.slice(-MAX_QUEUE);
    this.saveQueue();
    if (lastError) {
      return { ok: false, error: lastError.error || `HTTP ${lastError.status}`, sent: totalSent };
    }
    return { ok: true, sent: totalSent };
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
    // 2026-09-27 — R93.6: removed `this._syncTimer.unref()`. See comment
    // on the per-package timer above for the libuv starvation root cause.
    // NSSM keeps the process alive; the unref was unnecessary AND harmful.

    this._flushTimer = setInterval(() => {
      this.flushReportQueue().catch((e) => {
        this.logger?.warn({ err: e.message }, 'periodic flush crashed');
      });
    }, this.flushIntervalMs);
    // 2026-09-27 — R93.6: removed `this._flushTimer.unref()`. Same reason
    // as the sync timer above.
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

// 2026-09-22 S82 — production default for syncFromCenter: stamp
// X-Agent-Signature via signedRequestJson so the centre's identity-
// binding middleware accepts the GET after the 60s restart-grace window.
// Tests inject their own stub via the PackageManager `signedFetchJson`
// constructor option, mirroring the `fetchJson` pattern for the POST
// path.
async function defaultSignedFetchJson({ method, url, headers, body, agentToken, hostname, agentId, timeoutMs }) {
  // R93.2 — forward `body` to signedRequestJson. The original S82 helper
  // (syncFromCenter, GET-only) didn't carry a body so this was a no-op;
  // R93.2's flushReportQueue POST now uses this default and the body
  // holds the run batch. Without forwarding, the request goes out empty
  // (Content-Length: 0) and centre stores no runs → tests fail, ops
  // fail. signedRequestJson itself accepts body and forwards it to
  // requestJson; this wrapper just has to pass it through.
  return signedRequestJson({ method, url, headers, body, agentToken, hostname, agentId, timeoutMs });
}
