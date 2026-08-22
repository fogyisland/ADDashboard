import { beforeEach, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ConfigView from '../src/views/admin/ConfigView.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getConfigAudit: vi.fn(),
    rollbackConfig: vi.fn()
  }
}));

beforeEach(() => {
  setActivePinia(createPinia());
  adminApi.getConfig.mockReset();
  adminApi.getConfigAudit.mockResolvedValue({ data: [] });
});

test('ConfigView: shows "待重启" badge on listenPort row when restartRequired.listenPort=true', async () => {
  adminApi.getConfig.mockResolvedValue({
    data: {
      listenPort: '9090',
      restartRequired: { listenPort: true }
    }
  });

  const wrapper = mount(ConfigView);
  await flushPromises();

  expect(wrapper.text()).toContain('待重启');
  expect(wrapper.find('.restart-badge').exists()).toBe(true);
});

test('ConfigView: hides "待重启" badge when restartRequired.listenPort=false', async () => {
  adminApi.getConfig.mockResolvedValue({
    data: {
      listenPort: '8080',
      restartRequired: { listenPort: false }
    }
  });

  const wrapper = mount(ConfigView);
  await flushPromises();

  expect(wrapper.text()).not.toContain('待重启');
  expect(wrapper.find('.restart-badge').exists()).toBe(false);
});
