// R161.24 — Office 365 / Microsoft 365 SMTP 通道的回归网
//
// ── 现场根因 (operator 原话:「配置的时候发现不支持 office365 的邮件发送」) ──
//   Microsoft 自 2023 年起对 Exchange Online **默认关闭 SMTP AUTH**（基础
//   认证 user/password）。新建租户默认就是关的 ⇒ 主机/端口/用户名/密码
//   **全都填对**也一定失败, 典型报错:
//       535 5.7.139 Authentication unsuccessful,
//            SmtpClientAuthentication is disabled for this mailbox
//   而旧实现的 transport 只认 `auth: {user, pass}` 这**一种**认证方式 ⇒
//   现代 M365 根本没有可用的路径。
//
//   叠加三个坑:
//     (a) smtp_port 出厂默认 **25** —— Microsoft 默认封禁 25 端口。
//     (b) 587 = STARTTLS, 465 = 隐式 TLS。旧实现只映射 `smtp_secure` →
//         nodemailer `secure`（隐式 TLS）, **没有 STARTTLS 概念** ⇒ 在 587
//         上勾了 SSL/TLS 必然连不上。
//     (c) 没有超时 ⇒ 对端不回 220 时长时间卡死, 现场表现是"邮件发不出去、
//         日志什么都没有"。
//
// ── 本文件锁定 8 件事 (全部离线: 不连数据库, 不开 socket) ────────────────
//   1. buildSmtpBundle 只透出 smtp_* 白名单 (整张 system_config 不能直接
//      喂给 nodemailer)
//   2. 密码认证的 transport 参数与旧实现**逐字等价** (0 回归)
//   3. OAuth2 认证产出 nodemailer 认的形状 (type:'OAuth2' + accessUrl +
//      customParams.scope)
//   4. 令牌端点按租户拼成 Microsoft v2.0 —— 绝不落到 nodemailer 自带的
//      Google 默认值上
//   5. requireTLS 只在「明文起始」时生效 (465 上要求 STARTTLS 自相矛盾)
//   6. 超时被夹到 [5, 600] 秒
//   7. validateSmtpConfig 把「必然连不上」判成 error, 其余判成 warning
//      —— 不能把能用的自建配置误伤成不可保存
//   8. 机密键的掩码覆盖 4 个键 (含 OAuth2 三件套)
//
// 用法: cd Server/center && node --test tests/email-smtp-transport.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SMTP_AUTH_PASSWORD,
  SMTP_AUTH_OAUTH2,
  SMTP_CONFIG_KEYS,
  SMTP_SECRET_CONFIG_KEYS,
  SMTP_SECRET_MASK,
  DEFAULT_SMTP_PORT,
  DEFAULT_SMTP_TIMEOUT_SECONDS,
  MIN_SMTP_TIMEOUT_SECONDS,
  MAX_SMTP_TIMEOUT_SECONDS,
  DEFAULT_OAUTH_SCOPE,
  buildSmtpBundle,
  buildTransportOptions,
  buildMicrosoftTokenUrl,
  validateSmtpConfig,
  clampSmtpTimeoutSeconds,
  maskSmtpSecretsForRead
} from '../src/services/smtp-transport.js';

// ── 1. buildSmtpBundle ────────────────────────────────────────────────────

