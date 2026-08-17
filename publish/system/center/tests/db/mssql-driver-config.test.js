import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source-level scan: assert mssql driver hardening is in place.
// These options must be set at pool-config / ensureConnected time so they
// apply to every connection the pool returns (and survive pool reuse).
//
// - SET XACT_ABORT ON: makes any runtime SQL error in a transaction auto-
//   rollback (drivers/mssql.js wraps transactions expecting this — without
//   it, partial failures leave the XACT in an uncommittable state and the
//   try/catch rollback at line 185 races with the uncommittable XACT).
// - SET NOCOUNT ON: suppresses the 'n rows affected' rowset MSSQL emits
//   after INSERT/UPDATE/DELETE/MERGE. Without it, the driver's recordsets[]
//   indexing at line 115 can shift, breaking affectedRows extraction.
// - SET QUOTED_IDENTIFIER ON: pinned explicitly to avoid cross-driver
//   surprises (default-on but mssql npm may not always enable on pool
//   connect).
//
// requestTimeout / connectionTimeout / cancelTimeout: mssql npm defaults
// (15s / 30s / 30s) cause spurious disconnects on long migrations and
// large audit-report queries on SQL Server 2016+.

const SRC = fileURLToPath(new URL('../../src/db/drivers/mssql.js', import.meta.url));

function loadDriverSource() {
  return readFileSync(SRC, 'utf8');
}

test('mssql driver pool config declares requestTimeout >= 30000', () => {
  const src = loadDriverSource();
  assert.match(
    src,
    /requestTimeout\s*:\s*3\d{4,}/,
    'pool config must pin requestTimeout to >= 30000 (5min default per audit fix)'
  );
});

test('mssql driver pool config declares connectionTimeout >= 30000', () => {
  const src = loadDriverSource();
  assert.match(
    src,
    /connectionTimeout\s*:\s*3\d{4,}/,
    'pool config must pin connectionTimeout to >= 30000 (30s)'
  );
});

test('mssql driver pool config declares cancelTimeout >= 30000', () => {
  const src = loadDriverSource();
  assert.match(
    src,
    /cancelTimeout\s*:\s*3\d{4,}/,
    'pool config must pin cancelTimeout to >= 30000 (30s)'
  );
});

test('mssql driver ensureConnected issues SET XACT_ABORT ON after pool.connect()', () => {
  const src = loadDriverSource();
  assert.match(
    src,
    /SET\s+XACT_ABORT\s+ON/i,
    'ensureConnected must SET XACT_ABORT ON so tx failures auto-rollback per T-SQL spec'
  );
});

test('mssql driver ensureConnected issues SET NOCOUNT ON after pool.connect()', () => {
  const src = loadDriverSource();
  assert.match(
    src,
    /SET\s+NOCOUNT\s+ON/i,
    'ensureConnected must SET NOCOUNT ON so recordsets[] indexing is stable after MERGE/INSERT/UPDATE/DELETE'
  );
});

test('mssql driver ensureConnected issues SET QUOTED_IDENTIFIER ON explicitly', () => {
  const src = loadDriverSource();
  assert.match(
    src,
    /SET\s+QUOTED_IDENTIFIER\s+ON/i,
    'ensureConnected must SET QUOTED_IDENTIFIER ON explicitly to avoid cross-driver surprises'
  );
});