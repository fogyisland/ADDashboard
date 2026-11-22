// R161.35 第 2 步 (2026-11-22) — member 动作清单守卫的回归网.
//
// 守 Server/scripts/audit/check-member-script-manifest.mjs。
//
// ★ 为什么要单独测这个守卫:
//   守卫本身是"信任边界"的执行者 —— 它报绿就是"中心与 agent 的清单一致,
//   且磁盘上的脚本没有被篡改"。一个永远报绿的守卫比没有守卫更糟。
//   所以这里既要断言**干净的树报绿**, 也要断言**注入了缺陷的树报红**。
//
// ★ 注入方式: 在临时目录里按真实布局放一份货, 只破坏一处, 再跑守卫的
//   逻辑。守卫脚本本身不接受 --root 参数 (它是纯审计脚本, 不该有可被
//   绕过的开关), 所以这里通过**复制守卫脚本 + monkey-patch 路径**是行
//   不通的 —— ESM 静态 import 无法替换。改用最直白的方式:
//   直接对真实树做**原子式临时改动 + 还原** (备份字节 → 注入 → 断言 →
//   逐字节还原 → 断言还原成功)。任何一步失败都会把原文件写回去。
//
// ★ 这条测试会真实触碰 Server/agent/scripts 下的文件 (写后立即还原)。
//   风险面很小 (单文件追加一行), 且 finally 里做字节级还原 + 断言,
//   还原失败时测试直接报红而不是静默留下脏文件。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');
const GUARD = path.join(SERVER_ROOT, 'scripts', 'audit', 'check-member-script-manifest.mjs');
const AGENT_SCRIPTS = path.join(SERVER_ROOT, 'agent', 'scripts');
const NOAD_SCRIPTS = path.join(SERVER_ROOT, 'noadagent', 'scripts');
const AGENT_MANIFEST = path.join(SERVER_ROOT, 'agent', 'src', 'member-scripts.js');

