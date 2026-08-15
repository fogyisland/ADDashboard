import { existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDist = resolve(root, 'frontend/dist');
const centerDist = resolve(root, 'center/dist');
const centerCwd = resolve(root, 'center');

if (!existsSync(resolve(frontendDist, 'index.html'))) {
  console.log('[start-prod] frontend/dist missing — running build...');
  await run('npm', ['run', 'build:frontend'], { cwd: root });
}

if (existsSync(centerDist)) rmSync(centerDist, { recursive: true, force: true });
mkdirSync(centerDist, { recursive: true });
cpSync(frontendDist, centerDist, { recursive: true });
console.log('[start-prod] copied frontend/dist → center/dist');

const child = spawn(process.execPath, ['server.js'], {
  cwd: centerCwd,
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

function run(cmd, args, opts) {
  return new Promise((resolveRun, rejectRun) => {
    const p = spawn(cmd, args, { ...opts, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${cmd} exited ${code}`)));
  });
}