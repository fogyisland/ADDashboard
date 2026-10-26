// Standalone orchestrator — spawn child node --test directly, capture stdout
// as TAP via stream events.
//
// Why not run() API: run({ files: [...] }) spawns the child with a sanitized
// PATH that does NOT include Git's usr/bin, so spawnSync('diff', ...) inside
// publish-mirror.test.js fails with ENOENT.
//
// Why not execFileSync with fd stdio: works standalone but when the
// orchestrator itself is launched under `node --test` (parent), Node's
// test runner recursion guard kicks in and skips grandchild test files
// entirely — they exit 0 with zero tests run. This is dangerous because
// orchestrator's "trusted exit-code" fallback would mask any real test
// failure as PASS.
//
// Therefore: top-level .mjs script (NOT a test file) using spawn() + pipe
// stdout chunks into an in-memory buffer. We also pipe child stdout to the
// orchestrator's own stdout so the operator sees the grandchild TAP output
// live in their terminal.
//
// HARD REQUIREMENT: this script MUST be run as a top-level process — NOT
// from inside a `node --test` parent. The code-quality-audit.test.js
// wrapper (R120 Task 13) inherits stdio so it sees the recursion guard
// warnings, but does NOT use `trusted exit-code` fallback. Instead it
// fails the parent test if the orchestrator reports any
// `tap-capture-empty` dimension — forcing the operator to run this
// script standalone (`node center/scripts/audit/run-all-dimensions.mjs`)
// for real validation.
//
// R161.3 (2026-10-25): the wrapper it refers to (code-quality-audit.test.js)
// was removed by the R161 test-file cleanup, so the "run standalone" rule
// above now stands on its own — there is no wrapper left that could trigger
// the recursion guard. Run this script directly.
//
// PATH augmentation: inject C:\Program Files\Git\usr\bin (where `diff` lives
// on Git for Windows installs) so the child can spawn `diff`.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const repoRoot = process.cwd();

// Git for Windows ships diff.exe at C:\Program Files\Git\usr\bin\diff.exe
// (verify via `cygpath -w /usr/bin`). Add it to PATH so child processes
// can spawnSync('diff', ...).
const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const augmentedEnv = {
  ...process.env,
  PATH: `${GIT_USR_BIN};${process.env.PATH || ''}`,
};

// R161.3 (2026-10-25) — 前 14 个维度的测试文件在 R161 的"清除测试文件"清理里
// 被删掉了。它们只存在于源树的 `center/tests/`, 而那个目录**不随交付包发布**
// (install-center.ps1 / upgrade-center.ps1 的 -Exclude 里都有 'tests')。
//
// 在此之前, 这个脚本本身却随包发布 (LinuxServer/center/scripts/audit/) ⇒
// 在**任何**一台机器上 (交付机没有 tests/, 源树的 tests/ 也已被清空) 都是
// 14/14 MISS 然后退出 1。一个只会误报的审计脚本比没有更糟 —— 它训练操作员
// 忽略审计输出。
//
// ⇒ 处置: ① 这些维度标成 retired (保留记录, 但不计入失败, 也不再去找文件);
//        ② 整个 center/scripts/audit/ 目录登记为 source-only, 不再发布
//           (见 Server/scripts/audit/check-linux-package-sync.mjs 的 ALLOWLIST)。
//
// retired 的语义: "这个维度曾经存在, 它的网被有意撤掉了"。不是"通过了",
// 也不是"失败了" —— 是"不再适用"。想复活某个维度, 把它的测试文件放回
// center/tests/ 并删掉这里的 retired 标记即可。
const RETIRED_REASON = 'R161 清理删除了该测试文件 (center/tests/ 不随交付包发布)';

