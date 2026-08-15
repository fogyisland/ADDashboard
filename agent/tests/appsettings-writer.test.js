import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCenterUrlAtomic } from '../src/appsettings-writer.js';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'appsettings-writer-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('writes new centerUrl atomically and preserves other fields', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({
      centerUrl: 'http://localhost:8080',
      agentId: 'DC1',
      agentToken: 'tok',
      logLevel: 'info'
    }, null, 2));
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://localhost:9080' });
    assert.equal(r.ok, true);
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.centerUrl, 'http://localhost:9080');
    assert.equal(reread.agentId, 'DC1');
    assert.equal(reread.agentToken, 'tok');
    assert.equal(reread.logLevel, 'info');
  } finally { cleanup(); }
});

test('returns {ok:false, error:read-failed} when file does not exist', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'missing.json');
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://x:1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /read-failed/);
  } finally { cleanup(); }
});

test('returns {ok:false, error:parse-failed} when file is not JSON', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, 'not-json');
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://x:1' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'parse-failed');
    // Original must be untouched on parse failure
    assert.equal(readFileSync(p, 'utf8'), 'not-json');
  } finally { cleanup(); }
});

test('returns {ok:false, error:write-failed} when target dir is not writable', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({ centerUrl: 'http://x:1' }));
    // Make the dir read-only — child file creation will fail
    chmodSync(dir, 0o555);
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://y:2' });
    assert.equal(r.ok, false);
    // The error must be present (some Windows variants may not honor 0o555;
    // we accept any failure marker that starts with `write-` or `rename-`).
    assert.ok(/^(write-|rename-)/.test(r.error || ''), `expected write-/rename- error, got ${r.error}`);
    // Restore permissions so cleanup() can remove the dir
    chmodSync(dir, 0o755);
  } finally { cleanup(); }
});

test('never throws even on garbage inputs', () => {
  // Path is null — should return error, not throw
  let r;
  try {
    r = writeCenterUrlAtomic({ path: null, newUrl: 'http://x:1' });
  } catch (e) {
    r = { threw: e };
  }
  assert.ok(!r.threw, 'should not throw');
  assert.equal(r.ok, false);
});