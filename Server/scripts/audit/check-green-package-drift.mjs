#!/usr/bin/env node
// R160 — Green-package drift detector.
//
// WHY THIS EXISTS (the incident that motivated it)
// -------------------------------------------------
// The customer-facing green packages (ADAgent/, MemberAgent/) are NOT build
// artifacts of this repository: they are hand-copied snapshots of the operator
// machine's deploy tree (C:\agentInstall). The documented release entry
// (Server/scripts/prepare-release.ps1) calls six scripts that do not exist in
// this checkout, and the real builder (ADAgent/scripts/make-release.ps1) runs
// on the operator machine — its exclusion list proves the hand-copy, because
// the shipped package CONTAINS files the builder is contractually forbidden to
// include (run-partner-probe.js, submit-partner-probe*.js,
// trigger-all-packages-once.js).
//
// Consequence: every fix landed in Server/scripts/ silently stops reaching the
// package customers actually install. That is how a shipped `uninstall-agent.ps1`
// with NO drive-root guard (running `-InstallPath D:\` wipes the volume) and a
// shipped `install-agent.ps1` with NO dependency probe (npm exits 0, deps are
// missing, the service crash-loops) survived for weeks.
//
// This detector checks the INVARIANTS that matter (not byte-equality with the
// source tree — the green lineage legitimately owns features the source tree
// lacks, e.g. common/Version.psm1 + LogRetention.ps1), so the class of bug
// above cannot reach a customer silently again.
//
// Usage:  node Server/scripts/audit/check-green-package-drift.mjs
//         node Server/scripts/audit/check-green-package-drift.mjs --json
// Exit:   0 = no violation, 1 = at least one violation.
// Output: Server/scripts/audit/green-package-drift.json (machine-readable)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzePackage } from './check-agent-import-graph.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonOnly = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Locate the repo root: walk up until a directory contains BOTH a 'Server'
// subdir and at least one green package. (findRepoRoot mirrors the convention
// used by center/scripts/audit/diff-mirrors.mjs — take the deepest ancestor
// that still looks like the repo, so a mirror checkout also works.)
// ---------------------------------------------------------------------------
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const hasServer = existsSync(join(dir, 'Server'));
    const hasGreen = existsSync(join(dir, 'ADAgent')) || existsSync(join(dir, 'MemberAgent'));
    if (hasServer && hasGreen) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const repoRoot = findRepoRoot(__dirname);
if (!repoRoot) {
  console.error('ERR: could not locate repo root (need a dir containing Server/ and ADAgent/ or MemberAgent/)');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Green package definitions
// ---------------------------------------------------------------------------
const GREEN_PACKAGES = [
  {
    id: 'ADAgent',
    dir: 'ADAgent',
    // AD agent source tree in the repo
    sourceAgentDir: join('Server', 'agent'),
    // The AD green package must NOT claim the member agent's package name
    expectedPackageName: '@ad-dashboard/agent',
    // Files that only exist in the member green package (member lineage)
    memberOnly: false,
  },
  {
    id: 'MemberAgent',
    dir: 'MemberAgent',
    sourceAgentDir: join('Server', 'noadagent'),
    expectedPackageName: '@ad-dashboard/noad-agent',
    memberOnly: true,
  },
];

// The builder's own exclusion list (ADAgent/scripts/make-release.ps1, $xf) —
// files that MUST NOT appear in a built package. Their presence proves the
// package was hand-copied instead of built.
const BUILDER_EXCLUDED = [
  // R161.23 — 'scripts/trigger-all-packages-once.js' 与 'scripts/manual-trigger.js'
  //   从这份"禁止随包发布"清单里移除: 这两个是成员服务器上的**运维工具**,
  //   源树 Server\noadagent\scripts\ 里就有, 自动升级通道 (只发 .js) 也照发;
  //   唯独绿色包发布脚本把它们剔掉 ⇒ 绿色包装出来的成员机上没有这两个工具,
  //   自动升级过的机器上却有 ⇒ 同一个操作在不同装法下结果不一样。
  //   两个 make-release.ps1 的剔除清单已同步移除对应条目。
  'scripts/run-partner-probe.js',
  'scripts/submit-partner-probe.js',
  'scripts/submit-partner-probe-v2.js',
  'scripts/probe-repadmin.ps1',
  'scripts/debug-collect.js',
  'scripts/debug-collect-ps1.ps1',
  'scripts/test-collect-with-env.ps1',
  'scripts/list-today.ps1',
  'scripts/list-centre-routes.js',
  'scripts/git-init-commit.ps1',
  'scripts/make-release.ps1',
  'scripts/read-agent-token.js',
];

const findings = [];
const notes = [];

function addFinding(check, severity, pkg, message, detail) {
  findings.push({ check, severity, package: pkg, message, detail: detail ?? null });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function listFiles(root, filter) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'data') continue;
        walk(full);
      } else if (entry.isFile() && (!filter || filter(full))) {
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

function hasUtf8Bom(file) {
  const fd = readFileSync(file);
  return fd.length >= 3 && fd[0] === 0xef && fd[1] === 0xbb && fd[2] === 0xbf;
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// ---------------------------------------------------------------------------
// C1 — UTF-8 BOM on every shipped .ps1/.psm1
//      Windows PowerShell 5.1 reads a BOM-less script with the system ANSI
//      codepage (936 on a Chinese-locale host) => UTF-8 Chinese comments decode
//      as GBK => a stray '}' or quote turns a comment into a ParseError and the
//      WHOLE script fails to load. Measured in R160: adding Chinese comments to
//      a BOM-less green script produced "Unexpected token '}'" under PS 5.1 while
//      the same file parsed clean under PS 7.
// ---------------------------------------------------------------------------
function checkBom(pkg) {
  const pkgDir = join(repoRoot, pkg.dir);
  const scripts = listFiles(pkgDir, (f) => /\.ps[1m]$/i.test(f));
  // The bundled Node runtime under <pkg>/node/ is vendored — never touched.
  const vendored = scripts.filter((f) => f.includes(sep + 'node' + sep));
  const own = scripts.filter((f) => !vendored.includes(f));
  const missing = own.filter((f) => !hasUtf8Bom(f));
  for (const f of missing) {
    addFinding('C1-bom', 'error', pkg.id, 'PS script without UTF-8 BOM (PS 5.1 parses it as ANSI => ParseError risk)',
      relative(repoRoot, f).split(sep).join('/'));
  }
  if (own.length > 0 && missing.length === 0) {
    notes.push(`${pkg.id}: ${own.length} shipped PS scripts all carry a UTF-8 BOM`);
  }
  if (vendored.length > 0) {
    notes.push(`${pkg.id}: ${vendored.length} vendored node-runtime scripts skipped (never modified)`);
  }
}

// ---------------------------------------------------------------------------
// C2 — uninstall script must carry BOTH drive-root guards
//      layer 1: bare drive letter ('D:')  -> regex on the trimmed path
//      layer 2: real root ('D:\', '\\server\share') -> GetPathRoot comparison
//      Missing either one means `Remove-Item -Recurse -Force` can wipe a volume.
// ---------------------------------------------------------------------------
function checkUninstallGuard(pkg) {
  const file = join(repoRoot, pkg.dir, 'uninstall-agent.ps1');
  if (!existsSync(file)) {
    addFinding('C2-uninstall-guard', 'error', pkg.id, 'uninstall-agent.ps1 is missing from the green package');
    return;
  }
  const text = readText(file);
  const rel = relative(repoRoot, file).split(sep).join('/');
  if (!/\^\[A-Za-z\]:\$/.test(text)) {
    addFinding('C2-uninstall-guard', 'error', pkg.id, 'uninstall-agent.ps1 has NO bare-drive-letter guard (a `D:` install path deletes the CWD)', rel);
  }
  if (!text.includes('GetPathRoot')) {
    addFinding('C2-uninstall-guard', 'error', pkg.id, 'uninstall-agent.ps1 has NO filesystem-root guard (a `D:\\` install path wipes the volume)', rel);
  }
  if (/\bRemove-Item\s+-Path\s+\$InstallPath\b/.test(text)) {
    addFinding('C2-uninstall-guard', 'error', pkg.id, 'uninstall-agent.ps1 deletes with wildcard -Path (a path containing [ ] can hit the wrong target)', rel);
  }
  if (!text.includes('Remove-Item -LiteralPath $InstallPath')) {
    addFinding('C2-uninstall-guard', 'error', pkg.id, 'uninstall-agent.ps1 does not delete via -LiteralPath', rel);
  }
  if (!/is still registered after Unregister/.test(text)) {
    addFinding('C2-uninstall-guard', 'warn', pkg.id, 'uninstall-agent.ps1 deletes the install dir without verifying the service was actually unregistered', rel);
  }
}

// ---------------------------------------------------------------------------
// C3 — install script must verify the runtime deps are RESOLVABLE
//      A missing dep kills the agent on its first import (static import of
//      better-sqlite3 in src/local-queue.js) => NSSM restarts => crash loop.
//      The check must be require.resolve-based, not a node_modules directory
//      existence test (npm workspaces hoist deps to the parent tree).
//
//      The probe's MODULE SET is not allowed to be a guess: it must equal the
//      set of third-party modules the shipped payload actually imports
//      (measured by check-agent-import-graph.mjs). A module that is probed but
//      never imported is a stale requirement that will one day block a
//      perfectly good install with a false failure.
// ---------------------------------------------------------------------------
const analysisCache = new Map();

function measuredExternalModules(pkg) {
  if (!analysisCache.has(pkg.id)) {
    const greenDir = join(repoRoot, pkg.dir, 'agent');
    analysisCache.set(pkg.id, existsSync(greenDir) ? analyzePackage(greenDir) : null);
  }
  const analysis = analysisCache.get(pkg.id);
  return analysis ? analysis.external : [];
}

function parseRequiredModules(text) {
  const m = text.match(/\$RequiredRuntimeModules\s*=\s*@\(([^)]*)\)/);
  if (!m) return null;
  const mods = [];
  const re = /'([^']+)'/g;
  let x;
  while ((x = re.exec(m[1])) !== null) mods.push(x[1]);
  return mods;
}

function checkProbeModuleSet(check, pkg, text, rel, scriptName) {
  const expected = measuredExternalModules(pkg);
  const declared = parseRequiredModules(text);
  if (!declared) {
    addFinding(check, 'error', pkg.id,
      `${scriptName} does not declare $RequiredRuntimeModules (the probe module set must be an explicit, measured constant — not a guess baked into the probe source)`,
      rel);
    return;
  }
  for (const mod of expected) {
    if (!declared.includes(mod)) {
      addFinding(check, 'error', pkg.id,
        `${scriptName} does not probe '${mod}' — the shipped payload imports it statically, so a missing ${mod} is a startup crash-loop`,
        rel);
    }
  }
  for (const mod of declared) {
    if (!expected.includes(mod)) {
      addFinding(check, 'warn', pkg.id,
        `${scriptName} probes '${mod}' but the shipped payload never imports it — a stale requirement that will block a correct install once the package is cleaned up`,
        rel);
    }
  }
}

function checkDependencyProbe(pkg) {
  const file = join(repoRoot, pkg.dir, 'install-agent.ps1');
  if (!existsSync(file)) {
    addFinding('C3-dep-probe', 'error', pkg.id, 'install-agent.ps1 is missing from the green package');
    return;
  }
  const text = readText(file);
  const rel = relative(repoRoot, file).split(sep).join('/');
  if (!text.includes('require.resolve')) {
    addFinding('C3-dep-probe', 'error', pkg.id, 'install-agent.ps1 has NO resolvability probe (deps can be missing while the install reports success)', rel);
  }
  if (!text.includes('package.json')) {
    addFinding('C3-dep-probe', 'error', pkg.id, 'install-agent.ps1 does not check for package.json (npm install with no package.json installs nothing and still exits 0)', rel);
  }
  if (!text.includes('not resolvable') && !text.includes('NOT resolvable')) {
    addFinding('C3-dep-probe', 'error', pkg.id, 'install-agent.ps1 does not abort the install when the probe fails', rel);
  }
  checkProbeModuleSet('C3-dep-probe', pkg, text, rel, 'install-agent.ps1');
}

// ---------------------------------------------------------------------------
// C3b — start.ps1 (the hot-update path) must carry the SAME two guards:
//      (a) a dependency resolvability probe, and
//      (b) a crash-restart-loop check.
//
//      (a) R160 measured: the shipped start.ps1 ran `npm install` -> Start-Service
//          with no resolvability check. npm exits 0 even when it installed
//          nothing (no package.json in the target dir), the agent then dies on its
//          first static import of better-sqlite3, and NSSM restart-loops.
//
//      (b) The service is NSSM-managed with `AppExit Default Restart` +
//          `AppRestartDelay 2000`, so the SCM service state stays 'Running' while
//          node.exe crash-loops => `Status -eq 'Running'` is NOT a health check.
//          The shipped start.ps1 printed "started" and exited 0 over a crash
//          loop (prod field evidence: R121, 13 crashes / 10 min). The check must
//          therefore look at the agent's node child process (Win32_Process +
//          ParentProcessId) and require it to survive the observation window.
// ---------------------------------------------------------------------------
function checkStartScript(pkg) {
  const file = join(repoRoot, pkg.dir, 'start.ps1');
  if (!existsSync(file)) {
    addFinding('C3b-start', 'error', pkg.id, 'start.ps1 is missing from the green package');
    return;
  }
  const text = readText(file);
  const rel = relative(repoRoot, file).split(sep).join('/');
  if (!text.includes('require.resolve') && !text.includes('Test-NodeDepsResolvable')) {
    addFinding('C3b-start', 'error', pkg.id, 'start.ps1 has NO dependency resolvability probe (npm can exit 0 while installing nothing)', rel);
  }
  if (!text.includes('package.json')) {
    addFinding('C3b-start', 'error', pkg.id, 'start.ps1 does not check for package.json (npm install with no package.json installs nothing and still exits 0)', rel);
  }
  if (!text.includes('Win32_Process') || !text.includes('ParentProcessId')) {
    addFinding('C3b-start', 'error', pkg.id,
      'start.ps1 does not detect a crash-restart loop (NSSM keeps the SERVICE Running while the app crash-loops, so the service state alone proves nothing)', rel);
  }
  if (!/survived the \d+s stabilization window/.test(text)) {
    addFinding('C3b-start', 'warn', pkg.id,
      'start.ps1 has no stabilization window for the agent process check (a restart can only be observed over a window wider than NSSM\'s AppRestartDelay)', rel);
  }
  checkProbeModuleSet('C3b-start', pkg, text, rel, 'start.ps1');
}

// ---------------------------------------------------------------------------
// C4 — version coherence: package.json == build-manifest.json
//      R160 rule: package.json version === build-manifest round === fleet truth
// ---------------------------------------------------------------------------
function checkVersionCoherence(pkg) {
  const def = GREEN_PACKAGES.find((p) => p.id === pkg.id);
  const pkgJsonPath = join(repoRoot, pkg.dir, 'agent', 'package.json');
  const manifestPath = join(repoRoot, pkg.dir, 'agent', 'build-manifest.json');
  if (!existsSync(pkgJsonPath)) {
    addFinding('C4-version', 'error', pkg.id, 'agent/package.json is missing from the green package');
    return;
  }
  const pkgJson = readJsonSafe(pkgJsonPath);
  const manifest = readJsonSafe(manifestPath);
  if (!pkgJson) {
    addFinding('C4-version', 'error', pkg.id, 'agent/package.json is not valid JSON');
    return;
  }
  if (manifest && manifest.version && pkgJson.version !== manifest.version) {
    addFinding('C4-version', 'error', pkg.id,
      `agent/package.json version (${pkgJson.version}) != agent/build-manifest.json version (${manifest.version})`,
      'agent/build-manifest.json');
  }
  if (def.expectedPackageName && pkgJson.name !== def.expectedPackageName) {
    addFinding('C4-version', 'error', pkg.id,
      `agent/package.json name is "${pkgJson.name}", expected "${def.expectedPackageName}"`,
      'agent/package.json');
  }
  // The lockfile root entry must agree with package.json, otherwise npm
  // rewrites it on the target machine (and an offline target cannot).
  const lockPath = join(repoRoot, pkg.dir, 'agent', 'package-lock.json');
  const lock = readJsonSafe(lockPath);
  if (lock && lock.packages && lock.packages['']) {
    if (lock.packages[''].version && lock.packages[''].version !== pkgJson.version) {
      addFinding('C4-version', 'warn', pkg.id,
        `package-lock.json root version (${lock.packages[''].version}) != package.json version (${pkgJson.version})`,
        'agent/package-lock.json');
    }
  }
}

// ---------------------------------------------------------------------------
// C5 — payload drift: every source .js must exist in the green package with
//      identical bytes. Green-only .js files are reported as notes (the member
//      package still carries the pre-R158.75 lineage: runCollector /
//      runDiscovery / fetchPortList / openQueue / createScheduler, i.e. the AD
//      runtime the source deliberately removed from the noad bundle).
// ---------------------------------------------------------------------------
function checkPayloadDrift(pkg) {
  const def = GREEN_PACKAGES.find((p) => p.id === pkg.id);
  const sourceDir = join(repoRoot, def.sourceAgentDir);
  const greenDir = join(repoRoot, pkg.dir, 'agent');
  if (!existsSync(sourceDir) || !existsSync(greenDir)) {
    addFinding('C5-payload', 'error', pkg.id, 'cannot compare payload: source or green agent tree is missing');
    return;
  }
  const isJs = (f) => /\.(js|cjs|mjs)$/i.test(f);
  const sourceFiles = listFiles(sourceDir, isJs);
  const greenFiles = new Set(listFiles(greenDir, isJs).map((f) => relative(greenDir, f).split(sep).join('/')));
  const missing = [];
  const differing = [];
  for (const sf of sourceFiles) {
    const relPath = relative(sourceDir, sf).split(sep).join('/');
    const gf = join(greenDir, relPath);
    if (!existsSync(gf)) { missing.push(relPath); continue; }
    if (sha256(sf) !== sha256(gf)) differing.push(relPath);
  }
  for (const m of missing) {
    addFinding('C5-payload', 'error', pkg.id, `source agent file is missing from the green package: ${m}`, def.sourceAgentDir);
  }
  for (const d of differing) {
    addFinding('C5-payload', 'error', pkg.id, `green package agent file differs from source: ${d}`, def.sourceAgentDir);
  }
  const greenOnly = [...greenFiles].filter((f) => {
    const sf = join(sourceDir, f);
    return !existsSync(sf);
  });
  if (greenOnly.length > 0) {
    notes.push(`${pkg.id}: ${greenOnly.length} green-only agent JS file(s) not present in ${def.sourceAgentDir}: ${greenOnly.slice(0, 6).join(', ')}${greenOnly.length > 6 ? ', ...' : ''}`);
  }
  if (missing.length === 0 && differing.length === 0) {
    notes.push(`${pkg.id}: agent JS payload is byte-identical to ${def.sourceAgentDir}`);
  }
}

// ---------------------------------------------------------------------------
// C6 — builder-exclusion violations: files the builder forbids from shipping
//      that are present anyway => the package was hand-copied.
// ---------------------------------------------------------------------------
function checkBuilderExclusions(pkg) {
  const pkgDir = join(repoRoot, pkg.dir);
  for (const relPath of BUILDER_EXCLUDED) {
    const full = join(pkgDir, 'agent', relPath);
    if (existsSync(full)) {
      addFinding('C6-builder-exclusion', 'warn', pkg.id,
        `debug script present in the shipped package (the builder excludes it): agent/${relPath}`,
        'scripts/make-release.ps1 $xf');
    }
  }
}

// ---------------------------------------------------------------------------
// C7 — import graph of the shipped agent payload.
//      A relative import that does not resolve inside the package is an
//      ERR_MODULE_NOT_FOUND on the first import => the service crash-loops
//      (the R114 / R123 failure class). The reachability walk additionally
//      shows which shipped files are dead weight.
// ---------------------------------------------------------------------------
function checkImportGraph(pkg) {
  const greenDir = join(repoRoot, pkg.dir, 'agent');
  if (!existsSync(greenDir)) {
    addFinding('C7-import-graph', 'error', pkg.id, 'agent/ payload directory is missing from the green package');
    return;
  }
  const { broken, unreachable, reachable, entryFound } = analyzePackage(greenDir);
  if (!entryFound) {
    addFinding('C7-import-graph', 'error', pkg.id, 'agent/agent.js entry point is missing from the green package');
  }
  for (const b of broken) {
    addFinding('C7-import-graph', 'error', pkg.id,
      `broken relative import: ${b.from} -> ${b.spec} (ERR_MODULE_NOT_FOUND on first import => crash loop)`,
      b.from);
  }
  // Dead code is a packaging-hygiene signal, not a crash: report it as a note
  // with the full list (the operator's release builder is what decides what
  // actually ships, and it excludes the debug scripts at build time).
  if (unreachable.length > 0) {
    const shown = unreachable.map((f) => relative(greenDir, f).split(sep).join('/'));
    notes.push(`${pkg.id}: ${unreachable.length} shipped agent file(s) unreachable from agent.js (dead code): ${shown.join(', ')}`);
  }
  if (broken.length === 0 && entryFound) {
    notes.push(`${pkg.id}: all relative imports in the shipped payload resolve; ${reachable.size} file(s) reachable from agent.js`);
  }
}

// ---------------------------------------------------------------------------
// C8 — self-containment: the green package must ship the runtime it promises.
//
//      README-green-install.md (both packages) states: "绿色包自带 Node.js 20
//      LTS x64 (位于 <green>/node/, 随包分发, 无需目标机预装)" and "文件大小约
//      80-90 MB (含 Node 20 LTS portable)". The install chain depends on it
//      too: install-agent.ps1 stages <green>/node -> <InstallPath>/node and
//      then runs <InstallPath>/node/npm.cmd; Register-ADDashboardAgent.ps1
//      resolves <green>/nssm/nssm.exe.
//
//      R160 measured: MemberAgent/ has NEITHER node/ (80 MB) NOR nssm/ — the
//      tree was hand-copied and those two directories were never carried
//      over. The result on a customer machine: install aborts at the
//      "npm.cmd not found" guard (or, for nssm, at "nssm.exe not found"),
//      i.e. the air-gap install the README advertises is impossible.
//      Nothing in the tree detected it, because the previous checks only
//      looked at FILES THAT EXIST — never at the ones that are missing.
//
//      So this check asserts PRESENCE of the bundled runtime.
// ---------------------------------------------------------------------------
const REQUIRED_BUNDLED_ARTIFACTS = [
  { rel: join('node', 'node.exe'), why: 'NSSM launches the agent with this interpreter' },
  { rel: join('node', 'npm.cmd'), why: 'install-agent.ps1 runs <InstallPath>\\node\\npm.cmd install --omit=dev' },
  { rel: join('nssm', 'nssm.exe'), why: 'Register-ADDashboardAgent.ps1 registers the Windows service with it' },
];

function checkSelfContainment(pkg) {
  const pkgDir = join(repoRoot, pkg.dir);
  for (const art of REQUIRED_BUNDLED_ARTIFACTS) {
    const full = join(pkgDir, art.rel);
    if (!existsSync(full)) {
      addFinding('C8-self-containment', 'error', pkg.id,
        `green package is missing ${pkg.dir}/${art.rel.split(sep).join('/')} — ${art.why}. Without it the documented air-gap install cannot run on the target machine.`,
        'README-green-install.md');
    }
  }
}

// ---------------------------------------------------------------------------
// C9 — the service-registration script must not trust the SCM service state.
//
//      install-agent.ps1 delegates the service start to
//      Register-ADDashboardAgent.ps1. The old check there was
//      `Status -eq 'Running'` => "started". With NSSM's
//      `AppExit Default Restart` + `AppRestartDelay 2000` the SCM state stays
//      Running while node.exe crash-loops, so a fresh install of a
//      crash-looping agent reported SUCCESS (the R121 field failure).
//
//      The check must look at the agent's node child process and require it to
//      survive the observation window — same primitive as C3b.
// ---------------------------------------------------------------------------
function checkRegisterScript(pkg) {
  const file = join(repoRoot, pkg.dir, 'Register-ADDashboardAgent.ps1');
  if (!existsSync(file)) {
    addFinding('C9-register-crashcheck', 'error', pkg.id, 'Register-ADDashboardAgent.ps1 is missing from the green package');
    return;
  }
  const text = readText(file);
  const rel = relative(repoRoot, file).split(sep).join('/');
  if (!text.includes('Test-AgentProcessHealthy')) {
    addFinding('C9-register-crashcheck', 'error', pkg.id,
      'Register-ADDashboardAgent.ps1 has no agent-process health check (a crash-restart loop is reported as "started")', rel);
  }
  if (!text.includes('ParentProcessId')) {
    addFinding('C9-register-crashcheck', 'error', pkg.id,
      'Register-ADDashboardAgent.ps1 does not identify the agent child process (ParentProcessId) — the service state alone proves nothing', rel);
  }
  if (!/survived the \$\{ObservationSeconds\}s stabilization window/.test(text) && !/survived the \d+s stabilization window/.test(text)) {
    addFinding('C9-register-crashcheck', 'warn', pkg.id,
      'Register-ADDashboardAgent.ps1 has no stabilization window for the agent process check', rel);
  }
}

// ---------------------------------------------------------------------------
// C10 — the declared dependency set must equal the MEASURED runtime set.
//
//      install-agent.ps1 runs `<InstallPath>/node/npm.cmd install --omit=dev`
//      on the TARGET machine; whatever agent/package.json declares is what gets
//      installed there, and a non-zero npm exit aborts the whole install
//      (install-agent.ps1: `if ($LASTEXITCODE -ne 0) { throw "npm install failed" }`).
//
//      R160 measured on the shipped green packages:
//
//        MemberAgent/agent/package.json declared  axios + better-sqlite3 + pino
//        but the shipped member payload imports ONLY pino (better-sqlite3 is
//        reachable exclusively through src/local-queue.js, which nothing in the
//        member lineage imports — it is one of the 12 AD modules the member
//        build-manifest says the NoAD fork deleted).
//        Measured install cost of the two extra declarations on this machine:
//          84 packages / 15.1 s, incl. better-sqlite3@11.10.0 whose lock entry
//          has hasInstallScript=true => the TARGET must download a prebuilt
//          binary (GitHub) or run node-gyp (needs Python + VS Build Tools).
//          Trimmed manifest: 23 packages / 5.4 s, no native build.
//        A member server without build tools and without GitHub access fails
//        `npm install` => install-agent.ps1 throws => the member agent is never
//        installed, for a module it does not use.
//
//        ADAgent/agent/package.json declared axios as well; the AD payload
//        never imports it (it only appears in a comment), and the source tree
//        (Server/agent/package.json) already declares the minimal set.
//
//      Rules:
//        (a) a module the payload imports but package.json does not declare
//            => ERROR: npm install will not install it => startup crash-loop.
//        (b) a module package.json declares but the payload never imports
//            => ERROR when it carries an install script / platform constraint
//            (the target has to build or download it), else WARN (dead weight).
//        (c) package-lock.json's root deps must equal package.json's deps
//            => ERROR: `npm ci` refuses an out-of-sync lock, and an offline
//            target cannot re-resolve it.
// ---------------------------------------------------------------------------
function readDependencySet(pkgJson) {
  const deps = pkgJson && pkgJson.dependencies ? pkgJson.dependencies : {};
  const optDeps = pkgJson && pkgJson.optionalDependencies ? pkgJson.optionalDependencies : {};
  return { ...deps, ...optDeps };
}

function lockEntryFor(lock, name) {
  if (!lock || !lock.packages) return null;
  return lock.packages[`node_modules/${name}`] ?? null;
}

// Modules that need a native build (node-gyp: Python + VS Build Tools) or a
// binary download (prebuild-install / postinstall) ON THE TARGET. A target
// without a toolchain and without GitHub access cannot install them.
const NATIVE_INSTALL_MODULES = new Set([
  'better-sqlite3', 'better_sqlite3', 'sqlite3', 'sharp', 'canvas', 'bcrypt',
  'argon2', 'node-pty', 'node-sass', 'esbuild', 'grpc', 'grpc-tools',
  'ffi-napi', 'puppeteer', 'playwright-core', 'keytar', 'node-gyp',
]);

function hasNativeInstallFootprint(name, entry) {
  if (NATIVE_INSTALL_MODULES.has(name)) return true;
  if (!entry) return false;
  if (entry.hasInstallScript === true) return true;
  if (Array.isArray(entry.os) || Array.isArray(entry.cpu)) return true;
  if (entry.gypfile === true) return true;
  return false;
}

function checkDeclaredDependencies(pkg) {
  const agentDir = join(repoRoot, pkg.dir, 'agent');
  const pkgJsonPath = join(agentDir, 'package.json');
  const lockPath = join(agentDir, 'package-lock.json');
  if (!existsSync(pkgJsonPath)) {
    addFinding('C10-deps', 'error', pkg.id, 'agent/package.json is missing — npm install on the target has nothing to install');
    return;
  }
  const pkgJson = readJsonSafe(pkgJsonPath);
  if (!pkgJson) {
    addFinding('C10-deps', 'error', pkg.id, 'agent/package.json is not valid JSON');
    return;
  }
  const lock = readJsonSafe(lockPath);
  const declared = readDependencySet(pkgJson);
  const declaredNames = Object.keys(declared).sort();
  const measured = measuredExternalModules(pkg);
  const measuredNames = [...measured].sort();

  // (a) imported but not declared
  for (const mod of measuredNames) {
    if (!declaredNames.includes(mod)) {
      addFinding('C10-deps', 'error', pkg.id,
        `the payload imports '${mod}' but agent/package.json does not declare it — npm install on the target will not install it => the agent dies on its first import`,
        'agent/package.json');
    }
  }
  // (b) declared but never imported
  for (const mod of declaredNames) {
    if (measuredNames.includes(mod)) continue;
    const entry = lockEntryFor(lock, mod);
    if (hasNativeInstallFootprint(mod, entry)) {
      addFinding('C10-deps', 'error', pkg.id,
        `agent/package.json declares '${mod}' but the shipped payload never imports it, and it carries an install script / platform constraint — the target must download or build it during npm install, and a failure there aborts the whole install`,
        'agent/package.json');
    } else {
      addFinding('C10-deps', 'warn', pkg.id,
        `agent/package.json declares '${mod}' but the shipped payload never imports it — dead weight in every target-side npm install`,
        'agent/package.json');
    }
  }
  // (c) lock root vs manifest
  if (lock && lock.packages && lock.packages['']) {
    const lockDeps = Object.keys(readDependencySet(lock.packages[''])).sort();
    if (JSON.stringify(lockDeps) !== JSON.stringify(declaredNames)) {
      addFinding('C10-deps', 'error', pkg.id,
        `package-lock.json root dependencies (${lockDeps.join(', ') || 'none'}) != package.json dependencies (${declaredNames.join(', ') || 'none'}) — 'npm ci' refuses an out-of-sync lock and an offline target cannot re-resolve it`,
        'agent/package-lock.json');
    }
  } else {
    addFinding('C10-deps', 'warn', pkg.id,
      'agent/package-lock.json is missing — the target resolves the dependency tree on its own (no reproducible install)',
      'agent/package-lock.json');
  }
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------
for (const pkg of GREEN_PACKAGES) {
  if (!existsSync(join(repoRoot, pkg.dir))) {
    addFinding('C0-package', 'warn', pkg.id, `green package directory not found: ${pkg.dir}`);
    continue;
  }
  checkBom(pkg);
  checkUninstallGuard(pkg);
  checkDependencyProbe(pkg);
  checkStartScript(pkg);
  checkVersionCoherence(pkg);
  checkPayloadDrift(pkg);
  checkBuilderExclusions(pkg);
  checkImportGraph(pkg);
  checkSelfContainment(pkg);
  checkRegisterScript(pkg);
  checkDeclaredDependencies(pkg);
}

const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  summary: { errors: errors.length, warnings: warns.length, notes: notes.length },
  findings,
  notes,
};

const outFile = join(__dirname, 'green-package-drift.json');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (!jsonOnly) {
  console.log('=== green package drift check ===');
  console.log(`repo root: ${repoRoot}`);
  for (const f of findings) {
    const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`  ${tag} [${f.check}] ${f.package}: ${f.message}`);
  }
  for (const n of notes) console.log(`  note  ${n}`);
  console.log(`--- ${errors.length} error(s), ${warns.length} warning(s) -> ${relative(repoRoot, outFile).split(sep).join('/')}`);
}

process.exit(errors.length > 0 ? 1 : 0);
