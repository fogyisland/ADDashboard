import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestApp } from './helpers/test-app.js';
import { initPool, closePool } from '../src/db.js';

test('GET /healthz returns 200 when DB reachable', async (t) => {
  const url = process.env.TEST_SQL_URL;
  if (!url) return t.skip('TEST_SQL_URL not set');
  await initPool({ mysql: { host: url, port: 3306, database: 'mysql', user: 'root', password: '' } });
  const { default: supertest } = await import('supertest');
  const app = buildTestApp({ pool: await (await import('../src/db.js')).getPool() });
  const res = await supertest(app).get('/healthz');
  assert.equal(res.status, 200);
  await closePool();
});
