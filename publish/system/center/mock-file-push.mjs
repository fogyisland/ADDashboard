// mock-file-push.mjs — end-to-end exercise of the 文件推送 (file push)
// chain against a live centre. Drives every wire that the real agent will
// drive so the operator can sanity-check the full lifecycle without
// standing up a real AD agent process.
//
// Why a dedicated script (vs. extending mock-heartbeat-daemon.mjs)?
// The daemon handles heartbeat + replication + discovery, but the
// file-push chain is operator-initiated (upload from admin UI) and
// runs on a different cadence than steady-state reporting. Keeping
// the chains separate lets each one advance independently.
//
// Flow:
//   1. Operator-side: POST /api/admin/file-push      (upload bytes)
//   2. Agent-side:    GET  /api/agent/file-push      (claim/poll by hostname)
//   3. Agent-side:    GET  /api/agent/file-push/:id/file (download + SHA-256 verify)
//   4. Operator-side: GET  /api/admin/file-push/:id  (verify target → 'claimed')
//   5. Operator-side: POST /api/admin/file-push/:id/ack ok=true  (delivered)
//   6. Operator-side: POST /api/admin/file-push/:id/ack ok=false (failed path on a 2nd task)
//   7. Operator-side: GET  /api/admin/file-push      (list — both visible)
//
// Two ack paths are exercised end-to-end so the per-target state
// machine (pending → claimed → delivered / failed) is observed in both
// directions. The 1st task targets a DC the mock agent claims as
// 'MOCK-HUBADSRV1'; the 2nd targets a server claimed as 'app-srv-01'
// (covers both targetType values in the schema).
//
// Usage:
//   ADMIN_TOKEN=... AGENT_TOKEN=... node mock-file-push.mjs
//
// Both endpoints live on the web port (default 8080) per server.js
// mount layout — admin router + agent router both wired to /api. The
// script defaults ADMIN_URL / AGENT_URL to that port; override via env
// if running against a non-standard deployment.
//
// Exit codes:
//   0 — all 7 steps succeeded
//   1 — at least one step failed (logs the failing step to stderr)

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const ADMIN_URL  = process.env.ADMIN_URL  ?? 'http://127.0.0.1:8080';
const AGENT_URL  = process.env.AGENT_URL  ?? 'http://127.0.0.1:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN env var required for the upload + ack steps.');
  console.error('Get one via: curl -s $ADMIN_URL/api/auth/login -H "Content-Type: application/json" -d \'{"username":"admin","password":"..."}\'');
  process.exit(2);
}

// Two agent hostnames — one for each ack path. Both are targets of the
// uploaded task; each task pushes to a single target so the per-target
// ack state machine has exactly one row to flip per task.
const AGENT_HOST_OK     = 'MOCK-HUBADSRV1';
const AGENT_HOST_FAILED = 'app-srv-01';
const AGENT_ID_OK       = 'mock-agent-hub-01';
const AGENT_ID_FAILED   = 'mock-agent-app-01';

