// R158.37 (2026-10-03) - AD Forest Registry SQL helpers.
//
// CRUD SQL for the 4 physical tables (ad_forest / ad_forest_domain /
// ad_forest_dc_assignment / ad_forest_setting). Uses `?` placeholders.
// (R158.32 lesson: caller MUST use dict.<method>[db.dialect]; spreading
// dict collapses function refs to {}.)
//
// bind_password is AES-256-GCM ciphertext (Buffer/VarBinary); caller
// converts base64 string to Buffer before INSERT/UPDATE. Service layer
// uses ad-credential-vault.js for encrypt/decrypt.

const MASK_PASSWORD = "'********'"; // kept for backwards compatibility — UPDATE now uses IS NULL sentinel

// ---- ad_forest ----

const LIST_FORESTS_MYSQL = `SELECT id, forest_name, root_dn, ad_url, bind_dn,
                                    description, is_default, created_at, updated_at
                             FROM ad_forest ORDER BY is_default DESC, forest_name ASC`;
const LIST_FORESTS_MSSQL = LIST_FORESTS_MYSQL;

const GET_FOREST_MYSQL = `SELECT id, forest_name, root_dn, ad_url, bind_dn,
                                  bind_password, description, is_default, created_at, updated_at
                           FROM ad_forest WHERE id = ?`;
// R158.5 (2026-10-04) — MSSQL 必须独立字符串, 不能 = GET_FOREST_MYSQL
// (listForests/getForest 调用方用 [dialect] 下标, R158.32/R158.5 lesson).
const GET_FOREST_MSSQL = `SELECT id, forest_name, root_dn, ad_url, bind_dn,
                                  bind_password, description, is_default, created_at, updated_at
                           FROM ad_forest WHERE id = ?`;

const INSERT_FOREST_MYSQL = `INSERT INTO ad_forest
  (forest_name, root_dn, ad_url, bind_dn, bind_password, description, is_default)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_FOREST_MSSQL = INSERT_FOREST_MYSQL;

// UPDATE_FOREST_KEEP_PASSWORD skips the bind_password column entirely when
// the caller didn't supply a new password (skip-update path). MSSQL
// refuses to SET a VARBINARY column from a CASE expression whose THEN
// branch is a placeholder (implicit nvarchar -> varbinary conversion), so
// we route around it by splitting the SQL into two siblings.
const UPDATE_FOREST_KEEP_PASSWORD_MYSQL = `UPDATE ad_forest SET
  forest_name = ?, root_dn = ?, ad_url = ?, bind_dn = ?,
  description = ?, is_default = ?
  WHERE id = ?`;
const UPDATE_FOREST_KEEP_PASSWORD_MSSQL = UPDATE_FOREST_KEEP_PASSWORD_MYSQL;

// UPDATE_FOREST_SET_PASSWORD replaces the AES-256-GCM ciphertext (Buffer
// payload → VARBINARY column).
const UPDATE_FOREST_SET_PASSWORD_MYSQL = `UPDATE ad_forest SET
  forest_name = ?, root_dn = ?, ad_url = ?, bind_dn = ?,
  bind_password = ?, description = ?, is_default = ?
  WHERE id = ?`;
const UPDATE_FOREST_SET_PASSWORD_MSSQL = UPDATE_FOREST_SET_PASSWORD_MYSQL;

const DELETE_FOREST_MYSQL = `DELETE FROM ad_forest WHERE id = ?`;
const DELETE_FOREST_MSSQL = DELETE_FOREST_MYSQL;

const CLEAR_DEFAULT_MYSQL = `UPDATE ad_forest SET is_default = 0 WHERE is_default = 1`;
const CLEAR_DEFAULT_MSSQL = CLEAR_DEFAULT_MYSQL;

const SET_DEFAULT_MYSQL = `UPDATE ad_forest SET is_default = 1 WHERE id = ?`;
const SET_DEFAULT_MSSQL = SET_DEFAULT_MYSQL;

// ---- ad_forest_domain ----

// R158.44.7.3 (2026-10-04) — 列表 + 单查都要返 sync_enabled (R158.39 加列时漏
// 修 SELECT). 老 SELECT 列表返的 row 没有 sync_enabled, rowToDomainWire 行 66
// `row.sync_enabled == null ? true` 兜底 → 永远显示启用. PATCH 写 DB 成功但
// GET 永远 true, 操作员取消勾选刷新生效. R158.44.6+7 多次扩 ad_forest_domain
// (is_pdc/trust_direction/dc_hostname/sync_enabled) 都只动写入 SQL, 读 SQL
// 没跟上 → 这是反复 schema-drift 的根因. 一次性把 sync_enabled 加进读 SQL,
// 后续字段加列必须同步两个查询.
const LIST_DOMAINS_MYSQL = `SELECT id, forest_id, domain_dn, domain_name, role,
                                    trust_direction, dc_hostname, is_pdc, sync_enabled, created_at
                             FROM ad_forest_domain WHERE forest_id = ?
                             ORDER BY is_pdc DESC, domain_name ASC`;
const LIST_DOMAINS_MSSQL = LIST_DOMAINS_MYSQL;

const GET_DOMAIN_MYSQL = `SELECT id, forest_id, domain_dn, domain_name, role,
                                  trust_direction, dc_hostname, is_pdc, sync_enabled, created_at
                           FROM ad_forest_domain WHERE id = ?`;
const GET_DOMAIN_MSSQL = GET_DOMAIN_MYSQL;

const INSERT_DOMAIN_MYSQL = `INSERT INTO ad_forest_domain
  (forest_id, domain_dn, domain_name, role, trust_direction, dc_hostname, is_pdc)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_DOMAIN_MSSQL = INSERT_DOMAIN_MYSQL;

