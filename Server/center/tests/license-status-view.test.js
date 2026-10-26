// R161.7 (2026-10-26) — 许可证状态视图的回归网
//
// ★ 本轮修的现场 (operator 2026-10-26 原话):
//   「当前默认安装后的本地送 30 的激活状态没有显示, 是不需要还是没有激活呢?」
//
// ★ 根因 (三个缺陷叠在一起, 只修一个都留残症状):
//   ① 许可证页「当前许可证状态」卡片**只读 localStorage** (base32_status_v1)
//      —— 那是"本浏览器曾成功录入过 base32 激活"的本地回显, 不是激活事实。
//      ⇒ 换浏览器 / 清缓存 ⇒ 明明激活过也显示「未激活」(假阴性)。
//   ② 默认安装自动授予的 **30 天试用** (服务端 TRIAL_DAYS=30, installed_at 锚点,
//      在 license-state envelope 的 trial 字段里) **根本没被呈现** ——
//      卡片只认 base32 激活, 于是"本地送 30"这件事在许可证页上不存在。
//   ③ 服务端 DB 异常时 (status='unknown') 若照抄 has_license:false, 会把
//      "查不到"显示成"未激活" —— 谎报事实。
//
// ★ 本文件锁住的契约:
//   A. 判定优先级只有**一处**定义 (web/src/lib/licenseStatus.js), 5 种状态
//      逐格断言 (服务端已激活 / 试用中 / 试用过期 / 服务端未知 / 端点挂)。
//   B. 服务端 = 激活事实的真源; localStorage 只补服务端给不出的字段 (掩码密钥)。
//   C. LicenseView.vue 必须走公共实现 + 必须把试用与正式授权**分别**呈现,
//      且**不许**再拿 localStorage 当状态徽标的唯一判据。
//
// 用法: cd Server/center && node --test tests/license-status-view.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLicenseView } from '../web/src/lib/licenseStatus.js';
import { stripJsComments } from './helpers/strip-comments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..');
const LICENSE_VIEW = path.join(
  CENTER_ROOT, 'web', 'src', 'views', 'admin', 'systemSettings', 'LicenseView.vue'
);

/** 服务端 envelope 工厂 —— 形状跟 src/services/license-state.js 1:1 对齐. */
function serverState(overrides = {}) {
  return {
    has_license: false,
    status: 'none',
    should_redirect: false,
    days_remaining: null,
    days_until_warning: 30,
    expires_at: null,
    instance_id: null,
    license_kind: null,
    license_id: null,
    trial: {
      active: true,
      days_total: 30,
      days_remaining: 20,
      started_at: '2026-10-01',
      expires_at: '2026-10-31',
      date_source: 'appsettings_installedAt',
      pinned: true
    },
    quota: null,
    ...overrides
  };
}