// Deterministic test payload — small enough to fit comfortably under
// the JSON body limit (10 MB), large enough that SHA-256 actually has
// to be verified end-to-end. 256-byte ASCII header + 256-byte filler.
function makeTestPayload(label) {
  const head = Buffer.from(`# mock file-push payload (${label})\n# generated at ${new Date().toISOString()}\n`);
  const filler = Buffer.alloc(256, 0x20); // 256 spaces
  return Buffer.concat([head, filler]);
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ----- HTTP helpers -----

async function adminReq(path, { method = 'GET', body, headers = {} } = {}) {
  const url = `${ADMIN_URL}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...headers
    }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON (binary download) */ }
  return { status: res.status, ok: res.ok, data, text, headers: res.headers };
}

async function agentGet(path, { agentId, hostname } = {}) {
  const url = `${AGENT_URL}${path}` +
    (path.includes('?') ? '&' : '?') +
    `hostname=${encodeURIComponent(hostname ?? '')}` +
    (agentId ? `&agentId=${encodeURIComponent(agentId)}` : '');
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Agent-Token': AGENT_TOKEN,
      ...(agentId ? { 'X-Agent-Id': agentId } : {})
    },
    signal: AbortSignal.timeout(10_000)
  });
  return { status: res.status, ok: res.ok, text: await res.text(), headers: res.headers };
}

// File download — returns the raw bytes (octet-stream) + sha256 from
// the X-File-Sha256 header. SHA-256 mismatch with our locally-computed
// digest fails the step.
async function agentDownload(taskId, hostname) {
  const url = `${AGENT_URL}/api/agent/file-push/${encodeURIComponent(taskId)}/file?hostname=${encodeURIComponent(hostname)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Agent-Token': AGENT_TOKEN },
    signal: AbortSignal.timeout(30_000) // file body can take longer
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    ok: res.ok,
    bytes: buf,
    headerSha256: res.headers.get('x-file-sha256') || null,
    contentType: res.headers.get('content-type'),
    contentDisposition: res.headers.get('content-disposition')
  };
}

// ----- step logger -----

const STEP = (n, name) => console.log(`\n[STEP ${n}] ${name}`);
let failed = false;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ----- driver -----

async function runScenario({ label, hostname, agentId, ackOk, errorMessage }) {
  const payload = makeTestPayload(label);
  const sha256 = sha256Hex(payload);

  // STEP 1 — operator uploads the file
  STEP(1, `operator upload (target=${hostname}, sha256=${sha256.slice(0, 12)}…)`);
  const upload = await adminReq('/api/admin/file-push', {
    method: 'POST',
    body: {
      filename: `mock-${label}.bin`,
      contentB64: payload.toString('base64'),
      sha256,
      targetType: label.includes('dc') ? 'dc' : 'server',
      targets: [hostname],
      targetPath: 'C:\\tmp'
    }
  });
  check('upload returned 201', upload.status === 201, `status=${upload.status} body=${upload.text}`);
  if (!upload.ok) return null;
  const taskId = upload.data?.taskId;
  check('taskId returned', typeof taskId === 'string' && taskId.length > 0);
  check('sha256 echoed', upload.data?.sha256 === sha256);
  check('sizeBytes matches payload length', upload.data?.sizeBytes === payload.length);
  if (!taskId) return null;

  // STEP 2 — agent polls for tasks targeted at this hostname
  STEP(2, `agent poll (hostname=${hostname})`);
  const poll = await agentGet('/api/agent/file-push', { hostname, agentId });
  check('poll returned 200', poll.status === 200, `status=${poll.status} body=${poll.text}`);
  let pollData;
  try { pollData = JSON.parse(poll.text); } catch { pollData = null; }
  const pollTask = pollData?.tasks?.find(t => t.taskId === taskId);
  check('polled tasks[] contains our taskId', !!pollTask, `tasks=${JSON.stringify(pollData?.tasks?.map(t=>t.taskId))}`);
  check('poll task status is claimed', pollTask?.status === 'claimed');
  check('poll task filename matches', pollTask?.filename === `mock-${label}.bin`);

  // STEP 3 — agent downloads bytes, verifies SHA-256
  STEP(3, `agent download (taskId=${taskId})`);
  const dl = await agentDownload(taskId, hostname);
  check('download returned 200', dl.status === 200, `status=${dl.status}`);
  check('Content-Type is octet-stream', dl.contentType?.startsWith('application/octet-stream'));
  check('X-File-Sha256 header present', !!dl.headerSha256);
  const localSha = sha256Hex(dl.bytes);
  check('downloaded bytes sha256 matches upload', dl.headerSha256 === localSha && localSha === sha256);
  check('downloaded bytes length matches upload', dl.bytes.length === payload.length);

  // STEP 4 — operator re-fetches the task; the agent's poll should have
  // marked our hostname target as 'claimed' (targetStatus[0].status).
  STEP(4, `operator re-fetch task (verify target → 'claimed')`);
  const refetch = await adminReq(`/api/admin/file-push/${taskId}`);
  check('re-fetch returned 200', refetch.status === 200, `status=${refetch.status}`);
  const targetEntry = refetch.data?.targetStatus?.find(x => x.name === hostname);
  check('targetStatus row present for hostname', !!targetEntry);
  check('targetStatus.status === "claimed"', targetEntry?.status === 'claimed', `actual=${targetEntry?.status}`);
  check('targetStatus.claimedBy matches agentId', targetEntry?.claimedBy === agentId);

  // STEP 5/6 — operator ack (delivered OR failed)
  STEP(5, `operator ack ${ackOk ? 'ok=true (delivered)' : 'ok=false (failed)'}`);
  const ack = await adminReq(`/api/admin/file-push/${taskId}/ack`, {
    method: 'POST',
    body: {
      hostname,
      agentId,
      ok: ackOk,
      errorMessage: ackOk ? null : (errorMessage ?? 'mock write failure (permission denied)')
    }
  });
  check('ack returned 200', ack.status === 200, `status=${ack.status} body=${ack.text}`);
  check(`task.status === "${ackOk ? 'delivered' : 'failed'}"`, ack.data?.status === (ackOk ? 'delivered' : 'failed'));
  const ackTarget = ack.data?.targetStatus?.find(x => x.name === hostname);
  check(`targetStatus.status === "${ackOk ? 'delivered' : 'failed'}"`, ackTarget?.status === (ackOk ? 'delivered' : 'failed'));
  check('targetStatus.deliveredAt populated', !!ackTarget?.deliveredAt);
  if (!ackOk) check('errorMessage persisted', ackTarget?.errorMessage === errorMessage, `actual=${ackTarget?.errorMessage}`);

  return { taskId, finalStatus: ack.data?.status };
}

async function main() {
  console.log(`mock-file-push starting`);
  console.log(`  admin=${ADMIN_URL}  agent=${AGENT_URL}`);

  // STEP A — delivered path (DC target)
  const okRes = await runScenario({
    label: 'dc-delivered',
    hostname: AGENT_HOST_OK,
    agentId: AGENT_ID_OK,
    ackOk: true
  });

  // STEP B — failed path (server target)
  const failRes = await runScenario({
    label: 'server-failed',
    hostname: AGENT_HOST_FAILED,
    agentId: AGENT_ID_FAILED,
    ackOk: false,
    errorMessage: 'mock write failure (permission denied on C:\\tmp)'
  });

  // STEP 7 — list tasks; both should be visible
  STEP(7, 'list tasks — verify both tasks visible');
  const list = await adminReq('/api/admin/file-push');
  check('list returned 200', list.status === 200, `status=${list.status}`);
  const listData = list.data;
  check('list response is an array', Array.isArray(listData));
  if (Array.isArray(listData)) {
    const hasOk = listData.some(t => t.taskId === okRes?.taskId);
    const hasFail = listData.some(t => t.taskId === failRes?.taskId);
    check('list contains ok-task', hasOk);
    check('list contains fail-task', hasFail);
    const ourOk = listData.find(t => t.taskId === okRes?.taskId);
    const ourFail = listData.find(t => t.taskId === failRes?.taskId);
    check('list ok-task.status === delivered', ourOk?.status === 'delivered');
    check('list fail-task.status === failed', ourFail?.status === 'failed');
  }

  console.log(`\n${failed === 0 ? '✅ all checks passed' : `❌ ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('mock-file-push crashed:', e?.stack || e);
  process.exit(1);
});