// Init-complete marker: written on /finalize success, checked on boot.
// Two redundant stores so an attacker (or operator mistake) that wipes one
// cannot re-trigger the wizard without explicit action on the other:
//
//   1. File at <installPath>/.env with ADDASHBOARD_INITIALIZED=1 (env-var
//      format, cross-platform, easy to inspect / edit / script around)
//   2. Windows registry HKLM\SOFTWARE\ADDashboard\Initialized (operator-only)
//
// Boot: if EITHER store shows the marker, needsInit is hard-locked to false.
// Recovery (re-run wizard): operator must explicitly clear both stores AND
// remove appsettings.json (or use the runbook's "delete admin user" path,
// which only works if the marker is also cleared).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REG_KEY = 'HKLM\\SOFTWARE\\ADDashboard';
const REG_VALUE = 'Initialized';
const ENV_VAR = 'ADDASHBOARD_INITIALIZED';
const ENV_AT = 'ADDASHBOARD_INITIALIZED_AT';
const ENV_HEADER = '# AD Dashboard init-complete marker. To re-run the wizard, delete the lines below AND clear the registry value AND remove appsettings.json.';

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

function envFilePath(installPath) {
  return join(installPath, '.env');
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function serializeEnv(vars) {
  return ENV_HEADER + '\n' + Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

export async function writeMarker(installPath, _exec = defaultExec) {
  const file = envFilePath(installPath);
  const existing = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  existing[ENV_VAR] = '1';
  existing[ENV_AT] = new Date().toISOString();
  writeFileSync(file, serializeEnv(existing));
  if (isWindows()) {
    const r = await regAdd(_exec);
    if (r.code !== 0) {
      console.error(`marker: registry write failed (code ${r.code}); .env marker at ${file}`);
    }
  }
}

export async function clearMarker(installPath, _exec = defaultExec) {
  const file = envFilePath(installPath);
  if (existsSync(file)) {
    try {
      const parsed = parseEnv(readFileSync(file, 'utf8'));
      delete parsed[ENV_VAR];
      delete parsed[ENV_AT];
      const remaining = Object.keys(parsed).filter(k => k !== ENV_VAR && k !== ENV_AT);
      if (remaining.length === 0) {
        unlinkSync(file);
      } else {
        writeFileSync(file, serializeEnv(parsed));
      }
    } catch {
      unlinkSync(file);
    }
  }
  if (isWindows()) {
    await regDelete(_exec);
  }
}

export async function hasMarker(installPath, _exec = defaultExec) {
  const file = envFilePath(installPath);
  if (existsSync(file)) {
    try {
      const parsed = parseEnv(readFileSync(file, 'utf8'));
      if (parsed[ENV_VAR] === '1' || parsed[ENV_VAR] === 'true') return true;
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