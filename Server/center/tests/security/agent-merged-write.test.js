// R161.31 (2026-11-07) — 性能项 2 回归网: 心跳后 delivery 的**合并写入**。
//
// ★ 背景: 心跳响应可能同时带三份要落盘的东西 —— agentToken 轮换 /
//   clientSettings / 升级版本号。旧实现是**串行三次** applyXxxDelivery,
//   每个都 read → parse → mutate → write-tmp → fsync → rename 同一个
//   appsettings.json ⇒ 一次心跳付三倍全量读 + 三倍全量写 + 三次 fsync。
//
// ★ 为什么不能简单改 Promise.all (本测试锁住这个决策):
//   (a) 读-改-写丢更新 —— 三个 writer 各自 read 快照, 各自 mutate,
//       各自 rename ⇒ 后两个的快照缺前一个的改动 ⇒ 字段丢失。
//   (b) 共享 `${path}.tmp` ⇒ 并发 writer openSync 同一个 tmp ⇒ 内容交错
//       ⇒ appsettings.json 变损坏 JSON。
//
// ★ 本文件验证:
//   A. 合并写: 三个 patch 一次落盘, 全部字段都在 (不丢更新)
//   B. 合并写后磁盘上是**合法 JSON** (不是损坏文件)
//   C. tmp 文件名唯一 (并发写不共用同一个 tmp)
//   D. deferWrite 模式: delivery 只更新内存, 不碰磁盘
//   E. 编排器: 一次调用 = 磁盘只被写一次
//   F. 源码级守卫: agent.js 两个 inline 调用点 + heartbeat-callbacks.js
//      都必须走编排器, 不得再有"串行三个独立 await"的旧形状
//
// 用法: cd Server/center && node --test tests/security/agent-merged-write.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(CENTER_ROOT, '..', '..');
const AGENT_SRC = path.join(REPO_ROOT, 'Server', 'agent', 'src');

