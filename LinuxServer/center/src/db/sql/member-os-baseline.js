// SQL helpers for the ad_member_os_baseline* tables (R158.86, R158.86.4, 2026-10-12).
// Member Server OS baseline 专表 — 跟 ad_os_baseline (DC) 平行但独立:
//   · 字段用 hostname 不用 dc_name (跟 ad_member_servers.hostname 对齐)
//   · PK (hostname, collected_at) for ad_member_os_baseline (时序)
//   · PK (hostname) for ad_member_os_baseline_latest (per-host latest)
//   · FK→ad_member_servers.hostname ON DELETE CASCADE
//
// R158.86.4 (2026-10-12) — 19 字段 跟 ad_os_baseline 1.0.7 metricSchema 平行.
// 1.0.0 ship 时 5 字段 (cpu_pct/memory_pct/c_used_pct/disk_free_bytes/services_count),
// operator "os baseline 少了很多内容, 例如品牌, 磁盘品牌和分区的内容" → 1.0.1
// 加 14 字段 (disk_free/disk_total/disks[]/services/events[]/bios_info/cpu_brand/
// mem_total_bytes/system_info/network_info/memory_modules[]/motherboard/cpu/ips[]).
// 13 JSON/object 列在 service 层 bound() JSON.stringify 序列化 (跟 metricstore.js:148
// bound() 同 precedent, 不在 SQL 层做).
//
// Pattern matches center/src/db/sql/member-eventlog.js (R158.78),
// center/src/db/sql/member-server-ports.js (R158.74), and
// center/src/db/sql/member-servers.js (R158.45/R158.63).

// ── metrics (time-series) ─────────────────────────────────────────────────
// PK (hostname, collected_at) — same row can be re-upserted on identical
// (hostname, collected_at) key (R158.78 ON DUPLICATE KEY UPDATE pattern).
//
// R158.86.4 — 20 列 (5 标量 + 14 新 + agent_id/hostname/collected_at 3 主键).
// 实际 INSERT 19 列: 5 标量 (cpu_pct/memory_pct/c_used_pct/disk_free_bytes/services_count)
// + 14 新 (disk_free/disk_total/disks/services/events/bios_info/cpu_brand/mem_total_bytes/
// system_info/network_info/memory_modules/motherboard/cpu/ips).
// 顺序跟 service 喂的 normalized 字段 1:1 对齐.
const UPSERT_METRICS_MYSQL = `INSERT INTO ad_member_os_baseline
  (collected_at, agent_id, hostname,
   cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
   disk_free, disk_total, disks, services, events,
   bios_info, cpu_brand, mem_total_bytes,
   system_info, network_info, memory_modules,
   motherboard, cpu, ips)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    cpu_pct         = VALUES(cpu_pct),
    memory_pct      = VALUES(memory_pct),
    c_used_pct      = VALUES(c_used_pct),
    disk_free_bytes = VALUES(disk_free_bytes),
    services_count  = VALUES(services_count),
    disk_free       = VALUES(disk_free),
    disk_total      = VALUES(disk_total),
    disks           = VALUES(disks),
    services        = VALUES(services),
    events          = VALUES(events),
    bios_info       = VALUES(bios_info),
    cpu_brand       = VALUES(cpu_brand),
    mem_total_bytes = VALUES(mem_total_bytes),
    system_info     = VALUES(system_info),
    network_info    = VALUES(network_info),
    memory_modules  = VALUES(memory_modules),
    motherboard     = VALUES(motherboard),
    cpu             = VALUES(cpu),
    ips             = VALUES(ips)`;

