// start-prod: build the web bundle (vite) on cold start, then start the
// Express server from center/. center/dist/ is the single canonical output
// location — vite outputs there directly via outDir='../dist' in
// center/web/vite.config.js. No copy step.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const centerDist = resolve(root, 'center/dist');

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`${cmd} exited ${code}`)));
    p.on('error', rejectRun);
  });
}

if (!existsSync(resolve(centerDist, 'index.html'))) {
  console.log('[start-prod] center/dist missing — running build:web...');
  await run('npm', ['run', 'build:web', '--workspace=center'], { cwd: root });
}

console.log('[start-prod] starting center server');
await run('npm', ['start', '--workspace=center'], { cwd: root });