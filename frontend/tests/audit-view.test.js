import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getAudit: vi.fn()
  }
}));

import AuditView from '../src/views/admin/AuditView.vue';
import { adminApi } from '../src/api/admin.js';

function makeRows() {
  return [
    {
      id: 1,
      userId: 1,
      action: 'create_user',
      target: 'alice',
      payload: { username: 'alice', roleId: 1, status: 1 },
      createdAt: '2026-08-06T08:00:00Z'
    },
    {
      id: 2,
      userId: null,
      action: 'login_failed',
      target: 'bob',
      payload: null,
      createdAt: '2026-08-06T08:05:00Z'
    },
    {
      id: 3,
      userId: 1,
      action: 'update_config',
      target: 'system_config',
      payload: { polling_interval_minutes: '5' },
      createdAt: '2026-08-06T08:10:00Z'
    },
    {
      id: 4,
      userId: 2,
      action: 'bulk_import_sites',
      target: 'ad_sites',
      payload: { imported: 3, skipped: 1, total: 4 },
      createdAt: '2026-08-06T08:15:00Z'
    }
  ];
}

async function mountWith(rows) {
  adminApi.getAudit.mockResolvedValue({ data: rows });
  const wrapper = mount(AuditView, {
    global: {
      stubs: {
        AdminLayout: { template: '<div><slot /></div>' }
      }
    }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  adminApi.getAudit.mockReset();
});

test('AuditView: action column renders Chinese label as primary + raw key as small secondary code', async () => {
  const wrapper = await mountWith(makeRows());
  const actionLabels = wrapper.findAll('.action-label').map(el => el.text());
  const rawActions = wrapper.findAll('.raw-action').map(el => el.text());
  // Known actions translated to Chinese
  expect(actionLabels).toContain('创建用户');
  expect(actionLabels).toContain('登录失败');
  expect(actionLabels).toContain('修改系统配置');
  expect(actionLabels).toContain('批量导入站点');
  // Raw key still visible for audit/log debugging
  expect(rawActions).toContain('create_user');
  expect(rawActions).toContain('login_failed');
  expect(rawActions).toContain('update_config');
  expect(rawActions).toContain('bulk_import_sites');
  // Every label paired with a raw key
  expect(actionLabels.length).toBe(rawActions.length);
});

test('AuditView: target column renders Chinese label as primary + raw key as small secondary code when known', async () => {
  const wrapper = await mountWith(makeRows());
  const targetLabels = wrapper.findAll('.target-label').map(el => el.text());
  const rawTargets = wrapper.findAll('.raw-target').map(el => el.text());
  // Known targets translated
  expect(targetLabels).toContain('系统配置');
  expect(targetLabels).toContain('站点目录');
  // Raw key still visible
  expect(rawTargets).toContain('system_config');
  expect(rawTargets).toContain('ad_sites');
  // Unknown target (the username "bob" used as login target) — the raw value
  // appears as plain text, not wrapped in a labeled <div class="target-label">.
  expect(targetLabels).not.toContain('bob');
  // And the raw text "bob" is in the table somewhere
  expect(wrapper.text()).toContain('bob');
});

test('AuditView: payload renders pretty-printed (multi-line) JSON, not single-line blob', async () => {
  const wrapper = await mountWith(makeRows());
  const payloads = wrapper.findAll('pre.payload');
  expect(payloads.length).toBeGreaterThan(0);
  // Object payload — must contain field names
  const text = payloads[0].text();
  expect(text).toContain('username');
  expect(text).toContain('alice');
  // Pretty-printed means lines with whitespace, not all on one line
  expect(text.split('\n').length).toBeGreaterThan(1);
});

test('AuditView: null payload renders as empty (not "null")', async () => {
  const wrapper = await mountWith(makeRows());
  const payloads = wrapper.findAll('pre.payload').map(el => el.text());
  // Second row has payload=null
  // Either the cell is empty (no <pre> at all) or the cell shows nothing (not "null")
  // Find the cell for row 2 (login_failed row)
  const rows = wrapper.findAll('tbody tr');
  const loginRow = rows.find(r => r.text().includes('登录失败'));
  expect(loginRow).toBeTruthy();
  // No "null" string in the row
  expect(loginRow.text()).not.toContain('null');
});