// Batch upsert (R158.74 ports precedent) — server-side INSERT with VALUES
// joined; falls back to per-row loop if batch throws.
function upsertMetricsBatch({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { sql: '', params: [] };
  }
  const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  const params = [];
  for (const r of rows) {
    params.push(
      r.collectedAt, r.agentId, r.hostname,
      r.cpuPct, r.memoryPct, r.cUsedPct, r.diskFreeBytes, r.servicesCount,
      r.diskFree, r.diskTotal, r.disks, r.services, r.events,
      r.biosInfo, r.cpuBrand, r.memTotalBytes,
      r.systemInfo, r.networkInfo, r.memoryModules,
      r.motherboard, r.cpu, r.ips
    );
  }
  return {
    sql: `INSERT INTO ad_member_os_baseline
        (collected_at, agent_id, hostname,
         cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
         disk_free, disk_total, disks, services, events,
         bios_info, cpu_brand, mem_total_bytes,
         system_info, network_info, memory_modules,
         motherboard, cpu, ips)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          cpu_pct         = VALUES(cpu_pct),
          memory_pct      = VALUES(memory_pct),
          c_used_pct      = VALUES(c_used_pct),
          disk_free_bytes = VALUES(disk_free_bytes),
          services_count  = VALUES(services_count),
          disk_free       = VALUES(disk_free),
          disk_total      = VALUES(disk_total),
          disks           = VALUES(disks),
          services        = VALUES(services),
          events          = VALUES(events),
          bios_info       = VALUES(bios_info),
          cpu_brand       = VALUES(cpu_brand),
          mem_total_bytes = VALUES(mem_total_bytes),
          system_info     = VALUES(system_info),
          network_info    = VALUES(network_info),
          memory_modules  = VALUES(memory_modules),
          motherboard     = VALUES(motherboard),
          cpu             = VALUES(cpu),
          ips             = VALUES(ips)`,
    params
  };
}

const UPSERT_METRICS_MSSQL = `MERGE INTO ad_member_os_baseline AS t
  USING (SELECT
    CAST(? AS DATETIME2)     AS collected_at,
    CAST(? AS VARCHAR(64))   AS agent_id,
    CAST(? AS VARCHAR(128))  AS hostname,
    CAST(? AS FLOAT)         AS cpu_pct,
    CAST(? AS FLOAT)         AS memory_pct,
    CAST(? AS FLOAT)         AS c_used_pct,
    CAST(? AS BIGINT)        AS disk_free_bytes,
    CAST(? AS INT)           AS services_count,
    CAST(? AS NVARCHAR(MAX)) AS disk_free,
    CAST(? AS NVARCHAR(MAX)) AS disk_total,
    CAST(? AS NVARCHAR(MAX)) AS disks,
    CAST(? AS NVARCHAR(MAX)) AS services,
    CAST(? AS NVARCHAR(MAX)) AS events,
    CAST(? AS NVARCHAR(MAX)) AS bios_info,
    CAST(? AS VARCHAR(128))  AS cpu_brand,
    CAST(? AS BIGINT)        AS mem_total_bytes,
    CAST(? AS NVARCHAR(MAX)) AS system_info,
    CAST(? AS NVARCHAR(MAX)) AS network_info,
    CAST(? AS NVARCHAR(MAX)) AS memory_modules,
    CAST(? AS NVARCHAR(MAX)) AS motherboard,
    CAST(? AS NVARCHAR(MAX)) AS cpu,
    CAST(? AS NVARCHAR(MAX)) AS ips
  ) AS s
  ON t.hostname = s.hostname AND t.collected_at = s.collected_at
  WHEN MATCHED THEN UPDATE SET
    cpu_pct         = s.cpu_pct,
    memory_pct      = s.memory_pct,
    c_used_pct      = s.c_used_pct,
    disk_free_bytes = s.disk_free_bytes,
    services_count  = s.services_count,
    disk_free       = s.disk_free,
    disk_total      = s.disk_total,
    disks           = s.disks,
    services        = s.services,
    events          = s.events,
    bios_info       = s.bios_info,
    cpu_brand       = s.cpu_brand,
    mem_total_bytes = s.mem_total_bytes,
    system_info     = s.system_info,
    network_info    = s.network_info,
    memory_modules  = s.memory_modules,
    motherboard     = s.motherboard,
    cpu             = s.cpu,
    ips             = s.ips
  WHEN NOT MATCHED THEN INSERT
    (collected_at, agent_id, hostname,
     cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
     disk_free, disk_total, disks, services, events,
     bios_info, cpu_brand, mem_total_bytes,
     system_info, network_info, memory_modules,
     motherboard, cpu, ips)
  VALUES
    (s.collected_at, s.agent_id, s.hostname,
     s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes, s.services_count,
     s.disk_free, s.disk_total, s.disks, s.services, s.events,
     s.bios_info, s.cpu_brand, s.mem_total_bytes,
     s.system_info, s.network_info, s.memory_modules,
     s.motherboard, s.cpu, s.ips);`;

