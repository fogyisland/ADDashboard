// agent/src/appsettings-writer.js — atomic appsettings.json centerUrl rewrite.
//
// Pattern: read → parse → mutate → write-tmp → fsync → rename. The tmp+rename
// pair is atomic on the same volume on Windows + POSIX, so a crash mid-write
// leaves the original file intact. NEVER throws; all failure paths return
// { ok: false, error: '<reason>' }.

import {
  readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync, rmSync
} from 'node:fs';

// R161.31 (2026-11-07) — tmp 文件名必须**每次唯一**。
//
// ★ 为什么: 旧实现三处 writer 都用 `${path}.tmp` 这一个固定名字。
//   一旦两个 writer 并发跑 (R161.31 性能项 2 的并行化，或将来任何
//   并发调用), 它们会 openSync 同一个 tmp 文件 —— 后一个把前一个已写入
//   的内容截断/交错 ⇒ 最终 rename 上去的 appsettings.json 是**损坏的
//   JSON**。更糟的是两个 rename 抢同一个源文件: 先 rename 成功的那个
//   把 tmp 移走了, 后一个 rename 报 ENOENT ⇒ 那次写入静默丢失。
//
// ★ 解法: tmp 名带进程 pid + 单调计数 ⇒ 并发 writer 各写各的文件,
//   rename 各自成功, 最后一个 rename 覆盖前面的 (last-writer-wins)。
//   注意: 这**只**解决"写坏文件"和"丢写", 不解决"读-改-写丢更新"
//   (read → mutate → write 三步之间的窗口) —— 那个由
//   writeAppsettingsPatchAtomicMerged (合并成一次写) 解决。
let _tmpCounter = 0;
function nextTmpPath(path) {
  _tmpCounter += 1;
  return `${path}.tmp.${process.pid}.${_tmpCounter}`;
}

export function writeCenterUrlAtomic({ path, newUrl }) {
  // Defensive input check — caller passed garbage. Don't crash, return error.
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (typeof newUrl !== 'string' || !newUrl) {
    return { ok: false, error: 'invalid-newUrl' };
  }

  // 1. Read original
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  // 2. Parse
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  // 3. Mutate
  cfg.centerUrl = newUrl;

  // 4. Write tmp + fsync
  const tmpPath = nextTmpPath(path);
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  // 5. Rename over original (atomic on same volume)
  try {
    renameSync(tmpPath, path);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true };
}

// 2026-08-21 UX redesign (auto-delivery): when the centre pushes a new
// agentToken + agentTokenVersion via the heartbeat response, the agent
// MUST persist both atomically so a crash mid-write can't leave the file
// with the new version pointing at the old credential (or vice versa).
// Same shape as writeCenterUrlAtomic: read → parse → mutate → write-tmp
// → fsync → rename. NEVER throws.
export function writeAgentTokenAtomic({ path, newToken, newVersion }) {
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (typeof newToken !== 'string' || !newToken) {
    return { ok: false, error: 'invalid-newToken' };
  }
  // Version is a non-negative integer (matches the centre's monotonic
  // counter). Accept anything truthy + coerce via Number; reject NaN/0
  // because version=0 means "fresh install, never seen a credential".
  const versionNum = Number(newVersion);
  if (!Number.isInteger(versionNum) || versionNum < 1) {
    return { ok: false, error: 'invalid-newVersion' };
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  cfg.agentToken = newToken;
  cfg.agentTokenVersion = versionNum;

  const tmpPath = nextTmpPath(path);
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  try {
    renameSync(tmpPath, path);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true };
}

// 2026-10-01 R158.13 — generic appsettings.json patch writer. Used by
// applySettingsDelivery when the centre pushes {agentSettings, client
// SettingsVersion}. Accepts an arbitrary key/value patch object
// (heartbeatIntervalSeconds, pollingIntervalMinutes, …) atomically.
// Same five-step pattern as the two specialised writers above:
//   read → parse → mutate → write-tmp + fsync → rename
// NEVER throws; returns { ok, error? }.
//
// The mutation is shallow — every key in `patch` overwrites the
// existing value. Unrelated keys are preserved verbatim (we re-write
// the entire parsed JSON object). Centre range/whitelist enforcement
// happens BEFORE the patch reaches this function; agent-side
// validatePatch (settings-delivery.js) is a defence-in-depth check.
export function writeAppsettingsPatchAtomic({ path, patch }) {
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid-patch' };
  }
  const entries = Object.entries(patch);
  if (entries.length === 0) {
    // Reject empty patches — there's nothing to apply and writing a
    // fresh mtime on appsettings.json would be a no-op side-effect.
    return { ok: false, error: 'empty-patch' };
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  for (const [k, v] of entries) {
    cfg[k] = v;
  }

  const tmpPath = nextTmpPath(path);
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  try {
    renameSync(tmpPath, path);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true };
}

// R161.31 (2026-11-07) — 合并写入器: 把 N 个 delivery 的 patch 合成**一次**
// 原子写。跟 AD 树 (Server/agent/src/appsettings-writer.js) 1:1 平行。
//
// ★ 动机 (性能项 2): 心跳后的三个 delivery
//   (applyAgentTokenDelivery / applySettingsDelivery / applyUpgradeDelivery)
//   各自调用 writeAppsettingsPatchAtomic / writeAgentTokenAtomic, 而这三个
//   函数都是 read → parse → mutate → write-tmp → rename。串行跑 = **三次
//   全量读 + 三次全量写 + 三次 fsync**; 一次心跳要付三倍磁盘 IO。
//
// ★ 为什么不能简单改成 Promise.all: 那会引入两个真实缺陷 ——
//   (a) **读-改-写丢更新**: 三个 writer 各自 read 一个快照, 各自 mutate,
//       各自 rename。后两个的快照里没有前一个的改动 ⇒ 字段丢失。
//   (b) **共享 tmp 文件名**: 旧实现三处都用 `${path}.tmp` ⇒ 两个 writer
//       同时 openSync 同一个 tmp ⇒ 内容交错 ⇒ appsettings.json 变成损坏的
//       JSON, 下次启动 loadConfig 直接炸。
//   ⇒ 本文件顶部的 nextTmpPath (pid + 计数) 解决了 (b); 合并写入解决 (a)。
//
// ★ 契约: patches 是一个 patch 对象数组, 按数组顺序**后者覆盖前者**的同名键
//   (即 merge 语义)。调用方负责构造顺序 (调用顺序 = 语义顺序)。
//   返回 { ok, error?, applied?: string[] } —— applied 是本次真正落盘的键。
export function writeAppsettingsPatchAtomicMerged({ path, patches }) {
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (!Array.isArray(patches)) {
    return { ok: false, error: 'invalid-patches' };
  }
  const merged = {};
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    for (const [k, v] of Object.entries(patch)) {
      merged[k] = v;
    }
  }
  const entries = Object.entries(merged);
  if (entries.length === 0) {
    return { ok: false, error: 'empty-patch' };
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  for (const [k, v] of entries) {
    cfg[k] = v;
  }

  const tmpPath = nextTmpPath(path);
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  try {
    renameSync(tmpPath, path);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true, applied: entries.map(([k]) => k) };
}