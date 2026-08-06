import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';
import { getDcSummary } from '../src/api/dcs.js';

vi.mock('../src/api/client.js', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })) }
}));

test('getDcSummary calls /api/dcs/summary with siteId when provided', async () => {
  await getDcSummary(1);
  expect(api.get).toHaveBeenCalledWith('/api/dcs/summary?siteId=1');
});

test('getDcSummary omits siteId param when null', async () => {
  await getDcSummary(null);
  expect(api.get).toHaveBeenCalledWith('/api/dcs/summary');
});