describe('R161.7 — 许可证状态视图 (服务端真源 + 30 天试用可见)', () => {
  test('1. 服务端已激活 ⇒ 徽标「已激活」, 试用被正式授权覆盖', () => {
    const v = resolveLicenseView({
      serverState: serverState({
        has_license: true,
        status: 'active',
        expires_at: '2027-10-26 12:00:00',
        instance_id: 'inst-1',
        license_kind: 'base32',
        days_remaining: 365,
        trial: { active: false, days_total: 30, days_remaining: null, expires_at: null }
      }),
      localStatus: null
    });
    assert.equal(v.hasLicense, true);
    assert.equal(v.badge.text, '已激活');
    assert.equal(v.badge.cls, 'active');
    assert.equal(v.serverKnown, true);
    // 详情行取服务端字段
    assert.equal(v.detail.expires_at, '2027-10-26 12:00:00');
    assert.equal(v.detail.instance_id, 'inst-1');
    assert.equal(v.detail.license_kind, 'base32');
  });

  test('2. 未激活但试用中 ⇒ 徽标带试用剩余天数 (不是「未激活」)', () => {
    const v = resolveLicenseView({
      serverState: serverState({ has_license: false, status: 'none' }),
      localStatus: null
    });
    assert.equal(v.hasLicense, false);
    assert.equal(v.trialKnown, true);
    assert.equal(v.daysRemaining, 20);
    assert.equal(v.badge.text, '试用中 · 剩 20 天');
    assert.equal(v.badge.cls, 'trial');
    // 试用到期日要能呈现 (操作员要看到"到哪天")
    assert.equal(v.trial.expires_at, '2026-10-31');
  });

  test('3. 试用已过期 ⇒ 徽标「试用已过期 N 天」, 0 静默', () => {
    const v = resolveLicenseView({
      serverState: serverState({
        has_license: false,
        status: 'none',
        trial: { active: false, days_total: 30, days_remaining: -5, expires_at: '2026-10-21' }
      }),
      localStatus: null
    });
    assert.equal(v.trialKnown, true);
    assert.equal(v.daysRemaining, -5);
    assert.equal(v.badge.text, '试用已过期 5 天');
    assert.equal(v.badge.cls, 'expired');
  });

  test('4. 服务端 status=unknown (DB 挂) ⇒ 「状态未知」, 0 谎报「未激活」', () => {
    const v = resolveLicenseView({
      serverState: serverState({ has_license: false, status: 'unknown' }),
      localStatus: null
    });
    assert.equal(v.serverKnown, false, 'unknown ⇒ 服务端状态不可信');
    assert.equal(v.hasLicense, false);
    assert.equal(v.badge.text, '状态未知');
    // trial 不依赖 DB, 照样能显示
    assert.equal(v.trialKnown, true);
    assert.equal(v.daysRemaining, 20);
  });

  test('5. 端点挂 (服务端 envelope 缺失) ⇒ 回落 localStorage, 0 谎报', () => {
    // 5a. 本地有激活记录 ⇒ 回落「已激活」(旧行为, 不回归)
    const withLocal = resolveLicenseView({
      serverState: null,
      localStatus: { has_license: true, license_key_masked: 'AAAAA-BBBBB-CCCCC' }
    });
    assert.equal(withLocal.hasLicense, true);
    assert.equal(withLocal.badge.text, '已激活');
    assert.equal(withLocal.serverKnown, false);
    assert.equal(withLocal.trialKnown, false, '端点挂 ⇒ 试用未知, 不假装有试用');

    // 5b. 本地也没有 ⇒ 「状态未知」(0 谎报「未激活」: 端点挂了不等于没授权)
    const bare = resolveLicenseView({ serverState: null, localStatus: null });
    assert.equal(bare.hasLicense, false);
    assert.equal(bare.badge.text, '状态未知');
    assert.equal(bare.badge.cls, 'inactive');
  });

  test('6. 详情行: 服务端字段优先, localStorage 补服务端给不出的字段', () => {
    // 服务端只有 hash, 存不了明文 ⇒ 掩码密钥只能来自本地回显
    const v = resolveLicenseView({
      serverState: serverState({
        has_license: true,
        status: 'active',
        expires_at: '2027-01-01 00:00:00',
        instance_id: 'inst-server',
        license_kind: 'base32'
      }),
      localStatus: {
        has_license: true,
        license_key_masked: 'XXXXX-YYYYY-ZZZZZ',
        activated_at: '2026-10-26T08:00:00.000Z',
        expires_at: '2020-01-01 00:00:00'
      }
    });
    assert.equal(v.detail.instance_id, 'inst-server', '服务端字段优先');
    assert.equal(v.detail.expires_at, '2027-01-01 00:00:00', '服务端字段优先');
    assert.equal(v.detail.license_key_masked, 'XXXXX-YYYYY-ZZZZZ', '掩码密钥由本地补');
    assert.equal(v.detail.activated_at, '2026-10-26T08:00:00.000Z', '激活时间由本地补');
  });

  test('7. 未激活时不产出详情 (0 拿陈旧本地缓存冒充激活事实)', () => {
    const v = resolveLicenseView({
      serverState: serverState({ has_license: false, status: 'none' }),
      localStatus: { has_license: true, license_key_masked: 'STALE-KEY-XXXXX' }
    });
    assert.equal(v.hasLicense, false, '服务端说没激活就是没激活 (本地缓存是陈旧的)');
    assert.equal(v.badge.text, '试用中 · 剩 20 天');
  });

  test('8. LicenseView.vue 必须走公共实现 + 分别呈现试用与正式授权', () => {
    const raw = fs.readFileSync(LICENSE_VIEW, 'utf8');
    const src = stripJsComments(raw);

    // 8a. 必须 import 并调用公共实现
    assert.match(src, /import\s*\{\s*resolveLicenseView\s*\}\s*from\s*['"][^'"]*lib\/licenseStatus\.js['"]/,
      'LicenseView.vue 必须从 web/src/lib/licenseStatus.js 导入 resolveLicenseView');
    assert.match(src, /resolveLicenseView\(\{/,
      'LicenseView.vue 必须调用 resolveLicenseView (0 在组件里内联判定)');

    // 8b. 必须把服务端 envelope 整包存下来 (0 只取 quota 丢掉 has_license/trial)
    assert.match(src, /licenseState\.value\s*=\s*s\s*\?\?\s*null/,
      '必须把 license-state envelope 整包存进 licenseState');
    assert.match(src, /adminApi\.getLicenseState\(\)/,
      '必须调 license-state 端点拿服务端真源');

    // 8c. 模板必须分别呈现「正式授权」与「本地试用」两行
    assert.match(raw, /data-test="lic-license-row"/, '模板必须有「正式授权」行');
    assert.match(raw, /data-test="lic-trial-row"/, '模板必须有「本地试用」行');
    assert.match(raw, /days_remaining|daysRemaining/, '模板必须呈现试用剩余天数');

    // 8d. 状态徽标不许再拿 localStorage 当唯一判据
    assert.doesNotMatch(src,
      /base32Status\?\.has_license\s*\?\s*'active'\s*:\s*'inactive'/,
      '状态徽标不许再由 base32Status (localStorage) 单独决定 —— 那是换浏览器就失效的假阴性');
    assert.doesNotMatch(src, /base32Status\?\.has_license\s*\?\s*'已激活'\s*:\s*'未激活'/,
      '状态徽标文案不许再由 localStorage 单独决定');
  });

  test('9. 后端 envelope 的 trial 字段名必须与前端判定一致', () => {
    // 前端读 trial.days_remaining / trial.expires_at / trial.active;
    // 后端 license-state.js 必须真的产出这 3 个字段名, 否则前端永远拿不到试用信息.
    const serverSrc = fs.readFileSync(
      path.join(CENTER_ROOT, 'src', 'services', 'license-state.js'), 'utf8');
    for (const field of ['days_remaining', 'expires_at', 'active', 'days_total']) {
      assert.ok(serverSrc.includes(`${field}:`),
        `后端 license-state.js 的 trial envelope 必须有 ${field} 字段`);
    }
    // 试用天数常量 = 30 (operator 说的"送 30")
    assert.match(serverSrc, /const\s+TRIAL_DAYS\s*=\s*30\s*;/,
      'TRIAL_DAYS 必须仍是 30 天 (operator 的"本地送 30")');
  });
});
