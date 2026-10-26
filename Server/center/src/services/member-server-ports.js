// center/src/services/member-server-ports.js
// R158.74 (2026-10-11) — MemberServer 业务端口 service. 跟 account-change
//   service 同 shape (normalize + upsert + list + delete). 公共表 pattern,
//   中心端 MERGE ON (hostname, port) 自动 dedup.
//
// admin 手填端口 (file-server / web / database / app-server / custom),
// 后续 NoAD agent push 时再扩 (中心端加 probe 字段).

const VALID_SERVICE_TYPES = new Set(['file-server', 'web', 'database', 'app-server', 'custom']);

function normalizePort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function normalizeServiceType(t) {
  if (typeof t !== 'string') return null;
  const lower = t.trim().toLowerCase();
  return VALID_SERVICE_TYPES.has(lower) ? lower : null;
}

export function normalizeEntry(input) {
  const hostname = String(input?.hostname || '').trim();
  if (!hostname) return { error: 'hostname required' };
  const port = normalizePort(input?.port);
  if (port == null) return { error: 'port must be integer 1-65535' };
  const serviceType = normalizeServiceType(input?.service_type);
  if (!serviceType) return { error: 'service_type must be one of file-server|web|database|app-server|custom' };
  const note = input?.note ? String(input.note).trim() : null;
  return { hostname, port, serviceType, note };
}

export async function upsert(db, entry, log) {
  const spec = db.sql.memberServerPorts.upsert;
  const params = [entry.hostname, entry.port, entry.serviceType, entry.note];
  await db.execute(spec, params);
  return { upserted: 1 };
}

export async function listAll(db, log) {
  const { rows } = await db.query(db.sql.memberServerPorts.listAll);
  return rows || [];
}

export async function listByHostname(db, hostname, log) {
  const spec = db.sql.memberServerPorts.listByHostname;
  const { rows } = await db.query(spec, [hostname]);
  return rows || [];
}

export async function deleteByPk(db, hostname, port, log) {
  const spec = db.sql.memberServerPorts.deleteByPk;
  await db.execute(spec, [hostname, port]);
  return { deleted: 1 };
}

export async function deleteByHostname(db, hostname, log) {
  const spec = db.sql.memberServerPorts.deleteByHostname;
  await db.execute(spec, [hostname]);
  return { deleted: 1 };
}