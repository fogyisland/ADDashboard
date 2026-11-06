// 回填 1 行 ad_license_request —— 已激活的 base32 申请单。
//
// 为什么需要: 那次激活 (2026-10-22) 时, activate handler 里的
// `licenseRequestSql` import 还没落进运行的文件 (2026-10-23 17:22 才写进去),
// 所以 insert 和 markActivated 都静默失败 → ad_license_request 0 行。
// 结果: 申请单列表恒显「未激活」, 「激活后隐藏」功能过滤不到任何东西。
//
// ⭐ 键路线的修正 (与最初的设想不同):
//   最初想按 ad_system_registration.license_request_id 反推, 但实测**该列 3 行全 NULL**
//   —— activate handler 的 INSERT 显式传了 null (system-settings-v2.js:576:
//   `'base32', null, jsonPath`, 位置对齐 license_request_id)。
//   改用 request_json_path: saveLicenseRequest 的落盘命名是
//   `<requestId>.json` (license-request-store.js:45), 所以
//   **request_id === basename(json_path) 去扩展名**, 无歧义、可逆, 不猜。
//
// 值全部来自真实来源, 0 造值:
//   request_id / company / mac_address / months / max_nodes / installed_at
//     / signature / instance_id  ← 落盘 JSON (buildLicenseRequest 的 wire shape)
//   kind / json_path              ← ad_system_registration.license_kind / request_json_path
//   activated_at / license_id     ← ad_system_registration.activated_at / id
//
// ⚠ 幂等: 先查重再插。重复跑不会产生第 2 行。
// ⚠ 只回填 status='active' 且 json 文件仍在磁盘上的行 —— id=2 (10-15, months=12)
//   的 json 已被我们按操作员 directive 删掉备份, 文件不存在, 无法回填 (也不该回填:
//   那份是 12 年口径的申请单, 早已撤销)。
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenseRequest as licenseRequestSql } from '../src/db/sql/license-request.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dbIdx = await import('../src/db/index.js');
const { loadConfig } = await import('../src/config.js');

const cfgPath = [join(root, 'appsettings.json'), join(join(root, '..'), 'appsettings.json')].find(existsSync);
const cfg = loadConfig(cfgPath);
await dbIdx.init(cfg);
const db = dbIdx.getDb();
const dialect = db.dialect;

let fail = 0;
const ok = (n, c, x = '') => { c ? console.log('  OK   ' + n) : (fail++, console.log('  FAIL ' + n + (x ? '  -> ' + x : ''))); };

// 只回填 active 行
const regs = (await db.query(
  `SELECT id, status, license_kind, request_json_path, activated_at
     FROM ad_system_registration
    WHERE status = 'active' AND license_kind = 'base32' AND request_json_path IS NOT NULL
    ORDER BY id`, [])).rows || [];

console.log('候选回填行 (status=active + license_kind=base32 + 有 json_path) =', regs.length);
ok('至少有 1 个候选', regs.length > 0);

const inserted = [];

for (const reg of regs) {
  const jsonPath = reg.request_json_path;
  console.log('\n=== 注册行 id=' + reg.id + ' ===');
  console.log('  json_path = ' + jsonPath);

  if (!existsSync(jsonPath)) {
    console.log('  跳过: 落盘 JSON 不在磁盘上 (拿不到字段, 不造值)');
    continue;
  }

  // request_id 从文件名反解 (license-request-store.js:45 的命名契约)
  const requestId = basename(jsonPath).replace(/\.json$/i, '');
  console.log('  request_id (由文件名反解) = ' + requestId);

  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));

  // 字段完整性检查 —— 任一 NOT NULL 列缺失就不插 (宁可不动也不要插半截行)
  const need = ['company', 'mac_address', 'months', 'max_nodes', 'installed_at', 'signature', 'instance_id'];
  const missing = need.filter(k => raw[k] === undefined || raw[k] === null || raw[k] === '');
  if (missing.length) {
    fail++;
    console.log('  跳过: JSON 缺字段 ' + missing.join(',') + ' (NOT NULL 列, 不插半截行)');
    continue;
  }
  ok('  JSON 8 字段齐全 (含 6 个 NOT NULL)', true);
  console.log('  months=' + raw.months + ' max_nodes=' + raw.max_nodes
    + ' company=' + raw.company + ' (signature 有值, 长度' + String(raw.signature).length + ', 不打印)');

  // 幂等查重
  const dupe = (await db.query(licenseRequestSql[dialect].findById, [requestId])).rows || [];
  if (dupe.length) {
    ok('  已存在, 跳过 (幂等)', true);
    console.log('    已有行 id=' + dupe[0].id + ' activated_at=' + dupe[0].activated_at
      + ' license_id=' + dupe[0].license_id);
    continue;
  }
  console.log('  查重: 无现有行 → 执行 INSERT');

  // 走与 activate handler 完全相同的 helper (1:1 平行, 不自己拼 SQL)
  const r = await db.execute(licenseRequestSql[dialect].insert, [
    requestId, raw.company, raw.mac_address, Number(raw.months), Number(raw.max_nodes),
    raw.installed_at, raw.signature, raw.instance_id,
    reg.license_kind, jsonPath
  ]);
  const newId = r?.recordset?.[0]?.id || r?.insertId || null;
  ok('  INSERT 成功, 新行 id=' + newId, newId !== null);
  inserted.push({ newId, requestId });

  // ⭐ 再走 markActivated —— 跟 activate handler 同一条路径, 保证 activated_at / license_id
  //   由生产 helper 写入, 0 手写 UPDATE 绕开既有逻辑。
  await db.execute(licenseRequestSql[dialect].markActivated, [reg.id, requestId]);
  ok('  markActivated 已执行 (license_id=' + reg.id + ')', true);
}

console.log('\n=== 回填后核对 ===');
const final = (await db.query(`SELECT id, request_id, company, months, max_nodes, kind,
                                      activated_at, license_id, json_path
                                 FROM ad_license_request ORDER BY id`, [])).rows || [];
console.log('ad_license_request 总行数 =', final.length);
for (const r of final) {
  console.log('  id=' + r.id + ' request_id=' + r.request_id + ' company=' + r.company
    + ' months=' + r.months + ' max_nodes=' + r.max_nodes + ' kind=' + r.kind);
  console.log('    activated_at=' + r.activated_at + '  license_id=' + r.license_id);
  // ⭐ 反证: activated_at 必须非空, 否则「激活后隐藏」依然过滤不到
  ok('  id=' + r.id + ' activated_at 非空 (隐藏功能的过滤依据)', !!r.activated_at);
  // ⚠ 断言自己写错过一次 (lesson 163): MSSQL 驱动把 bigint 列 (id / license_id)
  //   以 **string** 返回 (typeof === 'string'), 所以 `license_id === 3` 恒假。
  //   必须 Number() 归一后再比。数据本身是对的。
  ok('  id=' + r.id + ' license_id 指向真实注册行', Number(r.license_id) === 3,
     'license_id=' + r.license_id + ' (typeof ' + typeof r.license_id + ')');
}
ok('回填产生了行 (预期 1)', final.length >= 1, 'rows=' + final.length);

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'HAS FAILURE') + '  ' + fail + ' failed');
console.log('本次插入 ' + inserted.length + ' 行: ' + (inserted.map(x => x.requestId).join(', ') || '(无)'));
process.exit(fail === 0 ? 0 : 1);