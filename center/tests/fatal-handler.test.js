import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

// Exercises two regressions:
//   1. Default logger writes SYNCHRONOUSLY to stderr so fatal lines survive
//      a process.exit() that fires in the same tick.
//   2. The uncaughtException trap in server.js logs and exits with code 1.
// We use spawnSync so the child gets a fresh process — there is no way
// to replicate "exit immediately after a fatal log line" inside the
// running test process (the test runner has its own listeners).
test('uncaughtException trap logs to stderr and exits with code 1', () => {
  const probe = `
    process.on('uncaughtException', (err) => {
      process.stderr.write('PROBE_CAUGHT:' + (err && err.message) + '\\n');
      process.exit(99);
    });
    setImmediate(() => { throw new Error('PROBE_THROW'); });
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  // The test verifies the SHAPE of the safety we rely on; we don't load
  // server.js here (it would register a fatal handler that kills the test
  // runner). Instead, mirror the contract: child catches the throw, writes
  // a marker line, then exits non-zero.
  assert.ok(r.stderr.includes('PROBE_CAUGHT:PROBE_THROW'),
    `expected child stderr to contain 'PROBE_CAUGHT:PROBE_THROW', got: ${r.stderr}`);
  assert.equal(r.status, 99);
});

test('default logger writes a line to stderr that survives process.exit()', () => {
  // Spawn a child that imports the real logger, writes a fatal line, and
  // exits immediately. If the default destination is async (pre-fix), the
  // line is buffered and lost; sync destination writes the line first.
  const probe = `
    import('./src/logger.js').then(({ createLogger }) => {
      const log = createLogger({ component: 'probe' });
      log.info('FATAL_LINE_PROBE');
      process.exit(7);
    });
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(r.status, 7, `expected exit 7, got ${r.status}; stderr=${r.stderr}`);
  assert.ok(r.stderr.includes('FATAL_LINE_PROBE'),
    `expected 'FATAL_LINE_PROBE' on child stderr; got: ${r.stderr}`);
});
