// 2026-09-05 R81 — unit tests for mock-member-commands.mjs.
//
// Pure in-process tests — no network, no live centre. Mirrors the
// pattern in tests/mock/mock-ad-admin.test.js (R75).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mockMemberScript,
  dispatchMockMemberCommand,
  memberLog,
  resetMemberLog,
  MockMemberError
} from '../../mock-member-commands.mjs';

function reset() {
  resetMemberLog();
}

// ── mockMemberScript ─────────────────────────────────────────────────────

test('mockMemberScript: Get-Date returns ISO date in stdout', () => {
  reset();
  const result = mockMemberScript('HOST1', { script: 'Get-Date', timeoutSec: 5 });
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.data.stdout, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.data.stderr, '');
  assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0);
  assert.equal(memberLog.length, 1);
  assert.equal(memberLog[0].hostname, 'HOST1');
  assert.equal(memberLog[0].script, 'Get-Date');
});

test('mockMemberScript: Get-Host returns MOCK-MEMBER-HOST payload', () => {
  reset();
  const result = mockMemberScript('H', { script: 'Get-Host', timeoutSec: 5 });
  assert.equal(result.success, true);
  const stdout = JSON.parse(result.data.stdout);
  assert.equal(stdout.Name, 'MOCK-MEMBER-HOST');
});

test('mockMemberScript: whoami returns MOCK\\hostname', () => {
  reset();
  const result = mockMemberScript('MEMBERSRV1', { script: 'whoami', timeoutSec: 5 });
  assert.equal(result.data.stdout, 'MOCK\\MEMBERSRV1');
});

test('mockMemberScript: hostname returns the hostname', () => {
  reset();
  const result = mockMemberScript('HOST-X', { script: 'hostname', timeoutSec: 5 });
  assert.equal(result.data.stdout, 'HOST-X');
});

test('mockMemberScript: unknown script falls back to [MOCK] prefix', () => {
  reset();
  const result = mockMemberScript('H', { script: 'Some-Cmdlet', timeoutSec: 5 });
  assert.equal(result.success, true);
  assert.match(result.data.stdout, /^\[MOCK\] Some-Cmdlet$/);
});

test('mockMemberScript: blocks Remove-Item -Recurse with explicit error', () => {
  reset();
  const result = mockMemberScript('H', {
    script: 'Remove-Item C:\\temp -Recurse',
    timeoutSec: 5
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.data.stderr, /Remove-Item .* blocked/);
  assert.match(result.error, /blocked/);
  // still logged so the e2e driver can inspect what got blocked
  assert.equal(memberLog.length, 1);
});

test('mockMemberScript: blocks Stop-Service', () => {
  reset();
  const result = mockMemberScript('H', {
    script: 'Stop-Service spooler',
    timeoutSec: 5
  });
  assert.equal(result.success, false);
  assert.match(result.data.stderr, /Stop-Service/);
});

test('mockMemberScript: blocks Format-Volume + Clear-Disk + Restart-Computer', () => {
  for (const script of [
    'Format-Volume -DriveLetter C',
    'Clear-Disk -Number 0',
    'Restart-Computer -Force'
  ]) {
    reset();
    const result = mockMemberScript('H', { script, timeoutSec: 5 });
    assert.equal(result.success, false, `expected ${script} to fail`);
    assert.notEqual(result.data.stderr, '', `expected stderr for ${script}`);
  }
});

test('mockMemberScript: blocks Invoke-Expression + iex pipeline', () => {
  for (const script of [
    'Invoke-Expression "Get-Date"',
    'Get-Process | iex'
  ]) {
    reset();
    const result = mockMemberScript('H', { script, timeoutSec: 5 });
    assert.equal(result.success, false, `expected ${script} to fail`);
  }
});

test('mockMemberScript: rejects empty script', () => {
  reset();
  const result = mockMemberScript('H', { script: '', timeoutSec: 5 });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.error, /script/);
});

// ── dispatchMockMemberCommand ───────────────────────────────────────────────

test('dispatchMockMemberCommand: routes member_script to mockMemberScript', () => {
  reset();
  const result = dispatchMockMemberCommand('H1', {
    commandType: 'member_script',
    params: { script: 'Get-Date', timeoutSec: 5 }
  });
  assert.equal(result.success, true);
  assert.match(result.data.stdout, /^\d{4}-\d{2}-\d{2}T/);
});

test('dispatchMockMemberCommand: unknown command_type returns success=false', () => {
  reset();
  const result = dispatchMockMemberCommand('H', {
    commandType: 'not_a_real_type',
    params: {}
  });
  assert.equal(result.success, false);
  assert.match(result.error, /unknown command_type/);
});

test('dispatchMockMemberCommand: missing commandType returns success=false', () => {
  reset();
  const result = dispatchMockMemberCommand('H', { params: {} });
  assert.equal(result.success, false);
  assert.match(result.error, /commandType/);
});

test('dispatchMockMemberCommand: missing command object returns success=false', () => {
  reset();
  const result = dispatchMockMemberCommand('H', null);
  assert.equal(result.success, false);
  assert.match(result.error, /command object/);
});

// ── MockMemberError ─────────────────────────────────────────────────────

test('MockMemberError carries an httpStatus for the ack layer', () => {
  const e = new MockMemberError('boom', 503);
  assert.equal(e.name, 'MockMemberError');
  assert.equal(e.httpStatus, 503);
  assert.equal(e.message, 'boom');
});