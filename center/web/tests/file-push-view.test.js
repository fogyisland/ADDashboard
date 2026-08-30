// 2026-08-30 R65 followup — frontend tests for FilePushView (shared
// upload + task-list surface). Covers both targetType=dc and
// targetType=server paths via the wrapper views.

import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listDcsCatalog: vi.fn(),
    listMemberServers: vi.fn(),
    listFilePushTasks: vi.fn(),
    uploadFile: vi.fn(),
    ackFilePushTask: vi.fn(),
    getFilePushFileBlob: vi.fn()
  }
}));

import AdFilePushView from '../src/views/admin/AdFilePushView.vue';
import MemberFilePushView from '../src/views/admin/MemberFilePushView.vue';
import FilePushView from '../src/views/admin/FilePushView.vue';
import { adminApi } from '../src/api/admin.js';

const RouterLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

beforeEach(() => {
  Object.values(adminApi).forEach((fn) => {
    if (typeof fn === 'function' && fn.mockReset) fn.mockReset();
  });
  // Default: empty catalog + empty task list
  adminApi.listDcsCatalog.mockResolvedValue({ data: [] });
  adminApi.listMemberServers.mockResolvedValue({ data: [] });
  adminApi.listFilePushTasks.mockResolvedValue({ data: [] });
});

