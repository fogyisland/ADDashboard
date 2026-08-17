// SQL helpers for the three server-group tables from migration 014:
//   ad_server_groups         (PK = group_id, UNIQUE group_name)
//   ad_server_group_members  (PK = group_id + hostname)
//   ad_member_server_packages (PK = hostname + package_name)
//
// Pattern matches center/src/db/sql.js's `sites` / `dcs` domain:
// dual-dialect SQL strings mounted into the registry so service code can
// read db.sql.serverGroups.<query> and get back a plain string for the
// active dialect.

export const serverGroups = {
  mysql: {
    // ---- ad_server_groups ----
    create: `INSERT INTO ad_server_groups (group_name, description) VALUES (?, ?)`,
    upsert: `INSERT INTO ad_server_groups (group_name, description) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE description = VALUES(description), updated_at = CURRENT_TIMESTAMP`,
    findByName: `SELECT group_id, group_name, description FROM ad_server_groups WHERE group_name = ?`,
    findById: `SELECT group_id, group_name, description FROM ad_server_groups WHERE group_id = ?`,
    list: `SELECT g.group_id, g.group_name, g.description,
            (SELECT COUNT(*) FROM ad_server_group_members m WHERE m.group_id = g.group_id) AS member_count
           FROM ad_server_groups g
           ORDER BY g.group_name`,
    update: `UPDATE ad_server_groups SET group_name = ?, description = ? WHERE group_id = ?`,
    delete: `DELETE FROM ad_server_groups WHERE group_id = ?`,

    // ---- ad_server_group_members ----
    addMember: `INSERT INTO ad_server_group_members (group_id, hostname) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE created_at = created_at`,
    removeMember: `DELETE FROM ad_server_group_members WHERE group_id = ? AND hostname = ?`,
    listMembers: `SELECT m.group_id, m.hostname, m.created_at, s.site_name
                  FROM ad_server_group_members m
                  LEFT JOIN ad_member_servers ms ON ms.hostname = m.hostname
                  LEFT JOIN ad_sites s ON s.site_id = ms.site_id
                  WHERE m.group_id = ?
                  ORDER BY m.hostname`,
    listGroupsForHostname: `SELECT g.group_id, g.group_name
                           FROM ad_server_groups g
                           INNER JOIN ad_server_group_members m ON m.group_id = g.group_id
                           WHERE m.hostname = ?
                           ORDER BY g.group_name`,

    // ---- ad_member_server_packages ----
    upsertPackage: `INSERT INTO ad_member_server_packages (hostname, package_name, enabled)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
    removePackage: `DELETE FROM ad_member_server_packages WHERE hostname = ? AND package_name = ?`,
    listPackagesForHost: `SELECT msp.hostname, msp.package_name, msp.enabled,
                                 msp.installed_at, msp.last_run_at,
                                 ip.version, ip.type, ip.enabled AS pkg_enabled
                          FROM ad_member_server_packages msp
                          LEFT JOIN installed_packages ip ON ip.name = msp.package_name
                          WHERE msp.hostname = ?
                          ORDER BY msp.package_name`,
    listHostsForPackage: `SELECT msp.hostname, msp.enabled, msp.installed_at, msp.last_run_at
                          FROM ad_member_server_packages msp
                          WHERE msp.package_name = ?
                          ORDER BY msp.hostname`,
    touchPackageRun: `UPDATE ad_member_server_packages SET last_run_at = NOW()
                      WHERE hostname = ? AND package_name = ?`,
    // Bulk operations for Task 7 (server-groups admin routes). Pattern:
    // resolve member hostnames via the join, then write. MySQL uses INSERT
    // ... SELECT FROM ...; MSSQL uses INSERT ... SELECT FROM ... too — both
    // dialects accept the same shape (SELECT in INSERT).
    bulkInstallPackage: `INSERT IGNORE INTO ad_member_server_packages (hostname, package_name, enabled)
      SELECT m.hostname, ?, ?
      FROM ad_server_group_members m
      WHERE m.group_id = ?`,
    bulkUninstallPackage: `DELETE msp FROM ad_member_server_packages msp
      INNER JOIN ad_server_group_members m ON m.hostname = msp.hostname
      WHERE m.group_id = ? AND msp.package_name = ?`,
    bulkSetEnabled: `UPDATE ad_member_server_packages msp
      INNER JOIN ad_server_group_members m ON m.hostname = msp.hostname
      SET msp.enabled = ?
      WHERE m.group_id = ? AND msp.package_name = ?`
  },
  mssql: {
    // ---- ad_server_groups ----
    create: `INSERT INTO ad_server_groups (group_name, description) VALUES (?, ?)`,
    findByName: `SELECT group_id, group_name, description FROM ad_server_groups WHERE group_name = ?`,
    findById: `SELECT group_id, group_name, description FROM ad_server_groups WHERE group_id = ?`,
    list: `SELECT g.group_id, g.group_name, g.description,
            (SELECT COUNT(*) FROM ad_server_group_members m WHERE m.group_id = g.group_id) AS member_count
           FROM ad_server_groups g
           ORDER BY g.group_name`,
    update: `UPDATE ad_server_groups SET group_name = ?, description = ? WHERE group_id = ?`,
    delete: `DELETE FROM ad_server_groups WHERE group_id = ?`,

    // ---- ad_server_group_members ----
    addMember: `MERGE INTO ad_server_group_members AS t
      USING (SELECT ? AS group_id, ? AS hostname) AS s
      ON t.group_id = s.group_id AND t.hostname = s.hostname
      WHEN NOT MATCHED THEN INSERT (group_id, hostname) VALUES (s.group_id, s.hostname);`,
    removeMember: `DELETE FROM ad_server_group_members WHERE group_id = ? AND hostname = ?`,
    listMembers: `SELECT m.group_id, m.hostname, m.created_at, s.site_name
                  FROM ad_server_group_members m
                  LEFT JOIN ad_member_servers ms ON ms.hostname = m.hostname
                  LEFT JOIN ad_sites s ON s.site_id = ms.site_id
                  WHERE m.group_id = ?
                  ORDER BY m.hostname`,
    listGroupsForHostname: `SELECT g.group_id, g.group_name
                           FROM ad_server_groups g
                           INNER JOIN ad_server_group_members m ON m.group_id = g.group_id
                           WHERE m.hostname = ?
                           ORDER BY g.group_name`,

    // ---- ad_member_server_packages ----
    upsertPackage: `MERGE INTO ad_member_server_packages AS t
      USING (SELECT ? AS hostname, ? AS package_name, ? AS enabled) AS s
      ON t.hostname = s.hostname AND t.package_name = s.package_name
      WHEN MATCHED THEN UPDATE SET enabled = s.enabled
      WHEN NOT MATCHED THEN INSERT (hostname, package_name, enabled) VALUES (s.hostname, s.package_name, s.enabled);`,
    removePackage: `DELETE FROM ad_member_server_packages WHERE hostname = ? AND package_name = ?`,
    listPackagesForHost: `SELECT msp.hostname, msp.package_name, msp.enabled,
                                 msp.installed_at, msp.last_run_at,
                                 ip.version, ip.type, ip.enabled AS pkg_enabled
                          FROM ad_member_server_packages msp
                          LEFT JOIN installed_packages ip ON ip.name = msp.package_name
                          WHERE msp.hostname = ?
                          ORDER BY msp.package_name`,
    listHostsForPackage: `SELECT msp.hostname, msp.enabled, msp.installed_at, msp.last_run_at
                          FROM ad_member_server_packages msp
                          WHERE msp.package_name = ?
                          ORDER BY msp.hostname`,
    touchPackageRun: `UPDATE ad_member_server_packages SET last_run_at = SYSUTCDATETIME()
                      WHERE hostname = ? AND package_name = ?`,
    // Bulk operations for Task 7. MSSQL has no INSERT IGNORE — use a
    // LEFT JOIN ... WHERE NOT EXISTS anti-pattern so re-running the install
    // is a no-op for hosts already bound to this package (idempotent).
    bulkInstallPackage: `INSERT INTO ad_member_server_packages (hostname, package_name, enabled)
      SELECT m.hostname, ?, ?
      FROM ad_server_group_members m
      WHERE m.group_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM ad_member_server_packages msp
          WHERE msp.hostname = m.hostname AND msp.package_name = ?
        )`,
    // MSSQL DELETE ... JOIN is supported in modern SQL Server (2005+).
    // Alternative is IN (SELECT hostname ...), but DELETE JOIN is more
    // efficient and reads the same as the MySQL counterpart.
    bulkUninstallPackage: `DELETE msp FROM ad_member_server_packages msp
      INNER JOIN ad_server_group_members m ON m.hostname = msp.hostname
      WHERE m.group_id = ? AND msp.package_name = ?`,
    bulkSetEnabled: `UPDATE msp SET enabled = ?
      FROM ad_member_server_packages msp
      INNER JOIN ad_server_group_members m ON m.hostname = msp.hostname
      WHERE m.group_id = ? AND msp.package_name = ?`
  }
};
