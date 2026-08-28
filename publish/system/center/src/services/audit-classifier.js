// Single source of truth for audit-log action classification.
// Policy lives in source, not in admin-editable config — adding a new action
// requires a code change here AND a unit test asserting it is mapped.

const ACTION_CATEGORY = Object.freeze(new Map([
  ['login',                          'ops'],
  ['login_failed',                   'security'],
  ['create_user',                    'changes'],
  ['update_user',                    'changes'],
  ['delete_user',                    'security'],
  ['update_config',                  'changes'],
  ['restart_service',                'changes'],
  ['test_smtp_email',                'ops'],
  ['bulk_import_sites',              'changes'],
  ['bulk_import_site_row',           'changes'],
  ['bulk_assign_dc_sites',           'changes'],
  ['bulk_assign_dc_site_row',        'changes'],
  ['bulk_assign_dc_unbound',         'changes'],
  ['create_site',                    'changes'],
  ['update_site',                    'changes'],
  ['delete_site',                    'changes'],
  ['assign_dc_site',                 'changes'],
  ['create_server_group',            'changes'],
  ['update_server_group',            'changes'],
  ['delete_server_group',            'changes'],
  ['replace_server_group_members',   'changes'],
  ['bulk_install_package_to_group',  'changes'],
  ['bulk_enable_package_to_group',   'changes'],
  ['bulk_disable_package_to_group',  'changes'],
  ['disable_builtin_ad_os_baseline', 'security'],
  ['create_member_server',           'changes'],
  ['agent_self_register',            'security'],
  ['create_alert_rule',              'changes'],
  ['delete_alert_rule',              'changes'],
  ['probe_state_changed',            'changes'],
  ['apply_migration',                'changes'],
  ['reset_failed_migration',         'changes'],
  // 2026-08-20 schema-migrations-upgrade SDD: T1 mark-applied / baseline /
  // apply-up-to + T2 upgrade_db. All are operator-driven schema writes —
  // catalog as 'changes' so they surface in the changes filter (not ops).
  ['mark_applied',                   'changes'],
  ['baseline',                       'changes'],
  ['apply_up_to',                    'changes'],
  ['upgrade_db',                     'changes'],
  // I9: dual-key JWT secret rotation events — security-bearing because
  // they change the server's signing key (rotate/commit touch active auth;
  // seed bootstraps the key on first install; auto_expire silently closes
  // an overlap window).
  ['rotate_jwt_secret',              'security'],
  ['auto_expire_jwt_secret',         'security'],
  ['commit_jwt_secret',              'security'],
  ['seed_jwt_secret',                'system'],
  // #167 C1: dual-key agent-token rotation events — security-bearing because
  // they change the server's agent-auth token (rotate/commit touch active
  // auth; seed bootstraps the token on first install; auto_expire silently
  // closes an overlap window). revoke_user_tokens (I1) is the admin action
  // that invalidates a user's JWT token_version — also security-bearing.
  //
  // 2026-08-21 UX redesign: `rotate_agent_token` was renamed to
  // `generate_agent_token` to reflect the new auto-delivery flow (the
  // action now means "generate a new token AND push it to verified agents"
  // rather than "rotate the dual-key manually"). Old audit rows keep the
  // original action string in audit_logs (append-only); the classifier
  // still maps it so a reader gets the right label/category/severity.
  ['rotate_agent_token',              'security'],
  ['generate_agent_token',            'security'],
  ['auto_expire_agent_token',         'security'],
  ['commit_agent_token',              'security'],
  ['seed_agent_token',                'system'],
  ['reveal_agent_token',              'security'],
  ['revoke_user_tokens',              'security'],
  // round-12: heartbeat "report now" — operator-initiated request to ask
  // an agent to send an immediate heartbeat report. Classified as 'changes'
  // because it mutates ad_agent_heartbeat.report_requested_at.
  ['request_agent_report',            'changes'],
  // 2026-08-26 round-19+: heartbeat-table + report-table delete buttons.
  // When a host is decommissioned the operator needs a way to clean its
  // stale rows out of the dashboard view. Both are 'changes' (mutate
  // ad_agent_heartbeat / ad_replication_status / ad_dcs / package_runs);
  // severity is 'medium' because a wrong click wipes real history.
  ['delete_agent_heartbeat',          'changes'],
  ['delete_dc',                       'changes']
  // 2026-08-26 round-17: update_replication_port_config was retired with the
  // probe-port rewrite — operators now edit ports via the standard
  // create_port / update_port / delete_port audit actions on system_ports.
]));

