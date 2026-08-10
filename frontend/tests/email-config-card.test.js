import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ConfigView from '../src/views/admin/ConfigView.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getConfigAudit: vi.fn().mockResolvedValue({ data: [] }),
    rollbackConfig: vi.fn(),
    sendTestEmail: vi.fn(() => Promise.resolve({ data: { ok: true, error: null } }))
  }
}));

import EmailConfigCard from '../src/views/admin/EmailConfigCard.vue';

beforeEach(() => {
  adminApi.sendTestEmail.mockReset();
  adminApi.sendTestEmail.mockResolvedValue({ data: { ok: true, error: null } });
  adminApi.getConfig.mockReset();
  adminApi.updateConfig.mockReset();
  adminApi.getConfigAudit.mockReset();
  adminApi.getConfigAudit.mockResolvedValue({ data: [] });
  adminApi.rollbackConfig.mockReset();
});

const SAMPLE_CFG = {
  smtp_host: 'smtp.example.com',
  smtp_port: 25,
  smtp_secure: 'false',
  smtp_user: 'alerts@example.com',
  // T12 fix1 contract: a present password is masked as `********` in getConfig
  // responses. The card must render this sentinel as the placeholder, NOT
  // cleartext.
  smtp_password: '********',
  smtp_from: 'alerts@example.com',
  alert_default_to: 'ops@corp.local',
  alert_default_cc: '',
  alert_eval_interval_seconds: 60,
  alert_email_max_attempts: 5,
  alert_email_initial_backoff_seconds: 30
};

test('EmailConfigCard masks smtp_password with ******** placeholder when set', async () => {
  const w = mount(EmailConfigCard, {
    props: { cfg: SAMPLE_CFG }
  });
  await flushPromises();
  const passwordInput = w.find('input[type=password]');
  expect(passwordInput.exists()).toBe(true);
  // Input value is empty (we never echo the sentinel into the field) but
  // the placeholder displays the mask so the operator can see the password
  // is configured.
  expect(passwordInput.element.value).toBe('');
  expect(passwordInput.attributes('placeholder')).toBe('********');
});

test('EmailConfigCard empty placeholder when smtp_password is absent', async () => {
  const w = mount(EmailConfigCard, {
    props: { cfg: { ...SAMPLE_CFG, smtp_password: '' } }
  });
  await flushPromises();
  const passwordInput = w.find('input[type=password]');
  expect(passwordInput.exists()).toBe(true);
  expect(passwordInput.attributes('placeholder')).toBe('');
});

test('EmailConfigCard emits update on password input edit; emits verbatim value', async () => {
  const w = mount(EmailConfigCard, {
    props: { cfg: SAMPLE_CFG }
  });
  await flushPromises();
  const passwordInput = w.find('input[type=password]');
  await passwordInput.setValue('new-secret-123');
  await flushPromises();
  const updateEvents = w.emitted('update') || [];
  expect(updateEvents.length).toBeGreaterThanOrEqual(1);
  // The most recent update event should carry the verbatim value (NOT the
  // mask sentinel — that's only what the server returns, the user typing
  // in a new password is the real value to persist).
  const last = updateEvents[updateEvents.length - 1][0];
  expect(last).toEqual({ key: 'smtp_password', value: 'new-secret-123' });
});

test('EmailConfigCard 发送测试邮件 button opens dialog and calls adminApi.sendTestEmail', async () => {
  const w = mount(EmailConfigCard, {
    props: { cfg: SAMPLE_CFG }
  });
  await flushPromises();
  const testBtn = w.findAll('button').find((b) => b.text() === '发送测试邮件');
  expect(testBtn).toBeTruthy();
  await testBtn.trigger('click');
  await flushPromises();
  // Dialog visible with a To input pre-filled from alert_default_to
  const toInput = w.find('input[placeholder="ops@corp.local"]');
  expect(toInput.exists()).toBe(true);
  expect(toInput.element.value).toBe('ops@corp.local');
  // Hit the in-dialog 发送 button
  const sendBtn = w.findAll('button').find((b) => b.text() === '发送' && !b.text().includes('发送中'));
  expect(sendBtn).toBeTruthy();
  await sendBtn.trigger('click');
  await flushPromises();
  expect(adminApi.sendTestEmail).toHaveBeenCalledWith({ to: 'ops@corp.local' });
});

test('EmailConfigCard displays SMTP error verbatim when test mail fails', async () => {
  adminApi.sendTestEmail.mockResolvedValue({ data: { ok: false, error: 'Invalid login: 535 Authentication failed' } });
  const w = mount(EmailConfigCard, {
    props: { cfg: SAMPLE_CFG }
  });
  await flushPromises();
  const testBtn = w.findAll('button').find((b) => b.text() === '发送测试邮件');
  await testBtn.trigger('click');
  await flushPromises();
  const sendBtn = w.findAll('button').find((b) => b.text() === '发送' && !b.text().includes('发送中'));
  await sendBtn.trigger('click');
  await flushPromises();
  expect(w.text()).toContain('Invalid login: 535 Authentication failed');
});

// Cross-task concern from T12 fix1: every post-fix1 smtp_password audit row
// is permanently un-rollbackable (T12 fix1 reviewer's note). The UI must
// disable the rollback button for those rows so the operator doesn't see a
// clickable button that 400s from the backend.
test('ConfigView audit row: smtp_password rollback button disabled with tooltip', async () => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockResolvedValue({ data: SAMPLE_CFG });
  adminApi.getConfigAudit.mockResolvedValue({
    data: [
      { id: 1, configKey: 'smtp_password', oldValue: '********', newValue: '********', changedByUsername: 'admin', changedAt: '2026-08-09T08:00:00Z', changeType: 'UPDATE' },
      { id: 2, configKey: 'smtp_host', oldValue: 'old.example.com', newValue: 'new.example.com', changedByUsername: 'admin', changedAt: '2026-08-09T08:05:00Z', changeType: 'UPDATE' }
    ]
  });
  const w = mount(ConfigView);
  await flushPromises();
  // Find the rollback buttons in the audit table
  const rollbackBtns = w.findAll('.audit button.rollback');
  expect(rollbackBtns.length).toBe(2);
  // The smtp_password row should be disabled with the Chinese tooltip
  const passwordBtn = rollbackBtns.find(b => b.text() === '不可回滚');
  expect(passwordBtn).toBeTruthy();
  expect(passwordBtn.attributes('disabled')).toBeDefined();
  expect(passwordBtn.attributes('title')).toBe('密码变更不可回滚');
  // The smtp_host row should still be enabled (rollbackable)
  const hostBtn = rollbackBtns.find(b => b.text() === '回滚');
  expect(hostBtn).toBeTruthy();
  expect(hostBtn.attributes('disabled')).toBeUndefined();
});