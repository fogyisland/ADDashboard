// Package manifest validation. Strict ajv schema with additionalProperties:false
// so unknown fields reject installs with PKG_INVALID_MANIFEST (400).
//
// JSON Schema draft-07 — params.schema is validated as draft-07 at admin-edit
// time (v2 plan dependency). This module only validates the top-level shape;
// params.schema is a free-form object here and gets re-validated when the
// admin UI generates the form.

import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

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
    widget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { enum: ['builtin'] },
        component: { enum: ['GaugeTile', 'CounterTile', 'TimeseriesTile', 'StatusTile'] },
      },
    },
    dependencies: { type: 'array', items: { type: 'object' } },
  },
};

const validate = ajv.compile(manifestSchema);

export function validateManifest(m) {
  const valid = validate(m);
  return { valid, errors: validate.errors || [] };
}

export { manifestSchema };
