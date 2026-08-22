// Tiny pub-sub for global UI notifications. The ErrorBanner component
// subscribes once at App.vue mount; any module (api client, views,
// route handlers) can fire a toast by calling notify() without
// importing the component. Pub-sub (not a singleton ref) keeps the
// component tree test-friendly: tests can subscribe in isolation,
// verify the message, and never touch the real DOM.
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// kind: 'error' (red, default) | 'info' (blue) | 'success' (green)
// ttlMs: 0 = sticky until user dismisses
export function notify(message, kind = 'error', ttlMs = 5000) {
  for (const fn of listeners) {
    try { fn(message, kind, ttlMs); } catch { /* listener errors must not break the publisher */ }
  }
}

// Convenience wrappers for the common case. Centralizing the message
// format here means callers don't repeat themselves and tests can
// assert on a stable shape.
export function notifyError(message) { notify(message, 'error', 5000); }
export function notifyInfo(message)  { notify(message, 'info', 4000); }
export function notifySuccess(message) { notify(message, 'success', 3500); }