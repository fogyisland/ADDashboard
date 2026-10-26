// center/src/services/system-alert-engine.js
// R158.68 (2026-10-10) — 系统内置告警 engine
//
// operator 决策 (2026-10-10): "删除现有活动告警问题, 这些都够不上告警, 我说的是
// 告警 1.agent 离线多少分钟, 可配置 2.单条复制链路多少次复制出错 和其他你能想出来的"
//
// 5 detector 共享一张 system_alerts 表 (kind 区分), 邮件走 system_alert_outbox
// (独立队列, 跟 report_email_outbox 物理隔离). 跟 R158.62 alert-engine 区别:
//   - 不依赖 operator 配规则 (5 detector 是硬编码, 阈值走 system_config 7 key)
//   - 状态机 firing → recovered (loop 下一轮自动) → acked (operator 手动)
//   - 邮件节流: 同 kind+scope 已有 firing → 不重复 INSERT; 重发邮件用 last_notified_at 节流 (默认 30min)
//   - 单 detector 失败不破其他 4 种 (R158.60.7 错误隔离模式)
//
// R158.68.1 (2026-10-10) — fix dormant schema drift. R158.68 plan 写 5 detector
//   SQL 时用印象,未先 query INFORMATION_SCHEMA 校准真表 schema. 3 detector 错
//   (replication_failed last_sync_at / port_latency_high hostname+metrics+captured_at /
//   disk_low 同 + 表名缺 .metrics). 跟 R158.62 os-baseline-metrics.js 同源 bug.
//   修法: 列名校准真表 + scope_ref 用 agentId(=hostname) 替 hostnames 时序字段
//   + disk_low 改用 c_used_pct 阈值替代 disk_free_kb JSON parse. 实测 mssql
//   10.170.140.23. 同步关系: [[dashboard-r158-68-detector-diagnosis]]
//
// 工厂: createSystemAlertLoop({ db, getIntervalSeconds, getSystemConfig, logger })
//   → { start, stop, tick, isRunning }  (跟 createEmailDeliveryLoop 同 shape)

// R158.X.1 (2026-10-15) — operator 反馈 "10 分钟一次太频繁, 触发一次后 1
//   小时再发". 改 30 → 60 min. 同一个 alert_id (kind+scope) 在 last_notified_at
//   距今 < 60 min 时直接 return, 不重发邮件也不 bump notify_count.
//   真因: 10 min 间隔不是 detector cadence 也不是 emailLoop cadence (两边都
//   60s), 实测发现是 ad_replication_status 行的 status_code 在 0 ↔ 非 0 之间
//   抖动 → checkRecovered 反复 markRecovered → 下轮 detector 新 INSERT →
//   attempt_count 永远 1/5. 节流改 60 min 是产品决策, 同时保留 status_code
//   抖动 0 修 (留作 R158.X.2 followup, 跟 R158.69.10 同期).
//
// R158.X.99.34.c (2026-10-19) — operator 反馈 "2 小时轮询一次, 如果发送,
//   则两小时后才发送, 避免发送太多次邮件". 改 60 → 120 min. 同一个 alert_id
//   (kind+scope) 距上次发送 < 120 min 不重发, 跟 detector eval cadence (10min,
//   R158.X.99.34.b 配 600s) 完全脱钩 — eval interval 决定 detector 多久查
//   一次, NOTIFY_THROTTLE_MINUTES 决定多久发一次邮件. 一个是查询频率, 一个
//   是发件频率, 操作员 directive 把发件频率从 1h 拉到 2h. 0 改 SQL helper
//   (findRecentByKindScope 走 `?` 占位符接收 minutes 参数, system-alerts.js
//   line 40-47 MySQL + 132-138 MSSQL 自动接收新值), 仅改本常量 + 注释.
//   1 后端 file 1 line 改.
const NOTIFY_THROTTLE_MINUTES = 120; // 同 kind+scope 重发邮件节流 (1:1 平行 findRecentByKindScope SQL `?` 参数)

