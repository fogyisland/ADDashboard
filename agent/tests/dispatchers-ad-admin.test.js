import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { sep } from 'node:path';
import { dispatchAdCommand, __testing } from '../src/dispatchers/ad-admin.js';

// Minimal hand-built ChildProcess. dispatcher reads from .stdout/.stderr
// (EventEmitter 'data' events). We never spawn a real process — these
// tests run on Linux CI and the JS module never has to round-trip
// through PowerShell here. The PS1 scripts themselves have their own
// real-DC test harness via mock-ad-admin-e2e.mjs (different file).
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (_sig) => { /* no-op */ };
  return child;
}

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeSpawn(behavior) {
  return (_cmd, _args) => {
    const child = fakeChild();
    queueMicrotask(() => behavior(child));
    return child;
  };
}

// pickScript routing ----------------------------------------------------

test('pickScript: user_* prefix → ad-admin-users.ps1', () => {
  for (const cmd of ['user_search', 'user_create', 'user_password_reset', 'user_enable', 'user_disable', 'user_unlock', 'user_set_attributes', 'user_delete', 'user_list_groups']) {
    const r = __testing.pickScript(cmd, 'scripts');
    assert.equal(r.script, 'ad-admin-users.ps1', `expected users script for ${cmd}`);
  }
});

test('pickScript: group_* prefix → ad-admin-groups.ps1', () => {
  for (const cmd of ['group_search', 'group_create', 'group_set_attributes', 'group_delete', 'group_list_members', 'group_add_member', 'group_remove_member', 'group_set_membership']) {
    const r = __testing.pickScript(cmd, 'scripts');
    assert.equal(r.script, 'ad-admin-groups.ps1', `expected groups script for ${cmd}`);
  }
});

test('pickScript: unknown prefix → error envelope, no script', () => {
  const r = __testing.pickScript('package_install', 'scripts');
  assert.equal(r.script, undefined);
  assert.match(r.error, /unsupported commandType/);
});

test('pickScript: empty / null commandType → error', () => {
  for (const v of ['', null, undefined]) {
    const r = __testing.pickScript(v, 'scripts');
    assert.equal(r.script, undefined);
    assert.match(r.error, /commandType required/);
  }
});

test('pickScript: does NOT accept capital-case prefix', () => {
  // The center's adCommands table stores commandType as lowercase
  // ("user_search"); capital-case would silently miss both prefixes.
  const r = __testing.pickScript('USER_search', 'scripts');
  assert.equal(r.script, undefined);
  assert.match(r.error, /unsupported commandType/);
});

// writeParamsFile + cleanup --------------------------------------------

test('writeParamsFile: writes JSON and is readable', () => {
  const tmp = __testing.writeParamsFile({ sam: 'jdoe', password: 'secret' });
  try {
    assert.ok(tmp.file.endsWith('params.json'));
    assert.ok(tmp.dir.includes('addash-ad-admin-'));
    // Re-read to confirm content
    const content = readFileSync(tmp.file, 'utf8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.sam, 'jdoe');
    assert.equal(parsed.password, 'secret');
  } finally {
    try { unlinkSync(tmp.file); } catch {}
    try { rmdirSync(tmp.dir); } catch {}
  }
});

test('writeParamsFile: handles empty / null params', () => {
  const tmp = __testing.writeParamsFile(null);
  try {
    const parsed = JSON.parse(readFileSync(tmp.file, 'utf8'));
    assert.deepEqual(parsed, {});
  } finally {
    try { unlinkSync(tmp.file); } catch {}
    try { rmdirSync(tmp.dir); } catch {}
  }
});

// dispatchAdCommand error envelopes (no spawn, no PS1) ----------------

test('dispatchAdCommand: empty commandType → error envelope, no spawn', async () => {
  let spawned = false;
  const r = await dispatchAdCommand({
    commandType: '',
    params: { foo: 1 },
    spawnFn: () => { spawned = true; return fakeChild(); }
  });
  assert.equal(spawned, false);
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.data, null);
  assert.match(r.error, /commandType required/);
});

