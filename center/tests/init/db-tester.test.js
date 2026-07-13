import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOneShotFacade } from '../../src/init/db-tester.js';
import { getWizardFacade, closeWizardFacade } from '../../src/init/wizard-facade.js';

// Stub the driver factories via direct import of the module we will modify.
// We expect withOneShotFacade to call createMysqlDriver or createMssqlDriver
// with the conn params, wrap it as a facade exposing execute/query/close,
// pass the facade to work(), then close it.

test('withOneShotFacade creates mysql facade for dialect=mysql and closes after work', async () => {
  let created = null, closed = null;
  const result = await withOneShotFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, async (db) => {
    created = db;
    assert.strictEqual(db.dialect, 'mysql');
    assert.strictEqual(typeof db.execute, 'function');
    assert.strictEqual(typeof db.close, 'function');
    return 'ok';
  }, {
    createMysqlDriver: (cfg) => { assert.deepStrictEqual(cfg, { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }); return { close: async () => { closed = true; } }; },
    createMssqlDriver: () => { throw new Error('should not be called'); }
  });
  assert.strictEqual(result, 'ok');
  assert.ok(created);
  assert.strictEqual(closed, true);
});

test('withOneShotFacade creates mssql facade for dialect=mssql', async () => {
  let createdFor = null;
  await withOneShotFacade('mssql', { server: 's', database: 'd', user: 'u', password: 'p' }, async () => 'ok', {
    createMysqlDriver: () => { throw new Error('should not be called'); },
    createMssqlDriver: (cfg) => { createdFor = cfg; return { close: async () => {} }; }
  });
  assert.deepStrictEqual(createdFor, { server: 's', database: 'd', user: 'u', password: 'p' });
});

test('withOneShotFacade closes facade even when work throws', async () => {
  let closed = false;
  await assert.rejects(
    withOneShotFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      async () => { throw new Error('boom'); },
      { createMysqlDriver: () => ({ close: async () => { closed = true; } }), createMssqlDriver: () => { throw new Error('x'); } }
    ),
    /boom/
  );
  assert.strictEqual(closed, true);
});

test('getWizardFacade creates facade on first call', async () => {
  await closeWizardFacade();
  let driverCfg = null;
  const f = await getWizardFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, {
    createMysqlDriver: (cfg) => { driverCfg = cfg; return { close: async () => {} }; },
    createMssqlDriver: () => { throw new Error('x'); }
  });
  assert.strictEqual(f.dialect, 'mysql');
  assert.deepStrictEqual(driverCfg, { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  await closeWizardFacade();
});

test('getWizardFacade returns same facade on subsequent calls with same params', async () => {
  await closeWizardFacade();
  let calls = 0;
  const drivers = {
    createMysqlDriver: () => { calls++; return { close: async () => {} }; },
    createMssqlDriver: () => { throw new Error('x'); }
  };
  const params = { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' };
  const f1 = await getWizardFacade('mysql', params, drivers);
  const f2 = await getWizardFacade('mysql', params, drivers);
  assert.strictEqual(f1, f2);
  assert.strictEqual(calls, 1);
  await closeWizardFacade();
});

test('getWizardFacade rebuilds when params change', async () => {
  await closeWizardFacade();
  let calls = 0;
  const drivers = {
    createMysqlDriver: () => { calls++; return { close: async () => {} }; },
    createMssqlDriver: () => { throw new Error('x'); }
  };
  await getWizardFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, drivers);
  await getWizardFacade('mysql', { host: 'h2', port: 3306, database: 'd', user: 'u', password: 'p' }, drivers);
  assert.strictEqual(calls, 2);
  await closeWizardFacade();
});

test('closeWizardFacade resets state', async () => {
  await closeWizardFacade();
  let closed = false;
  await getWizardFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, {
    createMysqlDriver: () => ({ close: async () => { closed = true; } }),
    createMssqlDriver: () => { throw new Error('x'); }
  });
  await closeWizardFacade();
  assert.strictEqual(closed, true);
});