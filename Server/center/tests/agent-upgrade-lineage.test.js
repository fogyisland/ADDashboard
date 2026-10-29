// R161.22 — 「升级血统」链路的回归网
//
// ── 缺陷链 (为什么会连着栽两次) ───────────────────────────────────────
//   R158.48 (2026-10-06) 建 agent 自动升级时, 中心端**只有一棵树**:
//     server.js:511  join(repoRoot, 'agent')   ← AD 血统
//   而代理端有**两棵树**:
//     Server/agent      (34 台 DC)
//     Server/noadagent  (成员服务器)
//
//   ↓ 断链点 1 (中心端)
//   routes/agent.js 的 non-ad 分支照样返回 upgradeAvailable/upgradeVersion,
//   而 computeUpgradeEnvelope 比的是 **AD 源**的版本号 ⇒ 成员代理每次心跳
//   都被告知「有 AD 包可升」⇒ 它去拉 GET /api/agent/upgrade ⇒ 中心端吐的
//   正是 AD 包 ⇒ applyUpgradeDelivery 把它 sha256 校验后**原子 rename
//   覆盖**到成员服务器自己的安装目录 ⇒ **成员服务器变成 DC 代理**。
//
//   ↓ 断链点 2 (代理端)
//   noad fork (R158.75) 抄调用点时漏了 `boundFetchUpgrade` 的**绑定**
//   ⇒ 每次心跳 ReferenceError ⇒ makeSendCallback.send() 里 postHeartbeat
//   之后的代码全部不可达 ⇒ **file-push drainer + member-commands drainer
//   永远不跑** (成员服务器收不到中心推的文件, 也永远不执行操作员排的
//   成员命令)。
//   ★ 断链点 2 恰好把断链点 1 挡住了 —— 所以现场看起来是「成员代理不升级」
//   (良性), 一旦有人把 boundFetchUpgrade 补上, 断链点 1 立刻变成 P0。
//   ⇒ 这两条必须**同时**钉死, 不能只修一条。
//
//   ↓ 断链点 3 (代理端)
//   noad fork 也漏了「升级装盘后自杀」那一步 (AD 端 agent.js:918-921 有,
//   R158.88.BF1 的教训) ⇒ 即使升级成功, 进程也不死 ⇒ 新代码不生效。
//
// ── 本文件锁定 12 件事 (全部离线: 不连数据库, 不起中心/代理进程) ───────
//   1. 血统归一化 (只有显式 'non-ad' 才算 non-AD)
//   2. ★ non-AD 血统**绝不**回退到 AD 源 (核心不变量)
//   3. AD 血统的升级信封逐字不变 (34 台 DC 零影响)
//   4. non-AD 代理拿的是 noad 源的版本号
//   5. 两棵树都没有时, 对应血统的代理拿不到升级信封 (安全降级)
//   6. 灰度熔断规则不变 (paused / canary / full)
//   7. noad 代理端拒收 AD 包 (显式要求 lineage === 'noad')
//   8. AD 代理端拒收 noad 包 (显式排除, 向后兼容)
//   9. 真实 build-manifest.json 的血统字段自洽
//  10. ★ noad agent.js 的 boundFetchUpgrade **有定义** (断链点 2)
//  11. ★ noad agent.js 升级成功后**会自杀** (断链点 3)
//  12. noad 代理只打 non-AD 端点; 绿色包与源树逐字一致
//
// 用法: cd Server/center && node --test tests/agent-upgrade-lineage.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LINEAGE_AD, LINEAGE_NON_AD, normalizeLineage,
  selectUpgradeSource, computeUpgradeEnvelopeFrom
} from '../src/services/agent-upgrade-envelope.js';
// ★ 代理端**真代码** (不是复刻品)。中心端单测直接 import 两棵树的
//   upgrade-delivery.js, 这样「中心端发什么」和「代理端收什么」两个
//   判定**不可能漂移**。
import { checkBundleLineage as checkNoadBundleLineage } from '../../noadagent/src/upgrade-delivery.js';
import { checkBundleLineage as checkAdBundleLineage } from '../../agent/src/upgrade-delivery.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const NOAD_AGENT_JS = path.join(SERVER_ROOT, 'noadagent', 'agent.js');
const NOAD_REPORTER_JS = path.join(SERVER_ROOT, 'noadagent', 'src', 'reporter.js');
const NOAD_MANIFEST = path.join(SERVER_ROOT, 'noadagent', 'build-manifest.json');
const AD_MANIFEST = path.join(SERVER_ROOT, 'agent', 'build-manifest.json');
const MEMBER_AGENT_JS = path.join(REPO_ROOT, 'MemberAgent', 'agent', 'agent.js');

