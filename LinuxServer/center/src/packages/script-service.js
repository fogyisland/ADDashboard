// Script + Policy service — used by the admin router (T7) and the
// builtin seeder (T9).
//
// R66 split: the legacy `installed_packages` single table becomes
// `package_scripts` (immutable-ish content: script body + sha256 +
// manifest) + `package_policies` (operator-tunable: intervalSec /
// timeoutMs / enabled / params / scope). This service is the ONLY public
// write surface over that pair — routes and the seeder call these four
// functions instead of touching SQL directly.
//
// R67-T1: added `getScript` — read-only view path that returns the
// script body without exposing the surrounding `installed_packages`
// row. Closes the R66-T10 data-loss pattern where the EditScriptModal
// opened with an empty textarea (because the list endpoint doesn't
// ship script_content) and the operator had no way to see what was
// already there before pasting a replacement. The new `viewMode` in
// the modal calls this and locks the textarea.
//
// Audit: `writeAudit` is injected by the caller as a plain function
// parameter — the service never imports an audit module. That keeps the
// module graph acyclic (script-service is strictly downstream of db/sql)
// and makes the tests trivial (assert the recorder array). T13 retired
// the T7 server.js adapter — script-service now emits the real
// audit.js shape ({action, target, payload}) directly.
//
// 2026-08-29: initial implementation for R66 task-5.
// 2026-08-29: T13 — emit real audit.js shape directly (T7 adapter retired).
// 2026-08-30: R67-T1 — add getScript() + view_script audit.
// 2026-09-26: R111 — add getPackageDetail({ db, name }) — returns
//              { package, recentRuns } for GET /api/admin/packages/:name.
//              Closes the R66-T13 V0→V1 regression where the legacy
//              detail endpoint was retired but the new V1 endpoint was
//              never added. PackageEditView.vue expects this exact
//              shape on line 144 — without it, every detail page
//              errors with a 404 load failure. See
//              progress_2026_09_26_r111_package_detail_endpoint.md.

import crypto from 'node:crypto';
import { packageRuns } from '../db/sql/package-runs.js';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { getDb } from '../db/index.js';
import { PkgError } from './errors.js';

const MAX_SCRIPT_BYTES = 1024 * 1024; // 1 MB
const VALID_SCOPES = ['global', 'agent_type:ad', 'agent_type:non-ad'];
// R158.56c (2026-10-08) — 加 'command' 让 3 个 ADUC 写动作包能通过 installScript.
// R158.46b 当时移除这 3 个包时假设 'command' 阻塞 abort (per-package try/catch
// 之前), R158.50.7i-fix 已加 per-package 隔离, 但 VALID_TYPES 仍不含 'command',
// installScript 仍然 throw. 修复: 加 'command'. 这是 type 值, 不是路径 —
// command 类型包 (ad_ad_ou_create 等) 不进 metricstore ETL (R47 + runner.js:619
// etl 路径只对 gauge/counter/status/timeseries 起作用), 走 ad_admin_commands
// 单独 lifecycle 表, 数据流已完全分离.
const VALID_TYPES = ['gauge', 'counter', 'status', 'timeseries', 'command'];
const VALID_AGENT_TYPES = ['ad', 'non-ad'];

