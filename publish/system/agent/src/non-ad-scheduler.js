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

import { shouldRunPackageForNonAd } from './agent-filters.js';

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
