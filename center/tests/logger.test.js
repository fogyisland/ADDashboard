import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createLogger, createRotatedLogger } from '../src/logger.js';

test('logger writes JSON line with component field', () => {
  const lines = [];
  const sink = new Writable({
    write(chunk, enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); }
  });
  const log = createLogger({ component: 'test', stream: sink });
  log.info('hello');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'hello');
  assert.equal(lines[0].component, 'test');
  assert.equal(lines[0].level, 30); // info
});

// 2026-08-25 round-12 observability: the rotated logger pins the daily-
// rotation contract that production depends on. Verify a log line lands
// on disk after the factory returns, with the configured file path under
// our temp dir (pino-roll picks the rotation suffix via dateFormat).
test('createRotatedLogger writes JSON lines to the rotated file (daily)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'addash-logger-'));
  try {
    // pino-roll does NOT keep the original filename — it opens
    // <basename>.<date>.<n>.log directly. So the "file" we pass is
    // really a path prefix; we look for any file under dir whose name
    // starts with the basename.
    const file = join(dir, 'center.log');
    const log = await createRotatedLogger({
      component: 'center',
      level: 'info',
      file,
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      limit: { count: 3 },
      mkdir: true,
      sync: true
    });
    log.info('rotated hello');
    const files = readdirSync(dir).filter(f => f.startsWith('center'));
    assert.ok(files.length >= 1, `expected at least one rotated file in ${dir}, got: ${files.join(',')}`);
    const contents = files.map(f => readFileSync(join(dir, f), 'utf8')).join('');
    assert.ok(contents.includes('rotated hello'),
      `expected rotated file to contain 'rotated hello', got: ${contents.slice(0, 200)}`);
    assert.ok(contents.includes('"component":"center"'),
      `expected rotated line to include component=center, got: ${contents.slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createRotatedLogger requires file (no silent fallback to stderr)', async () => {
  await assert.rejects(
    () => createRotatedLogger({ component: 'center' }),
    /file is required/,
    'must reject when file is omitted so production never silently logs to stderr'
  );
});

// Sanity check: a no-op (mkdir false, file already in place) round-trip
// doesn't throw — guards the auto-install path that runs the first time
// the operator restarts after upgrading to a build that uses pino-roll.
test('createRotatedLogger: existing dir + existing file path is safe to re-init', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'addash-logger-'));
  try {
    const file = join(dir, 'center.log');
    const a = await createRotatedLogger({ component: 'center', file, mkdir: true });
    a.info('first instance');
    a.flush?.(); // best-effort; sync:true already ensures write
    // Second instance opens the same rotated file. Should not throw.
    const b = await createRotatedLogger({ component: 'center', file, mkdir: true });
    b.info('second instance');
    // The rotated file lives under <dir>/center.<date>.<n>.log, NOT at
    // the original `file` path. Verify some rotated file appeared.
    assert.ok(readdirSync(dir).some(f => f.startsWith('center')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
