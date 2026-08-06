import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';
import { searchLockoutEvents } from '../src/api/lockout.js';

vi.mock('../src/api/client.js', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })) }
}));

test('searchLockoutEvents composes query string from non-empty fields', async () => {
  await searchLockoutEvents({ targetUser: 'alice', dc: 'DC01', caller: '', sinceHours: 24 });
  expect(api.get).toHaveBeenCalledWith('/api/lockout-events/search?targetUser=alice&dc=DC01&sinceHours=24');
});

test('searchLockoutEvents omits empty filter fields from query string', async () => {
  await searchLockoutEvents({ targetUser: 'alice', dc: '', caller: '', sinceHours: 6 });
  expect(api.get).toHaveBeenCalledWith('/api/lockout-events/search?targetUser=alice&sinceHours=6');
});