// ── latest (per-host latest) ───────────────────────────────────────────────
// PK (hostname) — UPSERT replaces the previous "latest" row for that host.
const UPSERT_LATEST_MYSQL = `INSERT INTO ad_member_os_baseline_latest
  (collected_at, agent_id, hostname,
   cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
   disk_free, disk_total, disks, services, events,
   bios_info, cpu_brand, mem_total_bytes,
   system_info, network_info, memory_modules,
   motherboard, cpu, ips)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    collected_at    = VALUES(collected_at),
    cpu_pct         = VALUES(cpu_pct),
    memory_pct      = VALUES(memory_pct),
    c_used_pct      = VALUES(c_used_pct),
    disk_free_bytes = VALUES(disk_free_bytes),
    services_count  = VALUES(services_count),
    disk_free       = VALUES(disk_free),
    disk_total      = VALUES(disk_total),
    disks           = VALUES(disks),
    services        = VALUES(services),
    events          = VALUES(events),
    bios_info       = VALUES(bios_info),
    cpu_brand       = VALUES(cpu_brand),
    mem_total_bytes = VALUES(mem_total_bytes),
    system_info     = VALUES(system_info),
    network_info    = VALUES(network_info),
    memory_modules  = VALUES(memory_modules),
    motherboard     = VALUES(motherboard),
    cpu             = VALUES(cpu),
    ips             = VALUES(ips)`;

const UPSERT_LATEST_MSSQL = `MERGE INTO ad_member_os_baseline_latest AS t
  USING (SELECT
    CAST(? AS DATETIME2)     AS collected_at,
    CAST(? AS VARCHAR(64))   AS agent_id,
    CAST(? AS VARCHAR(128))  AS hostname,
    CAST(? AS FLOAT)         AS cpu_pct,
    CAST(? AS FLOAT)         AS memory_pct,
    CAST(? AS FLOAT)         AS c_used_pct,
    CAST(? AS BIGINT)        AS disk_free_bytes,
    CAST(? AS INT)           AS services_count,
    CAST(? AS NVARCHAR(MAX)) AS disk_free,
    CAST(? AS NVARCHAR(MAX)) AS disk_total,
    CAST(? AS NVARCHAR(MAX)) AS disks,
    CAST(? AS NVARCHAR(MAX)) AS services,
    CAST(? AS NVARCHAR(MAX)) AS events,
    CAST(? AS NVARCHAR(MAX)) AS bios_info,
    CAST(? AS VARCHAR(128))  AS cpu_brand,
    CAST(? AS BIGINT)        AS mem_total_bytes,
    CAST(? AS NVARCHAR(MAX)) AS system_info,
    CAST(? AS NVARCHAR(MAX)) AS network_info,
    CAST(? AS NVARCHAR(MAX)) AS memory_modules,
    CAST(? AS NVARCHAR(MAX)) AS motherboard,
    CAST(? AS NVARCHAR(MAX)) AS cpu,
    CAST(? AS NVARCHAR(MAX)) AS ips
  ) AS s
  ON t.hostname = s.hostname
  WHEN MATCHED THEN UPDATE SET
    collected_at    = s.collected_at,
    cpu_pct         = s.cpu_pct,
    memory_pct      = s.memory_pct,
    c_used_pct      = s.c_used_pct,
    disk_free_bytes = s.disk_free_bytes,
    services_count  = s.services_count,
    disk_free       = s.disk_free,
    disk_total      = s.disk_total,
    disks           = s.disks,
    services        = s.services,
    events          = s.events,
    bios_info       = s.bios_info,
    cpu_brand       = s.cpu_brand,
    mem_total_bytes = s.mem_total_bytes,
    system_info     = s.system_info,
    network_info    = s.network_info,
    memory_modules  = s.memory_modules,
    motherboard     = s.motherboard,
    cpu             = s.cpu,
    ips             = s.ips
  WHEN NOT MATCHED THEN INSERT
    (collected_at, agent_id, hostname,
     cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
     disk_free, disk_total, disks, services, events,
     bios_info, cpu_brand, mem_total_bytes,
     system_info, network_info, memory_modules,
     motherboard, cpu, ips)
  VALUES
    (s.collected_at, s.agent_id, s.hostname,
     s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes, s.services_count,
     s.disk_free, s.disk_total, s.disks, s.services, s.events,
     s.bios_info, s.cpu_brand, s.mem_total_bytes,
     s.system_info, s.network_info, s.memory_modules,
     s.motherboard, s.cpu, s.ips);`;

