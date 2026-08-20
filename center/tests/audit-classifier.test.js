import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CATEGORY, ACTION_SEVERITY, ACTION_LABEL, TARGET_LABEL,
  CATEGORY_ACTIONS, SEVERITY_ACTIONS, classifyAction
} from '../src/services/audit-classifier.js';

test('classifier: ACTION_CATEGORY maps every emitted action to one of three categories', () => {
  const EMITTED = [
    'login', 'login_failed',
    'create_user', 'update_user', 'delete_user',
    'update_config', 'bulk_import_sites', 'bulk_assign_dc_sites',
    'apply_migration', 'reset_failed_migration',
    // 2026-08-20 schema-migrations-upgrade SDD T1+T2: mark_applied /
    // baseline / apply_up_to / upgrade_db — all 'changes' / 'medium'.
    'mark_applied', 'baseline', 'apply_up_to', 'upgrade_db',
    // #167 C1: agent-token rotation + revoke_user_tokens actions.
    'rotate_agent_token', 'commit_agent_token', 'seed_agent_token',
    'auto_expire_agent_token', 'revoke_user_tokens'
  ];
  for (const a of EMITTED) {
    assert.ok(['security', 'changes', 'ops', 'system'].includes(ACTION_CATEGORY.get(a)),
      `action ${a} missing from ACTION_CATEGORY`);
  }
});

test('classifier: classifyAction returns Chinese label + category + severity together', () => {
  const c = classifyAction('login_failed');
  assert.equal(c.label, '登录失败');
  assert.equal(c.category, 'security');
  assert.equal(c.severity, 'high');
});

test('classifier: CATEGORY_ACTIONS.security is exactly the registered security actions', () => {
  assert.deepEqual([...CATEGORY_ACTIONS.get('security')].sort(), [
    'agent_self_register', 'auto_expire_agent_token', 'auto_expire_jwt_secret',
    'commit_agent_token', 'commit_jwt_secret',
    'delete_user', 'disable_builtin_ad_os_baseline', 'login_failed',
    'revoke_user_tokens', 'rotate_agent_token', 'rotate_jwt_secret'
  ]);
});

test('classifier: SEVERITY_ACTIONS.high includes the JWT secret + agent-token rotation actions', () => {
  assert.deepEqual([...SEVERITY_ACTIONS.get('high')].sort(), [
    'auto_expire_agent_token', 'auto_expire_jwt_secret', 'delete_user',
    'disable_builtin_ad_os_baseline', 'login_failed', 'restart_service',
    'revoke_user_tokens', 'rotate_agent_token', 'rotate_jwt_secret'
  ]);
});

test('classifier: SEVERITY_ACTIONS.medium covers all medium-severity changes actions', () => {
  assert.deepEqual([...SEVERITY_ACTIONS.get('medium')].sort(), [
    'agent_self_register', 'apply_migration', 'apply_up_to',
    'baseline', 'bulk_assign_dc_sites',
    'bulk_disable_package_to_group', 'bulk_import_sites', 'bulk_install_package_to_group',
    'commit_agent_token', 'commit_jwt_secret', 'delete_alert_rule',
    'delete_server_group', 'delete_site', 'mark_applied',
    'replace_server_group_members', 'reset_failed_migration',
    'update_config', 'update_user', 'upgrade_db'
  ]);
});

// I9 T7-fix (important): the 4 new jwt_secret actions must NOT fall through
// to the defaults. Each maps to a non-default category that matches the
// existing taxonomy.
test('classifier: I9 jwt_secret actions resolve to non-default categories', () => {
  const cases = [
    { action: 'rotate_jwt_secret',      category: 'security', severity: 'high',   label: '轮换 JWT 签名密钥' },
    { action: 'auto_expire_jwt_secret', category: 'security', severity: 'high',   label: 'JWT 密钥自动过期' },
    { action: 'commit_jwt_secret',      category: 'security', severity: 'medium', label: '提交 JWT 签名密钥' },
    { action: 'seed_jwt_secret',        category: 'system',   severity: 'info',   label: '从 appsettings 初始化 JWT 密钥' }
  ];
  for (const c of cases) {
    const r = classifyAction(c.action);
    assert.equal(r.category, c.category, `${c.action} should map to category ${c.category}`);
    assert.equal(r.severity, c.severity, `${c.action} should map to severity ${c.severity}`);
    assert.equal(r.label,    c.label,    `${c.action} should map to label "${c.label}"`);
  }
});

test('classifier: ACTION_CATEGORY and ACTION_SEVERITY contain all 4 I9 jwt_secret entries', () => {
  for (const a of ['rotate_jwt_secret', 'auto_expire_jwt_secret', 'commit_jwt_secret', 'seed_jwt_secret']) {
    assert.ok(ACTION_CATEGORY.has(a), `${a} must be in ACTION_CATEGORY`);
    assert.ok(ACTION_SEVERITY.has(a), `${a} must be in ACTION_SEVERITY`);
    assert.ok(ACTION_LABEL.has(a),    `${a} must be in ACTION_LABEL`);
  }
});