describe('R161.24 buildSmtpBundle', () => {
  test('只透出 smtp_* 白名单, 整张 system_config 的其它键被挡掉', () => {
    const bundle = buildSmtpBundle({
      smtp_host: 'smtp.office365.com',
      smtp_port: '587',
      smtp_user: 'ops@corp.com',
      // 这些**绝不能**进入 transport options
      access_domain: 'dashboard.corp.com',
      jwt_secret_current: 'super-secret-jwt',
      ad_bind_password: 'ldap-secret',
      agent_token_current: 'agent-token'
    });
    assert.equal(bundle.smtp_host, 'smtp.office365.com');
    assert.equal(bundle.smtp_port, '587');
    assert.equal(bundle.smtp_user, 'ops@corp.com');
    assert.equal(bundle.access_domain, undefined);
    assert.equal(bundle.jwt_secret_current, undefined);
    assert.equal(bundle.ad_bind_password, undefined);
    assert.equal(bundle.agent_token_current, undefined);
  });

  test('smtp_from 在白名单里 (投递链路用它当 from)', () => {
    const bundle = buildSmtpBundle({ smtp_from: 'ops@corp.com', other: 'x' });
    assert.equal(bundle.smtp_from, 'ops@corp.com');
  });

  test('非对象 / 空输入 ⇒ 空 bundle, 不抛', () => {
    assert.deepEqual(buildSmtpBundle(null), {});
    assert.deepEqual(buildSmtpBundle(undefined), {});
    assert.deepEqual(buildSmtpBundle('not-an-object'), {});
    assert.deepEqual(buildSmtpBundle({}), {});
  });

  test('白名单里的每个键都能被透出 (防"加了键忘了进白名单")', () => {
    const input = {};
    for (const key of SMTP_CONFIG_KEYS) input[key] = `v-${key}`;
    const bundle = buildSmtpBundle(input);
    for (const key of SMTP_CONFIG_KEYS) {
      assert.equal(bundle[key], `v-${key}`, `键 ${key} 应当在 bundle 里`);
    }
  });
});

// ── 2. 密码认证: 与旧实现逐字等价 ─────────────────────────────────────────

describe('R161.24 buildTransportOptions — 密码认证 (0 回归)', () => {
  test('host/port/secure/auth.user/auth.pass 与旧实现一致', () => {
    const opts = buildTransportOptions({
      smtp_host: 'smtp.qq.com',
      smtp_port: '465',
      smtp_secure: 'true',
      smtp_user: 'a@b.com',
      smtp_password: 'pw'
    });
    assert.equal(opts.host, 'smtp.qq.com');
    assert.equal(opts.port, 465);
    assert.equal(opts.secure, true);
    assert.deepEqual(opts.auth, { user: 'a@b.com', pass: 'pw' });
  });

  test("smtp_secure='false' ⇒ secure=false (Boolean('false') 那个坑不能再踩)", () => {
    const opts = buildTransportOptions({
      smtp_host: 'h', smtp_port: '587', smtp_secure: 'false', smtp_user: 'u', smtp_password: 'p'
    });
    assert.equal(opts.secure, false);
  });

  test('smtp_secure 未配置 ⇒ secure=false (老库没有这个键)', () => {
    const opts = buildTransportOptions({ smtp_host: 'h', smtp_port: '25', smtp_user: 'u' });
    assert.equal(opts.secure, false);
  });

  test('没有用户名 ⇒ 不带 auth (匿名中继, 保留旧行为)', () => {
    const opts = buildTransportOptions({ smtp_host: 'h', smtp_port: '25' });
    assert.equal(opts.auth, undefined);
  });

  test('端口是数字 (旧实现把字符串直接透传)', () => {
    const opts = buildTransportOptions({ smtp_host: 'h', smtp_port: '587' });
    assert.equal(typeof opts.port, 'number');
    assert.equal(opts.port, 587);
  });

  test('端口非法 ⇒ 落回默认 25 (不抛, 让 validate 去报错)', () => {
    assert.equal(buildTransportOptions({ smtp_host: 'h', smtp_port: 'abc' }).port, DEFAULT_SMTP_PORT);
    assert.equal(buildTransportOptions({ smtp_host: 'h', smtp_port: '0' }).port, DEFAULT_SMTP_PORT);
    assert.equal(buildTransportOptions({ smtp_host: 'h', smtp_port: '70000' }).port, DEFAULT_SMTP_PORT);
  });
});

// ── 3/4. OAuth2 认证 ──────────────────────────────────────────────────────