// ── reads (front-end driven) ──────────────────────────────────────────────
// R158.86 — latest-by-hostname for /memberServer first-paint "OS 基线" tab.
// R158.86.4 — 19 字段 SELECT (跟 ad 端 os-baseline.js 平行).
const LATEST_BY_HOSTNAME_MYSQL = `SELECT collected_at, agent_id, hostname,
       cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
       disk_free, disk_total, disks, services, events,
       bios_info, cpu_brand, mem_total_bytes,
       system_info, network_info, memory_modules,
       motherboard, cpu, ips
  FROM ad_member_os_baseline_latest
  WHERE hostname = ?
  LIMIT 1`;

const LATEST_BY_HOSTNAME_MSSQL = `SELECT TOP 1 collected_at, agent_id, hostname,
       cpu_pct, memory_pct, c_used_pct, disk_free_bytes, services_count,
       disk_free, disk_total, disks, services, events,
       bios_info, cpu_brand, mem_total_bytes,
       system_info, network_info, memory_modules,
       motherboard, cpu, ips
  FROM ad_member_os_baseline_latest
  WHERE hostname = CAST(? AS VARCHAR(128))`;

// R158.86 — timeseries drilldown, 跟 R158.78 latestSummary 同 shape,
// LEFT JOIN ad_member_servers + ad_sites 给前端 site 标签.
// R158.86.4 — 19 字段 SELECT.
const QUERY_BY_HOSTNAME_MYSQL = `SELECT s.collected_at,
       s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes, s.services_count,
       s.disk_free, s.disk_total, s.disks, s.services, s.events,
       s.bios_info, s.cpu_brand, s.mem_total_bytes,
       s.system_info, s.network_info, s.memory_modules,
       s.motherboard, s.cpu, s.ips,
       ms.site_id, ds.site_name
  FROM ad_member_os_baseline s
  LEFT JOIN ad_member_servers ms ON ms.hostname = s.hostname
  LEFT JOIN ad_sites ds ON ds.site_id = ms.site_id
  WHERE s.hostname = ?
    AND s.collected_at >= (NOW() - INTERVAL ? HOUR)
  ORDER BY s.collected_at DESC
  LIMIT ?`;

function queryByHostname({ hostname, hours = 24, limit = 500 }) {
  const safeLimit = Math.max(1, Math.min(20000, Number.parseInt(limit, 10) || 500));
  return {
    sql: QUERY_BY_HOSTNAME_MYSQL,
    params: [hostname, hours, safeLimit]
  };
}

