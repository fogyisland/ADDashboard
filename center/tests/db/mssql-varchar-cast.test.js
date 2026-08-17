import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';
import { alertEvents } from '../../src/db/sql/alert-events.js';
import { alertOutbox } from '../../src/db/sql/alert-outbox.js';
import { alertRules } from '../../src/db/sql/alert-rules.js';
import { memberServers } from '../../src/db/sql/member-servers.js';
import { serverGroups } from '../../src/db/sql/server-groups.js';

// SQL Server raises Msg 468 ("Cannot resolve collation conflict between
// X and Y") when a VARCHAR column is compared to a NVARCHAR parameter
// — which is what the `mssql` npm driver binds every JS string as by
// default (NVarChar). The fix is to CAST each `?` placeholder that lands
// in a VARCHAR column with the column's exact width. NVARCHAR, INT, BIT,
// DATETIME2, DECIMAL, etc. do NOT need this wrapping.
//
// Schema ground-truth (db/migrations/mssql/*.sql):
//   VARCHAR(64):  ad_agent_port_status.agent_id, ad_lockout_events.agent_id,
//                 schema_migrations.applied_by
//   VARCHAR(128): ad_lockout_events.dc_name, ad_member_servers.hostname,
//                 ad_server_group_members.hostname, ad_server_groups.group_name,
//                 ad_member_server_packages.hostname, alert_rules.hostname,
//                 alert_events.hostname
//   VARCHAR(255): schema_migrations.description, schema_migrations.script
//   VARCHAR(256): ad_server_groups.description, alert_rules.name,
//                 ad_lockout_events.target_user_name,
//                 ad_lockout_events.subject_user_name,
//                 ad_lockout_events.subject_domain,
//                 ad_lockout_events.caller_computer_name
//   VARCHAR(16):  ad_member_servers.agent_type, alert_rule_state.state,
//                 schema_migrations.type, schema_migrations.status,
//                 probe_state.port_role, probe_state.status,
//                 sys_config_audit.change_type
//   VARCHAR(32):  ad_member_servers.discovered_via, alert_events.event,
//                 schema_migrations.version
//   VARCHAR(64):  ad_member_servers.ip_address, ad_member_servers.os_version
//   VARCHAR(1024): alert_email_outbox.to_addrs, alert_email_outbox.cc_addrs
//   VARCHAR(256): alert_email_outbox.subject

const sql = buildSql('mssql');

// Helper: every `?` in the SQL that is NOT inside CAST(? AS VARCHAR(N))
// must NOT be adjacent to a VARCHAR column. We count CAST wrappers and
// raw `?` placeholders separately, and verify they line up.
function countCastVarchars(sqlStr) {
  return (sqlStr.match(/CAST\(\?\s+AS\s+VARCHAR\(\d+\)\)/gi) || []).length;
}

function countRawPlaceholders(sqlStr) {
  // Strip CAST(? AS VARCHAR(N)) before counting raw `?` tokens.
  const stripped = sqlStr.replace(/CAST\(\?\s+AS\s+VARCHAR\(\d+\)\)/gi, '');
  return (stripped.match(/\?/g) || []).length;
}

// --- sql.js ---

test('mssql: config.audit.write wraps change_type (VARCHAR(16))', () => {
  const s = sql.config.audit.write;
  // 5 params: config_key, old_value, new_value, changed_by, change_type
  assert.strictEqual(countRawPlaceholders(s), 4, 'unchanged from non-VARCHAR params');
  assert.strictEqual(countCastVarchars(s), 1, 'change_type wrapped');
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(16\)\)/);
});

test('mssql: portStatus.upsertOne wraps agent_id (VARCHAR(64))', () => {
  const s = sql.portStatus.upsertOne;
  // 5 params: agent_id, port, ok, latency_ms, last_checked_at
  assert.strictEqual(countRawPlaceholders(s), 4);
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(64\)\)/);
});

test('mssql: lockout.upsertEvent wraps all 6 VARCHAR params', () => {
  const s = sql.lockout.upsertEvent;
  // 9 params: occurred_at, collected_at, agent_id, dc_name, event_record_id,
  //           target_user_name, subject_user_name, subject_domain, caller_computer_name
  // VARCHAR: agent_id(64), dc_name(128), target_user_name(256),
  //          subject_user_name(256), subject_domain(256), caller_computer_name(256)
  assert.strictEqual(countRawPlaceholders(s), 3, 'DATETIME2 + BIGINT = 3 unchanged');
  assert.strictEqual(countCastVarchars(s), 6);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(64\)\)/);   // agent_id
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);  // dc_name
  // 4 x VARCHAR(256): target_user_name, subject_user_name, subject_domain, caller_computer_name
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(256\)\)/gi) || []).length, 4);
});

test('mssql: lockout.search wraps all 6 VARCHAR params (3 columns × 2 ?)', () => {
  const s = sql.lockout.search;
  // WHERE cols: occurred_at, target_user_name, dc_name, caller_computer_name
  // 3 VARCHAR cols × 2 params each = 6 VARCHAR casts
  assert.strictEqual(countCastVarchars(s), 6);
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(256\)\)/gi) || []).length, 4);
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(128\)\)/gi) || []).length, 2);
});

test('mssql: schemaMigrations.upsert wraps 6 VARCHAR params', () => {
  const s = sql.schemaMigrations.upsert;
  // 10 params: version(32), description(255), type(16), script(255), checksum,
  //            applied_at, execution_ms, applied_by(64), status(16), error_message
  assert.strictEqual(countRawPlaceholders(s), 4, 'NVARCHAR/CHAR/DATETIME2/INT = 4 unchanged');
  assert.strictEqual(countCastVarchars(s), 6);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(32\)\)/);   // version
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(255\)\)/gi) || []).length, 2);  // description, script
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(16\)\)/gi) || []).length, 2);   // type, status
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(64\)\)/);   // applied_by
});

test('mssql: schemaMigrations.findByVersion wraps version (VARCHAR(32))', () => {
  const s = sql.schemaMigrations.findByVersion;
  assert.strictEqual(countRawPlaceholders(s), 0);
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(32\)\)/);
});

test('mssql: schemaMigrations.deleteFailed wraps version (VARCHAR(32))', () => {
  const s = sql.schemaMigrations.deleteFailed;
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(32\)\)/);
});

test('mssql: probeState.upsertRow wraps port_role + status (VARCHAR(16))', () => {
  // upsertRow is a SQL builder function (takes positional args but they're
  // not used in the SQL template — only the placeholder order matters).
  const s = sql.probeState.upsertRow('web', 'healthy', 12, new Date(), new Date(), 0);
  assert.strictEqual(countRawPlaceholders(s), 4, 'INT + DATETIME2 + DATETIME2 + INT = 4');
  assert.strictEqual(countCastVarchars(s), 2);
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(16\)\)/gi) || []).length, 2);
});

// --- alert-events.js ---

test('mssql: alertEvents.insert wraps event + hostname', () => {
  const s = alertEvents.mssql.insert;
  // 4 params: rule_id, event, hostname, detail
  assert.strictEqual(countRawPlaceholders(s), 2, 'rule_id + detail unchanged');
  assert.strictEqual(countCastVarchars(s), 2);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(32\)\)/);   // event
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);  // hostname
});

test('mssql: alertEvents.listByHostname wraps hostname (VARCHAR(128))', () => {
  const s = alertEvents.mssql.listByHostname;
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
});

// --- alert-outbox.js ---

test('mssql: alertOutbox.enqueue wraps to_addrs, cc_addrs, subject', () => {
  const s = alertOutbox.mssql.enqueue;
  // 7 params: alert_event_id, to_addrs, cc_addrs, subject, body_text, body_html, next_attempt_at
  assert.strictEqual(countRawPlaceholders(s), 4);
  assert.strictEqual(countCastVarchars(s), 3);
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(1024\)\)/gi) || []).length, 2);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(256\)\)/);
});

// --- alert-rules.js ---

test('mssql: alertRules.create wraps hostname + name', () => {
  const s = alertRules.mssql.create;
  // 7 params: hostname, name, [condition], for_minutes, cooldown_minutes, recipients, enabled
  assert.strictEqual(countRawPlaceholders(s), 5);
  assert.strictEqual(countCastVarchars(s), 2);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);  // hostname
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(256\)\)/);  // name
});

