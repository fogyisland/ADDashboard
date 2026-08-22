import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AgentTokenRotateModal from '../src/components/AgentTokenRotateModal.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    commitAgentToken: vi.fn(),
    getAgentTokenDelivery: vi.fn()
  }
}));

beforeEach(() => {
  adminApi.commitAgentToken.mockReset();
  adminApi.getAgentTokenDelivery.mockReset();
  adminApi.getAgentTokenDelivery.mockResolvedValue({
    data: { serverVersion: 0, total: 0, delivered: 0, agents: [] }
  });
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

test('renders newToken + expiry when visible (legacy rotate mode)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, mode: 'rotate', newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
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
    props: { visible: true, mode: 'rotate', newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
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
    props: { visible: true, mode: 'rotate', newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
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

test('稍后处理 button emits close (no commit, rotate mode)', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, mode: 'rotate', newToken: TOKEN, previousExpiresAt: null, ttlDays: 30 }
  });
  await flushPromises();
  await w.find('[data-test="close"]').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});

// ----- mode=generate (2026-08-21 UX redesign, auto-delivery) -----

test('mode=generate (default): renders newToken + delivery progress, hides commit CTA + expiry', async () => {
  setActivePinia(createPinia());
  adminApi.getAgentTokenDelivery.mockResolvedValue({
    data: { serverVersion: 8, total: 3, delivered: 1, agents: [
      { agentId: 'DC1', reportedVersion: 8, lastSeenAt: '2026-08-21T00:00:00Z' },
      { agentId: 'DC2', reportedVersion: 7, lastSeenAt: '2026-08-20T00:00:00Z' },
      { agentId: 'DC3', reportedVersion: 7, lastSeenAt: '2026-08-20T00:00:00Z' }
    ]}
  });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN }
  });
  await flushPromises();
  expect(w.find('[data-test="new-token"]').text()).toBe(TOKEN);
  // Delivery progress visible: 1 / 3 (33%)
  expect(w.text()).toContain('已推送到');
  expect(w.find('[data-test="delivery-progress"]').exists()).toBe(true);
  expect(w.find('[data-test="delivery-delivered"]').text()).toBe('1');
  expect(w.find('[data-test="delivery-total"]').text()).toBe('3');
  // Pending list visible (2 agents below serverVersion)
  expect(w.find('[data-test="delivery-pending"]').exists()).toBe(true);
  expect(w.text()).toContain('DC2');
  expect(w.text()).toContain('DC3');
  // No commit CTA, no TTL line, no "稍后处理" — auto-delivery replaces
  // both the operator RDP-and-edit and the close-old-token flow.
  expect(w.find('[data-test="commit"]').exists()).toBe(false);
  expect(w.text()).not.toContain('grace 窗口');
  // Single close button.
  expect(w.find('[data-test="close"]').exists()).toBe(true);
});

test('mode=generate: all delivered → shows ✓ 完成 message, close button reads 完成', async () => {
  setActivePinia(createPinia());
  adminApi.getAgentTokenDelivery.mockResolvedValue({
    data: { serverVersion: 8, total: 2, delivered: 2, agents: [
      { agentId: 'DC1', reportedVersion: 8, lastSeenAt: '2026-08-21T00:00:00Z' },
      { agentId: 'DC2', reportedVersion: 8, lastSeenAt: '2026-08-21T00:00:00Z' }
    ]}
  });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN }
  });
  await flushPromises();
  expect(w.find('[data-test="delivery-done"]').exists()).toBe(true);
  expect(w.text()).toContain('全部 Agent 已接收新令牌');
  expect(w.find('[data-test="close"]').text()).toBe('完成');
});

test('mode=generate: zero agents → renders "0 / 0", no pending list', async () => {
  setActivePinia(createPinia());
  adminApi.getAgentTokenDelivery.mockResolvedValue({
    data: { serverVersion: 8, total: 0, delivered: 0, agents: [] }
  });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN }
  });
  await flushPromises();
  expect(w.find('[data-test="delivery-delivered"]').text()).toBe('0');
  expect(w.find('[data-test="delivery-total"]').text()).toBe('0');
  // No pending list when no agents at all.
  expect(w.find('[data-test="delivery-pending"]').exists()).toBe(false);
  expect(w.find('[data-test="close"]').text()).toBe('关闭');
});

