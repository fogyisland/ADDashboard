// 2026-08-21 UX redesign (auto-delivery): tests for writeAgentTokenAtomic
// + applyAgentTokenDelivery. Two complementary surfaces:
//   - atomic write of { agentToken, agentTokenVersion } to appsettings.json
//   - the version-compare + persistence + in-memory swap that the heartbeat
//     send callback invokes after every postHeartbeat.
//
// The round-trip integration (mocked HTTP server → centre-shaped response
// → appsettings.json updated on disk) lives further down so the file
// exercises the full chain end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAgentTokenAtomic } from '../src/appsettings-writer.js';
import { applyAgentTokenDelivery } from '../src/agent-token-delivery.js';

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-token-delivery-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function seedAppsettings(dir, fields = {}) {
  const p = join(dir, 'appsettings.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://localhost:8080',
    agentId: 'DC1',
    agentToken: 'OLD-TOK',
    agentTokenVersion: 0,
    logLevel: 'info',
    ...fields
  }, null, 2));
  return p;
}

// ----- writeAgentTokenAtomic -----

test('writeAgentTokenAtomic writes new token + version, preserves other fields', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const r = writeAgentTokenAtomic({ path: p, newToken: 'NEW-TOK', newVersion: 5 });
    assert.equal(r.ok, true);
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.agentToken, 'NEW-TOK');
    assert.equal(reread.agentTokenVersion, 5);
    // Untouched fields
    assert.equal(reread.centerUrl, 'http://localhost:8080');
    assert.equal(reread.agentId, 'DC1');
    assert.equal(reread.logLevel, 'info');
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic overwrites only token + version when other fields present', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir, {
      customField: 'preserve-me',
      nested: { a: 1, b: [2, 3] }
    });
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: 1 });
    assert.equal(r.ok, true);
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.agentToken, 'X');
    assert.equal(reread.agentTokenVersion, 1);
    assert.equal(reread.customField, 'preserve-me');
    assert.deepEqual(reread.nested, { a: 1, b: [2, 3] });
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: invalid path returns error, never throws', () => {
  let r;
  try {
    r = writeAgentTokenAtomic({ path: null, newToken: 'X', newVersion: 1 });
  } catch (e) {
    r = { threw: e };
  }
  assert.ok(!r.threw, 'must not throw');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid-path');
});

test('writeAgentTokenAtomic: empty newToken returns error', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const r = writeAgentTokenAtomic({ path: p, newToken: '', newVersion: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid-newToken');
    // File untouched
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.agentToken, 'OLD-TOK');
    assert.equal(reread.agentTokenVersion, 0);
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: version=0 is rejected (0 means fresh-install)', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid-newVersion');
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: non-integer version is rejected', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: 1.5 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid-newVersion');
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: negative version is rejected', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: -1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid-newVersion');
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: NaN version is rejected', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: 'not-a-number' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid-newVersion');
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: missing file returns read-failed error', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'missing.json');
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /read-failed/);
  } finally { cleanup(); }
});

test('writeAgentTokenAtomic: corrupt JSON returns parse-failed error, file untouched', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, 'not-json');
    const r = writeAgentTokenAtomic({ path: p, newToken: 'X', newVersion: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'parse-failed');
    assert.equal(readFileSync(p, 'utf8'), 'not-json');
  } finally { cleanup(); }
});

// ----- applyAgentTokenDelivery -----

function makeConfig(overrides = {}) {
  return {
    agentToken: 'OLD-TOK',
    agentTokenVersion: 0,
    centerUrl: 'http://localhost:8080',
    ...overrides
  };
}

test('applyAgentTokenDelivery: no-op when result is null', async () => {
  const config = makeConfig();
  const r = await applyAgentTokenDelivery({ result: null, config, configPath: 'X', logger: noopLogger });
  assert.deepEqual(r, { applied: false });
  assert.equal(config.agentToken, 'OLD-TOK');
});

