// Network introspection helpers. Used by admin.js GET /api/admin/config to
// expose the server's primary IPv4 to ConfigView — the frontend uses this as
// the fallback host when `access_domain` is empty (operator didn't set a
// friendly hostname, so client + agent URLs point at the server's IP).
//
// `os.networkInterfaces()` returns one entry per interface with an array of
// address objects. We pick the first non-internal IPv4 address we find. The
// order of iteration is not formally guaranteed by Node, but on every
// supported platform the loopback interface comes first — so we explicitly
// skip "127.0.0.1" / "::1" via the `internal` flag and prefer site-local
// addresses (10.x / 172.16-31.x / 192.168.x) over link-local fallbacks.
//
// Returns '127.0.0.1' as the final fallback so callers always get a usable
// string even on a system with no external network (CI, sandbox). This
// matches the historical default that operators expect to see.

import { networkInterfaces } from 'node:os';

export function getPrimaryIPv4() {
  const interfaces = networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const addr of interfaces[name] || []) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      candidates.push({ name, address: addr.address });
    }
  }
  if (candidates.length === 0) return '127.0.0.1';
  // Prefer RFC1918 site-local addresses (10/8, 172.16/12, 192.168/16) — these
  // are the addresses an operator running the dashboard on a private network
  // actually wants to publish. Anything else (public routable IPs, link-local
  // 169.254/16) is a last-resort fallback.
  const SITE_LOCAL = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const siteLocal = candidates.find(c => SITE_LOCAL.test(c.address));
  return (siteLocal || candidates[0]).address;
}