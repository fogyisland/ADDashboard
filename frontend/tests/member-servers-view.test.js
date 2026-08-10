import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listMemberServers: vi.fn(() => Promise.resolve({ data: { items: [] } })),
    listSitesCatalog: vi.fn(() => Promise.resolve({ data: [] })),
    getMemberServer: vi.fn(() => Promise.resolve({ data: null })),
    createMemberServer: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    updateMemberServer: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    deleteMemberServer: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    listMemberServerPackages: vi.fn(() => Promise.resolve({ data: { items: [] } })),
    setMemberServerPackageEnabled: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    removeMemberServerPackage: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    listServerGroups: vi.fn(() => Promise.resolve({ data: [] })),
    createServerGroup: vi.fn(() => Promise.resolve({ data: { id: 1 } })),
    updateServerGroup: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    deleteServerGroup: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    listServerGroupMembers: vi.fn(() => Promise.resolve({ data: [] })),
    replaceServerGroupMembers: vi.fn(() => Promise.resolve({ data: { ok: true, added: 0, removed: 0 } })),
    bulkInstallForGroup: vi.fn(() => Promise.resolve({ data: { ok: true, affected: 0 } })),
    bulkUninstallForGroup: vi.fn(() => Promise.resolve({ data: { ok: true, removed: 0 } })),
    bulkEnableForGroup: vi.fn(() => Promise.resolve({ data: { ok: true, affected: 0 } })),
    bulkDisableForGroup: vi.fn(() => Promise.resolve({ data: { ok: true, affected: 0 } }))
  }
}));

import MemberServersView from '../src/views/admin/MemberServersView.vue';
import ServerGroupsView from '../src/views/admin/ServerGroupsView.vue';
import { adminApi } from '../src/api/admin.js';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

beforeEach(() => {
  Object.values(adminApi).forEach((fn) => {
    if (typeof fn === 'function' && fn.mockReset) fn.mockReset();
  });
});

function mountView(component) {
  return mount(component, {
    global: {
      stubs: {
        AdminLayout: { template: '<div><slot /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

test('MemberServersView renders table from listMemberServers', async () => {
  adminApi.listMemberServers.mockResolvedValue({
    data: {
      items: [
        { hostname: 'host-a', site_id: 1, site_name: 'Beijing-Site', ip_address: '10.0.0.1', os_version: 'Win2022', enabled: 1, last_seen_at: '2026-08-09T10:00:00Z', last_report_at: '2026-08-09T10:00:00Z' },
        { hostname: 'host-b', site_id: null, site_name: null, ip_address: '10.0.0.2', os_version: 'Win2019', enabled: 0, last_seen_at: null, last_report_at: null }
      ]
    }
  });
  adminApi.listSitesCatalog.mockResolvedValue({ data: [{ id: 1, siteName: 'Beijing-Site' }] });

  const wrapper = mountView(MemberServersView);
  await flushPromises();

  const text = wrapper.text();
  expect(text).toContain('host-a');
  expect(text).toContain('host-b');
  expect(text).toContain('Beijing-Site');
  expect(text).toContain('未分配');
  expect(text).toContain('10.0.0.1');
  expect(text).toContain('Win2022');
});

test('MemberServersView: clicking 批量导入 opens BulkImportDialog', async () => {
  adminApi.listMemberServers.mockResolvedValue({ data: { items: [] } });
  adminApi.listSitesCatalog.mockResolvedValue({ data: [] });

  const wrapper = mountView(MemberServersView);
  await flushPromises();

  expect(wrapper.findAllComponents({ name: 'BulkImportDialog' }).length).toBe(0);
  const buttons = wrapper.findAll('button');
  const bulkBtn = buttons.find(b => b.text() === '批量导入');
  expect(bulkBtn).toBeTruthy();
  await bulkBtn.trigger('click');
  await flushPromises();
  expect(wrapper.findAllComponents({ name: 'BulkImportDialog' }).length).toBe(1);
});

test('ServerGroupsView renders member_count from listServerGroups', async () => {
  adminApi.listServerGroups.mockResolvedValue({
    data: [
      { groupId: 1, groupName: 'edge-east', description: '东向边缘', memberCount: 4 },
      { groupId: 2, groupName: 'edge-west', description: null, memberCount: 0 }
    ]
  });

  const wrapper = mountView(ServerGroupsView);
  await flushPromises();

  const text = wrapper.text();
  expect(text).toContain('edge-east');
  expect(text).toContain('edge-west');
  expect(text).toContain('东向边缘');
  expect(text).toContain('4');
});
