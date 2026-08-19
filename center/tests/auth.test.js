import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { authRouter } from '../src/routes/auth.js';
import { verifyJwt } from '../src/auth/jwt.js';
import { default as supertest } from 'supertest';
import { _setDbForTest } from '../src/db/index.js';
import { buildSql } from '../src/db/sql.js';

// Keyed by username -> row. Routes execute the SELECT for findByUsername,
// then UPDATE sys_users on success / INSERT audit_logs on failure.
// We match by SQL fragment and use the first ? placeholder as the lookup.
function buildMockDb(byUsername) {
  return {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async execute(sql, params = []) {
      if (/FROM\s+sys_users\b/i.test(sql)) {
        const username = params[0];
        const row = byUsername[username];
        return {
          rows: row ? [row] : [],
          affectedRows: 1,
          insertId: undefined
        };
      }
      // UPDATE last_login_at / INSERT audit_logs — succeed silently
      return { rows: [], affectedRows: 1, insertId: undefined };
    },
    async query(sql, params = []) {
      if (/FROM\s+sys_users\b/i.test(sql)) {
        const username = params[0];
        const row = byUsername[username];
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
    async transaction() {},
    async healthcheck() {},
    async close() {}
  };
}

test('POST /api/auth/login returns 401 for bad password', async () => {
  const app = express();
  app.use(express.json());
  _setDbForTest(buildMockDb({
    'alice': { id: 1, username: 'alice', password_hash: '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv', status: 1, role: 'admin', permissions: ['*'], token_version: 0 }
  }));
  app.use(authRouter({ config: { jwtSecret: 's', agentToken: 'tok' }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'wrong' });
  assert.equal(res.status, 401);
});

test('POST /api/auth/login returns 200 with token + role for valid creds', async () => {
  const app = express();
  app.use(express.json());
  const passwordHash = bcrypt.hashSync('correct-horse-battery-staple', 12);
  // Mock must mirror production: SQL `users.findByUsername` returns the role
  // as `role_name` (sql.js:25), NOT `role`. Earlier this test passed only
  // because the mock used the wrong field name — masking a real bug where
  // routes/auth.js referenced `user.role` (undefined) instead of `user.role_name`.
  _setDbForTest(buildMockDb({
    'alice': { id: 1, username: 'alice', password_hash: passwordHash, status: 1, role_name: 'admin', permissions: ['*'], token_version: 0 }
  }));
  app.use(authRouter({ config: { jwtSecret: 'test-secret', agentToken: 'tok' }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'correct-horse-battery-staple' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'response should contain a JWT token');
  assert.equal(res.body.user.username, 'alice');
  assert.equal(res.body.user.role, 'admin', 'login response must surface role to frontend (drives auth.isAdmin + AppLayout topbar display)');
  // JWT must also carry the role for backend authorization. Decoding the token
  // proves routes/auth.js:17 reads user.role_name, not user.role.
  const payload = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'admin', 'JWT must carry role for backend requireRole/requirePermission middleware');
});

test('POST /api/auth/login embeds user.tokenVersion in the issued JWT', async () => {
  // I1: the JWT's tokenVersion claim must equal the DB row's current value at
  // the moment of login. If it does not, the userAuth middleware's per-request
  // comparison rejects the very first request after login with 401 'token
  // revoked'. token_version: 4 (not 0) so a hardcoded/defaulted 0 fails.
  const app = express();
  app.use(express.json());
  const passwordHash = bcrypt.hashSync('correct-horse-battery-staple', 12);
  _setDbForTest(buildMockDb({
    'alice': { id: 42, username: 'alice', password_hash: passwordHash, status: 1, role_name: 'admin', permissions: ['*'], token_version: 4 }
  }));
  app.use(authRouter({ config: { jwtSecret: 'test-secret', agentToken: 'tok' }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'correct-horse-battery-staple' });
  assert.equal(res.status, 200);
  const v = verifyJwt(res.body.token, { current: 'test-secret', previous: '' });
  assert.equal(v.tokenVersion, 4, 'JWT tokenVersion claim must come from the DB row, not the signJwt default of 0');
  assert.equal(typeof v.tokenVersion, 'number');
});