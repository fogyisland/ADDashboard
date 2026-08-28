// 2026-08-25 round-12 observability: verify that each agent endpoint emits
// an info-level log line on entry with the data shape the operator needs
// to validate reports. The log is consumed by the rotated pino-roll file
// at runtime (see src/logger.js + server.js) but is wired here through
// `req.log.info(...)` against the logger the test app receives, so we
// capture it via a recording sink.
//
// What we assert per route:
//   - the log fires on the FIRST line of the handler, before the route
//     returns — so a 400-shaped validation failure still produces a log
//     line (the operator can see malformed reports)
//   - `event`, `source`, and `agentId` are present in every entry
//   - the data-shape summary fields are present and correctly counted
//   - missing `source` field falls back to 'unknown' (backward compat
//     with older agents that predate the source-stamping change)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../src/routes/agent.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildRecordingPool } from './helpers/db-mock.js';

// captureLogger returns a pino-shaped logger that records every info/warn/
// error call into `entries`. The factory in agent.js calls
// `logger.child({method, url})` from app.js middleware; since we don't go
// through app.js here, the test's buildApp passes the recording logger
// directly and req.log is the same object.
function captureLogger() {
  const entries = [];
  const rec = (level) => (...args) => entries.push({ level, args });
  const logger = {
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    debug: rec('debug'),
    fatal: rec('fatal'),
    trace: rec('trace'),
    child() { return logger; } // used by app.js but our buildApp wires req.log directly
  };
  return { logger, entries };
}

const AGENT_TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;

function buildApp({ agentTokenValue, logger, extraScripts = [], records = [] } = {}) {
  const app = express();
  app.use(express.json());
  // app.js middleware equivalent: stamp req.log so the route's
  // req.log.info(...) lands in our recording logger. The middleware form
  // uses logger.child(...) but tests don't care about the method/url
  // bindings — we just need req.log === our recording object.
  app.use((req, _res, next) => { req.log = logger; next(); });

  const scripts = [...extraScripts];
  if (agentTokenValue) {
    scripts.push({ match: AGENT_TOKEN_BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: agentTokenValue }] });
  }
  const db = scripts.length
    ? buildMockDb(scripts).withRecording(records)
    : buildRecordingPool(records);
  _setDbForTest(db);

  app.use(agentRouter({ config: { agentToken: agentTokenValue }, logger }));
  return app;
}

// Each test gets a fresh logger. Captured entries end with the relevant
// info log (we filter by .event key so warn/error noise from the
// middleware doesn't pollute the lookup).
function findEntry(entries, event) {
  return entries.find(e => e.args[0] && e.args[0].event === event);
}

test('heartbeat: emits info log with event/source/agentId + counts on entry', async () => {
  const { logger, entries } = captureLogger();
  const app = buildApp({
    agentTokenValue: 'tok',
    logger,
    extraScripts: [
      { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{ report_requested_at: null }] }
    ]
  });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({
      agentId: 'agent-1',
      source: 'heartbeat',
      agentVersion: '1.0.0',
      ports: [{ port: 445 }, { port: 50001 }],
      pendingQueueSize: 3,
      hostname: 'DC1.example.com'
    });
  assert.equal(res.status, 200);
  const entry = findEntry(entries, 'agent.heartbeat');
  assert.ok(entry, 'expected an agent.heartbeat info entry');
  const data = entry.args[0];
  assert.equal(data.source, 'heartbeat');
  assert.equal(data.agentId, 'agent-1');
  assert.equal(data.agentVersion, '1.0.0');
  assert.equal(data.portsCount, 2);
  assert.equal(data.pendingQueueSize, 3);
  assert.equal(data.hostname, 'DC1.example.com');
  assert.equal(entry.args[1], 'agent heartbeat received');
});

test('heartbeat: missing source field falls back to "unknown" (backward compat)', async () => {
  const { logger, entries } = captureLogger();
  const app = buildApp({
    agentTokenValue: 'tok',
    logger,
    extraScripts: [
      { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{ report_requested_at: null }] }
    ]
  });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', ports: [] });
  assert.equal(res.status, 200);
  const entry = findEntry(entries, 'agent.heartbeat');
  assert.ok(entry);
  assert.equal(entry.args[0].source, 'unknown');
});

