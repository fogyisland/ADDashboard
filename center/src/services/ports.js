import { getDb } from '../db/index.js';

export function isValidPort(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export async function listPorts() {
  const db = getDb();
  const { rows } = await db.query(db.sql.ports.list);
  return rows;
}

export async function createPort({ port, label, sortOrder = 0 } = {}) {
  if (!isValidPort(port)) throw Object.assign(new Error('invalid port'), { httpStatus: 400 });
  if (!label || !String(label).trim()) throw Object.assign(new Error('label required'), { httpStatus: 400 });
  const db = getDb();
  try {
    const r = await db.execute(db.sql.ports.create, [port, String(label).trim(), sortOrder]);
    return { id: r.insertId ?? null };
  } catch (e) {
    if (e.code === 'DUP_ENTRY' || /duplicate/i.test(e.message)) {
      throw Object.assign(new Error('port already exists'), { httpStatus: 409 });
    }
    throw e;
  }
}

export async function updatePort(id, partial = {}) {
  const fields = [];
  const params = [];
  if (partial.port !== undefined) {
    if (!isValidPort(partial.port)) throw Object.assign(new Error('invalid port'), { httpStatus: 400 });
    fields.push('port = ?'); params.push(partial.port);
  }
  if (partial.label !== undefined) {
    if (!String(partial.label).trim()) throw Object.assign(new Error('label required'), { httpStatus: 400 });
    fields.push('label = ?'); params.push(String(partial.label).trim());
  }
  if (partial.sortOrder !== undefined) {
    fields.push('sort_order = ?'); params.push(partial.sortOrder);
  }
  if (fields.length === 0) throw Object.assign(new Error('no fields to update'), { httpStatus: 400 });
  params.push(id);
  const db = getDb();
  const sqlText = db.sql.ports.updatePartial(fields);
  const { affectedRows } = await db.execute(sqlText, params);
  return affectedRows > 0;
}

export async function deletePort(id) {
  const db = getDb();
  const { affectedRows } = await db.execute(db.sql.ports.delete, [id]);
  return affectedRows > 0;
}

export async function getPortStatusesForAgent(agentId) {
  const db = getDb();
  const { rows } = await db.query(db.sql.ports.listForAgent, [agentId]);
  return rows;
}