// #167 C1: parallel to the I9 test above. The 4 agent_token + 1
// revoke_user_tokens actions must NOT fall through to the defaults.
// Each maps to a non-default category that matches the existing
// taxonomy (security/security/security/system for the rotation set;
// security for the user-token revoke).
test('classifier: I3 agent_token actions resolve to non-default categories', () => {
  const cases = [
    { action: 'rotate_agent_token',      category: 'security', severity: 'high',   label: '轮换 Agent 令牌' },
    { action: 'auto_expire_agent_token', category: 'security', severity: 'high',   label: 'Agent 令牌自动过期' },
    { action: 'commit_agent_token',      category: 'security', severity: 'medium', label: '提交 Agent 令牌' },
    { action: 'seed_agent_token',        category: 'system',   severity: 'info',   label: '从 appsettings 初始化 Agent 令牌' }
  ];
  for (const c of cases) {
    const r = classifyAction(c.action);
    assert.equal(r.category, c.category, `${c.action} should map to category ${c.category}`);
    assert.equal(r.severity, c.severity, `${c.action} should map to severity ${c.severity}`);
    assert.equal(r.label,    c.label,    `${c.action} should map to label "${c.label}"`);
  }
});

test('classifier: I1 revoke_user_tokens is high severity security', () => {
  const v = classifyAction('revoke_user_tokens');
  assert.equal(v.category, 'security');
  assert.equal(v.severity, 'high');
  assert.equal(v.label, '撤销用户全部令牌');
});

test('classifier: ACTION_CATEGORY and ACTION_SEVERITY contain all 5 #167 entries', () => {
  for (const a of ['rotate_agent_token', 'auto_expire_agent_token', 'commit_agent_token', 'seed_agent_token', 'revoke_user_tokens']) {
    assert.ok(ACTION_CATEGORY.has(a), `${a} must be in ACTION_CATEGORY`);
    assert.ok(ACTION_SEVERITY.has(a), `${a} must be in ACTION_SEVERITY`);
    assert.ok(ACTION_LABEL.has(a),    `${a} must be in ACTION_LABEL`);
  }
});

test('classifier: unknown action returns the raw action as label + ops/low fallback', () => {
  const c = classifyAction('something_new');
  assert.equal(c.label, 'something_new');
  assert.equal(c.category, 'ops');
  assert.equal(c.severity, 'low');
});

test('classifier: TARGET_LABEL includes system_config / ad_sites / ad_dcs / schema_migrations', () => {
  assert.equal(TARGET_LABEL.get('system_config'),     '系统配置');
  assert.equal(TARGET_LABEL.get('ad_sites'),          '站点目录');
  assert.equal(TARGET_LABEL.get('ad_dcs'),            '域控目录');
  assert.equal(TARGET_LABEL.get('schema_migrations'), '迁移管理');
});

test('classifier: maps are frozen (Object.isFrozen)', () => {
  assert.ok(Object.isFrozen(ACTION_CATEGORY));
  assert.ok(Object.isFrozen(ACTION_SEVERITY));
  assert.ok(Object.isFrozen(ACTION_LABEL));
  assert.ok(Object.isFrozen(TARGET_LABEL));
});

// 2026-08-20 schema-migrations-upgrade SDD T1+T2 (fix round 1): the 4 new
// schema-migration actions must NOT fall through to the 'ops'/'low' fallback.
// Each maps to non-default category/severity/label. The same sibling-SDD
// audit pattern that caught missing entries for the jwt_secret +
// agent_token sets — register new action names whenever they're added.
test('classifier: schema-migrations-upgrade actions resolve to non-default categories', () => {
  const cases = [
    { action: 'mark_applied',  category: 'changes', severity: 'medium', label: '标记已应用' },
    { action: 'baseline',      category: 'changes', severity: 'medium', label: '基线标记' },
    { action: 'apply_up_to',   category: 'changes', severity: 'medium', label: '批量应用到版本' },
    { action: 'upgrade_db',    category: 'changes', severity: 'medium', label: '升级到最新' }
  ];
  for (const c of cases) {
    const r = classifyAction(c.action);
    assert.equal(r.category, c.category, `${c.action} should map to category ${c.category}`);
    assert.equal(r.severity, c.severity, `${c.action} should map to severity ${c.severity}`);
    assert.equal(r.label,    c.label,    `${c.action} should map to label "${c.label}"`);
  }
});

test('classifier: ACTION_CATEGORY and ACTION_SEVERITY contain all 4 schema-migrations-upgrade entries', () => {
  for (const a of ['mark_applied', 'baseline', 'apply_up_to', 'upgrade_db']) {
    assert.ok(ACTION_CATEGORY.has(a), `${a} must be in ACTION_CATEGORY`);
    assert.ok(ACTION_SEVERITY.has(a), `${a} must be in ACTION_SEVERITY`);
    assert.ok(ACTION_LABEL.has(a),    `${a} must be in ACTION_LABEL`);
  }
});
