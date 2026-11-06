// center/scripts/migrate-config-seed.mjs
// R158.dbparity-migrate (2026-10-22) — 存量库补 baseline seed.
//
// === 为什么需要 ===
// baseline 的 seed 一律是 "只在键不存在时插入" (MySQL INSERT IGNORE /
// MSSQL IF NOT EXISTS), **不覆盖已有行** —— 这是刻意的 (别抹掉操作员配置)。
// 代价是: 上线新 baseline 后, 存量库拿不到新 seed。
//
// === 本脚本只做 3 件事, 刻意不做的更多 ===
//   1. 回填**缺失**的键 (本机实测缺 2 个: agent_upgrade_canary_ratio /
//      agent_upgrade_rollout_strategy)
//   2. 把 email_enabled / history_enabled 置 0
//      (操作员 directive 2026-10-22: "邮件不自动开启, 历史也不自动开启")
//   3. 回填后逐条回读校验
//
// === 刻意不覆盖已有值 ——
//
//   本机审计发现 4 个键库值 ≠ baseline 值, 但**不是漂移, 是操作员有意配的**:
//     access_domain            = dashboard.shaphar.net   (部署地址)
//     discovery_interval_hours = 1 (baseline 4)           (调优过的发现周期)
//     ad_notify_body_template  = 详细模板 (baseline 是简版)
//     ad_notify_subject_template = 带 target_dc 的模板
//   把 baseline 值盖回去 = 用模板覆盖生产配置, 且这 4 项上 baseline 才是
//   "过时"的一方 (baseline 里 access_domain 是空串 —— 它根本不知道部署地址)。
//
//   因此: **只对显式列出的键动手, 其余一律不碰。** 脚本会打印"库值≠baseline"
//   的键供人工判断, 但绝不自动覆盖。
//
// === 幂等 ===
//   重复执行安全: 缺失键回填后不再缺失; 两个开关已是 0 时跳过。
//
// 用法 (center/ 下):
//   node scripts/migrate-config-seed.mjs --dry-run
//   node scripts/migrate-config-seed.mjs
//
// 默认 --dry-run: 这是改生产数据的脚本。

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIG_PATH = resolve(
  process.argv.find((a) => a.startsWith('--config='))?.slice('--config='.length) ||
  'appsettings.json'
);

// 操作员 directive 2026-10-22: 这两个开关一律关掉。
//   email_enabled=1 → 不入 outbox + 不发 SMTP (邮件不自动开)
//   history_enabled=1 → 继续 append ad_replication_history (历史不自动开)
const FORCE_TO = Object.freeze({
  email_enabled: '0',
  history_enabled: '0'
});

const DESC = Object.freeze({
  agent_upgrade_rollout_strategy:
    'Agent 升级发布策略: full=全量放行 / canary=按比例灰度 / paused=熔断停发。缺行或非法值按 full 处理',
  agent_upgrade_canary_ratio:
    'canary 策略下的灰度比例 (0-100), 按 (上报版本+目标版本) 稳定哈希取桶判定。缺行按 100 处理'
});

// 值从 baseline 文件里取, 不在本脚本硬编码 —— 两库同源, 免得手抄走样。
function loadMssqlSeeds() {
  const p = 'D:/dashboard/db/migrations/mssql/1.0.0-baseline.sql';
  const txt = readFileSync(p, 'utf8');
  const out = new Map();
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*\('([a-z0-9_]+)',\s*'((?:[^']|'')*)'/i.exec(line);
    if (m) out.set(m[1], m[2].replace(/''/g, "'"));
  }
  return out;
}

const SEEDS = loadMssqlSeeds();

function sqlFor(dialect) {
  return dialect === 'mssql' ? {
    list: `SELECT [config_key], [config_value] FROM system_config`,
    // MSSQL: MERGE 无 WHEN MATCHED 分支 = 已存在则彻底 no-op。
    // CAST 必需: mssql@11 对嵌套 MERGE 不做类型推断 (drivers/mssql.js:25)。
    upsert: `MERGE INTO system_config AS t
      USING (SELECT CAST(? AS NVARCHAR(64)) AS config_key,
                    CAST(? AS NVARCHAR(MAX)) AS config_value,
                    CAST(? AS NVARCHAR(256)) AS description,
                    CAST(? AS NVARCHAR(64)) AS updated_by) AS s
      ON t.[config_key] = s.config_key
      WHEN NOT MATCHED THEN INSERT ([config_key], [config_value], [description], [updated_by])
      VALUES (s.config_key, s.config_value, s.description, s.updated_by);`
  } : {
    list: 'SELECT `config_key`, `config_value` FROM system_config',
    upsert: `INSERT INTO system_config (config_key, config_value, description, updated_by)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE config_key = config_key`
  };
}

