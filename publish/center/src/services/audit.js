import { getDb } from '../db/index.js';
import {
  CATEGORY_ACTIONS, SEVERITY_ACTIONS, TARGET_LABEL, classifyAction
} from './audit-classifier.js';

export async function writeAudit({ userId, action, target, payload }, logger) {
  const db = getDb();
  try {
    await db.execute(db.sql.audit.write, [
      userId ?? null,
      action,
      target ?? null,
      payload == null ? null : JSON.stringify(payload)
    ]);
  } catch (e) {
    if (logger) logger.warn({ err: e.message, action, target }, 'audit write failed (best-effort)');
  }
}

function buildWhere({ category, actions, severities, userId, from, to }) {
  const conds = [];
  const params = [];
  if (category) {
    const list = CATEGORY_ACTIONS.get(category);
    if (!list) throw Object.assign(new Error('invalid category'), { httpStatus: 400 });
    conds.push(`a.action IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (Array.isArray(actions) && actions.length) {
    conds.push(`a.action IN (${actions.map(() => '?').join(',')})`);
    params.push(...actions);
  }
  if (Array.isArray(severities) && severities.length) {
    const list = severities.flatMap(s => SEVERITY_ACTIONS.get(s) ?? []);
    if (list.length) {
      conds.push(`a.action IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (Number.isInteger(userId)) { conds.push('a.user_id = ?'); params.push(userId); }
  if (from) { conds.push('a.created_at >= ?'); params.push(from); }
  if (to)   { conds.push('a.created_at <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, params };
}

function parsePayload(raw, logger) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) {
    logger?.warn?.({ err: e.message }, 'audit payload parse failed');
    return null;
  }
}

export async function listAudit({ category, actions, severities, userId, from, to, page = 1, size = 100 } = {}) {
  const db = getDb();
  const { where, params } = buildWhere({ category, actions, severities, userId, from, to });
  const { rows: countRows } = await db.query(`${db.sql.audit.count} ${where}`, params);
  const total = Number(countRows[0].total);
  const offset = (page - 1) * size;
  const listParams = [...params, size, offset];
  const { rows } = await db.query(db.sql.audit.list(where), listParams);
  return {
    rows: rows.map(r => ({
      id: r.id,
      userId: r.userId,
      username: r.username ?? null,
      action: r.action,
      actionLabel: classifyAction(r.action).label,
      category: classifyAction(r.action).category,
      severity: classifyAction(r.action).severity,
      target: r.target,
      targetLabel: r.target ? (TARGET_LABEL.get(r.target) ?? r.target) : null,
      payload: parsePayload(r.payload),
      createdAt: r.createdAt
    })),
    total,
    filtered: total,
    page,
    size
  };
}

export async function getAuditBadge(category) {
  const list = CATEGORY_ACTIONS.get(category);
  if (!list) throw Object.assign(new Error('invalid category'), { httpStatus: 400 });
  const db = getDb();
  const { rows } = await db.query(db.sql.audit.badge(list), list);
  return Number(rows[0].total);
}