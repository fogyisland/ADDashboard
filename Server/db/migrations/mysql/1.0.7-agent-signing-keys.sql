-- verify: table agent_signing_keys
--
-- R161.34 (2026-11-07) — per-agent 签名密钥表 (红队审计 A-F1, P1)
--
-- ★★ 这个表修的是什么漏洞:
--   中心与 agent 之间只有**一份全局共享**的 agent token
--   (system_config.agent_token_current / _previous 两行)。S82 的
--   X-Agent-Signature = HMAC(token, hostname + ':' + agentId + ':' + body)
--   ⇒ HMAC 只能证明"**持有 token 的人**签了这条请求", **不能**证明
--     "**这台机器**签了这条请求" —— 因为 hostname / agentId 全部由
--     请求方自报 (req.body.hostname / X-Agent-Hostname)。
--   ⇒ 循环论证: 用 A 的合法 token + 伪造的 hostname=B, 可以算出
--     **完全合法**的签名 (密钥全局共享, 谁都会签)。
--   ⇒ 后果不是"多看一条报表": member-commands 的 params.script 是
--     **自由格式 PowerShell 全文**, 跨机领取命令 ≈ **任意代码执行**。
--
-- ★ 为什么必须是 per-agent 密钥 (而不是"token ↔ hostname 绑定表"):
--   绑定表**挡不住**冒充。理由是数学的, 不是工程实现问题:
--     全 fleet 共用一把 token ⇒ A 和 B 的签名用**同一把钥匙**算 ⇒
--     中心看到 (hostname=B, agentId=B) 的合法签名时, **无法区分**
--     "这是 B 发的" 与 "这是 A 拿着共享 token 冒充 B 发的"。
--     绑定表只能做到"事后审计时能看出这台机器登记过", 拦不住请求。
--   ⇒ 唯一的解法是**让每台机器的签名密钥不同**: 中心按 **agentId**
--     反查该机的密钥来重算 HMAC ⇒ 冒充者没有 B 的密钥 ⇒ 算不出
--     B 的合法签名。
--
-- ★ 表结构:
--   agent_id     VARCHAR(64)  PK  — agent 的持久标识 (= $env:COMPUTERNAME,
--                                     Register-ADDashboardAgent.ps1 写入 appsettings)
--   signing_key  VARCHAR(96)  NOT NULL — 96 个 hex 字符 = 48 字节 = 384 bit
--                                     (与 agent_token_current 同规格: randomBytes(48))
--   key_version  INT          NOT NULL — 单调版本号, agent 用它判断
--                                     "中心发来的比我手上的新" (跟 agent_token_version 同构)
--   issued_at    DATETIME     NOT NULL
--   last_seen_at DATETIME     NULL
--   revoked_at   DATETIME     NULL — 非空 = 已吊销 (该 agent 的密钥作废)
--
-- ★★ 为什么 signing_key 明文存 (operator 2026-11-07 决定):
--   中心必须能**重算** HMAC 才能验签 ⇒ 不能只存摘要 ⇒ 必须可逆存储。
--   这与现有的 agent_token_current (明文存 system_config) 是**同一个
--   风险面** —— 访问面等于数据库访问面, 不引入**新的**风险类别。
--   若改成"用中心主密钥加密后存", 中心重启后主密钥丢失 = **整个 fleet
--   同时掉线**, 故障半径远大于收益 ⇒ 不做。
--
-- ★ 密钥的生命周期:
--   · 首次带签名的请求 ⇒ 中心按 agentId 生成一把并下发 (heartbeat 响应)
--   · agent 落盘后, 之后所有请求用它签名 ⇒ 中心按 agentId 反查验签
--   · 中心轮换全局 token 时, **不影响** per-agent 密钥 (它才是真正的身份凭据)
--   · 吊销某台机器 ⇒ revoked_at 置位 ⇒ 该机后续请求 401
--
-- ★★ 幂等性 (规则 2): 用 INFORMATION_SCHEMA 探针守卫 CREATE TABLE,
--   重复跑不会报错。
--
-- ★ DDL 前必须 SET SESSION lock_wait_timeout:
--   MySQL 的元数据锁等待默认 31536000 秒 (一年) —— 不设它, 迁移在
--   启动路径上**挂死一年**。10 秒足够: 抢不到锁就失败重试。

SET SESSION lock_wait_timeout = 10;

-- 守卫: 表不存在才建。
--   ⚠ 用 INFORMATION_SCHEMA.TABLES (标准 ANSI 表, 两个方言可比);
--     先看 TABLE_TYPE = 'BASE TABLE' —— 同名视图的话 CREATE TABLE
--     会报错, 而这里要判的正是"实体表在不在"。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'agent_signing_keys'
      AND TABLE_TYPE = 'BASE TABLE') = 0,
  'CREATE TABLE agent_signing_keys (
     agent_id     VARCHAR(64) NOT NULL,
     signing_key  VARCHAR(96) NOT NULL,
     key_version  INT NOT NULL DEFAULT 1,
     issued_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_seen_at DATETIME NULL,
     revoked_at   DATETIME NULL,
     PRIMARY KEY (agent_id),
     KEY idx_agent_signing_keys_active (agent_id, revoked_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