const ACTION_SEVERITY = Object.freeze(new Map([
  ['login',                          'low'],
  ['login_failed',                   'high'],
  ['create_user',                    'low'],
  ['update_user',                    'medium'],
  ['delete_user',                    'high'],
  ['update_config',                  'medium'],
  ['restart_service',                'high'],
  ['test_smtp_email',                'low'],
  ['bulk_import_sites',              'medium'],
  ['bulk_import_site_row',           'low'],
  ['bulk_assign_dc_sites',           'medium'],
  ['bulk_assign_dc_site_row',        'low'],
  ['bulk_assign_dc_unbound',         'low'],
  ['create_site',                    'low'],
  ['update_site',                    'low'],
  ['delete_site',                    'medium'],
  ['assign_dc_site',                 'low'],
  ['create_server_group',            'low'],
  ['update_server_group',            'low'],
  ['delete_server_group',            'medium'],
  ['replace_server_group_members',   'medium'],
  ['bulk_install_package_to_group',  'medium'],
  ['bulk_enable_package_to_group',   'low'],
  ['bulk_disable_package_to_group',  'medium'],
  ['disable_builtin_ad_os_baseline', 'high'],
  ['create_member_server',           'low'],
  ['agent_self_register',            'medium'],
  ['create_alert_rule',              'low'],
  ['delete_alert_rule',              'medium'],
  ['probe_state_changed',            'low'],
  ['apply_migration',                'medium'],
  ['reset_failed_migration',         'medium'],
  // 2026-08-20 schema-migrations-upgrade SDD: medium severity — these
  // change the schema state (mark_applied writes an applied row; baseline
  // bulk-marks; apply_up_to runs multiple migrations; upgrade_db runs
  // migrations + seeds). Higher than login (low) but lower than
  // restart_service (high) because they're database-only, not service-
  // affecting.
  ['mark_applied',                   'medium'],
  ['baseline',                       'medium'],
  ['apply_up_to',                    'medium'],
  ['upgrade_db',                     'medium'],
  // I9: JWT secret rotation — operator-driven rotation/commit are high
  // because they immediately change the signing key (every newly-issued
  // token uses the new key); auto-expire is high because it silently
  // closes the overlap window (stragglers start getting 401); seed is
  // info — first-boot bootstrap, no auth-bearing behavior.
  ['rotate_jwt_secret',              'high'],
  ['auto_expire_jwt_secret',         'high'],
  ['commit_jwt_secret',              'medium'],
  ['seed_jwt_secret',                'info'],
  // #167 C1: agent-token rotation severity mirrors JWT secret lifecycle.
  // rotate / generate = high (changes server's auth credential immediately);
  // commit = medium (ends a benign overlap window); seed = info
  // (first-boot bootstrap); auto_expire = high (silently closes overlap);
  // revoke_user_tokens = high (immediately invalidates every JWT issued
  // to that user).
  ['rotate_agent_token',              'high'],
  ['generate_agent_token',            'high'],
  ['auto_expire_agent_token',         'high'],
  ['commit_agent_token',              'medium'],
  ['seed_agent_token',                'info'],
  ['reveal_agent_token',              'high'],
  ['revoke_user_tokens',              'high'],
  // round-12: heartbeat "report now" — low severity (operator action,
  // not destructive; only sets a flag the next heartbeat will clear).
  ['request_agent_report',            'low'],
  // 2026-08-26 round-19+: heartbeat/report-table delete buttons. medium
  // because a mis-click drops real replication history; same shape as
  // delete_server_group.
  ['delete_agent_heartbeat',          'medium'],
  ['delete_dc',                       'medium']
  // 2026-08-26 round-17: update_replication_port_config retired (see above).
]));

