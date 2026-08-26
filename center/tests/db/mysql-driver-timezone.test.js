// 2026-08-26 round-15 follow-up: regression test for the mysql2 driver
// `timezone` config. The previous default '+08:00' caused mysql2 to
// interpret stored UTC DATETIME values as CST, returning JS Dates that
// were 8 hours earlier than the real UTC instant. The UI's probe panel
// then computed `Date.now() - parsed = 8h+` and showed all 3 center
// ports as "offline" (gap > 60s).
//
// Storage convention (set by toMysqlDatetime in src/utils/datetime.js):
//   - writes use getUTC*() → UTC-naive strings ("2026-08-26 08:38:59")
//   - the driver MUST read them back as UTC instants
//
// This test reads the driver factory's pool config via inspection
// (the pool isn't fully initialized in unit tests; we import the
// module and check that the createPool call would receive timezone:'Z').
// We assert by calling the factory and inspecting the returned pool's
// config — that needs the live config, so we use a small proxy: a
// getPoolConfig() helper that returns the timezone value.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The drivers/mysql.js module exports createMysqlDriver. We can't
// directly call mysql.createPool in a unit test, so we expose the
// resolved config via a small wrapper helper. If the module doesn't
// expose it, fall back to parsing the source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const driversSrc = readFileSync(
  resolve(__dirname, '../../src/db/drivers/mysql.js'),
  'utf8'
);

test('mysql driver factory configures timezone: "Z" (UTC) — matches storage convention', () => {
  // The pool must be configured to interpret stored DATETIME values as UTC
  // so JS Date round-trips preserve the wall-clock instant. A '+08:00' or
  // 'local' value causes a systematic 8h shift on every DATETIME read.
  assert.match(
    driversSrc,
    /timezone:\s*['"]Z['"]/,
    'src/db/drivers/mysql.js must configure mysql2 with timezone: "Z" (UTC). ' +
    'A non-UTC value causes mysql2 to interpret stored UTC DATETIME values ' +
    'as the wrong zone, returning JS Dates that are 8h off. ' +
    'See round-15 follow-up notes.'
  );
});

test('legacy src/db.js pool also configures timezone: "Z"', () => {
  // src/db.js hosts the legacy direct pool used by some code paths.
  // Both pools must agree on timezone or read results would be inconsistent.
  const legacySrc = readFileSync(
    resolve(__dirname, '../../src/db.js'),
    'utf8'
  );
  assert.match(
    legacySrc,
    /timezone:\s*['"]Z['"]/,
    'src/db.js must configure mysql2 with timezone: "Z" (UTC).'
  );
  // The legacy module's header comment must NOT still claim "matches
  // local time zone" — that was the wrong assumption.
  assert.doesNotMatch(
    legacySrc,
    /Session-level timezone is set\s+to\s+'\+08:00'/i,
    'src/db.js header comment must be updated to reflect UTC storage convention.'
  );
});
