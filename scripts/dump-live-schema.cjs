const mysql = require('mysql2/promise');
const fs = require('fs');

(async () => {
  const cfg = JSON.parse(fs.readFileSync('center/appsettings.json', 'utf8')).db.mysql;
  const c = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database
  });
  const [tables] = await c.query('SHOW TABLES');
  const tableNames = tables.map(t => Object.values(t)[0]);
  for (const name of tableNames) {
    console.log('=== TABLE:', name);
    const [cols] = await c.query(`SHOW FULL COLUMNS FROM \`${name}\``);
    for (const col of cols) {
      const def = col.Default === null ? 'NULL' : col.Default;
      console.log(`  ${col.Field} | ${col.Type} | null=${col.Null} | key=${col.Key} | default=${def} | extra=${col.Extra || ''}`);
    }
    const [idxs] = await c.query(`SHOW INDEX FROM \`${name}\``);
    const grouped = {};
    for (const i of idxs) {
      if (!grouped[i.Key_name]) grouped[i.Key_name] = { unique: !i.Non_unique, cols: [], type: i.Index_type };
      grouped[i.Key_name].cols.push({ col: i.Column_name, seq: i.Seq_in_index });
    }
    for (const [k, v] of Object.entries(grouped)) {
      v.cols.sort((a, b) => a.seq - b.seq);
      const colList = v.cols.map(x => x.col).join(',');
      console.log(`  IDX ${v.unique ? 'UNIQUE' : '      '} ${k} (${colList}) type=${v.type}`);
    }
    const [fk] = await c.query(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
      [cfg.database, name]
    );
    for (const f of fk) {
      console.log(`  FK   ${f.CONSTRAINT_NAME} (${f.COLUMN_NAME}) -> ${f.REFERENCED_TABLE_NAME}(${f.REFERENCED_COLUMN_NAME})`);
    }
  }
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });