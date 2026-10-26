// R161.6 (2026-10-26) — feature flag **seed 覆盖率**回归网
//
// ★ 本轮修的现场 (操作员原话):
//   「检查出来了, 功能开关中的内容不对 …… 这是我们要的功能开关。现有功能开关不够。」
//   「ADUC 开关在界面中开启了后也不会在首页中有显示」
//   「确认下 seed 的结果是否正确」
//
// ★ 根因 (纯静态可复现, 不需要连库):
//   基线 Server/db/migrations/{mysql,mssql}/1.0.0-baseline.sql 里
//   ad_feature_flags 只 seed 了 5 行 (ad_management.enabled / mcp.enabled /
//   mcp_write.enabled + rollout 那 2 把隐藏开关), 而**代码里在消费** 9 个 key
//   —— report_center.* 那 4 把从 2026-10-23 (R158.X.116.n) 加上后端 gate +
//   前端 meta.featureFlag + sidebar 入口起, 就一直**没有任何 seed 行**。
//   ⇒ 全新装机 (新装形态才暴露, 存量库行还在):
//       前端 fail-closed (缺 key ⇒ 关闭) ⇒ 报表中心 4 个入口被 v-if 过滤掉,
//                                              4 条路由被守卫弹回首页;
//       后端 fail-open   (缺行 ⇒ 放行) ⇒ /api/report-center/* 照常返回 200。
//   ⇒ 典型的「两层判定分裂」: 界面说功能没有, 接口说功能有。
//
// ★ 本文件锁住 5 件事 (全部静态, 不连真库):
//   1. 覆盖: 代码里消费的每一个 key, 双方言基线**都**必须有 seed 行。
//   2. parity: mysql / mssql 两份基线的 (key → value) 映射完全一致。
//   3. 集合: seed 出来的 key 集合 == 约定的 9 把 (7 布尔 + 2 rollout)。
//   4. 取值: 7 把布尔开关 seed 值 = '1'; rollout = 'full' / '100'。
//   5. 幂等: mysql 用 INSERT IGNORE, mssql 用 IF NOT EXISTS 守卫 ——
//      防止将来有人改成"覆盖写", 把 operator 手动改过的值冲掉。
//
// 用法: cd Server/center && node --test tests/feature-flag-seed-coverage.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsComments, stripSqlComments } from './helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');          // Server/center
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');    // Server
const WEB_SRC = path.join(CENTER_ROOT, 'web', 'src');
const SERVER_SRC = path.join(CENTER_ROOT, 'src');
const MYSQL_BASELINE = path.join(SERVER_ROOT, 'db', 'migrations', 'mysql', '1.0.0-baseline.sql');
const MSSQL_BASELINE = path.join(SERVER_ROOT, 'db', 'migrations', 'mssql', '1.0.0-baseline.sql');

// ---------------------------------------------------------------------------
// 约定的 flag 登记表 —— 代码里消费的 9 个 key 一个不多一个不少。
//   7 把布尔开关 = 操作员贴过来的那份清单 (功能开关页实际显示的那 7 行)。
//   2 把 rollout = agent 升级发布闸门, 不是布尔开关 (值是 'full'/'100'),
//                  在功能开关页被 HIDDEN_KEYS 隐藏, 走专有端点。
// ---------------------------------------------------------------------------
const BOOLEAN_FLAGS = [
  'ad_management.enabled',
  'mcp.enabled',
  'mcp_write.enabled',
  'report_center.enabled',
  'report_center.lockout.enabled',
  'report_center.failed_logon.enabled',
  'report_center.account_change.enabled'
];
const ROLLOUT_FLAGS = [
  'agent_upgrade_rollout_strategy',
  'agent_upgrade_canary_ratio'
];
const CANONICAL_FLAGS = [...BOOLEAN_FLAGS, ...ROLLOUT_FLAGS];
const EXPECTED_VALUES = {
  'agent_upgrade_rollout_strategy': 'full',
  'agent_upgrade_canary_ratio': '100'
};

