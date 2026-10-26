#!/usr/bin/env node
// Static grammar scan — runs `node --check` on every .js file under
// center/src, center/server.js, and agent/. Emits findings.json next
// to this script's parent (center/findings.json). Used by Task 1 +
// orchestrator (code-quality-audit.test.js).
//
// Usage: node center/scripts/audit/static-scan.mjs
// Output: center/findings.json (relative to scripts/audit)
// Exit: 0 if no findings, 1 if any finding produced.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'publish' || entry.startsWith('.')) continue;
      yield* walk(p);
    } else if (entry.endsWith('.js')) {
      yield p;
    }
  }
}

const findings = [];
const roots = [
  join(repoRoot, 'center', 'src'),
  join(repoRoot, 'center', 'server.js'),
  join(repoRoot, 'agent')
];

let totalFiles = 0;

for (const root of roots) {
  let files = [];
  try {
    const s = statSync(root);
    if (s.isDirectory()) files = [...walk(root)];
    else files = [root];
  } catch (e) {
    findings.push({ file: relative(repoRoot, root), type: 'missing', message: e.message });
    continue;
  }
  for (const f of files) {
    if (f.includes('node_modules')) continue;
    totalFiles++;
    try {
      execFileSync('node', ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      findings.push({
        file: relative(repoRoot, f),
        type: 'syntax-error',
        message: (e.stderr?.toString() || e.message || '').slice(0, 500)
      });
    }
  }
}

const out = join(__dirname, '..', '..', 'findings.json');
writeFileSync(out, JSON.stringify(findings, null, 2));
console.log(`static-scan: scanned ${totalFiles} file(s), ${findings.length} finding(s) → ${out}`);
process.exit(findings.length === 0 ? 0 : 1);
