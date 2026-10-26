// center/src/db/sql/system-registration.js
// R158.87 (2026-10-12) — ad_system_registration 公共表 SQL helper.
// License 录入 + 查重 + 撤销. 4 helper × 2 dialect (getCurrent / activate /
// findByHash / deactivate). 用 `?` 占位符, mssql driver wrapper rewrite.

export const systemRegistration = {
  mysql: {
    getCurrent: `SELECT id, license_key, license_hash, activated_at, expires_at, instance_id, status, notes, created_at, updated_at
                 FROM ad_system_registration WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
    activate: `INSERT INTO ad_system_registration
               (license_key, license_hash, expires_at, instance_id, notes, status)
               VALUES (?, ?, ?, ?, ?, 'active')`,
    findByHash: `SELECT id, status, instance_id FROM ad_system_registration WHERE license_hash = ?`,
    deactivate: `UPDATE ad_system_registration
                 SET status = 'revoked', updated_at = CURRENT_TIMESTAMP(3)
                 WHERE status = 'active'`
  },
  mssql: {
    getCurrent: `SELECT TOP 1 id, license_key, license_hash, activated_at, expires_at, instance_id, status, notes, created_at, updated_at
                 FROM ad_system_registration WHERE status = 'active' ORDER BY id DESC`,
    activate: `INSERT INTO ad_system_registration
               (license_key, license_hash, expires_at, instance_id, notes, status)
               OUTPUT inserted.id
               VALUES (?, ?, ?, ?, ?, 'active')`,
    findByHash: `SELECT id, status, instance_id FROM ad_system_registration WHERE license_hash = CAST(? AS CHAR(64))`,
    deactivate: `UPDATE ad_system_registration
                 SET status = 'revoked', updated_at = SYSUTCDATETIME()
                 WHERE status = 'active'`
  }
};