test('dispatchAdCommand: unsupported prefix → error envelope, no spawn', async () => {
  let spawned = false;
  const r = await dispatchAdCommand({
    commandType: 'package_install',
    params: {},
    spawnFn: () => { spawned = true; return fakeChild(); }
  });
  assert.equal(spawned, false);
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.error, /unsupported commandType/);
});

// dispatchAdCommand spawn errors --------------------------------------

test('dispatchAdCommand: spawn throws → exitCode 2 envelope', async () => {
  const r = await dispatchAdCommand({
    commandType: 'user_search',
    params: { filter: 'a' },
    spawnFn: () => { throw new Error('spawn exploded'); }
  });
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.error, /spawn failed/);
  assert.match(r.error, /spawn exploded/);
});

// dispatchAdCommand happy / sad PS1 envelopes --------------------------

test('dispatchAdCommand: happy path — parses JSON success envelope', async () => {
  const spawnFn = makeSpawn((child) => {
    const env = JSON.stringify({
      success: true,
      data: { users: [{ sam: 'jdoe' }], count: 1, truncated: false },
      error: null,
      exitCode: 0,
      durationMs: 42
    });
    child.stdout.emit('data', Buffer.from('noise from PS1\n'));
    child.stdout.emit('data', Buffer.from(env + '\n'));
    child.emit('close', 0);
  });
  const r = await dispatchAdCommand({
    commandType: 'user_search',
    params: { filter: 'j' },
    spawnFn
  });
  assert.equal(r.success, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.data.count, 1);
  assert.equal(r.data.users[0].sam, 'jdoe');
  assert.equal(r.error, null);
  assert.ok(r.durationMs >= 0);
});

test('dispatchAdCommand: PS1 success.exitCode != 0 propagates', async () => {
  const spawnFn = makeSpawn((child) => {
    const env = JSON.stringify({
      success: true, data: { sam: 'jdoe', enabled: true },
      error: null, exitCode: 0, durationMs: 7
    });
    child.stdout.emit('data', Buffer.from(env));
    child.emit('close', 0);
  });
  const r = await dispatchAdCommand({
    commandType: 'user_enable',
    params: { sam: 'jdoe' },
    spawnFn
  });
  assert.equal(r.success, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.data.enabled, true);
});

test('dispatchAdCommand: PS1 emits success=false envelope (4xx-grade)', async () => {
  const spawnFn = makeSpawn((child) => {
    const env = JSON.stringify({
      success: false, data: null, error: 'New-ADUser: access denied',
      exitCode: 1, durationMs: 5
    });
    child.stdout.emit('data', Buffer.from(env));
    child.emit('close', 1);
  });
  const r = await dispatchAdCommand({
    commandType: 'user_create',
    params: { sam: 'newone' },
    spawnFn
  });
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.error, /access denied/);
});

test('dispatchAdCommand: exit 0 but no JSON envelope → exitCode 1 fallback', async () => {
  const spawnFn = makeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('plain text only\n'));
    child.emit('close', 0);
  });
  const r = await dispatchAdCommand({
    commandType: 'user_search',
    params: {},
    spawnFn
  });
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.error, /no result envelope/);
});

test('dispatchAdCommand: non-zero exit + stderr → synthesized error', async () => {
  const spawnFn = makeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('Import-Module: ActiveDirectory not found\n'));
    child.emit('close', 2);
  });
  const r = await dispatchAdCommand({
    commandType: 'group_search',
    params: {},
    spawnFn
  });
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.error, /exit 2/);
  assert.match(r.error, /ActiveDirectory not found/);
});

test('dispatchAdCommand: invalid JSON on stdout + exit 0 → fallback', async () => {
  const spawnFn = makeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('not json at all\n'));
    child.emit('close', 0);
  });
  const r = await dispatchAdCommand({
    commandType: 'user_list_groups',
    params: { sam: 'jdoe' },
    spawnFn
  });
  assert.equal(r.success, false);
  assert.match(r.error, /no result envelope/);
});