test('mode=generate: polling fetches getAgentTokenDelivery on open + on 2s interval', async () => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  try {
    adminApi.getAgentTokenDelivery.mockResolvedValue({
      data: { serverVersion: 8, total: 1, delivered: 0, agents: [
        { agentId: 'DC1', reportedVersion: 7, lastSeenAt: '2026-08-20T00:00:00Z' }
      ]}
    });
    const w = mount(AgentTokenRotateModal, {
      props: { visible: true, newToken: TOKEN }
    });
    await flushPromises();
    // Immediate fetch on open.
    expect(adminApi.getAgentTokenDelivery).toHaveBeenCalledTimes(1);
    // 2s tick — another fetch.
    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(adminApi.getAgentTokenDelivery).toHaveBeenCalledTimes(2);
    // 4s tick — another fetch.
    vi.advanceTimersByTime(2000);
    await flushPromises();
    expect(adminApi.getAgentTokenDelivery).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test('mode=generate: closing the modal stops the polling timer (no leak after unmount)', async () => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  try {
    adminApi.getAgentTokenDelivery.mockResolvedValue({
      data: { serverVersion: 8, total: 0, delivered: 0, agents: [] }
    });
    const w = mount(AgentTokenRotateModal, {
      props: { visible: true, newToken: TOKEN }
    });
    await flushPromises();
    expect(adminApi.getAgentTokenDelivery).toHaveBeenCalledTimes(1);
    // Close: visible=false → polling stops.
    await w.setProps({ visible: false });
    vi.advanceTimersByTime(5000);
    await flushPromises();
    // Still 1 — no further polls after close.
    expect(adminApi.getAgentTokenDelivery).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('mode=generate: polling failure is silent (no toast, keeps last counts)', async () => {
  setActivePinia(createPinia());
  adminApi.getAgentTokenDelivery
    .mockResolvedValueOnce({
      data: { serverVersion: 8, total: 2, delivered: 1, agents: [
        { agentId: 'DC1', reportedVersion: 8, lastSeenAt: '2026-08-21T00:00:00Z' },
        { agentId: 'DC2', reportedVersion: 7, lastSeenAt: '2026-08-20T00:00:00Z' }
      ]}
    })
    .mockRejectedValueOnce(new Error('network down'));
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN }
  });
  await flushPromises();
  // Initial fetch succeeds → 1 / 2.
  expect(w.find('[data-test="delivery-delivered"]').text()).toBe('1');
  // Force a poll by advancing fake timers + flushing.
  vi.useFakeTimers();
  try {
    vi.advanceTimersByTime(2000);
    await flushPromises();
    // Last successful counts preserved on poll failure.
    expect(w.find('[data-test="delivery-delivered"]').text()).toBe('1');
    expect(w.find('[data-test="delivery-total"]').text()).toBe('2');
  } finally {
    vi.useRealTimers();
  }
});

test('mode=generate: click 关闭 emits close (no commit, since there is no commit button)', async () => {
  setActivePinia(createPinia());
  adminApi.getAgentTokenDelivery.mockResolvedValue({
    data: { serverVersion: 8, total: 1, delivered: 0, agents: [
      { agentId: 'DC1', reportedVersion: 7, lastSeenAt: '2026-08-20T00:00:00Z' }
    ]}
  });
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN }
  });
  await flushPromises();
  await w.find('[data-test="close"]').trigger('click');
  await flushPromises();
  expect(w.emitted('close')).toBeTruthy();
  expect(adminApi.commitAgentToken).not.toHaveBeenCalled();
});

test('mode=generate: click 复制 still emits copied event with token', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { visible: true, newToken: TOKEN }
  });
  await flushPromises();
  await w.find('[data-test="copy"]').trigger('click');
  await flushPromises();
  expect(w.emitted('copied')).toBeTruthy();
  expect(w.emitted('copied')[0][0]).toEqual({ token: TOKEN });
});

// ----- Legacy mode=view (kept for backward compat with other callers) -----

test('mode=view: header reads Agent 令牌(当前) and hides commit CTA + expiry', async () => {
  setActivePinia(createPinia());
  const w = mount(AgentTokenRotateModal, {
    props: { mode: 'view', visible: true, newToken: TOKEN, previousExpiresAt: '2026-09-19T00:00:00Z', ttlDays: 30 }
  });
  await flushPromises();
  expect(w.text()).toContain('Agent 令牌(当前)');
  expect(w.text()).not.toContain('Agent 令牌已生成');
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