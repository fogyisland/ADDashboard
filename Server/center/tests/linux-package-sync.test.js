// R161.32 — Linux 交付镜像漂移守卫 (check-linux-package-sync.mjs) 的回归网
//
// ★ 为什么必须有这个文件 (根因):
//   `Server/scripts/audit/check-linux-package-sync.mjs` **写好了但没接进任何
//   自动化链** —— 全仓只有 README 里写"维护者手动跑"。
//   ⇒ R161.30 S1 (init 向导 installer token) 和 R161.31 (迁移/验证脚本)
//     两批改动都漏了同步, 漂移**累积到 12 个文件**才被发现:
//       center/web/src/api/{client,init}.js
//       center/web/src/views/init/{DbConnStep,InitStep}.vue
//       center/scripts/{apply,verify}-*.mjs ×5 + _probe_* ×2
//       center/package.json   (FILE_PAIR — 必须字节相同)
//   ⇒ 本文件把那个守卫接进 `npm test` —— 漂移从此在**每次测试**时被抓住。
//
// ★ 为什么这个文件在 center/tests/ 顶层而不是 center/tests/audit/:
//   center/package.json 的 "test" 脚本的 glob 是 `tests/*.test.js ...`,
//   **不含 tests/audit/** ⇒ 放进去 CI 根本不跑。
//   而给 package.json 加 glob 会改掉它的内容 ⇒ `.install-hash` 失配 ⇒
//   目标机 (常常离线) 删 node_modules 重跑 npm install ⇒ 装机报废。
//   ⇒ 放顶层, 用现成的 glob, 不碰 package.json。
//
// ★ 为什么用"子进程"而不是 import:
//   check-linux-package-sync.mjs 是**纯脚本** (无 export, 顶层 process.exit),
//   import 它会直接结束本测试进程 ⇒ 只能用 spawn 跑, 读它的退出码 +
//   它写出的机器可读 JSON 报告 (Server/scripts/audit/linux-package-sync.json)。
//
// ★ Windows / Linux 交付树的差异模型 (为什么不能整树复制):
//   Windows (Server/) 独有: agent/ noadagent/ node/ nssm/ start.bat start.ps1
//   Linux   (LinuxServer/) 独有: ecosystem.config.cjs (PM2)
//   必须镜像: center/src center/web center/dist center/scripts db
//             center/data/packages
//             + 3 个单文件对 (center/server.js / build-manifest.json /
//                            center/package.json)
//   ⇒ 守卫的 TREE_PAIRS / FILE_PAIRS 就是这套模型的**代码化**;
//     本测试只断言"守卫跑出来是绿的", 不重复实现那套映射。
//
// 用法: cd Server/center && npm test
//       (或 node --test tests/linux-package-sync.test.js)

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ HERE = Server/center/tests ⇒ 上���级是 Server/center, 上两级是 Server。
const CENTER_ROOT = resolve(HERE, '..');                  // Server/center
const SERVER_ROOT = resolve(CENTER_ROOT, '..');           // Server
const REPO_ROOT = resolve(SERVER_ROOT, '..');            // 仓库根

const GUARD = join(SERVER_ROOT, 'scripts', 'audit', 'check-linux-package-sync.mjs');
const REPORT = join(SERVER_ROOT, 'scripts', 'audit', 'linux-package-sync.json');

// 守卫的退出码与它自己 process.exit 的那行保持一致。
const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

let guardResult = null;
let guardReport = null;