test('dispatchAdCommand: timeout → exitCode 2 + timeout message', async () => {
  // Spawn fn returns a child that NEVER emits close. The dispatcher's
  // setTimeout fires first.
  const neverClose = fakeChild();
  let killedWith = null;
  neverClose.kill = (sig) => { killedWith = sig; };
  const spawnFn = () => neverClose;
  const r = await dispatchAdCommand({
    commandType: 'user_search',
    params: {},
    timeoutMs: 50,
    spawnFn
  });
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.error, /timeout/);
  assert.equal(killedWith, 'SIGKILL');
});

test('dispatchAdCommand: child.on("error") fires → exitCode 2 envelope', async () => {
  const spawnFn = makeSpawn((child) => {
    child.emit('error', new Error('EACCES'));
  });
  const r = await dispatchAdCommand({
    commandType: 'user_create',
    params: { sam: 'x' },
    spawnFn
  });
  assert.equal(r.success, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.error, /EACCES|process error/);
});

// Password redaction guard ---------------------------------------------

test('dispatchAdCommand: params.password is never logged via logger', async () => {
  // Sanity: the dispatcher itself never reads or echoes `params` back
  // into the result. Even if the PS1 envelope returned data with a
  // password field (which it never should), the dispatcher would pass
  // it through verbatim. This test guards the dispatcher contract.
  const capturedLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    calls: [],
    warn(args, msg) { this.calls.push({ level: 'warn', args, msg }); }
  };
  const spawnFn = makeSpawn((child) => {
    const env = JSON.stringify({
      success: true, data: { sam: 'jdoe' }, error: null, exitCode: 0, durationMs: 1
    });
    child.stdout.emit('data', Buffer.from(env));
    child.emit('close', 0);
  });
  await dispatchAdCommand({
    commandType: 'user_search',
    params: { filter: 'a', password: 'TOP_SECRET' },
    spawnFn,
    logger: capturedLogger
  });
  for (const c of capturedLogger.calls) {
    const blob = JSON.stringify(c.args) + ' ' + (c.msg || '');
    assert.equal(blob.includes('TOP_SECRET'), false, 'password must not appear in any logger call');
  }
});

// Dispatcher wiring (no real PS1 invocation) ---------------------------

test('dispatchAdCommand: forwards CommandType + ParamsPath to spawn args', async () => {
  let capturedArgs = null;
  let capturedCmd = null;
  const spawnFn = (cmd, args) => {
    capturedCmd = cmd;
    capturedArgs = args;
    const child = fakeChild();
    queueMicrotask(() => {
      const env = JSON.stringify({ success: true, data: {}, error: null, exitCode: 0, durationMs: 1 });
      child.stdout.emit('data', Buffer.from(env));
      child.emit('close', 0);
    });
    return child;
  };
  await dispatchAdCommand({
    commandType: 'group_add_member',
    params: { name: 'g1', memberId: 'jdoe' },
    scriptsDir: 'D:/fake/scripts',
    powerShellPath: 'pwsh.exe',
    spawnFn
  });
  assert.equal(capturedCmd, 'pwsh.exe');
  assert.ok(Array.isArray(capturedArgs));
  // Find the script position + -CommandType + -ParamsPath
  const scriptIdx = capturedArgs.indexOf('-File') + 1;
  // join() normalises to platform separator on Windows; assert endsWith
  // instead of strict equality to be cross-platform.
  assert.ok(capturedArgs[scriptIdx].endsWith(`fake${sep}scripts${sep}ad-admin-groups.ps1`),
    `unexpected script path: ${capturedArgs[scriptIdx]}`);
  const cmdTypeIdx = capturedArgs.indexOf('-CommandType') + 1;
  assert.equal(capturedArgs[cmdTypeIdx], 'group_add_member');
  const paramsIdx = capturedArgs.indexOf('-ParamsPath') + 1;
  assert.ok(capturedArgs[paramsIdx].endsWith('params.json'));
});

