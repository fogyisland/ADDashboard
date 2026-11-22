-- verify: table agent_signing_keys
--
-- R161.34 (2026-11-07) — per-agent 签名密钥表 (红队审计 A-F1, P1) — MSSQL
--
-- ★★ 这个表修的是什么漏洞:
--   中心与 agent 之间只有**一份全局共享**的 agent token。S82 的
--   X-Agent-Signature = HMAC(token, hostname + ':' + agentId + ':' + body)
--   ⇒ HMAC 只能证明"**持有 token 的人**签了这条请求", **不能**证明
--     "**这台机器**签了这条请求" —— hostname / agentId 全部由请求方自报。
--   ⇒ 循环论证: 用 A 的合法 token + 伪造的 hostname=B, 可以算出
--     **完全合法**的签名 (密钥全局共享, 谁都会签)。
--   ⇒ 后果不是"多看一条报表": member-commands 的 params.script 是
--     **自由格式 PowerShell 全文**, 跨机领取命令 ≈ **任意代码执行**。
--
-- ★ 为什么必须是 per-agent 密钥 (而不是"token ↔ hostname 绑定表"):
--   绑定表**挡不住**冒充 —— 全 fleet 共用一把 token ⇒ A 和 B 的签名用
--   同一把钥匙算 ⇒ 中心**无法区分**"这是 B 发的" 与 "这是 A 拿着共享
--   token 冒充 B 发的"。绑定表只能事后审计, 拦不住请求。
--   ⇒ 唯一解法: 每台机器一把签名密钥, 中心按 **agentId** 反查重算 HMAC。
--
-- ★ MSSQL 侧的列类型对应 (与 MySQL 的逐字等价):
--   VARCHAR(64)  → VARCHAR(64)
--   VARCHAR(96)  → VARCHAR(96)   (96 hex = 48 字节 = 384 bit)
--   INT          → INT
--   DATETIME     → DATETIME2(0)  (精确值; 本项目其它表已用 DATETIME2)
--
-- ★★ 幂等性 (规则 2): IF OBJECT_ID(...) IS NULL 守卫 CREATE TABLE,
--   重复跑不会报错。
--
-- ★ DDL 前必须 SET LOCK_TIMEOUT 10000:
--   MSSQL 的锁等待默认 -1 (无限) ⇒ 不设它, 迁移在启动路径上**挂死**。

SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;

IF OBJECT_ID('[dbo].[agent_signing_keys]', 'U') IS NULL
BEGIN
  CREATE TABLE [dbo].[agent_signing_keys] (
    [agent_id] VARCHAR(64) NOT NULL,
    [signing_key] VARCHAR(96) NOT NULL,
    [key_version] INT NOT NULL DEFAULT 1,
    [issued_at] DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    [last_seen_at] DATETIME2(0) NULL,
    [revoked_at] DATETIME2(0) NULL,
    CONSTRAINT [PK_agent_signing_keys] PRIMARY KEY ([agent_id])
  );
END;

-- 二级索引 (与 MySQL 侧的 KEY idx_* 逐字对应)。
--   ⚠ 键长: (agent_id VARCHAR(64), revoked_at DATETIME2(0)) 在 MSSQL
--     非聚集索引键上限 1700 字节内 (64 字节 + 8 字节) ⇒ 安全。
IF OBJECT_ID('[dbo].[agent_signing_keys]', 'U') IS NOT NULL
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'idx_agent_signing_keys_active'
      AND object_id = OBJECT_ID('[dbo].[agent_signing_keys]')
  )
  BEGIN
    CREATE NONCLUSTERED INDEX [idx_agent_signing_keys_active]
      ON [dbo].[agent_signing_keys] ([agent_id], [revoked_at]);
  END;
END;
GO
