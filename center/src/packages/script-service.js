// Script + Policy service — used by the admin router (task 7) and the
// builtin seeder (task 9).
//
// R66 split: the legacy `installed_packages` single table becomes
// `package_scripts` (immutable-ish content: script body + sha256 +
// manifest) + `package_policies` (operator-tunable: intervalSec /
// timeoutMs / enabled / params / scope). This service is the ONLY public
// write surface over that pair — routes and the seeder call these four
// functions instead of touching SQL directly.
//
// Replaces center/src/packages/installer.js for V1 (installer.js keeps its
// legacy ZIP install path around for the V1 transition; it is removed in
// task 10 once router + seeder migrate).
//
// Audit: `writeAudit` is injected by the caller as a plain function
// parameter — the service never imports an audit module. That keeps the
// module graph acyclic (script-service is strictly downstream of db/sql)
// and makes the tests trivial (assert the recorder array).
//
// 2026-08-29: initial implementation for R66 task-5.

import crypto from 'node:crypto';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { PkgError } from './errors.js';

const MAX_SCRIPT_BYTES = 1024 * 1024; // 1 MB
const VALID_SCOPES = ['global', 'agent_type:ad', 'agent_type:non-ad'];
const VALID_TYPES = ['gauge', 'counter', 'status', 'timeseries'];
const VALID_AGENT_TYPES = ['ad', 'non-ad'];

const DEFAULT_INTERVAL_SEC = 3600;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SOURCE = 'admin-upload';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function validateScriptBody(content) {
  if (typeof content !== 'string') {
    throw new PkgError('INVALID_CONTENT', 'script content must be string');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SCRIPT_BYTES) {
    throw new PkgError('SCRIPT_TOO_LARGE', `script too large (${bytes} > ${MAX_SCRIPT_BYTES})`);
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,127}$/i.test(name)) {
    throw new PkgError('INVALID_NAME', `invalid package name: ${name}`);
  }
}

// The manifest deliberately carries NO intervalSec / timeoutMs — those are
// policy fields now and live in package_policies so the operator can retune
// them without rewriting the script row.
function buildManifest({ name, type, agentType, description }) {
  return {
    name,
    version: '1.0.0',
    type,
    description: description || '',
    schemaVersion: 1,
    agent: {
      type: agentType,
      script: 'collect.ps1'
      // NOTE: intervalSec and timeoutMs live in package_policies V1+
    }
  };
}

export async function installScript({
  db, name, content, type, agentType, description,
  intervalSec, timeoutMs, source = DEFAULT_SOURCE, writeAudit
}) {
  validateName(name);
  validateScriptBody(content);
  if (!VALID_TYPES.includes(type)) {
    throw new PkgError('INVALID_TYPE', `invalid type: ${type}`);
  }
  if (!VALID_AGENT_TYPES.includes(agentType)) {
    throw new PkgError('INVALID_AGENT_TYPE', `invalid agentType: ${agentType}`);
  }

  const existing = await packageScripts.get(db, name);
  if (existing) {
    throw new PkgError('PACKAGE_EXISTS', `package '${name}' already exists`);
  }

  const resolvedSource = source ?? DEFAULT_SOURCE;
  const scriptSha = sha256Hex(Buffer.from(content, 'utf8'));
  const manifest = buildManifest({ name, type, agentType, description });

  // 1. INSERT script
  await packageScripts.upsert(db, {
    name,
    version: manifest.version,
    scriptContent: content,
    scriptSha256: scriptSha,
    manifest,
    source: resolvedSource
  });
  // 2. INSERT policy (default enabled=false so the operator can review before running)
  await packagePolicies.upsert(db, {
    name,
    intervalSec: intervalSec ?? DEFAULT_INTERVAL_SEC,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    enabled: false,
    params: null,
    scope: 'global'
  });

  if (writeAudit) {
    await writeAudit({
      action: 'upload_script',
      targetType: 'packages',
      targetId: name,
      details: { name, scriptSha: scriptSha.slice(0, 8), source: resolvedSource }
    });
  }
  return { name, version: manifest.version, scriptSha };
}

