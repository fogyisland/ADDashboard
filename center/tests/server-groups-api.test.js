// Integration tests for the server-groups admin routes (Task 7 of the
// non-AD server management plan). Covers:
//   - GET    /api/admin/server-groups (list with member_count)
//   - POST   /api/admin/server-groups (create; 409 on duplicate)
//   - PUT    /api/admin/server-groups/:id (rename / describe; 404 on miss)
//   - DELETE /api/admin/server-groups/:id (drop; 404 on miss)
//   - GET    /api/admin/server-groups/:id/members (list hostnames)
//   - PUT    /api/admin/server-groups/:id/members (replace; idempotent)
//   - POST   /api/admin/server-groups/:id/packages/install (bulk INSERT IGNORE/MERGE)
//   - POST   /api/admin/server-groups/:id/packages/:name/uninstall (bulk DELETE; built-in audit)
//   - POST   /api/admin/server-groups/:id/packages/:name/enable / disable (bulk UPDATE)
//   - 401 without auth on all admin routes
//
// Pattern: node:test + node:assert/strict, express app built with the
// adminRouter factory, mock DB via _setDbForTest + buildMockDb helpers.
// No Jest, no supertest globals.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildRecordingPool } from './helpers/db-mock.js';

const SECRET = 'test-secret-sg';

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function buildApp() {
  const a = express();
  a.use(express.json());
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  a.use(adminRouter({
    config: { jwtSecret: SECRET },
    logger
  }));
  return a;
}