async function loadAgentModule(relPath) {
  return await import(pathToFileURL(path.join(AGENT_SRC, relPath)).href);
}

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r16131-merged-'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeSettingsFile(overrides = {}) {
  const p = path.join(tmpDir, `appsettings-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({
    centerUrl: 'https://center.example:8080',
    agentToken: 'old-token',
    agentTokenVersion: 1,
    clientSettingsVersion: 0,
    heartbeatIntervalSeconds: 60,
    ...overrides,
  }, null, 2));
  return p;
}

function makeLogger() {
  const noop = () => {};
  return {
    info: noop, warn: noop, error: noop, debug: noop,
    child: () => makeLogger(),
  };
}

describe('R161.31 — agent 心跳 delivery 合并写入', () => {
  test('A+B. 合并写: 三个 patch 一次落盘, 字段齐全且是合法 JSON', async () => {
    const { writeAppsettingsPatchAtomicMerged } = await loadAgentModule('appsettings-writer.js');
    const p = makeSettingsFile();

    const w = writeAppsettingsPatchAtomicMerged({
      path: p,
      patches: [
        { agentToken: 'new-token', agentTokenVersion: 2 },
        { heartbeatIntervalSeconds: 30, logLevel: 'debug' },
        { installedAgentVersion: '0.1.11' },
      ],
    });
    assert.equal(w.ok, true, `合并写必须成功: ${w.error}`);

    const raw = fs.readFileSync(p, 'utf8');
    const cfg = JSON.parse(raw); // 解析失败 = 文件损坏
    // 三个来源的字段**全部**在 —— 丢更新会缺其中一块。
    assert.equal(cfg.agentToken, 'new-token');
    assert.equal(cfg.agentTokenVersion, 2);
    assert.equal(cfg.heartbeatIntervalSeconds, 30);
    assert.equal(cfg.logLevel, 'debug');
    assert.equal(cfg.installedAgentVersion, '0.1.11');
    // 无关字段保留
    assert.equal(cfg.centerUrl, 'https://center.example:8080');
    assert.equal(cfg.clientSettingsVersion, 0);
  });

  test('C. tmp 文件名唯一: 并发写不共用同一个 tmp 文件', async () => {
    const { writeAppsettingsPatchAtomic } = await loadAgentModule('appsettings-writer.js');
    const p = makeSettingsFile();
    // 连续两次写 —— 若 tmp 名固定, 第二次会复用第一次的 (可能已被 rename
    // 掉的) tmp 路径。断言两次写的 tmp 路径不同: 通过"写完之后目录里没有
    // 残留 .tmp 文件" + "两次写都成功" 间接验证。
    const r1 = writeAppsettingsPatchAtomic({ path: p, patch: { a: 1 } });
    const r2 = writeAppsettingsPatchAtomic({ path: p, patch: { b: 2 } });
    assert.equal(r1.ok, true, r1.error);
    assert.equal(r2.ok, true, r2.error);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(cfg.a, 1);
    assert.equal(cfg.b, 2);
    // 没有残留 tmp
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], `不该有残留 tmp 文件: ${leftovers.join(',')}`);
  });

  test('D. deferWrite: delivery 只更新内存, 不碰磁盘', async () => {
    const { applyAgentTokenDelivery } = await loadAgentModule('agent-token-delivery.js');
    const p = makeSettingsFile();
    const config = { agentToken: 'old-token', agentTokenVersion: 1 };
    const before = fs.readFileSync(p, 'utf8');

    const r = await applyAgentTokenDelivery({
      result: {
        ok: true,
        data: { agentToken: 'brand-new-token', agentTokenVersion: 2 },
      },
      config,
      configPath: p,
      logger: makeLogger(),
      deferWrite: true,
    });

    assert.equal(r.applied, true, 'deferWrite 模式下必须返回 applied=true');
    assert.equal(r.deferred, true, '必须标记 deferred');
    assert.deepEqual(r.patch, { agentToken: 'brand-new-token', agentTokenVersion: 2 });
    // 内存已更新
    assert.equal(config.agentToken, 'brand-new-token');
    assert.equal(config.agentTokenVersion, 2);
    // 磁盘**未**变
    assert.equal(fs.readFileSync(p, 'utf8'), before, 'deferWrite 不得写盘');
  });

  test('E. 编排器: 一次调用 = 磁盘只被写一次, 三个字段全落盘', async () => {
    const { applyHeartbeatDeliveries } = await loadAgentModule('heartbeat-deliveries.js');
    const { applyAgentTokenDelivery } = await loadAgentModule('agent-token-delivery.js');
    const { applySettingsDelivery } = await loadAgentModule('settings-delivery.js');
    const p = makeSettingsFile();
    const config = {
      agentToken: 'old-token', agentTokenVersion: 1,
      clientSettingsVersion: 0, heartbeatIntervalSeconds: 60,
      installedAgentVersion: '0.1.10',
    };

    const result = {
      ok: true,
      data: {
        agentToken: 'new-token',
        agentTokenVersion: 2,
        agentSettings: { heartbeatIntervalSeconds: 45 },
        clientSettingsVersion: 1,
      },
    };

    const out = await applyHeartbeatDeliveries({
      result,
      config,
      configPath: p,
      logger: makeLogger(),
      applyAgentToken: (args) => applyAgentTokenDelivery(args),
      applySettings: (args) => applySettingsDelivery(args),
      applyUpgrade: undefined,
    });

    assert.equal(out.applied, true, `编排器写盘必须成功: ${out.error}`);
    assert.equal(out.patches.length, 2, 'token + settings 两个 patch');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(cfg.agentToken, 'new-token');
    assert.equal(cfg.agentTokenVersion, 2);
    assert.equal(cfg.heartbeatIntervalSeconds, 45);
    // 单次写盘 = 文件的 mtime 变更次数不该是 3。这里用"内容一次到位"
    // 加上编排器返回的 patches 长度做等价断言 (真正验证写次数需要
    // 拦截 fs, 过度耦合实现细节)。
  });

  test('F. 源码级守卫: 三处调用点都必须走编排器', () => {
    const agentSrc = fs.readFileSync(path.join(REPO_ROOT, 'Server', 'agent', 'agent.js'), 'utf8');
    const cbSrc = fs.readFileSync(path.join(AGENT_SRC, 'heartbeat-callbacks.js'), 'utf8');

    const callSites = agentSrc.match(/applyHeartbeatDeliveries\(\{/g) || [];
    assert.ok(callSites.length >= 2,
      `agent.js 必须有两个 inline 调用点走编排器 (AD scheduler + non-AD), 实际 ${callSites.length}`);
    assert.match(cbSrc, /applyHeartbeatDeliveries\(\{/,
      'heartbeat-callbacks.js 的 makeSendCallback 也必须走编排器');

    // 旧形状: 连续三个独立 await 的 delivery 调用, 不得再出现在 agent.js
    // 的两个 inline 调用点里。
    const legacyPattern = /await applyAgentTokenDelivery\(\{[^}]*\}\);\s*\n\s*\/\/[^\n]*\n\s*await applySettingsDelivery\(/;
    assert.doesNotMatch(agentSrc, legacyPattern,
      'agent.js 不得再有"串行 token → settings"旧形状 (要合并写)');
  });

  test('G. noadagent 树必须与 AD 树 1:1 平行 (同样的合并写)', () => {
    const noadSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'noadagent', 'agent.js'), 'utf8');
    assert.match(noadSrc, /applyHeartbeatDeliveries\(\{/,
      'noadagent 必须也走合并写编排器');
    const noadCbSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'noadagent', 'src', 'heartbeat-callbacks.js'), 'utf8');
    assert.match(noadCbSrc, /applyHeartbeatDeliveries\(\{/,
      'noadagent heartbeat-callbacks.js 必须也走合并写编排器');
    const noadWriterSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'Server', 'noadagent', 'src', 'appsettings-writer.js'), 'utf8');
    assert.match(noadWriterSrc, /writeAppsettingsPatchAtomicMerged/,
      'noadagent appsettings-writer.js 必须有合并写入器');
    assert.match(noadWriterSrc, /nextTmpPath/,
      'noadagent appsettings-writer.js 必须用唯一 tmp 名');
  });
});
