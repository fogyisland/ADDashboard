import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SQL Server raises error 10713 ("A MERGE statement must be terminated by a
// semi-colon (;).") for every MERGE that lacks the terminator — the parser
// rule is unconditional. MySQL has no such requirement, so a missing `;` is
// invisible in mysql-dialect tests and only surfaces at runtime on an MSSQL
// deployment. This scan walks the source text instead of the built dialect
// object because several MERGE registries (metric-store, orphan-schemas,
// installed-packages) are consumed directly by services and never reach
// buildSql('mssql').

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

// Backtick or single-quoted string literals. Our SQL is never double-quoted.
const STRING_LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g;

function unterminatedMerges() {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    let m;
    STRING_LITERAL.lastIndex = 0;
    while ((m = STRING_LITERAL.exec(src)) !== null) {
      const body = m[0].slice(1, -1);
      const merge = /MERGE\s+INTO/i.exec(body);
      if (!merge) continue;
      // The MERGE runs to the end of the literal unless a `;` closes it. A
      // trailing `; SELECT @@ROWCOUNT` counts as terminated.
      if (body.slice(merge.index).includes(';')) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file.slice(SRC.length + 1).replace(/\\/g, '/')}:${line}`);
    }
  }
  return offenders;
}

test('every MSSQL MERGE statement is terminated by a semicolon', () => {
  const offenders = unterminatedMerges();
  assert.deepStrictEqual(
    offenders,
    [],
    `MERGE statements missing the required ';' terminator (SQL Server error 10713):\n  ${offenders.join('\n  ')}`
  );
});
