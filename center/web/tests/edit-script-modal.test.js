// R67-T1 — EditScriptModal view-mode tests.
//
// The EditScriptModal has two modes:
//   1. Default (edit): opens with an empty textarea; operator pastes a
//      replacement body and the modal PUTs it.
//   2. viewMode=true: auto-fetches the currently-installed body via
//      packagesApi.getScript(name), renders it in a readonly textarea,
//      and exposes only a Close button.
//
// Both modes share the same modal component but use different data-test
// roots so tests can target one without crossing the other:
//   - default: data-test="edit-script-modal"
//   - view:    data-test="edit-script-modal-view"
//
// Audit note: every successful getScript call emits a view_script row
// server-side — verified in the backend router.test.js; here we only
// verify the frontend wires the call correctly and renders the response.

import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../src/api/packages.js', () => ({
  packagesApi: {
    getScript: vi.fn(),
    editScript: vi.fn()
  }
}));

import EditScriptModal from '../src/components/admin/EditScriptModal.vue';
import { packagesApi } from '../src/api/packages.js';

beforeEach(() => {
  vi.resetAllMocks();
});

const sampleItem = { name: 'pkg-a', scriptSha256: 'a'.repeat(64) };

// ─────────────────────────────────────────────────────────────────────
// Default (edit) mode — baseline regression for R66 T10.
// ─────────────────────────────────────────────────────────────────────

test('edit-mode modal opens with empty textarea + Save button visible', async () => {
  packagesApi.editScript.mockResolvedValue({ data: { ok: true, newSha: 'b'.repeat(64) } });
  const w = mount(EditScriptModal, { props: { item: sampleItem } });
  // Default mode never calls getScript.
  expect(packagesApi.getScript).not.toHaveBeenCalled();
  expect(w.find('[data-test="edit-script-modal"]').exists()).toBe(true);
  expect(w.find('[data-test="edit-script-modal-view"]').exists()).toBe(false);
  const ta = w.find('[data-test="edit-script-input"]');
  expect(ta.exists()).toBe(true);
  expect(ta.element.value).toBe('');
  // Save button visible, close = "取消"
  expect(w.find('[data-test="edit-script-submit"]').exists()).toBe(true);
  expect(w.find('[data-test="edit-script-cancel"]').text()).toBe('取消');
  // Header text = "编辑脚本"
  expect(w.find('header h3').text()).toBe('编辑脚本');
});

test('edit-mode: empty content + submit → inline error, no API call', async () => {
  const w = mount(EditScriptModal, { props: { item: sampleItem } });
  await w.find('[data-test="edit-script-submit"]').trigger('click');
  await flushPromises();
  expect(packagesApi.editScript).not.toHaveBeenCalled();
  expect(w.find('[data-test="edit-script-error"]').text()).toMatch(/不能为空/);
});

// ─────────────────────────────────────────────────────────────────────
// R67-T1 — viewMode prop. Auto-fetch + readonly render + no Save.
// ─────────────────────────────────────────────────────────────────────

test('view-mode modal auto-fetches script body via getScript on mount', async () => {
  packagesApi.getScript.mockResolvedValue({
    data: { name: 'pkg-a', scriptContent: 'Write-Host view', scriptSha256: 'a'.repeat(64), source: 'admin-upload', updatedAt: '2026-08-30' }
  });
  const w = mount(EditScriptModal, { props: { item: sampleItem, viewMode: true } });
  // Wait for the onMounted fetch + the v-model patch.
  await flushPromises();
  expect(packagesApi.getScript).toHaveBeenCalledTimes(1);
  expect(packagesApi.getScript).toHaveBeenCalledWith('pkg-a');
  const ta = w.find('[data-test="edit-script-input"]');
  expect(ta.element.value).toBe('Write-Host view');
});

test('view-mode modal renders the view variant data-test root', async () => {
  packagesApi.getScript.mockResolvedValue({
    data: { name: 'pkg-a', scriptContent: 'x', scriptSha256: 'a'.repeat(64), source: 'admin-upload', updatedAt: '2026-08-30' }
  });
  const w = mount(EditScriptModal, { props: { item: sampleItem, viewMode: true } });
  await flushPromises();
  expect(w.find('[data-test="edit-script-modal-view"]').exists()).toBe(true);
  expect(w.find('[data-test="edit-script-modal"]').exists()).toBe(false);
  // Header text = "查看脚本"
  expect(w.find('header h3').text()).toBe('查看脚本');
});

test('view-mode modal: textarea is readonly and Save button is hidden', async () => {
  packagesApi.getScript.mockResolvedValue({
    data: { name: 'pkg-a', scriptContent: 'x', scriptSha256: 'a'.repeat(64), source: 'admin-upload', updatedAt: '2026-08-30' }
  });
  const w = mount(EditScriptModal, { props: { item: sampleItem, viewMode: true } });
  await flushPromises();
  const ta = w.find('[data-test="edit-script-input"]');
  expect(ta.attributes('readonly')).toBeDefined();
  // Save button MUST be hidden in view mode — only the close footer action remains.
  expect(w.find('[data-test="edit-script-submit"]').exists()).toBe(false);
  // Close button label = "关闭" in view mode
  expect(w.find('[data-test="edit-script-cancel"]').text()).toBe('关闭');
});

test('view-mode modal: shows sha256 prefix hint alongside the label', async () => {
  packagesApi.getScript.mockResolvedValue({
    data: { name: 'pkg-a', scriptContent: 'x', scriptSha256: '1234567890abcdef'.padEnd(64, '0'), source: 'admin-upload', updatedAt: '2026-08-30' }
  });
  const w = mount(EditScriptModal, { props: { item: sampleItem, viewMode: true } });
  await flushPromises();
  // The .vue template renders scriptSha.slice(0, 12) + '…' — the first
  // 12 hex chars of the fetched sha256, suffixed with the U+2026 ellipsis.
  expect(w.text()).toMatch(/sha256:\s*1234567890ab…/);
});

test('view-mode modal: fetch failure shows inline error (no body)', async () => {
  packagesApi.getScript.mockRejectedValue({
    response: { data: { error: "package 'pkg-a' not found" } }
  });
  const w = mount(EditScriptModal, { props: { item: sampleItem, viewMode: true } });
  await flushPromises();
  expect(packagesApi.getScript).toHaveBeenCalledTimes(1);
  expect(w.find('[data-test="edit-script-error"]').text()).toMatch(/not found/);
  // No Save button still — the footer only has Close.
  expect(w.find('[data-test="edit-script-submit"]').exists()).toBe(false);
});

test('view-mode modal: Close button emits close event', async () => {
  packagesApi.getScript.mockResolvedValue({
    data: { name: 'pkg-a', scriptContent: 'x', scriptSha256: 'a'.repeat(64), source: 'admin-upload', updatedAt: '2026-08-30' }
  });
  const w = mount(EditScriptModal, { props: { item: sampleItem, viewMode: true } });
  await flushPromises();
  await w.find('[data-test="edit-script-cancel"]').trigger('click');
  expect(w.emitted('close')).toBeTruthy();
  expect(w.emitted('close')).toHaveLength(1);
});
