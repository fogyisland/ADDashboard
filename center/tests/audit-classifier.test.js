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
    'apply_migration', 'reset_failed_migration'
  ];
  for (const a of EMITTED) {
    assert.ok(['security', 'changes', 'ops'].includes(ACTION_CATEGORY.get(a)),
      `action ${a} missing from ACTION_CATEGORY`);
  }
});

test('classifier: classifyAction returns Chinese label + category + severity together', () => {
  const c = classifyAction('login_failed');
  assert.equal(c.label, '登录失败');
  assert.equal(c.category, 'security');
  assert.equal(c.severity, 'high');
});

test('classifier: CATEGORY_ACTIONS.security is exactly {login_failed, delete_user, agent_self_register, disable_builtin_ad_os_baseline}', () => {
  assert.deepEqual([...CATEGORY_ACTIONS.get('security')].sort(), [
    'agent_self_register', 'delete_user', 'disable_builtin_ad_os_baseline', 'login_failed'
  ]);
});

test('classifier: SEVERITY_ACTIONS.high includes delete_user, login_failed, restart_service, disable_builtin_ad_os_baseline', () => {
  assert.deepEqual([...SEVERITY_ACTIONS.get('high')].sort(), [
    'delete_user', 'disable_builtin_ad_os_baseline', 'login_failed', 'restart_service'
  ]);
});

test('classifier: SEVERITY_ACTIONS.medium covers all medium-severity changes actions', () => {
  assert.deepEqual([...SEVERITY_ACTIONS.get('medium')].sort(), [
    'agent_self_register', 'apply_migration', 'bulk_assign_dc_sites',
    'bulk_disable_package_to_group', 'bulk_import_sites', 'bulk_install_package_to_group',
    'delete_alert_rule', 'delete_server_group', 'delete_site',
    'replace_server_group_members',
    'reset_failed_migration', 'update_config', 'update_user'
  ]);
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
