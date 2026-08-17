// Single source of truth for audit-log action classification.
// Policy lives in source, not in admin-editable config — adding a new action
// requires a code change here AND a unit test asserting it is mapped.

const ACTION_CATEGORY = Object.freeze(new Map([
  ['login',                  'ops'],
  ['login_failed',           'security'],
  ['create_user',            'changes'],
  ['update_user',            'changes'],
  ['delete_user',            'security'],
  ['update_config',          'changes'],
  ['bulk_import_sites',      'changes'],
  ['bulk_import_site_row',   'changes'],
  ['bulk_assign_dc_sites',   'changes'],
  ['bulk_assign_dc_site_row','changes'],
  ['bulk_assign_dc_unbound', 'changes'],
  ['apply_migration',        'changes'],
  ['reset_failed_migration', 'changes']
]));

const ACTION_SEVERITY = Object.freeze(new Map([
  ['login',                  'low'],
  ['login_failed',           'high'],
  ['create_user',            'low'],
  ['update_user',            'medium'],
  ['delete_user',            'high'],
  ['update_config',          'medium'],
  ['bulk_import_sites',      'medium'],
  ['bulk_import_site_row',   'low'],
  ['bulk_assign_dc_sites',   'medium'],
  ['bulk_assign_dc_site_row','low'],
  ['bulk_assign_dc_unbound', 'low'],
  ['apply_migration',        'medium'],
  ['reset_failed_migration', 'medium']
]));

const ACTION_LABEL = Object.freeze(new Map([
  ['login',                  '登录'],
  ['login_failed',           '登录失败'],
  ['create_user',            '创建用户'],
  ['update_user',            '修改用户'],
  ['delete_user',            '删除用户'],
  ['update_config',          '修改系统配置'],
  ['bulk_import_sites',      '批量导入站点'],
  ['bulk_import_site_row',   '批量导入站点(行)'],
  ['bulk_assign_dc_sites',   '批量分配 DC 站点'],
  ['bulk_assign_dc_site_row','批量分配 DC 站点(行)'],
  ['bulk_assign_dc_unbound', '批量解绑 DC 站点'],
  ['apply_migration',        '应用迁移'],
  ['reset_failed_migration', '重置失败迁移']
]));

const TARGET_LABEL = Object.freeze(new Map([
  ['system_config',     '系统配置'],
  ['ad_sites',          '站点目录'],
  ['ad_dcs',            '域控目录'],
  ['schema_migrations', '迁移管理']
]));

function groupByValue(map) {
  const out = new Map();
  for (const [k, v] of map) {
    if (!out.has(v)) out.set(v, []);
    out.get(v).push(k);
  }
  for (const arr of out.values()) arr.sort();
  return Object.freeze(out);
}

const CATEGORY_ACTIONS = groupByValue(ACTION_CATEGORY);
const SEVERITY_ACTIONS = groupByValue(ACTION_SEVERITY);

export function classifyAction(action) {
  return {
    label:    ACTION_LABEL.get(action)    ?? action,
    category: ACTION_CATEGORY.get(action) ?? 'ops',
    severity: ACTION_SEVERITY.get(action) ?? 'low'
  };
}

export {
  ACTION_CATEGORY, ACTION_SEVERITY, ACTION_LABEL, TARGET_LABEL,
  CATEGORY_ACTIONS, SEVERITY_ACTIONS
};
