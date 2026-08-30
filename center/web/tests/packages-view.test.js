// R66 T10 — PackagesView (script/policy modals) test suite.
//
// Replaces the legacy store-backed tests (R6/R19/R41 era) with the new
// V1 envelope ({items} not {packages}) and the api/packages.js module.
// The legacy Pinia store at src/stores/packages.js is still alive for
// PackageEditView / RegistryView / MetricDashboardView; tests for that
// surface live in packages-store.test.js.

import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/packages.js', () => ({
  packagesApi: {
    list: vi.fn(),
    // R67-T1 — added for the view-mode entry point on the row.
    getScript: vi.fn(),
    uploadScript: vi.fn(),
    editScript: vi.fn(),
    setPolicy: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    deleteScript: vi.fn()
  }
}));

import PackagesView from '../src/views/admin/PackagesView.vue';
import { packagesApi } from '../src/api/packages.js';

function makeItems(count = 1, overrides = {}) {
  return Array.from({ length: count }, (_, i) => ({
    name: overrides.name || `pkg-${i}`,
    version: overrides.version || '1.0.0',
    type: overrides.type || 'gauge',
    enabled: overrides.enabled !== undefined ? overrides.enabled : true,
    intervalSec: overrides.intervalSec || 3600,
    timeoutMs: overrides.timeoutMs || 30000,
    source: overrides.source || 'admin-upload',
    scriptSha256: 'a'.repeat(64),
    manifest: { type: 'gauge', agent: { type: 'ad' } },
    updatedAt: '2026-08-29T10:00:00Z',
    ...overrides.extra
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
});

const globalStubs = {
  stubs: {
    AdminLayout: { template: '<div class="admin-layout-stub"><slot /></div>' }
  }
};

// 1. renders empty state when list returns {items: []}
test('PackagesView shows empty state when list is empty', async () => {
  packagesApi.list.mockResolvedValue({ data: { items: [] } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  expect(packagesApi.list).toHaveBeenCalledTimes(1);
  expect(w.text()).toMatch(/暂无脚本/);
});

// 2. renders N script rows from list
test('PackagesView renders one tr.script-row per item', async () => {
  const items = makeItems(5);
  packagesApi.list.mockResolvedValue({ data: { items } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  expect(w.findAll('tr.script-row')).toHaveLength(5);
  expect(w.find('[data-test="row-pkg-0"]').exists()).toBe(true);
  expect(w.find('[data-test="row-pkg-4"]').exists()).toBe(true);
});

// 3. clicking + 上传脚本 opens UploadScriptModal
test('PackagesView opens UploadScriptModal when upload button is clicked', async () => {
  packagesApi.list.mockResolvedValue({ data: { items: [] } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  await w.find('[data-test="upload-btn"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="upload-modal"]').exists()).toBe(true);
});

// 4. submitting upload modal calls packagesApi.uploadScript
test('PackagesView submit on UploadScriptModal calls packagesApi.uploadScript with form data', async () => {
  packagesApi.list.mockResolvedValue({ data: { items: [] } });
  packagesApi.uploadScript.mockResolvedValue({ data: { ok: true, name: 'pkg-a' } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  await w.find('[data-test="upload-btn"]').trigger('click');
  await flushPromises();
  await w.find('[data-test="upload-name-input"]').setValue('pkg-a');
  await w.find('[data-test="upload-interval-input"]').setValue(600);
  await w.find('[data-test="upload-timeout-input"]').setValue(60000);
  await w.find('[data-test="upload-content-input"]').setValue('Write-Host hi');
  await w.find('[data-test="upload-submit"]').trigger('click');
  await flushPromises();
  expect(packagesApi.uploadScript).toHaveBeenCalledTimes(1);
  const body = packagesApi.uploadScript.mock.calls[0][0];
  expect(body).toMatchObject({ name: 'pkg-a', intervalSec: 600, timeoutMs: 60000, content: 'Write-Host hi' });
  // modal closes on success
  expect(w.find('[data-test="upload-modal"]').exists()).toBe(false);
});

// 5. row 删除 button confirms then calls deleteScript
test('PackagesView delete button confirms then calls packagesApi.deleteScript', async () => {
  const items = makeItems(1, { name: 'pkg-a' });
  packagesApi.list.mockResolvedValue({ data: { items } });
  packagesApi.deleteScript.mockResolvedValue({ data: { ok: true } });
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  await w.find('[data-test="delete-pkg-a"]').trigger('click');
  await flushPromises();
  expect(confirmSpy).toHaveBeenCalled();
  expect(packagesApi.deleteScript).toHaveBeenCalledWith('pkg-a');
  confirmSpy.mockRestore();
});

// 6. row 编辑策略 button opens EditPolicyModal with current values
test('PackagesView edit-policy button opens EditPolicyModal pre-populated', async () => {
  const items = makeItems(1, { name: 'pkg-a', intervalSec: 3600, timeoutMs: 30000 });
  packagesApi.list.mockResolvedValue({ data: { items } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  await w.find('[data-test="edit-policy-pkg-a"]').trigger('click');
  await flushPromises();
  const modal = w.find('[data-test="edit-policy-modal"]');
  expect(modal.exists()).toBe(true);
  expect(modal.find('[data-test="policy-interval"]').element.value).toBe('3600');
  expect(modal.find('[data-test="policy-timeout"]').element.value).toBe('30000');
});

// 7. toggle button calls enable/disable based on current state
test('PackagesView toggle button calls enable or disable based on current enabled state', async () => {
  const items = [
    makeItems(1, { name: 'pkg-on', enabled: true })[0],
    makeItems(1, { name: 'pkg-off', enabled: false })[0]
  ];
  packagesApi.list.mockResolvedValue({ data: { items } });
  packagesApi.enable.mockResolvedValue({ data: { ok: true } });
  packagesApi.disable.mockResolvedValue({ data: { ok: true } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  // enabled=true → click toggle → expect disable
  await w.find('[data-test="toggle-pkg-on"]').trigger('click');
  await flushPromises();
  expect(packagesApi.disable).toHaveBeenCalledWith('pkg-on');
  expect(packagesApi.enable).not.toHaveBeenCalled();
  // enabled=false → click toggle → expect enable
  await w.find('[data-test="toggle-pkg-off"]').trigger('click');
  await flushPromises();
  expect(packagesApi.enable).toHaveBeenCalledWith('pkg-off');
});

// 8. R67-T1 — 查看 (view) button on the row opens EditScriptModal in viewMode.
//    Closes the R66-T10 data-loss gap: the edit modal opens with an empty
//    textarea (the list endpoint omits LONGTEXT script_content), so the
//    operator previously had no way to see the currently-installed body
//    without re-uploading it.
test('PackagesView view button opens EditScriptModal in viewMode (R67-T1)', async () => {
  const items = makeItems(1, { name: 'pkg-a' });
  packagesApi.list.mockResolvedValue({ data: { items } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  // Click the per-row 查看 button.
  await w.find('[data-test="view-script-pkg-a"]').trigger('click');
  await flushPromises();
  // The shared EditScriptModal mounts with viewMode=true → view variant root.
  const viewModal = w.find('[data-test="edit-script-modal-view"]');
  expect(viewModal.exists()).toBe(true);
  // The edit-mode root is NOT mounted.
  expect(w.find('[data-test="edit-script-modal"]').exists()).toBe(false);
});

// 9. R67-T1 — clicking the existing 脚本 (edit) button still mounts the
//    edit-mode variant (NOT the view variant). No regression for the
//    original edit path.
test('PackagesView edit button still opens EditScriptModal in edit-mode (no regression)', async () => {
  const items = makeItems(1, { name: 'pkg-a' });
  packagesApi.list.mockResolvedValue({ data: { items } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  await w.find('[data-test="edit-script-pkg-a"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="edit-script-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edit-script-modal-view"]').exists()).toBe(false);
});

// 10. R67-T1 — switching between view and edit resets the shared modal
//     cleanly. After view → close, the next edit click opens edit mode
//     (not the leftover view variant).
test('PackagesView view → close → edit cleanly toggles between modal variants', async () => {
  const items = makeItems(1, { name: 'pkg-a' });
  packagesApi.list.mockResolvedValue({ data: { items } });
  const w = mount(PackagesView, { global: globalStubs });
  await flushPromises();
  // View, then close.
  await w.find('[data-test="view-script-pkg-a"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="edit-script-modal-view"]').exists()).toBe(true);
  await w.find('[data-test="edit-script-cancel"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="edit-script-modal-view"]').exists()).toBe(false);
  // Edit next.
  await w.find('[data-test="edit-script-pkg-a"]').trigger('click');
  await flushPromises();
  expect(w.find('[data-test="edit-script-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edit-script-modal-view"]').exists()).toBe(false);
});
