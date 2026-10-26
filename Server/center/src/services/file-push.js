// 2026-08-30 R65 followup — 文件推送 (file push) backend service.
//
// Mock-first per operator standing directive ("先做mock 到时候agent
// 按照mock方案改造就好了"). No DB schema — task state lives in an
// in-memory Map keyed by taskId, and on every mutation the map is
// flushed to data/file-push/index.json so a process restart can
// recover in-flight tasks. The raw file bytes live alongside as
// data/file-push/<taskId>.bin — small enough (≤8 MB per the JSON
// body limit on /api/admin/file-push) that the filesystem is the
// natural choice for v1.
//
// Task lifecycle:
//
//   queued   → uploaded by operator, no agent has claimed yet
//   claimed  → an agent called /api/agent/file-push?hostname=X
//              and we found a task whose targets include X.
//              We record claimAt + claimAgentId for the audit row.
//   delivered→ the agent called /api/admin/file-push/:id/ack
//              with ok=true and we wrote the file to its target.
//   failed   → agent called /api/admin/file-push/:id/ack with
//              ok=false (or hit a write error); we record errorMessage
//              and the task is parked — operator can re-queue.
//
// Per-target ack: each task has a `targets` array (hostnames or DC
// names). Each target tracks its own status independently so a 5-host
// push shows 5/5 success / 3/5 / etc. The audit row 'push_file_delivered'
// is emitted once per target as it lands (matches the per-target flow
// rather than the whole-task summary).

import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sha256Hex } from '../config.js';
// R158.X.115 (2026-10-20) — 拒绝把文件下发到退役/暂停管控的主机。
import { findOffManagementHosts } from './host-status.js';

// ── Filesystem layout ──────────────────────────────────────────────────
// Root is resolved lazily via env() so the test harness can override it
// without re-importing this module. data/file-push/ is created on first
// write if missing — see ensureDataDir().
const DEFAULT_DATA_DIR = 'data/file-push';

function dataDir() {
  return process.env.ADDASHBOARD_FILE_PUSH_DIR || DEFAULT_DATA_DIR;
}

