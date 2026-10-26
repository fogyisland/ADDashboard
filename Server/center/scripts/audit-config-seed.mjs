// 诊断: 对比 baseline seed 值 vs 真库现值, 找出存量库缺哪些键 / 值不一致哪些键。
// 只读, 不写库。不打印任何凭据 (system_config 里可能有 ad_bind_password 等,
// 一律只打印"存在/缺失", 绝不打印 config_value)。

import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const CONFIG_PATH = resolve('appsettings.json');

// ---- 1. 从 baseline 解析 seed 值 ----
function parseMssqlSeeds() {
  const p = 'D:/dashboard/db/migrations/mssql/1.0.0-baseline.sql';
  const txt = readFileSync(p, 'utf8');
  const out = new Map();
  // baseline 的 system_config seed 形如 ('key', 'value', 'description'),
  // 跨行, 一行一条。用行扫描 + 括号深度跟踪。
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*\('([a-z0-9_]+)',\s*'((?:[^']|'')*)'/i.exec(line);
    if (m) out.set(m[1], m[2].replace(/''/g, "'"));
  }
  return out;
}

const baselineSeeds = parseMssqlSeeds();
console.log(`baseline (mssql) 解析到 ${baselineSeeds.size} 条 system_config seed\n`);

// ---- 2. 读真库 ----
const { init, close } = await import('../src/db/index.js');
const { loadConfig } = await import('../src/config.js');
const db = await init(loadConfig(CONFIG_PATH), { bootstrapMigrations: async () => {} });

// 敏感键: 只报存在性, 不报值
const SENSITIVE = /password|secret|token|bind_dn|_to$|_cc$/i;

try {
  const sql = db.dialect === 'mssql'
    ? `SELECT [config_key], [config_value], [description] FROM system_config ORDER BY [config_key]`
    : 'SELECT `config_key`, `config_value`, `description` FROM system_config ORDER BY `config_key`';
  const r = await db.query(sql, []);
  const rows = r?.rows ?? [];
  const live = new Map(rows.map((x) => [x.config_key, x.config_value]));

  console.log(`真库现有 ${live.size} 条\n`);
  console.log('=== A. 库里有、baseline 没有 (baseline 缺 seed) ===');
  const onlyLive = [...live.keys()].filter((k) => !baselineSeeds.has(k)).sort();
  if (onlyLive.length === 0) console.log('  (无)');
  else onlyLive.forEach((k) => console.log(`  ${k}${SENSITIVE.test(k) ? '  [敏感, 值不回显]' : `  = ${live.get(k)}`}`));

  console.log('\n=== B. baseline 有、库里缺 (需回填) ===');
  const onlyBase = [...baselineSeeds.keys()].filter((k) => !live.has(k)).sort();
  if (onlyBase.length === 0) console.log('  (无)');
  else onlyBase.forEach((k) => console.log(`  ${k}  baseline=${baselineSeeds.get(k)}${SENSITIVE.test(k) ? '  [敏感, 值不回显]' : ''}`));

  console.log('\n=== C. 两侧都有但值不同 ===');
  const diff = [...baselineSeeds.keys()].filter(
    (k) => live.has(k) && String(live.get(k)) !== String(baselineSeeds.get(k))
  ).sort();
  if (diff.length === 0) console.log('  (无)');
  else diff.forEach((k) => {
    const l = String(live.get(k)); const b = String(baselineSeeds.get(k));
    console.log(`  ${k}`);
    if (SENSITIVE.test(k)) console.log(`      库=${SENSITIVE.test(k) ? '[不回显]' : l}  baseline=${b}`);
    else console.log(`      库=${l}   baseline=${b}`);
  });

  console.log(`\n=== 汇总: 缺 ${onlyBase.length} 键, 值不同 ${diff.length} 键, baseline 缺 seed ${onlyLive.length} 键 ===`);
} finally {
  await close();
}