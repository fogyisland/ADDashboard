// Verify 02-seed-roles.sql also works against the fresh schema.
const mysql = require('mysql2/promise');
const fs = require('fs');

const APP_SETTINGS = JSON.parse(fs.readFileSync('center/appsettings.json', 'utf8')).db.mysql;

(async () => {
  const tmpDb = `addashboard_r84_seed_${Date.now()}`;
  const c = await mysql.createConnection({
    host: APP_SETTINGS.host, port: APP_SETTINGS.port, user: APP_SETTINGS.user, password: APP_SETTINGS.password,
    multipleStatements: true
  });
  await c.query(`CREATE DATABASE \`${tmpDb}\``);
  await c.query(`USE \`${tmpDb}\``);
  console.log('Applying 01-tables.sql...');
  await c.query(fs.readFileSync('db/schema/01-tables.sql', 'utf8'));
  console.log('Applying 02-seed-roles.sql...');
  await c.query(fs.readFileSync('db/schema/02-seed-roles.sql', 'utf8'));
  console.log('Seed applied. Checking expected rows:');
  const [roles] = await c.query('SELECT role_name FROM sys_roles ORDER BY role_name');
  console.log('  sys_roles:', roles.map(r => r.role_name).join(','));
  const [perms] = await c.query(
    `SELECT r.role_name, GROUP_CONCAT(rp.permission ORDER BY rp.permission) AS perms
     FROM sys_roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id, r.role_name ORDER BY r.role_name`
  );
  for (const p of perms) console.log(`  ${p.role_name}: ${p.perms || '(none)'}`);
  const [cfg] = await c.query('SELECT config_key, config_value FROM system_config ORDER BY config_key');
  console.log(`  system_config: ${cfg.length} rows`);
  for (const r of cfg) console.log(`    ${r.config_key} = ${r.config_value}`);

  await c.query(`DROP DATABASE \`${tmpDb}\``);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });