// RegistryClient — fetches a versioned package index from an HTTPS registry
// and downloads individual package zip files. Caches the index to disk for
// 1 hour by default (force=true bypasses cache).
//
// Security:
//   - Requires HTTPS for the registry URL (HTTP is a config error).
//   - Validates the index against the AJV-compiled registry-index schema.
//   - Verifies sha256 of every downloaded package when the index entry
//     provides one (registry is "open trust" — no signature verification
//     in v1; sha256 is a best-effort integrity check).
//
// Errors thrown as PkgError with codes:
//   PKG_REGISTRY_UNREACHABLE  — HTTP non-2xx on index or download
//   PKG_REGISTRY_INVALID      — index does not pass schema
//   PKG_CHECKSUM_MISMATCH     — sha256 mismatch
//   PKG_NOT_FOUND             — package name not in index
//
// Consumed by:
//   - center/src/packages/installer.js (Task 4) — installPackage(db, {registry, packageRef})
//   - Task 6 REST API admin install endpoint
//   - Task 7 agent pulls via /api/agent/packages (no direct registry access)

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { PkgError } from './errors.js';
import indexSchema from './registry-index.schema.json' with { type: 'json' };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateIndex = ajv.compile(indexSchema);

// Exported for tests (Task 9) — callers should use RegistryClient.fetchIndex().
export function validateRegistryIndex(json) {
  const valid = validateIndex(json);
  return { valid, errors: valid ? [] : (validateIndex.errors || []) };
}

const INDEX_CACHE_TTL_MS = 3600_000; // 1 hour
const INDEX_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export class RegistryClient {
  constructor({ baseUrl, cacheDir, logger, fetchFn = globalThis.fetch }) {
    if (!baseUrl) {
      throw new PkgError('PKG_VALIDATION_FAILED', 'baseUrl is required');
    }
    const isHttps = baseUrl.startsWith('https://');
    const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(baseUrl + '/');
    if (!isHttps && !isLoopback) {
      throw new PkgError('PKG_VALIDATION_FAILED', 'registry must be HTTPS (http allowed only for 127.0.0.1/localhost loopback)');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cacheDir = cacheDir;
    this.logger = logger;
    this.fetch = fetchFn;
    mkdirSync(cacheDir, { recursive: true });
  }

  async fetchIndex(force = false) {
    const cachePath = join(this.cacheDir, 'index.json');
    if (!force && existsSync(cachePath)) {
      const stat = statSync(cachePath);
      const age = Date.now() - stat.mtimeMs;
      if (age < INDEX_CACHE_TTL_MS) {
        return JSON.parse(readFileSync(cachePath, 'utf8'));
      }
    }
    const res = await this.fetch(`${this.baseUrl}/index.json`, {
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new PkgError('PKG_REGISTRY_UNREACHABLE', `HTTP ${res.status}`);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new PkgError('PKG_REGISTRY_INVALID', `index.json is not valid JSON: ${e.message}`);
    }
    if (!validateIndex(json)) {
      throw new PkgError('PKG_REGISTRY_INVALID', JSON.stringify(validateIndex.errors));
    }
    writeFileSync(cachePath, text);
    return json;
  }

  async downloadPackageByName(name) {
    const idx = await this.fetchIndex();
    const pkg = idx.packages.find((p) => p.name === name);
    if (!pkg) throw new PkgError('PKG_NOT_FOUND', name);
    const versionEntry = pkg.versions.find((v) => v.version === pkg.latestVersion);
    if (!versionEntry) {
      throw new PkgError('PKG_REGISTRY_INVALID', `latestVersion ${pkg.latestVersion} not in versions for ${name}`);
    }
    return this.downloadPackage(name, versionEntry);
  }

  async downloadPackage(name, versionEntry) {
    const url = `${this.baseUrl}/${versionEntry.package}`;
    const res = await this.fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new PkgError('PKG_REGISTRY_UNREACHABLE', `HTTP ${res.status} downloading ${versionEntry.package}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (versionEntry.sha256) {
      const actual = createHash('sha256').update(buf).digest('hex');
      if (actual !== versionEntry.sha256) {
        throw new PkgError(
          'PKG_CHECKSUM_MISMATCH',
          `expected ${versionEntry.sha256}, got ${actual} for ${name} ${versionEntry.version}`
        );
      }
    }
    return buf;
  }
}