const DIMENSIONS = [
  { id: 'static-scan',              file: 'center/tests/audit/static-scan.test.js',              task: 1,  retired: RETIRED_REASON },
  { id: 'tdz-safety',               file: 'center/tests/audit/tdz-safety.test.js',               task: 2,  retired: RETIRED_REASON },
  { id: 'async-safety',             file: 'center/tests/audit/async-safety.test.js',             task: 3,  retired: RETIRED_REASON },
  { id: 'silent-catch',             file: 'center/tests/audit/silent-catch.test.js',             task: 4,  retired: RETIRED_REASON },
  { id: 'module-logger-binding',    file: 'center/tests/audit/module-logger-binding.test.js',    task: 5,  retired: RETIRED_REASON },
  { id: 'hmac-signature-contract',  file: 'center/tests/audit/hmac-signature-contract.test.js',  task: 6,  retired: RETIRED_REASON },
  { id: 'dual-dialect',             file: 'center/tests/audit/dual-dialect.test.js',             task: 7,  retired: RETIRED_REASON },
  { id: 'publish-mirror',           file: 'center/tests/audit/publish-mirror.test.js',           task: 8,  retired: RETIRED_REASON },
  { id: 'boot-fingerprint-mirror',  file: 'center/tests/boot-version.test.js',                   task: 9,  retired: RETIRED_REASON },
  { id: 'middleware-chain-order',   file: 'center/tests/audit/middleware-chain-order.test.js',   task: 10, retired: RETIRED_REASON },
  { id: 'process-exit-cadence',     file: 'center/tests/audit/process-exit-cadence.test.js',     task: 11, retired: RETIRED_REASON },
  { id: 'error-coverage',           file: 'center/tests/audit/error-coverage.test.js',           task: 12, retired: RETIRED_REASON },
  { id: 'healthz-call-sites',       file: 'center/tests/audit/healthz-call-sites.test.js',       task: 13, retired: RETIRED_REASON },
  { id: 'agent-packages-no-userauth', file: 'center/tests/audit/agent-packages-no-userauth.test.js', task: 14, retired: RETIRED_REASON },
  // R161.3 — 新维度: 跨方言误用守卫 (check-dialect-compat.mjs) 的负向测试。
  //   放在 center/tests/ 顶层 (不是 center/tests/audit/) 是因为 center/package.json
  //   的 test 脚本 glob 里没有 tests/audit/ —— 放那儿 CI 根本不会跑; 而改
  //   package.json 的 glob 会改掉它的内容 ⇒ `.install-hash` 失配 ⇒ 目标机
  //   (常常离线) 删 node_modules 重跑 npm install ⇒ 装机报废。
  { id: 'dialect-compat',           file: 'center/tests/dialect-compat.test.js',                task: 15 },
  // R161.4 — 新维度: 基线幂等性守卫 (check-baseline-idempotency.mjs) 的负向测试。
  //   2026-10-25 操作员在 MySQL 上跑初始化向导报 `Duplicate column name 'task_id'`:
  //   根因 = 基线里同一张表同一列的 DDL 有两代, 旧代是**裸** ALTER (全新库一次过,
  //   重跑必炸), 而 init 向导的 POST /db/apply 每次都跑 applyAll() ⇒ 基线必须可重复执行。
  //   同样放 center/tests/ 顶层 (package.json 的 test glob 不含 tests/audit/, 且不能改它)。
  { id: 'baseline-idempotency',     file: 'center/tests/baseline-idempotency.test.js',          task: 16 },
  // R161.5 — 新维度: MySQL 5.7 兼容守卫 (check-mysql57-compat.mjs) 的负向测试。
  //   2026-10-26 操作员把库换成 MySQL 5.7.44 后一次暴露整族缺陷:
  //   CTE / 窗口函数 / ADD COLUMN IF NOT EXISTS 全是 MySQL 8.0+ 语法。
  //   根因 = 项目历史把 db.dialect 钉死在 'mssql' ⇒ MySQL 分支从未在生产跑过
  //   ⇒ 这些缺陷在 MSSQL 上完全看不出来 (同一份代码两段互不干扰)。
  //   与 dimension 15 (dialect-compat) 的分工: 15 管"对方方言的语法",
  //   17 管"同一方言的不同版本" —— MySQL 5.7 装不下 MySQL 8.0 的语法。
  { id: 'mysql57-compat',           file: 'center/tests/mysql57-compat.test.js',                task: 17 },
];

function runChild(absPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', absPath], {
      cwd: repoRoot,
      env: augmentedEnv,
      shell: false,
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    // Pipe grandchild TAP output to orchestrator's stdout so the operator
    // sees per-test pass/fail live even when the parent `node --test`
    // process tree is intercepting stdout buffers.
    child.stdout.on('data', (d) => {
      stdoutChunks.push(d);
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderrChunks.push(d);
      process.stderr.write(d);
    });
    child.on('error', (err) => resolve({
      code: -1,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8') + '\nspawn-error: ' + err.message,
    }));
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }));
  });
}

