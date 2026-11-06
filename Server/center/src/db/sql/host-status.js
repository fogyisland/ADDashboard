// SQL helpers for host lifecycle status (R158.X.115, 2026-10-20).
//
// 背景: 服务器"下线"(退役) 之前系统 0 下线路径。现有 DELETE 端点不是解法:
//   · agent 每 30min 重发 self-register (noadagent/agent.js:679) → 删掉的行会自己回来
//   · DELETE 是物理删除, FK CASCADE 清掉历史审计数据 → 不可追溯
//   · heartbeat_offline detector 无法区分"退役"与"临时离线/返修"
//
// 本模块提供两种主机状态, 加在两张目录表上 (ad_dcs / ad_member_servers):
//   decommissioned_at    非空 = 已退役 (终态, 不可逆)
//   monitoring_paused_at 非空 = 暂停管控 (临时态, 手动恢复, 0 自动到期)
//
// 两者互斥, 退役优先。**退役 0 物理删除**, 行留在原地带标记, 历史数据
// (package_runs / eventlog / os_baseline / admin_groups / alerts) 全保留,
// 仅从告警与在线视图排除。
//
// ---------------------------------------------------------------------------
// UPSERT 保护 (R158.86.5.2 不变式延伸) — 退役标记绝不能被 agent 覆盖
// ---------------------------------------------------------------------------
// R158.86.5.2 (2026-10-12) 立的不变式: "agent 上报路径只能写 agent 自己
// 观测得到的事实 (ip/os/last_seen); 凡是 admin 决策列 (enabled / site_id /
// install_root) 一律不进 UPSERT 的 UPDATE SET, 或用 COALESCE 保护 admin 值
// win"。这条不变式防止"agent 反向覆盖 admin 决策"。
//
// decommissioned_at / monitoring_paused_at 是**纯 admin 决策列** (退役是操作员
// 行为, agent 完全不知道), 所以必须享受同级保护:
//
//   ad_member_servers — 天然安全, 0 改动。
//     UPSERT 的 ON DUPLICATE KEY UPDATE 分支只更新
//     site_id / ip_address / os_version / install_root / updated_at 五列
//     (member-servers.js:50-55), 新列既不在 INSERT 列表也不在 UPDATE SET,
//     跟 enabled 同等级别 (enabled 也只 INSERT 不 UPDATE)。
//
//   ad_dcs — **必须显式加保护**, 否则退役 DC 必然复活。
//     discovery.upsertDc (sql.js:780 mysql / :4040-4070 mssql MERGE) 是
//     零保护全量覆盖, MATCHED 分支把 discovered_at 刷成当前 UTC。
//     只要 DC 的 agent 还在跑 collect-discovery.ps1 POST /api/agent/discover,
//     退役标记就会被清掉、行完全复活。本模块的 UPSERT 保护见下方
//     applyDcUpsertGuard()。
//
// ---------------------------------------------------------------------------
// 过滤谓词 (单一真源)
// ---------------------------------------------------------------------------
// 所有在线视图 (告警 detector / 拓扑图 / KPI / 包执行校验 / file-push /
// cron 调度) 都必须用这里导出的常量拼 WHERE, 避免"暂停了但某个视图还在
// 告警"的漏网 (跟 R158.X.99.34.b UNION ALL 单点修复 1:1 平行)。
//
// 注意别名: DC 侧用 `d` (ad_dcs), member 侧用 `ms` (ad_member_servers)。
// 消费方必须在 FROM/JOIN 里用同样的别名。

// DC 侧 (JOIN ad_dcs AS d)
export const ONLINE_DC_WHERE =
  'd.decommissioned_at IS NULL AND d.monitoring_paused_at IS NULL';

// Member 侧 (JOIN ad_member_servers AS ms)
export const ONLINE_MEMBER_WHERE =
  'ms.decommissioned_at IS NULL AND ms.monitoring_paused_at IS NULL';

// 不带别名的裸谓词, 供已经在单表查询里 (无 JOIN) 的消费方使用。
// 适用于 UPDATE/DELETE 的 WHERE 或 FROM 只有一张表且无别名的场景。
export const ONLINE_HOST_WHERE =
  'decommissioned_at IS NULL AND monitoring_paused_at IS NULL';

// 反向谓词: 该主机是否已退出管控 (退役 或 暂停)。
// 供 detector 侧"这台机器已经不该再评估"用, 语义比两个 NOT NULL 判断清晰。
export const OFFLINE_MANAGEMENT_WHERE =
  '(decommissioned_at IS NOT NULL OR monitoring_paused_at IS NOT NULL)';

// ---------------------------------------------------------------------------
// 生命周期状态转换 SQL
// ---------------------------------------------------------------------------
// 状态机 (应用层 services/host-status.js 强制, SQL 只负责落值):
//
//   在线        → 退役       d.decommissioned_at=NOW,  d.monitoring_paused_at=NULL
//   暂停 → 退役       d.decommissioned_at=NOW,  d.monitoring_paused_at=NULL (清零)
//   在线        → 暂停       d.decommissioned_at=NULL, d.monitoring_paused_at=NOW
//   暂停        → 恢复       两列都 NULL
//   已退役      → 恢复/暂停  **拒绝** (service 层 409, 终态不可逆)
//
// setLifecycle 用 COALESCE 语义: 传 null 表示"该列置 NULL", 传日期表示
// "该列设为该日期"。退役动作必须显式传 monitoring_paused_at=null 才能把
// 暂停态清掉 — 这是刻意的, 避免"退役后还留着暂停标记"导致 UI 显示混乱。

const SET_LIFECYCLE_MYSQL_DC =
  `UPDATE ad_dcs SET decommissioned_at = ?, monitoring_paused_at = ? WHERE dc_name = ?`;
const SET_LIFECYCLE_MSSQL_DC =
  `UPDATE ad_dcs SET decommissioned_at = ?, monitoring_paused_at = ? WHERE dc_name = CAST(? AS NVARCHAR(128))`;
const SET_LIFECYCLE_MYSQL_MEMBER =
  `UPDATE ad_member_servers SET decommissioned_at = ?, monitoring_paused_at = ? WHERE hostname = ?`;
const SET_LIFECYCLE_MSSQL_MEMBER =
  `UPDATE ad_member_servers SET decommissioned_at = ?, monitoring_paused_at = ? WHERE hostname = CAST(? AS VARCHAR(128))`;

// 只读两列, 供 service 层做互斥校验 (判断当前态 + 竞态防护)
const GET_STATUS_MYSQL_DC =
  `SELECT dc_name, decommissioned_at, monitoring_paused_at FROM ad_dcs WHERE dc_name = ?`;
const GET_STATUS_MSSQL_DC =
  `SELECT dc_name, decommissioned_at, monitoring_paused_at FROM ad_dcs WHERE dc_name = CAST(? AS NVARCHAR(128))`;
const GET_STATUS_MYSQL_MEMBER =
  `SELECT hostname, decommissioned_at, monitoring_paused_at FROM ad_member_servers WHERE hostname = ?`;
const GET_STATUS_MSSQL_MEMBER =
  `SELECT hostname, decommissioned_at, monitoring_paused_at FROM ad_member_servers WHERE hostname = CAST(? AS VARCHAR(128))`;

