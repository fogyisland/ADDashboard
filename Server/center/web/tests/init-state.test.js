// center/web/tests/init-state.test.js
// R159 重放 (2026-11-06) — 初始化状态闸门的回归网。
//
// 背景: R159 (2026-10-25) 的修复在 2026-10-26 的「并发会话覆写整树」事故中被
// 回滚 (main.js 回到裸 ls.startPolling(), router.js 回到自建 initStatusCache,
// 测试文件整个被删) ⇒ 向导期间前端重新开始打 /api/admin/* 端点 (404 噪音)。
// 本文件把当时的回归网重建出来, 并加了一条**源码级不变量**防止再次回滚。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.resetModules();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

function loadGate({ fetchImpl }) {
  return new Promise((resolve, reject) => {
    const mod = join(SRC, 'lib', 'initState.js');
    import(mod).then((m) => {
      resolve(m.createInitStateGate({ fetchImpl }));
    }).catch(reject);
  });
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

describe('A. createInitStateGate — 闸门矩阵', () => {
  it('A1. needsInit=true → known=true, polling 不允许', async () => {
    const calls = [];
    const gate = await loadGate({ fetchImpl: async (p) => { calls.push(p); return jsonResponse({ needsInit: true }); } });
    const state = await gate.getState();
    expect(state).toEqual({ known: true, needsInit: true });
    expect(calls).toEqual(['/api/init/status']);
  });

  it('A2. needsInit=false → polling 允许', async () => {
    const gate = await loadGate({ fetchImpl: async () => jsonResponse({ needsInit: false }) });
    const state = await gate.getState();
    expect(state).toEqual({ known: true, needsInit: false });
  });

  it('A3. 网络失败 → known=false (fail-closed), 且不缓存 (下次重试)', async () => {
    let attempts = 0;
    const gate = await loadGate({ fetchImpl: async () => { attempts++; throw new Error('boom'); } });
    const s1 = await gate.getState();
    expect(s1).toEqual({ known: false, needsInit: null });
    const s2 = await gate.getState();
    expect(attempts).toBe(2); // 失败不缓存 ⇒ 第二次真的重发了
  });

  it('A4. 形状异常 (缺 needsInit / 非对象) → 当"状态未知", 不缓存', async () => {
    let flip = false;
    const gate = await loadGate({ fetchImpl: async () => { flip = !flip; return flip ? jsonResponse({ hello: 1 }) : jsonResponse({ needsInit: false }); } });
    const s1 = await gate.getState();
    expect(s1.known).toBe(false);
    const s2 = await gate.getState();
    expect(s2).toEqual({ known: true, needsInit: false });
  });

  it('A5. HTTP 500 → 失败处理 (不缓存)', async () => {
    const gate = await loadGate({ fetchImpl: async () => jsonResponse({ needsInit: false }, 500) });
    const s = await gate.getState();
    expect(s.known).toBe(false);
  });

  it('A6. single-flight — 并发调用只发一次请求', async () => {
    let calls = 0;
    const gate = await loadGate({ fetchImpl: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return jsonResponse({ needsInit: false }); } });
    await Promise.all([gate.getState(), gate.getState(), gate.getState()]);
    expect(calls).toBe(1);
  });

  it('A7. reset() 后重新拉取', async () => {
    let calls = 0;
    const gate = await loadGate({ fetchImpl: async () => { calls++; return jsonResponse({ needsInit: false }); } });
    await gate.getState();
    gate.reset();
    await gate.getState();
    expect(calls).toBe(2);
  });
});

describe('B. 端到端模拟 — init 期间 0 个 admin 端点被调用', () => {
  it('B1. needsInit=true 时 main.js 的启动逻辑一个 admin 轮询都不该起', async () => {
    // 模拟 main.js 的 ensureBackgroundPolls 决策: gate 说"不允许" → startPolling 不被调。
    const started = [];
    const gate = await loadGate({ fetchImpl: async () => jsonResponse({ needsInit: true }) });
    const state = await gate.getState();
    // 这里复刻 main.js 的判定 (不真 import main.js — 那会拉起整个 Vue app)
    const { isBackgroundPollingAllowed } = await import(join(SRC, 'lib', 'initState.js'));
    if (isBackgroundPollingAllowed(state)) started.push('license');
    expect(started).toEqual([]);
  });

  it('B2. needsInit=false 时轮询允许', async () => {
    const { isBackgroundPollingAllowed } = await import(join(SRC, 'lib', 'initState.js'));
    const gate = await loadGate({ fetchImpl: async () => jsonResponse({ needsInit: false }) });
    const state = await gate.getState();
    expect(isBackgroundPollingAllowed(state)).toBe(true);
  });
});

describe('C. 源码级不变量 — 防「并发覆写」再次回滚 R159', () => {
  const read = (p) => readFileSync(join(SRC, p), 'utf8');

  it('C1. main.js 顶层不许裸 ls.startPolling() (必须经 ensureBackgroundPolls 闸门)', () => {
    const src = read('main.js');
    // 顶层裸调用 = 行首无缩进的 ls.startPolling()
    expect(/\nls\.startPolling\(\)/.test(src)).toBe(false);
    expect(src).toContain('ensureBackgroundPolls');
    expect(src).toContain('isBackgroundPollingAllowed');
  });

  it('C2. main.js 三轮询启动必须被闸门包住 (license/flags/inapp/timezone 都在闸门里)', () => {
    const src = read('main.js');
    const gateBlock = src.slice(src.indexOf('function ensureBackgroundPolls'), src.indexOf('ensureBackgroundPolls();'));
    for (const fn of ['ls.startPolling()', 'startFlagsPolling()', 'startInappPolling()', 'loadServerTimezone()']) {
      expect(gateBlock).toContain(fn);
    }
  });

  it('C3. router.js 不许自建 initStatusCache (必须用共享单例)', () => {
    const src = read('router.js');
    expect(src).not.toMatch(/let initStatusCache/);
    expect(src).toContain("from './lib/initState.js'");
  });

  it('C4. client.js 的 401 白名单必须含 system-alerts/since', () => {
    const src = read('api/client.js');
    expect(src).toContain('/api/admin/system-alerts/since');
  });

  it('C5. lib/initState.js 存在且导出闸门 API', () => {
    const src = read('lib/initState.js');
    for (const sym of ['createInitStateGate', 'getInitState', 'resetInitState', 'isBackgroundPollingAllowed']) {
      expect(src).toContain(`export function ${sym}`);
    }
  });
});
