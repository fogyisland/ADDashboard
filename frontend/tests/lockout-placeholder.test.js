import { test, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import LockoutPlaceholderView from '../src/views/LockoutPlaceholderView.vue';

function makeRouter(query = {}) {
  const r = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/lockout-troubleshooting', component: LockoutPlaceholderView }
    ]
  });
  const qs = new URLSearchParams(query).toString();
  r.push(`/lockout-troubleshooting${qs ? '?' + qs : ''}`);
  return r;
}

test('renders placeholder text + dc query param', async () => {
  setActivePinia(createPinia()); // AppLayout mounts useAuthStore()
  const router = makeRouter({ dc: 'DC01' });
  await router.isReady(); // navigation must settle before mount, else route.query is empty
  const w = mount(LockoutPlaceholderView, {
    global: { plugins: [router] }
  });
  expect(w.text()).toContain('用户锁定排查');
  expect(w.text()).toContain('功能开发中');
  expect(w.text()).toContain('DC01');
});
