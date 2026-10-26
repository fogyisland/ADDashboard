// non-ad-scheduler.js — per-package setInterval scheduler for the non-AD runtime.
//
// Holds the `localTasks` map and the `startTimerFor` / `applyPackageList`
// orchestration. Extracted into its own module so unit tests can import the
// SAME functions and the SAME map the runtime uses — no re-statement, no
// drift — and so we can assert handle stability across consecutive
// applyPackageList calls (regression test for the timer-starvation bug).
//
// The timer body (spawn PowerShell + POST result) is passed in by the caller
// (`runNonAdRuntime`) so this module stays IO-free and trivial to test.

// R158.75 (2026-10-11) — shouldRunPackageForNonAd inlined here from the
// (now-removed) agent-filters.js. Same predicate the non-AD runtime uses;
// one source of truth for the filter rule. Defensive against missing
// fields — every property access is optional-chained, and a missing
// `agent` block simply rejects the package.
//
// R158.87.6.5 (2026-10-12) — 三重防御:
//   1. agent.type === 'non-ad' (manifest 字段, R158.75 起原 predicate)
//   2. scope === 'agent_type:non-ad' (R158.86.5 install derive 字符串,
//      跟中心端 package_policies.scope 1:1 对称, 跟 R158.86.5.1 lesson
//      "1:1 server install scope + client read scope" 一致)
//   3. platforms includes 'windows' (跟 R158.75 兼容)
// 0 字段就拒, 不可逆. 防止中心端 server 端 (R158.87.6.5 L1 修后) 即使
// 返 13 包, noad agent 端 filter 兜底只装 non-ad scope 包. 跟 R158.86.5
// dormant bug 跟 R158.87.6.5 L1 强化 1:1 平行.
function shouldRunPackageForNonAd(pkg) {
  if (!pkg?.agent?.type || pkg.agent.type !== 'non-ad') return false;
  // R158.86.5 scope 字段是 package 顶层 (跟 installScript derive 1:1)
  // 不是 pkg.agent.scope. 防御 missing scope 字段 = 拒.
  if (pkg.scope !== 'agent_type:non-ad') return false;
  if (!(pkg.agent?.platforms || []).includes('windows')) return false;
  return true;
}

// Map<name, { timer: Timeout, intervalSec: number }>
const localTasks = new Map();

/**
 * Schedule one package's setInterval. Caller controls the timer body via
 * `runFn(pkg)`.
 *
 * Idempotent on (name, intervalSec): if the same name is already scheduled
 * at the same cadence, the existing timer is preserved. Without this guard
 * applyPackageList would restart the countdown on every 5-minute poll,
 * starving any package whose intervalSec >= poll cadence (so it never fires).
 */
export function startTimerFor(pkg, runFn) {
  const intervalSec = pkg.agent?.intervalSec;
  if (!intervalSec || intervalSec <= 0) return null;
  const intervalMs = intervalSec * 1000;
  const existing = localTasks.get(pkg.name);
  if (existing?.timer) {
    if (existing.intervalSec === intervalSec) return existing.timer;
    clearInterval(existing.timer);
  }
  const timer = setInterval(() => runFn(pkg), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  localTasks.set(pkg.name, { timer, intervalSec });
  return timer;
}

/**
 * Diff the desired package list against the currently-scheduled set:
 *   - stop timers whose names no longer appear
 *   - (re)start timers for the wanted set
 *
 * `startTimerFor` is idempotent on (name, intervalSec), so calling this on
 * every poll is safe and does NOT restart an unchanged schedule.
 */
export function applyPackageList(items, runFn) {
  const wanted = items.filter(shouldRunPackageForNonAd);
  const wantedNames = new Set(wanted.map((p) => p.name));
  for (const [name, t] of localTasks) {
    if (!wantedNames.has(name)) {
      clearInterval(t.timer);
      localTasks.delete(name);
    }
  }
  for (const pkg of wanted) startTimerFor(pkg, runFn);
  return wanted;
}

/** Tear down every scheduled timer. Used on SIGINT/SIGTERM. */
export function clearAllTimers() {
  for (const t of localTasks.values()) clearInterval(t.timer);
  localTasks.clear();
}

// R158.72.x.12 B' (2026-10-17) — triggerOnce wire 真实现 (NoAD 端
//   1:1 平行 AD agent/src/package-manager.js:404 runOne(pkg, {onceOnly})).
//   NoAD 跟 AD 的关键差异:
//     - AD `localTasks` Map 持 pkg ref → triggerOnce 跑完 clearInterval
//       + delete name 即可.
//     - NoAD `localTasks` Map 只持 {timer, intervalSec} → triggerOnce
//       跑完走 `localTasks.get(name)?.timer + clearInterval` 范式,
//       不 delete (因为中心端 cron 兜底会 5min 后再 setInterval).
//   跟 R158.60.10 intervalSec<=0 skip idiom 1:1 平行 — 0 改 reschedule /
//   applyPackageList 主路径, 0 改 startTimerFor, 0 改 clearAllTimers.
//   1 click 1 跑 0 启 setInterval (跟 AD 1:1 平行).
export function fireOnceFor(name) {
  const t = localTasks.get(name);
  if (t) {
    clearInterval(t.timer);
    localTasks.delete(name);
    return { action: 'clearInterval', reason: 'wire t.triggerOnce=true — 1 click 1 跑 0 启 setInterval' };
  }
  // Reschedule 0 entry (R158.60.10 intervalSec<=0 skip 范式, 跟
  //   cronExpr='0 2 * * *' + R158.72.x.11 self-interval anchor 范式
  //   1:1 平行). wire 仍标 triggerOnce=true 即可, 0 启 timer.
  return { action: 'noop', reason: 'no scheduled timer (R158.60.10 on-demand skip / R158.72.x.13 cronExpr daily 2:00 / 中心端 cron 兜底) — 0 启 setInterval' };
}

/**
 * Testing seam: returns the sorted list of package names currently held in
 * the localTasks map. Exported so the regression test can assert that an
 * unchanged applyPackageList call does NOT replace the underlying map entry
 * (which would mean the timer was restarted — the starvation bug).
 */
export function peekLocalTaskNames() {
  return Array.from(localTasks.keys()).sort();
}

/**
 * Testing seam: returns the actual { timer, intervalSec } entry for a given
 * package name. Tests use reference equality on `timer` to detect restarts.
 */
export function peekLocalTask(name) {
  return localTasks.get(name);
}

/**
 * Testing seam: reset the map between test cases. Not used in production.
 */
export function __resetLocalTasksForTests() {
  clearAllTimers();
}
