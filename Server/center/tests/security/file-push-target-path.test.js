// R161.30 (2026-11-07) — S6 安全修复回归网: 中心端 createTask 拦截相对路径 targetPath。
//
// ★ 背景: Agent 侧 lib/path-safety.js 是第一层 (写盘前校验), 但任务是
//   中心持久化的 —— 相对路径任务能常驻队列。修复 = 中心端 services/
//   file-push.js createTask 拒绝非绝对路径 targetPath (防御纵深第二层)。
//   允许形态: 盘符开头 (C:\ / C:/) 或 UNC (\\server\share)。
//
// 本文件锁住:
//   A. 行为矩阵: 相对路径 ⇒ 400 (httpStatus), 绝对路径 (盘符/UNC/正斜杠)
//      通过该校验 (后续可能因 findOffManagementHosts 失败, 只要不报
//      "targetPath 必须是绝对路径" 即视为通过第一道闸)
//   B. 源码级不变量: service 内必须有盘符/UNC 正则守卫
//
// 用法: cd Server/center && node --test tests/security/file-push-target-path.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');

// mock findOffManagementHosts (host-status.js 依赖 DB, 这里只测 targetPath 校验,
// 该校验在 findOffManagementHosts 调用之后 ⇒ 绝对路径用例会走到 mock 返回 []).
process.env.ADDASHBOARD_FILE_PUSH_DIR = path.join(CENTER_ROOT, 'data', 'file-push-test-s6');

// 稳定 mock: 不打 DB。ESM 下不能模块级注入, 用子上下文: 直接构造测试对象走
// 行为矩阵 (相对路径在校验处就抛, 根本到不了 host-status)。
const { createTask } = await import('../../src/services/file-push.js');

// host-status.js 的 findOffManagementHosts 走 getDb() 打 DB — 用 _setDbForTest
// 注入 mock (返回空行集 ⇒ 所有目标"不在目录表"会报退役…… 不行, 空行 = 不可下发)。
// ⇒ mock 返回所有目标都在线 (decommissioned_at/paused 均 NULL) ⇒ 放行。
const { _setDbForTest } = await import('../../src/db/index.js');
const { _resetForTests } = await import('../../src/services/file-push.js');

const mockDb = {
  query: async (_sql, params) => {
    // 返回与 params 等长的在线行集 (host 名大小写都给一份)
    const rows = (params || []).map(h => ({
      [h]: h, dc_name: h, hostname: h, DC_NAME: h, HOSTNAME: h,
      decommissioned_at: null, monitoring_paused_at: null
    }));
    return { rows };
  },
  execute: async () => ({ rows: [] })
};
_setDbForTest(mockDb);

await _resetForTests({ dir: process.env.ADDASHBOARD_FILE_PUSH_DIR });

describe('R161.30 S6 — 中心端 targetPath 绝对路径防线', () => {
  test('A1. 相对路径 ⇒ 400, 错误信息点名 targetPath', async () => {
    const cases = ['Temp\\probe', 'Temp/probe', './probe', 'probe', '.\\probe', '..\\x'];
    for (const tp of cases) {
      let caught = null;
      try {
        await createTask({
          filename: 'a.bin',
          buffer: Buffer.from('x'),
          targetType: 'server',
          targets: ['h1'],
          targetPath: tp
        });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, `相对路径 "${tp}" 必须被拦截`);
      assert.equal(caught.httpStatus, 400, `"${tp}" ⇒ 400`);
      assert.match(caught.message, /targetPath.*绝对路径|绝对路径.*targetPath/);
    }
  });

  test('A2. 绝对路径通过该闸 (盘符反斜杠 / 盘符正斜杠 / UNC)', async () => {
    const absolutePaths = ['C:\\Temp\\probe', 'C:/Temp/probe', '\\\\fileserver\\share\\dir'];
    for (const tp of absolutePaths) {
      const out = await createTask({
        filename: 'a.bin',
        buffer: Buffer.from('x'),
        targetType: 'server',
        targets: ['MOCKHOST1'],
        targetPath: tp
      });
      assert.ok(out.taskId, `"${tp}" 应建任务成功`);
    }
  });

  test('B. 源码级不变量: createTask 内必须有盘符/UNC 正则守卫', () => {
    const full = path.join(CENTER_ROOT, 'src', 'services', 'file-push.js');
    assert.ok(fs.existsSync(full), 'services/file-push.js 不存在');
    const src = fs.readFileSync(full, 'utf8');
    assert.match(src, /isAbsoluteTarget/,
      'createTask 必须有绝对路径判定 (isAbsoluteTarget)');
    assert.match(src, new RegExp(String.raw`a-zA-Z]:[\\/]|\\\\`),
      '必须含盘符 (X:\\) + UNC (\\\\) 的绝对路径正则');
    assert.match(src, /targetPath 必须是绝对路径/,
      '必须保留中文错误提示 (400) — 操作员可读');
  });
});