// ---------------------------------------------------------------------------
// SQL 解析工具
// ---------------------------------------------------------------------------

/**
 * 抽出基线里 ad_feature_flags 的 seed 行 → Map<key, value>。
 *
 * ★ 为什么不按 ';' 切语句: 描述字段里**有**分号 (mcp_write 那条的
 *   "…返 503 (已有 mcpw_ token 失效); 读通道不受影响"), 按 ';' 切会把
 *   元组拦腰截断 ⇒ mcp_write.enabled 会被漏掉。改用"从 INSERT 到下一个
 *   INSERT 之间"取区域 + 引号感知的元组正则, 天然不怕分号。
 */
function extractSeededFlags(sql) {
  const cleaned = stripSqlComments(sql);
  const insertRe = /INSERT\s+(?:IGNORE\s+)?INTO\s+[`\[]?ad_feature_flags[`\]]?\s*\(/gi;
  const starts = [];
  let m;
  while ((m = insertRe.exec(cleaned)) !== null) starts.push(m.index);

  const map = new Map();
  for (let i = 0; i < starts.length; i += 1) {
    const region = cleaned.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : cleaned.length);
    const tupleRe = /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'\s*(?:,\s*'((?:[^']|'')*)'\s*)?\)/g;
    let t;
    while ((t = tupleRe.exec(region)) !== null) {
      const key = t[1].replace(/''/g, "'");
      const value = t[2].replace(/''/g, "'");
      if (!map.has(key)) map.set(key, value);   // 同 key 多次出现 → 保留第一次
    }
  }
  return map;
}

/** 抽出基线里每一处 ad_feature_flags 的 INSERT 语句 (用于幂等形态检查)。 */
function extractFlagInserts(sql) {
  const cleaned = stripSqlComments(sql);
  const re = /INSERT\s+(IGNORE\s+)?INTO\s+[`\[]?ad_feature_flags[`\]]?\s*\(/gi;
  const out = [];
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    out.push({
      ignore: Boolean(m[1]),
      start: m.index,
      // 语句之前的 300 字符 (给 MSSQL 的 IF NOT EXISTS 守卫用)
      before: cleaned.slice(Math.max(0, m.index - 300), m.index)
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 源码消费点扫描
// ---------------------------------------------------------------------------

/**
 * 去掉 JS / Vue 里的注释 (行注释、块注释、HTML 注释), 引号感知。
 * 实现见 tests/helpers/strip-comments.js —— 为什么必须剥 (源码注释里
 * 大量描述着**已经删掉**的 gate) 见那里的说明。
 */
function listSourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|vue)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 从一段源码里抠出所有单引号字符串 (用于数组字面量内部的 key)。 */
function quotedLiterals(text) {
  const out = [];
  const re = /'([^']+)'/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// 消费点识别规则 —— 都是**具体**的语法形态, 不是"任意像 flag 的字符串",
// 这样注释里提到的 key 不会造成误判 (唯一会误判的是 router.js:637 那条
// 注释里的 featureFlag:'mcp_write.enabled', 而它本身就是合法 key, 无害)。
const CONSUMER_RULES = [
  { re: /\bisEnabled\(\s*'([^']+)'\s*\)/g, all: false },            // 前端 store 调用
  { re: /\bfeatureFlag\s*:\s*'([^']+)'/g, all: false },             // 路由 meta: string
  { re: /\bfeatureFlag\s*:\s*\[([^\]]*)\]/g, all: true },           // 路由 meta: string[]
  { re: /\bflag\s*:\s*'([^']+)'/g, all: false },                    // CARDS 卡片
  { re: /\bgetByKey\s*,\s*\[\s*'([^']+)'\s*\]/g, all: false },      // 后端读 flag
  { re: /\bMASTER_FLAG\s*=\s*'([^']+)'/g, all: false },             // 后端总闸
  { re: /\bSUB_FLAGS\s*=\s*\{([^}]*)\}/g, all: true }               // 后端子闸表
];

