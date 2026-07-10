import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowUtcIso } from '../src/utils/time.js';

test('nowUtcIso returns ISO 8601 UTC string ending with Z', () => {
  const s = nowUtcIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
