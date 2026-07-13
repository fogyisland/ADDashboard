import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcrypt';
import { authRouter } from '../src/routes/auth.js';
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
    'alice': { id: 1, username: 'alice', password_hash: '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv', status: 1, role: 'admin', permissions: ['*'] }
  }));
  app.use(authRouter({ config: { jwtSecret: 's', agentToken: 'tok' }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'wrong' });
  assert.equal(res.status, 401);
});

test('POST /api/auth/login returns 200 with token + role for valid creds', async () => {
  const app = express();
  app.use(express.json());
  const passwordHash = bcrypt.hashSync('correct-horse-battery-staple', 12);
  _setDbForTest(buildMockDb({
    'alice': { id: 1, username: 'alice', password_hash: passwordHash, status: 1, role: 'admin', permissions: ['*'] }
  }));
  app.use(authRouter({ config: { jwtSecret: 'test-secret', agentToken: 'tok' }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'correct-horse-battery-staple' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'response should contain a JWT token');
  assert.equal(res.body.user.username, 'alice');
  assert.equal(res.body.user.role, 'admin');
});