test('applyAgentTokenDelivery: no-op when result.ok is false', async () => {
  const config = makeConfig();
  const r = await applyAgentTokenDelivery({
    result: { ok: false, status: 500, data: { agentToken: 'X', agentTokenVersion: 5 } },
    config, configPath: 'X', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
  assert.equal(config.agentToken, 'OLD-TOK');
});

test('applyAgentTokenDelivery: no-op when result.data is missing', async () => {
  const config = makeConfig();
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: null },
    config, configPath: 'X', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
  assert.equal(config.agentToken, 'OLD-TOK');
});

test('applyAgentTokenDelivery: no-op when agentToken missing in payload', async () => {
  const config = makeConfig();
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: { agentTokenVersion: 5 } },
    config, configPath: 'X', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
});

test('applyAgentTokenDelivery: no-op when agentTokenVersion < current (older)', async () => {
  const config = makeConfig({ agentTokenVersion: 5 });
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: { agentToken: 'NEW', agentTokenVersion: 4 } },
    config, configPath: 'X', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
  assert.equal(config.agentToken, 'OLD-TOK');
  assert.equal(config.agentTokenVersion, 5);
});

test('applyAgentTokenDelivery: no-op when agentTokenVersion == current (already up-to-date)', async () => {
  const config = makeConfig({ agentTokenVersion: 5 });
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: { agentToken: 'NEW', agentTokenVersion: 5 } },
    config, configPath: 'X', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
  assert.equal(config.agentToken, 'OLD-TOK');
});

test('applyAgentTokenDelivery: no-op when agentTokenVersion is 0 in response (defensive)', async () => {
  const config = makeConfig();
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: { agentToken: 'NEW', agentTokenVersion: 0 } },
    config, configPath: 'X', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
});

test('applyAgentTokenDelivery: writes atomically + updates in-memory when version is newer', async () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const config = makeConfig();
    const r = await applyAgentTokenDelivery({
      result: { ok: true, data: { agentToken: 'NEW-TOK', agentTokenVersion: 7 } },
      config, configPath: p, logger: noopLogger
    });
    assert.equal(r.applied, true);
    assert.equal(r.previousVersion, 0);
    assert.equal(r.newVersion, 7);
    // In-memory updated
    assert.equal(config.agentToken, 'NEW-TOK');
    assert.equal(config.agentTokenVersion, 7);
    // On-disk updated
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.agentToken, 'NEW-TOK');
    assert.equal(reread.agentTokenVersion, 7);
    // Other fields preserved
    assert.equal(reread.centerUrl, 'http://localhost:8080');
    assert.equal(reread.agentId, 'DC1');
  } finally { cleanup(); }
});

test('applyAgentTokenDelivery: write failure does NOT update in-memory', async () => {
  const config = makeConfig();
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: { agentToken: 'NEW-TOK', agentTokenVersion: 7 } },
    config, configPath: '/nonexistent/path/appsettings.json', logger: noopLogger
  });
  assert.equal(r.applied, false);
  assert.match(r.error, /read-failed/);
  // In-memory NOT swapped — the agent keeps the old credential this run.
  assert.equal(config.agentToken, 'OLD-TOK');
  assert.equal(config.agentTokenVersion, 0);
});

// ----- Round-trip integration: mocked HTTP server -----
//
// Boots an http server that mimics the centre's /api/agent/heartbeat
// response shape. Verifies that:
//   (1) the agent payload includes agent_token_version
//   (2) when the centre replies with a newer version, appsettings.json
//       gets both fields updated atomically
//   (3) subsequent heartbeats use the new token (X-Agent-Token header)

async function withServer(handler, fn) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try { await fn(`http://127.0.0.1:${port}`); } finally { srv.close(() => resolve()); }
    });
  });
}