describe('R161.24 buildTransportOptions — OAuth2 (Office 365)', () => {
  const oauthBundle = {
    smtp_host: 'smtp.office365.com',
    smtp_port: '587',
    smtp_secure: 'false',
    smtp_require_tls: 'true',
    smtp_auth_type: 'oauth2',
    smtp_user: 'ops@corp.com',
    smtp_client_id: 'client-123',
    smtp_client_secret: 'secret-abc',
    smtp_refresh_token: 'refresh-xyz',
    smtp_oauth_tenant: 'contoso-tenant-guid'
  };

  test('产出 nodemailer 认的形状: type=OAuth2 + 凭据 + accessUrl', () => {
    const opts = buildTransportOptions(oauthBundle);
    assert.equal(opts.auth.type, 'OAuth2');
    assert.equal(opts.auth.user, 'ops@corp.com');
    assert.equal(opts.auth.clientId, 'client-123');
    assert.equal(opts.auth.clientSecret, 'secret-abc');
    assert.equal(opts.auth.refreshToken, 'refresh-xyz');
  });

  test('★ 令牌端点按租户拼成 Microsoft v2.0 —— 绝不是 nodemailer 的 Google 默认值', () => {
    const opts = buildTransportOptions(oauthBundle);
    assert.equal(
      opts.auth.accessUrl,
      'https://login.microsoftonline.com/contoso-tenant-guid/oauth2/v2.0/token'
    );
    assert.ok(!opts.auth.accessUrl.includes('accounts.google.com'));
  });

  test('显式给的令牌端点优先于按租户拼的', () => {
    const opts = buildTransportOptions({
      ...oauthBundle,
      smtp_oauth_access_url: 'https://proxy.corp.com/oauth2/v2.0/token'
    });
    assert.equal(opts.auth.accessUrl, 'https://proxy.corp.com/oauth2/v2.0/token');
  });

  test('★ scope 只能通过 customParams 注入 (nodemailer 才会把它拼进刷新请求)', () => {
    const opts = buildTransportOptions({ ...oauthBundle, smtp_oauth_scope: DEFAULT_OAUTH_SCOPE });
    assert.deepEqual(opts.auth.customParams, { scope: DEFAULT_OAUTH_SCOPE });
  });

  test('scope 留空 ⇒ 不发 customParams (由刷新令牌自带的授权范围决定)', () => {
    const opts = buildTransportOptions({ ...oauthBundle, smtp_oauth_scope: '' });
    assert.equal(opts.auth.customParams, undefined);
  });

  test('只填访问令牌也能用 (accessToken 直接带上)', () => {
    const opts = buildTransportOptions({
      smtp_host: 'smtp.office365.com',
      smtp_port: '587',
      smtp_auth_type: 'oauth2',
      smtp_user: 'ops@corp.com',
      smtp_access_token: 'at-1'
    });
    assert.equal(opts.auth.type, 'OAuth2');
    assert.equal(opts.auth.accessToken, 'at-1');
    assert.equal(opts.auth.refreshToken, undefined);
  });

  test('OAuth2 模式下**不会**退回密码认证 (旧实现只有密码一条路)', () => {
    const opts = buildTransportOptions({
      smtp_host: 'h', smtp_port: '587', smtp_auth_type: 'oauth2',
      smtp_user: 'u', smtp_password: 'p'
    });
    assert.equal(opts.auth.type, 'OAuth2');
    assert.equal(opts.auth.pass, undefined);
  });

  test('认证方式大小写 / 别名归一 (oauth / xoauth2 ⇒ oauth2)', () => {
    for (const alias of ['oauth2', 'OAUTH2', 'oauth', 'XOAuth2']) {
      const opts = buildTransportOptions({
        smtp_host: 'h', smtp_port: '587', smtp_auth_type: alias,
        smtp_user: 'u', smtp_refresh_token: 'r', smtp_client_id: 'c', smtp_client_secret: 's'
      });
      assert.equal(opts.auth.type, 'OAuth2', `别名 ${alias} 应当被识别为 oauth2`);
    }
  });

  test('buildMicrosoftTokenUrl: 空租户 ⇒ 空串 (不拼 accounts.google.com)', () => {
    assert.equal(buildMicrosoftTokenUrl(''), '');
    assert.equal(buildMicrosoftTokenUrl(null), '');
  });
});

// ── 5. requireTLS ─────────────────────────────────────────────────────────

describe('R161.24 requireTLS', () => {
  test('587 + 明文起始 ⇒ requireTLS=true (fail-closed)', () => {
    const opts = buildTransportOptions({
      smtp_host: 'smtp.office365.com', smtp_port: '587',
      smtp_secure: 'false', smtp_require_tls: 'true'
    });
    assert.equal(opts.requireTLS, true);
  });

  test('★ 465 (已经是隐式 TLS) ⇒ requireTLS=false (要求 STARTTLS 自相矛盾)', () => {
    const opts = buildTransportOptions({
      smtp_host: 'h', smtp_port: '465', smtp_secure: 'true', smtp_require_tls: 'true'
    });
    assert.equal(opts.secure, true);
    assert.equal(opts.requireTLS, false);
  });

  test('默认 (没配 require_tls) ⇒ false ⇒ 老配置行为不变', () => {
    const opts = buildTransportOptions({ smtp_host: 'h', smtp_port: '587', smtp_secure: 'false' });
    assert.equal(opts.requireTLS, false);
  });
});

