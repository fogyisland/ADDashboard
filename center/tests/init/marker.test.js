import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

function readEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

test('writeMarker: creates .env file with ADDASHBOARD_INITIALIZED=1', async () => {
  const dir = freshDir();
  const { exec } = fakeExec([{ code: 0, stdout: '', stderr: '' }]);
  await writeMarker(dir, exec);
  const f = join(dir, '.env');
  assert.ok(existsSync(f), '.env file created');
  const env = readEnv(f);
  assert.equal(env.ADDASHBOARD_INITIALIZED, '1');
  assert.ok(typeof env.ADDASHBOARD_INITIALIZED_AT === 'string');
  assert.ok(!isNaN(Date.parse(env.ADDASHBOARD_INITIALIZED_AT)), 'at is parseable ISO date');
});

test('writeMarker: preserves pre-existing keys in .env', async () => {
  const dir = freshDir();
  const f = join(dir, '.env');
  writeFileSync(f, 'EXISTING_KEY=keep-me\n# a comment\n');
  const { exec } = fakeExec([{ code: 0, stdout: '', stderr: '' }]);
  await writeMarker(dir, exec);
  const env = readEnv(f);
  assert.equal(env.EXISTING_KEY, 'keep-me');
  assert.equal(env.ADDASHBOARD_INITIALIZED, '1');
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
    assert.ok(existsSync(join(dir, '.env')), '.env marker still created');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('writeMarker: tolerates registry failure but still writes .env', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const dir = freshDir();
    const { exec } = fakeExec([{ code: 1, stdout: '', stderr: 'access denied' }]);
    await writeMarker(dir, exec);
    assert.ok(existsSync(join(dir, '.env')), '.env marker created despite registry failure');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('clearMarker: removes init keys but keeps unrelated keys', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    const f = join(dir, '.env');
    writeFileSync(f, 'EXISTING_KEY=keep-me\nADDASHBOARD_INITIALIZED=1\nADDASHBOARD_INITIALIZED_AT=2026-01-01T00:00:00.000Z\n');
    const { exec } = fakeExec([]);
    await clearMarker(dir, exec);
    const env = readEnv(f);
    assert.equal(env.EXISTING_KEY, 'keep-me');
    assert.equal(env.ADDASHBOARD_INITIALIZED, undefined);
    assert.equal(env.ADDASHBOARD_INITIALIZED_AT, undefined);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('clearMarker: deletes .env entirely when only init keys were present', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    const f = join(dir, '.env');
    writeFileSync(f, 'ADDASHBOARD_INITIALIZED=1\nADDASHBOARD_INITIALIZED_AT=2026-01-01T00:00:00.000Z\n');
    const { exec } = fakeExec([]);
    await clearMarker(dir, exec);
    assert.ok(!existsSync(f), '.env removed when empty after clear');
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('clearMarker: tolerates missing file', async () => {
  const dir = freshDir();
  const { exec } = fakeExec([]);
  await clearMarker(dir, exec);
});

test('hasMarker: returns true when .env has ADDASHBOARD_INITIALIZED=1', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    writeFileSync(join(dir, '.env'), 'ADDASHBOARD_INITIALIZED=1\nADDASHBOARD_INITIALIZED_AT=2026-01-01T00:00:00.000Z\n');
    const { exec } = fakeExec([]);
    const result = await hasMarker(dir, exec);
    assert.equal(result, true);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('hasMarker: returns true when .env has ADDASHBOARD_INITIALIZED=true', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    writeFileSync(join(dir, '.env'), 'ADDASHBOARD_INITIALIZED=true\n');
    const { exec } = fakeExec([]);
    const result = await hasMarker(dir, exec);
    assert.equal(result, true);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('hasMarker: returns false when no .env and no registry', async () => {
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

test('hasMarker: ignores .env without the marker key', async () => {
  const origPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const dir = freshDir();
    writeFileSync(join(dir, '.env'), 'OTHER_KEY=value\n');
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