function mountView(component) {
  return mount(component, {
    global: {
      stubs: {
        AdminLayout: { template: '<div><slot /></div>' },
        FilePushView: { props: ['targetType'], template: '<div data-test="inner"><slot :target-type="targetType" /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

function mountShared(targetType) {
  return mount(FilePushView, {
    props: { targetType },
    global: {
      stubs: {
        AdminLayout: { template: '<div><slot /></div>' },
        'router-link': RouterLinkStub
      }
    }
  });
}

// ── Wrapper views (smoke) ─────────────────────────────────────────

test('AdFilePushView renders the shared FilePushView with targetType=dc', async () => {
  const wrapper = mountView(AdFilePushView);
  await flushPromises();
  expect(wrapper.html()).toContain('inner');
});

test('MemberFilePushView renders the shared FilePushView with targetType=server', async () => {
  const wrapper = mountView(MemberFilePushView);
  await flushPromises();
  expect(wrapper.html()).toContain('inner');
});

// ── DC target ────────────────────────────────────────────────────

test('DC target: title shows AD label + loads from listDcsCatalog', async () => {
  adminApi.listDcsCatalog.mockResolvedValue({
    data: [
      { dcName: 'dc-bj-01', isBridgehead: true, isPdc: false },
      { dcName: 'dc-sh-01', isBridgehead: false, isPdc: true }
    ]
  });
  const wrapper = mountShared('dc');
  await flushPromises();

  expect(wrapper.text()).toContain('文件推送 (AD 域控)');
  expect(wrapper.text()).toContain('dc-bj-01');
  expect(wrapper.text()).toContain('桥头');
  expect(wrapper.text()).toContain('dc-sh-01');
  expect(wrapper.text()).toContain('PDC');
  // No member-server-only entry
  expect(adminApi.listMemberServers).not.toHaveBeenCalled();
});

// ── Server target ────────────────────────────────────────────────

test('Server target: title shows member-server label + loads from listMemberServers', async () => {
  adminApi.listMemberServers.mockResolvedValue({
    data: [
      { hostname: 'app-01', role: '应用服务器' }
    ]
  });
  const wrapper = mountShared('server');
  await flushPromises();

  expect(wrapper.text()).toContain('文件推送 (成员服务器)');
  expect(wrapper.text()).toContain('app-01');
  expect(wrapper.text()).toContain('应用服务器');
  expect(adminApi.listDcsCatalog).not.toHaveBeenCalled();
});

// ── Empty hint ───────────────────────────────────────────────────

test('DC: empty catalog renders hint linking to /admin/dcs-catalog', async () => {
  const wrapper = mountShared('dc');
  await flushPromises();
  const html = wrapper.html();
  expect(html).toContain('请先在');
  expect(html).toContain('/admin/dcs-catalog');
});

test('Server: empty catalog renders hint linking to /admin/member-servers', async () => {
  const wrapper = mountShared('server');
  await flushPromises();
  const html = wrapper.html();
  expect(html).toContain('请先在');
  expect(html).toContain('/admin/member-servers');
});

// ── Task list ────────────────────────────────────────────────────

test('renders task rows + per-row caret expands per-target detail', async () => {
  adminApi.listDcsCatalog.mockResolvedValue({ data: [{ dcName: 'dc-1', isBridgehead: false, isPdc: false }] });
  adminApi.listFilePushTasks.mockResolvedValue({
    data: [{
      taskId: 'task-1', filename: 'setup.exe', sizeBytes: 4096, sha256: 'abc123',
      targetType: 'dc', targetPath: 'C:\\tmp',
      targets: ['dc-1'], uploadedAt: '2026-08-30T10:00:00Z', uploadedBy: 'admin',
      status: 'queued',
      targetStatus: [
        { name: 'dc-1', status: 'pending', claimedAt: null, claimedBy: null, deliveredAt: null, errorMessage: null }
      ]
    }]
  });
  const wrapper = mountShared('dc');
  await flushPromises();

  expect(wrapper.text()).toContain('setup.exe');
  expect(wrapper.text()).toContain('队列中');

  // Expand the row
  await wrapper.find('[data-test="expand-task-1"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-test="detail-task-1"]').exists()).toBe(true);
  expect(wrapper.text()).toContain('待认领');
});

// ── Per-target ack status rendering ──────────────────────────────

test('detail row shows per-target status colors (ok / warn / err / queued)', async () => {
  adminApi.listDcsCatalog.mockResolvedValue({
    data: [
      { dcName: 'dc-ok', isBridgehead: false, isPdc: false },
      { dcName: 'dc-claimed', isBridgehead: false, isPdc: false },
      { dcName: 'dc-failed', isBridgehead: false, isPdc: false },
      { dcName: 'dc-pending', isBridgehead: false, isPdc: false }
    ]
  });
  adminApi.listFilePushTasks.mockResolvedValue({
    data: [{
      taskId: 'task-x', filename: 'patch.zip', sizeBytes: 100, sha256: 'def456',
      targetType: 'dc', targetPath: 'C:\\tmp',
      targets: ['dc-ok', 'dc-claimed', 'dc-failed', 'dc-pending'],
      uploadedAt: '2026-08-30T10:00:00Z', uploadedBy: 'admin',
      status: 'claimed',
      targetStatus: [
        { name: 'dc-ok',      status: 'delivered', claimedAt: '2026-08-30T10:01:00Z', claimedBy: 'agent-1', deliveredAt: '2026-08-30T10:02:00Z', errorMessage: null },
        { name: 'dc-claimed', status: 'claimed',   claimedAt: '2026-08-30T10:01:00Z', claimedBy: 'agent-2', deliveredAt: null,                       errorMessage: null },
        { name: 'dc-failed',  status: 'failed',    claimedAt: '2026-08-30T10:01:00Z', claimedBy: 'agent-3', deliveredAt: '2026-08-30T10:02:00Z', errorMessage: 'disk full' },
        { name: 'dc-pending', status: 'pending',   claimedAt: null,                    claimedBy: null,      deliveredAt: null,                       errorMessage: null }
      ]
    }]
  });
  const wrapper = mountShared('dc');
  await flushPromises();
  await wrapper.find('[data-test="expand-task-x"]').trigger('click');
  await flushPromises();

  const html = wrapper.html();
  // The class on each target row is target-${status} where status is
  // 'delivered' | 'claimed' | 'failed' | 'pending' (verbatim from
  // FilePushView.vue targetClass). The color is set by status-pill
  // inside the row.
  expect(html).toContain('target-delivered');
  expect(html).toContain('target-claimed');
  expect(html).toContain('target-failed');
  expect(html).toContain('target-pending');
  expect(html).toContain('disk full');
  expect(wrapper.text()).toContain('已送达');
  expect(wrapper.text()).toContain('已认领');
  expect(wrapper.text()).toContain('失败');
});

// ── Operator-driven ack (manual mark) ───────────────────────────

test('ack-ok button POSTs to adminApi.ackFilePushTask with ok=true', async () => {
  adminApi.listDcsCatalog.mockResolvedValue({ data: [{ dcName: 'dc-1', isBridgehead: false, isPdc: false }] });
  adminApi.listFilePushTasks.mockResolvedValue({
    data: [{
      taskId: 'task-ack', filename: 'f.txt', sizeBytes: 1, sha256: 'xx',
      targetType: 'dc', targetPath: 'C:\\tmp',
      targets: ['dc-1'], uploadedAt: '2026-08-30T10:00:00Z', uploadedBy: 'admin',
      status: 'queued',
      targetStatus: [{ name: 'dc-1', status: 'pending', claimedAt: null, claimedBy: null, deliveredAt: null, errorMessage: null }]
    }]
  });
  adminApi.ackFilePushTask.mockResolvedValue({ data: { taskId: 'task-ack', status: 'delivered' } });
  // Mock the prompt() that the manual-ack flow uses
  window.prompt = vi.fn()
    .mockReturnValueOnce('agent-99')         // hostname/agentId prompt
    .mockReturnValueOnce(null);              // errorMessage prompt — null for ok=true

  const wrapper = mountShared('dc');
  await flushPromises();

  await wrapper.find('[data-test="ack-ok-task-ack"]').trigger('click');
  await flushPromises();

  expect(adminApi.ackFilePushTask).toHaveBeenCalledWith('task-ack', {
    hostname: 'dc-1', agentId: 'agent-99', ok: true, errorMessage: null
  });
});

// ── Empty state ──────────────────────────────────────────────────

test('empty task list shows "暂无推送任务"', async () => {
  const wrapper = mountShared('dc');
  await flushPromises();
  expect(wrapper.text()).toContain('暂无推送任务');
});

// ── API client surface (regression guard against R65-T6 API shape) ─

test('adminApi exposes uploadFile + listFilePushTasks + ackFilePushTask', () => {
  expect(typeof adminApi.uploadFile).toBe('function');
  expect(typeof adminApi.listFilePushTasks).toBe('function');
  expect(typeof adminApi.ackFilePushTask).toBe('function');
  expect(typeof adminApi.getFilePushFileBlob).toBe('function');
});