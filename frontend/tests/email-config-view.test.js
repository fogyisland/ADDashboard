// SMTP / alert keys live on their own page (/admin/email-config) since T17.
// EmailConfigView mounts the same AdminLayout shell + the same save flow as
// ConfigView, just scoped to the 11 email-related keys.
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import EmailConfigView from '../src/views/admin/EmailConfigView.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getConfigAudit: vi.fn(),
    rollbackConfig: vi.fn(),
    sendTestEmail: vi.fn()
  }
}));

beforeEach(() => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockReset();
  adminApi.updateConfig.mockReset();
  adminApi.updateConfig.mockResolvedValue({ data: { ok: true } });
  adminApi.getConfigAudit.mockReset();
  adminApi.getConfigAudit.mockResolvedValue({ data: [] });
  adminApi.rollbackConfig.mockReset();
  adminApi.sendTestEmail.mockReset();
  adminApi.sendTestEmail.mockResolvedValue({ data: { ok: true, error: null } });
});

// The full endpoint returns the entire config map; EmailConfigView projects
// only the keys it owns. Ship a full map so the projection logic is exercised.
const FULL_CFG = {
  polling_interval_minutes: '5',
  latency_threshold_minutes: '60',
  heartbeat_interval_seconds: '10',
  history_enabled: '1',
  ad_agent_token: 'old-token-1234567890',
  listenPort: '8080',
  heartbeat_port: '8081',
  report_port: '8082',
  smtp_host: 'smtp.example.com',
  smtp_port: 25,
  smtp_secure: 'false',
  smtp_user: 'alerts@example.com',
  // T12 fix1 contract: a present password is masked as `********` in getConfig
  // responses. The form must render this sentinel as the placeholder, NOT
  // cleartext.
  smtp_password: '********',
  smtp_from: 'alerts@example.com',
  alert_default_to: 'ops@corp.local',
  alert_default_cc: '',
  alert_eval_interval_seconds: 60,
  alert_email_max_attempts: 5,
  alert_email_initial_backoff_seconds: 30
};

const EMAIL_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
  'alert_default_to', 'alert_default_cc',
  'alert_eval_interval_seconds', 'alert_email_max_attempts', 'alert_email_initial_backoff_seconds'
];

function rowFor(w, rawKey) {
  return w.findAll('table.t tbody tr').find((r) => r.find('.raw-key').text() === rawKey);
}

test('EmailConfigView renders only the 11 email keys — non-email keys are dropped', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  const w = mount(EmailConfigView);
  await flushPromises();
  const rawKeys = w.findAll('table.t .raw-key').map((el) => el.text());
  for (const k of EMAIL_KEYS) expect(rawKeys).toContain(k);
  for (const k of Object.keys(FULL_CFG)) {
    if (!EMAIL_KEYS.includes(k)) expect(rawKeys).not.toContain(k);
  }
});

test('EmailConfigView renders Chinese labels + description for each email key', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  const w = mount(EmailConfigView);
  await flushPromises();
  const labels = w.findAll('table.t .key-label').map((el) => el.text());
  expect(labels).toContain('SMTP 主机');
  expect(labels).toContain('默认收件人');
  const hostRow = rowFor(w, 'smtp_host');
  expect(hostRow.find('.desc-text').text()).toContain('SMTP 服务器');
});

test('smtp_password renders masked: empty input, ******** placeholder', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  const w = mount(EmailConfigView);
  await flushPromises();
  const input = w.find('input[type=password]');
  expect(input.exists()).toBe(true);
  expect(input.element.value).toBe('');
  expect(input.attributes('placeholder')).toBe('********');
});

test('smtp_password placeholder is empty when no password is configured', async () => {
  adminApi.getConfig.mockResolvedValue({ data: { ...FULL_CFG, smtp_password: '' } });
  const w = mount(EmailConfigView);
  await flushPromises();
  const input = w.find('input[type=password]');
  expect(input.exists()).toBe(true);
  expect(input.attributes('placeholder')).toBe('');
});

test('typing a new smtp_password marks dirty and saves the verbatim value', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  const w = mount(EmailConfigView);
  await flushPromises();
  expect(w.find('button.save').attributes('disabled')).toBeDefined();
  await w.find('input[type=password]').setValue('new-secret-123');
  await flushPromises();
  expect(w.find('button.save').attributes('disabled')).toBeUndefined();
  await w.find('button.save').trigger('click');
  await flushPromises();
  // PUT only the email subset (non-email keys are projected out at load time)
  const arg = adminApi.updateConfig.mock.calls[0][0];
  expect(arg.smtp_password).toBe('new-secret-123');
  expect(arg).not.toHaveProperty('polling_interval_minutes');
});

