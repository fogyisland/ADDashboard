// R161.21 — 成员代理「包作用域」链路的回归网
//
// ── 缺陷链 (为什么会连着栽三次) ───────────────────────────────────────
//   R158.86.5    中心端引入 package_policies.scope, 包按 agent 类型分流
//   R158.87.6.5  客户端加三重防御: agent.type / scope / platforms
//   ↓ 断链点 (R161.21 修)
//   中心端 GET /api/admin/agent/packages-for-host 的水合函数**没有把
//   package_policies.scope 放进 manifest** —— scope 只活在 DB 列里。
//   ⇒ 客户端拿到的 pkg.scope === undefined
//   ⇒ shouldRunPackageForNonAd 第 2 条硬条件恒假
//   ⇒ 实测「14 包输入 → 0 包通过」。
//
//   症状是 **0 行数据**, 不是 500, 不是日志报错, 不是进程崩溃 —— 最难查
//   的那一类。R158.86.5 → R158.87.6.5 → R161.21 三次都栽在同一条链上,
//   根因是这条链**没有可执行的断言**: 契约只以注释的形式存在。
//
// ── 本文件锁定 7 件事 (全部离线: 不连数据库, 不起 agent 进程) ─────────
//   1. scope 真的上线 (baked.scope === DB 列里的 scope)
//   2. scope 为 NULL/缺失 ⇒ 兜底 'global', **绝不 undefined**
//   3. AD 作用域的包在**服务端**就被挡掉 (不靠客户端兜底)
//   4. member 作用域的包一个不少地上线 (数量由唯一事实源驱动)
//   5. 下发的每个包都满足**客户端真谓词** (同一份代码, 1:1 契约)
//   6. 按主机禁用行 (enabled=0) 真的把那个包挡掉
//   7. 若中心端**不送** scope ⇒ 客户端 0 通过 (复现原始症状, 钉住因果)
//
// ★ 为什么断言用**真实 manifest.json** 而不是造对象:
//   ad_os_baseline 的 manifest.agent.type 至今仍写着 'non-ad' (R158.56c
//   时代遗留的错例), 而它的 scope 是 'agent_type:ad'。用真实 manifest 才能
//   证明「归属判定只看 scope」这条设计是真的成立, 而不是造出来的假象。
//
// 用法: cd Server/center && node --test tests/agent-packages-scope.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildManifestItems } from '../src/services/agent-packages-manifest.js';
import {
  SCOPE_OVERRIDE, SCOPE_AD, SCOPE_NON_AD, SCOPE_GLOBAL
} from '../src/services/package-scope.js';
// ★ 客户端**真谓词** —— 与运行时同一份代码 (noadagent/src/non-ad-scheduler.js
//   里 applyPackageList 用的就是它)。中心端单测直接 import 代理端源码,
//   这样「服务端送什么」和「客户端收什么」两个谓词**不可能漂移**。
import { shouldRunPackageForNonAd } from '../../noadagent/src/non-ad-scheduler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const PACKAGES_DIR = path.join(CENTER_ROOT, 'data', 'packages');

const AD_NAMES = Object.keys(SCOPE_OVERRIDE).filter(n => SCOPE_OVERRIDE[n] === SCOPE_AD);
const MEMBER_NAMES = Object.keys(SCOPE_OVERRIDE).filter(n => SCOPE_OVERRIDE[n] === SCOPE_NON_AD);

/**
 * 读一个内置包的**真实** manifest.json。
 * 目录形如 data/packages/<name>/<version>/manifest.json; 取版本号最大的
 * 那一版 (本断言只关心 manifest.agent.type / platforms, 与版本无关)。
 */
function readRealManifest(name) {
  const dir = path.join(PACKAGES_DIR, name);
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .reverse();
  for (const v of versions) {
    const p = path.join(dir, v, 'manifest.json');
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
    }
  }
  return null;
}

/** 造一条 `package_scripts + package_policies` JOIN 行 (listEnabledGlobal 的形状)。 */
function enabledRow(name, scope) {
  const manifest = readRealManifest(name) || {
    name,
    version: '1.0.0',
    agent: { type: scope === SCOPE_NON_AD ? 'non-ad' : 'ad', platforms: ['windows'] }
  };
  return {
    name,
    version: manifest.version || '1.0.0',
    script_sha256: 'deadbeef',
    // MSSQL 侧这一列是 NVARCHAR ⇒ 存的是 JSON 字符串; MySQL 侧是 JSON 列
    // ⇒ 读出来已经是对象。两种形态都要吃 (parseManifest 负责)。
    manifest_json: JSON.stringify(manifest),
    interval_sec: 3600,
    timeout_ms: 600000,
    enabled: 1,
    params_json: null,
    scope,
    source: 'builtin',
    created_at: '2026-10-01 00:00:00',
    updated_at: '2026-10-01 00:00:00'
  };
}

/** 造一条 `ad_member_server_packages` 按主机行 (listPackagesForHost 的形状)。 */
function memberRow(name, enabled = 1, hostname = 'MEMBER01') {
  return {
    hostname,
    package_name: name,
    enabled,
    installed_at: '2026-10-01 00:00:00',
    last_run_at: null,
    version: '1.0.0',
    pkg_enabled: 1
  };
}

const ALL_ENABLED_ROWS = Object.keys(SCOPE_OVERRIDE).map(n => enabledRow(n, SCOPE_OVERRIDE[n]));
const ALL_MEMBER_ROWS = MEMBER_NAMES.map(n => memberRow(n, 1));

