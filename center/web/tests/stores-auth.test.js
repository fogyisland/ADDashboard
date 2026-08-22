import { test, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth.js';

beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); });

test('login success stores token and user', async () => {
  const store = useAuthStore();
  await store.login({ username: 'admin', password: 'pw' }, async () => ({ data: { token: 'T', user: { id: 1, role: 'admin' } } }));
  expect(store.token).toBe('T');
  expect(localStorage.getItem('ad_token')).toBe('T');
  expect(store.isAdmin).toBe(true);
});

test('logout clears state', async () => {
  const store = useAuthStore();
  await store.login({ username: 'a', password: 'b' }, async () => ({ data: { token: 'T', user: { role: 'admin' } } }));
  store.logout();
  expect(store.token).toBeNull();
  expect(localStorage.getItem('ad_token')).toBeNull();
});
