import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMysqlDatetime } from '../src/utils/datetime.js';

test('toMysqlDatetime: ISO with milliseconds and Z -> naive DATETIME', () => {
  assert.equal(toMysqlDatetime('2026-07-12T09:00:04.931Z'), '2026-07-12 09:00:04');
});

test('toMysqlDatetime: ISO without milliseconds -> naive DATETIME', () => {
  assert.equal(toMysqlDatetime('2026-07-12T09:00:04Z'), '2026-07-12 09:00:04');
});

test('toMysqlDatetime: null -> null', () => {
  assert.equal(toMysqlDatetime(null), null);
});

test('toMysqlDatetime: undefined -> null', () => {
  assert.equal(toMysqlDatetime(undefined), null);
});

test('toMysqlDatetime: empty string -> null', () => {
  assert.equal(toMysqlDatetime(''), null);
});

test('toMysqlDatetime: invalid string -> null', () => {
  assert.equal(toMysqlDatetime('not-a-date'), null);
});

test('toMysqlDatetime: Date instance -> naive DATETIME', () => {
  assert.equal(toMysqlDatetime(new Date('2026-01-15T00:00:00Z')), '2026-01-15 00:00:00');
});