// ── 6. 超时 ───────────────────────────────────────────────────────────────

describe('R161.24 超时夹取', () => {
  test('非法 / 空 ⇒ 默认 30s', () => {
    assert.equal(clampSmtpTimeoutSeconds(''), DEFAULT_SMTP_TIMEOUT_SECONDS);
    assert.equal(clampSmtpTimeoutSeconds(undefined), DEFAULT_SMTP_TIMEOUT_SECONDS);
    assert.equal(clampSmtpTimeoutSeconds('abc'), DEFAULT_SMTP_TIMEOUT_SECONDS);
    assert.equal(clampSmtpTimeoutSeconds('0'), DEFAULT_SMTP_TIMEOUT_SECONDS);
    assert.equal(clampSmtpTimeoutSeconds('-5'), DEFAULT_SMTP_TIMEOUT_SECONDS);
  });

  test('小于下限 ⇒ 夹到 5s, 大于上限 ⇒ 夹到 600s', () => {
    assert.equal(clampSmtpTimeoutSeconds('1'), MIN_SMTP_TIMEOUT_SECONDS);
    assert.equal(clampSmtpTimeoutSeconds('9999'), MAX_SMTP_TIMEOUT_SECONDS);
  });

  test('合法值原样 (取整)', () => {
    assert.equal(clampSmtpTimeoutSeconds('45'), 45);
    assert.equal(clampSmtpTimeoutSeconds('45.6'), 46);
  });

  test('三个超时都从同一个值派生 (连接/握手/读写)', () => {
    const opts = buildTransportOptions({ smtp_host: 'h', smtp_port: '587', smtp_timeout_seconds: '12' });
    assert.equal(opts.connectionTimeout, 12000);
    assert.equal(opts.greetingTimeout, 12000);
    assert.equal(opts.socketTimeout, 12000);
  });
});

// ── 7. validateSmtpConfig ────────────────────────────────────────────────