// ---------------------------------------------------------------------------
// R158.X.115 (2026-10-20) — isHostOffManagement()
//   单一真源: 判断某主机是否已退出管控 (退役 或 暂停管控)。
//
//   背景: 「服务器下线」功能引入 decommissioned_at (终态) /
//   monitoring_paused_at (临时态) 两列。退出管控的机器不该再被告警评估,
//   否则退役 DC 会永久挂在 heartbeat_offline / disk_low firing 列表里 —
//   这正是本次要解决的问题。
//
//   两条 namespace 都要查 (跟 detectHeartbeatOffline 的 UNION ALL 1:1 平行):
//     · ad_member_servers.hostname  — member server
//     · ad_dcs.dc_name              — DC (ad_agent_heartbeat.agent_id 存的就是 dc_name)
//   命中任一即视为已退出管控。
//
//   消费方 (checkRecovered 的 checker): 返回 true = "已恢复" → markRecovered。
//   退役机器等价于已恢复, 因为它已不在评估范围内, 不该继续 firing。
// ---------------------------------------------------------------------------
async function isHostOffManagement(db, scopeRef) {
  const sql = db.dialect === 'mssql'
    ? `SELECT TOP 1 1 AS hit FROM ad_member_servers
       WHERE hostname = ? AND (decommissioned_at IS NOT NULL OR monitoring_paused_at IS NOT NULL)`
    : `SELECT 1 AS hit FROM ad_member_servers
       WHERE hostname = ? AND (decommissioned_at IS NOT NULL OR monitoring_paused_at IS NOT NULL)`;
  const r = await db.query(sql, [scopeRef]);
  if (r.rows.length > 0) return true;

  const dcSql = db.dialect === 'mssql'
    ? `SELECT TOP 1 1 AS hit FROM ad_dcs
       WHERE dc_name = ? AND (decommissioned_at IS NOT NULL OR monitoring_paused_at IS NOT NULL)`
    : `SELECT 1 AS hit FROM ad_dcs
       WHERE dc_name = ? AND (decommissioned_at IS NOT NULL OR monitoring_paused_at IS NOT NULL)`;
  const d = await db.query(dcSql, [scopeRef]);
  return d.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Detector 1: heartbeat_offline
// R158.X.99.34.b (2026-10-19) — UNION ALL 跨 2 条心跳 namespace:
//   1. member-server 端: ad_member_servers.hostname + enabled + last_seen_at
//      (R158.46 已建, 只在 agentType=='non-ad' 分支 touch)
//   2. AD agent 端: ad_agent_heartbeat.agent_id + last_heartbeat_at
//      (R158.69 namespace, append-only, agent_id 不是 hostname)
// 阈值从 system_config.system_alert_heartbeat_offline_minutes 读 (默认 15).
//
// 修 R158.X.99.34 没闭合的真因: 老 SQL 只看 member 表 → AD agent (DC 域控)
//   离线永远静默. 操作员 2026-10-19 directive "节点没死机,但 agent 过不来
//   就应该报警" → 真实场景 = KDLWHOFADSRV1/2 离线 7.2h/10h 0 告警 (R158.69
//   fleet ~DC fleet, AD agent namespace). fix: UNION ALL 两条 namespace,
//   各自保留 enabled/agent_id filter, hostname / agent_id 走 [scope_ref]
//   字段命名 (scope_type 一律 'host'). 0 改 schema / 0 改 wire / 0 改
//   checkRecovered 行为 (checkRecovered 仍查 append-only 心跳表 PK 列).
//
// R158.X.115 (2026-10-20) — 退役/暂停管控过滤。member 端加
//   `decommissioned_at IS NULL AND monitoring_paused_at IS NULL`;
//   AD 端 ad_agent_heartbeat 没这两列, 改用 INNER JOIN ad_dcs 取状态
//   (ad_dcs 有 FK 无 → dc_name 是 agent_id 的值, R158.69 fleet 约定)。
//   退役/暂停的机器永久退出告警评估, 这是「下线」功能的核心诉求:
//   退役 ≠ 临时离线, 前者不该再 fire, 后者照常 fire (返修场景)。
// ---------------------------------------------------------------------------
async function detectHeartbeatOffline(db, getConfig) {
  const cfg = await getConfig();
  const thresholdMin = Number(cfg?.system_alert_heartbeat_offline_minutes) || 15;
  // R158.X.99.34.b (2026-10-19) — UNION ALL 两条心跳 namespace. 各自保留
  // 原 filter, 0 改 member 端 enabled=1 (R158.46 ship 行为), AD 端不加
  // enabled (ad_agent_heartbeat 没这列). scope_ref 字段别名后统一格式:
  //   member: hostname, ad: agent_id. offline_min 走 dialect-specific
  //   DATEDIFF / TIMESTAMPDIFF, 跟原 1:1 平行.
  const sql = db.dialect === 'mssql'
    ? `SELECT hostname COLLATE SQL_Latin1_General_CP1_CI_AS AS scope_ref,
               last_seen_at AS last_seen,
               DATEDIFF(MINUTE, last_seen_at, SYSUTCDATETIME()) AS offline_min
        FROM ad_member_servers
        WHERE enabled = 1
          AND decommissioned_at IS NULL
          AND monitoring_paused_at IS NULL
          AND last_seen_at IS NOT NULL
          AND DATEDIFF(MINUTE, last_seen_at, SYSUTCDATETIME()) >= ?
        UNION ALL
        SELECT ah.agent_id COLLATE SQL_Latin1_General_CP1_CI_AS AS scope_ref,
               ah.last_heartbeat_at AS last_seen,
               DATEDIFF(MINUTE, ah.last_heartbeat_at, SYSUTCDATETIME()) AS offline_min
        FROM ad_agent_heartbeat ah
        INNER JOIN ad_dcs ad ON ad.dc_name = ah.agent_id
        WHERE ah.last_heartbeat_at IS NOT NULL
          AND ah.agent_id <> '__healthcheck__'
          AND ad.decommissioned_at IS NULL
          AND ad.monitoring_paused_at IS NULL
          AND DATEDIFF(MINUTE, ah.last_heartbeat_at, SYSUTCDATETIME()) >= ?`
    : `SELECT hostname AS scope_ref,
               last_seen_at AS last_seen,
               TIMESTAMPDIFF(MINUTE, last_seen_at, UTC_TIMESTAMP(3)) AS offline_min
        FROM ad_member_servers
        WHERE enabled = 1
          AND decommissioned_at IS NULL
          AND monitoring_paused_at IS NULL
          AND last_seen_at IS NOT NULL
          AND TIMESTAMPDIFF(MINUTE, last_seen_at, UTC_TIMESTAMP(3)) >= ?
        UNION ALL
        SELECT ah.agent_id AS scope_ref,
               ah.last_heartbeat_at AS last_seen,
               TIMESTAMPDIFF(MINUTE, ah.last_heartbeat_at, UTC_TIMESTAMP(3)) AS offline_min
        FROM ad_agent_heartbeat ah
        INNER JOIN ad_dcs ad ON ad.dc_name = ah.agent_id
        WHERE ah.last_heartbeat_at IS NOT NULL
          AND ah.agent_id <> '__healthcheck__'
          AND ad.decommissioned_at IS NULL
          AND ad.monitoring_paused_at IS NULL
          AND TIMESTAMPDIFF(MINUTE, ah.last_heartbeat_at, UTC_TIMESTAMP(3)) >= ?`;
  const { rows } = await db.query(sql, [thresholdMin, thresholdMin]);

  for (const r of rows) {
    const detail = {
      offline_min: Number(r.offline_min),
      last_seen:   r.last_seen
    };
    await maybeFire(db, {
      kind: 'heartbeat_offline',
      scope_type: 'host',
      scope_ref: r.scope_ref,
      threshold: { minutes: thresholdMin },
      detail
    });
  }

  // recovered: 之前有 firing 现在 last_seen 新了.
  // R158.X.99.34.b (2026-10-19) — UNION ALL 镜像, 双 namespace 都查.
  // 1. member 表用 hostname + enabled=1 (R158.46 行为 preserved).
  // 2. AD agent 表用 agent_id + <> '__healthcheck__' (R158.69 fleet helper).
  // 任一 namespace 找到最近 1 行距今 < thresholdMin 即"健康".
  //
  // R158.X.115 — checker 加退役/暂停短路: 这台机器已退出管控 → 不该继续
  //   firing。返回 true 让 checkRecovered 把它标 recovered (状态闭合)。
  //   service 层在退役动作里也会主动 batch markRecoveredByScope, 这里是
  //   兜底 (覆盖"退役后残留 agent 又心跳导致 firing"的重启窗口)。
  await checkRecovered(db, 'heartbeat_offline', thresholdMin, async (scopeRef) => {
    // R158.X.115 — 退役/暂停的机器直接判"已恢复"(= 不该再告警)。
    if (await isHostOffManagement(db, scopeRef)) return true;

    // R158.X.99.15 (2026-10-18) — 真因闭合. append-only 表里
    //   找任意 1 行 last_seen_at 距今 < thresholdMin 返"健康" = markRecovered,
    //   跟 R158.X.99.14 replication_failed 同 bug 1:1 平行.
    //   fix: ORDER BY ... DESC TOP 1 显式锁"最近 1 次".
    const memberSql = db.dialect === 'mssql'
      ? `SELECT TOP 1 last_seen_at FROM ad_member_servers
         WHERE hostname = ? AND enabled = 1 AND last_seen_at IS NOT NULL
         ORDER BY last_seen_at DESC`
      : `SELECT last_seen_at FROM ad_member_servers
         WHERE hostname = ? AND enabled = 1 AND last_seen_at IS NOT NULL
         ORDER BY last_seen_at DESC LIMIT 1`;
    const memberResult = await db.query(memberSql, [scopeRef]);
    if (memberResult.rows.length > 0) {
      const lastSeen = memberResult.rows[0].last_seen_at;
      const diffFn = db.dialect === 'mssql'
        ? `DATEDIFF(MINUTE, ?, SYSUTCDATETIME())`
        : `TIMESTAMPDIFF(MINUTE, ?, UTC_TIMESTAMP(3))`;
      const diffRes = await db.query(
        (db.dialect === 'mssql'
          ? `SELECT ${diffFn} AS d`
          : `SELECT ${diffFn} AS d`) + ' ',
        [lastSeen]
      );
      if (Number(diffRes.rows[0]?.d) < thresholdMin) return true;
    }
    // AD agent namespace check (平行 R158.69 fleet).
    const adSql = db.dialect === 'mssql'
      ? `SELECT TOP 1 last_heartbeat_at FROM ad_agent_heartbeat
         WHERE agent_id = ? AND agent_id <> '__healthcheck__' AND last_heartbeat_at IS NOT NULL
         ORDER BY last_heartbeat_at DESC`
      : `SELECT last_heartbeat_at FROM ad_agent_heartbeat
         WHERE agent_id = ? AND agent_id <> '__healthcheck__' AND last_heartbeat_at IS NOT NULL
         ORDER BY last_heartbeat_at DESC LIMIT 1`;
    const adResult = await db.query(adSql, [scopeRef]);
    if (adResult.rows.length > 0) {
      const lastHb = adResult.rows[0].last_heartbeat_at;
      const diffFn = db.dialect === 'mssql'
        ? `DATEDIFF(MINUTE, ?, SYSUTCDATETIME())`
        : `TIMESTAMPDIFF(MINUTE, ?, UTC_TIMESTAMP(3))`;
      const diffRes = await db.query(
        (db.dialect === 'mssql'
          ? `SELECT ${diffFn} AS d`
          : `SELECT ${diffFn} AS d`) + ' ',
        [lastHb]
      );
      return Number(diffRes.rows[0]?.d) < thresholdMin;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Detector 2: replication_failed
// 读 ad_replication_status, 找 status_code 非 0 的 (source_dc, dest_dc) 行.
// 阈值从 system_config.system_alert_replication_failure_count (默认 30 — R158.X.99.17).
// R158.68.1 — 真表列: source_dc / dest_dc / status_code / error_message /
//   last_attempt_time. R158.68 plan 假设 partner_dc / last_failure_count /
//   last_error / last_sync_at 是错的 (R158.46 ship 时 schema 不一样).
//
// R158.X.99.17 (2026-10-18) — 操作员 directive 锁 B 模式:
//   "超过了30次, 恢复了就置零, 再计算30次, 如果恢复了再次置零".
//   跨 NC 合并 (跟 R158.X.99.14 1:1 平行), 同 (source_dc, dest_dc) 链路自"最近 1 行
//   status_code=0" (checkpoint) 以来, append-only 累计 ≥ threshold 次 failure attempts
//   才 fire 1 条 alert. status=0 出现即推进 checkpoint → 累计 counter 归零 → 重新数.
//   checkpoint=null 走"全表累积" (id > 0 等价), 即链路从来没成功过 → 仍需累计 30 才 fire.
//
//   修 R158.X.99.14 没闭合的真因: 老 SQL `WHERE status_code <> 0` 在 append-only 表里
//   永远能 SELECT 出老失败行 → 每 10min 重新 INSERT firing → checkRecovered markRecovered
//   → 下一轮又 INSERT → 死循环 burst. 现算法用 checkpoint 限定"自上次成功以来",
//   老失败行永远在 checkpoint 之前不参与累积, 死循环真闭合.
//
//   0 改 checkRecovered (R158.X.99.14 SQL 保留, line 250-274 闭包), 0 改 suppression
//   guard, 0 改节流门 (R158.X.6 fired_at 60min 窗在 maybeFire 内嵌), 0 改其他 3 detector,
//   0 改 schema. 仅改 detectReplicationFailed 主路径.
// ---------------------------------------------------------------------------
async function detectReplicationFailed(db, getConfig) {
  const cfg = await getConfig();
  const threshold = Number(cfg?.system_alert_replication_failure_count) || 3;
  // R158.X.99.17 — fallback 仍 3 (保留向后兼容; 操作员已配 30, system_config 实际生效 30).
  //   UI 层 fallback 改 30 (SystemAlertsView.vue loadConfig) 是 UX 修复, 不是产品逻辑修复.

  // step 1: 列当前所有失败链路 distinct (src, dst) — 跨 NC 合并.
  //   Hard filter 跟 R158.X.99.14 现状 1:1 平行 (NOT IN '*'/'' + NOT NULL 过滤通配符 entry).
  //
  //   R158.X.115 (2026-10-20) — 排除退役/暂停管控的 DC。
  //   ad_replication_status 是 append-only 表, source_dc / dest_dc 是 VARCHAR
  //   逻辑引用 ad_dcs.dc_name (0 FK 约束)。退役 DC 的历史复制行保留在表里
  //   (可追溯), 但不再作为"当前失败链路"参与告警评估 —— 否则退役 DC 会
  //   永久挂 replication_failed firing。用 NOT EXISTS 而不是 INNER JOIN:
  //   append-only 大表上 NOT EXISTS 走半连接, 0 改行数, 跟 disk_low 的
  //   R158.X.115 过滤 1:1 平行。
  const linkSql = db.dialect === 'mssql'
    ? `SELECT source_dc, dest_dc
       FROM ad_replication_status
       WHERE status_code <> '0' AND status_code IS NOT NULL
         AND source_dc NOT IN ('*', '') AND source_dc IS NOT NULL
         AND dest_dc   NOT IN ('*', '') AND dest_dc   IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ad_dcs sd
                         WHERE sd.dc_name = ad_replication_status.source_dc
                           AND (sd.decommissioned_at IS NOT NULL OR sd.monitoring_paused_at IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM ad_dcs dd
                         WHERE dd.dc_name = ad_replication_status.dest_dc
                           AND (dd.decommissioned_at IS NOT NULL OR dd.monitoring_paused_at IS NOT NULL))
       GROUP BY source_dc, dest_dc`
    : `SELECT source_dc, dest_dc
       FROM ad_replication_status
       WHERE status_code <> 0 AND status_code IS NOT NULL
         AND source_dc NOT IN ('*', '') AND source_dc IS NOT NULL
         AND dest_dc   NOT IN ('*', '') AND dest_dc   IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ad_dcs sd
                         WHERE sd.dc_name = ad_replication_status.source_dc
                           AND (sd.decommissioned_at IS NOT NULL OR sd.monitoring_paused_at IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM ad_dcs dd
                         WHERE dd.dc_name = ad_replication_status.dest_dc
                           AND (dd.decommissioned_at IS NOT NULL OR dd.monitoring_paused_at IS NOT NULL))
       GROUP BY source_dc, dest_dc`;
  const { rows: linkRows } = await db.query(linkSql);

  for (const link of linkRows) {
    const src = link.source_dc;
    const dst = link.dest_dc;

    // step 2: 取最近 1 行 status_code=0 的 id 作 checkpoint (归零点).
    //   mssql TOP 1 / mysql LIMIT 1 — 跟 R158.X.99.14 checkRecovered `ORDER BY id DESC`
    //   拿"最近 attempt" 语义 1:1 平行. NULL = 链路从来没 status=0 行 → step 3 走全表累积分支.
    const checkpointSql = db.dialect === 'mssql'
      ? `SELECT TOP 1 id, last_attempt_time FROM ad_replication_status
         WHERE source_dc = ? AND dest_dc = ? AND status_code = '0'
         ORDER BY id DESC`
      : `SELECT id, last_attempt_time FROM ad_replication_status
         WHERE source_dc = ? AND dest_dc = ? AND status_code = 0
         ORDER BY id DESC LIMIT 1`;
    const { rows: cpRows } = await db.query(checkpointSql, [src, dst]);
    const checkpoint = cpRows[0] || null;  // { id, last_attempt_time } 或 null
    const cpId = checkpoint ? checkpoint.id : null;

    // step 3: 计算累积失败条数. checkpoint 以来 (含 checkpoint=null 全表).
    //   mssql CAST(? AS BIGINT) 防 mssql driver bind null 给 BIGINT 列时类型推断错.
    //   IS NOT NULL 防止 collect-replication.ps1 老 INF/NULL 残留误判.
    const countSql = db.dialect === 'mssql'
      ? `SELECT COUNT(*) AS cnt FROM ad_replication_status
         WHERE source_dc = ? AND dest_dc = ?
           AND status_code <> '0' AND status_code IS NOT NULL
           AND source_dc NOT IN ('*', '') AND dest_dc NOT IN ('*', '')
           AND (CAST(? AS BIGINT) IS NULL OR id > CAST(? AS BIGINT))`
      : `SELECT COUNT(*) AS cnt FROM ad_replication_status
         WHERE source_dc = ? AND dest_dc = ?
           AND status_code <> 0 AND status_code IS NOT NULL
           AND source_dc NOT IN ('*', '') AND dest_dc NOT IN ('*', '')
           AND (? IS NULL OR id > ?)`;
    const { rows: cntRows } = await db.query(countSql, [src, dst, cpId, cpId]);
    const accumulatedCount = Number(cntRows[0]?.cnt || 0);

    if (accumulatedCount < threshold) continue;  // 未达阈值, 跳过 (死循环真闭合)

    // step 4: 拿最近一次失败 status / error / time (UI + 邮件展示用).
    //   同 step 3 id > checkpoint 限定, 让"最近"是 checkpoint 以来而非全表.
    const lastFailSql = db.dialect === 'mssql'
      ? `SELECT TOP 1 status_code, error_message, last_attempt_time FROM ad_replication_status
         WHERE source_dc = ? AND dest_dc = ?
           AND status_code <> '0' AND status_code IS NOT NULL
           AND source_dc NOT IN ('*', '') AND dest_dc NOT IN ('*', '')
           AND (CAST(? AS BIGINT) IS NULL OR id > CAST(? AS BIGINT))
         ORDER BY id DESC`
      : `SELECT status_code, error_message, last_attempt_time FROM ad_replication_status
         WHERE source_dc = ? AND dest_dc = ?
           AND status_code <> 0 AND status_code IS NOT NULL
           AND source_dc NOT IN ('*', '') AND dest_dc NOT IN ('*', '')
           AND (? IS NULL OR id > ?)
         ORDER BY id DESC LIMIT 1`;
    const { rows: lastFailRows } = await db.query(lastFailSql, [src, dst, cpId, cpId]);
    const lastFail = lastFailRows[0] || null;

    // step 5: 组 detail + suppression guard + maybeFire.
    //   scope_ref = "source_dc → dest_dc" (复合 key; 跨 NC 合并, 跟 R158.X.99.14 1:1 平行).
    const scopeRef = `${src}→${dst}`;
    const detail = {
      dest_dc: dst,
      failure_status: lastFail?.status_code ?? null,
      last_error: lastFail?.error_message ?? null,
      last_attempt_time: lastFail?.last_attempt_time ?? null,
      // R158.X.99.17 新增字段 — 操作员 directive "超过了30次" 落地依据.
      accumulated_count: accumulatedCount,
      checkpoint_id: checkpoint?.id ?? null,
      since_last_success: checkpoint?.last_attempt_time ?? null
    };

    // R158.Suppression (2026-10-15) — 操作员行级暂停告警. 检测 (kind, scope_ref) 命中
    //   system_alert_suppressions → continue (0 INSERT + 0 邮件 + 0 bump notify).
    //   expires_at NULL = 永久 (默认永久抑制); 过期视为未抑制 (自动恢复).
    //   0 改其余 4 个 detector (heartbeat_offline / disk_low / failed_logon_spike);
    //   0 改 checkRecovered (state=firing 不存在就不需要 recovered).
    //   跟 R158.X 节流 (1 行常量) 1:1 平行 — 1 处 3 行 guard, 不开新 file 不开新 endpoint.
    const { rows: supRows } = await db.query(
      db.sql.systemAlertSuppressions.isSuppressed,
      ['replication_failed', scopeRef]
    );
    if (supRows.length > 0) continue;
    await maybeFire(db, {
      kind: 'replication_failed',
      scope_type: 'host',
      scope_ref: scopeRef,
      threshold: { failure_count: threshold },
      detail
    });
  }

  // R158.X.99.14 (2026-10-18) — checkRecovered 0 改. SQL 拿最近 1 行 status=0 才算恢复,
  //   跟新算法 checkpoint 语义 1:1 平行 (跨 NC 合并). 闭合 R158.X.99.10 真因链.
  await checkRecovered(db, 'replication_failed', threshold, async (scopeRef) => {
    const [src, dest] = scopeRef.split('→');
    // R158.X.99.14 (2026-10-18) — 真因闭合. 老 SQL 找 ad_replication_status
    // 任意 1 行 status_code=0 = "健康" (append-only 表里历史 status=0 链路永远
    // 在), 10min 跑 1 次 detectReplicationFailed → checkRecovered → firing
    // 立刻 markRecovered, UI 看到一长串 "firing → recovered" 反复 toggle
    // (= 10:01 → 10:11 → 10:21 → ... 11:01 同 2 个 DC 重复 burst 真因).
    // fix: 限定"最近 1 小时内同 source_dc+dest_dc 链路 status_code=0 才算
    // 恢复". ad_replication_status 表里没 last_attempt_time 列, 用 IDENTITY
    // id DESC 倒序拿最近 1 行 = 最近一次 attempt. (跟 R158.X.99.9 真因 1:1
    // 平行 = 用"最近窗口"判断恢复, 不用全表 grep 历史 status=0).
    const checkSql = db.dialect === 'mssql'
      ? `SELECT TOP 1 1 FROM (
          SELECT TOP 1 status_code FROM ad_replication_status
          WHERE source_dc = ? AND dest_dc = ?
          ORDER BY id DESC
        ) recent WHERE recent.status_code = '0' OR recent.status_code IS NULL`
      : `SELECT 1 FROM (
          SELECT status_code FROM ad_replication_status
          WHERE source_dc = ? AND dest_dc = ?
          ORDER BY id DESC LIMIT 1
        ) recent WHERE recent.status_code = 0 OR recent.status_code IS NULL`;
    const { rows } = await db.query(checkSql, [src, dest]);
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Detector 3: port_latency_high  (R158.86 — REMOVED 2026-10-12)
// Operator decision: "ad_member_port_latency 这个包删除, 因为没有这个需求".
//   - ad_member_port_latency 1.0.0 package retired (data/packages 目录删,
//     package_scripts + package_policies 行删, pkg_ad_member_port_latency
//     schema DROP, by sqlcmd operator hand-run).
//   - detectPortLatencyHigh() function and runDetector(...) entry removed.
//   - system_config.system_alert_port_latency_ms field kept (orphan
//     config; future restart would need a new detector + repopulate data).
//   - kindLabel map entry removed (no port_latency_high alert will fire
//     from this engine after the package is gone).
// R158.63 was the original ship; R158.68.1 fixed the schema. Both eras
// are now retired. history line preserved for R158.86 audit trail.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Detector 4: disk_low
// 读 pkg_ad_os_baseline.metrics, 用 c_used_pct (float) ≥ 95% 告警.
// 阈值从 system_config.system_alert_disk_free_kb (保留字段, 1GB 默认) — R158.68.1
//   决定改用 c_used_pct 直读 float, 不 parse disk_free nvarchar JSON. system_config
//   默认值不变 (避免动 UI), detector 不读它. 阈值硬编码 95% 跟 os-baseline
//   metrics 表 c_used_pct 语义对齐.
// R158.68.1 — 真表 pkg_ad_os_baseline.metrics, 列 agent_id / ts / c_used_pct.
//   R158.68 plan 假设 hostname / metrics / captured_at 错 (同 os-baseline-metrics
//   修复模式, R158.62 plan 时表 schema 不一样).
// ---------------------------------------------------------------------------
async function detectDiskLow(db, getConfig) {
  await getConfig();  // 读 config 保留 (system_alert_disk_free_kb 默认值不动)
  const THRESHOLD_PERCENT = 95;
  const probeSql = db.dialect === 'mssql'
    ? `SELECT TOP 1 1 FROM pkg_ad_os_baseline.metrics`
    : `SELECT 1 FROM pkg_ad_os_baseline.metrics LIMIT 1`;
  let probe;
  try {
    probe = await db.query(probeSql);
  } catch {
    return;
  }
  if (!probe.rows || probe.rows.length === 0) return;

  // 取每 agent 最新一行 (latest-per-agent, 跟 os-baseline-metrics.js 同模式)
  //
  // R158.X.115 (2026-10-20) — 排除退役/暂停管控的机器。
  //   pkg_ad_os_baseline.metrics.agent_id 就是主机名 (DC + member 共用这个
  //   命名空间, 跟 heartbeat detector 的 scope_ref 同语义)。NOT EXISTS 双
  //   子查询: member 表和 DC 表各查一次, 命中任一即排除该 agent。
  //   不 JOIN 而用 NOT EXISTS: metrics 是 metricstore 动态 schema (pkg_*),
  //   JOIN ad_dcs / ad_member_servers 会让 optimizer 在小表上做 nested loop,
  //   NOT EXISTS 语义更清楚且两侧表互不影响。
  const retiredExcludeMysql = `
       AND NOT EXISTS (SELECT 1 FROM ad_member_servers ms
                       WHERE ms.hostname = m.agent_id
                         AND (ms.decommissioned_at IS NOT NULL OR ms.monitoring_paused_at IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM ad_dcs ad
                       WHERE ad.dc_name = m.agent_id
                         AND (ad.decommissioned_at IS NOT NULL OR ad.monitoring_paused_at IS NOT NULL))`;
  const sql = db.dialect === 'mssql'
    ? `SELECT m.agent_id, m.ts, m.c_used_pct
       FROM pkg_ad_os_baseline.metrics m
       INNER JOIN (
         SELECT agent_id, MAX(ts) AS max_ts
         FROM pkg_ad_os_baseline.metrics
         GROUP BY agent_id
       ) latest ON m.agent_id = latest.agent_id AND m.ts = latest.max_ts
       WHERE m.c_used_pct IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ad_member_servers ms
                       WHERE ms.hostname = m.agent_id
                         AND (ms.decommissioned_at IS NOT NULL OR ms.monitoring_paused_at IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM ad_dcs ad
                       WHERE ad.dc_name = m.agent_id
                         AND (ad.decommissioned_at IS NOT NULL OR ad.monitoring_paused_at IS NOT NULL))`
    : `SELECT m.agent_id, m.ts, m.c_used_pct
       FROM pkg_ad_os_baseline.metrics m
       INNER JOIN (
         SELECT agent_id, MAX(ts) AS max_ts
         FROM pkg_ad_os_baseline.metrics
         GROUP BY agent_id
       ) latest ON m.agent_id = latest.agent_id AND m.ts = latest.max_ts
       WHERE m.c_used_pct IS NOT NULL${retiredExcludeMysql}`;
  const { rows } = await db.query(sql);

  for (const r of rows) {
    const used = Number(r.c_used_pct);
    if (!Number.isFinite(used)) continue;
    if (used >= THRESHOLD_PERCENT) {
      const detail = { c_used_pct: used, threshold_percent: THRESHOLD_PERCENT, agent_id: r.agent_id, ts: r.ts };
      await maybeFire(db, {
        kind: 'disk_low',
        scope_type: 'host',
        scope_ref: r.agent_id,
        threshold: { c_used_pct: THRESHOLD_PERCENT },
        detail
      });
    }
  }

  // R158.X.115 — 退役/暂停机器的存量 firing 告警在此闭合。
  //   上面的 NOT EXISTS 保证它们不再重新 fire; 这里用 checkRecovered 的
  //   checker 短路语义把它们标 recovered (状态闭合, 数据保留)。
  //   checker 返回 true = "已恢复" → markRecovered。退役机器等价于已恢复,
  //   因为它已退出管控范围, 不该继续挂在 firing 列表里。
  await checkRecovered(db, 'disk_low', { c_used_pct: THRESHOLD_PERCENT }, async (scopeRef) => {
    // R158.X.115 — 退役/暂停机器的存量 firing 在此闭合 (数据保留)。
    return isHostOffManagement(db, scopeRef);
  });
}

// ---------------------------------------------------------------------------
// Detector 5: failed_logon_spike
// 读 ad_failed_logon_events, 24h 内失败次数 >= 阈值 (全局告警).
// 阈值从 system_config.system_alert_failed_logon_24h (默认 500).
// ---------------------------------------------------------------------------
async function detectFailedLogonSpike(db, getConfig) {
  const cfg = await getConfig();
  const threshold = Number(cfg?.system_alert_failed_logon_24h) || 500;
  const sql = db.dialect === 'mssql'
    ? `SELECT TOP 1 COUNT(*) AS cnt FROM ad_failed_logon_events
       WHERE occurred_at >= DATEADD(HOUR, -24, SYSUTCDATETIME())`
    : `SELECT COUNT(*) AS cnt FROM ad_failed_logon_events
       WHERE occurred_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)`;
  const { rows } = await db.query(sql);
  const count = Number(rows[0]?.cnt || 0);
  if (count >= threshold) {
    await maybeFire(db, {
      kind: 'failed_logon_spike',
      scope_type: 'global',
      scope_ref: null,
      threshold: { count_24h: threshold },
      detail: { count_24h: count, threshold }
    });
  }
  // recovered: 之前 firing, 现在 count < threshold
  await checkRecovered(db, 'failed_logon_spike', threshold, async () => count < threshold);
}

// ---------------------------------------------------------------------------
// Helper: maybeFire — 同 kind+scope 已有 firing → 不重复 INSERT, 只 bumpNotify
// (邮件节流); 否则新 INSERT + 写 outbox.
// ---------------------------------------------------------------------------
async function maybeFire(db, { kind, scope_type, scope_ref, threshold, detail }) {
  const findSql = db.sql.systemAlerts.findOpenByKindScope;
  // R158.68.4 (2026-10-10) — findOpenByKindScope SQL 现在 (scope_ref = ? OR (scope_ref IS
  //   NULL AND ? IS NULL)) 用 4 个 params (scope_ref 双份) 才能正确匹配 NULL 行.
  //   老代码 3 params → mssql driver bind p4 = undefined → SQL `? IS NULL` 永假 →
  //   NULL 行永不 match → 每轮新 INSERT → failed_logon_spike 风暴 (31 行/5min).
  const { rows: openRows } = await db.execute(findSql, [kind, scope_type, scope_ref, scope_ref]);
  const now = new Date();
  if (openRows.length > 0) {
    const open = openRows[0];
    // 邮件节流: last_notified_at 距今 < NOTIFY_THROTTLE_MINUTES → 不重发
    if (open.last_notified_at) {
      const lastNotified = new Date(open.last_notified_at);
      const minutesAgo = (now - lastNotified) / 60000;
      if (minutesAgo < NOTIFY_THROTTLE_MINUTES) {
        // R158.X.5 (2026-10-16) — 既有 firing 节流门加 console.log audit,
        //   1:1 平行兜底门 line 328 suppressed 范式. Bug D 修法.
        console.log(`[system-alert] ${kind} ${scope_ref} throttle (firing 持续 ${minutesAgo.toFixed(1)}min < ${NOTIFY_THROTTLE_MINUTES}min), alert_id=${open.id}`);
        return;
      }
    }
    // 重发邮件 + bump notify_count
    await enqueueAlertEmail(db, open.id, kind, scope_ref, threshold, detail);
    await db.execute(db.sql.systemAlerts.bumpNotify, [open.id]);
    return;
  }
  // R158.X.4 (2026-10-16) — 新 INSERT 路径加兜底门. 修法: 查同 kind+scope
  //   最近 1 行 (不限 state, 跨 firing+recovered+acked) — findRecentByKindScope.
  //   若 last_notified_at 距今 < NOTIFY_THROTTLE_MINUTES → 跳过 enqueueAlertEmail
  //   + bumpNotify (但仍 INSERT 状态行, 标 detail: 'suppressed_by_recent_notification',
  //   让 UI 看得到 firing 记录但不重发邮件). 修 R158.X.3 没修的 Bug #1: 抖动 / 偶发
  //   fail 走新 INSERT 路径永远发邮件 → 节流基线失效. 1:1 平行 line 286-289 节流门
  //   范式 (last_notified_at 时间戳比较).
  // R158.X.6 (2026-10-16) — 节流基线改 fired_at (SQL 层 INTERVAL filter), 0 改
  //   last_notified_at / notify_count. 修 Bug E (R158.X.4 自打脸) + Bug F (R158.X.5
  //   notify_count 错配). 节流窗 60min 跟 NOTIFY_THROTTLE_MINUTES 1:1 平行.
  const recentSql = db.sql.systemAlerts.findRecentByKindScope;
  const { rows: recentRows } = await db.execute(recentSql, [kind, scope_type, scope_ref, scope_ref, NOTIFY_THROTTLE_MINUTES]);
  // R158.X.6 — SQL 已 filter 60min fired_at 窗, 0 命中即"60min 内无同 kind+scope 行"
  //   → 正常发邮件; 1 命中即"60min 内有 firing 记录" → suppressed, 跳过 enqueue.
  //   1:1 平行 line 283-289 既有 firing 节流门范式 (openRows.length > 0 → 节流).
  const suppressed = recentRows.length > 0;
  // 新 INSERT
  const insertSql = db.sql.systemAlerts.insert;
  // R158.X.4 (2026-10-16) — 兜底门 suppressed 时, 把 suppression reason 标进
  //   detail JSON (UI 看得到 firing 但不重发邮件, audit 价值).
  const detailToStore = suppressed
    ? { ...detail, _suppressed: true, _suppress_reason: 'recent_notification_within_throttle_window' }
    : detail;
  const insertParams = [kind, scope_type, scope_ref, JSON.stringify(threshold), JSON.stringify(detailToStore)];
  const result = await db.execute(insertSql, insertParams);
  const alertId = (Array.isArray(result) ? result[0]?.insertId : result?.insertId) || result?.recordset?.[0]?.id;
  if (!alertId) {
    console.error('[system-alert] insert returned no id', { kind, scope_ref });
    return;
  }
  if (suppressed) {
    // R158.X.4 (2026-10-16) — 跳过 enqueueAlertEmail + bumpNotify, 但状态行已 INSERT.
    //   1:1 平行 line 286-289 节流门 return 范式 (silent skip, 0 邮件).
    console.log(`[system-alert] ${kind} ${scope_ref} suppressed by recent notification (< ${NOTIFY_THROTTLE_MINUTES}min), alert_id=${alertId}`);
    return;
  }
  await enqueueAlertEmail(db, alertId, kind, scope_ref, threshold, detail);
  await db.execute(db.sql.systemAlerts.bumpNotify, [alertId]);
}

// 写 outbox + 模板 subject/body
async function enqueueAlertEmail(db, alertId, kind, scopeRef, threshold, detail) {
  const cfg = await (await import('./config.js')).getConfig();
  const to = (cfg?.system_alert_to || '').trim();
  if (!to) return;  // 没配收件人, 跳过 (UI 上提示)
  const subject = `[内置告警] ${kindLabel(kind)}${scopeRef ? ` — ${scopeRef}` : ''}`;
  const bodyText = `系统内置告警\n\n类别: ${kindLabel(kind)}\n主机: ${scopeRef || '(全局)'}\n触发时间: ${new Date().toISOString()}\n阈值: ${JSON.stringify(threshold)}\n详情: ${JSON.stringify(detail, null, 2)}\n\n告警 ID: ${alertId}`;
  const bodyHtml = `<pre style="font-family: monospace; font-size: 12px;">${bodyText.replace(/</g, '&lt;')}</pre>`;
  const nextAttempt = new Date();
  await db.execute(db.sql.systemAlertOutbox.enqueue, [
    alertId, to, null, subject, bodyText, bodyHtml, nextAttempt, 5
  ]);
}

function kindLabel(kind) {
  const map = {
    heartbeat_offline: 'agent 心跳离线',
    replication_failed: 'AD 复制链路失败',
    disk_low: '磁盘空间不足',
    failed_logon_spike: '失败登录激增'
  };
  return map[kind] || kind;
}

// ---------------------------------------------------------------------------
// Helper: checkRecovered — 之前 firing 的告警, 条件不再满足 → markRecovered
// checker 接收 scope_ref (或 null for global), 返 true/false
// ---------------------------------------------------------------------------
async function checkRecovered(db, kind, threshold, checker) {
  const sql = db.sql.systemAlerts.listFiring;
  // 注意: 我们要的是所有 firing 同 kind, 不带 kind filter 太宽. 用 listFiring({kind, limit:200})
  // R158.68.3 (2026-10-10) — params 必须跟 listFiring function 生成的 `?` 数量配对:
  //   fn({kind}) mssql 段 SQL 加 ` AND kind = ?` (1 个 `?`), 所以 params=[kind].
  //   老代码 `params=[]` + SQL 1 个 `?` → mssql driver @p1 未声明错. 同理 fn string
  //   形态 (mssql 用 TOP, 无 `?`) → params=[].
  const fn = sql;
  const sqlText = typeof fn === 'function' ? fn({ kind, limit: 200 }) : fn;
  const params = typeof fn === 'function' ? [kind] : [];
  const { rows } = await db.query(sqlText, params);
  for (const r of rows) {
    const isOk = await checker(r.scope_ref);
    if (isOk) {
      await db.execute(db.sql.systemAlerts.markRecovered, [r.id]);
    }
  }
}

// ---------------------------------------------------------------------------
// createSystemAlertLoop — 工厂
// ---------------------------------------------------------------------------
export function createSystemAlertLoop({ db, getIntervalSeconds, getSystemConfig, logger }) {
  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;

  async function runDetector(name, fn) {
    try {
      await fn(db, getSystemConfig);
    } catch (err) {
      // 单 detector 失败不破其他 4 种 (R158.60.7 错误隔离)
      // R158.68.3 (2026-10-10) — 加 stack + 上下文, 排查 "@p1" 报告缺定位.
      console.error(`[system-alert] ${name} detector failed:`, err.message, err.stack?.split('\n').slice(0, 4).join('\n'));
    }
  }

  async function tick() {
    if (tickInFlight) {
      console.error('[system-alert] tick skipped: previous tick still in flight');
      return;
    }
    tickInFlight = true;
    try {
      await Promise.all([
        runDetector('heartbeat_offline', detectHeartbeatOffline),
        runDetector('replication_failed', detectReplicationFailed),
        runDetector('disk_low',            detectDiskLow),
        runDetector('failed_logon_spike',  detectFailedLogonSpike),
      ]);
    } finally {
      tickInFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    Promise.resolve(getIntervalSeconds()).then((raw) => {
      if (!running) return;
      const sec = Math.max(10, Number(raw) || 60);
      interval = setInterval(() => {
        inFlight = tick().catch((e) => console.error('[system-alert] tick failed:', e.message));
      }, sec * 1000);
    }).catch((e) => console.error('[system-alert] start failed:', e.message));
  }

  async function stop() {
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return { start, stop, tick, isRunning: () => running };
}