// Parse TAP output. node --test default reporter emits lines like:
//   ✔ name (duration_ms)
//   ✖ name (duration_ms)
//   ℹ tests N
//   ℹ pass N
//   ℹ fail N
function parseTapSummary(stdout) {
  let tests = 0, pass = 0, fail = 0;
  let firstFailName = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('✔')) tests++;
    else if (trimmed.startsWith('✖')) tests++;
    const testsMatch = /^ℹ tests (\d+)/.exec(trimmed);
    if (testsMatch) tests = parseInt(testsMatch[1], 10);
    const passMatch = /^ℹ pass (\d+)/.exec(trimmed);
    if (passMatch) pass = parseInt(passMatch[1], 10);
    const failMatch = /^ℹ fail (\d+)/.exec(trimmed);
    if (failMatch) fail = parseInt(failMatch[1], 10);
    if (trimmed.startsWith('✖') && firstFailName === null) {
      // Extract test name — skip the ✖ prefix
      const m = /^✖ (.+?) \(\d/.exec(trimmed);
      if (m) firstFailName = m[1];
    }
  }
  return { tests, pass, fail, firstFailName };
}

const results = [];
const t0 = Date.now();

for (const dim of DIMENSIONS) {
  const abs = join(repoRoot, dim.file);
  const dimStart = Date.now();
  let ok = false;
  let tests = 0, pass = 0, fail = 0;
  let firstFailName = null;
  let missing = false;
  let code = -1;
  let tapEmpty = false;
  let tapEmptyReason = null;

  // 有意撤掉的维度 (R161.3): 不去找文件、不跑测试、**不算失败**,
  // 但必须醒目地印出来 —— 静默跳过会让人以为它还在跑。
  if (dim.retired) {
    results.push({
      id: dim.id, task: dim.task, tests: 0, pass: 0, fail: 0,
      durationMs: Date.now() - dimStart, ok: true, firstFailName: null,
      missing: false, tapEmptyReason: null, retired: dim.retired,
    });
    console.log(`[${dim.task.toString().padStart(2)}] ${dim.id.padEnd(28)} RETIRED  ${dim.retired}`);
    continue;
  }

  if (!existsSync(abs)) {
    missing = true;
  } else {
    const child = await runChild(abs);
    code = child.code;
    const parsed = parseTapSummary(child.stdout);
    tests = parsed.tests;
    pass = parsed.pass;
    fail = parsed.fail;
    firstFailName = parsed.firstFailName;
    // TAP summary numbers (authoritative) — but if the parent `node --test`
    // process tree intercepted the grandchild's TAP output and parsing
    // yields 0 tests (capture failure), trust the child exit code instead:
    // exit 0 with empty capture → all passed; non-zero → at least one failed.
    if (parsed.tests > 0) {
      ok = fail === 0 && pass > 0;
    } else {
      // tap-capture-empty: treat as FAIL, NOT pass — see HARD REQUIREMENT
      // at top of file. Recursion guard means grandchild tests never ran;
      // masking with `code === 0` would hide real failures.
      ok = false;
      tapEmptyReason = code === 0
        ? 'node --test recursion guard skipped grandchild (parent was also `node --test`)'
        : `grandchild exited ${code} with empty TAP capture`;
    }
    // Stash for the table row below.
    tapEmpty = parsed.tests === 0;
  }

  const durationMs = Date.now() - dimStart;
  results.push({ id: dim.id, task: dim.task, tests, pass, fail, durationMs, ok, firstFailName, missing, tapEmptyReason });
  const status = missing ? 'MISS' : (ok ? 'PASS' : 'FAIL');
  console.log(`[${dim.task.toString().padStart(2)}] ${dim.id.padEnd(28)} ${status}  ${tests}t/${pass}p/${fail}f  ${durationMs}ms${firstFailName ? '  first-fail: ' + firstFailName : ''}${!missing && tapEmpty ? '  (TAP-CAPTURE-EMPTY: ' + tapEmptyReason + ')' : ''}`);
}

const totalMs = Date.now() - t0;
const passed = results.filter(r => r.ok && !r.retired).length;
const failed = results.filter(r => !r.ok).length;
const retired = results.filter(r => r.retired).length;

console.log('');
console.log('================================================================');
console.log(`Audit orchestrator: ${passed} pass / ${failed} fail / ${retired} retired (of ${results.length})  total ${totalMs}ms`);
console.log('================================================================');

process.exit(failed === 0 ? 0 : 1);