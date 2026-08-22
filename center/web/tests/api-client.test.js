import { test, expect, vi } from 'vitest';
import axios from 'axios';

const routerPush = vi.fn();
vi.mock('../src/router.js', () => ({ default: { push: routerPush } }));

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
      response: { use: vi.fn((success, error) => { resHandlers.push(success, error); return success; }) }
    }
  };
  const create = vi.fn(() => mockInstance);
  return {
    default: { create },
    create,
    // Expose the registered interceptor handlers so tests can invoke the
    // response error path directly. The verb mocks don't actually chain
    // interceptors (they short-circuit to Promise.resolve), so the only
    // way to exercise the 401 redirect logic is to drive the registered
    // error handler ourselves.
    __resHandlers: resHandlers,
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

test('401 response clears ad_token and redirects to /login', async () => {
  localStorage.setItem('ad_token', 'old-tok');
  routerPush.mockClear();

  // Load client.js so its response error handler is registered.
  await import('../src/api/client.js?login=' + Date.now());

  // resHandlers layout per .use(success, error) call is [success, error].
  // The error handler is the LAST one registered per call. Mock verb
  // functions don't actually chain interceptors (they short-circuit to
  // Promise.resolve), so we drive the registered error handler directly.
  const axiosMod = await import('axios');
  expect(axiosMod.__resHandlers.length).toBeGreaterThanOrEqual(2);
  // Pick the last error handler (each client.js load registers a fresh pair).
  const handler = axiosMod.__resHandlers[axiosMod.__resHandlers.length - 1];
  // The handler re-rejects after running the redirect — await so the
  // rejection is observed (not an unhandled microtask).
  await handler({ response: { status: 401, data: { error: 'token expired' } } })
    .catch(() => {});

  expect(localStorage.getItem('ad_token')).toBeNull();
  expect(routerPush).toHaveBeenCalledWith('/login');
});

test('unhandledrejection with reason.message fires notifyError', async () => {
  const notifyMod = await import('../src/lib/notify.js');
  const spy = vi.spyOn(notifyMod, 'notifyError');

  // Make sure client.js is loaded so its window listener is registered.
  await import('../src/api/client.js?rej=' + Date.now());

  const evt = new Event('unhandledrejection');
  // jsdom doesn't expose a real PromiseRejectionEvent constructor in all
  // versions; plain Event with a `.reason` field is enough for our listener
  // which only reads `e.reason?.message`.
  evt.reason = { message: 'Network Error' };
  window.dispatchEvent(evt);

  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls.some(([msg]) => msg === 'Network Error')).toBe(true);
});