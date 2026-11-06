// center/src/services/license-quota-migrator.js
// R158.X.99-quota (2026-10-21) — license 节点配额的启动时幂等 ALTER.
//
// 背景: 授权单里的 max_nodes 在激活后**丢失** —— ad_system_registration 表无此列,
//   base32 activate 端点的 INSERT (system-settings-v2.js:481-495) 也不写它,
//   license-codec 的 verifyLicenseCode 只验 HMAC 从不解密 payload。后果是
//   「申请 100 个节点」这个授权意图在运行时完全查不到, 无法做配额控制。
//
// 为什么 runtime ALTER 而不是改 baseline:
//   R158.51 baseline freeze —— db/migrations/mssql/1.0.0-baseline.sql 已发布,
//   改它会让已部署库与 baseline 描述漂移。跟 host-status-migrator.js (R158.X.115)
//   同款处理: 运行时幂等 ALTER。
//
//   注意 MySQL baseline 里**根本没有** ad_system_registration 这张表 (连
//   ad_feature_flags / ad_license_request 都没有), 生产 appsettings.json 锁
//   db.dialect='mssql'。MySQL 分支照写不误 (information_schema 守卫会在表不存在
//   时跳过), 这样将来真切回 mysql 时至少不会因为语法差异炸掉。
//
// 两列的语义分工:
//   max_nodes            — 申请单里的**申请意图**(原样存, 不含宽限)
//   max_nodes_allowed    — ceil(max_nodes × 1.2) 的**派生上限**
//   两者都存是刻意的: 前者是输入(审计要能还原厂商发了什么), 后者是当次授权
//   的固定契约。实时重算的风险见 license-quota.js 的 storage 决策注释 ——
//   宽限比例日后若调整, 已激活的 license 不应跟着变(否则操作员改个常量就
//   悄悄改了存量客户的授权)。所以 activate 时算一次写死。
//
// 存量老行 (R158.LA 之前激活的): max_nodes 恒为 NULL = 不限额 = 现有行为,
//   界面显示「未设配额」。0 回填 —— 回填等于替厂商猜授权意图, 猜错比不猜更糟。

const TABLES = ['ad_system_registration'];
const COLUMNS = [
  { name: 'max_nodes', ddlMssql: 'ALTER TABLE ad_system_registration ADD max_nodes INT NULL', ddlMysql: 'ALTER TABLE ad_system_registration ADD COLUMN max_nodes INT NULL' },
  { name: 'max_nodes_allowed', ddlMssql: 'ALTER TABLE ad_system_registration ADD max_nodes_allowed INT NULL', ddlMysql: 'ALTER TABLE ad_system_registration ADD COLUMN max_nodes_allowed INT NULL' }
];

async function columnExists(db, table, col) {
  const sql = db.dialect === 'mssql'
    ? 'SELECT 1 AS hit FROM sys.columns WHERE object_id = OBJECT_ID(?) AND name = ?'
    : 'SELECT 1 AS hit FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?';
  const { rows } = await db.query(sql, [table, col]);
  return Array.isArray(rows) && rows.length > 0;
}

async function tableExists(db, table) {
  const sql = db.dialect === 'mssql'
    ? 'SELECT 1 AS hit FROM sys.tables WHERE name = ?'
    : 'SELECT 1 AS hit FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?';
  const { rows } = await db.query(sql, [table]);
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 幂等 ALTER: 给 ad_system_registration 加两列配额字段。
 *
 * @param {object} db     — 已就绪的连接
 * @param {object} logger — pino logger
 * @returns {{ applied: number, skipped: number, details: Array }}
 */
export async function applyLicenseQuotaColumns(db, logger) {
  const result = { applied: 0, skipped: 0, details: [] };

  for (const table of TABLES) {
    if (!await tableExists(db, table)) {
      // MySQL baseline 无此表 → 正常路径, 不是错误. quota 功能届时不可用,
      // 但既有 license 流程照常 (max_nodes 读不到 = 不限额 = 老行为)。
      result.skipped += COLUMNS.length;
      result.details.push({ table, outcome: 'table_missing' });
      logger?.warn?.({ table }, 'license-quota ALTER skipped: table not found (MySQL baseline lacks it)');
      continue;
    }
    for (const col of COLUMNS) {
      try {
        if (await columnExists(db, table, col.name)) {
          result.skipped += 1;
          result.details.push({ table, col: col.name, outcome: 'exists' });
          continue;
        }
        const ddl = db.dialect === 'mssql' ? col.ddlMssql : col.ddlMysql;
        await db.execute(ddl, []);
        result.applied += 1;
        result.details.push({ table, col: col.name, outcome: 'added' });
        logger?.info?.({ table, col: col.name }, 'license-quota ALTER: column added');
      } catch (e) {
        // 单列失败不阻断 —— 缺列只意味着配额不可用(= 不限额), 不影响既有流程.
        result.details.push({ table, col: col.name, outcome: 'failed', error: e.message });
        logger?.warn?.({ table, col: col.name, err: e.message }, 'license-quota ALTER failed; continuing');
      }
    }
  }

  return result;
}