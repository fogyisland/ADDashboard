// read-center-ports.mjs — read the centre's live config from system_config.
//
// Usage:
//   node read-center-ports.mjs <path-to-appsettings.json>
//
// Prints JSON to stdout:
//   { listenPort, heartbeatPort, reportPort, agentToken,
//     tokenSource: "system_config" | "appsettings" | "none",
//     source: "system_config" | "defaults", hostname: "..." }
//
// Why a separate helper (instead of reading directly in the .ps1)?
//   - PowerShell can't easily speak the MySQL protocol on Windows without
//     an installed mysql.exe (which we don't assume).
//   - The .ps1 stays thin: it spawns node, captures stdout, parses JSON.
//   - Failures (bad config / connection refused / missing rows) surface as
//     a non-zero exit + a single-line stderr message — easy to test from
//     Pester.
//
// R34.1: This is the seam that prevents the round-34 silent-stop
// incident from recurring. The mock daemon defaults CENTER_URL/REPORT_URL
// to 8081/8082; if the operator changed those via the admin UI, those
// baked-in defaults silently miss the live ports and the dashboard's
// "最近报告" column freezes at the last-known value. This script reads
// the live ports and the .ps1 passes them as env vars to the daemon.
//
// R41: also read agent_token_current — appsettings.json's `agentToken` is
// only the LEGACY bundle/fallback token (see agent-token.js FALLBACK_BUNDLE_SQL).
// The running centre authoritatively reads system_config.agent_token_current
// for every request, so a daemon started with the appsettings value gets 401
// on every heartbeat and silently drifts. The helper now returns the live
// token too; the .ps1 prefers it and only falls back to appsettings if the
// DB row is missing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

const DEFAULT_LISTEN    = 8080;
const DEFAULT_HEARTBEAT = 8081;
const DEFAULT_REPORT    = 8082;

function die(msg, code = 1) {
  process.stderr.write(`read-center-ports: ${msg}\n`);
  process.exit(code);
}

const appsettingsPath = process.argv[2];
if (!appsettingsPath) die('missing argument: <path-to-appsettings.json>');

let cfg;
try {
  cfg = JSON.parse(readFileSync(resolve(appsettingsPath), 'utf8'));
} catch (e) {
  die(`cannot read appsettings.json: ${e.message}`);
}
const dbCfg = cfg?.db?.mysql;
if (!dbCfg?.host || !dbCfg?.database) {
  die('appsettings.json missing db.mysql.host or db.mysql.database');
}

let conn;
try {
  conn = await mysql.createConnection({
    host: dbCfg.host,
    port: dbCfg.port ?? 3306,
    user: dbCfg.user,
    password: dbCfg.password,
    database: dbCfg.database,
    // round-15: pin UTC so DATETIME columns round-trip with the strings
    // we wrote via toMysqlDatetime(). mysql2's default was session-tz.
    timezone: 'Z',
    connectTimeout: 5000
  });

  const [rows] = await conn.query(
    "SELECT config_key, config_value FROM system_config WHERE config_key IN (?, ?, ?, ?)",
    ['listenPort', 'heartbeat_port', 'report_port', 'agent_token_current']
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.config_key, r.config_value]));

  // Read from DB or fall back to defaults. Important: never silently
  // lie about where a value came from — the .ps1 prints the source so
  // operators can see at a glance whether the centre has explicit
  // overrides in place.
  const hasOverrides = rows.some(r => r.config_key !== 'agent_token_current');
  const hasToken = !!byKey.agent_token_current;
  const appsettingsToken = typeof cfg.agentToken === 'string' ? cfg.agentToken : '';
  const result = {
    listenPort:     Number(byKey.listenPort)     || DEFAULT_LISTEN,
    heartbeatPort:  Number(byKey.heartbeat_port)  || DEFAULT_HEARTBEAT,
    reportPort:     Number(byKey.report_port)     || DEFAULT_REPORT,
    // R41: agent token. Live DB value wins; fall back to appsettings.json's
    // legacy bundle value (the centre also reads it as a last-ditch
    // fallback before auth fails — see agent-token.js). `tokenSource` lets
    // the .ps1 print provenance so an operator can spot if the live row
    // ever goes missing.
    agentToken:     byKey.agent_token_current || appsettingsToken,
    tokenSource:    hasToken ? 'system_config' : (appsettingsToken ? 'appsettings' : 'none'),
    source:         hasOverrides ? 'system_config' : 'defaults',
    hostname:       dbCfg.host
  };
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (e) {
  die(`mysql error: ${e.message}`);
} finally {
  if (conn) await conn.end().catch(() => {});
}