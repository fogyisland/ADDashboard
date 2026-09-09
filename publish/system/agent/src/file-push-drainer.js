// 2026-09-04 R78 — Real agent file-push drainer.
//
// Bridge the center's file-push queue (R65 followup) to local disk.
// Polls GET /api/agent/file-push?hostname=X on every heartbeat, then
// for each claimed task downloads the bytes via GET /api/agent/file-push/:id/file
// and writes them to disk at `<targetPath>/`. Marks the
// download + write outcome in a local log line so an operator scanning
// the agent log can see which files actually landed.
//
// Why a separate module:
//   - Pure-function shape (all wire helpers injected) makes the drainer
//     unit-testable with stub HTTP functions and a stub fs.writeFileSync.
//   - Mirrors the mock-side flow (center/mock-file-push.mjs) so an
//     operator running the e2e script gets the same sequencing.
//
// KNOWN GAP (intentional, R78 scope): there is no agent-side
// /api/agent/file-push/:id/ack endpoint on the center. The center's
// only ack surface is /api/admin/file-push/:id/ack, which is gated by
// userAuth + admin:users permission and requires an ADMIN_TOKEN the
// agent does not have. Per the directive's "Do NOT touch center
// service/routes/SQL" constraint we cannot add a new agent-side
// endpoint this round. Consequence: the per-target `targetStatus`
// column on center stays at 'claimed' forever after the agent writes
// the file; the operator must mark it delivered/failed manually via
// the admin UI. This is a follow-up backlog item (search for "file-push
// agent ack" in the issue tracker). For R78 we deliver the file-write
// path so the agent side actually moves bytes, and surface the
// outcome locally via structured log lines.
//
// Center endpoints used (already in production):
//   GET /api/agent/file-push?hostname=X&agentId=Y&limit=N
//       → { tasks: [{ taskId, filename, targetPath, sha256, sizeBytes,
//                     targetType, status, uploadedAt }] }
//       The center's claimForAgent flips a matching pending target to
//       'claimed' on the first poll (per-target state machine).
//   GET /api/agent/file-push/:id/file?hostname=X
//       → binary octet-stream with X-File-Sha256 header
//   POST /api/admin/file-push/:id/ack  (NOT USED — admin-auth only;
//       see KNOWN GAP above)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// 2026-09-09 S82 (security) — path-traversal guard. The wire format
// (targetPath + filename) is operator-supplied; we validate it against
// an allow-list of write roots before touching the filesystem so a
// payload like `..\..\..\Windows\System32\evil.dll` can't escape the
// intended payload directory.
import { validatePayloadPathOrThrow } from './lib/path-safety.js';

export async function drainFilePush({
  hostname,
  agentId,
  token,
  centerUrl,
  httpGetJson,
  httpGetBinary,
  logger,
  limit = 5,
  // 2026-09-09 S82 (security) — optional override for path-safety's
  // allowedRoots. Production callers omit it (the default covers
  // C:\addashboard\payloads + ProgramData variants); tests inject
  // sandbox tmpdirs so they don't have to create real paths under
  // C:\addashboard\ on every dev machine.
  allowedRoots,
} = {}) {
  if (!hostname) {
    return { processed: 0, delivered: 0, failed: 0, error: 'hostname required' };
  }
  if (typeof httpGetJson !== 'function' || typeof httpGetBinary !== 'function') {
    return { processed: 0, delivered: 0, failed: 0, error: 'httpGetJson/httpGetBinary required' };
  }

  // 1) Poll for tasks targeted at this hostname.
  let poll;
  try {
    poll = await httpGetJson({
      url: `${centerUrl}/api/agent/file-push?hostname=${encodeURIComponent(hostname)}&agentId=${encodeURIComponent(agentId || hostname)}&limit=${limit}`,
      headers: { 'X-Agent-Token': token },
      timeoutMs: 30_000,
    });
  } catch (e) {
    logger?.warn?.({ err: e.message, hostname }, 'file-push poll threw');
    return { processed: 0, delivered: 0, failed: 0, error: e.message };
  }

  if (!poll.ok) {
    if (poll.status !== 404) {
      logger?.warn?.({ status: poll.status, hostname }, 'file-push poll returned non-2xx');
    }
    return { processed: 0, delivered: 0, failed: 0, status: poll.status ?? 0 };
  }

  const tasks = Array.isArray(poll.data?.tasks) ? poll.data.tasks : [];
  if (tasks.length === 0) {
    return { processed: 0, delivered: 0, failed: 0 };
  }

  logger?.info?.({ hostname, count: tasks.length }, 'file-push tasks drained from center');

  let processed = 0;
  let delivered = 0;
  let failed = 0;

  for (const task of tasks) {
    processed++;
    const taskId = task.taskId;
    const filename = task.filename;
    // targetPath is the absolute dir on the agent where the file
    // should land (operator-supplied at upload time). Join with the
    // filename to produce the full local path. We do NOT trust
    // targetPath from the wire beyond using it as a join anchor —
    // mkdirSync({ recursive: true }) creates any missing parents.
    const targetDir = task.targetPath;

    if (!targetDir || !filename) {
      failed++;
      logger?.warn?.({ taskId, filename, targetDir }, 'file-push missing targetPath/filename; skipping');
      continue;
    }

    // 2026-09-09 S82 (security) — reject path-traversal payloads BEFORE
    // we touch the filesystem. validatePayloadPath walks filename rules
    // (no `..`, no `:`, no leading `.`, no separators), then resolves
    // `<targetPath>/<filename>` against the allow-list of write roots.
    // Throws 400-shaped error on rejection; the drainer logs + counts as
    // failed without writing anything.
    let targetPath;
    try {
      const r = validatePayloadPathOrThrow({ filename, targetPath: targetDir, allowedRoots });
      targetPath = r.resolved;
    } catch (e) {
      failed++;
      logger?.warn?.({ taskId, filename, targetDir, err: e.message }, 'file-push rejected (path-safety)');
      continue;
    }

    // 2) Download the bytes. httpGetBinary is injected; in production
    // it wraps an HTTPS GET that returns { ok, status, buffer, headerSha256 }.
    let buffer;
    try {
      const dl = await httpGetBinary({
        url: `${centerUrl}/api/agent/file-push/${encodeURIComponent(taskId)}/file?hostname=${encodeURIComponent(hostname)}`,
        headers: { 'X-Agent-Token': token },
        timeoutMs: 60_000,
      });
      if (!dl.ok) {
        failed++;
        logger?.warn?.({
          taskId, filename, status: dl.status,
        }, 'file-push download failed');
        continue;
      }
      buffer = dl.buffer;
    } catch (e) {
      failed++;
      logger?.warn?.({ err: e.message, taskId, filename }, 'file-push download threw');
      continue;
    }

    // 3) Write to disk. mkdir -p the parent so a missing dir doesn't
    // crash the agent (Windows mkdir recursive is idempotent for
    // existing dirs — Node's fs.mkdirSync({recursive:true}) is too).
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, buffer);
      delivered++;
      logger?.info?.({
        taskId,
        filename,
        targetPath,
        bytes: task.sizeBytes,
        sha256: task.sha256,
      }, 'file-push delivered to disk');
    } catch (e) {
      failed++;
      logger?.warn?.({
        err: e.message,
        taskId,
        filename,
        targetPath,
      }, 'file-push write failed (target dir unwritable?)');
    }
  }

  return { processed, delivered, failed };
}

// Exposed for the test harness.
export const __testing = { drainFilePush };
