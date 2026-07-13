import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../src/db/index.js';
import { buildTestApp } from './helpers/test-app.js';

test('GET /healthz returns 200 when DB reachable', async (t) => {
  const url = process.env.TEST_SQL_URL;
  if (!url) return t.skip('TEST_SQL_URL not set');
  await init({ db: { dialect: 'mysql', mysql: { host: url, port: 3306, database: 'mysql', user: 'root', password: process.env.TEST_SQL_PASSWORD || '' } } });
  const app = buildTestApp({ db: getDb() });
  const { default: supertest } = await import('supertest');
  const res = await supertest(app).get('/healthz');
  assert.equal(res.status, 200);
  await close();
});