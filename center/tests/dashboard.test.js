import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { dashboardRouter } from '../src/routes/dashboard.js';
import { signJwt } from '../src/auth/jwt.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';

// Programmable mock pool: returns recordset rows keyed by a tag.
// `script.rows` may be an array (returned as-is) or a function that
// returns an array (called each time the query matches).
// SQL matching is intentionally coarse; we key by the route's marker
// fragments so we don't need a SQL parser.
function buildMockPool(scripts) {
  // scripts: array of { match: RegExp, rows: any[] | (() => any[]) }
  return {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          for (const s of scripts) {
            if (s.match.test(q)) {
              const rows = typeof s.rows === 'function' ? s.rows() : s.rows;
              return { recordset: Array.isArray(rows) ? rows : [] };
            }
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

function buildApp({ pool, scripts }) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(dashboardRouter({ config, pool, logger }));
  return a;
}

function adminToken(extraPerms) {
  return signJwt(
    { sub: 'u1', role: 'admin', permissions: extraPerms ?? ['*'] },
    SECRET,
    60
  );
}

// ----- AUTH WIRING -----

test('overview: 401 when no token', async () => {
  const pool = buildMockPool([]);
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app).get('/api/dashboard/overview');
  assert.equal(r.status, 401);
});

test('overview: 403 when missing read:dash perm', async () => {
  const pool = buildMockPool([]);
  const app = buildApp({ pool, scripts: [] });
  const tok = signJwt(
    { sub: 'u2', role: 'viewer', permissions: ['read:something-else'] },
    SECRET,
    60
  );
  const r = await supertest(app)
    .get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${tok}`);
  assert.equal(r.status, 403);
});

test('overview: 200 with valid token + wildcard perm', async () => {
  // mock pool returns counts + lastUpdate + agent count
  const scripts = [
    {
      // overview count SELECT (SUM CASE WHEN ...)
      match: /SUM\s*\(\s*CASE\s+WHEN/i,
      rows: [{
        total: 10,
        healthy: 8,
        warning: 1,
        errored: 1,
        last_update: new Date('2026-07-10T00:00:00Z')
      }]
    },
    {
      // agent count SELECT
      match: /COUNT\(\*\)\s+AS\s+agent_count/i,
      rows: [{ agent_count: 3 }]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
  const r = await supertest(app)
    .get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.totalLinks, 10);
  assert.equal(r.body.healthy, 8);
  assert.equal(r.body.warning, 1);
  assert.equal(r.body.error, 1);
  assert.equal(r.body.agentCount, 3);
  assert.ok(r.body.lastUpdate, 'lastUpdate should be present');
});

// ----- SITE MATRIX -----

test('site-matrix: returns camelCase keys sourceSite/destSite/errorCount/warningCount/total', async () => {
  const scripts = [
    {
      match: /GROUP\s+BY\s+source_site\s*,\s*dest_site/i,
      rows: [
        { source_site: 'SITE-A', dest_site: 'SITE-B',
          error_count: 0, warning_count: 2, total: 5 },
        { source_site: 'SITE-B', dest_site: 'SITE-C',
          error_count: 1, warning_count: 1, total: 3 }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
  const r = await supertest(app)
    .get('/api/dashboard/site-matrix')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2);
  assert.deepEqual(Object.keys(r.body[0]).sort(),
    ['destSite','errorCount','sourceSite','total','warningCount']);
  assert.equal(r.body[0].sourceSite, 'SITE-A');
  assert.equal(r.body[0].destSite, 'SITE-B');
  assert.equal(r.body[0].errorCount, 0);
  assert.equal(r.body[0].warningCount, 2);
  assert.equal(r.body[0].total, 5);
});

// ----- TOPOLOGY -----

test('topology: returns nodes (site + dc) and links with source/target/statusCode/lastSuccessTime', async () => {
  const last = new Date('2026-07-10T12:34:56Z');
  const scripts = [
    {
      match: /FROM\s+ad_replication_status/i,
      rows: [
        { source_site: 'SITE-A', dest_site: 'SITE-B',
          source_dc: 'DC-A1', dest_dc: 'DC-B1',
          status_code: 0, last_success_time: last },
        { source_site: 'SITE-A', dest_site: 'SITE-B',
          source_dc: 'DC-A1', dest_dc: 'DC-B2',
          status_code: 2, last_success_time: last }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
  const r = await supertest(app)
    .get('/api/dashboard/topology')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.nodes));
  assert.ok(Array.isArray(r.body.links));

  // Site nodes: only `name`
  const siteNodes = r.body.nodes.filter(n => n.type === 'site');
  assert.ok(siteNodes.length >= 2, 'expect at least 2 site nodes');
  for (const n of siteNodes) {
    assert.ok(typeof n.name === 'string');
    assert.equal(n.site, undefined);
  }
  // DC nodes: name + site
  const dcNodes = r.body.nodes.filter(n => n.type === 'dc');
  assert.ok(dcNodes.length >= 3, 'expect at least 3 distinct dc nodes');
  for (const n of dcNodes) {
    assert.ok(typeof n.name === 'string');
    assert.ok(typeof n.site === 'string');
  }
  // Links: interface block field names
  assert.equal(r.body.links.length, 2);
  assert.deepEqual(
    Object.keys(r.body.links[0]).sort(),
    ['lastSuccessTime','source','statusCode','target']
  );
  assert.equal(r.body.links[0].statusCode, 0);
  assert.equal(r.body.links[1].statusCode, 2);
});

// ----- ERRORS -----

test('errors: returns camelCase rows with status_code <> 0 and computed duration', async () => {
  const scripts = [
    {
      match: /status_code\s*<>\s*0/i,
      rows: [
        {
          source_dc: 'DC-A1', dest_dc: 'DC-B1',
          source_site: 'SITE-A', dest_site: 'SITE-B',
          naming_context: 'DC=contoso,DC=com',
          status_code: 2,
          last_success_time: new Date('2026-07-10T00:00:00Z'),
          last_attempt_time: new Date('2026-07-10T01:00:00Z'),
          duration_minutes: 60
        }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
  const r = await supertest(app)
    .get('/api/dashboard/errors')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].sourceDc, 'DC-A1');
  assert.equal(r.body[0].destDc, 'DC-B1');
  assert.equal(r.body[0].sourceSite, 'SITE-A');
  assert.equal(r.body[0].destSite, 'SITE-B');
  assert.equal(r.body[0].namingContext, 'DC=contoso,DC=com');
  assert.equal(r.body[0].statusCode, 2);
  assert.equal(r.body[0].durationMinutes, 60);
});

// ----- AGENTS -----

test('agents: returns camelCase rows with computed secondsSinceHeartbeat', async () => {
  const scripts = [
    {
      match: /FROM\s+ad_agent_heartbeat/i,
      rows: [
        {
          agent_id: 'agent-1',
          last_heartbeat_at: new Date('2026-07-10T00:00:00Z'),
          agent_version: '1.0.0',
          last_report_at: new Date('2026-07-10T00:01:00Z'),
          last_report_status: 'success',
          pending_queue_size: 0,
          seconds_since_heartbeat: 42
        }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
  const r = await supertest(app)
    .get('/api/dashboard/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].agentId, 'agent-1');
  assert.equal(r.body[0].agentVersion, '1.0.0');
  assert.equal(r.body[0].lastReportStatus, 'success');
  assert.equal(r.body[0].pendingQueueSize, 0);
  assert.equal(r.body[0].secondsSinceHeartbeat, 42);
});

// ----- DB ERROR PATH -----

test('overview: 500 on DB error, returns {error: "internal"}', async () => {
  const pool = {
    request() {
      return {
        _inputs: {},
        input() { return this; },
        async query() { throw new Error('boom'); }
      };
    }
  };
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'internal');
});