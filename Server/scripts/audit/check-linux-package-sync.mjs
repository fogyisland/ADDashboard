#!/usr/bin/env node
// R161 — Linux deliverable (LinuxServer/) vs. Windows source tree (Server/)
// drift detector.
//
// WHY THIS EXISTS
// ---------------
// The Linux package is a HAND-COPY of the Windows source tree. The R160
// post-mortem on the green packages (ADAgent/ + MemberAgent/) proved what a
// hand-copy costs: every fix landed in the source tree silently stops reaching
// the artifact customers actually install, and because the copy is made by a
// human, the copy also picks up files the source never had (stale backups,
// leftover configs) and drops files the source has (the hand-copy's exclusion
// list is not a contract — it is a habit).
//
// LinuxServer/ was built the same way. Measured drift at the start of R161
// (before this detector existed):
//
//   · center/scripts/ carried 20 one-off debug scripts the source does not
//     have, and was MISSING 3 scripts the source has (audit-config-seed.mjs,
//     migrate-config-seed.mjs, audit/run-all-dimensions.mjs).
//   · center/web/vitest.config.js existed only in the Linux copy (a 2026-09-05
//     snapshot of a config that references tests/** — a directory the package
//     does not ship).
//   · center/package-lock.json existed only in the Linux copy, and it was
//     STALE: 419 packages, no @modelcontextprotocol/sdk, no zod. Running
//     `npm ci` inside center/ (the natural thing to do) installs a tree the
//     MCP routes cannot import from.
//   · .env.example existed only in the Linux copy, advertising credential
//     keys the application never reads (the app reads NO env vars for
//     DB/JWT/license — configuration lives in center/appsettings.json).
//
// None of that was visible: the copy had no detector, and "the package is
// stale" is invisible until an operator hits a missing-module error on a
// target machine.
//
// WHAT THIS CHECKS
// ----------------
//   C1  payload drift   — src / web / dist / scripts / db / built-in package
//                          payloads must be byte-identical (sha256) between
//                          the source tree and the Linux package, except for
//                          an explicit, reasoned allowlist.
//   C2  required paths  — the package must actually contain what the runtime
//                          needs (server.js, dist/index.html, the baseline
//                          SQL, the lifecycle scripts, ...).
//   C3  shell hygiene   — every .sh must be LF-only, BOM-less, start with
//                          `#!/usr/bin/env bash` and set `set -euo pipefail`.
//                          A BOM breaks the shebang ("command not found") and
//                          a CRLF turns `then` into `then\r` — both are
//                          silent, total failures on the target machine.
//   C4  footguns        — files that must NOT ship (see C4 for the list);
//                          each one is a documented production incident.
//   C5  lock coherence  — the root package.json workspaces and the root
//                          package-lock.json must agree, or `npm ci` fails
//                          with EUSAGE / installs the wrong tree.
//   C6  declared deps   — every bare import in center/src must be declared in
//                          center/package.json `dependencies`. An undeclared
//                          import is a missing module at runtime (this is how
//                          zod reached production: src/routes/mcp.js imported
//                          it while only the transitive dependency of the MCP
//                          SDK provided it).
//   C7  pm2 invariant   — ecosystem.config.cjs must keep the crash-loop
//                          invariant documented in that file (see C7).
//   C8  built-in pkgs   — every package the seeder registers must be present
//                          in the package at the exact version, with its
//                          manifest.json.
//   C9  no credentials  — the package must not contain a filled
//                          appsettings.json, an init marker .env, or a
//                          password-bearing .env.example.
//
// Usage:  node Server/scripts/audit/check-linux-package-sync.mjs
//         node Server/scripts/audit/check-linux-package-sync.mjs --json
// Exit:   0 = no error-level finding, 1 = at least one error-level finding.
// Output: Server/scripts/audit/linux-package-sync.json (machine-readable)

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonOnly = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Locate the repo root: the deepest ancestor that contains BOTH the source
// tree (Server/) and the Linux deliverable (LinuxServer/). Taking the deepest
// ancestor keeps a mirror checkout working (same convention as
// check-green-package-drift.mjs).
// ---------------------------------------------------------------------------
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'Server')) && existsSync(join(dir, 'LinuxServer'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(__dirname);
if (!repoRoot) {
  console.error('ERR: could not locate repo root (need a dir containing Server/ and LinuxServer/)');
  process.exit(2);
}

const SOURCE = join(repoRoot, 'Server');
const LINUX = join(repoRoot, 'LinuxServer');

const findings = [];
const notes = [];

function addFinding(check, severity, message, detail) {
  findings.push({ check, severity, message, detail: detail ?? null });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SKIP_DEFAULT = new Set(['node_modules', '.git', 'data', 'logs']);

function listFiles(root, skipDirs) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function toPosix(relPath) {
  return relPath.split(sep).join('/');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// C1 — payload drift
//
// The trees that must be byte-identical. `skip` prunes runtime/output
// directories that are not part of the payload; `center/data/packages` is a
// pair of its own because the built-in package payloads live there and a
// version bump in the source must reach the Linux package too (a stale
// built-in package means the Linux agents run an old collect script).
// ---------------------------------------------------------------------------
const TREE_PAIRS = [
  { id: 'center/src', from: join(SOURCE, 'center', 'src'), to: join(LINUX, 'center', 'src'), skip: SKIP_DEFAULT },
  { id: 'center/web', from: join(SOURCE, 'center', 'web'), to: join(LINUX, 'center', 'web'), skip: SKIP_DEFAULT },
  { id: 'center/dist', from: join(SOURCE, 'center', 'dist'), to: join(LINUX, 'center', 'dist'), skip: SKIP_DEFAULT },
  { id: 'center/scripts', from: join(SOURCE, 'center', 'scripts'), to: join(LINUX, 'center', 'scripts'), skip: SKIP_DEFAULT },
  { id: 'db', from: join(SOURCE, 'db'), to: join(LINUX, 'db'), skip: new Set(['node_modules', '.git']) },
  {
    id: 'center/data/packages',
    from: join(SOURCE, 'center', 'data', 'packages'),
    to: join(LINUX, 'center', 'data', 'packages'),
    skip: new Set(['node_modules', '.git']),
  },
];

// Intentional differences. Every entry MUST carry a reason — an unexplained
// allowlist entry is exactly how a hand-copy rots.
const ALLOWLIST = [
  {
    tree: 'center/scripts',
    side: 'source-only',
    path: 'publish-sync.mjs',
    reason: 'Windows-only publish mirror tool: it rewrites hardcoded D:/dashboard -> D:/Implementation/Server paths. On a Linux host it would publish to the wrong place.',
  },
  {
    tree: 'center/scripts',
    side: 'source-only',
    path: '_backup_pre_diag_cleanup_20261015_203424',
    dirPrefix: true,
    reason: 'Stale backup directory that only exists in the source tree; not part of the product.',
  },
  {
    tree: 'center/scripts',
    side: 'source-only',
    path: 'audit',
    dirPrefix: true,
    reason:
      '源树开发工具, 不是产品的一部分。三个脚本各自依赖一棵**不随交付包发布**的树: ' +
      'static-scan.mjs 扫 agent/ (agent 是另一个交付物: 绿色包 ADAgent/MemberAgent), ' +
      'diff-mirrors.mjs 比 publish/ (发布镜像树, 只在源树里), ' +
      'run-all-dimensions.mjs 跑 center/tests/ (install-center.ps1 / upgrade-center.ps1 的 ' +
      '-Exclude 里明确排除了 tests)。⇒ 在目标机上它们要么报一堆假阳性, 要么直接失败 —— ' +
      '一个永远误报的审计脚本比没有更糟, 它训练操作员忽略审计输出。',
  },
];

function allowlistMatch(treeId, side, relPath) {
  for (const entry of ALLOWLIST) {
    if (entry.tree !== treeId || entry.side !== side) continue;
    if (entry.dirPrefix) {
      if (relPath === entry.path || relPath.startsWith(`${entry.path}/`)) return entry;
    } else if (relPath === entry.path) {
      return entry;
    }
  }
  return null;
}

function checkPayloadDrift() {
  for (const pair of TREE_PAIRS) {
    if (!existsSync(pair.from)) {
      addFinding('C1-payload', 'error', `source tree is missing: ${toPosix(relative(repoRoot, pair.from))}`);
      continue;
    }
    if (!existsSync(pair.to)) {
      addFinding('C1-payload', 'error', `the Linux package is missing: ${toPosix(relative(repoRoot, pair.to))}`);
      continue;
    }
    const sourceFiles = listFiles(pair.from, pair.skip);
    const linuxFiles = new Map(
      listFiles(pair.to, pair.skip).map((f) => [toPosix(relative(pair.to, f)), f]),
    );

    for (const sourceFile of sourceFiles) {
      const relPath = toPosix(relative(pair.from, sourceFile));
      const linuxFile = linuxFiles.get(relPath);
      if (!linuxFile) {
        const allowed = allowlistMatch(pair.id, 'source-only', relPath);
        if (allowed) {
          notes.push(`${pair.id}: ${relPath} is intentionally source-only — ${allowed.reason}`);
          continue;
        }
        addFinding('C1-payload', 'error',
          `source file is missing from the Linux package: ${pair.id}/${relPath}`,
          pair.id);
        continue;
      }
      if (sha256(sourceFile) !== sha256(linuxFile)) {
        addFinding('C1-payload', 'error',
          `the Linux package copy differs from the source: ${pair.id}/${relPath}`,
          pair.id);
      }
    }

    for (const relPath of linuxFiles.keys()) {
      // R161.3 — source-only 是**强制**语义, 不是"宽容地忽略"。
      //   登记为 source-only 的东西如果又出现在交付包里, 说明有人把它抄回去了
      //   (或者根本忘了删)。那正是这个检查器存在的意义 —— 交付包不该带着
      //   在目标机上必然误报的脚本。所以这里报错, 而不是 C1 的默认路径
      //   (两边都有 + 字节相同 ⇒ 一片绿)。
      const declaredSourceOnly = allowlistMatch(pair.id, 'source-only', relPath);
      if (declaredSourceOnly) {
        addFinding('C1-payload', 'error',
          `the Linux package carries a file that is declared source-only: ${pair.id}/${relPath}`,
          declaredSourceOnly.reason);
        continue;
      }
      if (existsSync(join(pair.from, relPath))) continue;
      const allowed = allowlistMatch(pair.id, 'linux-only', relPath);
      if (allowed) {
        notes.push(`${pair.id}: ${relPath} is intentionally Linux-only — ${allowed.reason}`);
        continue;
      }
      addFinding('C1-payload', 'error',
        `the Linux package carries a file the source tree does not have: ${pair.id}/${relPath}`,
        pair.id);
    }

    notes.push(`${pair.id}: ${sourceFiles.length} source file(s) compared against the Linux package`);
  }
}

// ---------------------------------------------------------------------------
// C2 — required paths
//
// Everything the runtime or the documented install flow needs. A missing
// entry here is a broken package, not a style issue.
// ---------------------------------------------------------------------------
const REQUIRED_PATHS = [
  { rel: join('package.json'), why: 'npm workspaces root — `npm ci --omit=dev` runs here' },
  { rel: join('package-lock.json'), why: 'the authoritative lock (the root one is a workspaces lock)' },
  { rel: join('ecosystem.config.cjs'), why: 'PM2 process definition (宝塔 also reads it)' },
  { rel: join('build-manifest.json'), why: 'read by center/server.js for the version fingerprint' },
  { rel: join('center', 'server.js'), why: 'the process entry point' },
  { rel: join('center', 'package.json'), why: 'the center workspace manifest' },
  { rel: join('center', 'dist', 'index.html'), why: 'the pre-built frontend (the server never builds)' },
  { rel: join('center', 'appsettings.json.example'), why: 'the config template shown to the operator' },
  { rel: join('center', 'src'), why: 'the backend' },
  { rel: join('center', 'web'), why: 'the frontend sources (for a local rebuild)' },
  { rel: join('center', 'logs'), why: 'the runtime log directory (pino-roll writes here)' },
  { rel: join('center', 'logs', 'APP'), why: 'per-module log directory' },
  { rel: join('center', 'logs', 'FEATURE'), why: 'per-feature log directory' },
  { rel: join('center', 'data', 'packages'), why: 'the built-in package payloads' },
  { rel: join('db', 'migrations', 'mysql', '1.0.0-baseline.sql'), why: 'the MySQL baseline (the init wizard applies it)' },
  { rel: join('db', 'migrations', 'mssql', '1.0.0-baseline.sql'), why: 'the MSSQL baseline (the init wizard applies it)' },
  { rel: join('db', 'migrations', '1.0.0-baseline.js'), why: 'the R66 data-migration sidecar (schema-applier backfillMigrations)' },
  { rel: join('scripts', 'common.sh'), why: 'the shared shell library' },
  { rel: join('scripts', 'install.sh'), why: 'the install entry point' },
  { rel: join('scripts', 'start.sh'), why: 'the start entry point' },
  { rel: join('scripts', 'stop.sh'), why: 'the stop entry point' },
  { rel: join('scripts', 'verify.sh'), why: 'the self-check entry point' },
  { rel: join('scripts', 'uninstall.sh'), why: 'the uninstall entry point' },
  { rel: join('scripts', 'tests', 'test-guard.sh'), why: 'the executable self-test for the delete guard' },
];

function checkRequiredPaths() {
  for (const item of REQUIRED_PATHS) {
    const full = join(LINUX, item.rel);
    if (!existsSync(full)) {
      addFinding('C2-required', 'error',
        `the Linux package is missing ${toPosix(item.rel)} — ${item.why}`, item.rel);
    }
  }
  notes.push(`C2: ${REQUIRED_PATHS.length} required path(s) checked`);
}

// ---------------------------------------------------------------------------
// C3 — shell script hygiene
//
//   · a UTF-8 BOM breaks the shebang: the kernel does not recognise
//     "\xEF\xBB\xBF#!/usr/bin/env bash" => "command not found" on EVERY call.
//   · CRLF breaks bash: `if [ "$x" = "y" ]; then` becomes `... then\r`.
//   · no `set -e` means a failed step is ignored and the script reports
//     success while the install is half-done.
// ---------------------------------------------------------------------------
function checkShellHygiene() {
  const scripts = listFiles(join(LINUX, 'scripts'), new Set(['node_modules', '.git']));
  const shellFiles = scripts.filter((f) => f.endsWith('.sh'));
  if (shellFiles.length === 0) {
    addFinding('C3-shell', 'error', 'the Linux package has no .sh scripts under scripts/');
    return;
  }
  // A sourced library behaves differently from an entry point:
  //   · it must NOT enable "set -e" — that would change the CALLER's error
  //     semantics. scripts/tests/test-guard.sh deliberately runs WITHOUT -e
  //     (it counts the failures of the guard calls), and a library that
  //     switched -e on would abort the self-test at the first rejected case.
  //   · it therefore does not need "set -u"/"pipefail" either — the entry
  //     points that source it set those.
  const isSourcedLibrary = (file) => {
    const base = file.split(sep).pop();
    return shellFiles.some((other) => {
      if (other === file) return false;
      const text = readFileSync(other, 'utf8');
      return new RegExp(`^\\s*(\\.|source)\\s+[^\\n]*${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(text);
    });
  };

  for (const file of shellFiles) {
    const rel = toPosix(relative(repoRoot, file));
    const buffer = readFileSync(file);
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      addFinding('C3-shell', 'error', `${rel} carries a UTF-8 BOM — the shebang stops being the first line (bash: command not found)`, rel);
    }
    const text = buffer.toString('utf8');
    if (text.includes('\r')) {
      addFinding('C3-shell', 'error', `${rel} contains CR characters (CRLF line endings) — bash mis-parses the conditionals`, rel);
    }
    if (!text.startsWith('#!/usr/bin/env bash\n')) {
      addFinding('C3-shell', 'error', `${rel} does not start with "#!/usr/bin/env bash" on line 1`, rel);
    }
    // "set -euo pipefail" — the flags and pipefail share one line.
    const setLine = text.split('\n').map((l) => l.trim()).find((l) => /^set\s+-[a-zA-Z]+\s/.test(l));
    const flags = setLine ? (setLine.match(/^set\s+-([a-zA-Z]+)/) || [])[1] || '' : '';
    const library = isSourcedLibrary(file);
    if (library) {
      if (flags.includes('e')) {
        addFinding('C3-shell', 'error',
          `${rel} is a sourced library but enables "set -e" — that changes the CALLER's error semantics (the guard self-test must survive a failing command)`,
          rel);
      }
      continue;
    }
    if (!flags.includes('u') || !setLine || !setLine.includes('pipefail')) {
      addFinding('C3-shell', 'error',
        `${rel} does not enable "set -u" + "pipefail" (found: ${setLine || 'no set line'}) — a failed step would be ignored`,
        rel);
    }
  }
  notes.push(`C3: ${shellFiles.length} shell script(s) checked for BOM / CRLF / shebang / set flags`);
}

// ---------------------------------------------------------------------------
// C4 — footguns: files that must NOT ship
//
// Each entry is a documented failure mode, not a style preference.
// ---------------------------------------------------------------------------
const FORBIDDEN_PATHS = [
  {
    rel: join('.env.example'),
    why: 'phantom credential template: the application reads NO env vars for DB/JWT/license. Advertising DB_PWD keys that nothing reads invites operators to believe a .env file configures the server (it does not — only center/appsettings.json does).',
  },
  {
    rel: join('center', 'package-lock.json'),
    why: 'a stale nested lock (419 packages, no @modelcontextprotocol/sdk, no zod): running `npm ci` inside center/ — the natural thing to do — installs a tree the MCP routes cannot import from. The root lock is the authoritative one.',
  },
  {
    rel: join('center', 'db'),
    why: 'the migration engine only scans <repoRoot>/db/migrations/{mysql,mssql}/; a copy under center/ is never read and misleads whoever goes looking for the schema.',
  },
  {
    rel: join('center', '.env'),
    why: 'this is the init marker (ADDASHBOARD_INITIALIZED). Shipping it makes the server refuse to start ("init marker present but config missing") — the operator can never run the /init wizard.',
  },
  {
    rel: join('center', 'appsettings.json'),
    why: 'this file holds the DB password, jwtSecret and agentToken once the wizard has run. It must never be part of a deliverable.',
  },
  {
    rel: join('center', '.install-hash'),
    why: 'the Windows install-hash marker: it would make the Windows installer think the center is already installed and skip the dependency install.',
  },
];

function checkForbiddenPaths() {
  for (const item of FORBIDDEN_PATHS) {
    const full = join(LINUX, item.rel);
    if (existsSync(full)) {
      addFinding('C4-footgun', 'error',
        `the Linux package must not contain ${toPosix(item.rel)} — ${item.why}`, item.rel);
    }
  }
  // The example config must stay a template.
  const examplePath = join(LINUX, 'center', 'appsettings.json.example');
  if (existsSync(examplePath)) {
    const text = readFileSync(examplePath, 'utf8');
    if (!text.includes('REPLACE_WITH_')) {
      addFinding('C4-footgun', 'error',
        'center/appsettings.json.example no longer contains REPLACE_WITH_* placeholders — a real credential may have been pasted into the template',
        'center/appsettings.json.example');
    }
  }
  notes.push(`C4: ${FORBIDDEN_PATHS.length} forbidden path(s) checked`);
}

// ---------------------------------------------------------------------------
// C5 — lock coherence
//
// `npm ci` refuses (EUSAGE) when the manifest and the lock disagree, and an
// offline target machine cannot re-resolve the tree. The workspaces list in
// the lock's root entry must equal the manifest's.
// ---------------------------------------------------------------------------
function checkLockCoherence() {
  const manifestPath = join(LINUX, 'package.json');
  const lockPath = join(LINUX, 'package-lock.json');
  const manifest = readJsonSafe(manifestPath);
  const lock = readJsonSafe(lockPath);
  if (!manifest) {
    addFinding('C5-lock', 'error', 'LinuxServer/package.json is missing or is not valid JSON');
    return;
  }
  if (!lock) {
    addFinding('C5-lock', 'error', 'LinuxServer/package-lock.json is missing or is not valid JSON — `npm ci` cannot run without it');
    return;
  }
  const manifestWs = (manifest.workspaces || []).slice().sort();
  const lockWs = ((lock.packages && lock.packages[''] && lock.packages[''].workspaces) || []).slice().sort();
  if (JSON.stringify(manifestWs) !== JSON.stringify(lockWs)) {
    addFinding('C5-lock', 'error',
      `workspaces disagree: package.json says [${manifestWs.join(', ')}], package-lock.json says [${lockWs.join(', ')}] — re-run "npm install --package-lock-only" in the package root`,
      'package-lock.json');
  }
  for (const ws of manifestWs) {
    if (!existsSync(join(LINUX, ws, 'package.json'))) {
      addFinding('C5-lock', 'error',
        `workspace "${ws}" is declared but ${ws}/package.json does not exist — npm ci installs a broken tree`,
        'package.json');
    }
  }
  if (!lock.packages || !lock.packages['node_modules/zod']) {
    addFinding('C5-lock', 'error',
      'the lock has no node_modules/zod entry — the MCP routes (src/routes/mcp.js, mcp-write.js) import zod and would die at runtime',
      'package-lock.json');
  }
  notes.push(`C5: workspaces [${manifestWs.join(', ')}] checked against the lock`);
}

// ---------------------------------------------------------------------------
// C6 — declared dependencies
//
// A bare import in center/src that is not declared in center/package.json
// `dependencies` is a module the target machine never installs. This is the
// zod incident: src/routes/mcp.js imported zod, package.json did not declare
// it, and it only worked because the MCP SDK happened to depend on it — a
// transitive dependency that can disappear on any SDK upgrade.
//
// devDependencies are NOT acceptable either: the install is
// `npm ci --omit=dev`, so a devDependency is simply absent on the target.
// ---------------------------------------------------------------------------
function packageNameOf(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.slice(0, 2).join('/');
  }
  return spec.split('/')[0];
}

function collectBareImports(root) {
  const found = new Map();
  const files = listFiles(root, SKIP_DEFAULT).filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const importRe = /(?:^|\n)\s*(?:import\s+[^;]*?from\s*|import\s*|export\s+[^;]*?from\s*)["']([^"']+)["']/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let match;
    while ((match = importRe.exec(text)) !== null) {
      const spec = match[1];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const name = packageNameOf(spec);
      if (!found.has(name)) found.set(name, new Set());
      found.get(name).add(toPosix(relative(root, file)));
    }
  }
  return found;
}

function checkDeclaredDependencies() {
  const manifestPath = join(LINUX, 'center', 'package.json');
  const manifest = readJsonSafe(manifestPath);
  if (!manifest) {
    addFinding('C6-deps', 'error', 'LinuxServer/center/package.json is missing or is not valid JSON');
    return;
  }
  const deps = new Set(Object.keys(manifest.dependencies || {}));
  const devDeps = new Set(Object.keys(manifest.devDependencies || {}));
  const builtins = new Set(builtinModules);
  const imports = collectBareImports(join(LINUX, 'center', 'src'));
  for (const [name, files] of [...imports.entries()].sort()) {
    if (builtins.has(name)) continue;
    if (deps.has(name)) continue;
    const firstFile = [...files][0];
    if (devDeps.has(name)) {
      addFinding('C6-deps', 'error',
        `center/src imports "${name}" but it is only a devDependency — the target installs with "npm ci --omit=dev", so the module is absent at runtime (first importer: ${firstFile})`,
        'center/package.json');
    } else {
      addFinding('C6-deps', 'error',
        `center/src imports "${name}" but center/package.json does not declare it — the target never installs it (first importer: ${firstFile})`,
        'center/package.json');
    }
  }
  notes.push(`C6: ${imports.size} imported package name(s) checked against center/package.json dependencies`);
}

// ---------------------------------------------------------------------------
// C7 — PM2 crash-loop invariant
//
// pm2 7.1.1 marks a restart "unstable" only when the child lived LESS than
// min_uptime (default 1000 ms) AND the process was created less than
// min_uptime x max_restarts ago. Once unstable_restarts reaches max_restarts,
// pm2 sets the status to "errored" and NEVER restarts again.
//
// With restart_delay (5000) > min_uptime (1000) the 10-second window admits
// at most 2 unstable restarts, so max_restarts = 10 is unreachable => a
// crashing process restarts forever, which is exactly what the Windows side
// gets from NSSM's "AppExit Default Restart". Break the inequality and the
// service dies permanently instead of crash-looping.
// ---------------------------------------------------------------------------
function checkPm2Invariant() {
  const configPath = join(LINUX, 'ecosystem.config.cjs');
  if (!existsSync(configPath)) {
    addFinding('C7-pm2', 'error', 'LinuxServer/ecosystem.config.cjs is missing');
    return;
  }
  let config;
  try {
    const require = createRequire(import.meta.url);
    config = require(configPath);
  } catch (err) {
    addFinding('C7-pm2', 'error', `ecosystem.config.cjs does not load: ${err.message}`);
    return;
  }
  const apps = config && config.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    addFinding('C7-pm2', 'error', 'ecosystem.config.cjs exports no apps array');
    return;
  }
  for (const app of apps) {
    const label = app.name || '<unnamed>';
    if (!app.name) {
      addFinding('C7-pm2', 'error', 'a PM2 app has no name — the lifecycle scripts cannot address it');
    }
    if (!app.cwd || !toPosix(app.cwd).endsWith('center')) {
      addFinding('C7-pm2', 'error',
        `${label}: cwd must point at the center directory — center/server.js derives data/packages and the static dir from process.cwd() (got: ${app.cwd})`,
        'ecosystem.config.cjs');
    }
    if (!app.script || !toPosix(app.script).endsWith('server.js')) {
      addFinding('C7-pm2', 'error', `${label}: script must be the center server.js (got: ${app.script})`, 'ecosystem.config.cjs');
    }
    const minUptime = app.min_uptime === undefined ? 1000 : app.min_uptime;
    const restartDelay = app.restart_delay;
    if (typeof restartDelay !== 'number') {
      addFinding('C7-pm2', 'error', `${label}: restart_delay must be a number (got: ${restartDelay})`, 'ecosystem.config.cjs');
    } else if (restartDelay <= minUptime) {
      addFinding('C7-pm2', 'error',
        `${label}: restart_delay (${restartDelay}) must be GREATER than min_uptime (${minUptime}) — otherwise the max_restarts threshold becomes reachable and pm2 gives up on the process forever`,
        'ecosystem.config.cjs');
    }
    if (app.max_restarts === 0) {
      addFinding('C7-pm2', 'error',
        `${label}: max_restarts = 0 is NOT "unlimited" (0 >= 0 is always true) — pm2 marks the process errored on the FIRST exit and never restarts it`,
        'ecosystem.config.cjs');
    }
    if (app.max_restarts === Infinity || app.max_restarts === null) {
      addFinding('C7-pm2', 'error',
        `${label}: max_restarts must be a finite number (Infinity is serialized as null into ~/.pm2/dump.pm2)`,
        'ecosystem.config.cjs');
    }
    if (app.autorestart === false) {
      addFinding('C7-pm2', 'warn', `${label}: autorestart is false — a crash leaves the service down (the Windows NSSM side always restarts)`, 'ecosystem.config.cjs');
    }
    const env = app.env || {};
    for (const forbidden of ['DB_PASSWORD', 'DB_PWD', 'JWT_SECRET', 'AGENT_TOKEN']) {
      if (Object.prototype.hasOwnProperty.call(env, forbidden)) {
        addFinding('C7-pm2', 'error', `${label}: env carries ${forbidden} — credentials belong in center/appsettings.json only`, 'ecosystem.config.cjs');
      }
    }
  }
  notes.push(`C7: ${apps.length} PM2 app definition(s) checked against the crash-loop invariant`);
}

// ---------------------------------------------------------------------------
// C8 — built-in packages
//
// The seeder registers BUILTIN_PACKAGES on every normal-mode start. If the
// package tree does not carry <name>/<version>/manifest.json for one of them,
// that package is silently skipped (the seeder logs a warn) and the agents
// never receive it.
//
// R161.5 (2026-10-26) — 扩展: 光"文件在不在"不够, 还要校验**身份**。
//   操作员报的三条问题里有两条是同一个家族:
//     · manifest.name 写成连字符 (ad-os-baseline) 而目录名/DB 名是下划线
//       (ad_os_baseline) ⇒ validateManifest 抛 INVALID_MANIFEST ⇒ seeder
//       在 installScript 之前就把整包跳过 ⇒ pkg_* schema 从未创建 ⇒
//       GET /api/os-baseline 500。
//     · manifest 里声明的 collect.ps1 / migrations/*.sql 在磁盘上缺失
//       ⇒ 同样整包跳过 (readFileSync ENOENT)。
//   这两类缺陷在"文件存在"这一层完全看不出来 —— 目录里确实有 manifest.json。
//   ⇒ C8 现在校验: name / version / schemaName / script 存在 / migrations 存在。
// ---------------------------------------------------------------------------
async function checkBuiltinPackages() {
  const modulePath = join(SOURCE, 'center', 'src', 'services', 'builtin-packages.js');
  if (!existsSync(modulePath)) {
    addFinding('C8-builtin', 'warn', 'cannot read BUILTIN_PACKAGES from the source tree — the module is missing');
    return;
  }
  let builtins;
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    builtins = mod.BUILTIN_PACKAGES;
  } catch (err) {
    addFinding('C8-builtin', 'warn', `cannot import BUILTIN_PACKAGES: ${err.message}`);
    return;
  }
  if (!Array.isArray(builtins) || builtins.length === 0) {
    addFinding('C8-builtin', 'warn', 'BUILTIN_PACKAGES is empty or not an array');
    return;
  }
  const packagesRoot = join(LINUX, 'center', 'data', 'packages');
  let identityChecked = 0;
  for (const pkg of builtins) {
    const pkgDir = join(packagesRoot, pkg.name, pkg.version);
    const manifestPath = join(pkgDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      addFinding('C8-builtin', 'error',
        `built-in package ${pkg.name} ${pkg.version} is missing from the Linux package — the seeder will skip it and the agents never receive it`,
        `center/data/packages/${pkg.name}/${pkg.version}/manifest.json`);
      continue;
    }

    const manifest = readJsonSafe(manifestPath);
    if (!manifest || typeof manifest !== 'object') {
      addFinding('C8-builtin', 'error',
        `built-in package ${pkg.name} ${pkg.version} has an unreadable manifest.json — the seeder will skip it`,
        `center/data/packages/${pkg.name}/${pkg.version}/manifest.json`);
      continue;
    }
    identityChecked += 1;

    // ① manifest.name 必须是下划线形式, 与目录名/DB 名一致。
    if (manifest.name !== pkg.name) {
      addFinding('C8-builtin', 'error',
        `built-in package ${pkg.name} ${pkg.version} has manifest.name "${manifest.name}" — it must equal the directory name "${pkg.name}". ` +
        'A mismatch makes validateManifest throw INVALID_MANIFEST, which skips the whole package: the schema is never created and the API returns 500.',
        `center/data/packages/${pkg.name}/${pkg.version}/manifest.json`);
    }

    // ② manifest.version 必须等于声明版本。
    if (manifest.version !== pkg.version) {
      addFinding('C8-builtin', 'error',
        `built-in package ${pkg.name} ${pkg.version} has manifest.version "${manifest.version}" — it must equal the declared version "${pkg.version}"`,
        `center/data/packages/${pkg.name}/${pkg.version}/manifest.json`);
    }

    // ③ schemaName —— 只在 manifest **有** database 段时校验。
    //   注意: 有 6 个包走"公共表 pattern" (R110.A architectural pivot):
    //   manifest **故意不带** database 块 —— 数据落中心端公共表
    //   (ad_admin_members / ad_member_os_baseline 等), 不建 pkg_* schema。
    //   对这类包, "没有 schemaName" 是设计, 不是缺陷。
    //   对有 database 段的包, schemaName 就是实际的 MySQL 库名, 必须自洽。
    if (manifest.database) {
      const expectedSchema = `pkg_${pkg.name}`;
      const actualSchema = manifest.database.schemaName;
      if (actualSchema !== expectedSchema) {
        addFinding('C8-builtin', 'error',
          `built-in package ${pkg.name} ${pkg.version} has database.schemaName "${actualSchema}" — it must be "${expectedSchema}"`,
          `center/data/packages/${pkg.name}/${pkg.version}/manifest.json`);
      }
    }

    // ④ manifest 里点名的脚本必须在磁盘上存在。
    const scriptName = manifest.agent && manifest.agent.script;
    if (scriptName) {
      const scriptPath = join(pkgDir, scriptName);
      if (!existsSync(scriptPath)) {
        addFinding('C8-builtin', 'error',
          `built-in package ${pkg.name} ${pkg.version} declares agent.script "${scriptName}" but the file is missing — the seeder skips the whole package`,
          `center/data/packages/${pkg.name}/${pkg.version}/${scriptName}`);
      }
    }

    // ⑤ manifest 里点名的迁移文件必须在磁盘上存在。
    //   (ad_os_baseline 1.0.8 就是这么翻车的: manifest 声明 001/002/003,
    //    磁盘上只有 004 ⇒ 缺的那两张表从来没建出来。)
    const migrations = (manifest.database && manifest.database.migrations) || [];
    for (const migration of migrations) {
      const migrationPath = join(pkgDir, migration);
      if (!existsSync(migrationPath)) {
        addFinding('C8-builtin', 'error',
          `built-in package ${pkg.name} ${pkg.version} declares migration "${migration}" but the file is missing — the package schema is never created`,
          `center/data/packages/${pkg.name}/${pkg.version}/${migration}`);
      }
    }
  }
  notes.push(`C8: ${builtins.length} built-in package(s) checked in center/data/packages, ` +
    `${identityChecked} manifest identity/migration verified`);
}

