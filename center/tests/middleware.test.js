import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { userAuth } from '../src/auth/user-auth.js';
import { agentToken } from '../src/auth/agent-token.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { buildSql } from '../src/db/sql.js';

const sql = buildSql('mysql');

function dbMockWithRow(row) {
  return { query: async () => ({ rows: row == null ? [] : [row] }), sql };
}

function app_(middlewares) {
  const a = express();
  middlewares.forEach(mw => mw.forEach(([p, h]) => a.use(p, h)));
  a.get('/p', (req, res) => res.json({ user: req.user }));
  return a;
}

test('userAuth attaches user from valid token', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: dbMockWithRow({ token_version: 0, status: 1 }) }));
  a.get('/p', (req, res) => res.json({ user: req.user }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
  assert.equal(r.body.user.status, 1);
});

test('userAuth returns 401 without token', async () => {
  const a = express();
  a.use(userAuth({ secret: 'secret', db: dbMockWithRow(null) }));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p');
  assert.equal(r.status, 401);
});

test('userAuth returns 401 "user not found" when the row is missing', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: dbMockWithRow(null) }));
  a.get('/p', (_req, res) => res.json({ ok: true }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'user not found');
});

test('userAuth returns 401 "user disabled" when status !== 1', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: dbMockWithRow({ token_version: 0, status: 0 }) }));
  a.get('/p', (_req, res) => res.json({ ok: true }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'user disabled');
});

test('userAuth returns 401 "token revoked" when DB version differs from JWT claim', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: dbMockWithRow({ token_version: 1, status: 1 }) }));
  a.get('/p', (_req, res) => res.json({ ok: true }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'token revoked');
});

test('userAuth sets req.user.status from the DB row on success', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 3 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: dbMockWithRow({ token_version: 3, status: 1 }) }));
  a.get('/p', (req, res) => res.json({ user: req.user }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.status, 1);
  assert.equal(r.body.user.tokenVersion, 3);
});

test('agentToken returns 401 on wrong token', async () => {
  const a = express();
  a.use(agentToken('expected'));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p').set('X-Agent-Token', 'wrong');
  assert.equal(r.status, 401);
});

test('requirePerm returns 403 when missing', async () => {
  const a = express();
  a.use((req, _res, n) => { req.user = { permissions: ['read:dash'] }; n(); });
  a.use(requirePerm('admin:users'));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p');
  assert.equal(r.status, 403);
});

test('requirePerm allows wildcard', async () => {
  const a = express();
  a.use((req, _res, n) => { req.user = { permissions: ['*'] }; n(); });
  a.use(requirePerm('admin:users'));
  a.get('/p', (req, res) => res.json({}));
  const r = await supertest(a).get('/p');
  assert.equal(r.status, 200);
});
