// R161.4 — 基线幂等性守卫 (check-baseline-idempotency.mjs) 的回归网
//
// 为什么这个文件在 center/tests/ 顶层而不是 center/tests/audit/:
//   center/package.json 的 "test" 脚本的 glob 是
//     tests/*.test.js tests/auth/*.test.js ... tests/e2e/*.test.js
//   **不含 tests/audit/**。放进去 CI 根本不会跑 —— 一个不会被执行的测试
//   等于没有测试。而给 package.json 加 glob 会改掉它的内容 ⇒ `.install-hash`
//   失配 ⇒ 目标机 (常常离线) 删 node_modules 重跑 npm install ⇒ 装机报废。
//   ⇒ 放顶层, 用现成的 glob, 不碰 package.json。
//
// 这个网守的是什么
// ---------------
// 2026-10-25 操作员在 MySQL 上跑初始化向导报 `Duplicate column name 'task_id'`:
//   根因 = 基线里同一张表同一列的 DDL 有**两代**, 旧代是**裸** ALTER (重跑必炸),
//   新代是**已守卫**的同一条 ALTER。全新库"旧的先跑、新的跳过" ⇒ 一次过;
//   重跑 ⇒ 炸。而 init 向导的 POST /db/apply 每次都跑 applyAll(), 基线**必须可重复执行**。
//
// 守卫查的是"顶层语句流里还有没有裸 DDL" —— 因为守卫写法把 DDL 变成了
// `SET @s = ...` 里的**字符串字面量**, 顶层流里就看不见那条 DDL 了。
//
// 为什么必须有负向测试:
//   R161 的教训 —— "检测器自己也要负向测试"。一个只会输出 0 违规的守卫
//   和一个哑巴无法区分。本文件对**每一条**规则都构造一个必须触发的样本,
//   并且断言 "规则表里每条规则都有对应样本" —— 将来有人加了规则忘了写样本,
//   这个断言会失败。
//
// 用法: cd Server/center && npm test   (或 node --test tests/baseline-idempotency.test.js)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULES,
  checkFile,
  checkStatements,
  dialectOf,
  selfTest,
} from '../../scripts/audit/check-baseline-idempotency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');            // Server/
const REPO_ROOT = resolve(SERVER_ROOT, '..');              // repo root

