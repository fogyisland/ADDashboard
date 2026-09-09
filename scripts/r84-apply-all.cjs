// R84-T1: simulate init wizard applyAll() using the actual schema-applier logic.
// We test by: creating a temp DB, applying via splitSqlStatements from
// schema-applier, then dropping.
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const APP_SETTINGS = JSON.parse(fs.readFileSync('center/appsettings.json', 'utf8')).db.mysql;

// Inline reproduction of schema-applier.js splitSqlStatements — copied
// verbatim from center/src/init/schema-applier.js so the verification uses
// the exact same parser as production.
function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let blockDepth = 0;
  let currentDelim = ';';
  while (i < sql.length) {
    const c = sql[i];
    if (c === 'D' && (buf === '' || buf.endsWith('\n')) && /^\s*DELIMITER\s+(\S+)/.test(sql.slice(i))) {
      const m = /^\s*DELIMITER\s+(\S+)/.exec(sql.slice(i));
      currentDelim = m[1];
      buf = '';
      const nl = sql.indexOf('\n', i);
      i = nl >= 0 ? nl + 1 : sql.length;
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'" && sql[i + 1] === "'") { buf += sql[i + 1]; i += 2; continue; }
      if (c === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && sql[i + 1] === '"') { buf += sql[i + 1]; i += 2; continue; }
      if (c === '"') inDouble = false;
      i++; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl >= 0 ? nl : sql.length;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end >= 0 ? end + 2 : sql.length;
      continue;
    }
    if (c === "'") { inSingle = true; buf += c; i++; continue; }
    if (c === '"') { inDouble = true; buf += c; i++; continue; }
    if (c === 'B' && /BEGIN\b/.test(sql.slice(i, i + 5))) {
      blockDepth++; buf += sql.slice(i, i + 5); i += 5; continue;
    }
    if (c === 'E' && /END\b/.test(sql.slice(i, i + 3))) {
      if (blockDepth > 0) blockDepth--; buf += sql.slice(i, i + 3); i += 3; continue;
    }
    if (currentDelim.length === 1 && c === currentDelim[0] && blockDepth === 0) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    if (currentDelim.length > 1 && c === currentDelim[0] && blockDepth === 0 &&
        sql.slice(i, i + currentDelim.length) === currentDelim) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i += currentDelim.length;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

(async () => {
  const tmpDb = `addashboard_r84_applyall_${Date.now()}`;
  const c = await mysql.createConnection({
    host: APP_SETTINGS.host, port: APP_SETTINGS.port, user: APP_SETTINGS.user, password: APP_SETTINGS.password
  });
  await c.query(`CREATE DATABASE \`${tmpDb}\``);
  console.log(`Tmp DB: ${tmpDb}`);

  const sql01 = fs.readFileSync('db/schema/01-tables.sql', 'utf8');
  const sql02 = fs.readFileSync('db/schema/02-seed-roles.sql', 'utf8');

  console.log(`01-tables.sql: ${sql01.split('\n').length} lines, ${sql01.length} bytes`);
  console.log(`02-seed-roles.sql: ${sql02.split('\n').length} lines, ${sql02.length} bytes`);

  let total = 0;
  for (const file of ['db/schema/01-tables.sql', 'db/schema/02-seed-roles.sql']) {
    const sql = fs.readFileSync(file, 'utf8');
    const stmts = splitSqlStatements(sql);
    console.log(`  ${file}: ${stmts.length} statements`);
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      try {
        await c.query(`USE \`${tmpDb}\``);
        await c.query(stmt);
        total++;
      } catch (e) {
        console.error(`  FAIL [${i}]: ${stmt.slice(0, 120).replace(/\n/g, ' ')}`);
        console.error(`    ERR: ${e.message}`);
        await c.query(`DROP DATABASE \`${tmpDb}\``);
        await c.end();
        process.exit(1);
      }
    }
  }
  console.log(`\nAll ${total} statements applied successfully.`);

  const [tables] = await c.query(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?`, [tmpDb]);
  console.log(`Tables in fresh DB: ${tables[0].n}`);
  await c.query(`DROP DATABASE \`${tmpDb}\``);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });