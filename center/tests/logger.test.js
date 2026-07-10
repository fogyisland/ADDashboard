import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger } from '../src/logger.js';

test('logger writes JSON line with component field', () => {
  const lines = [];
  const sink = new Writable({
    write(chunk, enc, cb) { lines.push(JSON.parse(chunk.toString())); cb(); }
  });
  const log = createLogger({ component: 'test', stream: sink });
  log.info('hello');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'hello');
  assert.equal(lines[0].component, 'test');
  assert.equal(lines[0].level, 30); // info
});