const UPDATE_DOMAIN_MYSQL = `UPDATE ad_forest_domain SET
  domain_name = ?, role = ?, trust_direction = ?, dc_hostname = ?, is_pdc = ?
  WHERE id = ?`;
const UPDATE_DOMAIN_MSSQL = UPDATE_DOMAIN_MYSQL;

// R158.38.4 (2026-10-03) — root domain d+n updater. updateDomain 改不动
// domain_dn (uq_forest_domain 唯一约束 forest_id+domain_dn). 根域同步专门走
// 这里, 只改 domain_dn + domain_name.
const UPDATE_ROOT_DOMAIN_DN_MYSQL = `UPDATE ad_forest_domain SET
  domain_dn = ?, domain_name = ?
  WHERE id = ?`;
const UPDATE_ROOT_DOMAIN_DN_MSSQL = UPDATE_ROOT_DOMAIN_DN_MYSQL;

// R158.38.4 (2026-10-03) — 找 forest 的根域 id (role='root' AND domain_dn
// = forest.rootDn). 用来在 updateForest 时同步改根域的 d+n.
const FIND_ROOT_DOMAIN_ID_MYSQL = `SELECT id FROM ad_forest_domain
  WHERE forest_id = ? AND role = 'root' LIMIT 1`;
const FIND_ROOT_DOMAIN_ID_MSSQL = `SELECT TOP 1 id FROM ad_forest_domain
  WHERE forest_id = ? AND role = 'root'`;

// R158.39 (2026-10-03) — 每域自动同步开关. tick 跳过 sync_enabled=0 的域,
// 但手动触发 UI 多选不受限 (操作员可临时同步 disabled 域).
const LIST_ENABLED_DOMAINS_MYSQL = `SELECT id, forest_id, domain_dn, domain_name, role,
  trust_direction, dc_hostname, is_pdc, sync_enabled, created_at
  FROM ad_forest_domain WHERE forest_id = ? AND sync_enabled = 1
  ORDER BY role ASC, domain_name ASC`;
const LIST_ENABLED_DOMAINS_MSSQL = LIST_ENABLED_DOMAINS_MYSQL;

const SET_DOMAIN_SYNC_ENABLED_MYSQL = `UPDATE ad_forest_domain SET sync_enabled = ?
  WHERE id = ?`;
const SET_DOMAIN_SYNC_ENABLED_MSSQL = SET_DOMAIN_SYNC_ENABLED_MYSQL;

const DELETE_DOMAIN_MYSQL = `DELETE FROM ad_forest_domain WHERE id = ?`;
const DELETE_DOMAIN_MSSQL = DELETE_DOMAIN_MYSQL;

// ---- ad_forest_dc_assignment ----

const LIST_DC_ASSIGNMENTS_MYSQL = `SELECT id, forest_id, domain_id, dc_hostname, site_id, assigned_at
                                   FROM ad_forest_dc_assignment
                                   WHERE forest_id = ?
                                   ORDER BY dc_hostname ASC`;
const LIST_DC_ASSIGNMENTS_MSSQL = LIST_DC_ASSIGNMENTS_MYSQL;

const ASSIGN_DC_MYSQL = `INSERT INTO ad_forest_dc_assignment
  (forest_id, domain_id, dc_hostname, site_id)
  VALUES (?, ?, ?, ?)`;
const ASSIGN_DC_MSSQL = ASSIGN_DC_MYSQL;

const UNASSIGN_DC_MYSQL = `DELETE FROM ad_forest_dc_assignment WHERE dc_hostname = ?`;
const UNASSIGN_DC_MSSQL = UNASSIGN_DC_MYSQL;

// ---- ad_forest_setting ----

const LIST_SETTINGS_MYSQL = `SELECT id, forest_id, setting_key, setting_value, updated_at
                             FROM ad_forest_setting WHERE forest_id = ?
                             ORDER BY setting_key ASC`;
const LIST_SETTINGS_MSSQL = LIST_SETTINGS_MYSQL;

const UPSERT_SETTING_MYSQL = `INSERT INTO ad_forest_setting
  (forest_id, setting_key, setting_value)
  VALUES (?, ?, ?)
  ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`;
// MSSQL has no ON DUPLICATE KEY - use MERGE
const UPSERT_SETTING_MSSQL = `MERGE ad_forest_setting AS tgt
  USING (SELECT CAST(? AS INT) AS forest_id,
                CAST(? AS NVARCHAR(128)) AS setting_key,
                CAST(? AS NVARCHAR(2048)) AS setting_value) AS src
  ON (tgt.forest_id = src.forest_id AND tgt.setting_key = src.setting_key)
  WHEN MATCHED THEN UPDATE SET
    setting_value = src.setting_value,
    updated_at = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (forest_id, setting_key, setting_value)
    VALUES (src.forest_id, src.setting_key, src.setting_value);`;

const DELETE_SETTING_MYSQL = `DELETE FROM ad_forest_setting WHERE forest_id = ? AND setting_key = ?`;
const DELETE_SETTING_MSSQL = DELETE_SETTING_MYSQL;

// ---- ad_forest_domain_setting (R158.38.3) ----
// 独立表, 域级 (pwd_min_length / sync_interval / etc.). 不复用 ad_forest_setting.
// FK → ad_forest_domain ON DELETE CASCADE; UNIQUE (domain_id, setting_key).
const LIST_DOMAIN_SETTINGS_MYSQL = `SELECT id, domain_id, setting_key, setting_value, updated_at
                                   FROM ad_forest_domain_setting WHERE domain_id = ?
                                   ORDER BY setting_key ASC`;
const LIST_DOMAIN_SETTINGS_MSSQL = LIST_DOMAIN_SETTINGS_MYSQL;

const UPSERT_DOMAIN_SETTING_MYSQL = `INSERT INTO ad_forest_domain_setting
  (domain_id, setting_key, setting_value)
  VALUES (?, ?, ?)
  ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`;
const UPSERT_DOMAIN_SETTING_MSSQL = `MERGE ad_forest_domain_setting AS tgt
  USING (SELECT CAST(? AS INT) AS domain_id,
                CAST(? AS NVARCHAR(128)) AS setting_key,
                CAST(? AS NVARCHAR(2048)) AS setting_value) AS src
  ON (tgt.domain_id = src.domain_id AND tgt.setting_key = src.setting_key)
  WHEN MATCHED THEN UPDATE SET
    setting_value = src.setting_value,
    updated_at = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN
    INSERT (domain_id, setting_key, setting_value)
    VALUES (src.domain_id, src.setting_key, src.setting_value);`;

const DELETE_DOMAIN_SETTING_MYSQL = `DELETE FROM ad_forest_domain_setting WHERE domain_id = ? AND setting_key = ?`;
const DELETE_DOMAIN_SETTING_MSSQL = DELETE_DOMAIN_SETTING_MYSQL;

