import { existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const centerDir  = resolve(bundleRoot, 'center');
const agentDir   = resolve(bundleRoot, 'agent');
const frontendDir = resolve(bundleRoot, 'frontend');
const frontendDist = resolve(frontendDir, 'dist');
const centerDist  = resolve(centerDir, 'dist');

function log(msg) { console.log(`[green] ${msg}`); }

function run(cmd, args, opts) {
  return new Promise((resolveRun, rejectRun) => {
    log(`$ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd=${opts.cwd})` : ''}`);
    const p = spawn(cmd, args, { ...opts, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${cmd} exited ${code}`)));
  });
}

if (!existsSync(resolve(centerDir, 'node_modules'))) {
  log('center/node_modules missing — installing center deps');
  await run('npm', ['install', '--omit=dev'], { cwd: centerDir });
}

if (!existsSync(resolve(frontendDir, 'node_modules'))) {
  log('frontend/node_modules missing — installing frontend deps');
  await run('npm', ['install', '--omit=dev'], { cwd: frontendDir });
}

if (!existsSync(resolve(frontendDist, 'index.html'))) {
  log('frontend/dist missing — building frontend');
  await run('npm', ['run', 'build'], { cwd: frontendDir });
}

if (existsSync(centerDist)) rmSync(centerDist, { recursive: true, force: true });
mkdirSync(centerDist, { recursive: true });
cpSync(frontendDist, centerDist, { recursive: true });
log(`mirrored frontend/dist → center/dist`);

if (!existsSync(resolve(agentDir, 'node_modules'))) {
  log('agent/node_modules missing — installing agent deps (optional)');
  try {
    await run('npm', ['install', '--omit=dev'], { cwd: agentDir });
  } catch (err) {
    log(`agent deps install failed (non-fatal: ${err.message}). Green version will start center only.`);
  }
}

log('starting center on :8080 (Ctrl+C to stop)');
const child = spawn(process.execPath, ['server.js'], {
  cwd: centerDir,
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
process.on('SIGINT',  () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));