/** 造一份「可用」的升级源 (形状跟 agent-upgrade-source.js 的返回值一致)。 */
function makeSource(version, extra = {}) {
  return { available: true, version, fileCount: 1, totalBytes: 10, files: [], ...extra };
}

/** 把一个 manifest 对象变成 bundle 文件清单里的一项 (base64 载荷)。 */
function manifestFile(manifestObj) {
  return {
    path: 'build-manifest.json',
    sha256: 'x'.repeat(64),
    base64: Buffer.from(JSON.stringify(manifestObj), 'utf8').toString('base64')
  };
}

describe('R161.22 — 升级血统链路 (中心端选源 ⇄ 代理端校验, 1:1 契约)', () => {
  test('1. 血统归一化: 只有显式 non-ad 才算 non-AD', () => {
    assert.equal(normalizeLineage('non-ad'), LINEAGE_NON_AD);
    assert.equal(normalizeLineage('non-AD'), LINEAGE_NON_AD);
    assert.equal(normalizeLineage(' non-ad '), LINEAGE_NON_AD);
    assert.equal(normalizeLineage('ad'), LINEAGE_AD);
    assert.equal(normalizeLineage(undefined), LINEAGE_AD);
    assert.equal(normalizeLineage(null), LINEAGE_AD);
    assert.equal(normalizeLineage(''), LINEAGE_AD);
    assert.equal(normalizeLineage('unknown-garbage'), LINEAGE_AD);
  });

  test('2. ★ 核心不变量: non-AD 血统绝不回退到 AD 源', () => {
    const ad = makeSource('0.1.9');
    // 只有 AD 树 (non-AD 树缺失) ⇒ non-AD 代理拿到 null, 拿不到 AD 的 0.1.9。
    const picked = selectUpgradeSource({ ad, nonAd: null }, LINEAGE_NON_AD);
    assert.equal(picked, null,
      'non-AD 血统绝不能回退到 AD 源 —— 那正是成员服务器被 AD 代码覆盖的根因');
    // 两棵树都在 ⇒ non-AD 拿到 noad 源, AD 拿到 AD 源。
    const noad = makeSource('0.1.6-noad');
    assert.equal(selectUpgradeSource({ ad, nonAd: noad }, LINEAGE_NON_AD), noad);
    assert.equal(selectUpgradeSource({ ad, nonAd: noad }, LINEAGE_AD), ad);
    // 不可用的源等同于缺失。
    assert.equal(selectUpgradeSource({ ad: { available: false, version: '0.1.9' }, nonAd: null }, LINEAGE_NON_AD), null);
    assert.equal(selectUpgradeSource({ ad: { available: false, version: '0.1.9' }, nonAd: null }, LINEAGE_AD), null);
  });

  test('3. AD 血统的升级信封逐字不变 (34 台 DC 零影响)', () => {
    const ad = makeSource('0.1.9');
    // 老代理报 0.1.7 ⇒ 有升级, 目标 0.1.9
    assert.deepEqual(computeUpgradeEnvelopeFrom(ad, '0.1.7'),
      { upgradeAvailable: true, upgradeVersion: '0.1.9', rolloutStrategy: 'full' });
    // 同版本 ⇒ 无升级, 策略 'full' (不灰度)
    assert.deepEqual(computeUpgradeEnvelopeFrom(ad, '0.1.9'),
      { upgradeAvailable: false, upgradeVersion: null, rolloutStrategy: 'full' });
    // 老代理报 0.1.1 ⇒ 依然有升级 (字符串不等比较的既有语义, 不改)
    assert.equal(computeUpgradeEnvelopeFrom(ad, '0.1.1').upgradeAvailable, true);
  });

  test('4. non-AD 代理拿的是 noad 源的版本号', () => {
    const sources = { ad: makeSource('0.1.9'), nonAd: makeSource('0.1.6-noad') };
    const src = selectUpgradeSource(sources, LINEAGE_NON_AD);
    const env = computeUpgradeEnvelopeFrom(src, '0.1.4');
    assert.equal(env.upgradeAvailable, true);
    assert.equal(env.upgradeVersion, '0.1.6-noad',
      '成员代理必须拿到 noad 源的版本, 绝不是 AD 的 0.1.9');
    assert.notEqual(env.upgradeVersion, '0.1.9');
  });

  test('5. 两棵树都缺失 ⇒ 对应血统的代理拿不到升级信封 (安全降级)', () => {
    const env = computeUpgradeEnvelopeFrom(null, '0.1.4');
    assert.deepEqual(env,
      { upgradeAvailable: false, upgradeVersion: null, rolloutStrategy: 'unavailable' });
    // 代理端拿到这个信封时的行为: upgradeVersion 不是字符串 ⇒ 归一成 '' ⇒ 早退。
    const upgradeVersion = typeof env.upgradeVersion === 'string' ? env.upgradeVersion : '';
    assert.equal(upgradeVersion.length, 0);
  });

  test('6. 灰度熔断规则不变 (paused / canary / full)', () => {
    const ad = makeSource('0.1.9');
    const paused = computeUpgradeEnvelopeFrom(ad, '0.1.7', { strategy: 'paused', canaryRatio: 100 });
    assert.deepEqual(paused,
      { upgradeAvailable: false, upgradeVersion: null, rolloutStrategy: 'paused' });
    const canary = computeUpgradeEnvelopeFrom(ad, '0.1.7', { strategy: 'canary', canaryRatio: 0 });
    assert.deepEqual(canary,
      { upgradeAvailable: false, upgradeVersion: null, rolloutStrategy: 'canary' });
    const canaryFull = computeUpgradeEnvelopeFrom(ad, '0.1.7', { strategy: 'canary', canaryRatio: 100 });
    assert.equal(canaryFull.upgradeAvailable, true);
    assert.equal(canaryFull.upgradeVersion, '0.1.9');
    assert.equal(canaryFull.rolloutStrategy, 'canary');
  });

  test('7. noad 代理端拒收 AD 包 (显式要求 lineage === noad)', () => {
    // AD 血统的 manifest 没有 lineage 字段 ⇒ 拒收
    const adManifest = JSON.parse(readFileSync(AD_MANIFEST, 'utf8'));
    const v1 = checkNoadBundleLineage([manifestFile(adManifest)]);
    assert.equal(v1.ok, false, 'AD 包必须被 noad 代理拒收');
    assert.equal(v1.reason, 'lineage-mismatch');
    // 显式写着 lineage:'ad' ⇒ 同样拒收
    const v2 = checkNoadBundleLineage([manifestFile({ version: '0.1.9', lineage: 'ad' })]);
    assert.equal(v2.ok, false);
    assert.equal(v2.reason, 'lineage-mismatch');
    assert.equal(v2.lineage, 'ad');
    // noad 包 ⇒ 放行
    const noadManifest = JSON.parse(readFileSync(NOAD_MANIFEST, 'utf8'));
    const v3 = checkNoadBundleLineage([manifestFile(noadManifest)]);
    assert.equal(v3.ok, true, `noad 包必须放行, 实际 reason=${v3.reason}`);
    assert.equal(v3.lineage, 'noad');
    // 没有 build-manifest.json ⇒ 拒收 (血统未知)
    const v4 = checkNoadBundleLineage([{ path: 'agent.js', base64: 'eA==' }]);
    assert.equal(v4.ok, false);
    assert.equal(v4.reason, 'missing-build-manifest');
  });

  test('8. AD 代理端拒收 noad 包 (显式排除, 向后兼容)', () => {
    const noadManifest = JSON.parse(readFileSync(NOAD_MANIFEST, 'utf8'));
    const v1 = checkAdBundleLineage([manifestFile(noadManifest)]);
    assert.equal(v1.ok, false, 'AD 代理必须拒收 noad 包');
    assert.equal(v1.reason, 'lineage-mismatch');
    // AD manifest (无 lineage 字段) ⇒ 放行 (不能因为中心端回退就断掉 34 台 DC 的升级通道)
    const adManifest = JSON.parse(readFileSync(AD_MANIFEST, 'utf8'));
    const v2 = checkAdBundleLineage([manifestFile(adManifest)]);
    assert.equal(v2.ok, true, 'AD 包必须放行');
    // 没有 manifest ⇒ 放行 (排除法, 不是要求法)
    const v3 = checkAdBundleLineage([{ path: 'agent.js', base64: 'eA==' }]);
    assert.equal(v3.ok, true);
  });

  test('9. 真实 build-manifest.json 的血统字段自洽', () => {
    const noadManifest = JSON.parse(readFileSync(NOAD_MANIFEST, 'utf8'));
    assert.equal(noadManifest.lineage, 'noad',
      'noadagent/build-manifest.json 必须声明 lineage=noad, 否则代理端会拒收中心端发的包');
    assert.equal(typeof noadManifest.version, 'string');
    const adManifest = JSON.parse(readFileSync(AD_MANIFEST, 'utf8'));
    assert.notEqual(adManifest.lineage, 'noad',
      'AD manifest 绝不能声明自己是 noad');
    assert.equal(typeof adManifest.version, 'string');
  });

  test('10. ★ noad agent.js 的 boundFetchUpgrade 有定义 (断链点 2)', () => {
    const src = readFileSync(NOAD_AGENT_JS, 'utf8');
    // 绑定必须存在。
    assert.match(src, /\b(?:const|let|var)\s+boundFetchUpgrade\s*=/,
      'noad agent.js 缺 boundFetchUpgrade 的绑定 ⇒ 每次心跳 ReferenceError '
      + '⇒ file-push / member-commands drainer 永远不跑');
    // 调用点引用的每一个标识符都必须在「声明 ∪ import」集合里。
    const declared = new Set(
      [...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
    );
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) imported.add(name.trim());
      }
    }
    const known = new Set([...declared, ...imported,
      '__dirname', 'console', 'process', 'Buffer', 'setTimeout', 'setInterval',
      'clearInterval', 'clearTimeout', 'setImmediate', 'fetch', 'URL', 'JSON',
      'Math', 'Date', 'Error', 'Promise', 'Object', 'Array', 'String', 'Number',
      'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
      'decodeURIComponent', 'AbortController', 'setTimeout']);
    // 取出 applyUpgradeDelivery(...) 实参里用到的标识符。
    const callMatch = /applyUpgradeDelivery\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(src);
    assert.ok(callMatch, '找不到 applyUpgradeDelivery 调用点 (noad agent.js 结构变了?)');
    const used = new Set();
    for (const part of callMatch[1].split(',')) {
      const kv = part.split(':');
      const value = (kv.length > 1 ? kv[1] : kv[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(value)) used.add(value);
    }
    for (const name of used) {
      assert.ok(known.has(name),
        `applyUpgradeDelivery 的实参 '${name}' 在 noad agent.js 里既没声明也没 import `
        + '⇒ 运行时 ReferenceError');
    }
  });

  test('11. ★ noad agent.js 升级成功后会自杀 (断链点 3)', () => {
    const src = readFileSync(NOAD_AGENT_JS, 'utf8');
    assert.match(src, /upgradeR[\s\S]{0,200}?applied\s*===\s*true/,
      'noad agent.js 没有读 upgradeR.applied ⇒ 升级装盘后进程不死 ⇒ 新代码不生效');
    assert.match(src, /upgradeR[\s\S]{0,400}?exiting\s*===\s*true/,
      'noad agent.js 没有读 upgradeR.exiting');
    assert.match(src, /setImmediate\s*\(\s*\(\)\s*=>\s*process\.kill/,
      'noad agent.js 升级后没有 SIGTERM 自己 (NSSM 不会重拉)');
  });

  test('12. noad 代理只打 non-AD 端点; 绿色包与源树逐字一致', () => {
    const reporter = readFileSync(NOAD_REPORTER_JS, 'utf8');
    assert.match(reporter, /\/api\/agent\/upgrade-non-ad/,
      'noad 代理必须打 /api/agent/upgrade-non-ad');
    assert.doesNotMatch(reporter, /\/api\/agent\/upgrade`/,
      'noad 代理不能打 /api/agent/upgrade (那是 AD 包)');
    // 绿色包 (MemberAgent) 必须跟源树 (Server/noadagent) 逐字一致 ——
    // 否则操作员推到成员服务器上的代码跟中心端发的不是一个东西。
    for (const rel of ['agent.js', 'src/reporter.js', 'src/upgrade-delivery.js']) {
      const srcPath = path.join(SERVER_ROOT, 'noadagent', rel);
      const pkgPath = path.join(REPO_ROOT, 'MemberAgent', 'agent', rel);
      assert.ok(existsSync(pkgPath), `MemberAgent/agent/${rel} 不存在`);
      assert.equal(readFileSync(pkgPath, 'utf8'), readFileSync(srcPath, 'utf8'),
        `MemberAgent/agent/${rel} 与 Server/noadagent/${rel} 不一致 (绿色包漂移)`);
    }
    // 中心端必须同时保留 AD 端点并注册 non-AD 端点。
    const centreRoutes = readFileSync(path.join(SERVER_ROOT, 'center', 'src', 'routes', 'agent-upgrade.js'), 'utf8');
    assert.match(centreRoutes, /router\.get\('\/api\/agent\/upgrade',/,
      'AD 升级端点必须保留 (34 台 DC 依赖它)');
    assert.match(centreRoutes, /router\.get\('\/api\/agent\/upgrade-non-ad',/,
      'non-AD 升级端点缺失');
    // 成员心跳分支必须显式声明血统。
    const centreAgent = readFileSync(path.join(SERVER_ROOT, 'center', 'src', 'routes', 'agent.js'), 'utf8');
    assert.match(centreAgent, /computeUpgradeEnvelope\(agentVersion,\s*null,\s*'non-ad'\)/,
      '成员心跳分支没有传 non-ad 血统 ⇒ 成员代理会去升 AD 包');
  });
});
