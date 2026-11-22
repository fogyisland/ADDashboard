// R161.34 (2026-11-07) — 红队审计修复批 (第 2 组): agent 侧两处输入校验加固
//
// ★ 本文件锁住两件事 (都是"外部输入直接进路径 / 进命令参数"的注入面):
//
//   A. upgrade-delivery 的 upgradeVersion 路径段守卫 (两棵树)
//      upgradeVersion 来自中心下发的 upgrade envelope, 直接进
//        join(agentInstallDir, '.upgrade-staging', upgradeVersion)
//      ⇒ 中心下发 "../../Windows/System32" 就能让 agent (SYSTEM 身份)
//        在任意目录 mkdir 并写入 bundle 文件。
//      修 = 套 path-safety.js 的 isSafeSegment (字符白名单 + 拒绝 . / ..)。
//
//   B. ad-admin dispatcher 的 quoteForPowerShell 一律加引号
//      旧实现只在值含 /[\s'"\\]/ 时加单引号 ⇒ `$` `;` `|` `&` `$()` 这些
//      真正能注入 PowerShell 命令的字符**全被漏掉**。
//      例: parentDn = "DC=x;whoami" ⇒ `;` 是命令分隔符 ⇒ 注入。
//      修 = 一律单引号包裹 (单引号串内 $ ` ; | & 都是字面量)。
//
// ★ 为什么用真实 import 而不是只读源码:
//   quoteForPowerShell / isSafeSegment 都是**未导出**的内部函数, 所以
//   源码级断言只能验"调用点存在", 验不了**行为**。
//   ⇒ 行为用"复算 + 真实模块"验证: 从真实 agent-identity.js /
//     path-safety.js import, 对真实 argv 展开做断言。
//
// 用法: cd Server/center && node --test tests/security/agent-input-hardening.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(CENTER_ROOT, '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'Server');

function readSrc(...parts) {
  return fs.readFileSync(path.join(SERVER_ROOT, ...parts), 'utf8');
}

// 真实 path-safety 模块 (两棵树各一份, 断言它们一致)。
async function loadPathSafety(tree) {
  const url = pathToFileURL(path.join(SERVER_ROOT, tree, 'src', 'lib', 'path-safety.js')).href;
  return import(url);
}

