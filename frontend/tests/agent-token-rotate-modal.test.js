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

// mode='view' (operator-initiated read of the active token): same copy
// button works, but no commit CTA + no expiry line + no "稍后处理"
// split-button footer. The "Agent 令牌已轮换" header is replaced with
// "Agent 令牌(当前)" so the operator knows they're looking at the live
// token, not a freshly-issued one.
test('mode=view: header reads Agent 令牌(当前) and hides commit CTA + expiry', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { mode: 'view', visible: true, newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  await flushPromises();
  expect(w.text()).toContain('Agent 令牌(当前)');
  expect(w.text()).not.toContain('Agent 令牌已轮换');
  // Commit CTA + 稍后处理 split hidden in view mode
  expect(w.find('[data-test="commit"]').exists()).toBe(false);
  // Expiry line is rotate-flow specific — even if previousExpiresAt is set,
  // view mode shouldn't surface the grace-window countdown.
  expect(w.text()).not.toContain('30 天 grace 窗口');
  // Copy button still works
  expect(w.find('[data-test="copy"]').exists()).toBe(true);
  // Single close button (no primary CTA)
  expect(w.find('[data-test="close"]').exists()).toBe(true);
  expect(w.find('[data-test="close"]').text()).toBe('关闭');
});

test('mode=view: click 关闭 emits close (no commit, since there is no commit button)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { mode: 'view', visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="close"]').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});

test('mode=view: click 复制 still emits copied event with token', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { mode: 'view', visible: true, newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="copy"]').trigger('click');
  await flushPromises();
  expect(w.emitted('copied')).toBeTruthy();
  expect(w.emitted('copied')[0][0]).toEqual({ token: TOKEN });
});