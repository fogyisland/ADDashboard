// RegistryClient tests — serve a tiny local HTTP server (Node http) that
// returns a fake index.json + zip buffer. Exercises:
//   1. fetchIndex returns parsed JSON
//   2. cache hit on second fetchIndex call (no network)
//   3. downloadPackageByName returns Buffer with sha256 verify
//   4. sha256 mismatch rejects with PKG_CHECKSUM_MISMATCH

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RegistryClient } from '../../src/packages/registry.js';
import { PkgError } from '../../src/packages/errors.js';

function startTestServer({ index, zips }) {
  return new Promise((resolve) => {
    const handlers = {
      'GET /index.json': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(index));
      },
    };
    // Pre-compute zip handler by filename
    for (const [name, buf] of Object.entries(zips)) {
      handlers[`GET /${name}`] = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(buf);
      };
    }
    const server = http.createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      const h = handlers[key];
      if (!h) {
        res.writeHead(404);
        res.end();
        return;
      }
      h(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `https://127.0.0.1:${port}`, server });
    });
  });
}

describe('RegistryClient', () => {
  let server, baseUrl, cacheDir, zips, index;
  let pkgZip, pkgSha256;

  before(async () => {
    pkgZip = Buffer.from('fake-zip-content-for-pkg-1.0.0');
    pkgSha256 = createHash('sha256').update(pkgZip).digest('hex');
    zips = {
      'pkg-1.0.0.zip': pkgZip,
      'pkg-bad.zip': Buffer.from('mismatched-content'),
    };
    index = {
      version: 1,
      updatedAt: '2026-07-29T00:00:00Z',
      packages: [
        {
          name: 'pkg',
          latestVersion: '1.0.0',
          type: 'gauge',
          versions: [
            {
              version: '1.0.0',
              package: 'pkg-1.0.0.zip',
              sha256: pkgSha256,
              size: pkgZip.length,
              releasedAt: '2026-07-29T00:00:00Z',
            },
          ],
        },
      ],
    };
    server = await startTestServer({ index, zips });
    // Loopback http is permitted by RegistryClient constructor for tests;
    // production deployments must use HTTPS.
    baseUrl = server.url.replace('https://', 'http://');
    cacheDir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  });

  after(() => {
    if (server) server.server.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetchIndex returns parsed JSON', async () => {
    const c = new RegistryClient({ baseUrl, cacheDir });
    const idx = await c.fetchIndex(true);
    assert.equal(idx.version, 1);
    assert.equal(idx.packages.length, 1);
    assert.equal(idx.packages[0].name, 'pkg');
  });

  it('fetchIndex cache hit on second call (no network)', async () => {
    const c = new RegistryClient({ baseUrl, cacheDir });
    await c.fetchIndex(true); // populate cache
    // Now close the server so any network call would fail
    await new Promise((r) => server.server.close(r));
    server = null;
    const idx = await c.fetchIndex(false); // should hit cache
    assert.equal(idx.version, 1);
    assert.equal(idx.packages[0].name, 'pkg');
  });

  it('downloadPackageByName returns Buffer with sha256 verify', async () => {
    // Restart server for download test
    server = await startTestServer({ index, zips });
    baseUrl = server.url.replace('https://', 'http://');
    const c = new RegistryClient({ baseUrl, cacheDir });
    const buf = await c.downloadPackageByName('pkg');
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, pkgZip.length);
    assert.equal(buf.toString('utf8'), 'fake-zip-content-for-pkg-1.0.0');
  });

  it('rejects sha256 mismatch on downloadPackage', async () => {
    // Build an index that points to a zip with wrong sha256
    const badIndex = {
      version: 1,
      updatedAt: '2026-07-29T00:00:00Z',
      packages: [
        {
          name: 'badpkg',
          latestVersion: '1.0.0',
          type: 'gauge',
          versions: [
            {
              version: '1.0.0',
              package: 'pkg-bad.zip',
              sha256: '0000000000000000000000000000000000000000000000000000000000000000',
              size: 17,
              releasedAt: '2026-07-29T00:00:00Z',
            },
          ],
        },
      ],
    };
    const badServer = await startTestServer({ index: badIndex, zips });
    const badUrl = badServer.url.replace('https://', 'http://');
    // Fresh cache dir so downloadPackageByName doesn't reuse the cached
    // index from earlier tests.
    const badCacheDir = mkdtempSync(join(tmpdir(), 'registry-bad-'));
    const c = new RegistryClient({ baseUrl: badUrl, cacheDir: badCacheDir });
    await assert.rejects(
      () => c.downloadPackageByName('badpkg'),
      (err) => err instanceof PkgError && err.code === 'PKG_CHECKSUM_MISMATCH'
    );
    badServer.server.close();
    rmSync(badCacheDir, { recursive: true, force: true });
  });
});
