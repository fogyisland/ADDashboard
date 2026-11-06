// R161.9 (2026-10-26) — Agent 令牌"缩写"恒不变的回归网
//
// ★ 本轮修的现场 (操作员原话):
//   「当前agent 令牌中的 代码缩写似乎不会发生变化」
//
// ★ 根因:
//   ConfigView.vue 的 maskToken() 直接 `return 'a3f9'` —— 一个**硬编码常量**。
//   界面上的 "…a3f9" 看着像令牌片段，实际与生效令牌**毫无关系**：生成多少次
//   新令牌它都不变。操作员看到这行无法判断"这一行显示的是不是当前生效的
//   那一枚令牌"。
//   (注: 早期把原因记成"服务端不回明文所以前端只能瞎编"是不准确的 ——
//    服务端 getAgentTokenState() 本来就拿到了完整令牌，只是路由没往外发。)
//
// ★ 修法与**为什么不用"尾部 4 位明文"**:
//   后者虽密码学上可忽略(16 bit / 384 bit)，但它把**凭据材料**从"有审计的
//   reveal 路径"搬到"无审计的 state 路径"，违反本项目"凡是读凭据材料必留
//   审计"的契约 (REVEAL_AUDIT + audit-classifier.js 高危分类) ⇒ 方向错误。
//   改用**指纹** = sha256(令牌) 前 8 位：对 384-bit 随机的令牌不可逆，不属于
//   凭据材料，可以安全待在无审计的读路径上；语义同 SSH/GPG key fingerprint。
//
// ★ 本文件锁住的契约:
//   A. 指纹函数本身的性质: 长度 / 确定性 / 随令牌变化 / **不含明文片段**。
//   B. 黄金值: 锁定 sha256 + 截断长度 (两端算法漂移会立刻红)。
//   C. 前端不再有硬编码缩写, 且**不在前端自己算哈希** (单一真源在服务端)。
//   D. 路由把指纹接到响应里 (接线点存在, 别被重构掉)。
//
// 用法: cd Server/center && node --test tests/agent-token-fingerprint.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { fingerprintAgentToken } from '../src/services/agent-token.js';
import { stripJsComments } from './helpers/strip-comments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// 静态断言必须针对**代码**，不是注释 —— 本文件自己在 ConfigView.vue 里
// 留了"这里以前返回硬编码常量 'a3f9'"的说明性注释，不剥注释会把注释当成
// 代码而误报。（helpers/strip-comments.js 剥行注释/块注释/HTML 注释，
//  字符串字面量内容原样保留。）
const readSrc = (rel) => stripJsComments(fs.readFileSync(path.join(here, '..', rel), 'utf8'));

const FIXED_TOKEN = 'a'.repeat(96);            // 真实令牌 = 48 字节 = 96 hex
const GOLDEN = 'ee4caa55';                      // sha256(FIXED_TOKEN) 前 8 位

describe('A. fingerprintAgentToken 的性质', () => {
  test('空值 / 非字符串 ⇒ 空串（不抛异常，不返回 undefined）', () => {
    assert.equal(fingerprintAgentToken(''), '');
    assert.equal(fingerprintAgentToken(null), '');
    assert.equal(fingerprintAgentToken(undefined), '');
    assert.equal(fingerprintAgentToken(12345), '');
    assert.equal(fingerprintAgentToken({}), '');
  });

  test('输出恰好 8 个小写十六进制字符', () => {
    const fp = fingerprintAgentToken(FIXED_TOKEN);
    assert.equal(fp.length, 8);
    assert.match(fp, /^[0-9a-f]{8}$/);
  });

  test('同一令牌 ⇒ 同一指纹（确定性）', () => {
    assert.equal(fingerprintAgentToken(FIXED_TOKEN), fingerprintAgentToken(FIXED_TOKEN));
  });

  test('★ 令牌一变，指纹就变 —— 这正是操作员要的那件事', () => {
    const tokenA = 'a'.repeat(96);
    const tokenB = 'b'.repeat(96);
    assert.notEqual(fingerprintAgentToken(tokenA), fingerprintAgentToken(tokenB));
    // 连"只差一位"的两个令牌也必须给出不同指纹
    const tokenC = 'a'.repeat(95) + 'c';
    assert.notEqual(fingerprintAgentToken(tokenA), fingerprintAgentToken(tokenC));
  });

  test('★ 指纹不包含令牌的任何明文片段（证明它不是"尾部几位"）', () => {
    const token = 'deadbeef' + '0123456789abcdef'.repeat(4) + 'cafebabe';
    const fp = fingerprintAgentToken(token);
    // 令牌尾部 4 位
    assert.notEqual(fp, token.slice(-4));
    // 令牌尾部 8 位
    assert.notEqual(fp, token.slice(-8));
    // 指纹里不含令牌末 4 位这串字符
    assert.equal(fp.includes(token.slice(-4)), false);
    // 指纹里不含令牌的任何 4 位连续子串（96 位令牌 ⇒ 93 个窗口）
    for (let i = 0; i + 4 <= token.length; i++) {
      const window = token.slice(i, i + 4);
      if (window === fp) continue; // 4 个 hex 字符恰好相等的概率极低，但不为 0
      assert.equal(fp.includes(window), false, `指纹泄露了令牌子串 ${window}`);
    }
  });

  test('指纹与"尾部 4 位"不是同一个东西（防止有人改回明文片段）', () => {
    // 构造一个尾部 4 位 = 指纹的令牌是不现实的（需要预知 sha256），
    // 但可以断言两者在**语义上**是不同的量：改令牌尾部 ⇒ 尾部变、指纹也变；
    // 而"尾部"这个概念根本不在实现里 —— 实现只依赖 sha256。
    assert.equal(fingerprintAgentToken(FIXED_TOKEN), GOLDEN);
  });
});