function queryByHostnameMssql({ hostname, hours = 24, limit = 500 }) {
  // R158.17.5 — MSSQL 不接受参数化 TOP. 路由用 clampInt 夹紧.
  const safeLimit = Math.max(1, Math.min(20000, Number.parseInt(limit, 10) || 500));
  return {
    sql: `SELECT TOP ${safeLimit} s.collected_at,
                 s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes, s.services_count,
                 s.disk_free, s.disk_total, s.disks, s.services, s.events,
                 s.bios_info, s.cpu_brand, s.mem_total_bytes,
                 s.system_info, s.network_info, s.memory_modules,
                 s.motherboard, s.cpu, s.ips,
                 ms.site_id, ds.site_name
            FROM ad_member_os_baseline s
            LEFT JOIN ad_member_servers ms ON ms.hostname = s.hostname
            LEFT JOIN ad_sites ds ON ds.site_id = ms.site_id
           WHERE s.hostname = CAST(? AS VARCHAR(128))
             AND s.collected_at >= (DATEADD(HOUR, -?, SYSUTCDATETIME()))
           ORDER BY s.collected_at DESC`,
    params: [hostname, hours]
  };
}

// ── retention ─────────────────────────────────────────────────────────────
// R158.86.2 (2026-10-12) — operator directive "数据保留10天", 7d → 10d.
// R158.86.4 — purge 不变, 仍 DELETE 整行 (新 14 JSON 列在 JSON 内部,
// 整行时间到了就 drop).

// ── list (R158.99) ────────────────────────────────────────────────────────
// R158.99 (2026-10-13) — R158.86 ship 时 route 复用了 DC helper
// `db.sql.osBaselineMetrics.listLatestPerAgent` (查 pkg_ad_os_baseline.metrics,
// member 端 0 行). member endpoint 必须用真正的 member 表 helper. R158.86
// ship 时漏了 "全 member server list per host" helper — 只有 latestByHostname
// (单 host) + queryByHostname (单 host 时序). 新增 listLatestPerAgent +
// listTimeseriesByAgent 跟 DC 端 osBaselineMetrics/osBaselineTimeseries
// 同 signature 平行 (function 返 string SQL, sinceHours/agentIds 通过
// 字符串 interpolation 拼, 跟 R158.7 hub-resources / R158.29 同 precedent),
// 走 ad_member_os_baseline (时序) + ad_member_servers + ad_sites LEFT JOIN
// 给前端 site_name.

const LIST_LATEST_MYSQL = ({ sinceHours = 24 } = {}) => {
  const h = Math.max(1, Math.min(720, Number.parseInt(sinceHours, 10) || 24));
  return `SELECT s.collected_at, s.agent_id, s.hostname,
       s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes, s.services_count,
       s.disk_free, s.disk_total, s.disks, s.services, s.events,
       s.bios_info, s.cpu_brand, s.mem_total_bytes,
       s.system_info, s.network_info, s.memory_modules,
       s.motherboard, s.cpu, s.ips,
       ms.site_id, ds.site_name
  FROM ad_member_os_baseline s
  INNER JOIN (
    SELECT hostname, MAX(collected_at) AS max_collected
    FROM ad_member_os_baseline
    WHERE collected_at >= (NOW() - INTERVAL ${h} HOUR)
    GROUP BY hostname
  ) latest ON latest.hostname = s.hostname AND latest.max_collected = s.collected_at
  LEFT JOIN ad_member_servers ms ON ms.hostname = s.hostname
  LEFT JOIN ad_sites ds ON ds.site_id = ms.site_id
  ORDER BY s.collected_at DESC`;
};

const LIST_LATEST_MSSQL = ({ sinceHours = 24 } = {}) => {
  const h = Math.max(1, Math.min(720, Number.parseInt(sinceHours, 10) || 24));
  return `WITH latest AS (
    SELECT hostname, MAX(collected_at) AS max_collected
    FROM ad_member_os_baseline
    WHERE collected_at >= DATEADD(HOUR, -${h}, SYSUTCDATETIME())
    GROUP BY hostname
  )
  SELECT s.collected_at, s.agent_id, s.hostname,
         s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes, s.services_count,
         s.disk_free, s.disk_total, s.disks, s.services, s.events,
         s.bios_info, s.cpu_brand, s.mem_total_bytes,
         s.system_info, s.network_info, s.memory_modules,
         s.motherboard, s.cpu, s.ips,
         ms.site_id, ds.site_name
  FROM ad_member_os_baseline s
  JOIN latest ON latest.hostname = s.hostname AND latest.max_collected = s.collected_at
  LEFT JOIN ad_member_servers ms ON ms.hostname = s.hostname
  LEFT JOIN ad_sites ds ON ds.site_id = ms.site_id
  ORDER BY s.collected_at DESC`;
};