// ---------------------------------------------------------------------------
// C9 — no credentials in the deliverable
//
// The configuration lives in center/appsettings.json, written by the /init
// wizard on the target machine. The package itself must carry no secret.
// ---------------------------------------------------------------------------
function checkNoCredentials() {
  const pkgRoot = join(LINUX, 'package.json');
  const manifest = readJsonSafe(pkgRoot);
  const ecoPath = join(LINUX, 'ecosystem.config.cjs');
  if (manifest && typeof manifest === 'object') {
    const serialized = JSON.stringify(manifest);
    if (/"(password|passwd|pwd|secret|agentToken|jwtSecret)"\s*:\s*"[^"]{4,}"/i.test(serialized)) {
      addFinding('C9-secrets', 'error', 'the root package.json appears to carry a credential value', 'package.json');
    }
  }
  if (existsSync(ecoPath)) {
    const text = readFileSync(ecoPath, 'utf8');
    const match = text.match(/(?:password|passwd|pwd|secret|agentToken|jwtSecret)\s*[:=]\s*['"][^'"]{4,}['"]/i);
    if (match) {
      addFinding('C9-secrets', 'error',
        `ecosystem.config.cjs appears to carry a credential value (matched: ${match[0].split(':')[0].trim()})`,
        'ecosystem.config.cjs');
    }
  }
  notes.push('C9: no credential value found in the package manifests');
}

