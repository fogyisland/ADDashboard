// R161.31 反证脚本 — 证明三个同族表的 status_code 确实装不下真实 Windows 错误码。
//
// ★ 只做 INSERT, 且**显式回滚** (事务 ROLLBACK) ⇒ 不留任何数据。
// ★ 目的: 用真实驱动的错误信息证明"必须加宽", 而不是靠推断。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(HERE, '..');

const cfg = JSON.parse(readFileSync(resolve(CENTER_ROOT, 'appsettings.json'), 'utf8'));
const dialect = cfg.db.dialect;
const connCfg = { ...cfg.db[dialect] };

const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: connCfg.host, port: connCfg.port ?? 3306,
  user: connCfg.user, password: connCfg.password, database: connCfg.database
});

/** 用真实驱动路径 (pool.query, 无绑定参数) 试写一行, 返回错误信息或 null。 */
async function tryInsert(table, statusCode) {
  const sql =
    `INSERT INTO ${table} ` +
    '(local_dc, peer_dc, naming_context, status_code, last_success_time, last_attempt_time, error_message) ' +
    "VALUES ('__probe_local__', '__probe_peer__', '__probe_ctx__', ?, NULL, UTC_TIMESTAMP(), NULL)";
  try {
    const [rows] = await pool.query(sql, [statusCode]);
    return { ok: true, affected: rows?.affectedRows ?? 0 };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

const conn = await pool.getConnection();
let pass = 0;
let fail = 0;

function assertTrue(cond, msg) {
  if (cond) { pass += 1; console.log(`  ✔ ${msg}`); }
  else { fail += 1; console.log(`  ✘ ${msg}`); }
}

try {
  await conn.beginTransaction();

  // ---- 1. 三个同族表装不下 1398 (真实库里 ad_replication_status 里的值) ----
  for (const table of ['ad_dc_inbound_partners', 'ad_dc_outbound_partners']) {
    console.log(`\n[1] ${table} 写 status_code=1398 (真实错误码) 应被拒绝:`);
    const r = await tryInsert(table, 1398);
    assertTrue(!r.ok && String(r.message).includes('Out of range'),
      `拒绝写入并报 out-of-range (实际: ${r.ok ? '成功写入' : r.code + ' ' + r.message})`);
  }

  console.log('\n[1] ad_replication_probe_history 写 status_code=1398 应被拒绝:');
  {
    // ⚠ 列名必须跟基线一致: ad_replication_probe_history 用的是
    //   collected_at / attempt_at / result (不是 probe_time)。
    const sql =
      'INSERT INTO ad_replication_probe_history ' +
      '(collected_at, agent_id, source_dc, dest_dc, naming_context, attempt_at, result, status_code) ' +
      "VALUES (UTC_TIMESTAMP(3), '__probe_agent__', '__probe_local__', '__probe_peer__', '__probe_ctx__', UTC_TIMESTAMP(3), 'error', ?)";
    let rejected = false;
    let detail = '成功写入';
    try {
      const [rows] = await pool.query(sql, [1398]);
      detail = `成功写入 (affected=${rows?.affectedRows ?? 0})`;
    } catch (err) {
      rejected = String(err.message).includes('Out of range');
      detail = `${err.code} ${err.message}`;
    }
    assertTrue(rejected, `拒绝写入并报 out-of-range (实际: ${detail})`);
  }

  // ---- 2. 对照: 小值能写进去 (证明列本身可用, 问题只在值域) ----
  console.log('\n[2] 对照组: status_code=0 应能写进去 (证明问题只在值域不在列本身):');
  {
    const r = await tryInsert('ad_dc_inbound_partners', 0);
    assertTrue(r.ok, `status_code=0 写入成功 (实际: ${r.ok ? 'ok' : r.code + ' ' + r.message})`);
  }

  // ---- 3. 迁移后应能写进去 (迁移跑过之后) ----
  console.log('\n[3] 迁移生效后 (列已是 int) status_code=1398 应能写进去:');
  {
    const [cols] = await pool.query(
      'SELECT DATA_TYPE FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      ['ad_dc_inbound_partners', 'status_code']
    );
    const dataType = cols[0]?.DATA_TYPE;
    if (dataType === 'int') {
      const r = await tryInsert('ad_dc_inbound_partners', 1398);
      assertTrue(r.ok, `列已是 int ⇒ 写入成功 (实际: ${r.ok ? 'ok' : r.code + ' ' + r.message})`);
    } else {
      console.log(`  ⓘ 列当前是 ${dataType} (未迁移) ⇒ 跳过 (迁移生效后重跑本脚本可验证)`);
    }
  }
} finally {
  await conn.rollback();
  conn.release();
  await pool.end();
}

console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
