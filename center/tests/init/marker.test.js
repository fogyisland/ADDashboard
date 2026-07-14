import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMarker, clearMarker, hasMarker, installPathFromConfigPath } from '../../src/init/marker.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'marker-test-'));
}

function fakeExec(plan) {
  const calls = [];
  let i = 0;
  return {
    calls,
    exec: async (args) => {
      calls.push(args);
      const r = plan[i++] ?? { code: 0, stdout: '', stderr: '' };
      return r;
    }
  };
}

test('writeMarker: creates .initialized file with ISO timestamp', async () => {
  const dir = freshDir();
  const { exec } = fakeExec([{ code: 0, stdout: '', stderr: '' }]);
  await writeMarker(dir, exec);
  const f = join(dir, '.initialized');
  assert.ok(existsSync(f), 'marker file created');
  const meta = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(typeof meta.at === 'string', 'has at timestamp');
  assert.ok(!isNaN(Date.parse(meta.at)), 'at is parseable ISO date');
});

test('writeMarker: invokes reg add on win32', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = freshDir();
    const { calls, exec } = fakeExec([{ code: 0, stdout: '', stderr: '' }]);
    await writeMarker(dir, exec);
    assert.equal(calls.length, 1, 'one registry call');
    assert.deepEqual(calls[0].slice(0, 2), ['add', 'HKLM\\SOFTWARE\\ADDashboard']);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('writeMarker: skips registry on non-win32', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    const { calls, exec } = fakeExec([]);
    await writeMarker(dir, exec);
    assert.equal(calls.length, 0, 'no registry calls on linux');
    assert.ok(existsSync(join(dir, '.initialized')), 'file marker still created');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('writeMarker: tolerates registry failure but still writes file', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = freshDir();
    const { exec } = fakeExec([{ code: 1, stdout: '', stderr: 'access denied' }]);
    await writeMarker(dir, exec); // should not throw
    assert.ok(existsSync(join(dir, '.initialized')), 'file marker created despite registry failure');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('clearMarker: removes file and registry value', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = freshDir();
    writeFileSync(join(dir, '.initialized'), '{"at":"2026-01-01T00:00:00.000Z"}');
    const { calls, exec } = fakeExec([{ code: 0, stdout: '', stderr: '' }]);
    await clearMarker(dir, exec);
    assert.ok(!existsSync(join(dir, '.initialized')), 'file removed');
    assert.equal(calls.length, 1, 'one registry call');
    assert.deepEqual(calls[0].slice(0, 2), ['delete', 'HKLM\\SOFTWARE\\ADDashboard']);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('clearMarker: tolerates missing file', async () => {
  const dir = freshDir();
  const { exec } = fakeExec([]);
  await clearMarker(dir, exec); // should not throw
});

test('hasMarker: returns true when file exists', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    writeFileSync(join(dir, '.initialized'), '{"at":"2026-01-01T00:00:00.000Z"}');
    const { exec } = fakeExec([]);
    const result = await hasMarker(dir, exec);
    assert.equal(result, true);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('hasMarker: returns false when no file and no registry', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = freshDir();
    const { exec } = fakeExec([{ code: 1, stdout: '', stderr: 'unable to find' }]);
    const result = await hasMarker(dir, exec);
    assert.equal(result, false);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('hasMarker: returns true when registry has the value', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = freshDir();
    const { exec } = fakeExec([{
      code: 0,
      stdout: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\ADDashboard\n    Initialized    REG_DWORD    0x1\n',
      stderr: ''
    }]);
    const result = await hasMarker(dir, exec);
    assert.equal(result, true);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('hasMarker: ignores malformed marker file (no `at` field)', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    writeFileSync(join(dir, '.initialized'), 'not json');
    const { exec } = fakeExec([]);
    const result = await hasMarker(dir, exec);
    assert.equal(result, false);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('installPathFromConfigPath: dirname of config path', () => {
  assert.equal(installPathFromConfigPath('/etc/addashboard/appsettings.json'), '/etc/addashboard');
  assert.equal(installPathFromConfigPath('./appsettings.json'), '.');
  assert.equal(installPathFromConfigPath('C:\\Program Files\\ADDashboard\\Center\\appsettings.json'),
    'C:\\Program Files\\ADDashboard\\Center');
});