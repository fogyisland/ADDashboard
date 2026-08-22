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

test('ConfigView: renders listenPort/heartbeat_port/report_port rows with labels + numeric inputs', async () => {
  adminApi.getConfig.mockResolvedValue({
    data: {
      listenPort: '8080',
      heartbeat_port: '8081',
      report_port: '8082'
    }
  });

  const wrapper = mount(ConfigView);
  await flushPromises();

  expect(wrapper.text()).toContain('中心 Web 端口');
  expect(wrapper.text()).toContain('心跳端口');
  expect(wrapper.text()).toContain('报告端口');
  // One number input per port key. The table renders exactly the keys
  // getConfig returned, so this fixture yields 3 regardless of how many
  // numeric keys the real endpoint carries.
  expect(wrapper.find('table.t').findAll('input[type="number"]')).toHaveLength(3);
});