test('mssql: alertRules.listForHost / listEnabledForHost / listEnabledForHostWithState wrap hostname', () => {
  for (const key of ['listForHost', 'listEnabledForHost', 'listEnabledForHostWithState']) {
    const s = alertRules.mssql[key];
    assert.strictEqual(countCastVarchars(s), 1, `${key} should have 1 CAST`);
    assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
  }
});

test('mssql: alertRules.update wraps name (VARCHAR(256))', () => {
  const s = alertRules.mssql.update;
  // 7 params: name, [condition], for_minutes, cooldown_minutes, recipients, enabled, rule_id
  assert.strictEqual(countRawPlaceholders(s), 6);
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(256\)\)/);
});

test('mssql: alertRules.upsertState wraps state (VARCHAR(16))', () => {
  const s = alertRules.mssql.upsertState;
  // 6 params: rule_id, state, first_hit_at, last_fired_at, last_recovered_at, suppressed_until
  assert.strictEqual(countRawPlaceholders(s), 5);
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(16\)\)/);
});

// --- member-servers.js ---

test('mssql: memberServers.upsert wraps 5 VARCHAR columns', () => {
  const s = memberServers.mssql.upsert;
  // 7 params: hostname(128), site_id, ip_address(64), os_version(64),
  //           agent_type(16), enabled, discovered_via(32)
  assert.strictEqual(countRawPlaceholders(s), 2, 'site_id + enabled unchanged');
  assert.strictEqual(countCastVarchars(s), 5);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);  // hostname
  assert.strictEqual((s.match(/CAST\(\?\s+AS\s+VARCHAR\(64\)\)/gi) || []).length, 2);  // ip_address, os_version
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(16\)\)/);   // agent_type
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(32\)\)/);   // discovered_via
});

test('mssql: memberServers hostname-only WHERE queries wrap hostname', () => {
  for (const key of ['findByHostname', 'delete', 'touchLastSeen', 'touchLastReport']) {
    const s = memberServers.mssql[key];
    assert.strictEqual(countCastVarchars(s), 1, `${key} should wrap once`);
    assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
  }
});

// --- server-groups.js ---

test('mssql: serverGroups.addMember wraps hostname (VARCHAR(128))', () => {
  const s = serverGroups.mssql.addMember;
  // 2 params: group_id, hostname
  assert.strictEqual(countRawPlaceholders(s), 1);
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
});

test('mssql: serverGroups.removeMember wraps hostname', () => {
  const s = serverGroups.mssql.removeMember;
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
});

test('mssql: serverGroups.listGroupsForHostname wraps hostname', () => {
  const s = serverGroups.mssql.listGroupsForHostname;
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
});

test('mssql: serverGroups.upsertPackage wraps hostname (VARCHAR(128))', () => {
  const s = serverGroups.mssql.upsertPackage;
  // 3 params: hostname(128), package_name(NVARCHAR), enabled(BIT)
  assert.strictEqual(countRawPlaceholders(s), 2);
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
});

test('mssql: serverGroups hostname-bearing WHERE queries wrap hostname', () => {
  for (const key of ['removePackage', 'listPackagesForHost', 'touchPackageRun']) {
    const s = serverGroups.mssql[key];
    assert.strictEqual(countCastVarchars(s), 1, `${key} should wrap once`);
    assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
  }
});

test('mssql: serverGroups.create wraps group_name + description', () => {
  const s = serverGroups.mssql.create;
  // 2 params: group_name(128), description(256)
  assert.strictEqual(countRawPlaceholders(s), 0);
  assert.strictEqual(countCastVarchars(s), 2);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(256\)\)/);
});

test('mssql: serverGroups.findByName wraps group_name (VARCHAR(128))', () => {
  const s = serverGroups.mssql.findByName;
  assert.strictEqual(countCastVarchars(s), 1);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
});

test('mssql: serverGroups.update wraps group_name + description', () => {
  const s = serverGroups.mssql.update;
  // 3 params: group_name(128), description(256), group_id(INT)
  assert.strictEqual(countRawPlaceholders(s), 1);
  assert.strictEqual(countCastVarchars(s), 2);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(128\)\)/);
  assert.match(s, /CAST\(\?\s+AS\s+VARCHAR\(256\)\)/);
});
