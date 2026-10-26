// 发布同步: D:\dashboard\ → D:\Implementation\Server\
// 严格按 PUBLISH-REPORT.txt 的 1:1 规则。
// ⚠ 本文件是"发布时哪些路径不带走"的唯一定义处。
//   scripts/audit/diff-mirrors.mjs 做镜像漂移检测时按同类规则判定, 改这里
//   必须同步确认那边, 否则"盘点说该发"但"同步没发", 或者反过来。
//
// R160 审计修复 (2026-10-25):
//
//   F1 — 源目录不存在时, 旧实现 walk() 的 `catch { return out; }` 把错误吞成
//        "0 个文件" ⇒ 复制 0 个、失败 0 个、复核 0 个 ⇒ 最后打印 **SYNC OK**。
//        源树被改名/没挂载/盘符没映射 都会走到这条路径 —— 操作员看到
//        "SYNC OK" 就以为发布成功, 实际一个字节都没发过去。
//        现在: 源不存在 ⇒ 明确报错 + exit 2; 遍历中途某个子目录读不到 ⇒
//        计入 unreadable 并让整体失败。
//
//   F2 — 旧实现无论成败都 **exit 0**。CI / 上层脚本看到 exit 0 就当发布成功。
//        现在失败 ⇒ exit 1。
//
//   F3 — 旧实现 hash() 读不到文件时返回 null, 而 `hash(s) === hash(d)` 在
//        两边都读不到时 (null === null) 为真 ⇒ 一个**根本没法读**的文件
//        被判成"已一致跳过"。现在 null 哈希一律当作"必须复制", 让
//        copyFileSync 去报真实的错误。
import { readdirSync, existsSync, mkdirSync, copyFileSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const SRC = 'D:/dashboard';
const DST = 'D:/Implementation/Server';

const EXCLUDE_DIR = new Set([
  'node_modules', '.scratch', '.git', '.backups', '.backup',
  'data', 'logs', 'Logs', 'APP', 'FEATURE', 'tmp', '.tmp',
  'tests',
]);
const EXCLUDE_FILE = new Set(['.env']);
const EXCLUDE_EXT = new Set(['.log', '.pid', '.tmp']);
const isBackupPath = (rel) => /(^|[\\/])\.backup[\\/]/.test(rel) || /(^|[\\/])backup[\\/]/i.test(rel);

// 遍历时读不到的目录 —— 记下来, 最后让整次同步判失败 (F1)。
const unreadable = [];

function walk(root, cur = root, out = []) {
  let ents;
  try {
    ents = readdirSync(cur, { withFileTypes: true });
  } catch (e) {
    unreadable.push(relative(root, cur) || '.' + '  ->  ' + String(e.message || e).slice(0, 120));
    return out;
  }
  for (const e of ents) {
    const full = join(cur, e.name);
    const rel = relative(root, full);
    if (isBackupPath(rel)) continue;
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name) || EXCLUDE_FILE.has(e.name)) continue;
      walk(root, full, out);
    } else {
      if (EXCLUDE_FILE.has(e.name)) continue;
      if (EXCLUDE_EXT.has(e.name.split('.').pop()?.toLowerCase())) continue;
      out.push(rel);
    }
  }
  return out;
}

const hash = (p) => { try { return createHash('sha1').update(readFileSync(p)).digest('hex'); } catch { return null; } };

// ---- 前置检查: 源目录必须存在且是目录 (F1) --------------------------------
if (!existsSync(SRC)) {
  console.error(`[publish-sync] FATAL: source directory '${SRC}' does not exist — nothing was synced.`);
  console.error('[publish-sync]        Check the drive mapping / the source tree path before re-running.');
  process.exit(2);
}
try {
  if (!statSync(SRC).isDirectory()) {
    console.error(`[publish-sync] FATAL: source path '${SRC}' is not a directory — nothing was synced.`);
    process.exit(2);
  }
} catch (e) {
  console.error(`[publish-sync] FATAL: cannot stat source '${SRC}': ${String(e.message || e)}`);
  process.exit(2);
}

const files = walk(SRC);
console.log('源文件数 (排除后) =', files.length, '\n');

let copied = 0, skipped = 0, failed = 0;
const failedList = [];

for (const rel of files) {
  const s = join(SRC, rel);
  const d = join(DST, rel);
  try {
    // F3: 源哈希读不到 (null) 时**不能**判成"已一致" —— 那会让一个
    // 根本没法读的文件被静默跳过。null ⇒ 走复制分支, 让 copyFileSync
    // 报出真实的错误。
    const srcHash = hash(s);
    if (srcHash !== null && existsSync(d) && srcHash === hash(d)) { skipped++; continue; }
    const dd = dirname(d);
    if (!existsSync(dd)) mkdirSync(dd, { recursive: true });
    copyFileSync(s, d);
    copied++;
  } catch (e) {
    failed++;
    failedList.push(rel + '  ->  ' + String(e.message || e).slice(0, 120));
  }
}

console.log('=== 同步结果 ===');
console.log('  已复制/覆盖 =', copied);
console.log('  已一致跳过 =', skipped);
console.log('  失败       =', failed);
for (const f of failedList.slice(0, 20)) console.log('    ✗ ' + f);
if (unreadable.length > 0) {
  console.log('  读不到的目录 =', unreadable.length);
  for (const u of unreadable.slice(0, 20)) console.log('    ✗ ' + u);
}

// 反证: 同步后目标应与源的 sha1 完全吻合
console.log('\n=== 反证: 逐文件 sha1 复核 ===');
let mismatch = 0, checked = 0;
for (const rel of files) {
  const s = join(SRC, rel), d = join(DST, rel);
  if (!existsSync(d)) { mismatch++; console.log('  ✗ 缺失 ' + rel); continue; }
  if (hash(s) !== hash(d)) { mismatch++; if (mismatch <= 10) console.log('  ✗ 不一致 ' + rel); }
  checked++;
}
console.log('  已复核 =', checked, ' 不一致 =', mismatch);

// F2: 失败必须让进程以非零码退出 —— 否则上层脚本/CI 只看 exit code,
//     "SYNC HAS PROBLEM" 这行字会被完全忽略。
const ok = (failed === 0 && mismatch === 0 && unreadable.length === 0);
console.log('\n' + (ok ? 'SYNC OK' : 'SYNC HAS PROBLEM'));
if (!ok) {
  if (unreadable.length > 0) console.error(`[publish-sync] ${unreadable.length} directory(ies) could not be read — the sync is INCOMPLETE.`);
  if (failed > 0) console.error(`[publish-sync] ${failed} file(s) failed to copy — the sync is INCOMPLETE.`);
  if (mismatch > 0) console.error(`[publish-sync] ${mismatch} file(s) do not match the source after the copy — the sync is INCOMPLETE.`);
  process.exit(1);
}
process.exit(0);