import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../src/api/client.js', () => ({
  default: {
    get: vi.fn()
  }
}));

import api from '../../src/api/client.js';
import router, { resetInitStatusCache, _resetInitStatusCacheForTest } from '../../src/router.js';

describe('init bootstrap guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    _resetInitStatusCacheForTest();
    api.get.mockReset();
  });

  it('redirects /init to /login when needsInit=false', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    await router.push('/init');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(api.get).toHaveBeenCalledWith('/api/init/status');
  });

  it('redirects / to /init when needsInit=true', async () => {
    api.get.mockResolvedValue({ data: { needsInit: true } });
    await router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/init');
    expect(api.get).toHaveBeenCalledWith('/api/init/status');
  });

  it('allows /login when needsInit=false', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    await router.push('/login');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('redirects protected path to /login when no token', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    await router.push('/matrix');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/matrix');
  });

  it('allows protected path when ad_token present', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    localStorage.setItem('ad_token', 'fake-token');
    await router.push('/matrix');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/matrix');
  });

  it('treats /api/init/status error as needsInit=false', async () => {
    api.get.mockRejectedValue(new Error('network'));
    await router.push('/');
    await router.isReady();
    // needsInit=false (from catch branch) and no token => /login
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('invalidates cached init status after reset', async () => {
    api.get.mockResolvedValueOnce({ data: { needsInit: true } });
    await router.push('/login');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/init');

    resetInitStatusCache();
    api.get.mockResolvedValueOnce({ data: { needsInit: false } });
    await router.push('/login');

    expect(router.currentRoute.value.path).toBe('/login');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('caches init status after first call', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    await router.push('/init');
    await router.isReady();
    await router.push('/login');
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});