async function main() {
  const { init, close } = await import('../src/db/index.js');
  const { loadConfig } = await import('../src/config.js');
  const db = await init(loadConfig(CONFIG_PATH), { bootstrapMigrations: async () => {} });
  const S = sqlFor(db.dialect);

  let inserted = 0;
  let updated = 0;

  try {
    const r = await db.query(S.list, []);
    const live = new Map((r?.rows ?? []).map((x) => [x.config_key, x.config_value]));

    // ---- 1. 回填缺失键 ----
    const missing = [...SEEDS.keys()].filter((k) => !live.has(k)).sort();
    console.log(`\n=== 1. 回填缺失键 (${missing.length} 个) ===`);
    if (missing.length === 0) console.log('  (无)');
    for (const k of missing) {
      const v = SEEDS.get(k);
      console.log(`  ${k} = ${v}`);
      if (!DRY_RUN) {
        // key 已存在 = 别人刚建了 (并发), no-op upsert 天然幂等
        await db.query(S.upsert, [k, v, DESC[k] || '', 'seed-migrate']);
        inserted++;
      }
    }

    // ---- 2. 强制两个开关为 0 ----
    console.log(`\n=== 2. 开关置 0 (操作员 directive) ===`);
    for (const [k, want] of Object.entries(FORCE_TO)) {
      const cur = live.get(k);
      if (cur === undefined) {
        console.log(`  ${k}: 键不存在 → 按 ${want} 插入`);
        if (!DRY_RUN) {
          await db.query(S.upsert, [k, want, '', 'seed-migrate']);
          inserted++;
        }
      } else if (String(cur) === want) {
        console.log(`  ${k}: 已是 ${want}, 跳过`);
      } else {
        console.log(`  ${k}: ${cur} → ${want}  ${DRY_RUN ? '(dry-run)' : ''}`);
        if (!DRY_RUN) {
          // 这 2 个键是**有意**改值, 不是回填 —— 必须真 UPDATE。
          // 且加 WHERE 限定旧值, 防并发下把别人的改动盖回去。
          const upd = db.dialect === 'mssql'
            ? `UPDATE system_config SET [config_value] = ?, [updated_at] = SYSUTCDATETIME(), [updated_by] = ? WHERE [config_key] = ? AND [config_value] <> ?`
            : 'UPDATE system_config SET `config_value` = ?, `updated_at` = CURRENT_TIMESTAMP, `updated_by` = ? WHERE `config_key` = ? AND `config_value` <> ?';
          await db.query(upd, [want, 'seed-migrate', k, want]);
          updated++;
        }
      }
    }

    // ---- 3. 只报告不修改 ----
    const drift = [...SEEDS.keys()].filter(
      (k) => live.has(k) && !FORCE_TO[k] && String(live.get(k)) !== String(SEEDS.get(k))
    ).sort();
    console.log(`\n=== 3. 库值≠baseline 值 (仅报告, **不修改**) ===`);
    if (drift.length === 0) console.log('  (无)');
    else drift.forEach((k) => {
      console.log(`  ${k}`);
      console.log(`      库=${live.get(k)}`);
      console.log(`      baseline=${SEEDS.get(k)}`);
    });
    console.log(`  → 这些多为操作员有意配置 (部署地址/调优参数/自定义模板),`);
    console.log(`    刻意不覆盖。如确需对齐 baseline, 请人工确认后手工改。`);

    // ---- 4. 回读校验 ----
    if (DRY_RUN) {
      console.log(`\n--dry-run: 未写入任何数据。去掉 flag 执行。`);
    } else {
      const r2 = await db.query(S.list, []);
      const after = new Map((r2?.rows ?? []).map((x) => [x.config_key, x.config_value]));
      console.log(`\n=== 4. 回读校验 ===`);
      let bad = 0;
      for (const k of missing) {
        const ok = after.has(k);
        if (!ok) bad++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k} 已存在`);
      }
      for (const [k, want] of Object.entries(FORCE_TO)) {
        const got = String(after.get(k));
        const ok = got === want;
        if (!ok) bad++;
        console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k} = ${got} (期望 ${want})`);
      }
      console.log(`\n插入 ${inserted} 行, 更新 ${updated} 行, 校验失败 ${bad} 项`);
      if (bad > 0) process.exitCode = 1;
    }
  } finally {
    await close();
  }
}

main().catch((e) => { console.error(`FAIL: ${e?.message || e}`); process.exit(1); });