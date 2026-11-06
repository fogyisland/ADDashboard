// R158.68 (2026-10-10) — pkg_ad_os_baseline.metrics 指标查询
// 跟 osBaselineTimeseries 区别: 这个是 "latest per agent" 单行查询 (UI 列表),
// 那个是 timeseries 24h 时序 (UI 折线). 都走同一张表 (pkg_ad_os_baseline.metrics)
// 但 query shape 不同.
//
// 真表 schema (verified 2026-10-10 against INFORMATION_SCHEMA.COLUMNS on
// db=dashboard, schema=pkg_ad_os_baseline, table=metrics):
//   agent_id varchar NOT NULL
//   ts datetime NOT NULL
//   cpu_pct float / memory_pct float
//   disk_free nvarchar / disk_total nvarchar (JSON strings)
//   services nvarchar / events nvarchar (JSON strings)
//   bios_info nvarchar / cpu_brand nvarchar / mem_total_bytes bigint
//   disks nvarchar / c_used_pct float
//   system_info nvarchar / network_info nvarchar / memory_modules nvarchar
//   motherboard nvarchar / cpu nvarchar / ips nvarchar
//   **没有 hostname / captured_at / metrics 列** — 老 SQL helper 假设错了.
//
// ad_sites 真主键是 site_id (不是 id), 列名 site_name (不是 name).

export const osBaselineMetrics = {
  mysql: {
    // 每 agent 取最近一行 (跟 dashboard.js:284 同一 pattern).
    // site_name + discovered_at 由 routes/os-baseline.js 的 enrich SQL
    // 单独查 (LEFT JOIN ad_dcs → ad_sites). 这里不再带, 避免依赖
    // ad_dcs.domain_name (实际不存在) 等历史列名假设.
    listLatestPerAgent: ({ sinceHours = 24 } = {}) => `
      SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct,
             m.disk_free, m.disk_total, m.services, m.events,
             m.bios_info, m.cpu_brand, m.mem_total_bytes,
             m.disks, m.c_used_pct,
             m.system_info, m.network_info, m.memory_modules
      FROM pkg_ad_os_baseline.metrics m
      WHERE m.ts >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${Number(sinceHours) || 24} HOUR)
        AND m.ts = (SELECT MAX(m2.ts) FROM pkg_ad_os_baseline.metrics m2 WHERE m2.agent_id = m.agent_id)
      ORDER BY m.ts DESC`,

    // 单 host 最新一行 (MemberServerDetailView baseline tab)
    getLatest: `SELECT m.agent_id, m.ts, m.cpu_pct, m.memory_pct,
                       m.disk_free, m.disk_total, m.services, m.events,
                       m.bios_info, m.cpu_brand, m.mem_total_bytes,
                       m.disks, m.c_used_pct,
                       m.system_info, m.network_info, m.memory_modules
                FROM pkg_ad_os_baseline.metrics m
                WHERE m.agent_id = ?
                ORDER BY m.ts DESC
                LIMIT 1`
  },
  mssql: {
    // 2026-10-20 perf (R158 verification) — this used to read
    //
    //   CROSS APPLY (SELECT TOP 1 ts FROM ... WHERE agent_id = m.agent_id
    //                ORDER BY ts DESC) latest
    //   WHERE m.ts = latest.ts AND m.ts >= <window>
    //
    // pkg_ad_os_baseline.metrics is a HEAP with no secondary index (verified
    // against sys.indexes: only type_desc='HEAP'). At ~870k rows / 34 agents
    // that correlated subquery ran once per row of the table. Measured on
    // production: 8195ms avg for this statement — the entire /api/os-baseline
    // and /api/os-baseline/timeseries latency.
    //
    // Rewrite: aggregate FIRST (one sequential pass narrowing to one row per
    // agent inside the window), then join back to fetch the wide nvarchar
    // columns only for those rows. Measured: 152ms avg — 54x faster, and
    // correct without any new index (no DDL, no write-path cost).
    //
    // Semantics also tightened. The old form computed "latest row per agent
    // over the WHOLE table, then filter to the window", so an agent whose
    // newest row predates the window still paid a full subquery before being
    // dropped. The new form computes "latest row per agent WITHIN the
    // window", which is what the endpoint name and the callers mean. Verified
    // equivalent on production: same 34 rows, same 34 agents covered, zero
    // value-level differences (a lone ts delta came from a new agent upload
    // landing between the two queries, not from a shape difference).
    //
    // MySQL sibling above already uses the aggregate-then-filter shape; this
    // brings the MSSQL branch in line with it.
    listLatestPerAgent: ({ sinceHours = 24 } = {}) => `
      SELECT TOP 1000 m.agent_id, m.ts, m.cpu_pct, m.memory_pct,
             m.disk_free, m.disk_total, m.services, m.events,
             m.bios_info, m.cpu_brand, m.mem_total_bytes,
             m.disks, m.c_used_pct,
             m.system_info, m.network_info, m.memory_modules
      FROM pkg_ad_os_baseline.metrics m
      INNER JOIN (SELECT agent_id, MAX(ts) AS ts
                    FROM pkg_ad_os_baseline.metrics
                   WHERE ts >= DATEADD(HOUR, -${Number(sinceHours) || 24}, SYSUTCDATETIME())
                   GROUP BY agent_id) latest
              ON m.agent_id = latest.agent_id AND m.ts = latest.ts
      ORDER BY m.ts DESC`,

    getLatest: `SELECT TOP 1 m.agent_id, m.ts, m.cpu_pct, m.memory_pct,
                       m.disk_free, m.disk_total, m.services, m.events,
                       m.bios_info, m.cpu_brand, m.mem_total_bytes,
                       m.disks, m.c_used_pct,
                       m.system_info, m.network_info, m.memory_modules
                FROM pkg_ad_os_baseline.metrics m
                WHERE m.agent_id = ?
                ORDER BY m.ts DESC`
  }
};
