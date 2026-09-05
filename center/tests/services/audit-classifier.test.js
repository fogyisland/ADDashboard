// Unit tests for audit-classifier.js — round-12 T4, round-19+ delete buttons,
// R66 package-mgmt actions, R67-T1 view_script.
//
// classifyAction(action) must map every audit action used by the app to a
// category / severity / label triple. When a new action is introduced, a
// classifier entry MUST be added in the same commit (or the audit log row
// defaults to the fallback ('ops' / 'low' / action-as-label) and the
// changes filter / Chinese label silently break).
//
// Covered actions:
//   - request_agent_report — round-12 T4. Operator-initiated "ask this agent
//     to send a heartbeat report now". Category=changes, severity=low,
//     label=请求 Agent 立即回报.
//   - delete_agent_heartbeat — round-19+ delete buttons on the heartbeat
//     table. Cascades ad_agent_heartbeat + ad_replication_status +
//     package_runs. Category=changes, severity=medium, label=删除 Agent 心跳记录.
//   - delete_dc — round-19+ delete buttons on the DC tab. Removes the row
//     from ad_dcs only (other tab keeps heartbeat visibility). Category=
//     changes, severity=medium, label=删除 DC 记录.
//   - view_script — R67-T1. Read-only view path that returns the raw
//     script body for the EditScriptModal's view-mode. Category=changes,
//     severity=low (no mutation), label=查看脚本.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../../src/services/audit-classifier.js';

test('classifyAction: request_agent_report is classified as changes/low/请求 Agent 立即回报', () => {
  const c = classifyAction('request_agent_report');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'low');
  assert.equal(c.label, '请求 Agent 立即回报');
});

test('classifyAction: delete_agent_heartbeat is classified as changes/medium/删除 Agent 心跳记录', () => {
  const c = classifyAction('delete_agent_heartbeat');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'medium');
  assert.equal(c.label, '删除 Agent 心跳记录');
});

test('classifyAction: delete_dc is classified as changes/medium/删除 DC 记录', () => {
  const c = classifyAction('delete_dc');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'medium');
  assert.equal(c.label, '删除 DC 记录');
});

test('classifyAction: view_script is classified as changes/low/查看脚本 (R67-T1)', () => {
  const c = classifyAction('view_script');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'low');
  assert.equal(c.label, '查看脚本');
});

// 2026-09-05 R81 — member-server PowerShell command audit (4 entries).
// The operator-visible action is `ad_member_command_queued` (a free-form
// script on a member server hostname — high severity because there's no
// whitelist). The 3 system-side actions track agent-observed status
// transitions on that row.
test('classifyAction: ad_member_command_queued is changes/high/成员服务器 PowerShell 命令排队 (R81)', () => {
  const c = classifyAction('ad_member_command_queued');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'high');
  assert.equal(c.label, '成员服务器 PowerShell 命令排队');
});

test('classifyAction: ad_member_command_succeeded is changes/low/成员服务器 PowerShell 命令成功 (R81)', () => {
  const c = classifyAction('ad_member_command_succeeded');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'low');
  assert.equal(c.label, '成员服务器 PowerShell 命令成功');
});

test('classifyAction: ad_member_command_failed is changes/medium/成员服务器 PowerShell 命令失败 (R81)', () => {
  const c = classifyAction('ad_member_command_failed');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'medium');
  assert.equal(c.label, '成员服务器 PowerShell 命令失败');
});

test('classifyAction: ad_member_command_timed_out is changes/medium/成员服务器 PowerShell 命令超时 (R81)', () => {
  const c = classifyAction('ad_member_command_timed_out');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'medium');
  assert.equal(c.label, '成员服务器 PowerShell 命令超时');
});
