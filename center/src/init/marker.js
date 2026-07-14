// Init-complete marker: written on /finalize success, checked on boot.
// Two redundant stores so an attacker (or operator mistake) that wipes one
// cannot re-trigger the wizard without explicit action on the other:
//
//   1. File at <installPath>/.initialized (cross-platform, easy to inspect)
//   2. Windows registry HKLM\SOFTWARE\ADDashboard\Initialized (operator-only)
//
// Boot: if EITHER store shows the marker, needsInit is hard-locked to false.
// Recovery (re-run wizard): operator must explicitly clear both stores AND
// remove appsettings.json (or use the runbook's "delete admin user" path,
// which only works if the marker is also cleared).

import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const REG_KEY = 'HKLM\\SOFTWARE\\ADDashboard';
const REG_VALUE = 'Initialized';

// Default exec shim. Override via _exec in tests to avoid spawning reg.exe.
async function defaultExec(args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('reg.exe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function regAdd(_exec = defaultExec) {
  return _exec(['add', REG_KEY, '/v', REG_VALUE, '/t', 'REG_DWORD', '/d', '1', '/f']);
}

async function regDelete(_exec = defaultExec) {
  return _exec(['delete', REG_KEY, '/v', REG_VALUE, '/f']);
}

async function regQuery(_exec = defaultExec) {
  return _exec(['query', REG_KEY, '/v', REG_VALUE]);
}

function isWindows() {
  return process.platform === 'win32';
}

export async function writeMarker(installPath, _exec = defaultExec) {
  const file = join(installPath, '.initialized');
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString() }, null, 2));
  if (isWindows()) {
    const r = await regAdd(_exec);
    if (r.code !== 0) {
      // Registry write failed — file marker still stands. Log via stderr.
      console.error(`marker: registry write failed (code ${r.code}); file marker at ${file}`);
    }
  }
}

export async function clearMarker(installPath, _exec = defaultExec) {
  const file = join(installPath, '.initialized');
  try { unlinkSync(file); } catch { /* may not exist */ }
  if (isWindows()) {
    await regDelete(_exec); // ignore result — value may not exist
  }
}

export async function hasMarker(installPath, _exec = defaultExec) {
  const file = join(installPath, '.initialized');
  if (existsSync(file)) {
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8'));
      if (meta && typeof meta.at === 'string') return true;
    } catch { /* malformed — fall through */ }
  }
  if (isWindows()) {
    const r = await regQuery(_exec);
    if (r.code === 0 && r.stdout.includes(REG_VALUE)) return true;
  }
  return false;
}

// Resolve the install dir from a config file path. Falls back to dirname of
// the config path so the marker lives alongside appsettings.json.
export function installPathFromConfigPath(configPath) {
  return dirname(configPath);
}