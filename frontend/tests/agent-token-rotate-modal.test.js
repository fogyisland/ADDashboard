import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AgentTokenRotateModal from '../src/components/AgentTokenRotateModal.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    commitAgentToken: vi.fn()
  }
}));

beforeEach(() => {
  adminApi.commitAgentToken.mockReset();
  // jsdom doesn't provide navigator.clipboard by default; stub it so the
  // copy button's success path is exercised without a real DOM context.
  if (!globalThis.navigator.clipboard) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue() },
      configurable: true
    });
  }
});

const TOKEN = 'a3f9bc12deadbeefcafe000000000000000000000000000000000000000000beef';

test('renders newToken + expiry when visible', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  await flushPromises();
  expect(w.find('[data-test="new-token"]').text()).toBe(TOKEN);
  expect(w.text()).toContain('2026'); // expiry timestamp visible
  expect(w.text()).toContain('30 天 grace 窗口');
});

test('does not render when visible=false', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: false, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  expect(w.find('[data-test="agent-token-modal"]').exists()).toBe(false);
});

test('click 复制 emits copied event with token', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="copy"]').trigger('click');
  await flushPromises();
  expect(w.emitted('copied')).toBeTruthy();
  expect(w.emitted('copied')[0][0]).toEqual({ token: TOKEN });
  expect(w.find('[data-test="copy"]').text()).toBe('已复制');
});

test('click 关闭旧令牌 calls commitAgentToken and emits committed + close', async () => {
  setActivePinia(createPinia());
  adminApi.commitAgentToken.mockResolvedValue({ data: { ok: true } });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="commit"]').trigger('click');
  await flushPromises();
  expect(adminApi.commitAgentToken).toHaveBeenCalled();
  expect(w.emitted('committed')).toBeTruthy();
  expect(w.emitted('close')).toBeTruthy();
});

test('commit failure surfaces notifyError and leaves modal open', async () => {
  setActivePinia(createPinia());
  adminApi.commitAgentToken.mockRejectedValue({ response: { data: { error: 'commit failed' } } });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="commit"]').trigger('click');
  await flushPromises();
  expect(adminApi.commitAgentToken).toHaveBeenCalled();
  expect(w.emitted('committed')).toBeFalsy();
  expect(w.emitted('close')).toBeFalsy();
  // Modal still visible — operator can retry.
  expect(w.find('[data-test="agent-token-modal"]').exists()).toBe(true);
});

test('background click emits close (no commit)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('.modal-bg').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});

test('稍后处理 button emits close (no commit)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="close"]').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});