#!/usr/bin/env node
// R160 — agent bundle import-graph audit (reachability + resolvability).
//
// WHY
// ---
// The member green package was hand-copied and, until R160, still carried the
// AD collector lineage (collector.js / discovery.js / scheduler.js /
// ad-commands-drainer.js / local-queue.js ...) that the source noadagent bundle
// deliberately removed in R158.75. R160 re-synced the 5 runtime files from
// source, which means the package now carries a set of files that may be
// (a) dead code, or worse
// (b) still imported by something -> the member agent on a non-AD server would
//     pull in AD machinery (or a dependency the member package.json does not
//     declare, e.g. better-sqlite3 via src/local-queue.js).
//
// Two questions are answered here, per package:
//   R1  Do all RELATIVE imports resolve inside the package?  (a broken import
//       = ERR_MODULE_NOT_FOUND on the first import -> crash loop)
//   R2  Which files are REACHABLE from the entry point (agent.js)? Anything
//       unreachable is dead weight shipped to customers.
//
// Usage: node Server/scripts/audit/check-agent-import-graph.mjs [pkgDir ...]
// Exit:  0 = all good, 1 = broken import(s)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep, extname } from 'node:path';
import { builtinModules } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');

const DEFAULT_PACKAGES = ['ADAgent/agent', 'MemberAgent/agent'];

function listJs(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs)$/i.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// Static import / export-from / require / DYNAMIC import of a RELATIVE
// specifier.
//
// The dynamic-import alternative is not optional: the member agent loads
// './src/package-runner.js' through `import('...')` at runtime (agent.js:529).
// Without it the reachability walker reports that file as dead code, which is
// exactly the kind of false finding that makes a tool untrustworthy.
const RELATIVE_SPECIFIER =
  /(?:^|[\s;{}()=])(?:import|export)\s+(?:[\w*{}\s,$]*?\sfrom\s+)?['"](\.[^'"]+)['"]|(?:^|[^\w$.])require\s*\(\s*['"](\.[^'"]+)['"]\s*\)|(?:^|[^\w$.])import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// Strip JS comments BEFORE scanning for imports.
//
// R160 lesson (same shape as the R120 static-scan lesson): the first version
// of this checker reported "agent.js -> ./src/port-scanner.js is BROKEN", but
// that import is COMMENTED OUT (R158.0.1.9 removed port-scanner). A scanner
// that does not strip comments reports ghost findings and, worse, teaches the
// reader to ignore the tool. The stripper is string-aware so that a '//' inside
// a string literal (e.g. 'http://x') does not start a comment.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') state = 'code';
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
      out += c; i++; continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') state = 'code';
      out += c; i++; continue;
    }
  }
  return out;
}

function extractRelativeImports(source) {
  const code = stripComments(source);
  const specs = new Set();
  let m;
  RELATIVE_SPECIFIER.lastIndex = 0;
  while ((m = RELATIVE_SPECIFIER.exec(code)) !== null) {
    specs.add(m[1] ?? m[2] ?? m[3]);
  }
  return [...specs];
}

// BARE (non-relative) import specifiers: the third-party modules a file
// depends on. This is the ground truth for "which modules must be resolvable
// before the agent is allowed to start".
const BARE_SPECIFIER =
  /(?:^|[\s;{}()=])(?:import|export)\s+(?:[\w*{}\s,$]*?\sfrom\s+)?['"]([^.'"][^'"]*)['"]|(?:^|[^\w$.])require\s*\(\s*['"]([^.'"][^'"]*)['"]\s*\)|(?:^|[^\w$.])import\s*\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g;

function extractBareImports(source) {
  const code = stripComments(source);
  const specs = new Set();
  let m;
  BARE_SPECIFIER.lastIndex = 0;
  while ((m = BARE_SPECIFIER.exec(code)) !== null) {
    specs.add(m[1] ?? m[2] ?? m[3]);
  }
  return [...specs];
}

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [];
  if (extname(base)) candidates.push(base);
  else {
    candidates.push(base + '.js', base + '.cjs', base + '.mjs', join(base, 'index.js'));
  }
  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith(sep)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// analyzePackage — reusable by the drift detector (C7) and by the CLI below.
// ---------------------------------------------------------------------------
export function analyzePackage(pkgDir) {
  const files = listJs(pkgDir);

  // --- R1: resolvability ------------------------------------------------------
  const broken = [];
  const edges = new Map();
  const bareByFile = new Map();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const specs = extractRelativeImports(src);
    const resolvedEdges = [];
    for (const spec of specs) {
      const target = resolveSpecifier(f, spec);
      if (!target) {
        broken.push({
          from: relative(repoRoot, f).split(sep).join('/'),
          spec,
        });
      } else {
        resolvedEdges.push(target);
      }
    }
    edges.set(resolve(f), resolvedEdges);
    bareByFile.set(resolve(f), extractBareImports(src));
  }

  // --- R2: reachability from the entry point ----------------------------------
  const entry = resolve(pkgDir, 'agent.js');
  const entryFound = existsSync(entry);
  const reachable = new Set();
  if (entryFound) {
    const stack = [entry];
    while (stack.length) {
      const cur = stack.pop();
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const next of edges.get(cur) ?? []) {
        if (!reachable.has(next)) stack.push(next);
      }
    }
  }
  const unreachable = files.filter((f) => !reachable.has(resolve(f)));

  // --- R3: the third-party modules the RUNNING code actually needs -----------
  // Only files reachable from the entry point count: a module that only a dead
  // file imports cannot crash the service. node: builtins are excluded.
  const external = new Set();
  for (const f of reachable) {
    for (const spec of bareByFile.get(f) ?? []) {
      if (spec.startsWith('node:')) continue;
      if (builtinModules.includes(spec)) continue;
      external.add(spec);
    }
  }

  return {
    files,
    broken,
    reachable,
    unreachable,
    entryFound,
    external: [...external].sort(),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isCli = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const packages = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_PACKAGES;
  let failures = 0;

  for (const pkgRel of packages) {
    const pkgDir = resolve(repoRoot, pkgRel);
    if (!existsSync(pkgDir)) {
      console.log(`SKIP  ${pkgRel}: not found`);
      continue;
    }
    const { files, broken, reachable, unreachable, entryFound, external } = analyzePackage(pkgDir);

    console.log(`=== ${pkgRel} ===`);
    console.log(`  js files            : ${files.length}`);
    console.log(`  reachable from agent.js: ${reachable.size}`);
    console.log(`  unreachable (dead)  : ${unreachable.length}`);
    console.log(`  broken relative imports: ${broken.length}`);
    console.log(`  external modules required at runtime: ${external.join(', ') || '(none)'}`);
    for (const b of broken) {
      console.log(`    BROKEN  ${b.from}  ->  ${b.spec}`);
    }
    if (unreachable.length) {
      const shown = unreachable.map((f) => relative(pkgDir, f).split(sep).join('/'));
      console.log(`    unreachable: ${shown.join(', ')}`);
    }
    if (!entryFound) {
      console.log(`    agent.js ENTRY POINT NOT FOUND`);
      failures++;
    }
    if (broken.length) failures++;
  }

  process.exit(failures > 0 ? 1 : 0);
}
