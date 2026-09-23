// 2026-09-04 R78 — Real agent file-push drainer.
// 2026-09-22 R78.1 — Agent-side ack routing (this file).
//
// Bridge the center's file-push queue (R65 followup) to local disk.
// Polls GET /api/agent/file-push?hostname=X on every heartbeat, then
// for each claimed task downloads the bytes via GET /api/agent/file-push/:id/file
// and writes them to disk at `<targetPath>/`. After a successful
// write (or a hard failure) the drainer POSTs the outcome to
// /api/agent/file-push/:id/ack so the center flips the per-target
// status to 'delivered' / 'failed' and emits the matching audit row.
//
// Why a separate module:
//   - Pure-function shape (all wire helpers injected) makes the drainer
//     unit-testable with stub HTTP functions and a stub fs.writeFileSync.
//   - Mirrors the mock-side flow (center/mock-file-push.mjs) so an
//     operator running the e2e script gets the same sequencing.
//
// Center endpoints used:
//   GET /api/agent/file-push?hostname=X&agentId=Y&limit=N
//       → { tasks: [{ taskId, filename, targetPath, sha256, sizeBytes,
//                     targetType, status, uploadedAt }] }
//       The center's claimForAgent flips a matching pending target to
//       'claimed' on the first poll (per-target state machine).
//   GET /api/agent/file-push/:id/file?hostname=X
//       → binary octet-stream with X-File-Sha256 header
//   POST /api/agent/file-push/:id/ack  (R78.1, agent-token gated)
//       body: { hostname, agentId, ok, errorMessage? }
//       → 200 { task } | 400 missing fields | 403 wrong hostname | 404 unknown task
//       On success the per-target status flips; one audit row
//       (push_file_delivered or push_file_failed) is emitted. This
//       closes the R78 KNOWN GAP — operators no longer have to mark
//       delivered/failed manually via the admin UI.

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
  httpPostJson,
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
    return { processed: 0, delivered: 0, failed: 0, acked: 0, error: 'hostname required' };
  }
  if (typeof httpGetJson !== 'function' || typeof httpGetBinary !== 'function' || typeof httpPostJson !== 'function') {
    return { processed: 0, delivered: 0, failed: 0, acked: 0, error: 'httpGetJson/httpGetBinary/httpPostJson required' };
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
    return { processed: 0, delivered: 0, failed: 0, acked: 0 };
  }

  logger?.info?.({ hostname, count: tasks.length }, 'file-push tasks drained from center');

  let processed = 0;
  let delivered = 0;
  let failed = 0;
  let acked = 0;

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

    // Per-task outcome — declared up front so every skip / fail path
    // can ack uniformly (R78.1 closes the long-standing gap where the
    // agent wrote files but the center's per-target column stayed at
    // 'claimed' forever). Default is a hard fail; set inside the
    // successful paths below.
    let ok = false;
    let errMsg = null;

    if (!targetDir || !filename) {
      failed++;
      errMsg = 'missing targetPath/filename';
      logger?.warn?.({ taskId, filename, targetDir }, 'file-push missing targetPath/filename; skipping');
    } else {
      // 2026-09-09 S82 (security) — reject path-traversal payloads BEFORE
      // we touch the filesystem. validatePayloadPath walks filename rules
      // (no `..`, no `:`, no leading `.`, no separators), then resolves
      // `<targetPath>/<filename>` against the allow-list of write roots.
      // Throws 400-shaped error on rejection; the drainer logs + counts as
      // failed without writing anything.
      let targetPath;
      let safetyRejected = false;
      try {
        const r = validatePayloadPathOrThrow({ filename, targetPath: targetDir, allowedRoots });
        targetPath = r.resolved;
      } catch (e) {
        failed++;
        safetyRejected = true;
        errMsg = `path-safety: ${e.message}`;
        logger?.warn?.({ taskId, filename, targetDir, err: e.message }, 'file-push rejected (path-safety)');
      }

      // 2) Download the bytes. httpGetBinary is injected; in production
      // it wraps an HTTPS GET that returns { ok, status, buffer, headerSha256 }.
      let buffer = null;
      let dlOk = false;
      if (!safetyRejected) {
        try {
          const dl = await httpGetBinary({
            url: `${centerUrl}/api/agent/file-push/${encodeURIComponent(taskId)}/file?hostname=${encodeURIComponent(hostname)}`,
            headers: { 'X-Agent-Token': token },
            timeoutMs: 60_000,
          });
          if (!dl.ok) {
            failed++;
            errMsg = `download HTTP ${dl.status}`;
            logger?.warn?.({
              taskId, filename, status: dl.status,
            }, 'file-push download failed');
          } else {
            dlOk = true;
            buffer = dl.buffer;
          }
        } catch (e) {
          failed++;
          errMsg = `download threw: ${e.message}`;
          logger?.warn?.({ err: e.message, taskId, filename }, 'file-push download threw');
        }
      }

      // 3) Write to disk. mkdir -p the parent so a missing dir doesn't
      // crash the agent (Windows mkdir recursive is idempotent for
      // existing dirs — Node's fs.mkdirSync({recursive:true}) is too).
      let writeOk = false;
      if (dlOk) {
        try {
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, buffer);
          writeOk = true;
          delivered++;
          ok = true;
          errMsg = null;
          logger?.info?.({
            taskId,
            filename,
            targetPath,
            bytes: task.sizeBytes,
            sha256: task.sha256,
          }, 'file-push delivered to disk');
        } catch (e) {
          failed++;
          errMsg = `write failed: ${e.message}`;
          logger?.warn?.({
            err: e.message,
            taskId,
            filename,
            targetPath,
          }, 'file-push write failed (target dir unwritable?)');
        }
      }
    }

    // 4) 2026-09-22 R78.1 — ack the outcome to the center. Without
    // this the per-target `targetStatus` row on the center side stays
    // at 'claimed' forever and operators have to flip it manually.
    // We ack even on the failure paths so the trail shows what really
    // happened (download 403 vs write EACCES look very different in
    // the audit log). Network / 5xx errors from the ack endpoint are
    // logged but don't roll the per-task counter — the next heartbeat
    // will re-claim and re-try. A non-2xx ack response with a 4xx body
    // is treated as "center rejected our ack" and also retried later.
    try {
      const ackRes = await httpPostJson({
        url: `${centerUrl}/api/agent/file-push/${encodeURIComponent(taskId)}/ack`,
        headers: { 'X-Agent-Token': token },
        timeoutMs: 15_000,
        body: {
          hostname,
          agentId: agentId || hostname,
          ok,
          errorMessage: errMsg
        }
      });
      if (ackRes?.ok) {
        acked++;
      } else {
        logger?.warn?.({
          taskId,
          status: ackRes?.status,
          ok
        }, 'file-push ack returned non-2xx; will retry on next heartbeat');
      }
    } catch (e) {
      logger?.warn?.({
        err: e.message,
        taskId,
        ok
      }, 'file-push ack threw; will retry on next heartbeat');
    }
  }

  return { processed, delivered, failed, acked };
}

// Exposed for the test harness.
export const __testing = { drainFilePush };