test('round-trip: centre returns newer version → payload includes agent_token_version, config + disk updated', async () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir);
    const config = makeConfig();
    // Centre replies with version 1 on first heartbeat (fresh install →
    // version 0 in agent payload → centre bumps + delivers version 1).
    let receivedVersion = null;
    let receivedTokenHeader = null;
    let callCount = 0;
    const serverVersion = 1;

    await withServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        callCount++;
        const parsed = JSON.parse(body);
        if (callCount === 1) receivedVersion = parsed.agent_token_version;
        if (callCount === 2) receivedTokenHeader = req.headers['x-agent-token'];
        res.end(JSON.stringify({
          ok: true,
          agentToken: 'DELIVERED-TOK',
          agentTokenVersion: serverVersion
        }));
      });
    }, async (url) => {
      const { postHeartbeat } = await import('../src/reporter.js');
      // Tick 1: agent version=0, centre replies with version=1
      const r1 = await postHeartbeat({ centerUrl: url, agentToken: config.agentToken, payload: {
        agentId: 'DC1',
        agent_token_version: Number(config.agentTokenVersion) || 0
      }});
      await applyAgentTokenDelivery({ result: r1, config, configPath: p, logger: noopLogger });
      // Tick 2: agent version=1, centre reply swallowed (version unchanged)
      const r2 = await postHeartbeat({ centerUrl: url, agentToken: config.agentToken, payload: {
        agentId: 'DC1',
        agent_token_version: Number(config.agentTokenVersion) || 0
      }});
      await applyAgentTokenDelivery({ result: r2, config, configPath: p, logger: noopLogger });
    });

    // (1) The first heartbeat payload included agent_token_version: 0
    assert.equal(receivedVersion, 0, 'first heartbeat should carry version 0');
    // (2) Disk updated atomically — both fields
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.agentToken, 'DELIVERED-TOK');
    assert.equal(reread.agentTokenVersion, 1);
    // (3) In-memory updated for use on the next heartbeat
    assert.equal(config.agentToken, 'DELIVERED-TOK');
    assert.equal(config.agentTokenVersion, 1);
    // (4) Second heartbeat used the new token
    assert.equal(receivedTokenHeader, 'DELIVERED-TOK');
  } finally { cleanup(); }
});

test('round-trip: centre does NOT reply with agentToken when agent is already up-to-date', async () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = seedAppsettings(dir, { agentToken: 'CURRENT-TOK', agentTokenVersion: 3 });
    const config = makeConfig({ agentToken: 'CURRENT-TOK', agentTokenVersion: 3 });
    let calls = 0;

    await withServer((req, res) => {
      calls++;
      res.end(JSON.stringify({ ok: true })); // no agentToken field
    }, async (url) => {
      const { postHeartbeat } = await import('../src/reporter.js');
      const r = await postHeartbeat({ centerUrl: url, agentToken: config.agentToken, payload: {
        agentId: 'DC1',
        agent_token_version: config.agentTokenVersion
      }});
      await applyAgentTokenDelivery({ result: r, config, configPath: p, logger: noopLogger });
    });

    // Disk untouched (still version=3)
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.agentToken, 'CURRENT-TOK');
    assert.equal(reread.agentTokenVersion, 3);
    assert.equal(config.agentToken, 'CURRENT-TOK');
    assert.equal(config.agentTokenVersion, 3);
    assert.equal(calls, 1);
  } finally { cleanup(); }
});

test('round-trip: existing in-memory version matches centre → no delivery payload → config unchanged', async () => {
  // When the agent reports version=N and the centre is also at version=N,
  // the centre omits agentToken from the response. The helper must
  // recognise "no payload" as "nothing to do" and leave both disk + memory
  // alone (the previous version-comparison logic was correct, this test
  // locks it down).
  const config = makeConfig({ agentTokenVersion: 5 });
  const r = await applyAgentTokenDelivery({
    result: { ok: true, data: { ok: true, accepted: 0, rejected: 0 } }, // no agentToken
    config, configPath: '/nonexistent', logger: noopLogger
  });
  assert.deepEqual(r, { applied: false });
  assert.equal(config.agentToken, 'OLD-TOK');
  assert.equal(config.agentTokenVersion, 5);
});

// ----- Defaults: config.js agentTokenVersion -----

test('config.js: loadConfig defaults agentTokenVersion to 0 when absent', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'appsettings.json');
    writeFileSync(p, JSON.stringify({
      centerUrl: 'http://localhost:8080',
      agentId: 'DC1',
      agentToken: 'tok'
    }));
    const cfg = loadConfig(p);
    assert.equal(cfg.agentTokenVersion, 0);
  } finally { cleanup(); }
});

test('config.js: loadConfig preserves explicit agentTokenVersion from appsettings.json', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'appsettings.json');
    writeFileSync(p, JSON.stringify({
      centerUrl: 'http://localhost:8080',
      agentId: 'DC1',
      agentToken: 'tok',
      agentTokenVersion: 7
    }));
    const cfg = loadConfig(p);
    assert.equal(cfg.agentTokenVersion, 7);
  } finally { cleanup(); }
});
