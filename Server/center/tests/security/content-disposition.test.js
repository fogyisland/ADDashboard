// R161.30 (2026-11-07) — S5 安全修复回归网: Content-Disposition filename 注入。
//
// ★ 背景: 3 个下载端点直接 `filename="${raw}"` 进响应头 —— 任务名含
//   双引号可注入任意 disposition 参数, 含 CR/LF 可拆分 HTTP 响应。
//   修复 = 共用 src/utils/content-disposition.js 的
//   contentDispositionFilename()。
//
// 本文件锁住:
//   A. 纯函数行为矩阵 (转义 / 剥控制字符 / 兜底)
//   B. 源码级不变量: 3 个调用点必须全部走 helper, 不许再内联
//
// 用法: cd Server/center && node --test tests/security/content-disposition.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentDispositionFilename } from '../../src/utils/content-disposition.js';
import { stripJsComments } from '../helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');

describe('R161.30 S5 — Content-Disposition filename 注入防线', () => {
  test('A1. 双引号与反斜杠按 RFC 6266 转义', () => {
    assert.equal(contentDispositionFilename('p.sh" ; evil="x'), 'p.sh\\" ; evil=\\"x');
    assert.equal(contentDispositionFilename('a\\b.txt'), 'a\\\\b.txt');
  });

  test('A2. CR / LF / NUL / 控制字符 / DEL 全部剥掉', () => {
    assert.equal(contentDispositionFilename('a\r\nX-Injected: 1\r\nb'), 'aX-Injected: 1b');
    assert.equal(contentDispositionFilename('n\0ul'), 'nul');
    assert.equal(contentDispositionFilename('tab\there'), 'tabhere');
    assert.equal(contentDispositionFilename('del\x7f'), 'del');
  });

  test('A3. 空 / 非字符串 / 全剥空 ⇒ 兜底 file', () => {
    assert.equal(contentDispositionFilename(''), 'file');
    assert.equal(contentDispositionFilename(undefined), 'file');
    assert.equal(contentDispositionFilename(null), 'file');
    assert.equal(contentDispositionFilename(42), '42');
    assert.equal(contentDispositionFilename('\r\n'), 'file', '全控制字符剥光后兜底');
  });

  test('A4. 正常文件名零变化 (幂等不改好名字)', () => {
    assert.equal(contentDispositionFilename('report.csv'), 'report.csv');
    assert.equal(contentDispositionFilename('备份-文件 2026.sql'), '备份-文件 2026.sql');
  });

  test('B. 3 个下载端点必须全部走 helper, 不许内联 raw 拼接', () => {
    const sites = [
      { rel: 'src/routes/file-push.js', must: /contentDispositionFilename\(t\.filename\)/ },
      { rel: 'src/routes/agent.js', must: /contentDispositionFilename\(t\.filename\)/ },
      { rel: 'src/routes/admin.js', must: /contentDispositionFilename\(filename\)/ }
    ];
    for (const site of sites) {
      const full = path.join(CENTER_ROOT, site.rel);
      assert.ok(fs.existsSync(full), `调用点文件不存在: ${site.rel}`);
      const src = stripJsComments(fs.readFileSync(full, 'utf8'));
      assert.match(src, site.must, `${site.rel} 没走 contentDispositionFilename helper`);
      // 负向: 不许再出现内联的裸 `${...}` 拼进 filename (helper 调用除外)
      assert.doesNotMatch(src, /filename="\$\{(?!contentDispositionFilename)/,
        `${site.rel} 还有内联 filename 拼接 — 请改用 src/utils/content-disposition.js`);
    }
  });
});
