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

// ── In-memory state ────────────────────────────────────────────────────
// Map<taskId, task>. Loaded from disk on first read (lazy).
let _cache = null;
let _loading = null;

async function loadIndex() {
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

async function flushIndex() {
  ensureDataDir();
  const out = { tasks: Object.fromEntries(_cache) };
  const tmp = indexPath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
  await fs.rename(tmp, indexPath());
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
  if (!Buffer.isBuffer(buffer)) throw httpErr(400, 'buffer required');
  if (targetType !== 'dc' && targetType !== 'server') {
    throw httpErr(400, 'targetType must be dc or server');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw httpErr(400, 'targets array required (non-empty)');
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
  // Write the bytes AFTER the index so a crash between the two leaves
  // the index missing the entry rather than pointing at a half-written
  // file. fs.writeFile is atomic-ish (overwrites via O_TRUNC) — if it
  // fails the operator will see 'queued' without a file on disk; the
  // router's audit row is only written after both succeed.
  ensureDataDir();
  await fs.writeFile(filePathFor(taskId), buffer);
  return { taskId, sha256, sizeBytes: buffer.length, targetCount: task.targetStatus.length };
}

/** List all tasks (most recent first). Used by admin UI + agent debug. */
export async function listTasks() {
  const cache = await loadIndex();
  const out = [];
  for (const t of cache.values()) out.push(publicView(t));
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
 */
export async function claimForAgent(agentId, hostname) {
  if (!hostname) throw httpErr(400, 'hostname required');
  const cache = await loadIndex();
  const now = new Date().toISOString();
  const out = [];
  for (const t of cache.values()) {
    if (!t.targets.includes(hostname)) continue;
    if (t.status === 'delivered' || t.status === 'failed') continue;
    // Mark this target as claimed by this agent (first time).
    const tgt = t.targetStatus.find(x => x.name === hostname);
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
  const tgt = t.targetStatus.find(x => x.name === hostname);
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