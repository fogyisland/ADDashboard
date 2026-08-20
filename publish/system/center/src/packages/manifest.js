// Package manifest validation. Strict ajv schema with additionalProperties:false
// so unknown fields reject installs with PKG_INVALID_MANIFEST (400).
//
// JSON Schema draft-07 — params.schema is validated as draft-07 at admin-edit
// time (v2 plan dependency). This module only validates the top-level shape;
// params.schema is a free-form object here and gets re-validated when the
// admin UI generates the form.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const manifestSchema = {
  type: 'object',
  required: ['name', 'version', 'type'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: '^[a-z0-9-]+(\\.[a-z0-9-]+)*$' },
    version: { type: 'string' },  // SemVer validated by caller via semver lib
    type: { enum: ['gauge', 'counter', 'timeseries', 'status'] },
    description: { type: 'string' },
    author: { type: 'string' },
    license: { type: 'string' },
    agent: {
      type: 'object',
      required: ['minVersion', 'script', 'intervalSec'],
      additionalProperties: false,
      properties: {
        // Optional agent runtime type. Defaults to "ad" when omitted (existing
        // manifests are unaffected). "non-ad" is required for member-server
        // packages (e.g. ad_os_baseline); the agent runtime reads this to
        // pick the right loop. WPF package designer also exposes this as a
        // dropdown in the manifest form.
        type: { enum: ['ad', 'non-ad'], default: 'ad' },
        minVersion: { type: 'string' },
        platforms: { type: 'array', items: { enum: ['windows'] } },
        runtime: { enum: ['powershell'] },
        script: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
        intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
      },
    },
    center: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minVersion: { type: 'string' },
        maxVersion: { type: 'string' },
      },
    },
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'label'],
        additionalProperties: false,
        properties: {
          key: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
          label: { type: 'string' },
          unit: { type: 'string' },
          thresholds: {
            type: 'object',
            additionalProperties: false,
            properties: { warn: { type: 'number' }, crit: { type: 'number' } },
          },
        },
      },
    },
    params: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schema: { type: 'object' },  // JSON Schema draft-07 (validated at runtime when admin edits)
        required: { type: 'array', items: { type: 'string' } },
      },
    },
    // Editor-only per-metric user overrides (label/unit/thresholds). The
    // agent runtime ignores this block; center preserves it through install
    // so edits survive package re-imports. WPF designer's pre-flight schema
    // mirror also accepts this field (D3 round-trip fix).
    metricOverrides: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          unit: { type: 'string' },
          warn: { type: 'number' },
          crit: { type: 'number' },
        },
      },
    },
    widget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { enum: ['builtin'] },
        component: { enum: ['GaugeTile', 'CounterTile', 'TimeseriesTile', 'StatusTile'] },
      },
    },
    dependencies: { type: 'array', items: { type: 'object' } },
    database: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaName', 'migrations', 'metricTable', 'metricSchema'],
      properties: {
        schemaName: {
          type: 'string',
          // pkg_<name-with-dashes-as-underscores>; installer defaults to this if omitted,
          // but in the manifest it's required so the author is explicit.
          pattern: '^pkg_[a-z0-9_]+$'
        },
        migrations: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', minLength: 1 }
        },
        metricTable: {
          type: 'string',
          pattern: '^[a-z0-9_]+$'
        },
        metricSchema: {
          type: 'object',
          minProperties: 3,             // at least agent_id + ts + 1 user column
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            required: ['type'],
            properties: {
              type: {
                type: 'string',
                // canonical vocabulary — match ddl-sandbox.normalizeType() output.
                // Single source of truth: see task 1's normalizeType.
                pattern: '^(int|integer|bigint|smallint|tinyint|varchar\\(\\d+\\)|char\\(\\d+\\)|text|nvarchar\\(\\d+\\)|ntext|double|float|decimal\\(\\d+,\\d+\\)|numeric\\(\\d+,\\d+\\)|datetime|timestamp|datetimeoffset|date|json|boolean|bit)$'
              },
              nullable: { type: 'boolean' }
            }
          },
          // ajv can't easily express "agent_id and ts must be present with nullable=false" in pure JSON Schema;
          // enforce in post-validation hook below.
        }
      }
    }
  },
};

const validate = ajv.compile(manifestSchema);

// Post-validation hook: enforce metricSchema must include agent_id and ts with nullable=false.
// Pure ajv JSON Schema cannot express "key presence + value constraint" easily, so we layer
// this check on top of the schema-validated shape.
function extraCheck(m) {
  if (m && m.database && m.database.metricSchema) {
    const s = m.database.metricSchema;
    if (!s.agent_id || s.agent_id.nullable !== false) return 'database.metricSchema.agent_id must exist with nullable=false';
    if (!s.ts || s.ts.nullable !== false) return 'database.metricSchema.ts must exist with nullable=false';
  }
  return null;
}

export function validateManifest(m) {
  const valid = validate(m);
  if (!valid) return { valid: false, errors: validate.errors || [] };
  const extra = extraCheck(m);
  if (extra) return { valid: false, errors: [{ instancePath: '/database/metricSchema', message: extra }] };
  return { valid: true, errors: [] };
}

export { manifestSchema };
