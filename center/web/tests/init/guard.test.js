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
    // 2026-08-29 round-59.1: /matrix is now a redirect (→ /admin/site-replication-matrix/all)
    // so it's no longer suitable as a generic protected-path probe in the guard test —
    // the redirect chain would change currentRoute.value.path before the guard runs.
    // Use /agents (a real top-level AppLayout route) as the protected-path example.
    await router.push('/agents');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/agents');
  });

  it('allows protected path when ad_token present', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    localStorage.setItem('ad_token', 'fake-token');
    await router.push('/agents');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/agents');
  });

  // 2026-08-29 round-59.1: /matrix was an empty stub that called the
  // deleted /api/dashboard/site-matrix endpoint (R36 cleanup). We made
  // it a redirect to the canonical /admin/site-replication-matrix/all
  // (复制状态概览) so any saved bookmark from the old /matrix page
  // auto-resolves to the right view.
  it('/matrix redirects to canonical /admin/site-replication-matrix/all', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    localStorage.setItem('ad_token', 'fake-token');
    await router.push('/matrix');
    await router.isReady();
    expect(router.currentRoute.value.path).toBe('/admin/site-replication-matrix/all');
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