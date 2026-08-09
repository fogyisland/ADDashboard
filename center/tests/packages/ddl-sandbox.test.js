import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSql, normalizeType, ALLOWED_KEYWORDS, BLOCKED_PATTERNS } from '../../src/packages/ddl-sandbox.js';

test('scanSql: passes simple CREATE TABLE', () => {
  const sql = 'CREATE TABLE metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, cpu_pct DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))';
  assert.deepStrictEqual(scanSql(sql), { ok: true });
});

test('scanSql: passes ALTER TABLE ADD COLUMN', () => {
  assert.deepStrictEqual(scanSql('ALTER TABLE metrics ADD COLUMN swap_pct DOUBLE NULL'), { ok: true });
});

test('scanSql: passes CREATE INDEX', () => {
  assert.deepStrictEqual(scanSql('CREATE INDEX ix_metrics_agent ON metrics (agent_id)'), { ok: true });
});

test('scanSql: rejects CREATE VIEW (SELECT body is blocked)', () => {
  // CREATE VIEW is a DDL keyword (allowed) but every view body contains SELECT
  // which is in BLOCKED_PATTERNS. The scanner rejects on SELECT, not on CREATE VIEW.
  const r = scanSql('CREATE VIEW v AS SELECT * FROM metrics');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /MERGE|SELECT/);
});

test('scanSql: rejects DROP TABLE', () => {
  const r = scanSql('DROP TABLE metrics');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /DROP/i);
});

test('scanSql: rejects GRANT', () => {
  assert.strictEqual(scanSql('GRANT SELECT ON metrics TO app_user').ok, false);
});

test('scanSql: rejects INSERT INTO', () => {
  assert.strictEqual(scanSql('INSERT INTO metrics VALUES (1, NOW(), 50.0)').ok, false);
});

test('scanSql: rejects UPDATE <identifier>', () => {
  assert.strictEqual(scanSql('UPDATE metrics SET cpu_pct = 0').ok, false);
});

test('scanSql: rejects DELETE FROM', () => {
  assert.strictEqual(scanSql('DELETE FROM metrics WHERE ts < NOW()').ok, false);
});

test('scanSql: rejects MERGE', () => {
  assert.strictEqual(scanSql('MERGE INTO metrics USING src ON metrics.id = src.id').ok, false);
});

test('scanSql: rejects SELECT', () => {
  assert.strictEqual(scanSql('SELECT * FROM metrics').ok, false);
});

test('scanSql: rejects EXEC / EXECUTE / CALL', () => {
  assert.strictEqual(scanSql('EXEC sp_helpdb').ok, false);
  assert.strictEqual(scanSql('CALL my_proc()').ok, false);
});

test('scanSql: rejects cross-package reference (pkg_other)', () => {
  const r = scanSql('CREATE TABLE x (id INT REFERENCES pkg_other.foo(id))');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /pkg_/);
});

test('scanSql: rejects cross-schema reference (installed_packages)', () => {
  const r = scanSql('CREATE TABLE x (id INT REFERENCES installed_packages(id))');
  assert.strictEqual(r.ok, false);
});

test('scanSql: rejects multi-statement', () => {
  const r = scanSql('CREATE TABLE foo (id INT); DROP TABLE bar');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /;/);
});

test('scanSql: rejects unknown identifier (e.g. Lambda, WHEREEVER)', () => {
  assert.strictEqual(scanSql('SELECT * FROM metrics WHERE id = 1').ok, false); // SELECT banned
  assert.strictEqual(scanSql('WHEREEVER foo = bar').ok, false); // unknown keyword
});

test('scanSql: passes ON UPDATE / ON DELETE CASCADE (FK actions)', () => {
  const sql = 'CREATE TABLE child (id INT, parent_id INT, FOREIGN KEY (parent_id) REFERENCES parent(id) ON UPDATE CASCADE ON DELETE CASCADE)';
  assert.deepStrictEqual(scanSql(sql), { ok: true });
});

test('scanSql: passes comment stripping', () => {
  const sql = `
    -- a comment
    /* multi
       line */
    CREATE TABLE x (id INT)
  `;
  assert.deepStrictEqual(scanSql(sql), { ok: true });
});

test('scanSql: passes dialect-specific (AUTO_INCREMENT / IDENTITY / NVARCHAR / DATETIMEOFFSET / COLLATE)', () => {
  assert.deepStrictEqual(scanSql('CREATE TABLE x (id INT AUTO_INCREMENT PRIMARY KEY, name NVARCHAR(64))'), { ok: true });
  assert.deepStrictEqual(scanSql('CREATE TABLE x (id INT IDENTITY PRIMARY KEY, ts DATETIMEOFFSET NOT NULL)'), { ok: true });
  assert.deepStrictEqual(scanSql('CREATE TABLE x (id INT) COLLATE utf8mb4_unicode_ci'), { ok: true });
});

test('scanSql: passes numeric literals and string literals', () => {
  assert.deepStrictEqual(scanSql("CREATE TABLE x (val DOUBLE DEFAULT 0.5, label VARCHAR(16) DEFAULT 'unknown')"), { ok: true });
});

test('scanSql: rejects identifier containing disallowed word (e.g. DROPPED)', () => {
  // identifier "DROPPED" — not a keyword, but contains DROP substring; \bDROP\b still matches because of word boundary
  const r = scanSql('CREATE TABLE DROPPED (id INT)');
  assert.strictEqual(r.ok, false); // matches \bDROP\b
});

test('normalizeType: case + whitespace insensitive', () => {
  assert.strictEqual(normalizeType('VARCHAR(64)'), 'varchar(64)');
  assert.strictEqual(normalizeType('  varchar(  64  )  '), 'varchar(64)');
  assert.strictEqual(normalizeType('DOUBLE'), 'double');
  assert.strictEqual(normalizeType('datetime'), 'datetime');
  assert.strictEqual(normalizeType('NVARCHAR(255)'), 'nvarchar(255)');
});

test('ALLOWED_KEYWORDS contains DDL essentials', () => {
  for (const k of ['CREATE', 'TABLE', 'ALTER', 'ADD', 'COLUMN', 'INDEX', 'VIEW', 'CASCADE', 'REFERENCES', 'ON', 'UPDATE', 'DELETE']) {
    assert.ok(ALLOWED_KEYWORDS.has(k), `${k} missing`);
  }
});

test('BLOCKED_PATTERNS is non-empty array of RegExp', () => {
  assert.ok(Array.isArray(BLOCKED_PATTERNS));
  assert.ok(BLOCKED_PATTERNS.length >= 6);
  for (const r of BLOCKED_PATTERNS) assert.ok(r instanceof RegExp);
});

test('scanSql: rejects non-string input', () => {
  assert.deepStrictEqual(scanSql(null), { ok: false, blocked: 'non-string input' });
});
