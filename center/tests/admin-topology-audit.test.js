// C12 fix: topology routes (sites-catalog POST/PUT/DELETE + dcs-catalog
// PUT site) used to be silent — no writeAudit call on success. This file
// adds regression coverage so a future refactor can't quietly drop the
// audit rows again. Pattern matches server-groups-api.test.js: supertest
// + recording db + findAudit on /INSERT\s+INTO\s+audit_logs/.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}
function buildApp() {
  const a = express();
  a.use(express.json());
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  a.use(adminRouter({ config: { jwtSecret: SECRET }, logger }));
  return a;
}

function findAudit(records, action) {
  return records.find(r =>
    /INSERT\s+INTO\s+audit_logs/i.test(r.sql) && r.params[1] === action
  );
}

describe('C12: sites-catalog audit coverage', () => {
  test('POST /api/admin/sites-catalog writes create_site audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/INSERT\s+INTO\s+ad_sites/i.test(sql)) return { rows: [], affectedRows: 1, insertId: 7 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .post('/api/admin/sites-catalog')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ siteName: 'Site-A', regionCode: 'CN-North', isHub: 1, description: 'HQ' });
    const audit = findAudit(records, 'create_site');
    assert.ok(audit, 'create_site audit row must be written');
    assert.equal(audit.params[2], 'Site-A');
    assert.equal(audit.params[0], 'u1');
    const payload = JSON.parse(audit.params[3]);
    assert.equal(payload.siteName, 'Site-A');
    assert.equal(payload.regionCode, 'CN-North');
    assert.equal(payload.isHub, 1);
    assert.equal(payload.id, 7);
  });

  test('PUT /api/admin/sites-catalog/:id writes update_site audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/UPDATE\s+ad_sites/i.test(sql)) return { rows: [], affectedRows: 1 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .put('/api/admin/sites-catalog/5')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ siteName: 'Site-A-new', regionCode: 'CN-South' });
    const audit = findAudit(records, 'update_site');
    assert.ok(audit, 'update_site audit row must be written');
    assert.equal(audit.params[2], '5');
    const payload = JSON.parse(audit.params[3]);
    assert.equal(payload.siteId, 5);
    assert.deepEqual(payload.fieldsUpdated.sort(), ['region_code', 'site_name']);
  });

  test('DELETE /api/admin/sites-catalog/:id writes delete_site audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/DELETE\s+FROM\s+ad_sites/i.test(sql)) return { rows: [], affectedRows: 1 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .delete('/api/admin/sites-catalog/5')
      .set('Authorization', `Bearer ${adminToken()}`);
    const audit = findAudit(records, 'delete_site');
    assert.ok(audit, 'delete_site audit row must be written');
    assert.equal(audit.params[2], '5');
    const payload = JSON.parse(audit.params[3]);
    assert.equal(payload.siteId, 5);
    assert.match(payload.note, /unbindDcs/);
  });
});

describe('C12: dcs-catalog audit coverage', () => {
  test('PUT /api/admin/dcs-catalog/:dc_name/site binds writes assign_dc_site audit row', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/UPDATE\s+ad_dcs/i.test(sql)) return { rows: [], affectedRows: 1 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .put('/api/admin/dcs-catalog/dc-01.contoso.com/site')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ siteId: 7 });
    const audit = findAudit(records, 'assign_dc_site');
    assert.ok(audit, 'assign_dc_site audit row must be written');
    assert.equal(audit.params[2], 'dc-01.contoso.com');
    const payload = JSON.parse(audit.params[3]);
    assert.equal(payload.dcName, 'dc-01.contoso.com');
    assert.equal(payload.siteId, 7);
    assert.equal(payload.operation, 'bind');
  });

  test('PUT /api/admin/dcs-catalog/:dc_name/site null siteId writes assign_dc_site with operation=unbind', async () => {
    const records = [];
    const db = buildMockDb([]).withRecording(records);
    db.execute = async (sql, params) => {
      records.push({ sql, params });
      if (/UPDATE\s+ad_dcs/i.test(sql)) return { rows: [], affectedRows: 1 };
      return { rows: [], affectedRows: 0 };
    };
    _setDbForTest(db);
    await supertest(buildApp())
      .put('/api/admin/dcs-catalog/dc-01.contoso.com/site')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ siteId: null });
    const audit = findAudit(records, 'assign_dc_site');
    assert.ok(audit, 'assign_dc_site audit row must be written for unbind too');
    const payload = JSON.parse(audit.params[3]);
    assert.equal(payload.operation, 'unbind');
    assert.equal(payload.siteId, null);
  });
});