const DEFAULT_INTERVAL_SEC = 3600;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SOURCE = 'admin-upload';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// R152 — append-only history writer. Called by installScript / editScript
// after the main package_scripts row is upserted. Best-effort: a failure
// here MUST NOT fail the user-visible operation (the operator's upload
// already succeeded against the main table, the history row is just
// observability). Errors are logged and swallowed so we never break the
// primary ingest path. (Same philosophy as the orphan-schemas cleanup
// helper — observability never wins over availability.)
//
// R158.60.9 (2026-10-09) — exported so builtin-packages.js seeder can
// append a history row when packageScripts.upsert path runs (built-in
// upgrade + content refresh). Pre-fix only installScript/editScript
// wrote history, so all built-in version bumps (8 published versions of
// ad_failed_logon_collector 1.0.0→1.0.8 with no admin edits) showed
// up as a single 1.0.0 row in /admin/packages history. Operator visual
// confirmation in diag-r15860-9-history-count.mjs.
export async function recordPublish({ name, version, scriptSha256, manifest, source }) {
  try {
    const db = getDb();
    const dialect = db.dialect;
    if (dialect === 'mssql') {
      // No INSERT IGNORE on MSSQL — guard with an existence check so
      // re-publishing the same (name, version, sha) is a clean no-op.
      const exists = await db.query(
        `SELECT 1 AS hit FROM package_scripts_history
          WHERE name = ? AND version = ? AND script_sha256 = ?`,
        [name, version, scriptSha256]
      );
      if (exists.rows?.[0]?.hit) return;
      await db.query(
        `INSERT INTO package_scripts_history
          (name, version, script_sha256, manifest_json, source, published_at)
          VALUES (?, ?, ?, ?, ?, SYSUTCDATETIME())`,
        [name, version, scriptSha256, JSON.stringify(manifest), source]
      );
    } else {
      // MySQL — INSERT IGNORE handles the UNIQUE(name, version, sha)
      // collision natively. affectedRows=0 on duplicate is fine.
      await db.query(
        `INSERT IGNORE INTO package_scripts_history
          (name, version, script_sha256, manifest_json, source, published_at)
          VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [name, version, scriptSha256, JSON.stringify(manifest), source]
      );
    }
  } catch (e) {
    // Observability failure must not roll back the user-visible upload.
    // eslint-disable-next-line no-console
    console.error('[R152] recordPublish failed', { name, version, source, err: e?.message || String(e) });
  }
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

// R130 — validate a manifest override so the caller (currently only the
// builtin seeder) can't sneak an unexpected shape past installScript.
// Required keys mirror the installScript public surface; the `database`
// block (when present) is what flips the package onto the v2 metricstore
// path (metricstore.ingestRunV2 keys off `manifest.database.metricTable`).
// Without this guard, a malformed override silently makes ingestRun fall
// back to the v1 path and the package's `pkg_<name>.metrics` table never
// receives a single row — the exact failure mode R130 surfaced for
// ad_lockout_summary (DcCard.vue shows '—' for lockedCount forever).
function validateManifest(manifest, name) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new PkgError('INVALID_MANIFEST', `installScript: manifest override must be an object`);
  }
  if (manifest.name !== name) {
    throw new PkgError('INVALID_MANIFEST', `installScript: manifest.name ${manifest.name} does not match package ${name}`);
  }
  if (manifest.database !== undefined) {
    const db = manifest.database;
    if (typeof db !== 'object' || db === null || Array.isArray(db)) {
      throw new PkgError('INVALID_MANIFEST', `installScript: manifest.database must be an object`);
    }
    if (typeof db.schemaName !== 'string' || !/^pkg_[a-z0-9_]+$/.test(db.schemaName)) {
      throw new PkgError('INVALID_MANIFEST', `installScript: manifest.database.schemaName must match /^pkg_[a-z0-9_]+$/`);
    }
    if (typeof db.metricTable !== 'string' || !/^[a-z][a-z0-9_]*$/.test(db.metricTable)) {
      throw new PkgError('INVALID_MANIFEST', `installScript: manifest.database.metricTable must match /^[a-z][a-z0-9_]*$/`);
    }
    if (typeof db.metricSchema !== 'object' || db.metricSchema === null || Array.isArray(db.metricSchema)) {
      throw new PkgError('INVALID_MANIFEST', `installScript: manifest.database.metricSchema must be an object`);
    }
  }
}

export async function installScript({
  db, name, content, type, agentType, description,
  intervalSec, timeoutMs, source = DEFAULT_SOURCE, writeAudit,
  // R130 — optional caller-supplied manifest. When set, installScript
  // uses it instead of buildManifest() so callers that have the full
  // raw manifest.json (e.g. seedBuiltinPackages for built-in packages
  // with a `database` block) can persist the v2 metricstore keys intact.
  // The admin upload path doesn't pass this and continues to get a
  // minimal stub — admin uploads don't carry a `database` block anyway,
  // so v1 metric_* tables remain their landing zone.
  manifest: manifestOverride,
  // R158.86.5 (2026-10-12) — package_policies.scope 拆细. Caller
  // (e.g. builtin-packages seeder) passes explicit scope; admin upload
  // path 不传 → derived from agentType (ad → 'agent_type:ad',
  // non-ad → 'agent_type:non-ad'). Default 'global' 仅 fallback.
  scope: scopeOverride = null
}) {
  validateName(name);
  validateScriptBody(content);
  if (!VALID_TYPES.includes(type)) {
    throw new PkgError('INVALID_TYPE', `invalid type: ${type}`);
  }
  if (!VALID_AGENT_TYPES.includes(agentType)) {
    throw new PkgError('INVALID_AGENT_TYPE', `invalid agentType: ${agentType}`);
  }
  if (manifestOverride !== undefined) {
    validateManifest(manifestOverride, name);
  }

  const existing = await packageScripts.get(db, name);
  if (existing) {
    throw new PkgError('PACKAGE_EXISTS', `package '${name}' already exists`);
  }

  const resolvedSource = source ?? DEFAULT_SOURCE;
  const scriptSha = sha256Hex(Buffer.from(content, 'utf8'));
  // R130 — caller-supplied manifest (e.g. raw manifest.json from
  // seedBuiltinPackages) wins over the stub built from individual
  // installScript args. The stub loses the `database` block which is
  // what flips metricstore onto the v2 path, so without this preference
  // a v2 package like ad_lockout_summary would silently never receive
  // any metric rows (DcCard.vue shows '—' for lockedCount).
  const manifest = manifestOverride ?? buildManifest({ name, type, agentType, description });

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
  // R158.86.5 — scope 拆细: caller-provided scope wins; else derive
  // from agentType; else 'global' fallback. 拆细后 AD agent 不会收
  // 'agent_type:non-ad' 包 (跟 member_* 错推 30s 假跑同根因).
  const derivedScope = agentType === 'ad' ? 'agent_type:ad'
    : agentType === 'non-ad' ? 'agent_type:non-ad'
    : 'global';
  const finalScope = scopeOverride ?? derivedScope;
  await packagePolicies.upsert(db, {
    name,
    intervalSec: intervalSec ?? DEFAULT_INTERVAL_SEC,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    enabled: false,
    params: null,
    scope: finalScope
  });
  // R152 — dual-write to the history table so /api/admin/packages/:name/history
  // can show "this package was first installed at T by source X with sha Y".
  // Skipped if manifestOverride was provided with a different version than
  // what we just persisted — but we use manifest.version consistently, so
  // this should be in sync with the main row.
  await recordPublish({
    name, version: manifest.version, scriptSha256: scriptSha,
    manifest, source: resolvedSource
  });

  if (writeAudit) {
    await writeAudit({
      action: 'upload_script',
      target: 'packages',
      payload: { name, scriptSha: scriptSha.slice(0, 8), source: resolvedSource }
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

  // R152 — append the new sha + manifest to history. The version field
  // stays the same on editScript (manifest.version isn't bumped by an
  // edit — that's the publish-script's job), so the UNIQUE
  // (name, version, script_sha256) key is fresh here because newSha
  // differs from oldSha. recordPublish is best-effort.
  await recordPublish({
    name, version: existing.version, scriptSha256: newSha,
    manifest: existing.manifest, source: existing.source
  });

  if (writeAudit) {
    await writeAudit({
      action: 'edit_script',
      target: 'packages',
      payload: { name, oldSha: oldSha.slice(0, 8), newSha: newSha.slice(0, 8) }
    });
  }
  return { name, oldSha, newSha, updatedAt: new Date(), noOp: false };
}

export async function setPolicy({ db, name, intervalSec, timeoutMs, enabled, params, scope, cronExpr, writeAudit }) {
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
  // R158.72.x.13 (2026-10-17) — +cronExpr 字段 (跟 R158.60.10 intervalSec
  //   1:1 平行, 5-field cron 字符串 e.g. '0 2 * * *' 或 null 透传).
  //   null = 撤 (走 R158.72.x.11 self-interval anchor 范式, agent 0.1.0
  //   setInterval 24h 1 拍, 0 中心端 cron fire). string = 走中心端 cron
  //   fire (R158.72.x.13 ship 闭合 范式, 6 包 daily 2:00 + Jitter
  //   0~30min per-DC). 0 必严格 5-field 校验 (前端已 Ajv 限 type, server
  //   端只做长度 0~64 跟 column 一致, 跟 R158.72.x.5 jitter_at NULL 1:1
  //   平行). 0 改 R158.86.6 #5 (1 view 1 endpoint 1:1, 复用既 PUT policy
  //   端点).
  if (cronExpr !== undefined) {
    if (cronExpr !== null && typeof cronExpr !== 'string') {
      throw new PkgError('INVALID_CRON_EXPR', `cronExpr must be string or null (got ${typeof cronExpr})`);
    }
    if (typeof cronExpr === 'string' && cronExpr.length > 64) {
      throw new PkgError('INVALID_CRON_EXPR', `cronExpr must be 0..64 chars (got ${cronExpr.length})`);
    }
    fields.cronExpr = cronExpr;
  }
  if (Object.keys(fields).length === 0) {
    throw new PkgError('EMPTY_POLICY', 'setPolicy: no fields provided');
  }

  await packagePolicies.updatePartial(db, name, fields);

  if (writeAudit) {
    await writeAudit({
      action: 'set_policy',
      target: 'packages',
      payload: { name, fields: Object.keys(fields) }
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
      target: 'packages',
      payload: { name, deleted: { script: true, policy: true } }
    });
  }
  return { name, deleted: { script: true, policy: true } };
}

// Read-only view of the current script body. R67-T1 closes the
// R66-T10 data-loss gap: the edit modal opens with an empty textarea
// because the list endpoint intentionally omits script_content (LONGTEXT
// would balloon the payload), and before this method there was no API
// for the frontend to ask "what's currently installed?". The view-mode
// of EditScriptModal calls this and locks the textarea so the operator
// can read the script before choosing to edit.
//
// Returns ONLY the script-side fields (no policy). Audit is emitted
// (low severity, category 'changes') because every view is an admin
// read of the deployed PowerShell — same audit footprint as the 4
// write actions, but no schema mutation.
export async function getScript({ db, name, writeAudit }) {
  validateName(name);
  const existing = await packageScripts.get(db, name);
  if (!existing) {
    throw new PkgError('PACKAGE_NOT_FOUND', `package '${name}' not found`);
  }
  if (writeAudit) {
    await writeAudit({
      action: 'view_script',
      target: 'packages',
      payload: { name, scriptSha: existing.scriptSha256.slice(0, 8) }
    });
  }
  return {
    name: existing.name,
    version: existing.version,
    scriptContent: existing.scriptContent,
    scriptSha256: existing.scriptSha256,
    source: existing.source,
    updatedAt: existing.updatedAt
  };
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

// Test-only constant used by router tests to assert the audit-action
// emitted by getScript without re-importing the audit-classifier.
export const VIEW_SCRIPT_AUDIT_ACTION = 'view_script';

// R111 — read-only composite view of (script + policy + recent runs) for
// the admin detail page. Joined at the service layer because the two
// tables are read-only here (the /api/admin/packages list endpoint
// performs the same join but inline; here we additionally need the
// recentRuns list which is an N+1 join if done inline).
//
// 404 semantics match getScript / deleteScript: PACKAGE_NOT_FOUND if
// packageScripts.get() returns null. A missing policy row degrades to
// safe defaults (matches /api/admin/packages list shape at
// router.js:120-137) — the package still surfaces for inspection even
// if its policy hasn't been seeded yet.
//
// `limit` defaults to 20 to keep the detail-page payload bounded; the
// list endpoint uses 200 across ALL packages (dashboard.js:1006). The
// /admin/packages edit page is single-package so 20 is plenty.
//
// No audit emission on read — only getScript writes a `view_script`
// audit (R67-T1). Composite reads of policy + runs are lower-stakes
// and would create audit noise if logged every page load.
export async function getPackageDetail({ db, name }) {
  validateName(name);

  const script = await packageScripts.get(db, name);
  if (!script) {
    throw new PkgError('PACKAGE_NOT_FOUND', `package '${name}' not found`);
  }

  // Policy is optional — fall back to safe defaults so the detail page
  // still renders if the policy row is missing (e.g. partial seeder
  // run before the policy was committed). Mirrors the list endpoint's
  // `policyByName.get(s.name) || {}` pattern at router.js:121.
  const policy = await packagePolicies.getByName(db, name);
  const p = policy || {};

  const recentRuns = await packageRuns.listRecent(db, { packageName: name, limit: 20 });

  return {
    package: {
      name: script.name,
      version: script.version,
      type: script.manifest?.type || 'gauge',
      agentType: script.manifest?.agent?.type || 'ad',
      enabled: !!p.enabled,
      intervalSec: p.intervalSec ?? null,
      timeoutMs: p.timeoutMs ?? null,
      params: p.params ?? null,
      scope: p.scope ?? 'global',
      // R158.72.x.13 (2026-10-17) — getPackageDetail 返 cronExpr 字段.
      //   跟 /api/admin/packages 列表 端点 1:1 平行 hydrate. NULL = 走
      //   R158.72.x.11 self-interval anchor 范式, '0 2 * * *' = 走中心端
      //   cron fire. 前端 PackageEditView 0 必改 (R158.77.1 锁, 0 引新
      //   column / 0 引新 input), 操作员能通过既 /admin/packages 表查
      //   看 (跟 R158.72.x.6 中文化 1:1 平行 0 引新 view).
      cronExpr: p.cronExpr ?? null,
      source: script.source,
      scriptSha256: script.scriptSha256,
      manifest: script.manifest,
      updatedAt: script.updatedAt,
      installed_at: script.createdAt ?? null
    },
    recentRuns: Array.isArray(recentRuns) ? recentRuns : []
  };
}
