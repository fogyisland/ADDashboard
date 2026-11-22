// SQL helpers for the agent_signing_keys table (R161.34, A-F1 修复).
//
// ★ 这张表存在的原因 (红队审计 A-F1, P1):
//   中心与 agent 之间只有**一份全局共享**的 agent token。S82 的签名
//   X-Agent-Signature = HMAC(token, hostname + ':' + agentId + ':' + body)
//   ⇒ HMAC 只证明"持有 token 的人签了这条请求", 不证明"这台机器签了
//     这条请求" —— hostname / agentId 全是请求方自报的。
//   ⇒ 用 A 的合法 token + 伪造的 hostname=B 可以算出完全合法的签名
//     (密钥全局共享, 谁都会签) ⇒ 循环论证。
//   ⇒ member-commands 的 params.script 是**自由格式 PowerShell 全文**
//     ⇒ 跨机领取命令 ≈ 任意代码执行。
//
// ★ 为什么是 per-agent 密钥而不是"token ↔ hostname 绑定表":
//   绑定表**挡不住**冒充 —— 全 fleet 共用一把 token ⇒ A 和 B 的签名用
//   同一把钥匙算 ⇒ 中心**无法区分**"这是 B 发的"与"这是 A 拿着共享
//   token 冒充 B 发的"。绑定表只能事后审计, 拦不住请求。
//   ⇒ 唯一解法: 每台机器一把签名密钥, 中心按 **agentId** 反查重算。
//
// 表结构 (MySQL / MSSQL 两边收敛到同一个最终 schema):
//   agent_id     VARCHAR(64) PK   — = $env:COMPUTERNAME
//   signing_key  VARCHAR(96)      — 96 hex = 48 字节 = 384 bit
//   key_version  INT              — 单调版本号 (agent 用它判断新旧)
//   issued_at    DATETIME
//   last_seen_at DATETIME NULL
//   revoked_at   DATETIME NULL    — 非空 = 已吊销
//
// ★ 双语言范式跟 center/src/db/sql/member-servers.js 一致:
//   MySQL 用 ON DUPLICATE KEY UPDATE; MSSQL 用 MERGE。
//   ★ MSSQL 侧的 agent_id 参数必须 CAST(? AS VARCHAR(64)) —— 跟
//     member-servers.js 的 FIND_BY_HOSTNAME_MSSQL 同一条纪律 (否则
//     隐式转换会让索引失效, 走全表扫)。

// 按 agent_id 取该机密钥 (验签主路径)。revoked_at 非空的行**也**返回,
//   由调用方判断是否拒绝 —— SQL 层不做过滤, 免得"查不到"与"已吊销"
//   两种语义混在一个空结果里。
const FIND_BY_AGENT_MYSQL = `SELECT agent_id, signing_key, key_version, issued_at, last_seen_at, revoked_at
  FROM agent_signing_keys
  WHERE agent_id = ?`;
const FIND_BY_AGENT_MSSQL = `SELECT agent_id, signing_key, key_version, issued_at, last_seen_at, revoked_at
  FROM agent_signing_keys
  WHERE agent_id = CAST(? AS VARCHAR(64))`;

// 写入/更新该机密钥 (首次发放 + 轮换)。MySQL 用 ON DUPLICATE KEY UPDATE
//   把 signing_key / key_version 一起换掉; MSSQL 用 MERGE 的 MATCHED 分支。
//   ⚠ revoked_at 在 UPDATE 分支里**不动** —— 吊销是 admin 决策, 发密钥
//     不该悄悄复活一台被吊销的机器 (跟 member-servers 的 COALESCE
//     preserve 同一条纪律: agent 路径不能覆盖 admin 决策)。
const UPSERT_MYSQL = `INSERT INTO agent_signing_keys
  (agent_id, signing_key, key_version, issued_at, last_seen_at)
  VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  ON DUPLICATE KEY UPDATE
    signing_key = VALUES(signing_key),
    key_version = VALUES(key_version),
    last_seen_at = UTC_TIMESTAMP()`;

const UPSERT_MSSQL = `MERGE INTO agent_signing_keys AS t
  USING (SELECT CAST(? AS VARCHAR(64)) AS agent_id, CAST(? AS VARCHAR(96)) AS signing_key,
    CAST(? AS INT) AS key_version
  ) AS s
  ON t.agent_id = s.agent_id
  WHEN MATCHED THEN UPDATE SET
    signing_key = s.signing_key,
    key_version = s.key_version,
    last_seen_at = SYSUTCDATETIME()
  WHEN NOT MATCHED THEN INSERT
    (agent_id, signing_key, key_version, issued_at, last_seen_at)
    VALUES
    (s.agent_id, s.signing_key, s.key_version, SYSUTCDATETIME(), SYSUTCDATETIME());`;

// 触碰 last_seen_at (该机正常通信时更新活跃时间)。
const TOUCH_MYSQL = `UPDATE agent_signing_keys SET last_seen_at = UTC_TIMESTAMP()
  WHERE agent_id = ?`;
const TOUCH_MSSQL = `UPDATE agent_signing_keys SET last_seen_at = SYSUTCDATETIME()
  WHERE agent_id = CAST(? AS VARCHAR(64))`;

// 吊销 (admin 决策): 置 revoked_at。**只允许从 NULL 变非 NULL**
//   (重复吊销不覆盖原始时间戳 —— 保留"第一次被吊销"的事实)。
const REVOKE_MYSQL = `UPDATE agent_signing_keys SET revoked_at = UTC_TIMESTAMP()
  WHERE agent_id = ? AND revoked_at IS NULL`;
const REVOKE_MSSQL = `UPDATE agent_signing_keys SET revoked_at = SYSUTCDATETIME()
  WHERE agent_id = CAST(? AS VARCHAR(64)) AND revoked_at IS NULL`;

// 吊销后重新启用 (admin 决策): 清空 revoked_at。
const UNREVOKE_MYSQL = `UPDATE agent_signing_keys SET revoked_at = NULL
  WHERE agent_id = ?`;
const UNREVOKE_MSSQL = `UPDATE agent_signing_keys SET revoked_at = NULL
  WHERE agent_id = CAST(? AS VARCHAR(64))`;

// 全部密钥清单 (admin 可查: 每台机器的密钥版本 + 状态)。
const LIST_ALL_MYSQL = `SELECT agent_id, key_version, issued_at, last_seen_at, revoked_at
  FROM agent_signing_keys
  ORDER BY agent_id`;
// ★ 清单**不含** signing_key —— 它是凭据材料, 出现在无审计的读路径上
//   违反本项目"读凭据材料必留审计"的契约 (同 services/agent-token.js 的
//   fingerprintAgentToken 设计论证)。要看明文只能走专门的 reveal 端点。
const LIST_ALL_MSSQL = LIST_ALL_MYSQL;

export const agentSigningKeys = {
  mysql: {
    findByAgent: FIND_BY_AGENT_MYSQL,
    upsert: UPSERT_MYSQL,
    touch: TOUCH_MYSQL,
    revoke: REVOKE_MYSQL,
    unrevoke: UNREVOKE_MYSQL,
    listAll: LIST_ALL_MYSQL
  },
  mssql: {
    findByAgent: FIND_BY_AGENT_MSSQL,
    upsert: UPSERT_MSSQL,
    touch: TOUCH_MSSQL,
    revoke: REVOKE_MSSQL,
    unrevoke: UNREVOKE_MSSQL,
    listAll: LIST_ALL_MSSQL
  }
};
