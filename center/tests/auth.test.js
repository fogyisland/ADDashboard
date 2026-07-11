import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcrypt';
import { authRouter } from '../src/routes/auth.js';
import { default as supertest } from 'supertest';

// Build a mock mssql pool whose request() is synchronous (matches real API)
// and returns a promise of { recordset } from query().
function buildMockPool(map) {
  return {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          for (const [k, v] of Object.entries(self._inputs)) {
            if (q.includes(`@${k}`)) {
              if (q.includes('FROM sys_users u JOIN sys_roles r') && k === 'u') {
                return { recordset: map[v] ? [map[v]] : [] };
              }
            }
          }
          // UPDATE / INSERT — succeed silently
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

test('POST /api/auth/login returns 401 for bad password', async () => {
  const app = express();
  app.use(express.json());
  const pool = buildMockPool({
    'alice': { id: 1, username: 'alice', password_hash: '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv', status: 1, role_name: 'admin', permissions: '["*"]' }
  });
  app.use(authRouter({ config: { jwtSecret: 's' }, pool, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'wrong' });
  assert.equal(res.status, 401);
});

test('POST /api/auth/login returns 200 with token + role for valid creds', async () => {
  const app = express();
  app.use(express.json());
  const passwordHash = bcrypt.hashSync('correct-horse-battery-staple', 12);
  const pool = buildMockPool({
    'alice': { id: 1, username: 'alice', password_hash: passwordHash, status: 1, role_name: 'admin', permissions: '["*"]' }
  });
  app.use(authRouter({ config: { jwtSecret: 'test-secret' }, pool, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
  const res = await supertest(app).post('/api/auth/login').send({ username: 'alice', password: 'correct-horse-battery-staple' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token, 'response should contain a JWT token');
  assert.equal(res.body.user.username, 'alice');
  assert.equal(res.body.user.role, 'admin');
});