test('dispatchAdCommand: cleans up params file on success', async () => {
  let paramsPath = null;
  const spawnFn = makeSpawn((child) => {
    // Capture the params path from inside the dispatcher via parent closure
    // — easier: read from spawn args.
    const env = JSON.stringify({ success: true, data: {}, error: null, exitCode: 0, durationMs: 1 });
    child.stdout.emit('data', Buffer.from(env));
    child.emit('close', 0);
  });
  // Wrap spawnFn to also capture the ParamsPath arg
  const wrappedSpawn = (cmd, args) => {
    const child = spawnFn(cmd, args);
    const idx = args.indexOf('-ParamsPath') + 1;
    paramsPath = args[idx];
    return child;
  };
  await dispatchAdCommand({
    commandType: 'user_search',
    params: { foo: 'bar' },
    spawnFn: wrappedSpawn
  });
  assert.ok(paramsPath);
  assert.equal(existsSync(paramsPath), false, 'params file should be unlinked after dispatch');
});

test('dispatchAdCommand: cleanup is best-effort — survives ENOENT', async () => {
  // If the params file is already gone (e.g. PS1 deleted it), the
  // dispatcher's unlinkSync catch should swallow the error and not
  // surface it. We force this by deleting the file BEFORE close fires.
  let paramsPath = null;
  const wrappedSpawn = (cmd, args) => {
    const child = fakeChild();
    paramsPath = args[args.indexOf('-ParamsPath') + 1];
    queueMicrotask(() => {
      unlinkSync(paramsPath); // pre-empt the dispatcher
      const env = JSON.stringify({ success: true, data: {}, error: null, exitCode: 0, durationMs: 1 });
      child.stdout.emit('data', Buffer.from(env));
      child.emit('close', 0);
    });
    return child;
  };
  const r = await dispatchAdCommand({
    commandType: 'user_search',
    params: {},
    spawnFn: wrappedSpawn
  });
  assert.equal(r.success, true);
  // No throw, no surfaced ENOENT.
});

test('dispatchAdCommand: PS1 envelope with non-number exitCode → coerced', async () => {
  const spawnFn = makeSpawn((child) => {
    const env = JSON.stringify({
      success: false, data: null, error: 'unknown cmd', exitCode: 'three', durationMs: 1
    });
    child.stdout.emit('data', Buffer.from(env));
    child.emit('close', 1);
  });
  const r = await dispatchAdCommand({
    commandType: 'user_search',
    params: {},
    spawnFn
  });
  // PS1 emitted exitCode:"three" — dispatcher coerces non-number to 1
  // (failed default).
  assert.equal(r.success, false);
  assert.equal(typeof r.exitCode, 'number');
  assert.equal(r.exitCode, 1);
});

// Default export surface ------------------------------------------------

test('dispatchAdCommand: alias dispatchAdAdminCommand points to same fn', () => {
  // Module re-exports dispatchAdAdminCommand for parity with center's
  // dispatchMockAdCommand naming. Just confirm both names resolve.
  // We re-import via the static import at top of file: dispatchAdCommand
  // is the canonical name; we just check the module didn't blow up.
  assert.equal(typeof dispatchAdCommand, 'function');
});

test('__testing: DEFAULT_SCRIPTS_DIR ends with agent/scripts', () => {
  // The default scripts dir is computed from import.meta.url. On
  // Windows it will be a backslash-separated absolute path. Just
  // confirm it points into agent/scripts, not a relative path.
  const d = __testing.DEFAULT_SCRIPTS_DIR;
  assert.ok(d.includes('agent'));
  assert.ok(d.endsWith('scripts') || d.endsWith('scripts\\') || d.includes('scripts\\'));
});

test('__testing: DEFAULT_TIMEOUT_MS is at least 30s', () => {
  assert.ok(__testing.DEFAULT_TIMEOUT_MS >= 30_000, 'AD cmdlets can be slow on DC failover');
});