describe('Linux 交付镜像漂移 (Server/ vs LinuxServer/)', () => {
  before(() => {
    assert.ok(existsSync(GUARD), `守卫脚本不存在: ${GUARD}`);

    // ★ 跑守卫, 但**不能让它写报告文件**覆盖真实的审计产物
    //   (报告文件是 gitignore 的产物, 但目标机上可能有别的用途) ⇒
    //   跑在**仓库根**下, 让它自己定位; 报告路径由守卫自己算。
    const res = spawnSync(process.execPath, [GUARD, '--json'], {
      cwd: SERVER_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    guardResult = res;

    if (existsSync(REPORT)) {
      try {
        guardReport = JSON.parse(readFileSync(REPORT, 'utf8'));
      } catch (e) {
        guardReport = { parseError: e.message };
      }
    }
  });

  test('守卫脚本本身能跑起来 (不能有语法错 / 崩溃)', () => {
    assert.notEqual(guardResult.status, EXIT_USAGE,
      `守卫以用法错误退出 (exit 2) —— 检查它的用法或仓库根定位:\n`
      + `${guardResult.stderr || guardResult.stdout}`);
    // ★ '--json' 模式下守卫**故意不打印任何东西** (只有非 json 模式才 log),
    //   所以 stdout 为空是正常的 ⇒ 这里只断言"进程真的跑完了"
    //   (status !== null ⇒ 没被信号杀死 / 没超时)。
    assert.notEqual(guardResult.status, null,
      '守卫没跑完就被杀了 (信号或超时) —— 它可能在某个文件上死循环');
    assert.notEqual(guardResult.error?.code, 'ETIMEDOUT',
      '守卫超时了 —— 它可能在某个文件上死循环');
  });

  test('★ Linux 交付镜像与源树零漂移 (守卫 exit 0)', () => {
    // 失败时把守卫的每条 finding 打出来 —— 光给一个退出码没法排查。
    const detail = (guardReport?.findings || [])
      .map((f) => `  [${f.severity}] [${f.check}] ${f.message}`)
      .join('\n');
    assert.equal(
      guardResult.status,
      EXIT_OK,
      `Linux 交付镜像与源树漂移了 —— check-linux-package-sync.mjs 退出码 `
      + `${guardResult.status} (期望 ${EXIT_OK})。\n`
      + (detail || '(报告里没有 findings, 但退出码非 0 —— 报告可能是旧的)')
      + '\n\n修法: 把 Server/ 下对应的文件复制到 LinuxServer/ 下 (逐字节相同)。'
      + '\n     注意两棵树结构不同 —— 不能整树复制: Windows 侧独有 agent/ noadagent/ '
      + 'node/ nssm/ start.bat start.ps1, Linux 侧独有 ecosystem.config.cjs。'
      + '\n     守卫的 TREE_PAIRS / FILE_PAIRS 定义了必须镜像的范围。'
    );
  });

  test('守卫的报告是机器可读的, 且 summary 与退出码一致', () => {
    assert.ok(guardReport, '守卫没写出 JSON 报告 —— 它的机器可读契约坏了');
    assert.ok(guardReport.summary, 'JSON 报告缺 summary 段');
    const { errors, warnings } = guardReport.summary;
    assert.equal(typeof errors, 'number', 'summary.errors 不是数字');
    assert.equal(typeof warnings, 'number', 'summary.warnings 不是数字');
    assert.equal(
      errors > 0 ? EXIT_FINDINGS : EXIT_OK,
      guardResult.status,
      `报告说 ${errors} 个 error, 但进程退出码是 ${guardResult.status} —— `
      + '两者的判定口径不一致 (守卫的 JSON 报告与退出码必须同源)');
  });

  test('守卫的 ALLOWLIST 每一条都带理由 (防止"白名单腐化")', () => {
    assert.ok(Array.isArray(guardReport?.allowlist), '报告缺 allowlist 段');
    for (const entry of guardReport.allowlist) {
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.trim().length > 0,
        `ALLOWLIST 条目 ${entry.tree}/${entry.side}/${entry.path} 没有写理由 —— `
        + '一条没理由的白名单就是漂移的开始');
    }
  });

  test('必镜像的三棵树都参与了比对 (守卫没漏掉 center/web)', () => {
    // ★ 回归 R161.32 的真实缺陷: 漂移发生在 center/web/src/ 下 (4 个文件)。
    //   如果守卫的 TREE_PAIRS 哪天漏了 center/web, 这个断言会先红 ——
    //   提醒"别再把 web/src 排除在镜像范围外"。
    const notes = guardReport?.notes || [];
    const webCompared = notes.some((n) => /center\/web/.test(String(n)));
    assert.ok(webCompared,
      '守卫的 notes 里没有 center/web 的比对记录 ⇒ center/web 可能没进 '
      + 'TREE_PAIRS ⇒ web/src 的漂移永远抓不到');
  });
});
