import Database from 'better-sqlite3';

export function openQueue(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
  )`);
  const ins = db.prepare('INSERT INTO queue (payload) VALUES (?)');
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM queue');
  const peek = db.prepare('SELECT id, payload FROM queue ORDER BY id ASC LIMIT ?');
  const del = db.prepare('DELETE FROM queue WHERE id = ?');
  return {
    enqueue: (payload) => { ins.run(payload); },
    count: () => cnt.get().n,
    peek: (limit) => peek.all(limit),
    delete: (ids) => { const tx = db.transaction((arr) => arr.forEach(id => del.run(id))); tx(ids); },
    close: () => db.close()
  };
}
