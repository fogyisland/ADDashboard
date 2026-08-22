import { test, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import { useDirtyState } from '../src/composables/useDirtyState.js';

test('initial state: not dirty', () => {
  const initial = { a: '1', b: '2' };
  const { current, snapshot, dirty } = useDirtyState(initial);
  expect(current.value).toEqual(initial);
  expect(snapshot.value).toEqual(initial);
  expect(dirty.value).toBe(false);
});

test('mutating current triggers dirty', () => {
  const { current, dirty } = useDirtyState({ a: '1' });
  current.value = { a: '2' };
  expect(dirty.value).toBe(true);
});

test('markClean takes a new snapshot and clears dirty', () => {
  const { current, snapshot, dirty, markClean } = useDirtyState({ a: '1' });
  current.value = { a: '2' };
  expect(dirty.value).toBe(true);
  markClean({ a: '2' });
  expect(snapshot.value).toEqual({ a: '2' });
  expect(dirty.value).toBe(false);
});

test('reset restores current to snapshot', () => {
  const { current, snapshot, dirty, reset } = useDirtyState({ a: '1', b: '2' });
  current.value = { a: '99', b: '2' };
  expect(dirty.value).toBe(true);
  reset();
  expect(current.value).toEqual({ a: '1', b: '2' });
  expect(dirty.value).toBe(false);
});

test('snapshot is decoupled from current (no shared references)', () => {
  const initial = { a: { nested: 1 } };
  const { current, snapshot, markClean } = useDirtyState(initial);
  current.value.a.nested = 99;
  markClean(current.value);
  expect(snapshot.value.a.nested).toBe(99);
  current.value.a.nested = 100;
  expect(snapshot.value.a.nested).toBe(99);
});

test('JSON.stringify equality is used for comparison (key order independent)', () => {
  const { current, dirty } = useDirtyState({ a: '1', b: '2' });
  current.value = { b: '2', a: '1' };
  expect(dirty.value).toBe(false);
});

// --- Regression guards -------------------------------------------------
// The key-order case above also passes if `dirty` is permanently stuck at
// false, so it is asserted here against a real change to keep it honest.

test('key-order comparison is not vacuous: a real value change is still dirty', () => {
  const { current, dirty } = useDirtyState({ a: '1', b: '2' });
  current.value = { b: '2', a: '1' };
  expect(dirty.value).toBe(false);
  current.value = { b: '3', a: '1' };
  expect(dirty.value).toBe(true);
});

test('nested field edit flips dirty without whole-object assignment', () => {
  const { current, dirty } = useDirtyState({ a: { n: 1 } });
  expect(dirty.value).toBe(false);
  current.value.a.n = 2;
  expect(dirty.value).toBe(true);
});

test('editing again after markClean re-dirties', () => {
  const { current, dirty, markClean } = useDirtyState({ a: '1' });
  current.value = { a: '2' };
  markClean(current.value);
  expect(dirty.value).toBe(false);
  current.value = { a: '3' };
  expect(dirty.value).toBe(true);
});

test('beforeunload is registered on mount, guards only when dirty, and is removed on unmount', async () => {
  const addSpy = vi.spyOn(window, 'addEventListener');
  const removeSpy = vi.spyOn(window, 'removeEventListener');
  let api = null;
  const Comp = { setup() { api = useDirtyState({ a: '1' }); return () => h('div'); } };
  const wrapper = mount(Comp);

  const registrations = addSpy.mock.calls.filter((c) => c[0] === 'beforeunload');
  expect(registrations.length).toBe(1);
  const handler = registrations[0][1];

  const cleanEvent = { preventDefault: vi.fn(), returnValue: undefined };
  handler(cleanEvent);
  expect(cleanEvent.preventDefault).not.toHaveBeenCalled();

  api.current.value = { a: '2' };
  await nextTick();
  const dirtyEvent = { preventDefault: vi.fn(), returnValue: undefined };
  handler(dirtyEvent);
  expect(dirtyEvent.preventDefault).toHaveBeenCalled();
  expect(dirtyEvent.returnValue).toBe('');

  wrapper.unmount();
  expect(removeSpy.mock.calls.filter((c) => c[0] === 'beforeunload' && c[1] === handler).length).toBe(1);
});

test('no beforeunload listener is registered outside setup()', () => {
  const addSpy = vi.spyOn(window, 'addEventListener');
  const before = addSpy.mock.calls.filter((c) => c[0] === 'beforeunload').length;
  useDirtyState({ a: '1' });
  const after = addSpy.mock.calls.filter((c) => c[0] === 'beforeunload').length;
  expect(after).toBe(before);
});