const LIST_TIMESERIES_MYSQL = ({ agentIds, sinceMinutes } = {}) => {
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return { sql: null, params: [] };  // caller short-circuits
  }
  const m = Math.max(1, Math.min(43200, Number.parseInt(sinceMinutes, 10) || 1440));
  return {
    sql: `SELECT s.hostname, s.collected_at,
            s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes
      FROM ad_member_os_baseline s
      WHERE s.hostname IN (${agentIds.map(() => '?').join(',')})
        AND s.collected_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${m} MINUTE)
      ORDER BY s.hostname ASC, s.collected_at ASC`,
    params: agentIds
  };
};

const LIST_TIMESERIES_MSSQL = ({ agentIds, sinceMinutes } = {}) => {
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return { sql: null, params: [] };
  }
  const m = Math.max(1, Math.min(43200, Number.parseInt(sinceMinutes, 10) || 1440));
  return {
    sql: `SELECT s.hostname, s.collected_at,
            s.cpu_pct, s.memory_pct, s.c_used_pct, s.disk_free_bytes
      FROM ad_member_os_baseline s
      WHERE s.hostname IN (${agentIds.map(() => '?').join(',')})
        AND s.collected_at >= DATEADD(MINUTE, -${m}, SYSUTCDATETIME())
      ORDER BY s.hostname ASC, s.collected_at ASC`,
    params: agentIds
  };
};

// R158.86.2 (2026-10-12) — operator directive "数据保留10天", 7d → 10d.
// R158.86.4 — purge 不变, 仍 DELETE 整行 (新 14 JSON 列在 JSON 内部,
// 整行时间到了就 drop).
const PURGE_OLDER_THAN_MYSQL = 'DELETE FROM ad_member_os_baseline WHERE collected_at < ?';
const PURGE_OLDER_THAN_MSSQL = 'DELETE FROM ad_member_os_baseline WHERE collected_at < CAST(? AS DATETIME2)';

const PURGE_OLDER_THAN_LATEST_MYSQL = `DELETE FROM ad_member_os_baseline_latest
  WHERE hostname IN (
    SELECT hostname FROM ad_member_servers
    WHERE last_seen_at < ?
  )`;
const PURGE_OLDER_THAN_LATEST_MSSQL = `DELETE FROM ad_member_os_baseline_latest
  WHERE hostname IN (
    SELECT hostname FROM ad_member_servers
    WHERE last_seen_at < CAST(? AS DATETIME2)
  )`;

function purgeOlderThan({ cutoffIso }) {
  return {
    sql:    PURGE_OLDER_THAN_MYSQL,
    params: [cutoffIso]
  };
}

function purgeOlderThanMssql({ cutoffIso }) {
  return {
    sql:    PURGE_OLDER_THAN_MSSQL,
    params: [cutoffIso]
  };
}

// latest 表按 ad_member_servers.last_seen_at 过期清理
// (member-server 消失 N 天, latest 行的 hostname 不再有效).
function purgeLatestByStaleServer({ cutoffIso }) {
  return {
    sql:    PURGE_OLDER_THAN_LATEST_MYSQL,
    params: [cutoffIso]
  };
}

function purgeLatestByStaleServerMssql({ cutoffIso }) {
  return {
    sql:    PURGE_OLDER_THAN_LATEST_MSSQL,
    params: [cutoffIso]
  };
}

