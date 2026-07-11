import { test, expect, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios', () => {
  const reqHandlers = [];
  const resHandlers = [];
  const buildVerb = (verb) => {
    const fn = vi.fn((url, config) => {
      const cfg = { url, headers: {}, ...(config || {}) };
      for (const h of reqHandlers) h(cfg);
      // Re-write the call record so it includes the mutated config
      fn.mock.calls[fn.mock.calls.length - 1] = [url, cfg];
      return Promise.resolve({ data: cfg });
    });
    return fn;
  };
  const mockInstance = {
    get: buildVerb('get'),
    post: buildVerb('post'),
    put: buildVerb('put'),
    delete: buildVerb('delete'),
    interceptors: {
      request: { use: vi.fn((h) => { reqHandlers.push(h); return h; }) },
      response: { use: vi.fn((h) => { resHandlers.push(h); return h; }) }
    }
  };
  const create = vi.fn(() => mockInstance);
  return {
    default: { create },
    create,
    get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn()
  };
});

test('api client attaches Authorization header from localStorage', async () => {
  localStorage.setItem('ad_token', 'tok123');
  const mod = await import('../src/api/client.js?test=' + Date.now());
  await mod.default.get('/api/dashboard/overview');
  const a = (await import('axios')).default.create.mock.results[0].value;
  expect(a.get).toHaveBeenCalled();
  const headers = a.get.mock.calls[0][1]?.headers;
  expect(headers?.Authorization).toBe('Bearer tok123');
});