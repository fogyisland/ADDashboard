// center/scripts/backfill-install-anchor.mjs
// R158.Trial-anchor (2026-10-22) — 存量部署补写 install_anchor 行.
//
// 用途: 上线本特性之前就已部署的中心, DB 里没有 install_anchor 行, 而
// appsettings.json 已有 installedAt (试用可能已用了 20 天)。首次启动时
// applyInstallAnchor 会用**当前**文件日期建锚 —— 对这类机器没问题 (文件日期
// 就是真实安装日期), 但 operator 显式跑一次本脚本更可控: 能看到每台机补了什么。
//
// 语义 (操作员 directive 2026-10-22 "现有部署计算后填入就好了"):
//   at      = 现有 appsettings.json.installedAt —— **不重置**试用, 存量机保持原样。
//   machine = 本机 MAC                            —— 诊断用, 非秘密。
//   h       = HMAC(本机 signature, at|sig|machine) —— 立即算出并写入。
//
//   **signature 本身不入库。** 它是 HMAC 密钥, 与被保护数据同存 = 机制归零。
//   (有 DB 读权限者拿到 sig 即可伪造任意合法锚点。) 详见 install-anchor.js 头注释。
//
// 幂等: 已有 install_anchor 行时跳过并报 skipped, **不覆盖**
//   (覆盖 = 把篡改/过期痕迹洗掉, 与 applyInstallAnchor 的策略一致)。
//
// 用法 (在 center/ 目录下):
//   node scripts/backfill-install-anchor.mjs --dry-run
//   node scripts/backfill-install-anchor.mjs
//
// --dry-run 只打印将要写什么, 不碰 DB。默认 dry-run —— 这是改生产数据的脚本,
// 不该因为操作员忘了加 flag 就直接落库。

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ANCHOR_KEY,
  buildAnchorValue,
  parseAnchorValue,
  primaryMac
} from '../src/services/install-anchor.js';
import { readInstalledAt, readSignature } from '../src/services/license-validator.js';
import { installAnchorSql } from '../src/db/sql/install-anchor.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CONFIG_PATH = resolve(
  args.find((a) => a.startsWith('--config='))?.slice('--config='.length) ||
  'appsettings.json'
);

async function main() {
  // ---- 1. 读本地配置 ----
  if (!existsSync(CONFIG_PATH)) {
    console.error(`FAIL: appsettings not found: ${CONFIG_PATH}`);
    console.error('      init wizard 还没跑完时不存在该文件, 此时也不该有存量数据。');
    process.exit(1);
  }
  const installedAt = readInstalledAt(CONFIG_PATH);
  const signature = readSignature(CONFIG_PATH);

  // signature 就是 HMAC 密钥 —— **一行都不回显**, 连掩码/长度都不给。
  // 它同时是 license-codec 的签名材料: 泄漏 = 锚点可伪造 + license 申请单可伪造。
  // 只需知道"在不在", 不需要知道是什么。
  const sigStatus = signature ? '存在 (不回显)' : '(缺)';

  console.log(`config     : ${CONFIG_PATH}`);
  console.log(`installedAt: ${installedAt ?? '(缺)'}`);
  console.log(`signature  : ${sigStatus}`);
  console.log(`mac        : ${primaryMac() || '(取不到, 用空串)'}`);

  if (!installedAt || !signature) {
    console.error('\nFAIL: installedAt 或 signature 缺失, 无法计算锚点。');
    console.error('      缺 signature 时应先跑 server.js 的一次正常启动');
    console.error('      (ensureSignatureAndInstalledAt 会幂等补写), 再重跑本脚本。');
    process.exit(1);
  }

  const mac = primaryMac();
  const value = buildAnchorValue({ at: installedAt, sig: signature, mac });

  // 自检: 算出来的值必须能通过自己的验签 —— 否则写进去的是一行永远
  // 被判 tampered 的垃圾, 且因为"不覆盖"策略永远修不好。
  const selfCheck = parseAnchorValue(value, signature);
  if (!selfCheck.ok) {
    console.error(`\nFAIL: 自检未通过 (${selfCheck.reason}) — 拒绝写入。`);
    process.exit(1);
  }

  console.log('\n将要写入的 install_anchor 行:');
  console.log(`  at  = ${installedAt}   (沿用现有安装日期, 不重置试用)`);
  console.log(`  sig = 存在 (不回显)`);
  console.log(`  h   = ${selfCheck.ok ? 'HMAC 自检通过' : '自检失败'}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: 未连接数据库, 未做任何写入。去掉该 flag 执行。');
    return;
  }

  // ---- 2. 连 DB ----
  // db 模块从 appsettings.json 读连接配置, init() 会做 dialect probe。
  const { init, close } = await import('../src/db/index.js');
  const { loadConfig } = await import('../src/config.js');
  const cfg = loadConfig(CONFIG_PATH);
  // opts.bootstrapMigrations 是**测试注入的函数**, 不是布尔开关 (db/index.js:105
  // `opts.bootstrapMigrations ?? <真实 bootstrap>`)。传 false 会让 doBootstrap
  // 变成 false, 随后 `await doBootstrap(...)` 抛 "doBootstrap is not a function"。
  // 本脚本只写一行 system_config, 不该触发 schema bootstrap → 传 no-op。
  const db = await init(cfg, { bootstrapMigrations: async () => {} });

  try {
    const sql = installAnchorSql[db.dialect];
    const existing = await db.query(sql.getAnchor, [ANCHOR_KEY]);
    const rows = existing?.rows;

    if (Array.isArray(rows) && rows.length > 0) {
      // 已有行: 只做验签诊断, 绝不覆盖。
      const parsed = parseAnchorValue(rows[0]?.config_value, signature);
      if (parsed.ok) {
        console.log(`\nskipped: 已有 install_anchor 行且验签通过 (at=${parsed.at}) — 未改动。`);
      } else {
        console.log(`\nskipped: 已有 install_anchor 行但验签失败 (${parsed.reason}) — 未改动。`);
        console.log('        这是篡改迹象, 本脚本刻意不覆盖。要恢复请人工核对后再处理。');
      }
      return;
    }

    await db.query(sql.insertAnchorIfAbsent, [
      ANCHOR_KEY,
      value,
      '安装锚点 — 安装日期 + 本机 signature 的 HMAC, 防重装重置试用期',
      'install-anchor-backfill'
    ]);

    const verify = await db.query(sql.getAnchor, [ANCHOR_KEY]);
    const parsed = parseAnchorValue(verify?.rows?.[0]?.config_value, signature);
    if (!parsed.ok) {
      console.error(`\nWARN: 已写入但回读验签失败 (${parsed.reason}) — 请人工检查。`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nOK: install_anchor 已写入并验签通过 (at=${parsed.at})。`);
    console.log('    试用日期沿用原值, 未重置。');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err?.message || err}`);
  process.exit(1);
});