// 全局生命周期列表 (/admin/server-lifecycle 用), 支持按状态过滤。
// status 取值: all(退役∪暂停, 默认) | decommissioned | paused | active
export const hostStatus = {
  mysql: {
    setLifecycleDc: SET_LIFECYCLE_MYSQL_DC,
    setLifecycleMember: SET_LIFECYCLE_MYSQL_MEMBER,
    getStatusDc: GET_STATUS_MYSQL_DC,
    getStatusMember: GET_STATUS_MYSQL_MEMBER,
    listLifecycleDc: ({ status = 'all', limit = 500 } = {}) => {
      const lim = Math.min(1000, Math.max(1, Number(limit) || 500));
      let cond;
      if (status === 'decommissioned') cond = 'd.decommissioned_at IS NOT NULL';
      else if (status === 'paused') cond = 'd.decommissioned_at IS NULL AND d.monitoring_paused_at IS NOT NULL';
      else if (status === 'active') cond = ONLINE_DC_WHERE;
      else cond = 'd.decommissioned_at IS NOT NULL OR d.monitoring_paused_at IS NOT NULL';
      return `SELECT d.dc_name AS host, d.site_id, s.site_name, d.ip_address, d.os_version,
                     d.decommissioned_at, d.monitoring_paused_at, d.discovered_at, d.discovered_by_agent_id
              FROM ad_dcs d
              LEFT JOIN ad_sites s ON d.site_id = s.site_id
              WHERE ${cond}
              ORDER BY d.decommissioned_at DESC, d.dc_name
              LIMIT ${lim}`;
    },
    listLifecycleMember: ({ status = 'all', limit = 500 } = {}) => {
      const lim = Math.min(1000, Math.max(1, Number(limit) || 500));
      let cond;
      if (status === 'decommissioned') cond = 'ms.decommissioned_at IS NOT NULL';
      else if (status === 'paused') cond = 'ms.decommissioned_at IS NULL AND ms.monitoring_paused_at IS NOT NULL';
      else if (status === 'active') cond = ONLINE_MEMBER_WHERE;
      else cond = 'ms.decommissioned_at IS NOT NULL OR ms.monitoring_paused_at IS NOT NULL';
      return `SELECT ms.hostname AS host, ms.site_id, s.site_name, ms.ip_address, ms.os_version,
                     ms.decommissioned_at, ms.monitoring_paused_at, ms.discovered_at, ms.discovered_via,
                     ms.last_seen_at, ms.enabled
              FROM ad_member_servers ms
              LEFT JOIN ad_sites s ON ms.site_id = s.site_id
              WHERE ${cond}
              ORDER BY ms.decommissioned_at DESC, ms.hostname
              LIMIT ${lim}`;
    }
  },
  mssql: {
    setLifecycleDc: SET_LIFECYCLE_MSSQL_DC,
    setLifecycleMember: SET_LIFECYCLE_MSSQL_MEMBER,
    getStatusDc: GET_STATUS_MSSQL_DC,
    getStatusMember: GET_STATUS_MSSQL_MEMBER,
    listLifecycleDc: ({ status = 'all', limit = 500 } = {}) => {
      const lim = Math.min(1000, Math.max(1, Number(limit) || 500));
      let cond;
      if (status === 'decommissioned') cond = 'd.decommissioned_at IS NOT NULL';
      else if (status === 'paused') cond = 'd.decommissioned_at IS NULL AND d.monitoring_paused_at IS NOT NULL';
      else if (status === 'active') cond = ONLINE_DC_WHERE;
      else cond = 'd.decommissioned_at IS NOT NULL OR d.monitoring_paused_at IS NOT NULL';
      return `SELECT TOP ${lim} d.dc_name AS host, d.site_id, s.site_name, d.ip_address, d.os_version,
                     d.decommissioned_at, d.monitoring_paused_at, d.discovered_at, d.discovered_by_agent_id
              FROM ad_dcs d
              LEFT JOIN ad_sites s ON d.site_id = s.site_id
              WHERE ${cond}
              ORDER BY d.decommissioned_at DESC, d.dc_name`;
    },
    listLifecycleMember: ({ status = 'all', limit = 500 } = {}) => {
      const lim = Math.min(1000, Math.max(1, Number(limit) || 500));
      let cond;
      if (status === 'decommissioned') cond = 'ms.decommissioned_at IS NOT NULL';
      else if (status === 'paused') cond = 'ms.decommissioned_at IS NULL AND ms.monitoring_paused_at IS NOT NULL';
      else if (status === 'active') cond = ONLINE_MEMBER_WHERE;
      else cond = 'ms.decommissioned_at IS NOT NULL OR ms.monitoring_paused_at IS NOT NULL';
      return `SELECT TOP ${lim} ms.hostname AS host, ms.site_id, s.site_name, ms.ip_address, ms.os_version,
                     ms.decommissioned_at, ms.monitoring_paused_at, ms.discovered_at, ms.discovered_via,
                     ms.last_seen_at, ms.enabled
              FROM ad_member_servers ms
              LEFT JOIN ad_sites s ON ms.site_id = s.site_id
              WHERE ${cond}
              ORDER BY ms.decommissioned_at DESC, ms.hostname`;
    }
  }
};