/** 扫描前端 + 后端源码, 返回被消费的 flag key 集合。 */
function collectConsumedKeys() {
  const consumed = new Map();   // key → [来源文件]
  const files = [
    ...listSourceFiles(WEB_SRC).map((f) => ({ f, scope: 'web' })),
    ...listSourceFiles(SERVER_SRC).map((f) => ({ f, scope: 'server' }))
  ];
  for (const { f, scope } of files) {
    const src = stripJsComments(fs.readFileSync(f, 'utf8'));
    for (const rule of CONSUMER_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      let m;
      while ((m = re.exec(src)) !== null) {
        const keys = rule.all ? quotedLiterals(m[1]) : [m[1]];
        for (const key of keys) {
          if (!consumed.has(key)) consumed.set(key, []);
          consumed.get(key).push(`${scope}:${path.relative(SERVER_ROOT, f)}`);
        }
      }
    }
  }
  return consumed;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('R161.6 — feature flag seed 覆盖 (双方言基线)', () => {
  const mysqlSql = fs.readFileSync(MYSQL_BASELINE, 'utf8');
  const mssqlSql = fs.readFileSync(MSSQL_BASELINE, 'utf8');
  const mysqlSeeds = extractSeededFlags(mysqlSql);
  const mssqlSeeds = extractSeededFlags(mssqlSql);
  const consumed = collectConsumedKeys();

  test('1. 代码里消费的每一个 flag key, 双方言基线都有 seed 行', () => {
    const missingMysql = [];
    const missingMssql = [];
    for (const [key, sources] of consumed) {
      if (!mysqlSeeds.has(key)) missingMysql.push(`${key}  ← ${sources[0]}`);
      if (!mssqlSeeds.has(key)) missingMssql.push(`${key}  ← ${sources[0]}`);
    }
    assert.deepEqual(missingMysql, [],
      'MySQL 基线缺 seed 行 (消费点有, seed 没有 ⇒ 全新装机该功能必然不可达):\n  ' +
      missingMysql.join('\n  '));
    assert.deepEqual(missingMssql, [],
      'MSSQL 基线缺 seed 行:\n  ' + missingMssql.join('\n  '));
  });

  test('2. 双方言 seed 出来的 (key → value) 映射完全一致 (parity)', () => {
    const mysqlKeys = [...mysqlSeeds.keys()].sort();
    const mssqlKeys = [...mssqlSeeds.keys()].sort();
    assert.deepEqual(mssqlKeys, mysqlKeys,
      'mysql / mssql 两份基线 seed 的 key 集合不一致 —— 一边有 seed 一边没有 = ' +
      '同一个功能在两种部署形态下行为不同');
    for (const key of mysqlKeys) {
      assert.equal(mssqlSeeds.get(key), mysqlSeeds.get(key),
        `key "${key}" 的 seed 值在两种方言里不一致`);
    }
  });

  test('3. seed 出来的 key 集合 == 约定的 9 把 (7 布尔 + 2 rollout)', () => {
    const seeded = [...mysqlSeeds.keys()].sort();
    assert.deepEqual(seeded, [...CANONICAL_FLAGS].sort(),
      'seed 的 key 集合跟登记表不一致 —— 多出来的 key 没有消费点 (死 seed), ' +
      '少掉的 key 有消费点却没 seed (本轮修的正是这个)');
  });

  test('4. 7 把布尔开关 seed 值 = "1"; 2 把 rollout = full / 100', () => {
    for (const key of BOOLEAN_FLAGS) {
      assert.equal(mysqlSeeds.get(key), '1',
        `布尔开关 "${key}" 的 seed 值应为 '1' (新装即开), 实际 ${JSON.stringify(mysqlSeeds.get(key))}`);
      assert.equal(mssqlSeeds.get(key), '1',
        `布尔开关 "${key}" 的 mssql seed 值应为 '1'`);
    }
    for (const key of ROLLOUT_FLAGS) {
      assert.equal(mysqlSeeds.get(key), EXPECTED_VALUES[key],
        `rollout 开关 "${key}" 的 seed 值应为 ${EXPECTED_VALUES[key]}`);
      assert.equal(mssqlSeeds.get(key), EXPECTED_VALUES[key],
        `rollout 开关 "${key}" 的 mssql seed 值应为 ${EXPECTED_VALUES[key]}`);
    }
  });

  test('5. 幂等形态: mysql 全用 INSERT IGNORE, mssql 全用 IF NOT EXISTS 守卫', () => {
    // mysql: 每一处都必须是 INSERT IGNORE —— 覆盖写会把 operator 改过的值冲掉。
    for (const stmt of extractFlagInserts(mysqlSql)) {
      assert.ok(stmt.ignore,
        'MySQL 基线里有一处 ad_feature_flags 的 INSERT 不是 INSERT IGNORE —— ' +
        '重复 apply 会覆盖 operator 手动改过的开关值');
    }
    // mssql: 每一处 INSERT 的前一行必须是 IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = '<key>')
    const inserts = extractFlagInserts(mssqlSql);
    assert.ok(inserts.length > 0, 'MSSQL 基线里没找到 ad_feature_flags 的 INSERT');
    for (const stmt of inserts) {
      assert.match(stmt.before, /IF NOT EXISTS\s*\(SELECT 1 FROM ad_feature_flags WHERE \[key\] = '[^']+'\)/i,
        'MSSQL 基线里有一处 ad_feature_flags 的 INSERT 没有 IF NOT EXISTS 守卫 —— ' +
        '重复 apply 会撞主键或覆盖 operator 改过的值');
    }
  });

  test('6. 消费点扫描能真的扫到东西 (防空转: 扫描器坏了 = 什么都"通过")', () => {
    // ★ 覆盖率断言的**自检**: 扫描器坏了会返回空集合, 于是第 1 条测试
    //   永远绿 —— 跟"哑巴"无法区分。必须显式断言扫到了预期数量。
    assert.ok(consumed.size >= CANONICAL_FLAGS.length,
      `消费点扫描只扫到 ${consumed.size} 个 key (< ${CANONICAL_FLAGS.length}) —— ` +
      '扫描规则坏了, 覆盖率断言会变成永远绿的哑巴');
    for (const key of CANONICAL_FLAGS) {
      assert.ok(consumed.has(key),
        `登记的 key "${key}" 在源码里没扫到消费点 —— 要么它已经没人消费了 ` +
        '(那登记表该删它), 要么扫描规则漏了形态 (那覆盖率断言是哑巴)');
    }
  });

  test('7. 抽取器自检: 合成基线缺行必须报"缺", 描述里的分号不能截断元组', () => {
    // ★ 抽取器自己的自检 —— 否则"抽取器恒返回全集"会让第 1/3 条永远绿。
    const one = extractSeededFlags(
      "INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES\n" +
      "  ('a.enabled', '1', 'x');\n"
    );
    assert.equal(one.size, 1, '合成基线只有 1 行, 抽取器却报出多行');
    assert.ok(one.has('a.enabled'));
    assert.ok(!one.has('b.enabled'), '不存在的 key 不该被抽出来');

    // ★ 描述字段里**有**分号 (mcp_write 那条真实 seed 就是) —— 按 ';' 切语句
    //   的实现会在这里把元组截断, 导致 mcp_write.enabled 漏检。
    const two = extractSeededFlags(
      "INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES\n" +
      "  ('a.enabled', '1', '描述里有分号; 也不能截断'),\n" +
      "  ('b.enabled', '1', '普通');\n"
    );
    assert.equal(two.size, 2, '描述里的分号不该把元组截断');
    assert.ok(two.has('b.enabled'), '分号之后的元组必须照样抽得到');
    assert.equal(two.get('a.enabled'), '1');
  });
});
