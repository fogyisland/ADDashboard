// Parse "user:password@host:port" (or "user@host", "host", etc.) from an env var.
// Defaults: port 3306 for mysql, 1433 for mssql. Throws on missing key.
export function parseTestUrl(envKey, { defaultPort }) {
  const raw = process.env[envKey];
  if (!raw) throw new Error(`${envKey} not set`);
  let user = null, password = '', host = raw, port = defaultPort;
  const atIdx = raw.lastIndexOf('@');
  if (atIdx >= 0) {
    const creds = raw.slice(0, atIdx);
    host = raw.slice(atIdx + 1);
    const colonIdx = creds.indexOf(':');
    if (colonIdx >= 0) {
      user = creds.slice(0, colonIdx);
      password = creds.slice(colonIdx + 1);
    } else {
      user = creds;
    }
  }
  const portIdx = host.lastIndexOf(':');
  if (portIdx >= 0 && /^\d+$/.test(host.slice(portIdx + 1))) {
    port = parseInt(host.slice(portIdx + 1), 10);
    host = host.slice(0, portIdx);
  }
  return { user, password, host, port };
}