// ★ 判定退出码必须用 spawnSync 的 status, 不能 `node ... | tail`
//   —— 管道会吞掉退出码 (R161.34 踩过: --check 报 stale 却显示 exit=0)。
function runGuard() {
  const r = spawnSync(process.execPath, [GUARD], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function withFileMutation(file, mutate, fn) {
  const original = fs.readFileSync(file);
  try {
    mutate(file, original);
    return fn();
  } finally {
    fs.writeFileSync(file, original);
    // 还原必须逐字节成立 —— 否则后面的测试全部不可信。
    assert.ok(fs.readFileSync(file).equals(original), `还原失败: ${file}`);
  }
}

describe('R161.35 第 2 步 — member 动作清单守卫', () => {
  test('G1. 干净的树必须报绿 (exit 0)', () => {
    const r = runGuard();
    assert.equal(r.status, 0, `守卫在干净树上必须 exit 0, 实际 ${r.status}\n${r.stderr}${r.stdout}`);
    assert.match(r.stdout, /member 动作清单一致/);
  });

  test('G2. ★ 改一个字节 (改 .ps1) ⇒ 守卫必须 exit 1 且指出 sha256 不一致', () => {
    const target = path.join(AGENT_SCRIPTS, 'member-collect-now.ps1');
    withFileMutation(target, (f) => {
      fs.appendFileSync(f, '\r\n# tampered by regression test\r\n');
    }, () => {
      const r = runGuard();
      assert.equal(r.status, 1, `篡改必须被抓住 (实际 exit ${r.status})`);
      assert.match(r.stderr, /sha256 与封印不一致/);
      assert.match(r.stderr, /member-collect-now\.ps1/);
    });
  });

  test('G3. ★ 中心清单多一个动作 ⇒ 守卫必须 exit 1 并点名该动作', () => {
    // 只给**一份副本**注入: 用真实文件 + 追加一个动作后还原。
    const centerManifest = path.join(CENTER_ROOT, 'src', 'services', 'member-scripts-manifest.js');
    withFileMutation(centerManifest, (f, originalSrc) => {
      const src = originalSrc.toString('utf8');
      const injected = src.replace(
        'export const SCRIPT_IDS = Object.freeze(Object.keys(MEMBER_SCRIPTS));',
        // ★ 必须重建对象, 不能在 MEMBER_SCRIPTS 上直接赋值 —— 它是
        //   Object.freeze 的, 直接赋值会抛 TypeError, 守卫于是因"运行
        //   错误"而 exit 1 —— 那是个**假阳性**的报红: 它证明了"守卫会
        //   崩", 而不是"守卫能识别多出的动作"。
        // ★ 注入文本必须走**函数式替换**: 字符串替换里 `$&`/`$'`/`$1`
        //   是特殊模式, 而我们要注入的源码里就有 `$` 和展开语法 —— 被
        //   当模式吃掉过一次。函数返回值永远按字面量处理。
        () => `const MEMBER_SCRIPTS_WITH_GHOST = Object.freeze({
`
          + `  ...MEMBER_SCRIPTS,
`
          + `  ghost_action: Object.freeze({ timeoutSec: 5, label: 'ghost', args: {} })
`
          + `});
`
          + `export const SCRIPT_IDS = Object.freeze(Object.keys(MEMBER_SCRIPTS_WITH_GHOST));`
      );
      assert.notEqual(injected, src, '注入点必须存在 —— 否则这条测试是个摆设');
      fs.writeFileSync(f, injected, 'utf8');
    }, () => {
      const r = runGuard();
      assert.equal(r.status, 1, '中心多出的动作必须报红');
      assert.match(r.stderr, /ghost_action/);
      assert.match(r.stderr, /缺少动作/);
    });
  });

  test('G4. ★ agent 与 noadagent 不一致 ⇒ 守卫必须 exit 1', () => {
    const target = path.join(NOAD_SCRIPTS, 'member-restart-service.ps1');
    withFileMutation(target, (f) => {
      fs.appendFileSync(f, '\r\n# noad drift\r\n');
    }, () => {
      const r = runGuard();
      assert.equal(r.status, 1, '两棵 agent 树漂移必须报红');
      assert.match(r.stderr, /不一致/);
      assert.match(r.stderr, /noadagent/);
    });
  });

  test('G5. ★ 负向测试: 判据必须能区分"干净"和"注入" (防止守卫永远报红/报绿)', () => {
    // G1 与 G2 之间的差异就是"有没有注入"。如果 G2 在没注入时也报 1,
    // G2 就毫无信息量。这里用同一次运行证明两边都成立。
    const clean = runGuard();
    assert.equal(clean.status, 0);
    const target = path.join(AGENT_SCRIPTS, 'member-restart-service.ps1');
    withFileMutation(target, (f) => fs.appendFileSync(f, '\r\n# x\r\n'), () => {
      const dirty = runGuard();
      assert.notEqual(dirty.status, clean.status, '★ 注入前后退出码必须不同');
    });
    const after = runGuard();
    assert.equal(after.status, 0, '还原后必须恢复绿 —— 否则这条测试污染了工作区');
  });

  test('G6. 封印工具与守卫必须对同一份磁盘字节给出相同结论', () => {
    // 两个工具读的是同一份文件; 如果封印工具报"已是最新"而守卫报红,
    // 说明其中一个的判据错了。这里只断言"干净时两边都是绿的"以及
    // "工具存在" —— 注入场景由 G2 覆盖。
    assert.ok(fs.existsSync(GUARD));
    assert.ok(fs.existsSync(AGENT_MANIFEST));
    const seal = spawnSync(
      process.execPath,
      [path.join(SERVER_ROOT, 'scripts', 'audit', 'refresh-member-script-hashes.mjs'), '--check'],
      { cwd: SERVER_ROOT, encoding: 'utf8', windowsHide: true }
    );
    assert.equal(seal.status, 0, `封印工具在干净树上必须 exit 0\n${seal.stdout}${seal.stderr}`);
  });
});
