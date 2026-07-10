import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger } from '../src/logger.js';

test('agent logger writes JSON line with component', () => {
  const lines = [];
  const sink = new Writable({ write(c,e,cb){ lines.push(JSON.parse(c.toString())); cb(); }});
  const log = createLogger({ component: 'agent', stream: sink });
  log.info('startup');
  assert.equal(lines[0].component, 'agent');
});
