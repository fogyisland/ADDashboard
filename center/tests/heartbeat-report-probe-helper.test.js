// Unit tests for Task 2 — `restartRequired()` helper in
// center/src/services/config.js.
//
// The helper compares `center_listen_port_pending_version` against
// `center_listen_port_started_version` and returns `{ listenPort: <bool> }`.
// A "restart needed" is signaled when pending != null AND started != null
// AND pending !== started.
//
// Used by the GET /api/admin/config route to surface a "restart required"
// badge in the ConfigView (Task 6). Tests below pin the contract so the
// UI badge logic and the helper stay in sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest } from '../src/db/index.js';
import { restartRequired } from '../src/services/config.js';
import { buildMockDb } from './helpers/db-mock.js';

// Two-key regex covers both pending and started rows in the same query.
const PAIR_KEYS = /WHERE\s+config_key\s+IN\s*\(\s*'center_listen_port_pending_version'\s*,\s*'center_listen_port_started_version'\s*\)/i;

test('restartRequired: listenPort:true when pending != started', async () => {
  const db = buildMockDb([
    {
      match: PAIR_KEYS,
      rows: [
        { config_key: 'center_listen_port_pending_version', config_value: 'abc123' },
        { config_key: 'center_listen_port_started_version',  config_value: 'xyz789' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const out = await restartRequired();
  assert.deepEqual(out, { listenPort: true });
});

test('restartRequired: listenPort:false when pending == started', async () => {
  const db = buildMockDb([
    {
      match: PAIR_KEYS,
      rows: [
        { config_key: 'center_listen_port_pending_version', config_value: 'sameval' },
        { config_key: 'center_listen_port_started_version',  config_value: 'sameval' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const out = await restartRequired();
  assert.deepEqual(out, { listenPort: false });
});

test('restartRequired: listenPort:false when pending is null (no UI save yet)', async () => {
  // Only `started` is present — operator has just bootstrapped, no save has
  // happened, so nothing is pending.
  const db = buildMockDb([
    {
      match: PAIR_KEYS,
      rows: [
        { config_key: 'center_listen_port_started_version', config_value: 'startedval' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const out = await restartRequired();
  assert.deepEqual(out, { listenPort: false });
});

test('restartRequired: listenPort:false when started is null (init edge case)', async () => {
  const db = buildMockDb([
    {
      match: PAIR_KEYS,
      rows: [
        { config_key: 'center_listen_port_pending_version', config_value: 'pendingval' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const out = await restartRequired();
  assert.deepEqual(out, { listenPort: false });
});

test('restartRequired: listenPort:false when both rows absent (fresh install)', async () => {
  const db = buildMockDb([
    { match: PAIR_KEYS, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const out = await restartRequired();
  assert.deepEqual(out, { listenPort: false });
});
