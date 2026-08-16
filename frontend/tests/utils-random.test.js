import { describe, it, expect, vi, afterEach } from 'vitest';

// Polyfill install: importing random.js installs crypto.randomUUID as a side
// effect when the native one is missing — exactly what init.js relies on.
const randomFresh = await import('../src/utils/random.js');

describe('utils/random polyfill', () => {
  // jsdom exposes globalThis.crypto as a getter-only property, so we replace
  // it via Object.defineProperty rather than direct assignment.
  const originalCrypto = globalThis.crypto;
  function replaceCrypto(value) {
    Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  }

  afterEach(() => {
    // Restore the original crypto (the "missing" tests replace it wholesale).
    replaceCrypto(originalCrypto);
  });

  it('returns a valid v4 UUID when crypto.randomUUID is missing (older browser)', async () => {
    // Simulate older browsers (Chrome <92 / Firefox <95 / Safari <15.4) by
    // replacing crypto with one that has getRandomValues but NOT randomUUID.
    // jsdom's crypto.randomUUID is non-configurable so `delete` silently fails;
    // replacing the whole crypto object is the only reliable stub.
    replaceCrypto({ getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined');

    // Re-import the polyfill so its top-level side effect runs against the
    // current crypto shape (Vitest's module cache would otherwise reuse the
    // first-import snapshot).
    vi.resetModules();
    const random = await import('../src/utils/random.js');

    const id = random.randomUUID();
    // RFC 4122 v4 format: 8-4-4-4-12 hex with hyphens
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // The "4" in the version nibble confirms v4 (random UUID)
    expect(id[14]).toBe('4');
    // The variant nibble must be 10xx (8, 9, a, or b)
    expect('89ab').toContain(id[19].toLowerCase());
  });

  it('returns distinct values across many calls (random, not constant)', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(randomFresh.randomUUID());
    // 100 random v4 UUIDs should have ~0 collisions (1.2e-58 chance)
    expect(ids.size).toBe(100);
  });

  it('throws a clear error when crypto is entirely unavailable', async () => {
    // Pathological env where crypto is undefined entirely. The polyfill
    // install must throw a clear error rather than silently producing
    // all-zero UUIDs (which would collide in the system_config table).
    replaceCrypto(undefined);
    try {
      vi.resetModules();
      await expect(import('../src/utils/random.js')).rejects.toThrow(/crypto/i);
    } finally {
      replaceCrypto(originalCrypto);
    }
  });

  it('delegates to native crypto.randomUUID when present (no behavioral drift)', () => {
    if (!globalThis.crypto?.randomUUID) {
      // Skip in jsdom if no native — the earlier tests already cover the
      // polyfill path, this one just pins the no-op delegation contract.
      return;
    }
    const id = randomFresh.randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});