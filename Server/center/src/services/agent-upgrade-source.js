// R158.48 (2026-10-06) — agent auto-update source reader.
//
// Operator directive 2026-10-06:
//   "在这里能否增加一个 agent 自动更新相关操作？所有的数据通过自动同步
//    自动下载到本地替换呢？"
// 3 explicit choices:
//   - scope: only JS code (agent.js + src/*.js). Exclude PS1/data/logs/etc.
//   - transport: standalone GET /api/agent/upgrade (agent pulls on heartbeat
//     envelope that says upgradeAvailable=true)
//   - source: server.js boot reads <repoRoot>/agent/build-manifest.json
//
// This module is the boot-time reader. Mirrors the centre's own
// build-manifest boot fingerprint at server.js:298-309 (R119.B /
// R119.B.UPGRADE) — same pattern, parallel source path. The result is
// cached at module scope (closure-captured `let _agentUpgradeSource = ...`
// inside agent-upgrade.js, set once at boot) and refreshed only on process
// restart — the operator must `nssm restart center` to pick up new agent
// code. This is intentional: simple, predictable, no mid-flight cache
// invalidation race.
//
// File selection rules (matches user "仅 JS 代码"):
//   INCLUDE:  agent.js (carries VERSION constant) + src/**/*.js
//   INCLUDE:  build-manifest.json (agent needs to know its own build metadata)
//   EXCLUDE:  scripts/*.ps1     (PowerShell scripts — user explicit "仅 JS 代码")
//   EXCLUDE:  data/, logs/, node_modules/, publish/, *.tmp
//   EXCLUDE:  appsettings.json  (operator-editable runtime config, must not be overwritten)
//   EXCLUDE:  *.json (except build-manifest.json)
//   EXCLUDE:  *.md, *.log, *.ps1, *.psm1
//
// Per-file shape: {path (relative to agent root), sha256 (hex), base64, bytes}.
// Total bundle size cap = 50 MB (webApp body limit, server.js:95). If cap hit
// → return null + log error, agent upgrades will never trigger until the
// operator slims the bundle.

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

// Cap raw bytes — 50 MB matches server.js webApp body limit. If exceeded,
// agent upgrade is permanently disabled until the bundle is slimmed.
const BUNDLE_BYTE_CAP = 50 * 1024 * 1024;

const INCLUDE_NAME_RULES = [
  // exact matches: agent.js + build-manifest.json at root
  (relPath) => relPath === 'agent.js' || relPath === 'build-manifest.json',
  // src/**/*.js
  (relPath) => relPath.startsWith(`src${sep}`) && relPath.endsWith('.js')
];

function shouldInclude(relPath) {
  return INCLUDE_NAME_RULES.some((rule) => {
    try { return rule(relPath); }
    catch { return false; }
  });
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Recursive directory walker. Skips EXCLUDED_DIRS entirely (cheaper than
// per-file filters — names often the path before reading). Returns string[]
// (absolute paths).
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'data',
  'logs',
  'publish',
  '.git',
  '.upgrade-staging',
  'dist',
  'coverage'
]);

function walkAgentTree(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Permission denied / broken symlink — best-effort continue
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        const rel = relative(rootDir, abs);
        if (shouldInclude(rel)) out.push(abs);
      }
    }
  }
  return out;
}

// Read the agent's build-manifest.json. Fallback to agent/package.json if
// build-manifest absent (mirrors server.js:298-309 same-shape behaviour:
// version got as fallback when manifest unreadable). If neither available, log
// warn and return null.
function readAgentVersionFromMeta(rootDir, logger) {
  const manifestPath = join(rootDir, 'build-manifest.json');
  const packageJsonPath = join(rootDir, 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.version === 'string') {
        return {
          version: parsed.version,
          buildTime: parsed.buildTime ?? null,
          gitCommit: parsed.gitCommit ?? null
        };
      }
    } catch (err) {
      logger?.warn?.({ err: err.message, manifestPath }, 'agent build-manifest.json parse failed');
    }
  }
  if (existsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.version === 'string') {
        return {
          version: parsed.version,
          buildTime: null,
          gitCommit: null
        };
      }
    } catch (err) {
      logger?.warn?.({ err: err.message, packageJsonPath }, 'agent package.json parse failed');
    }
  }
  return null;
}

// Read agentRoot (assumed to be `<repoRoot>/agent`). Returns
// {available, version, buildTime, gitCommit, files: [{path, sha256, base64, bytes}]}
// or null if unavailable (path missing / version unparsable / bundle > cap).
//
// `logger` is optional; errors log warn when present.
export async function getAgentUpgradeSource(agentRoot, logger = null) {
  if (!agentRoot || typeof agentRoot !== 'string') {
    logger?.error?.({ agentRoot }, 'agent-upgrade-source: agentRoot path invalid');
    return null;
  }
  if (!existsSync(agentRoot)) {
    logger?.warn?.({ agentRoot }, 'agent-upgrade-source: agent directory missing; upgradeAvailable will be false for all heartbeats');
    return null;
  }
  const meta = readAgentVersionFromMeta(agentRoot, logger);
  if (!meta) {
    logger?.warn?.({ agentRoot }, 'agent-upgrade-source: agent version unreadable; upgradeAvailable will be false');
    return null;
  }

  const filePaths = walkAgentTree(agentRoot);
  const files = [];
  let totalBytes = 0;

  for (const absPath of filePaths) {
    let stat;
    try {
      stat = statSync(absPath);
    } catch (err) {
      logger?.warn?.({ err: err.message, path: absPath }, 'agent-upgrade-source: stat failed; skipping');
      continue;
    }
    if (totalBytes + stat.size > BUNDLE_BYTE_CAP) {
      logger?.error?.({
        capBytes: BUNDLE_BYTE_CAP,
        currentBytes: totalBytes,
        offendingPath: relative(agentRoot, absPath),
        offendingSize: stat.size
      }, 'agent-upgrade-source: bundle exceeds 50MB cap; upgradeAvailable will be false until bundle is slimmed');
      return null;
    }
    let bytes;
    try {
      bytes = readFileSync(absPath);
    } catch (err) {
      logger?.warn?.({ err: err.message, path: absPath }, 'agent-upgrade-source: read failed; skipping');
      continue;
    }
    const rel = relative(agentRoot, absPath).split(sep).join('/');  // Windows backslash → forward slash for portability
    files.push({
      path: rel,
      sha256: sha256Hex(bytes),
      base64: bytes.toString('base64'),
      bytes: bytes.length
    });
    totalBytes += stat.size;
  }

  if (files.length === 0) {
    logger?.warn?.({ agentRoot }, 'agent-upgrade-source: no files matched include rules; upgradeAvailable will be false');
    return null;
  }

  return {
    available: true,
    version: meta.version,
    buildTime: meta.buildTime,
    gitCommit: meta.gitCommit,
    files,
    fileCount: files.length,
    totalBytes
  };
}