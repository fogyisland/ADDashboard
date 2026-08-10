// T16: small helper for the non-AD self-register payload.
// Returns { hostname, version, ip } where:
//   hostname — OS hostname (os.hostname())
//   version  — best-effort Windows version string (empty string when unknown)
//   ip       — first non-internal IPv4 from os.networkInterfaces(), '' when none
//
// Lives in its own file so tests can mock it via dynamic import if needed.
// On non-Windows hosts `release()` is still meaningful; we keep the helper
// cross-platform and let the center decide whether to surface the value.

import { hostname, networkInterfaces, release } from 'node:os';

export function getOsInfo() {
  const version = release() || '';
  let ip = '';
  try {
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name] || []) {
        if (i && i.family === 'IPv4' && !i.internal) {
          ip = i.address;
          break;
        }
      }
      if (ip) break;
    }
  } catch {
    ip = '';
  }
  return { hostname: hostname(), version, ip };
}