// ---------------------------------------------------------------------------
// applyDcUpsertGuard() — 给 ad_dcs 的 discovery UPSERT 打退役标记保护补丁
// ---------------------------------------------------------------------------
// R158.X.115: discovery.upsertDc (sql.js:780 mysql / :4040-4070 mssql) 是
// 零保护全量覆盖, 必须追加 self-assign 尾部才能防止退役 DC 复活。
//
// 为什么不直接手改那两行长 SQL: 那两个字符串在 sql.js 里是 module-level
// 字面量, 且 R158.69~R158.X.99 一路累积了大量注释与历史绑定顺序修正
// (lesson 18/20: mssql v11 rowsAffected shape; lesson 46: 9 sibling + 6 处
// driver fix)。用函数做幂等补丁比手改长字符串风险低, 且双方言都能覆盖。
//
// 幂等性: 追加前先检测尾部标记, 重复调用不会叠加。
//
// MySQL:      ...discovered_by_agent_id = VALUES(discovered_by_agent_id)
//          →  ...discovered_by_agent_id = VALUES(discovered_by_agent_id),
//              decommissioned_at = decommissioned_at,
//              monitoring_paused_at = monitoring_paused_at
//
// MSSQL MERGE: ...discovered_by_agent_id = s.discovered_by_agent_id
//          →  ...discovered_by_agent_id = s.discovered_by_agent_id,
//              t.decommissioned_at = t.decommissioned_at,
//              t.monitoring_paused_at = t.monitoring_paused_at
//
// 注意 MSSQL 侧必须写 `t.xxx = t.xxx` 带目标表别名前缀, 且 MERGE 的 UPDATE
// SET 里**不能**用 `col = col` 无别名形式 (MSSQL 会报 ambiguous / 与 USING
// 的 s.xxx 冲突)。自赋值 t.xxx = t.xxx 是 no-op, 纯表达"这列不由 agent 决定"。
//
// ---------------------------------------------------------------------------
// R158.X.115-revive (2026-10-23) — 退役守卫改成「when_created 变了才复活」
// ---------------------------------------------------------------------------
// 原来的无条件 self-assign 只挡住了一半: 它防住了「硬件坏了但 agent 还在
// 跑 collect-discovery.ps1」导致的误复活, 但同时也挡住了**同名重装上线**。
//
// 操作员的真实流程是「下线就是那台机器没了, 同名字重装就是新机器上线」,
// 这两件事在 SQL 层面都表现为同一件事: 一行 dc_name=X 的记录, 被 agent
// 上报了一次。**唯一的区分信号是 when_created**:
//   · 同一台机器误报 → when_created 不变 (AD 没重新 promotion)
//   · 同名重装     → when_created 变 (全新机器, 新 NTDS, 新 objectSid)
//
// ⚠ 试过用 discovered_by_agent_id 区分, **不可行**: 实测库里这列的值就是
//   dc_name 本身 (KDLBJOFADSRV1 → 'KDLBJOFADSRV1'), 对重装没有任何信息量。
//
// 于是语义变成:
//   when_created 相同 → 保持退役 (t.decommissioned_at = t.decommissioned_at)
//   when_created 不同 → 自动复活 (t.decommissioned_at = NULL)
// 即「同名重装 = 重新上线」, 与操作员的流程一致。
//
// monitoring_paused_at (暂停管控) 语义不同: 暂停是**临时态, 由人手动恢复**,
// 所以无论 when_created 变没变都保持不变 —— 它不该被 agent 决定。
//
// 风险: HIGH (不改则同名重装永远无法上线, 且无任何提示)。
const MYSQL_GUARD_MARK = 'decommissioned_at = CASE WHEN';
const MSSQL_GUARD_MARK = 't.decommissioned_at = CASE WHEN';

export function applyDcUpsertGuard(sql, dialect) {
  if (!sql || typeof sql !== 'string') return sql;
  if (dialect === 'mssql') {
    if (sql.includes(MSSQL_GUARD_MARK)) return sql;
    const anchor = 'discovered_by_agent_id = s.discovered_by_agent_id';
    if (!sql.includes(anchor)) return sql;
    // when_created 变了 (ISNULL 任一侧) → 清空退役标记 = 重新上线
    //
    // ⚠ MSSQL 的 ISNULL(expr, replacement) 把 replacement 的类型强制给整个
    //   表达式。对 datetime2 列写 ISNULL(t.when_created, 0) 会让 SQL Server 拿
    //   int 去调和 datetime2, 报 "Operand type clash: int is incompatible with
    //   datetime2"。哨兵必须是同类型的 NULL: CAST(NULL AS DATETIME2)。
    //   两侧都 NULL 时 ISNULL 返回 NULL, NULL <> NULL 仍是 NULL → CASE 不命中
    //   → 保持退役, 不会误复活 (对应测试场景 D 的前半段)。
    const revive = 'CASE WHEN (t.when_created IS NULL AND s.when_created IS NOT NULL)'
      + ' OR ISNULL(t.when_created, CAST(NULL AS DATETIME2))'
      + ' <> ISNULL(s.when_created, CAST(NULL AS DATETIME2))'
      + ' THEN NULL ELSE t.decommissioned_at END';
    return sql.replace(
      anchor,
      `${anchor},\n           t.decommissioned_at = ${revive},\n           t.monitoring_paused_at = t.monitoring_paused_at`
    );
  }
  // mysql
  if (sql.includes(MYSQL_GUARD_MARK)) return sql;
  const anchor = 'discovered_by_agent_id = VALUES(discovered_by_agent_id)';
  if (!sql.includes(anchor)) return sql;
  const revive = 'CASE WHEN NOT (VALUES(when_created) <=> when_created) THEN NULL ELSE decommissioned_at END';
  return sql.replace(
    anchor,
    `${anchor},\n    decommissioned_at = ${revive},\n    monitoring_paused_at = monitoring_paused_at`
  );
}