export async function editScript({ db, name, content, writeAudit }) {
  validateName(name);
  validateScriptBody(content);

  const existing = await packageScripts.get(db, name);
  if (!existing) {
    throw new PkgError('PACKAGE_NOT_FOUND', `package '${name}' not found`);
  }

  const newSha = sha256Hex(Buffer.from(content, 'utf8'));
  if (newSha === existing.scriptSha256) {
    // No-op — same content. Skip audit + skip UPDATE to avoid noise.
    return { name, oldSha: existing.scriptSha256, newSha, updatedAt: existing.updatedAt, noOp: true };
  }

  const oldSha = existing.scriptSha256;
  await packageScripts.updateScript(db, { name, scriptContent: content, scriptSha256: newSha });

  if (writeAudit) {
    await writeAudit({
      action: 'edit_script',
      targetType: 'packages',
      targetId: name,
      details: { name, oldSha: oldSha.slice(0, 8), newSha: newSha.slice(0, 8) }
    });
  }
  return { name, oldSha, newSha, updatedAt: new Date(), noOp: false };
}

export async function setPolicy({ db, name, intervalSec, timeoutMs, enabled, params, scope, writeAudit }) {
  validateName(name);

  const fields = {};
  if (intervalSec !== undefined) {
    const n = Number(intervalSec);
    if (!Number.isInteger(n) || n < 5 || n > 86400) {
      throw new PkgError('INVALID_INTERVAL', `intervalSec must be integer 5..86400 (got ${n})`);
    }
    fields.intervalSec = n;
  }
  if (timeoutMs !== undefined) {
    const n = Number(timeoutMs);
    if (!Number.isInteger(n) || n < 1000 || n > 600000) {
      throw new PkgError('INVALID_TIMEOUT', `timeoutMs must be integer 1000..600000 (got ${n})`);
    }
    fields.timeoutMs = n;
  }
  if (enabled !== undefined) fields.enabled = !!enabled;
  if (params !== undefined) fields.params = params;
  if (scope !== undefined) {
    if (!VALID_SCOPES.includes(scope)) {
      throw new PkgError('INVALID_SCOPE', `scope must be one of ${VALID_SCOPES.join('|')} (got '${scope}')`);
    }
    fields.scope = scope;
  }
  if (Object.keys(fields).length === 0) {
    throw new PkgError('EMPTY_POLICY', 'setPolicy: no fields provided');
  }

  await packagePolicies.updatePartial(db, name, fields);

  if (writeAudit) {
    await writeAudit({
      action: 'set_policy',
      targetType: 'packages',
      targetId: name,
      details: { name, fields: Object.keys(fields) }
    });
  }
  return { name, fields, updatedAt: new Date() };
}

export async function deleteScript({ db, name, writeAudit }) {
  validateName(name);
  const existing = await packageScripts.get(db, name);
  if (!existing) {
    throw new PkgError('PACKAGE_NOT_FOUND', `package '${name}' not found`);
  }
  // Delete from BOTH tables explicitly (FK cascade handles policy under
  // MySQL but not always under MSSQL if the FK is set with NO ACTION; the
  // explicit DELETE is the safe universal path).
  await packagePolicies.delete(db, name);
  await packageScripts.delete(db, name);

  if (writeAudit) {
    await writeAudit({
      action: 'delete_script',
      targetType: 'packages',
      targetId: name,
      details: { name, deleted: { script: true, policy: true } }
    });
  }
  return { name, deleted: { script: true, policy: true } };
}

export const __testHelpers = {
  buildManifest,
  validateName,
  validateScriptBody,
  sha256Hex,
  VALID_SCOPES,
  VALID_TYPES,
  VALID_AGENT_TYPES,
  MAX_SCRIPT_BYTES
};
