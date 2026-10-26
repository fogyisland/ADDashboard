// start-prod: build the web bundle (vite) on cold start, then start the
// Express server from center/. center/dist/ is the single canonical output
// location — vite outputs there directly via outDir='../dist' in
// center/web/vite.config.js. No copy step.
//
// R160 审计修复 (2026-10-25):
//
//   M1 — 旧逻辑只看 "dist/index.html 在不在"。在 ⇒ 永远不构建。于是
//        "改了 web/src 但忘了 build:web" 的情况会让**陈旧**的 dist 被一直
//        服务下去 (线上看到旧 UI) —— 这正是 2026-08-22 "推了修复但用户
//        还是旧页面" 那一类事故的成因。
//        但**不能**改成"发现陈旧就自动重建": 生产安装是
//        `npm install --omit=dev` ⇒ 机器上**没有 vite** ⇒ 自动重建必然
//        失败 ⇒ 服务根本起不来 (比旧 UI 严重得多)。
//        所以定成: 生产默认仍然只在 dist 缺失时构建; 陈旧只**告警**并
//        给出明确下一步; 想强制重建用 ADDASHBOARD_REBUILD_WEB=1。
//
//   M2 — 旧 spawn 用了 shell: true (Windows 上是为了能跑 npm.cmd)。shell
//        意味着整条命令交给 cmd.exe 解释: 路径带空格会被拆坏, 参数一旦
//        来自外部就是命令注入面。现在优先直接用 node 跑 npm-cli.js
//        (shell: false —— 没有 shell 就没有注入面), 找不到 npm-cli.js 才
//        退回 shell 方式 (且此时参数必须全是本文件里的字面量)。
//
//   M3 — 构建失败 / 产物缺失时明确报错并 exit 1, 而不是抛一个未处理的
//        promise rejection (现场只看到一坨 stack trace, 不知道卡在哪一步,
//        更不知道"生产机上没有 vite"这条关键信息)。
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const centerDist = resolve(root, 'center/dist');
const distIndex = resolve(centerDist, 'index.html');
const webSrc = resolve(root, 'center/web/src');

/**
 * 找到 npm 的 CLI 入口, 以便**绕开 shell** 调用 npm。
 * 返回 null 表示找不到 (调用方退回 shell 方式)。
 */
function resolveNpmCli() {
  const candidates = [
    // workspace 根 (npm install 时装出来的 npm)
    resolve(root, 'node_modules/npm/bin/npm-cli.js'),
    // 正在跑本脚本的这个 node 旁边 —— 绿色包自带的 node 就是这种布局
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    // 绿色包里的 node/ 与 publish/system/node/
    resolve(root, 'node/node_modules/npm/bin/npm-cli.js'),
    resolve(root, 'publish/system/node/node_modules/npm/bin/npm-cli.js')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 组装一次 npm 调用。优先 { node, npm-cli.js, args } (无 shell);
 * 兜底 { npm, args, shell:true }。
 */
function npmSpec(args) {
  const cli = resolveNpmCli();
  if (cli) {
    return { cmd: process.execPath, args: [cli, ...args], shell: false };
  }
  // 兜底走 shell —— 参数必须全部是本文件里的**字面量**。
  // 任何外部输入拼进来都等于命令注入。
  return { cmd: 'npm', args, shell: process.platform === 'win32' };
}

function run(spec, opts = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const p = spawn(spec.cmd, spec.args, {
      stdio: 'inherit',
      shell: spec.shell === true,
      ...opts
    });
    p.on('exit', code => (code === 0 ? resolveRun() : rejectRun(new Error(`${spec.cmd} exited ${code}`))));
    p.on('error', rejectRun);
  });
}

/**
 * web/src 下最新的源文件修改时间 (ms)。用来判断 dist 是否陈旧。
 * node_modules / .git 跳过; 单个文件读不到 (遍历期间被删) 忽略。
 */
function newestSourceMtime(dir) {
  if (!existsSync(dir)) return null;
  let newest = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (newest === null || mtime > newest) newest = mtime;
        } catch {
          // 文件在遍历期间被删 — 忽略, 不影响判断
        }
      }
    }
  }
  return newest;
}

const forceRebuild = ['1', 'true', 'yes'].includes(
  (process.env.ADDASHBOARD_REBUILD_WEB || '').toLowerCase()
);

if (forceRebuild) {
  console.log('[start-prod] ADDASHBOARD_REBUILD_WEB is set — rebuilding center/web unconditionally');
  try {
    await run(npmSpec(['run', 'build:web', '--workspace=center']), { cwd: root });
  } catch (err) {
    console.error(`[start-prod] FATAL: web build failed: ${err.message}`);
    console.error('[start-prod] hint: production installs use `npm install --omit=dev` — vite is NOT');
    console.error('[start-prod]       available there, so the bundle has to be built BEFORE packaging');
    console.error('[start-prod]       (npm run build:web --workspace=center on the build machine).');
    process.exit(1);
  }
} else if (!existsSync(distIndex)) {
  console.log('[start-prod] center/dist missing — running build:web...');
  try {
    await run(npmSpec(['run', 'build:web', '--workspace=center']), { cwd: root });
  } catch (err) {
    console.error(`[start-prod] FATAL: web build failed: ${err.message}`);
    console.error('[start-prod] hint: production installs use `npm install --omit=dev` — vite is NOT');
    console.error('[start-prod]       available there, so the bundle has to be built BEFORE packaging');
    console.error('[start-prod]       (npm run build:web --workspace=center on the build machine).');
    process.exit(1);
  }
} else {
  // dist 在, 但可能比源文件旧 —— 只告警, 不自动重建 (见文件头 M1)。
  const srcMtime = newestSourceMtime(webSrc);
  const distMtime = statSync(distIndex).mtimeMs;
  if (srcMtime && srcMtime > distMtime) {
    console.warn('[start-prod] WARNING: center/dist is older than center/web/src — the served UI may be stale.');
    console.warn('[start-prod]          rebuild with: npm run build:web --workspace=center');
    console.warn('[start-prod]          (or set ADDASHBOARD_REBUILD_WEB=1 to rebuild on every start)');
  }
}

// 构建产物必须真的在 —— 否则服务会以"页面 404 / 白屏"的形式跑起来。
if (!existsSync(distIndex)) {
  console.error(`[start-prod] FATAL: ${distIndex} is still missing — refusing to start the server.`);
  process.exit(1);
}

console.log('[start-prod] starting center server');
try {
  await run(npmSpec(['start', '--workspace=center']), { cwd: root });
} catch (err) {
  console.error(`[start-prod] center server exited abnormally: ${err.message}`);
  process.exit(1);
}