export const forestRegistry = {
  listForests: { mysql: LIST_FORESTS_MYSQL, mssql: LIST_FORESTS_MSSQL },
  getForest: { mysql: GET_FOREST_MYSQL, mssql: GET_FOREST_MSSQL },
  insertForest: { mysql: INSERT_FOREST_MYSQL, mssql: INSERT_FOREST_MSSQL },
  // Two siblings for the keep-password vs set-password paths (see comment
  // above UPDATE_FOREST_KEEP_PASSWORD_*). Service picks at call time.
  updateForestKeepPassword: { mysql: UPDATE_FOREST_KEEP_PASSWORD_MYSQL, mssql: UPDATE_FOREST_KEEP_PASSWORD_MSSQL },
  updateForestSetPassword: { mysql: UPDATE_FOREST_SET_PASSWORD_MYSQL, mssql: UPDATE_FOREST_SET_PASSWORD_MSSQL },
  deleteForest: { mysql: DELETE_FOREST_MYSQL, mssql: DELETE_FOREST_MSSQL },
  clearDefault: { mysql: CLEAR_DEFAULT_MYSQL, mssql: CLEAR_DEFAULT_MSSQL },
  setDefault: { mysql: SET_DEFAULT_MYSQL, mssql: SET_DEFAULT_MSSQL },

  listDomains: { mysql: LIST_DOMAINS_MYSQL, mssql: LIST_DOMAINS_MSSQL },
  getDomain: { mysql: GET_DOMAIN_MYSQL, mssql: GET_DOMAIN_MSSQL },
  insertDomain: { mysql: INSERT_DOMAIN_MYSQL, mssql: INSERT_DOMAIN_MSSQL },
  updateDomain: { mysql: UPDATE_DOMAIN_MYSQL, mssql: UPDATE_DOMAIN_MSSQL },
  deleteDomain: { mysql: DELETE_DOMAIN_MYSQL, mssql: DELETE_DOMAIN_MSSQL },
  // R158.38.4 (2026-10-03) — root domain id/dn sync helpers.
  findRootDomainId: { mysql: FIND_ROOT_DOMAIN_ID_MYSQL, mssql: FIND_ROOT_DOMAIN_ID_MSSQL },
  updateRootDomainDn: { mysql: UPDATE_ROOT_DOMAIN_DN_MYSQL, mssql: UPDATE_ROOT_DOMAIN_DN_MSSQL },
  // R158.39 (2026-10-03) — 每域自动同步开关 SQL.
  listEnabledDomains: { mysql: LIST_ENABLED_DOMAINS_MYSQL, mssql: LIST_ENABLED_DOMAINS_MSSQL },
  setDomainSyncEnabled: { mysql: SET_DOMAIN_SYNC_ENABLED_MYSQL, mssql: SET_DOMAIN_SYNC_ENABLED_MSSQL },

  listDcAssignments: { mysql: LIST_DC_ASSIGNMENTS_MYSQL, mssql: LIST_DC_ASSIGNMENTS_MSSQL },
  assignDc: { mysql: ASSIGN_DC_MYSQL, mssql: ASSIGN_DC_MSSQL },
  unassignDc: { mysql: UNASSIGN_DC_MYSQL, mssql: UNASSIGN_DC_MSSQL },

  listSettings: { mysql: LIST_SETTINGS_MYSQL, mssql: LIST_SETTINGS_MSSQL },
  upsertSetting: { mysql: UPSERT_SETTING_MYSQL, mssql: UPSERT_SETTING_MSSQL },
  deleteSetting: { mysql: DELETE_SETTING_MYSQL, mssql: DELETE_SETTING_MSSQL },

  // R158.38.3 — domain-level settings (独立表 ad_forest_domain_setting).
  listDomainSettings: { mysql: LIST_DOMAIN_SETTINGS_MYSQL, mssql: LIST_DOMAIN_SETTINGS_MSSQL },
  upsertDomainSetting: { mysql: UPSERT_DOMAIN_SETTING_MYSQL, mssql: UPSERT_DOMAIN_SETTING_MSSQL },
  deleteDomainSetting: { mysql: DELETE_DOMAIN_SETTING_MYSQL, mssql: DELETE_DOMAIN_SETTING_MSSQL }
};