describe('R161.24 validateSmtpConfig', () => {
  const validOauth = {
    smtp_host: 'smtp.office365.com',
    smtp_port: '587',
    smtp_secure: 'false',
    smtp_require_tls: 'true',
    smtp_auth_type: 'oauth2',
    smtp_user: 'ops@corp.com',
    smtp_client_id: 'c',
    smtp_client_secret: 's',
    smtp_refresh_token: 'r',
    smtp_oauth_tenant: 'tenant-guid',
    // 作用域用出厂默认值 (.default) —— 这才是"配全了"的形态。
    smtp_oauth_scope: DEFAULT_OAUTH_SCOPE
  };

  test('主机为空 ⇒ error', () => {
    const r = validateSmtpConfig({ smtp_host: '', smtp_port: '587' });
    assert.equal(r.ok, false);
    assert.match(r.error, /主机/);
  });

  test('端口非法 ⇒ error', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: 'abc' });
    assert.equal(r.ok, false);
    assert.match(r.error, /端口/);
  });

  test('★ 465 不开 SSL/TLS ⇒ error (465 是隐式 TLS 端口, 明文连必然失败)', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: '465', smtp_secure: 'false', smtp_user: 'u' });
    assert.equal(r.ok, false);
    assert.match(r.error, /465/);
  });

  test('★ 587 开了 SSL/TLS ⇒ warning (自建中继可能支持, 不能误伤成不可保存)', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: '587', smtp_secure: 'true', smtp_user: 'u' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /587/.test(w) && /STARTTLS/.test(w)));
  });

  test('★ 端口 25 ⇒ warning (Microsoft 365 封禁)', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: '25', smtp_user: 'u' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /25/.test(w)));
  });

  test('587 没开强制 STARTTLS ⇒ warning', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: '587', smtp_secure: 'false', smtp_user: 'u' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /STARTTLS/.test(w)));
  });

  test('密码模式没填用户名 ⇒ warning 而**不是** error (匿名中继仍然合法)', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: '25' });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /匿名/.test(w)));
  });

  test('未知的认证方式 ⇒ error', () => {
    const r = validateSmtpConfig({ smtp_host: 'h', smtp_port: '587', smtp_auth_type: 'kerberos' });
    assert.equal(r.ok, false);
    assert.match(r.error, /认证方式/);
  });

  test('OAuth2 缺用户名 ⇒ error', () => {
    const r = validateSmtpConfig({ ...validOauth, smtp_user: '' });
    assert.equal(r.ok, false);
    assert.match(r.error, /用户名/);
  });

  test('OAuth2 缺凭据 (既没刷新令牌也没访问令牌) ⇒ error', () => {
    const r = validateSmtpConfig({ ...validOauth, smtp_refresh_token: '', smtp_client_id: '', smtp_client_secret: '' });
    assert.equal(r.ok, false);
    assert.match(r.error, /刷新令牌/);
  });

  test('OAuth2 缺租户且没给完整端点 ⇒ error', () => {
    const r = validateSmtpConfig({ ...validOauth, smtp_oauth_tenant: '' });
    assert.equal(r.ok, false);
    assert.match(r.error, /租户/);
  });

  test('OAuth2 只填了访问令牌 ⇒ ok + warning (令牌会过期, 建议用刷新令牌)', () => {
    const r = validateSmtpConfig({
      smtp_host: 'smtp.office365.com', smtp_port: '587', smtp_auth_type: 'oauth2',
      smtp_user: 'ops@corp.com', smtp_access_token: 'at', smtp_oauth_tenant: 't'
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /访问令牌/.test(w)));
  });

  test('发件人 ≠ 用户名 ⇒ warning (Office 365 要求一致)', () => {
    const r = validateSmtpConfig({
      smtp_host: 'h', smtp_port: '587', smtp_user: 'a@corp.com', smtp_from: 'b@corp.com'
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /发件人/.test(w)));
  });

  test('★ 完整的 Office 365 配置 ⇒ ok 且**没有** warning', () => {
    const r = validateSmtpConfig(validOauth);
    assert.equal(r.ok, true);
    assert.equal(r.error, null);
    assert.deepEqual(r.warnings, []);
  });
});

// ── 8. 机密键掩码 ─────────────────────────────────────────────────────────

describe('R161.24 机密键掩码', () => {
  test('4 个机密键全部被掩码', () => {
    const masked = maskSmtpSecretsForRead({
      smtp_password: 'pw',
      smtp_client_secret: 'cs',
      smtp_refresh_token: 'rt',
      smtp_access_token: 'at',
      smtp_host: 'h'
    });
    assert.equal(masked.smtp_password, SMTP_SECRET_MASK);
    assert.equal(masked.smtp_client_secret, SMTP_SECRET_MASK);
    assert.equal(masked.smtp_refresh_token, SMTP_SECRET_MASK);
    assert.equal(masked.smtp_access_token, SMTP_SECRET_MASK);
    assert.equal(masked.smtp_host, 'h');
  });

  test('空值不掩码 (前端靠这个区分"没配"和"配了但隐藏")', () => {
    const masked = maskSmtpSecretsForRead({ smtp_password: '', smtp_refresh_token: undefined });
    assert.equal(masked.smtp_password, '');
    assert.equal(masked.smtp_refresh_token, undefined);
  });

  test('已经是哨兵的值不被二次处理 (幂等)', () => {
    const once = maskSmtpSecretsForRead({ smtp_password: 'pw' });
    const twice = maskSmtpSecretsForRead(once);
    assert.equal(twice.smtp_password, SMTP_SECRET_MASK);
  });

  test('机密键清单就是那 4 个 (前后端口径必须一致)', () => {
    assert.deepEqual(SMTP_SECRET_CONFIG_KEYS.slice().sort(), [
      'smtp_access_token',
      'smtp_client_secret',
      'smtp_password',
      'smtp_refresh_token'
    ]);
  });

  test('认证方式常量', () => {
    assert.equal(SMTP_AUTH_PASSWORD, 'password');
    assert.equal(SMTP_AUTH_OAUTH2, 'oauth2');
  });
});