test('smtp_secure toggles between the string forms true/false', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  const w = mount(EmailConfigView);
  await flushPromises();
  const secureRow = rowFor(w, 'smtp_secure');
  const box = secureRow.find('input[type=checkbox]');
  expect(box.element.checked).toBe(false);
  expect(secureRow.text()).toContain('关闭');
  await box.setValue(true);
  await flushPromises();
  expect(secureRow.text()).toContain('启用');
  await w.find('button.save').trigger('click');
  await flushPromises();
  expect(adminApi.updateConfig).toHaveBeenCalledWith(
    expect.objectContaining({ smtp_secure: 'true' })
  );
});

test('发送测试邮件 opens the dialog prefilled from alert_default_to and calls sendTestEmail', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  const w = mount(EmailConfigView);
  await flushPromises();
  const testBtn = w.findAll('button').find((b) => b.text() === '发送测试邮件');
  expect(testBtn).toBeTruthy();
  await testBtn.trigger('click');
  await flushPromises();
  const toInput = w.find('.modal input');
  expect(toInput.exists()).toBe(true);
  expect(toInput.element.value).toBe('ops@corp.local');
  const sendBtn = w.findAll('button').find((b) => b.text() === '发送');
  expect(sendBtn).toBeTruthy();
  await sendBtn.trigger('click');
  await flushPromises();
  expect(adminApi.sendTestEmail).toHaveBeenCalledWith({ to: 'ops@corp.local' });
  expect(w.text()).toContain('已发送 (ops@corp.local)');
});

test('发送测试邮件 is disabled until smtp_host is set', async () => {
  adminApi.getConfig.mockResolvedValue({ data: { ...FULL_CFG, smtp_host: '' } });
  const w = mount(EmailConfigView);
  await flushPromises();
  const testBtn = w.findAll('button').find((b) => b.text() === '发送测试邮件');
  expect(testBtn.attributes('disabled')).toBeDefined();
});

test('test mail failure surfaces the SMTP error verbatim', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  adminApi.sendTestEmail.mockResolvedValue({
    data: { ok: false, error: 'Invalid login: 535 Authentication failed' }
  });
  const w = mount(EmailConfigView);
  await flushPromises();
  await w.findAll('button').find((b) => b.text() === '发送测试邮件').trigger('click');
  await flushPromises();
  await w.findAll('button').find((b) => b.text() === '发送').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('Invalid login: 535 Authentication failed');
});

// Cross-task concern from T12 fix1: every post-fix1 smtp_password audit row is
// permanently un-rollbackable. The UI must disable the rollback button for
// those rows so the operator doesn't see a clickable button that 400s.
test('audit row: smtp_password rollback button disabled with tooltip', async () => {
  adminApi.getConfig.mockResolvedValue({ data: FULL_CFG });
  adminApi.getConfigAudit.mockResolvedValue({
    data: [
      { id: 1, configKey: 'smtp_password', oldValue: '********', newValue: '********', changedByUsername: 'admin', changedAt: '2026-08-09T08:00:00Z', changeType: 'UPDATE' },
      // A non-email audit row must NOT show up here — the email page filters by key.
      { id: 2, configKey: 'smtp_host', oldValue: 'old.example.com', newValue: 'new.example.com', changedByUsername: 'admin', changedAt: '2026-08-09T08:05:00Z', changeType: 'UPDATE' },
      { id: 3, configKey: 'listenPort', oldValue: '8080', newValue: '8081', changedByUsername: 'admin', changedAt: '2026-08-09T08:06:00Z', changeType: 'UPDATE' }
    ]
  });
  const w = mount(EmailConfigView);
  await flushPromises();
  const rollbackBtns = w.findAll('.audit button.rollback');
  expect(rollbackBtns.length).toBe(2);
  const passwordBtn = rollbackBtns.find((b) => b.text() === '不可回滚');
  expect(passwordBtn).toBeTruthy();
  expect(passwordBtn.attributes('disabled')).toBeDefined();
  expect(passwordBtn.attributes('title')).toBe('密码变更不可回滚');
  const hostBtn = rollbackBtns.find((b) => b.text() === '回滚');
  expect(hostBtn).toBeTruthy();
  expect(hostBtn.attributes('disabled')).toBeUndefined();
});