// ---------------------------------------------------------------------------
// C10 — 内置包源只允许有一份 (center/web/data 是无消费者的重复副本)
//
// center/data/packages 是内置包源的唯一真相: server.js 的
// builtinSourceCandidates = [publish/system/center/data/packages,
// __dirname/data/packages] —— 运行时读的就是这一份 (或者说它的交付副本)。
//
// center/web/data/** 曾经存在过**第二份**内置包副本
// (2026-10-25 13:29 一次批量拷贝留下的: 14 个包, 其中 4 个的
// manifest.name 还是连字符坏名, 另有 2 个包停在旧版本号)。它**没有任何
// 消费者**:
//   · vite 只打包 web/src (build.outDir = '../dist') ⇒ web/data 不进产物
//   · publish-sync.mjs 的 EXCLUDE_DIR 排除 data ⇒ 不进发布镜像
//   · ship-publish-to-prod.ps1 的 $alwaysXD 排除 data ⇒ 不进生产机
//   · 本检查器的 SKIP_DEFAULT 也排除 data ⇒ 漂移检测看不见它
// ⇒ 结果是: 这份副本既发不出去、也读不到, 只会**静默漂移**;
//   而它正是 R161.5「seeds 的包不对」那族缺陷的第二份藏身处 ——
//   谁按目录名去找 manifest.json, 找到的可能是这份坏的。
//
// ⇒ 断言两棵树里都没有 center/web/data。
// ---------------------------------------------------------------------------
function checkStrayPackageSources() {
  const targets = [
    { root: SOURCE, label: 'source tree' },
    { root: LINUX, label: 'linux package' }
  ];
  let clean = 0;
  for (const { root, label } of targets) {
    const stray = join(root, 'center', 'web', 'data');
    if (!existsSync(stray)) {
      clean += 1;
      continue;
    }
    // 数一下里面有多少 manifest —— 报告里要告诉操作员"藏了多少个坏包"。
    let manifestCount = 0;
    const pkgRoot = join(stray, 'packages');
    if (existsSync(pkgRoot)) {
      for (const pkg of readdirSync(pkgRoot, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        for (const ver of readdirSync(join(pkgRoot, pkg.name), { withFileTypes: true })) {
          if (ver.isDirectory() && existsSync(join(pkgRoot, pkg.name, ver.name, 'manifest.json'))) {
            manifestCount += 1;
          }
        }
      }
    }
    addFinding('C10-stray-source', 'error',
      `the ${label} carries a second built-in package tree at center/web/data ` +
      `(${manifestCount} manifest(s)). It has no consumer (vite only bundles web/src, ` +
      'publish-sync and ship-publish-to-prod both exclude data), so it only drifts ' +
      'silently — and it is a second hiding place for the R161.5 class of defects ' +
      '(manifest.name with hyphens, stale version numbers). center/data/packages is ' +
      'the only real source.',
      'center/web/data');
  }
  notes.push(`C10: ${clean}/${targets.length} tree(s) carry exactly one built-in package source (center/data/packages)`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
checkPayloadDrift();
checkRequiredPaths();
checkShellHygiene();
checkForbiddenPaths();
checkLockCoherence();
checkDeclaredDependencies();
checkPm2Invariant();
await checkBuiltinPackages();
checkNoCredentials();
checkStrayPackageSources();

const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  summary: { errors: errors.length, warnings: warns.length, notes: notes.length },
  allowlist: ALLOWLIST,
  findings,
  notes,
};

const outFile = join(__dirname, 'linux-package-sync.json');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (!jsonOnly) {
  console.log('=== linux package sync check ===');
  console.log(`repo root: ${repoRoot}`);
  for (const f of findings) {
    const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`  ${tag} [${f.check}] ${f.message}`);
  }
  for (const n of notes) console.log(`  note  ${n}`);
  console.log(`--- ${errors.length} error(s), ${warns.length} warning(s) -> ${toPosix(relative(repoRoot, outFile))}`);
}

process.exit(errors.length > 0 ? 1 : 0);
