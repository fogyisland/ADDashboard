// SQL helpers for the system_alerts table (R158.68).
// 5 内置告警 kind 共享一张表 (heartbeat_offline / replication_failed /
// port_latency_high / disk_low / failed_logon_spike). 跟 alert_events
// 同模式 (单表多 kind), 但语义不同:
//   - alert_events 是配置驱动的规则触发历史 (R158.62, 已删)
//   - system_alerts 是 5 detector 写入的"事实"告警, 不依赖 operator 配规则
//   - state 三态 firing → recovered → acked
//   - detail JSON 存 detector 现场数据 (offline_min / p95_ms / disk_free_kb ...)
//   - threshold JSON 存触发时阈值快照 (后续调整阈值不抹历史)
//   - last_notified_at + notify_count 实现邮件节流 (避免重复邮件轰炸)

export const systemAlerts = {
  mysql: {
    // INSERT, 返 lastInsertId (mysql2 driver 走 result.insertId)
    insert: `INSERT INTO system_alerts
      (kind, scope_type, scope_ref, state, threshold, detail, fired_at)
      VALUES (?, ?, ?, 'firing', ?, ?, UTC_TIMESTAMP(3))`,

    // 按 kind + scope 找当前 firing (cooldown 用)
    // 同一 kind+scope_ref 的 firing 持续期间, detector 不会重复 INSERT
    findOpenByKindScope: `SELECT id, kind, scope_type, scope_ref, state, threshold, detail,
                                 fired_at, last_notified_at, notify_count
                          FROM system_alerts
                          WHERE kind = ? AND scope_type = ?
                            AND (scope_ref <=> ? OR (scope_ref IS NULL AND ? IS NULL))
                            AND state = 'firing'
                          ORDER BY id DESC
                          LIMIT 1`,

    // R158.X.4 (2026-10-16) — 兜底门: 不限 state, 查同 kind+scope 最近 1 行.
    //   用途: maybeFire 新 INSERT 路径 line 297 前门, 防止 recovered 后又 firing
    //   走新 INSERT 路径立即发邮件 (老 last_notified_at 节流基线失效).
    //   若 last_notified_at 距今 < NOTIFY_THROTTLE_MINUTES → 跳过 enqueueAlertEmail.
    //   1:1 平行 findOpenByKindScope scope 匹配 (scope_ref <=> ? 兼容 NULL).
    // R158.X.6 (2026-10-16) — 节流基线改 fired_at (永远不被 markRecovered/notify_count
    //   改, 稳定). 加 fired_at >= UTC_TIMESTAMP(3) - INTERVAL ? MINUTE SQL 层 filter.
    //   修 Bug E (R158.X.4 兜底门自打脸) + Bug F (R158.X.5 notify_count 兜底门错配).
    // R158.X.99.34.c (2026-10-19) — 节流窗 60 → 120 min, 跟 NOTIFY_THROTTLE_MINUTES 1:1 平行.
    //   `?` 占位符接收 NOTIFY_THROTTLE_MINUTES, 改 engine.js 常量即生效, SQL 不必改.
    //   1:1 平行 MSSQL 段.
    findRecentByKindScope: `SELECT id, kind, scope_type, scope_ref, state, threshold, detail,
                                   fired_at, recovered_at, acked_at, last_notified_at, notify_count
                            FROM system_alerts
                            WHERE kind = ? AND scope_type = ?
                              AND (scope_ref <=> ? OR (scope_ref IS NULL AND ? IS NULL))
                              AND fired_at >= UTC_TIMESTAMP(3) - INTERVAL ? MINUTE
                            ORDER BY id DESC
                            LIMIT 1`,

    // 查 current firing (UI 当前告警 tab). kind/scope_ref 可选过滤.
    // LIMIT 走参数绑定 (mysql2 支持 LIMIT ?)
    listFiring: ({ kind = null, scope_ref = null, limit = 100 } = {}) => {
      let sql = `SELECT id, kind, scope_type, scope_ref, state, threshold, detail,
                        fired_at, recovered_at, acked_at, acked_by, last_notified_at, notify_count
                 FROM system_alerts
                 WHERE state = 'firing'`;
      if (kind) sql += ` AND kind = ?`;
      if (scope_ref) sql += ` AND scope_ref = ?`;
      sql += ` ORDER BY fired_at DESC, id DESC LIMIT ${Number(limit) || 100}`;
      return sql;
    },

    // 查历史 (含 recovered/acked). UI 历史告警 tab.
    listRecent: ({ kind = null, limit = 100 } = {}) => {
      let sql = `SELECT id, kind, scope_type, scope_ref, state, threshold, detail,
                        fired_at, recovered_at, acked_at, acked_by, last_notified_at, notify_count
                 FROM system_alerts
                 WHERE 1=1`;
      if (kind) sql += ` AND kind = ?`;
      sql += ` ORDER BY fired_at DESC, id DESC LIMIT ${Number(limit) || 100}`;
      return sql;
    },

    // R158.X.99.34.d (2026-10-19) — in-app notification 列表端点 helper.
    //   取代 listRecent 走 `since` 时戳 filter (client-controlled watermark) 替代
    //   `limit=N` rows cap. 0 改 listRecent (SystemAlertsView 历史 tab 仍用 limit)。
    //   fired_at / recovered_at / acked_at 三列任一 > since → 返该行,
    //   前端 store 派生 3 类 state-transition (新 firing / firing→recovered /
    //   firing→acked) 推 in-app toast + BellIcon badge. 1:1 平行 mssql 段 listSince.
    listSince: ({ since, limit = 50 } = {}) => {
      const lim = Math.min(200, Math.max(1, Number(limit) || 50));
      return `SELECT id, kind, scope_type, scope_ref, state, threshold, detail,
                    fired_at, recovered_at, acked_at, acked_by, last_notified_at, notify_count
             FROM system_alerts
             WHERE (fired_at > ?
                    OR (recovered_at IS NOT NULL AND recovered_at > ?)
                    OR (acked_at IS NOT NULL AND acked_at > ?))
             ORDER BY fired_at DESC, id DESC
             LIMIT ${lim}`;
    },

    // KPI bar: firing 总数 / 24h 触发 / 24h 恢复 / 24h 已 ack
    // R158.X.116.m (2026-10-23) — 补 recovered_24h_count + 给 acked 加 24h 窗。
    //   1:1 平行 MSSQL 段同名 helper (含完整真因注释)。acked_count 原为全历史
    //   总数, 但 UI label 是「24h 已 ack」, 补窗后语义才对齐。
    countKpi: `SELECT
         SUM(CASE WHEN state = 'firing' THEN 1 ELSE 0 END) AS firing_count,
         SUM(CASE WHEN fired_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS last_24h_count,
         SUM(CASE WHEN recovered_at IS NOT NULL
                   AND recovered_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
                  THEN 1 ELSE 0 END) AS recovered_24h_count,
         SUM(CASE WHEN state = 'acked'
                   AND acked_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)
                  THEN 1 ELSE 0 END) AS acked_count
       FROM system_alerts`,

    // firing → recovered (detector 下一轮发现条件不满足)
    // 注意: 只 update state='firing' 的行 (避免覆盖 acked)
    // R158.X.3 (2026-10-16) — 清 notify_count, 保留 last_notified_at (节流基线).
    //   R158.X.5 (2026-10-16) — 修订: 保留 last_notified_at 作节流基线 (60min 窗
    //   稳定), 只归零 notify_count. 修 Bug B: 归零后兜底门失效 (last_notified_at
    //   NULL → notify_count=0 → 下一行 INSERT 永远发). 修 Bug E: 兜底门改用
    //   notify_count > 0 (1:1 平行 NOTIFY_THROTTLE_MINUTES 语义). 跟 R158.X.3
    //   directive "恢复后置零" 不冲突: "置零" = 退到 "可再次发邮件" 状态.
    //   1:1 平行 MSSQL 段.
    markRecovered: `UPDATE system_alerts
                    SET state = 'recovered', recovered_at = UTC_TIMESTAMP(3),
                        notify_count = 0
                    WHERE id = ? AND state = 'firing'`,

    // R158.X.115 (2026-10-20) — 按 scope_ref 批量关闭 firing 告警。
    //   主机退役/暂停管控时用 (services/host-status.js closeOpenAlerts):
    //   这台机器当前 firing 的告警不再有意义, 批量标 recovered 闭合状态,
    //   数据保留在表里可查 (state 变 recovered 而非物理删)。
    //   语义跟单条 markRecovered 1:1: 只动 state='firing' 的行, 不碰 acked;
    //   notify_count 归零 (R158.X.3/X.5 口径), last_notified_at 保留作节流基线。
    //   scope_type='host' 限定: 不误伤 failed_logon_spike 这类
    //   scope_type='global' / scope_ref IS NULL 的告警。
    markRecoveredByScope: `UPDATE system_alerts
                    SET state = 'recovered', recovered_at = UTC_TIMESTAMP(3),
                        notify_count = 0
                    WHERE scope_type = 'host' AND scope_ref = ? AND state = 'firing'`,

    // operator 手动 ack
    markAcked: `UPDATE system_alerts
                SET state = 'acked', acked_at = UTC_TIMESTAMP(3), acked_by = ?
                WHERE id = ? AND state = 'firing'`,

    // 邮件节流: 每次重发邮件, 更新 last_notified_at + notify_count
    bumpNotify: `UPDATE system_alerts
                SET last_notified_at = UTC_TIMESTAMP(3), notify_count = notify_count + 1
                WHERE id = ?`,

    // Detector 评估: 列出最近 5min 内有 heartbeat 的 host (给 detectHeartbeatOffline 排除用)
    // 实际 detector 用 ad_member_servers.last_seen_at 直接比较, 这条 query 备用
    listActiveHosts: `SELECT hostname, last_seen_at
                      FROM ad_member_servers
                      WHERE enabled = 1
                      ORDER BY hostname`,

    // R158.X.99.report (2026-10-21) — 日报/周报「节点离线明细」段数据源.
    //   离线事件真相已经在本表 (detectHeartbeatOffline 写 fired_at,
    //   checkRecovered 写 recovered_at), 日报只是从来没查过它.
    //
    //   ⚠ 口径限定 (必读, 写进报告正文避免误读): 本表只记录**超过阈值**的
    //     离线 (system_alert_heartbeat_offline_minutes, 默认 15 min).
    //     心跳缺失 3~14 min 的短抖动**不会**产生行 —— 两张心跳表
    //     (ad_agent_heartbeat / ad_member_heartbeat) 都是 UPSERT 覆盖的
    //     当前快照, 0 历史时序, 阈值以下的抖动在数据层根本不存在.
    //     所以本段的准确名字是「**告警级**离线明细」, 不是「全部离线」.
    //     要真覆盖全部抖动需另建 append-only 心跳时序表, 不在本次范围.
    //
    //   窗口口径跟其他段一致: fired_at 落在 [periodStart, periodEnd].
    //   命中条件刻意用 OR 而非 AND —— 一条告警只要**任一端**落在窗口内就要出现:
    //   (a) 窗口内离线: 离线时长完全在窗口内, 报告里是完整记录
    //   (b) 窗口前离线、窗口内恢复 (recovered_at > periodStart): 恢复动作本身
    //       是本时段的事件, 必须让操作员看到"几点恢复的"
    //   只按 fired_at 过滤会漏掉 (b) 类 —— 那正是操作员最想看的"几点恢复".
    //   detail JSON 离线分钟数由调用方 parse (driver 侧无统一 JSON 提取函数).
    listOfflineInWindow: ({ periodStart, periodEnd, limit = 200 } = {}) => {
      const lim = Math.min(500, Math.max(1, Number(limit) || 200));
      return `SELECT id, kind, scope_type, scope_ref, state, detail,
                       fired_at, recovered_at, acked_at
                FROM system_alerts
                WHERE kind = 'heartbeat_offline'
                  AND (fired_at BETWEEN ? AND ?
                       OR (recovered_at IS NOT NULL AND recovered_at BETWEEN ? AND ?))
                ORDER BY fired_at DESC
                LIMIT ${lim}`;
    },

    // R158.X.99.report (2026-10-21) — 「节点离线明细」段 summary 计数.
    //   未恢复 (recovered_at IS NULL) 的行数 = 报告截止时仍在离线, 单独一个桶:
    //   它跟"已恢复"混在一起会让操作员以为都恢复了.
    countOfflineInWindow: `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN recovered_at IS NULL THEN 1 ELSE 0 END) AS still_offline,
         COUNT(DISTINCT scope_ref) AS host_count
       FROM system_alerts
       WHERE kind = 'heartbeat_offline'
         AND (fired_at BETWEEN ? AND ?
              OR (recovered_at IS NOT NULL AND recovered_at BETWEEN ? AND ?))`
  },
  mssql: {
    // mssql 用 OUTPUT inserted.id 返新行 id (mssql driver 走 recordset[0].id)
    insert: `INSERT INTO system_alerts
      (kind, scope_type, scope_ref, state, threshold, detail, fired_at)
      OUTPUT inserted.id
      VALUES (?, ?, ?, 'firing', ?, ?, SYSUTCDATETIME())`,

    findOpenByKindScope: `SELECT TOP 1 id, kind, scope_type, scope_ref, state, threshold, detail,
                                 fired_at, last_notified_at, notify_count
                          FROM system_alerts
                          WHERE kind = ? AND scope_type = ?
                            AND (scope_ref = ? OR (scope_ref IS NULL AND ? IS NULL))
                            AND state = 'firing'
                          ORDER BY id DESC`,

    // R158.X.4 (2026-10-16) — 兜底门, 1:1 平行 MySQL 段 findRecentByKindScope.
    //   跨 state (firing+recovered+acked) 查最近 1 行, 用途同 MySQL 段注释.
    //   mssql TOP 1 替 LIMIT 1, scope 匹配 1:1 平行 findOpenByKindScope 模式.
    // R158.X.6 (2026-10-16) — 节流基线改 fired_at (稳定, 跟 markRecovered/notify_count
    //   解耦). DATEADD(MINUTE, -?, SYSUTCDATETIME()) 替 MySQL INTERVAL 语法.
    // R158.X.99.34.c (2026-10-19) — 节流窗 60 → 120 min, 跟 NOTIFY_THROTTLE_MINUTES 1:1 平行.
    //   `?` 占位符接收 NOTIFY_THROTTLE_MINUTES, 改 engine.js 常量即生效, SQL 不必改.
    findRecentByKindScope: `SELECT TOP 1 id, kind, scope_type, scope_ref, state, threshold, detail,
                                   fired_at, recovered_at, acked_at, last_notified_at, notify_count
                            FROM system_alerts
                            WHERE kind = ? AND scope_type = ?
                              AND (scope_ref = ? OR (scope_ref IS NULL AND ? IS NULL))
                              AND fired_at >= DATEADD(MINUTE, -?, SYSUTCDATETIME())
                            ORDER BY id DESC`,

    // mssql LIMIT 用 TOP n interpolation (binding 不支持)
    listFiring: ({ kind = null, scope_ref = null, limit = 100 } = {}) => {
      let sql = `SELECT TOP ${Number(limit) || 100} id, kind, scope_type, scope_ref, state, threshold, detail,
                        fired_at, recovered_at, acked_at, acked_by, last_notified_at, notify_count
                 FROM system_alerts
                 WHERE state = 'firing'`;
      if (kind) sql += ` AND kind = ?`;
      if (scope_ref) sql += ` AND scope_ref = ?`;
      sql += ` ORDER BY fired_at DESC, id DESC`;
      return sql;
    },

    listRecent: ({ kind = null, limit = 100 } = {}) => {
      let sql = `SELECT TOP ${Number(limit) || 100} id, kind, scope_type, scope_ref, state, threshold, detail,
                        fired_at, recovered_at, acked_at, acked_by, last_notified_at, notify_count
                 FROM system_alerts
                 WHERE 1=1`;
      if (kind) sql += ` AND kind = ?`;
      sql += ` ORDER BY fired_at DESC, id DESC`;
      return sql;
    },

    // R158.X.99.34.d (2026-10-19) — in-app notification 列表端点 helper
    //   MSSQL mirror, 跟 MySQL 段 listSince 1:1 平行 (除 LIMIT → TOP).
    listSince: ({ since, limit = 50 } = {}) => {
      const lim = Math.min(200, Math.max(1, Number(limit) || 50));
      return `SELECT TOP ${lim} id, kind, scope_type, scope_ref, state, threshold, detail,
                    fired_at, recovered_at, acked_at, acked_by, last_notified_at, notify_count
             FROM system_alerts
             WHERE (fired_at > ?
                    OR (recovered_at IS NOT NULL AND recovered_at > ?)
                    OR (acked_at IS NOT NULL AND acked_at > ?))
             ORDER BY fired_at DESC, id DESC`;
    },

    // R158.X.116.m (2026-10-23) — 补 recovered_24h_count + 给 acked 加 24h 窗。
    //   修复前前端 4 个 KPI 全显 '-', 真因是 shape 分裂 (lesson 13):
    //     前端 SystemAlertsView.vue 读 firing / last24h / recovered24h / acked24h,
    //     本 helper 返 firing_count / last_24h_count / acked_count —— 4 个 label
    //     里 3 个字段名对不上, 第 4 个 (恢复) 后端压根没提供。
    //   另: acked_count 原为**全历史**总数 (无时间窗), 但 UI label 写的是
    //     「24h 已 ack」—— 名字对上后数字仍会不符。故补时间窗, 语义对齐 label。
    //   这里只做 24h 窗口径修正, 不改 firing (firing 是**当前快照**, 本就该
    //     无时间窗, 前端 label「当前 firing」也是这个语义)。
    countKpi: `SELECT
         SUM(CASE WHEN state = 'firing' THEN 1 ELSE 0 END) AS firing_count,
         SUM(CASE WHEN fired_at > DATEADD(HOUR, -24, SYSUTCDATETIME()) THEN 1 ELSE 0 END) AS last_24h_count,
         SUM(CASE WHEN recovered_at IS NOT NULL
                   AND recovered_at > DATEADD(HOUR, -24, SYSUTCDATETIME())
                  THEN 1 ELSE 0 END) AS recovered_24h_count,
         SUM(CASE WHEN state = 'acked'
                   AND acked_at > DATEADD(HOUR, -24, SYSUTCDATETIME())
                  THEN 1 ELSE 0 END) AS acked_count
       FROM system_alerts`,

    // R158.X.5 (2026-10-16) — 修订 R158.X.3: 保留 last_notified_at, 只归零
    //   notify_count. 修法同 MySQL 段注释. 1:1 平行 MySQL 段 markRecovered.
    markRecovered: `UPDATE system_alerts
                    SET state = 'recovered', recovered_at = SYSUTCDATETIME(),
                        notify_count = 0
                    WHERE id = ? AND state = 'firing'`,

    // R158.X.115 (2026-10-20) — 按 scope_ref 批量关闭 firing 告警。见 mysql 段注释。
    //   MSSQL mirror, 1:1 平行 (除 UTC_TIMESTAMP(3) → SYSUTCDATETIME())。
    markRecoveredByScope: `UPDATE system_alerts
                    SET state = 'recovered', recovered_at = SYSUTCDATETIME(),
                        notify_count = 0
                    WHERE scope_type = 'host' AND scope_ref = ? AND state = 'firing'`,

    markAcked: `UPDATE system_alerts
                SET state = 'acked', acked_at = SYSUTCDATETIME(), acked_by = ?
                WHERE id = ? AND state = 'firing'`,

    bumpNotify: `UPDATE system_alerts
                SET last_notified_at = SYSUTCDATETIME(), notify_count = notify_count + 1
                WHERE id = ?`,

    listActiveHosts: `SELECT hostname, last_seen_at
                      FROM ad_member_servers
                      WHERE enabled = 1
                      ORDER BY hostname`,

    // R158.X.99.report (2026-10-21) — 日报/周报「节点离线明细」段.
    //   MSSQL mirror, 1:1 平行 mysql 段 listOfflineInWindow / countOfflineInWindow.
    //   仅 LIMIT → TOP n 的语法差异, 语义/窗口口径/OR 过滤完全一致.
    //   口径限定 (告警级离线, 阈值以下抖动不记录) 见 mysql 段长注释.
    listOfflineInWindow: ({ periodStart, periodEnd, limit = 200 } = {}) => {
      const lim = Math.min(500, Math.max(1, Number(limit) || 200));
      return `SELECT TOP ${lim} id, kind, scope_type, scope_ref, state, detail,
                          fired_at, recovered_at, acked_at
               FROM system_alerts
               WHERE kind = 'heartbeat_offline'
                 AND (fired_at BETWEEN ? AND ?
                      OR (recovered_at IS NOT NULL AND recovered_at BETWEEN ? AND ?))
               ORDER BY fired_at DESC`;
    },

    countOfflineInWindow: `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN recovered_at IS NULL THEN 1 ELSE 0 END) AS still_offline,
         COUNT(DISTINCT scope_ref) AS host_count
       FROM system_alerts
       WHERE kind = 'heartbeat_offline'
         AND (fired_at BETWEEN ? AND ?
              OR (recovered_at IS NOT NULL AND recovered_at BETWEEN ? AND ?))`
  }
};
