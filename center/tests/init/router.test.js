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
  createAdminFn = async () => adminResult,
  depOverrides = {}
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
      writeMarker: async () => {},
      backfillMigrations: async () => 0,
      ...depOverrides
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

test('GET /api/init/status returns needsInit=false in normal mode (no 404)', async () => {
  // Status is intentionally mounted BEFORE the init-mode guard so the frontend
  // router's `beforeEach` can probe init state without producing 404 noise on
  // every page load. Returns 200 with {needsInit: false} instead of 404.
  const app = makeApp({ needsInit: false });
  const r = await call(app, 'GET', '/api/init/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.needsInit, false);
});

test('GET /api/init/status is the only init route reachable in normal mode', async () => {
  // Other init routes stay guarded — only /status is always reachable.
  const app = makeApp({ needsInit: false });
  const r = await call(app, 'POST', '/api/init/db/test', { dialect: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
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

test('db/apply calls applyAll THEN backfillMigrations in order', async () => {
  // Order is load-bearing: applyAll runs migration 009, which creates the
  // schema_migrations table that backfillMigrations writes into. Backfilling
  // first would hit a missing table.
  const callOrder = [];
  const app = makeApp({
    depOverrides: {
      applyAll: async () => { callOrder.push('applyAll'); return { schema: [], seed: [], migrations: [] }; },
      backfillMigrations: async () => { callOrder.push('backfillMigrations'); }
    }
  });
  const r = await call(app, 'POST', '/api/init/db/apply', {
    dialect: 'mysql',
    connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
    createDatabase: false
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(callOrder, ['applyAll', 'backfillMigrations']);
});

test('db/apply returns 500 when backfillMigrations fails', async () => {
  const app = makeApp({
    depOverrides: { backfillMigrations: async () => { throw new Error('backfill boom'); } }
  });
  const r = await call(app, 'POST', '/api/init/db/apply', {
    dialect: 'mysql',
    connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
    createDatabase: false
  });
  assert.strictEqual(r.status, 500);
  assert.match(r.body.error, /backfill boom/);
});

// MSSQL wraps the actionable error in `precedingErrors[]` — the top-level
// `e.message` is often just "Could not create constraint or index. See previous
// errors." which is useless on its own. The wizard route must surface the
// chain so the operator can see the real constraint / FK / permission problem.
test('db/apply surfaces MSSQL precedingErrors in 500 response', async () => {
  const mssqlErr = new Error('Could not create constraint or index. See previous errors.');
  mssqlErr.code = 'EREQUEST';
  mssqlErr.lineNumber = 95;
  mssqlErr.precedingErrors = [
    Object.assign(new Error('Foreign key "fk_dcs_site" references invalid column "site_id" in referenced table.'), { code: 'EFK' }),
    Object.assign(new Error("The REFERENCES permission was denied on the object 'ad_sites', database 'ad_dashboard', schema 'dbo'."), { code: 'Eperm' })
  ];
  const app = makeApp({
    depOverrides: { applyAll: async () => { throw mssqlErr; } }
  });
  const r = await call(app, 'POST', '/api/init/db/apply', {
    dialect: 'mssql',
    connParams: { server: 's', database: 'd', user: 'u', password: 'p' },
    createDatabase: false
  });
  assert.strictEqual(r.status, 500);
  assert.match(r.body.error, /Could not create constraint or index/);
  assert.match(r.body.error, /fk_dcs_site/);
  assert.match(r.body.error, /REFERENCES permission/);
  assert.strictEqual(r.body.code, 'EREQUEST');
  assert.strictEqual(r.body.lineNumber, 95);
  assert.deepStrictEqual(r.body.precedingErrors, [
    'Foreign key "fk_dcs_site" references invalid column "site_id" in referenced table.',
    "The REFERENCES permission was denied on the object 'ad_sites', database 'ad_dashboard', schema 'dbo'."
  ]);
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
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080
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
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080
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

// ----- C6 fix: init/finalize validate listenPort and auto-generate secrets -----
// finalize previously accepted empty/missing jwtSecret and agentToken, which
// would write an appsettings.json with secrets that effectively disable auth
// (JWT signed with '' or agentToken matching any empty header). C6 fix: refuse
// empty values, auto-generate a 48-byte hex (96-char) secret when missing or
// shorter than 32 chars. Also rejects bad listenPort so the new instance
// can't boot-loop on a privileged/out-of-range port.

test('C6: finalize rejects listenPort below 1024 (privileged port)', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 80
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /listenPort/);
    assert.strictEqual(wrote.length, 0, 'appsettings.json must NOT be written when listenPort is invalid');
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize rejects listenPort above 65535', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 65536
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(wrote.length, 0);
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize rejects listenPort that is not a number', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 'abc'
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(wrote.length, 0);
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize rejects missing listenPort', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }
      // listenPort intentionally omitted
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(wrote.length, 0);
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize auto-generates jwtSecret when missing (96-char hex)', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080,
      agentToken: 'x'.repeat(48)
      // jwtSecret intentionally omitted
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(wrote.length, 1);
    assert.match(wrote[0].jwtSecret, /^[0-9a-f]{96}$/, 'jwtSecret should be auto-generated 96-char hex');
    assert.strictEqual(wrote[0].agentToken, 'x'.repeat(48), 'agentToken must be passed through unchanged');
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize auto-generates agentToken when missing', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080,
      jwtSecret: 'y'.repeat(48)
      // agentToken intentionally omitted
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(wrote.length, 1);
    assert.match(wrote[0].agentToken, /^[0-9a-f]{96}$/);
    assert.strictEqual(wrote[0].jwtSecret, 'y'.repeat(48));
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize auto-generates secret shorter than 32 chars (treated as missing)', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080,
      jwtSecret: 'short',
      agentToken: 'also-short'
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(wrote.length, 1);
    // Both should be auto-generated since the supplied values are < 32 chars
    assert.match(wrote[0].jwtSecret, /^[0-9a-f]{96}$/);
    assert.match(wrote[0].agentToken, /^[0-9a-f]{96}$/);
    assert.notStrictEqual(wrote[0].jwtSecret, wrote[0].agentToken, 'each generated secret must be unique');
  } finally {
    process.exit = origExit;
  }
});

test('C6: finalize passes through supplied secrets when length >= 32', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const wrote = [];
    const app = makeApp({ writeConfigFn: (args) => { wrote.push(args); return { ok: true, path: args.path }; } });
    const suppliedJwt = 'jwt-secret-' + 'x'.repeat(32); // 43 chars
    const suppliedAgent = 'agent-token-' + 'y'.repeat(32);
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080,
      jwtSecret: suppliedJwt,
      agentToken: suppliedAgent
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(wrote[0].jwtSecret, suppliedJwt);
    assert.strictEqual(wrote[0].agentToken, suppliedAgent);
  } finally {
    process.exit = origExit;
  }
});