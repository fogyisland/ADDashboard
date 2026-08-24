// Unit tests for audit-classifier.js — round-12 T4.
//
// classifyAction(action) must map every audit action used by the app to a
// category / severity / label triple. When a new action is introduced, a
// classifier entry MUST be added in the same commit (or the audit log row
// defaults to the fallback ('ops' / 'low' / action-as-label) and the
// changes filter / Chinese label silently break).
//
// This file currently covers the round-12 `request_agent_report` action —
// an operator-initiated "ask this agent to send a heartbeat report now".
// Classified as:
//   - category = 'changes' (it mutates ad_agent_heartbeat.report_requested_at)
//   - severity = 'low'      (operator action, not destructive)
//   - label    = '请求 Agent 立即回报'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../../src/services/audit-classifier.js';

test('classifyAction: request_agent_report is classified as changes/low/请求 Agent 立即回报', () => {
  const c = classifyAction('request_agent_report');
  assert.equal(c.category, 'changes');
  assert.equal(c.severity, 'low');
  assert.equal(c.label, '请求 Agent 立即回报');
});