describe('B. 黄金值（锁定算法与截断长度）', () => {
  test('sha256 前 8 位 —— 两端算法漂移会红', () => {
    const expected = createHash('sha256').update(FIXED_TOKEN, 'utf8').digest('hex').slice(0, 8);
    assert.equal(expected, GOLDEN);
    assert.equal(fingerprintAgentToken(FIXED_TOKEN), GOLDEN);
  });

  test('长度变化会改变黄金值 ⇒ 截断长度被真正锁住', () => {
    assert.notEqual(GOLDEN, createHash('sha256').update(FIXED_TOKEN, 'utf8').digest('hex').slice(0, 6));
    assert.notEqual(GOLDEN, createHash('sha256').update(FIXED_TOKEN, 'utf8').digest('hex').slice(0, 12));
  });
});

describe('C. 前端不再有硬编码缩写，且不在前端算哈希', () => {
  const vue = readSrc('web/src/views/admin/ConfigView.vue');

  test('★ 硬编码的 "a3f9" 必须消失', () => {
    assert.equal(vue.includes("'a3f9'"), false, 'ConfigView.vue 仍返回硬编码缩写');
    assert.equal(vue.includes('"a3f9"'), false, 'ConfigView.vue 仍返回硬编码缩写');
  });

  test('maskToken() 必须读服务端下发的 tokenFingerprint', () => {
    assert.match(vue, /tokenState\.value\.tokenFingerprint/,
      'maskToken() 没有使用 tokenState.tokenFingerprint');
  });

  test('★ 前端不得自己算哈希（单一真源在服务端，避免两端算法漂移）', () => {
    assert.equal(/createHash|require\(['"]crypto['"]\)|from ['"]crypto['"]|crypto\.subtle/.test(vue), false,
      '前端出现本地哈希实现 —— 指纹必须由服务端算');
  });

  test('tokenState 初始形状含 tokenFingerprint 字段', () => {
    assert.match(vue, /tokenFingerprint:\s*''/,
      'tokenState 初始值缺 tokenFingerprint');
  });
});

describe('D. 路由接线（指纹真的发到前端了）', () => {
  const admin = readSrc('src/routes/admin.js');

  test('GET /api/admin/agent-token 的响应带 tokenFingerprint', () => {
    assert.match(admin, /tokenFingerprint:\s*fingerprintAgentToken\(s\.current\)/,
      '路由没有把指纹接进响应');
  });

  test('路由 import 了 fingerprintAgentToken', () => {
    assert.match(admin, /import\s*\{[^}]*fingerprintAgentToken[^}]*\}\s*from\s*'\.\.\/services\/agent-token\.js'/,
      'admin.js 没有 import fingerprintAgentToken');
  });

  test('★ 该读路径不得回传令牌明文片段（否则又变成"凭据材料出无审计路径"）', () => {
    // 取 GET /api/admin/agent-token 这个 handler 的文本块，断言里面没有
    // 直接把 s.current 放进响应。
    const start = admin.indexOf("r.get('/api/admin/agent-token'");
    assert.notEqual(start, -1, '找不到 GET /api/admin/agent-token 路由');
    const end = admin.indexOf("r.get('/api/admin/agent-token/reveal'", start);
    const block = admin.slice(start, end === -1 ? start + 2000 : end);
    assert.equal(/token:\s*s\.current/.test(block), false,
      'state 路由里回传了令牌明文');
    assert.equal(/current:\s*s\.current/.test(block), false,
      'state 路由里回传了令牌明文');
  });
});