function ensureDataDir() {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath() {
  return join(dataDir(), 'index.json');
}
function filePathFor(taskId) {
  return join(dataDir(), `${taskId}.bin`);
}
// R158.69.9 (2026-10-11) — export filePathFor for retention sweep (delete .bin
// when purging old tasks). 之前 internal, retention 现在需要.
// 这里 export 是"implementation not API surface" (跟 R158.69 feedback 一致).
export { filePathFor };

// ── In-memory state ────────────────────────────────────────────────────
// Map<taskId, task>. Loaded from disk on first read (lazy).
let _cache = null;
let _loading = null;

// R158.69.9 (2026-10-11) — exported so file-push-retention.js can read the
// in-memory cache without re-hitting disk. "Implementation not API surface"
// (R158.69 feedback) — only the retention loop shares this.
export async function loadIndex() {
  if (_cache) return _cache;
  if (_loading) return _loading;
  _loading = (async () => {
    ensureDataDir();
    try {
      const raw = await fs.readFile(indexPath(), 'utf8');
      const parsed = JSON.parse(raw);
      _cache = new Map(Object.entries(parsed.tasks || {}));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      _cache = new Map();
    }
    return _cache;
  })();
  return _loading;
}

// R158.69.9 (2026-10-11) — flushIndex mutex + unique tmp + retry.
//
// 真因: 修前 tmp 名固定 = `index.json.tmp`. 多 agent 并发 poll (中心 34
// DC, 高峰 30 req/s) 时, call A writeFile → call B writeFile overwrite →
// call A rename 报 ENOENT (tmp 不存在 / sharing violation). 实测 4 次
// (10-10 16:11, 10-11 08:26, 08:27, 09:30) + 新 push 100% 触发.
//
// 修法 3 layer:
//   - Promise chain mutex (_flushChain.then): 同 process 内所有 flush 串行
//   - unique tmp 名 (pid + ts + uuid): 跨 call / 跨 process 不冲突
//   - retry + backoff 处理 Windows MoveFileEx 偶发 ENOENT/EPERM/EBUSY
let _flushChain = Promise.resolve();

// R158.69.9 (2026-10-11) — exported so file-push-retention.js can sweep stale
// claims + purge old tasks through the same mutex-protected writer. This is
// "implementation not API surface" (R158.69 feedback) — no external caller
// should depend on the write behavior directly, but the retention loop must
// share the same mutex or it would race ackTask/claimForAgent/createTask.
export async function flushIndex() {
  ensureDataDir();
  const job = _flushChain.then(async () => {
    const out = { tasks: Object.fromEntries(_cache) };
    const tmp = `${indexPath()}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rename(tmp, indexPath());
        return;
      } catch (e) {
        lastErr = e;
        // Windows MoveFileEx 偶发 sharing violation (ENOENT/EPERM/EBUSY),
        // 其他 code (e.g. EACCES permission) 直接抛不重试.
        if (e.code !== 'ENOENT' && e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
      }
    }
    // retry 5 次仍失败, 清残留 tmp 避免堆积 (理论不该, 防御)
    try { await fs.unlink(tmp); } catch {}
    throw lastErr;
  });
  // catch 阻断链上 fail 不污染后续 flush. worker 内部 try/return 已处理
  // success, 失败让 job reject, 链上 catch 后 chain 仍可继续 append.
  _flushChain = job.catch(() => {});
  return job;
}

// 2026-09-09 S82 (security) — filename validation at queue time.
// Mirrors the agent-side path-safety rules (lib/path-safety.js) so an
// operator can't even *queue* a payload that would later be rejected on
// the agent. Defense-in-depth — the agent still re-validates before
// writing to disk.
const FILENAME_FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/;
const FILENAME_FORBIDDEN_SUBSTR = /(\.\.|[:\\/])/;

function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return { ok: false, error: 'filename is required' };
  }
  if (filename.length > 255) {
    return { ok: false, error: 'filename exceeds 255 chars' };
  }
  if (FILENAME_FORBIDDEN_CHARS.test(filename)) {
    return { ok: false, error: 'filename contains control characters' };
  }
  if (FILENAME_FORBIDDEN_SUBSTR.test(filename)) {
    return { ok: false, error: 'filename contains path separator, drive letter, or relative-segment (..)' };
  }
  if (filename.startsWith('.')) {
    return { ok: false, error: 'filename starts with . (hidden / relative)' };
  }
  return { ok: true };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create a new push task.
 *
 * @param {object} args
 * @param {string} args.filename         — original filename from upload
 * @param {Buffer} args.buffer           — raw file bytes
 * @param {string} args.targetType       — 'dc' | 'server'
 * @param {string[]} args.targets        — list of hostnames (or DC names)
 * @param {string} args.targetPath       — absolute directory on each agent
 *                                        where the file should be written
 * @param {number|null} args.uploadedBy  — admin user id (for audit row)
 * @returns {Promise<{taskId, sha256, sizeBytes, targetCount}>}
 */
export async function createTask({ filename, buffer, targetType, targets, targetPath, uploadedBy }) {
  if (!filename) throw httpErr(400, 'filename required');
  // 2026-09-09 S82 (security) — filename validation. Mirrors the
  // agent-side lib/path-safety.js rules. Reject at queue time so the
  // operator can't bypass via a payload that would only fail on the
  // agent later (and so audit shows the rejection happened on the
  // server, not as an opaque "agent failed to write").
  const v = validateFilename(filename);
  if (!v.ok) throw httpErr(400, v.error);
  if (!Buffer.isBuffer(buffer)) throw httpErr(400, 'buffer required');
  if (targetType !== 'dc' && targetType !== 'server') {
    throw httpErr(400, 'targetType must be dc or server');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw httpErr(400, 'targets array required (non-empty)');
  }
  // R158.X.115 (2026-10-20) — 拒绝把文件下发到退役/暂停管控的主机。
  //   退役 = agent 已卸载, 推了永远没人 claim, task 会永远卡在 queued 且
  //   targetStatus 停在 pending, 在 UI 上看起来像"下发失败"其实是"不该下发";
  //   暂停 = 操作员明确表示这台机器现在别管。
  //   拒绝在**建任务时**而不是让任务失败, 操作员能立刻知道原因并改成
  //   "先恢复管控" 或从目标里去掉。
  //
  //   kind 映射: targetType 'dc' → ad_dcs.dc_name; 'server' → ad_member_servers.hostname。
  //   一次查全 (0 N+1): 逐目标 isHostOnline 会打 N 次 DB, 这里一次批量查。
  const normalizedTargets = targets.map(t => String(t).trim()).filter(Boolean);
  const offMgmtTargets = await findOffManagementHosts(
    targetType === 'dc' ? 'dc' : 'member',
    normalizedTargets
  );
  if (offMgmtTargets.length > 0) {
    throw httpErr(400,
      `以下目标已退役/暂停管控或不存在, 不能作为下发目标: ${offMgmtTargets.join(', ')}。`
      + '如需下发, 请先恢复该主机的管控。');
  }
  if (!targetPath || typeof targetPath !== 'string') {
    throw httpErr(400, 'targetPath required');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const task = {
    taskId,
    filename,
    sizeBytes: buffer.length,
    sha256,
    targetType,
    targetPath,
    targets: targets.map(t => String(t).trim()).filter(Boolean),
    uploadedAt: now,
    uploadedBy: uploadedBy ?? null,
    status: 'queued',
    // Per-target ack state. Each entry: { name, status, claimedAt, claimedBy,
    // deliveredAt, errorMessage }. Initialized on task creation so the UI
    // can render the target list before any agent has polled.
    targetStatus: targets.map(t => ({
      name: String(t).trim(),
      status: 'pending',
      claimedAt: null,
      claimedBy: null,
      deliveredAt: null,
      errorMessage: null
    }))
  };
  const cache = await loadIndex();
  cache.set(taskId, task);
  await flushIndex();
  ensureDataDir();
  try {
    await fs.writeFile(filePathFor(taskId), buffer);
  } catch (e) {
    // S4 (2026-09-30) — fs.writeFile failure (disk full / permission /
    // transient I/O) used to leave a stale entry in index.json pointing
    // at a missing .bin file: listTasks/getTask returned status='queued'
    // but getTaskFile 404'd forever (no GC). Roll back the index entry
    // we just wrote so the task disappears from admin UIs and any
    // pending agent claim won't get a dangling reference. Re-throw so
    // the route handler returns 500 (matches the "audit row only after
    // both succeed" invariant we promise upstream).
    cache.delete(taskId);
    try { await flushIndex(); } catch (flushErr) {
      logger?.error?.({ err: flushErr?.message, taskId }, 'file-push: index rollback failed');
    }
    throw e;
  }
  return { taskId, sha256, sizeBytes: buffer.length, targetCount: task.targetStatus.length };
}

/** List all tasks (most recent first). Used by admin UI + agent debug. */
export async function listTasks({ targetType } = {}) {
  const cache = await loadIndex();
  const out = [];
  for (const t of cache.values()) {
    if (targetType && t.targetType !== targetType) continue;
    out.push(publicView(t));
  }
  // newest first
  out.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
  return out;
}

/** Single task view (admin: includes targetStatus; agent view strips it). */
export async function getTask(taskId) {
  const cache = await loadIndex();
  const t = cache.get(taskId);
  if (!t) throw httpErr(404, 'task not found');
  return publicView(t);
}

/**
 * Agent-facing view — only returns tasks targeted at this agent.
 * Filters by hostname match against the `targets` list. Marks a
 * matching task as 'claimed' the first time it's polled so the
 * operator can see the agent picked it up (the actual delivery ack
 * still comes via ackTask()).
 *
 * R158.61+5 (2026-10-10) — case-insensitive hostname match.
 * Windows `os.hostname()` returns mixed case (e.g. KDLBJOFADSrv1)
 * while AD canonical DC names are uppercase (KDLBJOFADSRV1). The
 * agent sends `hostname` = mixed case but file-push tasks are
 * queued with `targets` = uppercase (from listDcsCatalog → dcName
 * = ad_dcs.dc_name, all-caps). JS `String.includes` is
 * case-sensitive, so claims silently failed forever and operators
 * saw a "queued forever" UI. Compare via toLowerCase() on both
 * sides; keep the original casing in storage.
 */
export async function claimForAgent(agentId, hostname) {
  if (!hostname) throw httpErr(400, 'hostname required');
  const cache = await loadIndex();
  const now = new Date().toISOString();
  const hostnameLower = hostname.toLowerCase();
  const out = [];
  for (const t of cache.values()) {
    const matchIdx = t.targets.findIndex(x => String(x).toLowerCase() === hostnameLower);
    if (matchIdx === -1) continue;
    if (t.status === 'delivered' || t.status === 'failed') continue;
    // Mark this target as claimed by this agent (first time). Match
    // by the *original* name stored in targetStatus (preserves case).
    const matchedName = t.targets[matchIdx];
    const tgt = t.targetStatus.find(x => x.name === matchedName);
    if (tgt && tgt.status === 'pending') {
      tgt.status = 'claimed';
      tgt.claimedAt = now;
      tgt.claimedBy = agentId;
    }
    if (t.status === 'queued') t.status = 'claimed';
    out.push(agentView(t));
  }
  if (out.length) await flushIndex();
  return out;
}

/**
 * Agent reports delivery outcome for one of its assigned targets.
 * @param {string} taskId
 * @param {string} hostname   — the agent's hostname (must match a target)
 * @param {string} agentId    — the agent identifier (heartbeat agentId)
 * @param {boolean} ok
 * @param {string|null} errorMessage
 */
export async function ackTask(taskId, hostname, agentId, ok, errorMessage) {
  const cache = await loadIndex();
  const t = cache.get(taskId);
  if (!t) throw httpErr(404, 'task not found');
  // R158.61+5 — case-insensitive target lookup (claim-side already
  // does this; ack must too so an agent that claims with
  // 'KDLBJOFADSrv1' and acks with the same mixed case still finds
  // its target row even when queued as uppercase 'KDLBJOFADSRV1').
  const hostnameLower = String(hostname || '').toLowerCase();
  const tgt = t.targetStatus.find(x => String(x.name).toLowerCase() === hostnameLower);
  if (!tgt) throw httpErr(404, 'hostname is not a target of this task');
  const now = new Date().toISOString();
  if (ok) {
    tgt.status = 'delivered';
    tgt.deliveredAt = now;
    tgt.errorMessage = null;
  } else {
    tgt.status = 'failed';
    tgt.deliveredAt = now;
    tgt.errorMessage = errorMessage || 'unknown error';
  }
  tgt.claimedBy = agentId || tgt.claimedBy;
  // Roll the task-level status forward: delivered if all targets delivered;
  // failed if all targets failed; otherwise stay in claimed.
  const allDelivered = t.targetStatus.every(x => x.status === 'delivered');
  const allFailed = t.targetStatus.every(x => x.status === 'failed');
  if (allDelivered) t.status = 'delivered';
  else if (allFailed) t.status = 'failed';
  else t.status = 'claimed';
  await flushIndex();
  return publicView(t);
}

/** Raw file bytes for download (admin + agent). Throws 404 if missing. */
export async function getTaskFile(taskId) {
  const cache = await loadIndex();
  if (!cache.has(taskId)) throw httpErr(404, 'task not found');
  try {
    return await fs.readFile(filePathFor(taskId));
  } catch (e) {
    if (e.code === 'ENOENT') throw httpErr(404, 'file missing on disk');
    throw e;
  }
}

// ── View shapers ───────────────────────────────────────────────────────
// Each task carries full data; the route hands different slices to
// admin vs agent. Keeping them in one place means the audit row
// payload always matches the response payload.

function publicView(t) {
  return {
    taskId: t.taskId,
    filename: t.filename,
    sizeBytes: t.sizeBytes,
    sha256: t.sha256,
    targetType: t.targetType,
    targetPath: t.targetPath,
    targets: t.targets,
    targetStatus: t.targetStatus,
    status: t.status,
    uploadedAt: t.uploadedAt,
    uploadedBy: t.uploadedBy
  };
}

function agentView(t) {
  return {
    taskId: t.taskId,
    filename: t.filename,
    sizeBytes: t.sizeBytes,
    sha256: t.sha256,
    targetType: t.targetType,
    targetPath: t.targetPath,
    status: t.status,
    uploadedAt: t.uploadedAt
  };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// ── Test helpers ───────────────────────────────────────────────────────
// Exposed for the test harness so it can reset the in-memory cache +
// delete on-disk state between runs without leaking state across test
// files. NOT exported via the router — only via direct import.
export async function _resetForTests({ dir } = {}) {
  if (dir) process.env.ADDASHBOARD_FILE_PUSH_DIR = dir;
  _cache = new Map();
  _loading = null;
}

// sha256Hex re-export so the router can validate the operator-supplied
// hash against the freshly-computed one (defense-in-depth on the upload
// path; not strictly needed but cheap).
export { sha256Hex };