const ACTION_LABEL = Object.freeze(new Map([
  ['login',                          '登录'],
  ['login_failed',                   '登录失败'],
  ['create_user',                    '创建用户'],
  ['update_user',                    '修改用户'],
  ['delete_user',                    '删除用户'],
  ['update_config',                  '修改系统配置'],
  ['restart_service',                '重启服务'],
  ['test_smtp_email',                '测试 SMTP 邮件'],
  ['bulk_import_sites',              '批量导入站点'],
  ['bulk_import_site_row',           '批量导入站点(行)'],
  ['bulk_assign_dc_sites',           '批量分配 DC 站点'],
  ['bulk_assign_dc_site_row',        '批量分配 DC 站点(行)'],
  ['bulk_assign_dc_unbound',         '批量解绑 DC 站点'],
  ['create_site',                    '创建站点'],
  ['update_site',                    '修改站点'],
  ['delete_site',                    '删除站点'],
  ['assign_dc_site',                 '分配 DC 站点'],
  ['create_server_group',            '创建服务器组'],
  ['update_server_group',            '修改服务器组'],
  ['delete_server_group',            '删除服务器组'],
  ['replace_server_group_members',   '替换服务器组成员'],
  ['bulk_install_package_to_group',  '批量安装包到组'],
  ['bulk_enable_package_to_group',   '批量启用包'],
  ['bulk_disable_package_to_group',  '批量禁用包'],
  ['disable_builtin_ad_os_baseline', '禁用内置 ad-os-baseline'],
  ['create_member_server',           '创建成员服务器'],
  ['agent_self_register',            'Agent 自注册'],
  ['create_alert_rule',              '创建告警规则'],
  ['delete_alert_rule',              '删除告警规则'],
  ['probe_state_changed',            '探针状态变化'],
  ['apply_migration',                '应用迁移'],
  ['reset_failed_migration',         '重置失败迁移'],
  // 2026-08-20 schema-migrations-upgrade SDD: Chinese labels for the new
  // schema-migration actions. Phrasing matches the existing taxonomy
  // (verb + object, "标记 / 基线 / 批量应用 / 升级").
  ['mark_applied',                   '标记已应用'],
  ['baseline',                       '基线标记'],
  ['apply_up_to',                    '批量应用到版本'],
  ['upgrade_db',                     '升级到最新'],
  // I9: JWT secret rotation labels (Chinese to match surrounding taxonomy).
  ['rotate_jwt_secret',              '轮换 JWT 签名密钥'],
  ['auto_expire_jwt_secret',         'JWT 密钥自动过期'],
  ['commit_jwt_secret',              '提交 JWT 签名密钥'],
  ['seed_jwt_secret',                '从 appsettings 初始化 JWT 密钥'],
  // #167 C1: agent-token rotation labels (parallel to I9).
  //
  // 2026-08-21 UX redesign: the operator-facing concept is now "generate
  // a new token and push it to verified agents" rather than "rotate the
  // dual-key manually". The Chinese label reflects that — "生成 Agent 令牌"
  // instead of "轮换 Agent 令牌". Old `rotate_agent_token` rows from prior
  // deployments still map to the new label so the audit reader sees a
  // consistent history.
  ['rotate_agent_token',              '生成 Agent 令牌'],
  ['generate_agent_token',            '生成 Agent 令牌'],
  ['auto_expire_agent_token',         'Agent 令牌自动过期'],
  ['commit_agent_token',              '提交 Agent 令牌'],
  ['seed_agent_token',                '从 appsettings 初始化 Agent 令牌'],
  ['reveal_agent_token',              '复制 Agent 令牌'],
  ['revoke_user_tokens',              '撤销用户全部令牌'],
  // round-12: heartbeat "report now" — Chinese label for the new
  // request_agent_report action (operator clicks "立即回报" on the agent
  // list to ask that agent to send a heartbeat immediately).
  ['request_agent_report',            '请求 Agent 立即回报'],
  // 2026-08-26 round-19+: heartbeat/report-table delete buttons. The
  // 中文 label names the operator's mental model — "删除 Agent 记录"
  // captures both tables because they share row identity.
  ['delete_agent_heartbeat',          '删除 Agent 心跳记录'],
  ['delete_dc',                       '删除 DC 记录']
  // 2026-08-26 round-17: update_replication_port_config was removed when the
  // probe-port list moved into the system_ports table (same source as the
  // port-health-check page). Operators now edit ports via the existing
  // create_port / update_port / delete_port audit actions; no separate
  // action needed.
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
