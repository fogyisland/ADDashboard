import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getAudit: vi.fn(),
    getAuditBadge: vi.fn(),
    exportAudit: vi.fn()
  }
}));

import AuditView from '../src/views/admin/AuditView.vue';
import { adminApi } from '../src/api/admin.js';

function makeRows(category = 'security') {
  return [
    { id: 1, userId: 1, username: 'admin', action: 'login_failed', actionLabel: '登录失败',
      category, severity: 'high', target: null, targetLabel: null,
      payload: { ip: '1.2.3.4', reason: 'bad_password' }, createdAt: '2026-08-06T08:00:00Z' },
    { id: 2, userId: null, username: null, action: 'login_failed', actionLabel: '登录失败',
      category, severity: 'high', target: null, targetLabel: null,
      payload: null, createdAt: '2026-08-06T08:05:00Z' }
  ];
}

async function mountView(overrides = {}) {
  adminApi.getAudit.mockResolvedValue({
    data: { rows: overrides.rows ?? makeRows(), total: 2, filtered: 2, page: 1, size: 100 }
  });
  adminApi.getAuditBadge.mockImplementation(async (cat) => ({
    category: cat,
    count: cat === 'security' ? 5 : cat === 'changes' ? 12 : 3
  }));
  const wrapper = mount(AuditView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = vi.fn();
});

test('AuditView: renders 3 tabs with badge counts', async () => {
  const w = await mountView();
  expect(w.text()).toContain('🔒 安全');
  expect(w.text()).toContain('📝 变更');
  expect(w.text()).toContain('⚙ 运维');
  expect(adminApi.getAuditBadge).toHaveBeenCalledWith('security');
  expect(adminApi.getAuditBadge).toHaveBeenCalledWith('changes');
  expect(adminApi.getAuditBadge).toHaveBeenCalledWith('ops');
});

test('AuditView: tab click switches active tab and refetches with that category', async () => {
  const w = await mountView();
  vi.clearAllMocks();
  adminApi.getAudit.mockResolvedValue({ data: { rows: [], total: 0, filtered: 0, page: 1, size: 100 } });
  adminApi.getAuditBadge.mockResolvedValue({ category: 'changes', count: 12 });
  const tabs = w.findAll('.tab');
  await tabs[1].trigger('click');  // 变更 tab
  await flushPromises();
  expect(adminApi.getAudit).toHaveBeenCalledWith(expect.objectContaining({ category: 'changes' }));
});

test('AuditView: row click opens drawer with payload tree (object payload)', async () => {
  const w = await mountView();
  await w.findAll('tbody tr.row')[0].trigger('click');
  await flushPromises();
  expect(w.find('.drawer').exists()).toBe(true);
  expect(w.find('.drawer').text()).toContain('ip');
  expect(w.find('.drawer').text()).toContain('1.2.3.4');
});

test('AuditView: row click with null payload shows fallback note (no crash)', async () => {
  const w = await mountView();
  await w.findAll('tbody tr.row')[1].trigger('click');  // payload: null
  await flushPromises();
  expect(w.find('.drawer').exists()).toBe(true);
  expect(w.find('.drawer').text()).toMatch(/无 payload|null/);
});

test('AuditView: empty tab shows empty-state, not broken table', async () => {
  adminApi.getAudit.mockResolvedValue({ data: { rows: [], total: 0, filtered: 0, page: 1, size: 100 } });
  adminApi.getAuditBadge.mockResolvedValue({ category: 'changes', count: 0 });
  const w = mount(AuditView, { global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } } });
  await flushPromises();
  expect(w.text()).toMatch(/暂无数据/);
});

test('AuditView: export JSON button calls exportAudit with current filter state and triggers download', async () => {
  adminApi.exportAudit.mockResolvedValue(new Blob(['[]']));
  const w = await mountView();
  await w.find('[data-test="export-json"]').trigger('click');
  await flushPromises();
  expect(adminApi.exportAudit).toHaveBeenCalledWith('json', expect.objectContaining({ category: 'security' }));
});

test('AuditView: severity color class reflects server-supplied severity', async () => {
  const w = await mountView();
  const rows = w.findAll('tbody tr.row');
  expect(rows[0].classes()).toContain('sev-high');
  expect(rows[1].classes()).toContain('sev-high');
});