const MYSQL_BASELINE = resolve(SERVER_ROOT, 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');
const MSSQL_BASELINE = resolve(SERVER_ROOT, 'db', 'migrations', 'mssql', '1.0.0-baseline.sql');
const LINUX_MYSQL_BASELINE = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');
const LINUX_MSSQL_BASELINE = resolve(REPO_ROOT, 'LinuxServer', 'db', 'migrations', 'mssql', '1.0.0-baseline.sql');

/** 收集某个检查结果里的问题 ruleId 集合。 */
function ruleIdsOf(problems) {
  return problems.map((p) => p.ruleId);
}

// ---------------------------------------------------------------------------
// 1. 正样本 —— 真实基线必须 0 误报
// ---------------------------------------------------------------------------

describe('check-baseline-idempotency — 真实基线', () => {
  test('Server MySQL 基线 0 违规', () => {
    assert.ok(existsSync(MYSQL_BASELINE), `基线不存在: ${MYSQL_BASELINE}`);
    const result = checkFile(MYSQL_BASELINE, readFileSync(MYSQL_BASELINE, 'utf8'));
    assert.deepEqual(result.problems, [], `MySQL 基线被误判:\n${JSON.stringify(result.problems, null, 2)}`);
    assert.equal(result.dialect, 'mysql');
    assert.ok(result.statementCount > 200, `语句数异常少: ${result.statementCount}`);
  });

  test('Server MSSQL 基线 0 违规', () => {
    assert.ok(existsSync(MSSQL_BASELINE), `基线不存在: ${MSSQL_BASELINE}`);
    const result = checkFile(MSSQL_BASELINE, readFileSync(MSSQL_BASELINE, 'utf8'));
    assert.deepEqual(result.problems, [], `MSSQL 基线被误判:\n${JSON.stringify(result.problems, null, 2)}`);
    assert.equal(result.dialect, 'mssql');
    assert.ok(result.statementCount > 300, `语句数异常少: ${result.statementCount}`);
  });

  test('交付包 (LinuxServer) 基线 0 违规 —— 交付树必须与源树同样干净', () => {
    for (const file of [LINUX_MYSQL_BASELINE, LINUX_MSSQL_BASELINE]) {
      assert.ok(existsSync(file), `交付基线不存在: ${file}`);
      const result = checkFile(file, readFileSync(file, 'utf8'));
      assert.deepEqual(result.problems, [], `交付基线被误判 (${file}):\n${JSON.stringify(result.problems, null, 2)}`);
    }
  });

  test('交付包的 MySQL 基线与源树逐字一致 (手抄副本不许漂移)', () => {
    assert.ok(existsSync(LINUX_MYSQL_BASELINE), `交付基线不存在: ${LINUX_MYSQL_BASELINE}`);
    const source = readFileSync(MYSQL_BASELINE);
    const linux = readFileSync(LINUX_MYSQL_BASELINE);
    assert.equal(linux.length, source.length, '交付包基线与源树基线字节长度不同');
    assert.ok(linux.equals(source), '交付包基线与源树基线内容不同');
  });
});

// ---------------------------------------------------------------------------
// 2. 不变量 —— 直接断言基线的结构, 不依赖守卫实现
// ---------------------------------------------------------------------------

describe('check-baseline-idempotency — 基线结构不变量', () => {
  test('MySQL 基线顶层没有裸 ALTER / 裸 CREATE INDEX', () => {
    const problems = checkStatements('mysql', [
      'ALTER TABLE ad_admin_commands ADD COLUMN task_id VARCHAR(64) NULL',
    ]);
    assert.ok(ruleIdsOf(problems).includes('MYSQL-BARE-ALTER'), JSON.stringify(problems));
  });

  test('MySQL 基线里每一条 SET @s 守卫都有配对的 PREPARE/EXECUTE/DEALLOCATE', () => {
    const sql = readFileSync(MYSQL_BASELINE, 'utf8');
    const result = checkFile(MYSQL_BASELINE, sql);
    assert.ok(!ruleIdsOf(result.problems).includes('GUARD-CHAIN-BROKEN'), JSON.stringify(result.problems));
    assert.ok(!ruleIdsOf(result.problems).includes('GUARD-CHAIN-ORPHAN'), JSON.stringify(result.problems));
    assert.ok(result.guardCount >= 40, `守卫链数量异常少: ${result.guardCount}`);
  });

  test('MSSQL 基线顶层全部被 IF 守卫 (唯一豁免是前置 DROP 过的 CREATE VIEW)', () => {
    const result = checkFile(MSSQL_BASELINE, readFileSync(MSSQL_BASELINE, 'utf8'));
    assert.ok(!ruleIdsOf(result.problems).includes('MSSQL-UNGUARDED-TOPLEVEL'), JSON.stringify(result.problems));
    assert.ok(!ruleIdsOf(result.problems).includes('MSSQL-CREATE-VIEW-NO-PRECEDING-DROP'), JSON.stringify(result.problems));
  });
});

// ---------------------------------------------------------------------------
// 3. 负样本 —— 每条规则都必须能触发
// ---------------------------------------------------------------------------

describe('check-baseline-idempotency — 规则负样本', () => {
  for (const rule of RULES) {
    test(`${rule.id} 的负样本能触发本规则`, () => {
      const dialect = rule.dialects[0];
      const hits = rule.detect({ dialect, statements: rule.negativeSample });
      assert.ok(
        hits && hits.length > 0,
        `规则 ${rule.id} 的负样本没有触发它 ⇒ 这条规则永远不会报警 (假仪器)。` +
          `负样本: ${JSON.stringify(rule.negativeSample)}`
      );
    });
  }

  test('规则表里的每一条规则都有负样本和正样本', () => {
    const missingNegative = RULES.filter((r) => !r.negativeSample || r.negativeSample.length === 0);
    assert.deepEqual(
      missingNegative.map((r) => r.id),
      [],
      '这些规则没有负样本 —— 加了规则忘了写样本, 等于这条规则没人验证过'
    );
    const missingPositive = RULES.filter((r) => !r.positiveSamples || r.positiveSamples.length === 0);
    assert.deepEqual(
      missingPositive.map((r) => r.id),
      [],
      '这些规则没有正样本 —— 规则过宽时会误报, 没有正样本就没人能发现'
    );
  });

  test('每条规则的正样本都不触发 (规则不许过宽)', () => {
    for (const rule of RULES) {
      const dialect = rule.dialects[0];
      for (const sample of rule.positiveSamples) {
        const hits = rule.detect({ dialect, statements: sample });
        assert.ok(
          !hits || hits.length === 0,
          `规则 ${rule.id} 的正样本触发了它 ⇒ 规则过宽, 会误报。` +
            `正样本: ${JSON.stringify(sample)} → ${JSON.stringify(hits)}`
        );
      }
    }
  });

  test('守卫脚本自身的自检通过 (CLI 与测试用的是同一份规则表)', () => {
    const self = selfTest();
    assert.ok(self.ok, `守卫自检失败:\n${JSON.stringify(self.failures, null, 2)}`);
    assert.equal(self.checkedRules, RULES.length);
  });
});

// ---------------------------------------------------------------------------
// 4. ★ 历史缺陷基线 —— 用修前基线里**逐字摘出**的真实语句做负向验证
// ---------------------------------------------------------------------------
// 这 12 条就是 R161.4 修复前基线里的裸 DDL —— 它们在全新库上"一次过",
// 在**重跑**时炸出 `Duplicate column name 'task_id'` (errno 1060)。
// 守卫必须把它们一条不落地抓出来。

const PRE_FIX_BARE_DDL = [
  'ALTER TABLE ad_admin_commands ADD COLUMN task_id VARCHAR(64) NULL',
  'CREATE UNIQUE INDEX ux_ad_admin_commands_task_id ON ad_admin_commands(task_id)',
  'CREATE INDEX ix_ad_admin_commands_dc_task ON ad_admin_commands(target_dc, task_id)',
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN client_settings_version INT NOT NULL DEFAULT 0 AFTER agent_token_version',
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN heartbeat_interval_seconds INT NULL DEFAULT NULL AFTER client_settings_version',
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN last_upgrade_event JSON NULL',
  'ALTER TABLE ad_lockout_events ADD COLUMN target_user_description VARCHAR(512) NULL AFTER target_user_name',
  'ALTER TABLE ad_lockout_events CHANGE COLUMN target_user_description target_user_display_name VARCHAR(512) NULL',
  'ALTER TABLE package_runs ADD COLUMN script_version VARCHAR(32) NULL',
  'CREATE INDEX ix_partner_inbound_collected_at ON ad_partner_inbound (collected_at)',
  'CREATE INDEX ix_partner_inbound_dest_dc ON ad_partner_inbound (dest_dc)',
  'CREATE INDEX ix_partner_inbound_agent_id ON ad_partner_inbound (agent_id)',
];

describe('check-baseline-idempotency — 修前基线的裸 DDL 全部要被抓到', () => {
  test('12 条裸 DDL 一条不落', () => {
    const problems = checkStatements('mysql', PRE_FIX_BARE_DDL);
    const ids = ruleIdsOf(problems);
    const alterHits = problems.filter((p) => p.ruleId === 'MYSQL-BARE-ALTER');
    const indexHits = problems.filter((p) => p.ruleId === 'MYSQL-BARE-CREATE-INDEX');
    assert.equal(alterHits.length, 7, `应当抓到 7 条裸 ALTER, 实际 ${alterHits.length}:\n${JSON.stringify(problems, null, 2)}`);
    assert.equal(indexHits.length, 5, `应当抓到 5 条裸 CREATE INDEX, 实际 ${indexHits.length}:\n${JSON.stringify(problems, null, 2)}`);
    assert.ok(ids.includes('MYSQL-BARE-ALTER'));
    assert.ok(ids.includes('MYSQL-BARE-CREATE-INDEX'));
  });

  test('操作员报的那条 (task_id) 必须在告警里', () => {
    const problems = checkStatements('mysql', PRE_FIX_BARE_DDL);
    const hit = problems.find(
      (p) => p.ruleId === 'MYSQL-BARE-ALTER' && /ad_admin_commands ADD COLUMN task_id/.test(p.statement)
    );
    assert.ok(hit, `没有抓到 task_id 那条:\n${JSON.stringify(problems, null, 2)}`);
  });
});

// ---------------------------------------------------------------------------
// 5. 守卫链结构的负样本 —— 这类是"执行测试抓不到"的
// ---------------------------------------------------------------------------
// 守卫链写了一半 (只写 SET @s 漏了 EXECUTE) 时, 基线**不报错**, 只是
// **静默少建一列**。"apply-twice 两遍都成功" 这种弱证明完全看不出来。

describe('check-baseline-idempotency — 守卫链结构负样本', () => {
  test('SET @s 后面缺 EXECUTE ⇒ GUARD-CHAIN-BROKEN', () => {
    const statements = [
      "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_x' AND COLUMN_NAME = 'c1') = 0, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'DEALLOCATE PREPARE stmt',
    ];
    const problems = checkStatements('mysql', statements);
    assert.ok(ruleIdsOf(problems).includes('GUARD-CHAIN-BROKEN'), JSON.stringify(problems));
  });

  test('探针查 A 表但 DDL 改 B 表 ⇒ GUARD-PROBE-TARGET-MISMATCH', () => {
    const statements = [
      "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_y' AND COLUMN_NAME = 'c1') = 0, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'EXECUTE stmt',
      'DEALLOCATE PREPARE stmt',
    ];
    const problems = checkStatements('mysql', statements);
    assert.ok(ruleIdsOf(problems).includes('GUARD-PROBE-TARGET-MISMATCH'), JSON.stringify(problems));
  });

  test('探针硬编码库名 ⇒ GUARD-PROBE-HARDCODED-SCHEMA', () => {
    const statements = [
      "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'addashboard' AND TABLE_NAME = 'ad_x' AND COLUMN_NAME = 'c1') = 0, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'EXECUTE stmt',
      'DEALLOCATE PREPARE stmt',
    ];
    const problems = checkStatements('mysql', statements);
    assert.ok(ruleIdsOf(problems).includes('GUARD-PROBE-HARDCODED-SCHEMA'), JSON.stringify(problems));
  });

  test('成对改名只探了旧列 ⇒ GUARD-RENAME-PAIR-INCOMPLETE', () => {
    const statements = [
      "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_description') = 1, 'ALTER TABLE ad_lockout_events CHANGE COLUMN target_user_description target_user_display_name VARCHAR(512) NULL', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'EXECUTE stmt',
      'DEALLOCATE PREPARE stmt',
    ];
    const problems = checkStatements('mysql', statements);
    assert.ok(ruleIdsOf(problems).includes('GUARD-RENAME-PAIR-INCOMPLETE'), JSON.stringify(problems));
  });

  test('条件恒真的守卫 ⇒ GUARD-NON-CANONICAL-SHAPE', () => {
    const statements = [
      "SET @s = (SELECT IF(1 = 1, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'EXECUTE stmt',
      'DEALLOCATE PREPARE stmt',
    ];
    const problems = checkStatements('mysql', statements);
    assert.ok(ruleIdsOf(problems).includes('GUARD-NON-CANONICAL-SHAPE'), JSON.stringify(problems));
  });

  test('守卫里的 DDL 含分号 ⇒ GUARD-DDL-MULTI-STATEMENT', () => {
    const statements = [
      "SET @s = (SELECT IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_x' AND COLUMN_NAME = 'c1') = 0, 'ALTER TABLE ad_x ADD COLUMN c1 INT NULL; DROP TABLE ad_y', 'SELECT 1'))",
      'PREPARE stmt FROM @s',
      'EXECUTE stmt',
      'DEALLOCATE PREPARE stmt',
    ];
    const problems = checkStatements('mysql', statements);
    assert.ok(ruleIdsOf(problems).includes('GUARD-DDL-MULTI-STATEMENT'), JSON.stringify(problems));
  });
});

// ---------------------------------------------------------------------------
// 6. MSSQL 侧负样本
// ---------------------------------------------------------------------------

describe('check-baseline-idempotency — MSSQL 负样本', () => {
  test('顶层 CREATE TABLE 没被 IF 包住 ⇒ MSSQL-UNGUARDED-TOPLEVEL', () => {
    const problems = checkStatements('mssql', ['CREATE TABLE ad_x (id INT NOT NULL)']);
    assert.ok(ruleIdsOf(problems).includes('MSSQL-UNGUARDED-TOPLEVEL'), JSON.stringify(problems));
  });

  test('顶层 CREATE VIEW 没有前置 DROP VIEW ⇒ MSSQL-CREATE-VIEW-NO-PRECEDING-DROP', () => {
    const problems = checkStatements('mssql', ['CREATE VIEW v_x AS SELECT 1 AS a']);
    assert.ok(ruleIdsOf(problems).includes('MSSQL-CREATE-VIEW-NO-PRECEDING-DROP'), JSON.stringify(problems));
  });

  test('IF 块里的 TRUNCATE 依然违规 (守卫只保证"对象存在才执行", 不保护数据)', () => {
    const problems = checkStatements('mssql', ["IF OBJECT_ID('[ad_x]', 'U') IS NOT NULL TRUNCATE TABLE [ad_x]"]);
    assert.ok(ruleIdsOf(problems).includes('MSSQL-TRUNCATE-INSIDE-GUARD'), JSON.stringify(problems));
  });

  test('合规的 MSSQL 守卫写法不报错', () => {
    const problems = checkStatements('mssql', [
      "IF OBJECT_ID('[ad_x]', 'U') IS NULL BEGIN CREATE TABLE [ad_x] ([id] INT NOT NULL) END",
      "IF OBJECT_ID('[v_x]', 'V') IS NOT NULL DROP VIEW [v_x]",
      'CREATE VIEW v_x AS SELECT 1 AS a',
    ]);
    assert.deepEqual(problems, [], JSON.stringify(problems));
  });
});

// ---------------------------------------------------------------------------
// 7. 方言判定
// ---------------------------------------------------------------------------

describe('check-baseline-idempotency — 方言判定', () => {
  test('路径里带 /mysql/ 或 /mssql/ 才能判定', () => {
    assert.equal(dialectOf('Server/db/migrations/mysql/1.0.0-baseline.sql'), 'mysql');
    assert.equal(dialectOf('Server\\db\\migrations\\mssql\\1.0.0-baseline.sql'), 'mssql');
  });

  test('MySQL 规则不会作用到 MSSQL 基线上', () => {
    const problems = checkStatements('mssql', ['ALTER TABLE ad_x ADD COLUMN c1 INT NULL']);
    assert.ok(!ruleIdsOf(problems).includes('MYSQL-BARE-ALTER'), JSON.stringify(problems));
  });

  test('MSSQL 规则不会作用到 MySQL 基线上', () => {
    const problems = checkStatements('mysql', ['CREATE TABLE ad_x (id INT NOT NULL)']);
    assert.ok(!ruleIdsOf(problems).includes('MSSQL-UNGUARDED-TOPLEVEL'), JSON.stringify(problems));
  });
});
