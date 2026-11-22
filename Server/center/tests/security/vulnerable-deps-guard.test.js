// R161.34 — 漏洞依赖守卫 (check-vulnerable-deps.mjs) 的回归网。
//
// ★ 为什么要这个文件:
//   红队审计发现前端 xlsx 解析用的是 `xlsx@0.18.5` (SheetJS), 带**两个
//   high 级漏洞**, 而两个都**直接命中**我们的攻击面:
//     · GHSA-4r6h-8v6p-xvw6 — Prototype Pollution (<0.19.3)
//     · GHSA-5pgg-2g8v-p4x9 — ReDoS (<0.20.2)
//   我们的用法 = "操作员上传 xlsx → 浏览器解析" ⇒ 正是"不可信文件 → 解析器"。
//   ⇒ 已换成 `exceljs` (npm 上 0 high / 0 critical)。
//
// ★ 这个测试锁两件事:
//   1. 现状是干净的 (守卫 exit 0)
//   2. ★ **守卫自己有效** —— 注入 xlsx 必须报红。
//      (记忆里的教训: "检测器自己也要负向测试"。一个永远报绿的守卫
//       比没有守卫更糟 —— 它训练操作员忽略审计输出。)
//
// ★ 用法: cd Server/center && node --test tests/security/vulnerable-deps-guard.test.js

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync,
  mkdirSync, copyFileSync
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = resolve(HERE, '..', '..');
const SERVER_ROOT = resolve(CENTER_ROOT, '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');

const GUARD = join(SERVER_ROOT, 'scripts', 'audit', 'check-vulnerable-deps.mjs');
const REPORT = join(SERVER_ROOT, 'scripts', 'audit', 'vulnerable-deps.json');

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

let guardResult = null;
let guardReport = null;

describe('R161.34 — 漏洞依赖守卫 (check-vulnerable-deps.mjs)', () => {
  before(() => {
    assert.ok(existsSync(GUARD), `守卫脚本不存在: ${GUARD}`);
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

  test('守卫脚本本身能跑起来', () => {
    assert.notEqual(guardResult.status, EXIT_USAGE,
      `守卫以用法错误退出 (exit 2):\n${guardResult.stderr || guardResult.stdout}`);
    assert.notEqual(guardResult.status, null, '守卫没跑完就被杀了 (信号或超时)');
    assert.notEqual(guardResult.error?.code, 'ETIMEDOUT', '守卫超时了');
  });

  test('★ 现状干净: 不得有已知的漏洞直接依赖 (守卫 exit 0)', () => {
    const detail = (guardReport?.findings || [])
      .map((f) => `  [${f.code}] ${f.manifest}: ${f.detail}`)
      .join('\n');
    assert.equal(
      guardResult.status,
      EXIT_OK,
      `存在有已知漏洞的直接依赖 —— check-vulnerable-deps.mjs 退出码 `
      + `${guardResult.status} (期望 ${EXIT_OK})。\n${detail}`
    );
  });

  test('★ xlsx 必须已从所有清单里消失 (不能只是版本号变了)', () => {
    for (const rel of [
      join('Server', 'center', 'package.json'),
      join('Server', 'package.json'),
      join('LinuxServer', 'center', 'package.json')
    ]) {
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) continue;
      const manifest = JSON.parse(readFileSync(abs, 'utf8'));
      const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
      assert.equal(deps.xlsx, undefined,
        `${rel}: 不得再声明 xlsx (两个 high 漏洞, npm 上无修复版) —— 用 exceljs`);
    }
  });

  test('★ exceljs 必须已就位 (换库不能只删不装)', () => {
    const abs = join(REPO_ROOT, 'Server', 'center', 'package.json');
    const manifest = JSON.parse(readFileSync(abs, 'utf8'));
    const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
    assert.ok(deps.exceljs, 'center/package.json 必须声明 exceljs');
  });

  test('★ 守卫自己有效: 注入 xlsx 必须报红 (负向测试)', () => {
    // 在临时目录搭一个"仓库"骨架, 只放守卫 + 一个带 xlsx 的 manifest。
    // 守卫靠"向上找 Server 目录"定位仓库根 ⇒ 临时目录满足这个条件。
    const tmpRoot = mkdtempSync(join(os.tmpdir(), 'addash-vdep-'));
    try {
      const auditDir = join(tmpRoot, 'Server', 'scripts', 'audit');
      const centerDir = join(tmpRoot, 'Server', 'center');
      mkdirSync(auditDir, { recursive: true });
      mkdirSync(centerDir, { recursive: true });
      copyFileSync(GUARD, join(auditDir, 'check-vulnerable-deps.mjs'));
      writeFileSync(join(centerDir, 'package.json'), JSON.stringify({
        name: 'probe', version: '1.0.0',
        dependencies: { xlsx: '^0.18.5' }
      }, null, 2), 'utf8');

      const res = spawnSync(process.execPath, [join(auditDir, 'check-vulnerable-deps.mjs')], {
        cwd: tmpRoot,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
      assert.equal(res.status, EXIT_FINDINGS,
        `★ 守卫注入 xlsx 后必须报红 (exit ${EXIT_FINDINGS}), 实际 ${res.status}。`
        + `一个永远报绿的守卫比没有守卫更糟。\n${res.stdout || ''}${res.stderr || ''}`);
      assert.match(res.stderr + res.stdout, /xlsx/,
        '守卫的输出里必须点名是哪个包违规');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