test('report: emits info log with entries/summaryEntries counts + source on entry', async () => {
  // 2026-08-26 round-18: lockoutEvents removed from the report payload
  // and the per-route log; lockout data ships via the ad_lockout_list
  // package on a 15-minute cadence instead.
  const { logger, entries } = captureLogger();
  const app = buildApp({
    agentTokenValue: 'tok',
    logger,
    extraScripts: [
      { match: /SELECT\s+config_key,\s*config_value\s+FROM\s+system_config/i,
        rows: [{ config_key: 'history_enabled', config_value: 'true' }] },
      { match: /FROM\s+system_config/i,
        rows: [
          { config_key: 'polling_interval_minutes', config_value: '15' },
          { config_key: 'latency_threshold_minutes', config_value: '180' },
          { config_key: 'heartbeat_interval_seconds', config_value: '5' }
        ] }
    ]
  });
  const res = await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'tok')
    .send({
      source: 'collect-replication',
      agentId: 'agent-1',
      collectedAt: '2026-07-11T00:00:00Z',
      data: [
        { sourceDc: 'DC-A', destDc: 'DC-B', namingContext: '__dc_summary__' },
        { sourceDc: 'DC-A', destDc: 'DC-B', namingContext: '__partner_ports__:DC-B' }
      ]
    });
  assert.equal(res.status, 200);
  const entry = findEntry(entries, 'agent.report');
  assert.ok(entry, 'expected an agent.report info entry');
  const data = entry.args[0];
  assert.equal(data.source, 'collect-replication');
  assert.equal(data.agentId, 'agent-1');
  assert.equal(data.entries, 2);
  // 2026-08-28 round-45: partnerPortEntries counter removed (R35 port
  // monitoring surface dropped — agent emits no __partner_ports__:% rows).
  assert.equal(data.summaryEntries, 1);
  assert.equal(entry.args[1], 'agent report received');
});

test('report: summaryEntries surfaces __dc_summary__ rows independently', async () => {
  // 2026-08-26 round-18: this replaces the previous Bug Z surface-area
  // test that asserted on a lockoutEvents=0 default. The lockoutEvents
  // field no longer exists; the operator now reads lockout trends from
  // the ad_lockout_summary / ad_lockout_list packages instead.
  const { logger, entries } = captureLogger();
  const app = buildApp({
    agentTokenValue: 'tok',
    logger,
    extraScripts: [
      { match: /SELECT\s+config_key,\s*config_value\s+FROM\s+system_config/i,
        rows: [{ config_key: 'history_enabled', config_value: 'true' }] },
      { match: /FROM\s+system_config/i,
        rows: [
          { config_key: 'polling_interval_minutes', config_value: '15' },
          { config_key: 'latency_threshold_minutes', config_value: '180' },
          { config_key: 'heartbeat_interval_seconds', config_value: '5' }
        ] }
    ]
  });
  await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'tok')
    .send({
      source: 'collect-replication',
      agentId: 'agent-1',
      collectedAt: '2026-07-11T00:00:00Z',
      data: [{ sourceDc: 'DC-A', destDc: 'DC-B', namingContext: '__dc_summary__' }]
    });
  const entry = findEntry(entries, 'agent.report');
  assert.ok(entry);
  assert.equal(entry.args[0].summaryEntries, 1, '__dc_summary__ row must count');
  // partnerPortEntries counter removed in round-45 (R35 port monitoring
  // surface dropped).
});

test('discover: emits info log with dcName/dcSite/rolesCount on entry', async () => {
  const { logger, entries } = captureLogger();
  const app = buildApp({ agentTokenValue: 'tok', logger });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'tok')
    .send({
      source: 'collect-discovery',
      agentId: 'agent-1',
      collectedAt: '2026-07-11T00:00:00Z',
      dc: { name: 'DC-A', site: 'SiteA', roles: ['PDC', 'RID'] }
    });
  assert.equal(res.status, 200);
  const entry = findEntry(entries, 'agent.discover');
  assert.ok(entry);
  const data = entry.args[0];
  assert.equal(data.source, 'collect-discovery');
  assert.equal(data.agentId, 'agent-1');
  assert.equal(data.dcName, 'DC-A');
  assert.equal(data.dcSite, 'SiteA');
  assert.equal(data.rolesCount, 2);
});

test('discover: missing source falls back to "unknown"', async () => {
  const { logger, entries } = captureLogger();
  const app = buildApp({ agentTokenValue: 'tok', logger });
  await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'tok')
    .send({
      agentId: 'agent-1',
      collectedAt: '2026-07-11T00:00:00Z',
      dc: { name: 'DC-A' }
    });
  const entry = findEntry(entries, 'agent.discover');
  assert.ok(entry);
  assert.equal(entry.args[0].source, 'unknown');
});