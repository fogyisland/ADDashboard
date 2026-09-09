// R84-T1 verification: create a temporary schema, apply the merged 01-tables.sql,
// then diff columns / indexes / FKs against the live production schema.
const mysql = require('mysql2/promise');
const fs = require('fs');
const { execSync } = require('child_process');

const APP_SETTINGS = JSON.parse(fs.readFileSync('center/appsettings.json', 'utf8')).db.mysql;

async function dumpSchema(c, dbName) {
  await c.query(`USE \`${dbName}\``);
  const [tables] = await c.query('SHOW TABLES');
  const tableNames = tables.map(t => Object.values(t)[0]);
  const dump = {};
  for (const name of tableNames) {
    const [cols] = await c.query(`SHOW FULL COLUMNS FROM \`${name}\``);
    const colInfo = {};
    for (const col of cols) {
      colInfo[col.Field] = {
        type: col.Type,
        null: col.Null,
        key: col.Key,
        default: col.Default === null ? null : col.Default,
        extra: col.Extra || ''
      };
    }
    const [idxs] = await c.query(`SHOW INDEX FROM \`${name}\``);
    const grouped = {};
    for (const i of idxs) {
      if (!grouped[i.Key_name]) grouped[i.Key_name] = { unique: !i.Non_unique, cols: [], type: i.Index_type };
      grouped[i.Key_name].cols.push({ col: i.Column_name, seq: i.Seq_in_index });
    }
    const idxInfo = {};
    for (const [k, v] of Object.entries(grouped)) {
      v.cols.sort((a, b) => a.seq - b.seq);
      const colList = v.cols.map(x => x.col).join(',');
      idxInfo[k] = { unique: v.unique, cols: colList, type: v.type };
    }
    const [fk] = await c.query(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [dbName, name]
    );
    const fkInfo = {};
    for (const f of fk) {
      if (!fkInfo[f.CONSTRAINT_NAME]) fkInfo[f.CONSTRAINT_NAME] = [];
      fkInfo[f.CONSTRAINT_NAME].push({ col: f.COLUMN_NAME, refTable: f.REFERENCED_TABLE_NAME, refCol: f.REFERENCED_COLUMN_NAME });
    }
    dump[name] = { cols: colInfo, idxs: idxInfo, fks: fkInfo };
  }
  return dump;
}

function compareSchema(prod, fresh, log) {
  let colMatches = 0, colMismatches = 0;
  let idxMatches = 0, idxMismatches = 0;
  let fkMatches = 0, fkMismatches = 0;
  const prodTables = Object.keys(prod);
  const freshTables = Object.keys(fresh);
  const allTables = new Set([...prodTables, ...freshTables]);
  for (const t of allTables) {
    if (!prod[t]) {
      log.push(`MISSING IN PROD: ${t}`);
      continue;
    }
    if (!fresh[t]) {
      log.push(`MISSING IN FRESH: ${t}`);
      continue;
    }
    // Columns: compare field-by-field for shared tables
    for (const [col, c] of Object.entries(prod[t].cols)) {
      const f = fresh[t].cols[col];
      if (!f) { colMismatches++; log.push(`COL MISSING IN FRESH: ${t}.${col}`); continue; }
      if (f.type === c.type && f.null === c.null && f.default === c.default && f.extra === c.extra) {
        colMatches++;
      } else {
        colMismatches++;
        log.push(`COL MISMATCH: ${t}.${col} | prod=${JSON.stringify(c)} | fresh=${JSON.stringify(f)}`);
      }
    }
    for (const col of Object.keys(fresh[t].cols)) {
      if (!prod[t].cols[col]) { colMismatches++; log.push(`COL MISSING IN PROD: ${t}.${col}`); }
    }
    // Indexes
    for (const [k, ix] of Object.entries(prod[t].idxs)) {
      const f = fresh[t].idxs[k];
      if (!f) { idxMismatches++; log.push(`IDX MISSING IN FRESH: ${t}.${k}`); continue; }
      if (f.unique === ix.unique && f.cols === ix.cols && f.type === ix.type) {
        idxMatches++;
      } else {
        idxMismatches++;
        log.push(`IDX MISMATCH: ${t}.${k} | prod=${JSON.stringify(ix)} | fresh=${JSON.stringify(f)}`);
      }
    }
    for (const k of Object.keys(fresh[t].idxs)) {
      if (!prod[t].idxs[k]) { idxMismatches++; log.push(`IDX MISSING IN PROD: ${t}.${k}`); }
    }
    // FKs
    for (const [k, fk] of Object.entries(prod[t].fks)) {
      const f = fresh[t].fks[k];
      if (!f) { fkMismatches++; log.push(`FK MISSING IN FRESH: ${t}.${k}`); continue; }
      const prodSig = JSON.stringify(fk);
      const freshSig = JSON.stringify(f);
      if (prodSig === freshSig) fkMatches++;
      else { fkMismatches++; log.push(`FK MISMATCH: ${t}.${k} | prod=${prodSig} | fresh=${freshSig}`); }
    }
    for (const k of Object.keys(fresh[t].fks)) {
      if (!prod[t].fks[k]) { fkMismatches++; log.push(`FK MISSING IN PROD: ${t}.${k}`); }
    }
  }
  return { colMatches, colMismatches, idxMatches, idxMismatches, fkMatches, fkMismatches };
}

(async () => {
  const tmpDb = `addashboard_r84_verify_${Date.now()}`;
  const c = await mysql.createConnection({
    host: APP_SETTINGS.host, port: APP_SETTINGS.port, user: APP_SETTINGS.user, password: APP_SETTINGS.password
  });
  await c.query(`CREATE DATABASE \`${tmpDb}\``);
  await c.query(`USE \`${tmpDb}\``);
  const sql = fs.readFileSync('db/schema/01-tables.sql', 'utf8');
  // Use mysql client's multi-statement support, which is the most permissive
  // way to apply DDL — it accepts everything the schema-applier's splitter
  // accepts plus some extras (DELIMITER, etc.). This is purely a verification
  // harness: production applyAll() uses splitSqlStatements().
  const conn2 = await mysql.createConnection({
    host: APP_SETTINGS.host, port: APP_SETTINGS.port, user: APP_SETTINGS.user, password: APP_SETTINGS.password,
    multipleStatements: true, database: tmpDb
  });
  try {
    await conn2.query(sql);
  } catch (e) {
    console.error('FAILED:', e.message);
    throw e;
  }
  console.log(`Tmp DB ${tmpDb} populated.`);

  const prod = await dumpSchema(c, APP_SETTINGS.database);
  const fresh = await dumpSchema(c, tmpDb);

  const log = [];
  const r = compareSchema(prod, fresh, log);
  console.log('\n=== RESULTS ===');
  console.log(`Columns:  ${r.colMatches} match, ${r.colMismatches} mismatch`);
  console.log(`Indexes:  ${r.idxMatches} match, ${r.idxMismatches} mismatch`);
  console.log(`FKs:      ${r.fkMatches} match, ${r.fkMismatches} mismatch`);
  if (log.length) {
    console.log('\n=== DIFF DETAIL ===');
    for (const line of log) console.log(line);
  } else {
    console.log('\n=== NO DIFFS ===');
  }

  await c.query(`DROP DATABASE \`${tmpDb}\``);
  await c.end();
  process.exit(log.length === 0 ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });