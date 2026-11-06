#!/usr/bin/env node
// R161.26 — 部署链「依赖安装」的工作区隔离守卫
//
// 为什么需要这个守卫
// ------------------
// 中心的生产依赖有**三条**安装入口: install-center.ps1 (新装) /
// upgrade-center.ps1 (升级) / update-center.ps1 (热修)。2026-10-29 的部署
// 审计在这三条链上实测到两件事:
//
//   1) **共享根的构建/测试工具链被静默剪掉** —— Server/ 是 npm workspaces
//      根 (workspaces: ["center","agent"])。在**工作区成员目录**里跑
//      `npm install --omit=dev`, npm 认的 install root 是**工作区根**, 成员
//      自己的 devDependencies 会被一起剪掉 (实测 Server 源树 dry-run:
//      "removed 141 packages" = vite / vitest / jsdom / supertest /
//      @vue/test-utils / @vitejs/plugin-vue / rollup ...)
//      ⇒ 装完这台机器**再也 build 不出前端、跑不了 web 测试**, 而下一条
//      命令报的是 "vite: not found" —— 与部署毫无关系, 现场离原因十万八千里。
//      ⇒ 装完必须把工具链装回来 (只在装之前本机就有时才恢复 ⇒ 生产目标机
//      行为一个字节都不变)。
//
//   2) **作用域必须显式** —— 兄弟工作区 (agent) 的**原生依赖**
//      better-sqlite3 **只有在工作区根上跑** install 才会被拉进来 (实测:
//      根上跑会 "add better-sqlite3 11.10.0" 外加 prebuild-install /
//      node-abi / napi-build-utils 等 30 个包)。它要下载预编译二进制, 或者
//      现场拉 C++ 工具链 —— **离线目标机直接装不上** ⇒ 安装器抛错 ⇒ 服务装不上。
//      旧写法躲过这一劫靠的是"cwd 恰好在成员目录"这个**巧合** (实测:
//      成员目录跑时兄弟工作区的依赖原样保留), 而 install-center.ps1 里
//      紧挨着的 dev 自愈恰恰是**在根上**跑的 ⇒ 作用域一旦靠 cwd 的启发式,
//      一次"顺手清理"就能把它请回来。
//
// 为什么是"守卫"而不是"注释"
// --------------------------
// 这三条入口是**手抄**的: 修好 install-center.ps1 不会让另外两个自动跟着改。
// 而这个缺陷**装完才显形** (报的是 "vite: not found", 不是 "部署装错了") ⇒
// 没有守卫, 下一个人照抄旧写法就把它请回来。本守卫把契约钉死:
//
//   C1  三条入口必须走**同一份**共享实现 (Install-CenterNodeDeps),
//       且不得再出现裸的 `npm.cmd install --omit=dev`。
//   C2  共享实现与工作区探测函数必须存在。
//   C3  工作区分支必须显式限定 `--workspace=` (不许无过滤地装整个工作区)。
//   C4  共享实现必须含"装完把被剪掉的工具链装回来"的逻辑 (`--include=dev`)。
//   C5  **实测探针** —— 真的把 Service.psm1 加载起来跑一遍:
//       Get-NpmWorkspaceContext 对 <repo>/Server/center 必须返回
//       Root=<repo>/Server 且 Member='center'; 对 <repo>/Server/scripts
//       必须返回 null (非成员 ⇒ 走"原地装"的交付包分支)。
//
// 退出码: 0 = 全绿; 1 = 有 error; 2 = 前置失败 (找不到仓库根)。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsonOnly = process.argv.includes('--json');

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

const findings = [];
const notes = [];

function addFinding(check, severity, message, detail) {
  findings.push({ check, severity, message, detail: detail ?? null });
}

function readText(relativePath) {
  const abs = join(repoRoot, relativePath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

// ---------------------------------------------------------------------------
// C1 / C2 / C3 / C4 — 静态契约
// ---------------------------------------------------------------------------
const SERVICE_MODULE = 'Server/scripts/common/Service.psm1';
const INSTALL_ENTRY_POINTS = [
  'Server/scripts/install-center.ps1',
  'Server/scripts/upgrade-center.ps1',
  'Server/scripts/update-center.ps1'
];

const serviceModule = readText(SERVICE_MODULE);
if (serviceModule === null) {
  addFinding('C2-service', 'error', `${SERVICE_MODULE} is missing — the shared install helper cannot exist`);
} else {
  // C2 — 三个函数必须都在。
  for (const fn of ['ConvertTo-WorkspaceGlobRegex', 'Get-NpmWorkspaceContext', 'Install-CenterNodeDeps']) {
    if (!new RegExp(`function\\s+${fn}\\b`).test(serviceModule)) {
      addFinding('C2-service', 'error', `${SERVICE_MODULE} does not define ${fn}()`);
    }
  }

  // C3 — 工作区分支必须显式限定工作区。
  if (!/(?:\$npmCmd|npm\.cmd)\s+install[^\r\n]*--workspace=/.test(serviceModule)) {
    addFinding(
      'C3-workspace-scope',
      'error',
      `${SERVICE_MODULE}: the workspace branch must install with an explicit --workspace=<member> filter`,
      'without it, an install at the workspace root also pulls the sibling workspaces (agent) and their native dependencies (better-sqlite3) — an offline target machine cannot install those'
    );
  }

  // C4 — 装完必须把被剪掉的工具链装回来。
  if (!/(?:\$npmCmd|npm\.cmd)\s+install[^\r\n]*--include=dev/.test(serviceModule)) {
    addFinding(
      'C4-dev-toolchain',
      'error',
      `${SERVICE_MODULE}: no --include=dev restore step`,
      '`npm install --omit=dev` prunes the shared workspace dev toolchain (vite/vitest/jsdom — measured "removed 140 packages"); without restoring it, the machine can no longer build the web UI or run the web tests, and the error ("vite: not found") points nowhere near the cause'
    );
  }
}

for (const rel of INSTALL_ENTRY_POINTS) {
  const text = readText(rel);
  if (text === null) {
    addFinding('C1-entry-point', 'error', `${rel} is missing`);
    continue;
  }
  // C1 — 必须走共享实现。
  if (!/Install-CenterNodeDeps/.test(text)) {
    addFinding(
      'C1-entry-point',
      'error',
      `${rel} does not call Install-CenterNodeDeps`,
      'install / upgrade / update must share ONE implementation — fixing one and leaving the other two keeps the defect alive on two of the three chains'
    );
  }
  // C1 — 不得再有裸的 npm install --omit=dev。
  if (/npm\.cmd\s+install\s+--omit=dev/.test(text)) {
    addFinding(
      'C1-entry-point',
      'error',
      `${rel} still runs a raw "npm.cmd install --omit=dev"`,
      'route it through Install-CenterNodeDeps (workspace-aware + re-verified + dev-toolchain restore)'
    );
  }
}

// ---------------------------------------------------------------------------
// C5 — 实测探针: 真的加载 Service.psm1 跑一遍工作区探测
// ---------------------------------------------------------------------------
function runPowerShell(script) {
  for (const exe of ['powershell.exe', 'pwsh', 'pwsh.exe']) {
    try {
      const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000
      });
      return { ok: true, exe, out };
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      return { ok: false, exe, out: String(err.stdout || ''), error: String(err.stderr || err.message || '') };
    }
  }
  return { ok: false, exe: null, out: '', error: 'no powershell executable found' };
}

const modulePath = join(repoRoot, 'Server', 'scripts', 'common', 'Service.psm1').replace(/'/g, "''");
const centerPath = join(repoRoot, 'Server', 'center').replace(/'/g, "''");
const scriptsPath = join(repoRoot, 'Server', 'scripts').replace(/'/g, "''");

const probe = runPowerShell(
  `Import-Module '${modulePath}' -Force; ` +
  `$c = Get-NpmWorkspaceContext -StartDir '${centerPath}'; ` +
  `$s = Get-NpmWorkspaceContext -StartDir '${scriptsPath}'; ` +
  `if ($c) { Write-Output ('CENTER=' + $c.Root + '|' + $c.Member) } else { Write-Output 'CENTER=' }; ` +
  `if ($s) { Write-Output ('SCRIPTS=' + $s.Root + '|' + $s.Member) } else { Write-Output 'SCRIPTS=' }`
);

if (!probe.ok || !probe.exe) {
  notes.push('C5 live probe skipped: no usable powershell on this machine (the static checks still ran)');
} else {
  const lines = String(probe.out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const centerLine = lines.find((l) => l.startsWith('CENTER='));
  const scriptsLine = lines.find((l) => l.startsWith('SCRIPTS='));
  if (!centerLine) {
    addFinding('C5-live-probe', 'error', 'the live probe produced no CENTER= line', String(probe.error || '').slice(0, 400));
  } else {
    const value = centerLine.slice('CENTER='.length);
    if (!value) {
      addFinding(
        'C5-live-probe',
        'error',
        'Get-NpmWorkspaceContext returned null for <repo>/Server/center',
        'it must detect the workspace root — otherwise the install falls back to the plain path and prunes the shared root dev toolchain'
      );
    } else {
      const [root, member] = value.split('|');
      const expectedRoot = resolve(repoRoot, 'Server');
      if (resolve(root) !== expectedRoot) {
        addFinding('C5-live-probe', 'error', `workspace root mismatch: got ${root}, expected ${expectedRoot}`);
      }
      if (member !== 'center') {
        addFinding('C5-live-probe', 'error', `workspace member mismatch: got '${member}', expected 'center'`);
      }
    }
  }
  if (scriptsLine && scriptsLine.slice('SCRIPTS='.length)) {
    addFinding(
      'C5-live-probe',
      'error',
      'Get-NpmWorkspaceContext matched a directory that is NOT a workspace member (<repo>/Server/scripts)',
      'a false positive here would turn every install into a workspace install'
    );
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  summary: { errors: errors.length, warnings: warns.length, notes: notes.length },
  findings,
  notes
};

const outFile = join(__dirname, 'npm-install-isolation.json');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

if (!jsonOnly) {
  console.log('=== npm install isolation check ===');
  console.log(`repo root: ${repoRoot}`);
  for (const f of findings) {
    const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`  ${tag} [${f.check}] ${f.message}`);
    if (f.detail) console.log(`        ${f.detail}`);
  }
  for (const n of notes) console.log(`  note  ${n}`);
  console.log(`--- ${errors.length} error(s), ${warns.length} warning(s) -> ${relative(repoRoot, outFile)}`);
}

process.exit(errors.length > 0 ? 1 : 0);