export const memberOsBaseline = {
  mysql: {
    upsertMetrics: ({ collectedAt, agentId, hostname,
      cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
      diskFree, diskTotal, disks, services, events,
      biosInfo, cpuBrand, memTotalBytes,
      systemInfo, networkInfo, memoryModules,
      motherboard, cpu, ips }) => ({
      sql:    UPSERT_METRICS_MYSQL,
      params: [collectedAt, agentId, hostname,
        cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
        diskFree, diskTotal, disks, services, events,
        biosInfo, cpuBrand, memTotalBytes,
        systemInfo, networkInfo, memoryModules,
        motherboard, cpu, ips]
    }),
    upsertMetricsBatch,
    upsertLatest: ({ collectedAt, agentId, hostname,
      cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
      diskFree, diskTotal, disks, services, events,
      biosInfo, cpuBrand, memTotalBytes,
      systemInfo, networkInfo, memoryModules,
      motherboard, cpu, ips }) => ({
      sql:    UPSERT_LATEST_MYSQL,
      params: [collectedAt, agentId, hostname,
        cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
        diskFree, diskTotal, disks, services, events,
        biosInfo, cpuBrand, memTotalBytes,
        systemInfo, networkInfo, memoryModules,
        motherboard, cpu, ips]
    }),
    latestByHostname: ({ hostname }) => ({
      sql:    LATEST_BY_HOSTNAME_MYSQL,
      params: [hostname]
    }),
    // R158.99 — list all member servers' latest row (跟 DC 端 osBaselineMetrics.listLatestPerAgent 同 shape 平行, function 返 string SQL with interpolated sinceHours)
    listLatestPerAgent: LIST_LATEST_MYSQL,
    // R158.99 — list all member servers' timeseries (跟 DC 端 osBaselineTimeseries 同 shape 平行, function 返 {sql, params} 跟 existing 模式)
    listTimeseriesByAgent: LIST_TIMESERIES_MYSQL,
    queryByHostname,
    purgeOlderThan,
    purgeLatestByStaleServer
  },
  mssql: {
    upsertMetrics: ({ collectedAt, agentId, hostname,
      cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
      diskFree, diskTotal, disks, services, events,
      biosInfo, cpuBrand, memTotalBytes,
      systemInfo, networkInfo, memoryModules,
      motherboard, cpu, ips }) => ({
      sql:    UPSERT_METRICS_MSSQL,
      params: [collectedAt, agentId, hostname,
        cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
        diskFree, diskTotal, disks, services, events,
        biosInfo, cpuBrand, memTotalBytes,
        systemInfo, networkInfo, memoryModules,
        motherboard, cpu, ips]
    }),
    upsertMetricsBatch: upsertMetricsBatch, // batch 同样适用 mssql via MERGE VALUES — v1 留 single-row 路径
    upsertLatest: ({ collectedAt, agentId, hostname,
      cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
      diskFree, diskTotal, disks, services, events,
      biosInfo, cpuBrand, memTotalBytes,
      systemInfo, networkInfo, memoryModules,
      motherboard, cpu, ips }) => ({
      sql:    UPSERT_LATEST_MSSQL,
      params: [collectedAt, agentId, hostname,
        cpuPct, memoryPct, cUsedPct, diskFreeBytes, servicesCount,
        diskFree, diskTotal, disks, services, events,
        biosInfo, cpuBrand, memTotalBytes,
        systemInfo, networkInfo, memoryModules,
        motherboard, cpu, ips]
    }),
    latestByHostname: ({ hostname }) => ({
      sql:    LATEST_BY_HOSTNAME_MSSQL,
      params: [hostname]
    }),
    // R158.99 — 同上 mssql 版
    listLatestPerAgent: LIST_LATEST_MSSQL,
    listTimeseriesByAgent: LIST_TIMESERIES_MSSQL,
    queryByHostname:  queryByHostnameMssql,
    purgeOlderThan:   purgeOlderThanMssql,
    purgeLatestByStaleServer: purgeLatestByStaleServerMssql
  }
};
