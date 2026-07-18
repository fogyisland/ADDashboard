import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initRouter } from '../../src/init/router.js';

function makeApp({
  needsInit = true,
  dbTestResult = { rows: [{ '1': 1 }], affectedRows: 0 },
  applyResult = { schema: [], seed: [], migrations: [] },
  adminResult = { id: 1, username: 'admin' },
  writeConfigFn = ({ path }) => ({ ok: true, path }),
  createAdminFn = async () => adminResult
} = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/init', initRouter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    configPath: './appsettings.json',
    installPath: '.',
    getNeedsInit: () => needsInit,
    _deps: {
      withOneShotFacade: async (d, p, w) => w({ execute: async () => dbTestResult, query: async () => dbTestResult, close: async () => {} }),
      applyAll: async () => applyResult,
      createAdmin: createAdminFn,
      writeConfig: writeConfigFn,
      getWizardFacade: async () => ({ execute: async () => dbTestResult, query: async () => dbTestResult, close: async () => {} }),
      closeWizardFacade: async () => {},
      writeMarker: async () => {}
    }
  }));
  return app;
}

async function call(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://localhost:${port}${path}`;
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      import('node:http').then(http => {
        const req = http.request(url, opts, (res) => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    });
  });
}

test('GET /api/init/status returns needsInit=true when in init mode', async () => {
  const app = makeApp({ needsInit: true });
  const r = await call(app, 'GET', '/api/init/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.needsInit, true);
});

test('GET /api/init/status returns 404 when not in init mode', async () => {
  const app = makeApp({ needsInit: false });
  const r = await call(app, 'GET', '/api/init/status');
  assert.strictEqual(r.status, 404);
});

test('POST /api/init/db/test returns ok when facade returns ok', async () => {
  const app = makeApp({ dbTestResult: { rows: [{ '1': 1 }], affectedRows: 0 } });
  const r = await call(app, 'POST', '/api/init/db/test', { dialect: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
});

test('POST /api/init/db/test returns 400 when dialect is missing', async () => {
  const app = makeApp();
  const r = await call(app, 'POST', '/api/init/db/test', { host: 'h' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /dialect/);
});

test('POST /api/init/db/apply applies schema + seed + migrations', async () => {
  const app = makeApp({ applyResult: { schema: ['s1'], seed: ['s2'], migrations: ['m1'] } });
  const r = await call(app, 'POST', '/api/init/db/apply', { dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, createDatabase: false });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.schema, ['s1']);
});

test('POST /api/init/admin/create returns 409 on AdminConflictError', async () => {
  const conflictErr = new Error('admin exists');
  conflictErr.code = 'ADMIN_EXISTS';
  const app = makeApp({
    createAdminFn: async () => { throw conflictErr; }
  });
  const r = await call(app, 'POST', '/api/init/admin/create', { dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, username: 'admin', password: 'pw' });
  assert.strictEqual(r.status, 409);
});

test('POST /api/init/finalize succeeds when closing wizard facade fails', async () => {
  // Stub process.exit so the route's setImmediate(() => process.exit(0)) does
  // not terminate the test runner. The actual exit behaviour is verified by
  // the dedicated test below.
  const origExit = process.exit;
  process.exit = () => {};
  try {
    let wrotePath = null, loggedError = null;
    const app = express();
    app.use(express.json());
    app.use('/api/init', initRouter({
      logger: { info: () => {}, warn: () => {}, error: (details, message) => { loggedError = { details, message }; } },
      configPath: './does-not-matter.json',
      getNeedsInit: () => true,
      _deps: {
        withOneShotFacade: async (d, p, w) => w({ execute: async () => ({}), query: async () => ({}), close: async () => {} }),
        applyAll: async () => ({}),
        createAdmin: async () => ({ id: 1, username: 'admin' }),
        writeConfig: ({ path }) => { wrotePath = path; return { ok: true, path }; },
        getWizardFacade: async () => ({}),
        closeWizardFacade: async () => { throw new Error('pool already closed'); }
      }
    }));
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(wrotePath, './does-not-matter.json');
    assert.deepStrictEqual(loggedError, {
      details: { err: 'pool already closed' },
      message: 'init wizard facade close failed'
    });
  } finally {
    process.exit = origExit;
  }
});
test('POST /api/init/finalize writes config and closes wizard facade', async () => {
  // Stub process.exit so the route's setImmediate(() => process.exit(0)) does
  // not terminate the test runner. The actual exit behaviour is verified by
  // the dedicated test below.
  const origExit = process.exit;
  process.exit = () => {};
  try {
    let wrotePath = null, closed = false;
    // Use a fresh setup here because we need to capture both wrotePath (from writeConfig)
    // and closed (from closeWizardFacade). makeApp captures only one; this test needs both.
    const app = express();
    app.use(express.json());
    app.use('/api/init', initRouter({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      configPath: './does-not-matter.json',
      getNeedsInit: () => true,
      _deps: {
        withOneShotFacade: async (d, p, w) => w({ execute: async () => ({}), query: async () => ({}), close: async () => {} }),
        applyAll: async () => ({}),
        createAdmin: async () => ({ id: 1, username: 'admin' }),
        writeConfig: ({ path }) => { wrotePath = path; return { ok: true, path }; },
        getWizardFacade: async () => ({}),
        closeWizardFacade: async () => { closed = true; }
      }
    }));
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080, agentToken: 'a', jwtSecret: 'j', logLevel: 'info', env: 'prod', staticDir: './dist'
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(wrotePath, './does-not-matter.json');
    assert.strictEqual(closed, true);
  } finally {
    process.exit = origExit;
  }
});

test('POST /api/init/finalize schedules process.exit(0) after responding', async () => {
  let exited = false;
  const origExit = process.exit;
  process.exit = (code) => { exited = code === 0; };
  try {
    const app = makeApp();
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    // Wait for setImmediate to fire
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(exited, true, 'process.exit(0) should have been called');
  } finally {
    process.exit = origExit;
  }
});