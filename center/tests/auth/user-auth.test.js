import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userAuth, invalidateJwtSecretCache, _loadJwtSecretBundle } from '../../src/auth/user-auth.js';

function stubBundle(bundle) {
  return {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        const rows = [];
        if (bundle.current !== undefined)
          rows.push({ config_key: 'jwt_secret_current', config_value: bundle.current });
        if (bundle.previous !== undefined)
          rows.push({ config_key: 'jwt_secret_previous', config_value: bundle.previous });
        return { rows };
      }
      // users.getAuthStatus path
      return { rows: [{ token_version: 0, status: 1 }] };
    },
    sql: {
      users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' }
    }
  };
}

function buildReq(token) {
  return token
    ? { headers: { authorization: `Bearer ${token}` } }
    : { headers: {} };
}

function buildRes() {
  let statusCode = 0;
  let jsonBody = null;
  return {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return jsonBody; }
  };
}

async function makeToken(secret, sub = 'u1') {
  const { signJwt } = await import('../../src/auth/jwt.js');
  return signJwt({ sub, role: 'admin', permissions: [], tokenVersion: 0 }, secret, 60);
}

test('accepts token signed with current secret', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: '' }), logger: null });
  const tok = await makeToken('CUR');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.sub, 'u1');
});

test('accepts token signed with previous secret during overlap', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: 'PREV' }), logger: null });
  const tok = await makeToken('PREV');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req._jwtSecretMatchedPrevious, true);
});

test('rejects malformed/missing token', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: '' }), logger: null });
  const req = buildReq(null);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects token signed with neither secret', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: 'PREV' }), logger: null });
  const tok = await makeToken('OTHER');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects when token_version mismatch', async () => {
  invalidateJwtSecretCache();
  const db = {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        return { rows: [{ config_key: 'jwt_secret_current', config_value: 'CUR' }] };
      }
      return { rows: [{ token_version: 99, status: 1 }] }; // mismatch with tokenVersion: 0
    },
    sql: { users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' } }
  };
  const mw = userAuth({ db, logger: null });
  const tok = await makeToken('CUR');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'token revoked');
});

test('rejects when user disabled', async () => {
  invalidateJwtSecretCache();
  const db = {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        return { rows: [{ config_key: 'jwt_secret_current', config_value: 'CUR' }] };
      }
      return { rows: [{ token_version: 0, status: 0 }] };
    },
    sql: { users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' } }
  };
  const mw = userAuth({ db, logger: null });
  const tok = await makeToken('CUR');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'user disabled');
});

test('caches the bundle; invalidateJwtSecretCache forces reload', async () => {
  invalidateJwtSecretCache();
  let bundleCalls = 0;
  const db = {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        bundleCalls++;
        return { rows: [{ config_key: 'jwt_secret_current', config_value: 'CUR' }] };
      }
      return { rows: [{ token_version: 0, status: 1 }] };
    },
    sql: { users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' } }
  };
  const mw = userAuth({ db, logger: null });
  const tok = await makeToken('CUR');
  await mw(buildReq(tok), buildRes(), () => {});
  await mw(buildReq(tok), buildRes(), () => {});
  assert.equal(bundleCalls, 1);
  invalidateJwtSecretCache();
  await mw(buildReq(tok), buildRes(), () => {});
  assert.equal(bundleCalls, 2);
});