describe('R161.21 — 成员代理包作用域链路 (中心端下发 ⇄ 代理端接收, 1:1 契约)', () => {
  test('0. 前置: 白名单本身是自洽的 (member 3 个 / AD 若干, 且互不重叠)', () => {
    assert.equal(MEMBER_NAMES.length, 3,
      `member 作用域包应为 3 个, 实际 ${MEMBER_NAMES.length}: ${MEMBER_NAMES.join(', ')}`);
    assert.deepEqual(MEMBER_NAMES.sort(),
      ['member_admin_groups', 'member_eventlog_collector', 'member_os_baseline_collector']);
    assert.ok(AD_NAMES.length >= 14,
      `AD 作用域包数量异常: ${AD_NAMES.length}`);
    // 白名单里的包必须都有真实 manifest 可读 —— 否则本测试的输入是假的。
    for (const name of Object.keys(SCOPE_OVERRIDE)) {
      assert.ok(readRealManifest(name),
        `data/packages/${name} 下找不到 manifest.json —— 白名单与磁盘不同步`);
    }
  });

  test('1. scope 真的上线了 (baked.scope === DB 列里的 scope)', () => {
    const items = buildManifestItems({
      enabledRows: ALL_ENABLED_ROWS,
      memberRows: ALL_MEMBER_ROWS
    });
    for (const item of items) {
      assert.equal(typeof item.scope, 'string',
        `${item.name}: scope 必须上线且是字符串, 实际 ${JSON.stringify(item.scope)}`);
      assert.equal(item.scope, SCOPE_NON_AD,
        `${item.name}: scope 应等于 DB 里的 ${SCOPE_NON_AD}`);
    }
  });

  test('2. scope 为 NULL/缺失 ⇒ 兜底 global, 绝不 undefined', () => {
    const rows = [
      { ...enabledRow('ad_os_baseline', SCOPE_AD), scope: null },
      { ...enabledRow('ad_lockout_list', SCOPE_AD), scope: undefined },
      enabledRow('member_os_baseline_collector', SCOPE_NON_AD)
    ];
    const items = buildManifestItems({ enabledRows: rows, memberRows: [memberRow('member_os_baseline_collector')] });
    for (const item of items) {
      assert.notEqual(item.scope, undefined,
        `${item.name}: scope 绝不能是 undefined (客户端判定会走 false 分支)`);
    }
    // 兜底成 'global' 的包两端都不下发 ⇒ 不该出现在结果里。
    assert.deepEqual(items.map(i => i.name), ['member_os_baseline_collector']);
  });

  test('3. AD 作用域的包在服务端就被挡掉 (不靠客户端兜底)', () => {
    const items = buildManifestItems({
      enabledRows: ALL_ENABLED_ROWS,
      memberRows: ALL_MEMBER_ROWS
    });
    const leaked = items.filter(i => AD_NAMES.includes(i.name));
    assert.deepEqual(leaked, [],
      `AD 作用域的包不该下发给成员代理: ${leaked.map(i => i.name).join(', ')}`);
  });

  test('4. member 作用域的包一个不少地上线 (数量 = 3)', () => {
    const items = buildManifestItems({
      enabledRows: ALL_ENABLED_ROWS,
      memberRows: ALL_MEMBER_ROWS
    });
    assert.deepEqual(items.map(i => i.name).sort(), MEMBER_NAMES.slice().sort(),
      '成员代理应正好收到 3 个包');
  });

  test('5. 1:1 契约: 下发的每个包都满足客户端真谓词', () => {
    const items = buildManifestItems({
      enabledRows: ALL_ENABLED_ROWS,
      memberRows: ALL_MEMBER_ROWS
    });
    assert.ok(items.length > 0, '前置: 应该有包下发');
    for (const item of items) {
      assert.equal(shouldRunPackageForNonAd(item), true,
        `${item.name}: 服务端下发的东西客户端会拒收 —— 两端谓词不再 1:1`);
    }
  });

  test('6. 按主机禁用行 (enabled=0) 真的把那个包挡掉', () => {
    const rows = ALL_MEMBER_ROWS.map(r =>
      r.package_name === 'member_eventlog_collector' ? memberRow(r.package_name, 0) : r);
    const items = buildManifestItems({ enabledRows: ALL_ENABLED_ROWS, memberRows: rows });
    const names = items.map(i => i.name);
    assert.ok(!names.includes('member_eventlog_collector'),
      '被主机禁用的包不该下发');
    assert.equal(names.length, MEMBER_NAMES.length - 1);
  });

  test('7. 反证: 若中心端不送 scope ⇒ 客户端 0 通过 (复现原始症状)', () => {
    // 构造「修之前的服务端行为」: 水合时不带 scope。
    const items = buildManifestItems({
      enabledRows: ALL_ENABLED_ROWS,
      memberRows: ALL_MEMBER_ROWS
    }).map(i => {
      const { scope, ...rest } = i;
      return rest;
    });
    const passed = items.filter(shouldRunPackageForNonAd);
    assert.equal(passed.length, 0,
      '前置假设失效: 没有 scope 的话客户端本该一个都不收 (这正是 R161.21 的原始症状)');
    // ⇒ scope 是这条链上**唯一**的必需字段, 少一个字段就全灭。
  });

  test('8. 上线形态: intervalSec / timeoutMs 必须是数字 (agent 直接读这两个字段)', () => {
    const items = buildManifestItems({
      enabledRows: ALL_ENABLED_ROWS,
      memberRows: ALL_MEMBER_ROWS
    });
    for (const item of items) {
      assert.equal(typeof item.agent.intervalSec, 'number',
        `${item.name}: agent.intervalSec 必须是数字`);
      assert.equal(typeof item.agent.timeoutMs, 'number',
        `${item.name}: agent.timeoutMs 必须是数字`);
      assert.ok(item.agent.intervalSec > 0, `${item.name}: intervalSec 必须 > 0 (否则不会起定时器)`);
    }
  });

  test('9. 无按主机绑定行时, member 作用域的全局包仍应下发', () => {
    // 边界: 成员主机还没在 ad_member_server_packages 里绑任何包。
    // mergePackagesForHost 的 'global' 分支会把这些包带出来, 再由服务端
    // 的 scope 收口挑出 member 那 3 个 ⇒ 不能因为"没绑定"就 0 包。
    const items = buildManifestItems({ enabledRows: ALL_ENABLED_ROWS, memberRows: [] });
    assert.deepEqual(items.map(i => i.name).sort(), MEMBER_NAMES.slice().sort(),
      '没绑主机时也应下发 member 作用域的 3 个包');
    for (const item of items) {
      assert.equal(shouldRunPackageForNonAd(item), true,
        `${item.name}: 客户端会拒收`);
    }
  });
});