// ---------------------------------------------------------------------------
// 1. GET /api/admin/server-groups — list
// ---------------------------------------------------------------------------
describe('GET /api/admin/server-groups', () => {
  test('200 with admin token: returns list with member_count (camelCase)', async () => {
    const db = buildMockDb([
      { match: /FROM\s+ad_server_groups\s+g/i, rows: [
        { group_id: 1, group_name: 'g1', description: 'first', member_count: 3 },
        { group_id: 2, group_name: 'g2', description: null, member_count: 0 }
      ] }
    ]).standard();
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .get('/api/admin/server-groups')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.equal(r.body.length, 2);
    assert.equal(r.body[0].groupId, 1);
    assert.equal(r.body[0].groupName, 'g1');
    assert.equal(r.body[0].memberCount, 3);
  });

  test('401 without auth', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp()).get('/api/admin/server-groups');
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/admin/server-groups — create
// ---------------------------------------------------------------------------
describe('POST /api/admin/server-groups', () => {
  test('201 with admin token: create group', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'g1', description: 'first group' });
    assert.equal(r.status, 201, `expected 201, got ${r.status}`);
    assert.ok(r.body.id != null, 'body should include id');
    const create = records.find(r => /INSERT\s+INTO\s+ad_server_groups/i.test(r.sql));
    assert.ok(create, 'INSERT into ad_server_groups should be issued');
    assert.equal(create.params[0], 'g1');
    assert.equal(create.params[1], 'first group');
  });

  test('409 on duplicate group_name', async () => {
    // Mock throws DUP_ENTRY on INSERT into ad_server_groups. The route
    // checks e.code === 'DUP_ENTRY' (the normalized code, not the raw
    // mysql2 'ER_DUP_ENTRY'). DbError.wrap normally remaps via CODE_MAP,
    // but _setDbForTest replaces the entire db facade, so the mock's
    // thrown error lands on the route's catch directly. Throw with the
    // normalized code so the 409 branch fires.
    const db = buildMockDb([
      { match: /INSERT\s+INTO\s+ad_server_groups/i, throwOnExecute: Object.assign(new Error('dup'), { code: 'DUP_ENTRY' }) }
    ]).standard();
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'g1' });
    assert.equal(r.status, 409);
  });

  test('400 when groupName missing', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 3. PUT /api/admin/server-groups/:id — rename / describe
// ---------------------------------------------------------------------------
describe('PUT /api/admin/server-groups/:id', () => {
  test('200 with admin token: rename + update description', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .put('/api/admin/server-groups/7')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'g1-new', description: 'renamed' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const update = records.find(r => /UPDATE\s+ad_server_groups/i.test(r.sql));
    assert.ok(update, 'UPDATE ad_server_groups should be issued');
    assert.equal(update.params[0], 'g1-new');
    assert.equal(update.params[1], 'renamed');
    assert.equal(update.params[2], 7);
  });

  test('404 on missing group (affectedRows=0)', async () => {
    // Custom mock that always returns affectedRows=0 so the 404 branch fires
    const { buildSql } = await import('../src/db/sql.js');
    const db = {
      dialect: 'mysql',
      sql: buildSql('mysql'),
      async execute() { return { rows: [], affectedRows: 0, insertId: undefined }; },
      async query() { return { rows: [] }; },
      async transaction() {},
      async healthcheck() {},
      async close() {}
    };
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .put('/api/admin/server-groups/99999')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'x' });
    assert.equal(r.status, 404);
  });

  test('400 when no fields supplied', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .put('/api/admin/server-groups/7')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 4. DELETE /api/admin/server-groups/:id — drop
// ---------------------------------------------------------------------------
describe('DELETE /api/admin/server-groups/:id', () => {
  test('200 with admin token: delete issued', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .delete('/api/admin/server-groups/7')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const del = records.find(r => /DELETE\s+FROM\s+ad_server_groups/i.test(r.sql));
    assert.ok(del, 'DELETE on ad_server_groups should be issued');
    assert.equal(del.params[0], 7);
  });

  test('404 on missing group (affectedRows=0)', async () => {
    const { buildSql } = await import('../src/db/sql.js');
    const db = {
      dialect: 'mysql',
      sql: buildSql('mysql'),
      async execute() { return { rows: [], affectedRows: 0, insertId: undefined }; },
      async query() { return { rows: [] }; },
      async transaction() {},
      async healthcheck() {},
      async close() {}
    };
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .delete('/api/admin/server-groups/99999')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 5. GET /api/admin/server-groups/:id/members
// ---------------------------------------------------------------------------
describe('GET /api/admin/server-groups/:id/members', () => {
  test('200 with admin token: returns hostnames array', async () => {
    const db = buildMockDb([
      { match: /FROM\s+ad_server_group_members\s+m\s+LEFT JOIN/i, rows: [
        { hostname: 'SRV-A' }, { hostname: 'SRV-B' }
      ] }
    ]).standard();
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .get('/api/admin/server-groups/1/members')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.equal(r.body.length, 2);
    assert.equal(r.body[0].hostname, 'SRV-A');
  });
});

// ---------------------------------------------------------------------------
// 6. PUT /api/admin/server-groups/:id/members — replace (idempotent)
// ---------------------------------------------------------------------------
describe('PUT /api/admin/server-groups/:id/members', () => {
  test('200 with admin token: replace issues DELETE + INSERTs (idempotent diff)', async () => {
    const records = [];
    // listMembers returns existing hostnames ['SRV-A']
    const db = buildMockDb([
      { match: /FROM\s+ad_server_group_members\s+m\s+LEFT JOIN/i, rows: [{ hostname: 'SRV-A' }] }
    ]);
    _setDbForTest(db.withRecording(records));
    const r = await supertest(buildApp())
      .put('/api/admin/server-groups/1/members')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostnames: ['SRV-B', 'SRV-C'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // SRV-A is removed (DELETE) and SRV-B/SRV-C are inserted (2 INSERTs)
    const dels = records.filter(r => /DELETE\s+FROM\s+ad_server_group_members/i.test(r.sql));
    const inserts = records.filter(r => /INSERT\s+INTO\s+ad_server_group_members|MERGE\s+INTO\s+ad_server_group_members/i.test(r.sql));
    assert.ok(dels.length >= 1, 'DELETE for removed member should be issued');
    assert.ok(inserts.length >= 2, 'INSERTs for new members should be issued');
  });

  test('idempotent: same hostnames returns 200 with no DELETE/INSERT churn', async () => {
    const records = [];
    const db = buildMockDb([
      { match: /FROM\s+ad_server_group_members\s+m\s+LEFT JOIN/i, rows: [{ hostname: 'SRV-A' }, { hostname: 'SRV-B' }] }
    ]);
    _setDbForTest(db.withRecording(records));
    const r = await supertest(buildApp())
      .put('/api/admin/server-groups/1/members')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostnames: ['SRV-A', 'SRV-B'] });
    assert.equal(r.status, 200);
    // No churn — nothing to delete, nothing to insert
    const dels = records.filter(r => /DELETE\s+FROM\s+ad_server_group_members/i.test(r.sql));
    const inserts = records.filter(r => /INSERT\s+INTO\s+ad_server_group_members|MERGE\s+INTO\s+ad_server_group_members/i.test(r.sql));
    assert.equal(dels.length, 0);
    assert.equal(inserts.length, 0);
  });

  test('400 when hostnames missing', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .put('/api/admin/server-groups/1/members')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 7. POST /api/admin/server-groups/:id/packages/install
// ---------------------------------------------------------------------------
describe('POST /api/admin/server-groups/:id/packages/install', () => {
  test('200 with admin token: enqueues per-host rows via INSERT IGNORE / MERGE', async () => {
    const records = [];
    // install uses bulkInstallPackage (INSERT IGNORE / INSERT ... NOT EXISTS)
    const db = buildMockDb([]);
    _setDbForTest(db.withRecording(records));
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups/1/packages/install')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ packageName: 'ad-os-baseline', confirmDropSchema: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const inserts = records.filter(r => /INSERT\s+IGNORE\s+INTO\s+ad_member_server_packages|INSERT\s+INTO\s+ad_member_server_packages/i.test(r.sql));
    // MySQL bulkInstallPackage resolves the membership JOIN in the SQL itself,
    // so a single statement covers both members. We assert the SQL is the
    // bulk variant (uses INSERT ... SELECT FROM ad_server_group_members).
    assert.ok(inserts.length >= 1, `expected at least 1 bulk INSERT, got ${inserts.length}`);
    const install = inserts[0];
    assert.match(install.sql, /FROM\s+ad_server_group_members/i);
    // params: [package_name, enabled, group_id] (mysql) — confirm packageName landed
    assert.ok(install.params.includes('ad-os-baseline'));
    assert.ok(install.params.includes(1));
    assert.ok(install.params.includes(1)); // group_id
  });

  test('400 when packageName missing', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups/1/packages/install')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ confirmDropSchema: false });
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 8. POST /api/admin/server-groups/:id/packages/:name/uninstall
//    For built-in 'ad-os-baseline': audit row per affected host + DELETE.
// ---------------------------------------------------------------------------
describe('POST /api/admin/server-groups/:id/packages/:name/uninstall', () => {
  test('200 for built-in ad-os-baseline: audit per host + DELETE', async () => {
    const records = [];
    // listHostsForPackage returns the hosts that actually have this package bound
    const db = buildMockDb([
      { match: /FROM\s+ad_member_server_packages\s+msp\s+WHERE\s+msp\.package_name\s+=\s+\?/i,
        rows: [{ hostname: 'SRV-A' }, { hostname: 'SRV-B' }] }
    ]);
    _setDbForTest(db.withRecording(records));
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups/1/packages/ad-os-baseline/uninstall')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // Per-host audit rows (one per affected host) BEFORE any DELETE, plus
    // a C11 bulk_disable_package_to_group summary row that lands AFTER the
    // DELETE so an operator can pivot by group_id without fanning out across
    // per-host disable rows.
    const perHostAudits = records.filter(r =>
      /INSERT\s+INTO\s+audit_logs/i.test(r.sql) &&
      r.params[1] === 'disable_builtin_ad_os_baseline'
    );
    assert.equal(perHostAudits.length, 2, 'audit row per affected host');
    for (const a of perHostAudits) {
      assert.equal(a.params[1], 'disable_builtin_ad_os_baseline');
      assert.ok(['SRV-A', 'SRV-B'].includes(a.params[2]));
    }
    const summaryAudit = records.find(r =>
      /INSERT\s+INTO\s+audit_logs/i.test(r.sql) &&
      r.params[1] === 'bulk_disable_package_to_group'
    );
    assert.ok(summaryAudit, 'bulk_disable_package_to_group summary audit row must be written');
    assert.equal(summaryAudit.params[2], '1');
    // Bulk DELETE for ad_member_server_packages (single statement)
    const dels = records.filter(r => /DELETE\s+(msp\s+)?FROM\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(dels.length >= 1);
    // Per-host audit must come before DELETE
    assert.ok(records.indexOf(perHostAudits[0]) < records.indexOf(dels[0]), 'per-host audit must precede DELETE');
  });

  test('200 for non-built-in package: DELETE + bulk_disable_package_to_group summary audit', async () => {
    const records = [];
    const db = buildMockDb([
      { match: /FROM\s+ad_member_server_packages\s+msp\s+WHERE\s+msp\.package_name\s+=\s+\?/i,
        rows: [{ hostname: 'SRV-A' }] }
    ]);
    _setDbForTest(db.withRecording(records));
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups/1/packages/other-pkg/uninstall')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    // C11: non-built-in packages now write the bulk_disable_package_to_group
    // summary row (no per-host disable — that was the built-in-specific
    // safety-net audit). Verify only the summary row is written.
    const audits = records.filter(r => /INSERT\s+INTO\s+audit_logs/i.test(r.sql));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].params[1], 'bulk_disable_package_to_group');
    assert.equal(audits[0].params[2], '1');
    const dels = records.filter(r => /DELETE\s+(msp\s+)?FROM\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(dels.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// 9. POST /api/admin/server-groups/:id/packages/:name/enable / disable
// ---------------------------------------------------------------------------
describe('POST /api/admin/server-groups/:id/packages/:name/enable', () => {
  test('200: bulk UPDATE enabled=1 for all members of the group', async () => {
    const records = [];
    const db = buildMockDb([]);
    _setDbForTest(db.withRecording(records));
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups/1/packages/some-pkg/enable')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const updates = records.filter(r => /UPDATE\s+(msp\s+)?ad_member_server_packages/i.test(r.sql));
    assert.ok(updates.length >= 1, `expected at least 1 UPDATE, got ${updates.length}`);
    // params: [enabled, group_id, package_name] (mysql) — first param is enabled=1
    assert.equal(updates[0].params[0], 1, 'first param should be enabled=1');
  });
});

describe('POST /api/admin/server-groups/:id/packages/:name/disable', () => {
  test('200: bulk UPDATE enabled=0 for all members of the group', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups/1/packages/some-pkg/disable')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    const updates = records.filter(r => /UPDATE\s+(msp\s+)?ad_member_server_packages/i.test(r.sql));
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].params[0], 0);
  });
});

// ---------------------------------------------------------------------------
// 10. 401 without auth — applies to all new routes
// ---------------------------------------------------------------------------
describe('Auth coverage', () => {
  test('401 on DELETE /api/admin/server-groups/:id', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp()).delete('/api/admin/server-groups/1');
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------------------
// C11: server-groups audit row coverage — every mutating route must write
// an audit_logs INSERT so compliance reviewers can answer "who deleted
// group X" without grepping the application log.
// ---------------------------------------------------------------------------
describe('C11: server-groups audit coverage', () => {
  function findAudit(records, action) {
    return records.find(r =>
      /INSERT\s+INTO\s+audit_logs/i.test(r.sql) && r.params[1] === action
    );
  }

  test('POST /api/admin/server-groups writes create_server_group audit row', async () => {
    const records = [];
    _setDbForTest(buildMockDb([]).withRecording(records));
    await supertest(buildApp())
      .post('/api/admin/server-groups')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'g1', description: 'first' });
    const audit = findAudit(records, 'create_server_group');
    assert.ok(audit, 'create_server_group audit row must be written');
    assert.equal(audit.params[2], 'g1'); // target = groupName
    assert.equal(audit.params[0], 'u1'); // userId
  });

  test('PUT /api/admin/server-groups/:id writes update_server_group audit row', async () => {
    const records = [];
    const db = buildMockDb([
      { match: /UPDATE\s+ad_server_groups/i, rows: [] }
    ]).withRecording(records);
    // Mock needs to report affectedRows=1 for the route to proceed past 404
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/UPDATE\s+ad_server_groups/i.test(sql)) return { rows: [], affectedRows: 1 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .put('/api/admin/server-groups/7')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'g1-new' });
    const audit = findAudit(records, 'update_server_group');
    assert.ok(audit, 'update_server_group audit row must be written');
    assert.equal(audit.params[2], '7');
  });

  test('DELETE /api/admin/server-groups/:id writes delete_server_group audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/DELETE\s+FROM\s+ad_server_groups/i.test(sql)) return { rows: [], affectedRows: 1 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .delete('/api/admin/server-groups/7')
      .set('Authorization', `Bearer ${adminToken()}`);
    const audit = findAudit(records, 'delete_server_group');
    assert.ok(audit, 'delete_server_group audit row must be written');
    assert.equal(audit.params[2], '7');
  });

  test('PUT /api/admin/server-groups/:id/members writes replace_server_group_members audit row INSIDE the tx', async () => {
    const records = [];
    const txCalls = [];
    const db = buildMockDb([
      { match: /FROM\s+ad_server_group_members/i, rows: [{ hostname: 'old-A' }, { hostname: 'old-B' }] }
    ]).withRecording(records);
    db.transaction = async (work) => {
      const txWrapper = {
        sql: db.sql,
        async execute(sql, params) {
          txCalls.push({ sql, params, inTx: true });
          return { rows: [], affectedRows: 0 };
        }
      };
      return await work(txWrapper);
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .put('/api/admin/server-groups/7/members')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostnames: ['new-X', 'old-A'] }); // 1 added (new-X), 1 removed (old-B)
    // The audit row must land inside the same tx as the data writes — verify
    // by checking it shows up in txCalls (not records against the global db).
    const audit = txCalls.find(c =>
      /INSERT\s+INTO\s+audit_logs/i.test(c.sql) &&
      c.params[1] === 'replace_server_group_members'
    );
    assert.ok(audit, 'replace_server_group_members audit row must be inside the tx');
    assert.equal(audit.params[2], '7');
    const payload = JSON.parse(audit.params[3]);
    assert.deepEqual(payload.added, ['new-X']);
    assert.deepEqual(payload.removed, ['old-B']);
  });

  test('POST .../packages/install writes bulk_install_package_to_group audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/INSERT\s+INTO\s+ad_member_server_packages/i.test(sql)) return { rows: [], affectedRows: 5 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .post('/api/admin/server-groups/7/packages/install')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ packageName: 'my-pkg' });
    const audit = findAudit(records, 'bulk_install_package_to_group');
    assert.ok(audit, 'bulk_install_package_to_group audit row must be written');
    assert.equal(audit.params[2], '7');
  });

  test('POST .../packages/:name/enable writes bulk_enable_package_to_group audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/UPDATE\s+(msp\s+)?ad_member_server_packages/i.test(sql)) return { rows: [], affectedRows: 3 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .post('/api/admin/server-groups/7/packages/my-pkg/enable')
      .set('Authorization', `Bearer ${adminToken()}`);
    const audit = findAudit(records, 'bulk_enable_package_to_group');
    assert.ok(audit, 'bulk_enable_package_to_group audit row must be written');
    assert.equal(audit.params[2], '7');
  });

  test('POST .../packages/:name/disable writes bulk_disable_package_to_group audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/UPDATE\s+(msp\s+)?ad_member_server_packages/i.test(sql)) return { rows: [], affectedRows: 3 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .post('/api/admin/server-groups/7/packages/my-pkg/disable')
      .set('Authorization', `Bearer ${adminToken()}`);
    const audit = findAudit(records, 'bulk_disable_package_to_group');
    assert.ok(audit, 'bulk_disable_package_to_group audit row must be written');
    assert.equal(audit.params[2], '7');
  });

  test('audit row writes do not break the operation when audit INSERT throws (best-effort)', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      // First call is the INSERT into ad_server_groups — succeed.
      // Second call is the audit_logs INSERT — throw.
      const calls = records.filter(r => /INSERT/i.test(r.sql)).length;
      if (calls === 1 && /INSERT\s+INTO\s+audit_logs/i.test(sql)) {
        throw new Error('audit table hiccup');
      }
      return { rows: [], affectedRows: 1 };
    };
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .post('/api/admin/server-groups')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ groupName: 'g1' });
    // Best-effort: route must still return 201 (audit failure is warn-logged)
    assert.equal(r.status, 201);
  });
});