describe('R161.34 — agent 侧输入校验加固', () => {
  test('A1. 两棵树的 upgrade-delivery 必须 import 并使用 isSafeSegment', () => {
    for (const tree of ['agent', 'noadagent']) {
      const src = readSrc(tree, 'src', 'upgrade-delivery.js');
      assert.match(
        src,
        /import\s*\{\s*isSafeSegment\s*\}\s*from\s*'\.\/lib\/path-safety\.js'/,
        `${tree}/src/upgrade-delivery.js 必须 import isSafeSegment`
      );
      // 守卫必须**在** stagingDir 拼接之前 (否则守卫是死代码)。
      // ⚠ 必须跳过注释行: 守卫函数的说明注释里也写了 isSafeSegment(upgradeVersion),
      //   indexOf 会先命中注释 ⇒ 用"行首非注释"的匹配。
      const guardMatch = src.match(/^\s*if\s*\(!isSafeSegment\(upgradeVersion\)\)/m);
      // ⚠ 同样要避开注释里的同名字符串 (守卫注释里引用了拼接表达式) ——
      //   只认真正赋值给 stagingDir 的那一行。
      const stagingMatch = src.match(/^\s*const stagingDir = join\(agentInstallDir, '\.upgrade-staging', upgradeVersion\);/m);
      assert.ok(guardMatch, `${tree}: 必须有 if (!isSafeSegment(upgradeVersion)) 守卫`);
      assert.ok(stagingMatch, `${tree}: 必须保留 stagingDir 拼接`);
      assert.ok(guardMatch.index < stagingMatch.index,
        `${tree}: 守卫必须在 stagingDir 拼接**之前** (否则是死代码)`);
      // 失败语义: 拒绝时不 SIGTERM (不能因为坏版本号把 agent 打死)
      const guardBlock = src.slice(guardMatch.index, guardMatch.index + 600);
      assert.match(guardBlock, /unsafe-upgrade-version/,
        `${tree}: 拒绝路径必须给出可区分的 error code`);
    }
  });

  test('A2. isSafeSegment 真实行为: 拒绝路径穿越, 放行正常版本号', async () => {
    const { isSafeSegment } = await loadPathSafety('agent');
    // 正常版本号必须放行 —— 否则升级功能会被守卫打死
    for (const ok of ['0.1.5', '0.1.6-rc1', '1.0.0', '2026.11.07']) {
      assert.equal(isSafeSegment(ok), true, `正常版本号必须放行: ${ok}`);
    }
    // 路径穿越 / 分隔符 / 相对段必须拒绝
    for (const bad of [
      '../../Windows/System32',
      '..\\..\\Windows',
      '..',
      '.',
      'a/b',
      'a\\b',
      'C:evil',
      'ver;calc',
      ''
    ]) {
      assert.equal(isSafeSegment(bad), false, `危险版本号必须拒绝: ${JSON.stringify(bad)}`);
    }
  });

  test('A3. 两棵树的 path-safety.js 行为一致 (防分叉)', async () => {
    const ad = await loadPathSafety('agent');
    const noad = await loadPathSafety('noadagent');
    const probes = ['0.1.5', '../x', 'a/b', '..', 'x;y', '$(calc)'];
    for (const p of probes) {
      assert.equal(ad.isSafeSegment(p), noad.isSafeSegment(p),
        `两棵树 isSafeSegment 对 ${JSON.stringify(p)} 的判定必须一致`);
    }
  });

  test('B1. ad-admin dispatcher 必须**一律**加单引号 (旧正则不得回退)', () => {
    const src = readSrc('agent', 'src', 'dispatchers', 'ad-admin.js');
    const fnStart = src.indexOf('function quoteForPowerShell');
    assert.notEqual(fnStart, -1, '必须保留 quoteForPowerShell');
    const fnBlock = src.slice(fnStart, fnStart + 1200);
    // 旧实现的特征正则 (只有含这些字符才加引号) —— 必须消失
    assert.doesNotMatch(fnBlock, /\[\s'\"\\\\\]/,
      '旧的"含空白/引号才加引号"判定必须删除 (漏掉 $ ; | & 等注入字符)');
    // 一律包裹: 函数体必须无条件返回单引号包裹
    assert.match(fnBlock, /return\s+"'"[\s\S]{0,200}?replace\(\/'\/g,\s*"''"\)[\s\S]{0,120}?"'"/,
    'quoteForPowerShell 必须无条件把值包进单引号并把内嵌单引号转义成两个');
  });

  test('B2. quoteForPowerShell 真实行为: 注入载荷不得逃出引号', async () => {
    // quoteForPowerShell 未导出 ⇒ 从真实模块复算同构实现并对**真实调用点**
    // 的展开结果做断言 (源码级断言已在 B1 锁住"无条件包裹")。
    const src = readSrc('agent', 'src', 'dispatchers', 'ad-admin.js');
    const fnStart = src.indexOf('function quoteForPowerShell');
    const fnEnd = src.indexOf('\n}', fnStart) + 2;
    const fnBody = src.slice(fnStart, fnEnd);

    // 把函数体放进一个可 eval 的作用域里跑真实逻辑 (不 eval 整文件)
    const factory = new Function(`${fnBody}\nreturn quoteForPowerShell;`);
    const quote = factory();

    // 注入载荷: 每个都必须整体落在单引号串内, 不得产生裸的 ; | & $( )
    const payloads = [
      'DC=x;whoami',
      'DC=x|calc',
      'DC=x&calc',
      'DC=x$(calc.exe)',
      'DC=`calc.exe`',
      "O'Brien",
      "'; calc; '",
      'a b',
      '',
      'plain'
    ];
    for (const p of payloads) {
      const out = quote(p);
      assert.ok(out.startsWith("'") && out.endsWith("'"),
        `载荷必须整体被单引号包裹: ${JSON.stringify(p)} => ${JSON.stringify(out)}`);
      // 单引号串内不得有未转义的单引号 (PowerShell 里 ' 结束字符串)
      const inner = out.slice(1, -1);
      assert.ok(/^([^']|'')*$/.test(inner),
        `单引号串内不得有未转义的单引号: ${JSON.stringify(out)}`);
      // 还原: PowerShell 单引号串的 '' 还原成 '
      assert.equal(inner.replace(/''/g, "'"), p,
        `加引号必须可逆 (值语义不变): ${JSON.stringify(p)}`);
    }
  });

  test('B3. flattenParamsToArgs: 每个字符串值都必须已加引号', async () => {
    const src = readSrc('agent', 'src', 'dispatchers', 'ad-admin.js');
    // flattenParamsToArgs 依赖 mapActionForCommand 与 quoteForPowerShell ——
    // 三段函数体一起抽出来放进同一个 eval 作用域 (不 eval 整个文件)。
    const mapStart = src.indexOf('function mapActionForCommand');
    const quoteStart = src.indexOf('function quoteForPowerShell');
    const flattenStart = src.indexOf('function flattenParamsToArgs');
    assert.ok(mapStart !== -1 && quoteStart !== -1 && flattenStart !== -1,
      '三个函数必须都在');
    const mapBody = src.slice(mapStart, src.indexOf('\n}', mapStart) + 2);
    const quoteBody = src.slice(quoteStart, src.indexOf('\n}', quoteStart) + 2);
    const flattenBody = src.slice(flattenStart, src.indexOf('\n}', flattenStart) + 2);

    const factory = new Function(`${mapBody}\n${quoteBody}\n${flattenBody}\nreturn flattenParamsToArgs;`);
    const flatten = factory();
    const args = flatten('ou_create', { parentDn: 'DC=x;whoami', name: "O'Brien" });
    // argv 形态: ['--action','create','--parentDn','<v>','--name','<v>']
    //   → 偶数下标是 flag, 奇数下标是值; 下标 1 是 action (来自映射表, 不加引号)
    const values = args.filter((_, i) => i % 2 === 1 && i !== 1);
    for (const v of values) {
      assert.ok(v.startsWith("'") && v.endsWith("'"),
        `argv 里的字符串值必须已加引号: ${JSON.stringify(v)}`);
    }
    assert.ok(args.includes("'DC=x;whoami'"), '注入载荷必须被引号包住');
    assert.ok(args.includes("'O''Brien'"), '内嵌单引号必须转义成两个');
  });
});
