// center/src/services/smtp-transport.js
//
// R161.24 (2026-10-29) — SMTP 传输层配置解析 (密码 / OAuth2 双通道)。
//
// ── 为什么单独一个文件 ────────────────────────────────────────────────────
// 1) **零第三方依赖**: 本文件不 import nodemailer / mysql2 / mssql,
//    只用纯 JS ⇒ 回归网可以独立 import 它做单测 (跟 services/package-scope.js
//    同一条 precedent: 纯函数模块必须能在没装依赖的环境里被 import)。
// 2) **单一真源**: 投递链路 (services/email.js) 与「发测试邮件」路由
//    (routes/admin.js) 是两条独立路径, 必须用**同一套**解析逻辑, 否则
//    两边迟早漂移 (现场表现就是「测试邮件能发, 定时告警发不出去」)。
//    本文件同时被 services/config.js 引用 (机密键清单), 所以**不能**放在
//    email.js 里 —— 那会形成 config.js → email.js → config.js 的循环 import。
//
// ── 现场根因 (operator 原话:「配置的时候发现不支持 office365 的邮件发送」) ──
// Microsoft 自 2023 年起对 Exchange Online **默认关闭 SMTP AUTH**（基础
// 认证 user/password）。新建租户的默认状态就是关的 ⇒ 把主机/端口/用户名/
// 密码**全都填对**也一定失败, 典型报错:
//     535 5.7.139 Authentication unsuccessful,
//          SmtpClientAuthentication is disabled for this mailbox
// ⇒ 现代 M365 唯一受支持的路径是 **OAuth2 / XOAUTH2**（Entra 应用注册 +
// refresh token）。而旧实现只认 `auth: {user, pass}` 这**一种**认证方式。
//
// 叠加三个坑:
//   (a) `smtp_port` 的出厂默认值是 **25**, 而 Microsoft **默认封禁 25 端口**
//       ⇒ 照默认值配必然连不上。
//   (b) 587 = STARTTLS（先明文握手再升级）, 465 = 隐式 TLS（直接 TLS）。
//       旧实现只把 `smtp_secure` 映射到 nodemailer 的 `secure`（隐式 TLS）,
//       **根本没有「STARTTLS」这个概念** ⇒ 操作员在 587 上勾了 SSL/TLS
//       就变成「在 STARTTLS 端口上要隐式 TLS」⇒ 必然连不上。
//   (c) 旧实现没有连接/握手/读写超时 ⇒ 对端不回 220 时**永久卡死**
//       （nodemailer 默认 connectionTimeout=120s, greetingTimeout=30s,
//       socketTimeout=600s —— 但 greetingTimeout 默认 30s 在 587 上够用,
//       真正会卡死的是 secure=true 打到 465 明文端口的「Greeting never
//       received」, 见 email.js 里 R158.100-fix 的现场记录）。
//
// ── 本文件提供的纯函数 ────────────────────────────────────────────────────
//   buildSmtpBundle(cfg)        从整张 system_config map 里挑出 smtp_* 子集
//   buildTransportOptions(smtp) → nodemailer transport 参数
//   validateSmtpConfig(smtp)    → { ok, error, warnings } 可执行的中文结论

export const SMTP_AUTH_PASSWORD = 'password';
export const SMTP_AUTH_OAUTH2 = 'oauth2';

export const DEFAULT_SMTP_PORT = 25;
export const DEFAULT_SMTP_TIMEOUT_SECONDS = 30;
export const MIN_SMTP_TIMEOUT_SECONDS = 5;
export const MAX_SMTP_TIMEOUT_SECONDS = 600;

// Microsoft 365 的 SMTP 权限作用域。默认给 `.default`（= 应用已授权的
// 委托+静态权限集合）。操作员可以把它清空 —— 清空后刷新请求**不带 scope**,
// 由 refresh token 自带的授权范围决定（部分租户只同意了 SMTP.Send 时,
// 显式发 .default 反而会被租户策略拒）。
export const DEFAULT_OAUTH_SCOPE = 'https://outlook.office365.com/.default';

// Microsoft v2.0 令牌端点模板。**必须显式给** —— nodemailer 的默认值是
// Google 的 `https://accounts.google.com/o/oauth2/token`, 打到那儿必然失败。
export const MICROSOFT_TOKEN_URL_TEMPLATE =
  'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token';

// 全部 smtp_* 配置键。system_config 是 KV 表 ⇒ **新增键不需要迁移**。
// `smtp_from` 也在列表里 —— 投递链路用它当 from, 且体检时拿它跟
// smtp_user 比对（O365 要求 from 与已认证账号一致, 或在允许的发件人列表里）。
export const SMTP_CONFIG_KEYS = Object.freeze([
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_require_tls',
  'smtp_timeout_seconds',
  'smtp_auth_type',
  'smtp_user',
  'smtp_password',
  'smtp_client_id',
  'smtp_client_secret',
  'smtp_refresh_token',
  'smtp_access_token',
  'smtp_oauth_tenant',
  'smtp_oauth_access_url',
  'smtp_oauth_scope',
  'smtp_from'
]);

// 机密键清单 —— 读时掩码 / 写时哨兵保持原值 / 审计行脱敏, 三个动作共用
// 这一份清单, 避免"加了一个新机密但忘了脱敏"。
//   smtp_password        基础认证密码
//   smtp_client_secret   Entra 应用 client secret
//   smtp_refresh_token   OAuth2 refresh token
//   smtp_access_token    OAuth2 access token
export const SMTP_SECRET_CONFIG_KEYS = Object.freeze([
  'smtp_password',
  'smtp_client_secret',
  'smtp_refresh_token',
  'smtp_access_token'
]);

// 掩码哨兵。跟历史 SMTP_PASSWORD_MASK 同一个字符串, 前端的老逻辑不用改。
export const SMTP_SECRET_MASK = '********';

// ── 小工具 ────────────────────────────────────────────────────────────────

function trimmed(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function trimmedOrUndefined(value) {
  const s = trimmed(value);
  return s.length > 0 ? s : undefined;
}

function isTrue(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function normalizeAuthType(value) {
  const s = trimmed(value).toLowerCase();
  if (s === '') return SMTP_AUTH_PASSWORD;
  if (s === SMTP_AUTH_OAUTH2 || s === 'oauth' || s === 'xoauth2') return SMTP_AUTH_OAUTH2;
  if (s === SMTP_AUTH_PASSWORD || s === 'basic' || s === 'plain') return SMTP_AUTH_PASSWORD;
  return s; // 未知值原样返回, 由 validateSmtpConfig 报错
}

function normalizePort(value) {
  const n = Number(trimmed(value));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
    return DEFAULT_SMTP_PORT;
  }
  return n;
}

// 超时夹取到 [5, 600] 秒。0 / 负数 / 非数字 → 用默认值 30s。
export function clampSmtpTimeoutSeconds(value) {
  const n = Number(trimmed(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SMTP_TIMEOUT_SECONDS;
  return Math.min(MAX_SMTP_TIMEOUT_SECONDS, Math.max(MIN_SMTP_TIMEOUT_SECONDS, Math.round(n)));
}

// ── buildSmtpBundle ───────────────────────────────────────────────────────

// 从整张 system_config map 里挑出本应用拥有的 smtp_* 子集。
// 投递链路拿到的 getSystemConfig() 返回的是**整张表**, 直接传给 nodemailer
// 会把 access_domain / jwt_secret_current 之类的无关键一起带进 transport
// options —— 这里显式收敛成白名单, 两个调用方共用, 不会漂移。
export function buildSmtpBundle(cfg) {
  const out = {};
  if (!cfg || typeof cfg !== 'object') return out;
  for (const key of SMTP_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(cfg, key)) out[key] = cfg[key];
  }
  return out;
}

// 读时掩码 —— 把所有机密键换成哨兵。真实值永远不进浏览器。
export function maskSmtpSecretsForRead(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = { ...cfg };
  let changed = false;
  for (const key of SMTP_SECRET_CONFIG_KEYS) {
    if (out[key] && out[key] !== SMTP_SECRET_MASK) {
      out[key] = SMTP_SECRET_MASK;
      changed = true;
    }
  }
  return changed ? out : cfg;
}

// ── buildTransportOptions ─────────────────────────────────────────────────

// 拼 Microsoft v2.0 令牌端点。租户可以是 GUID, 也可以是 'common' /
// 'organizations' / 'consumers' 这类特殊租户名（照原样拼, 不做校验 ——
// 校验留给令牌端点自己, 端点会回明确的错误）。
export function buildMicrosoftTokenUrl(tenantId) {
  const tenant = trimmed(tenantId);
  if (!tenant) return '';
  return MICROSOFT_TOKEN_URL_TEMPLATE.replace('{tenant}', encodeURIComponent(tenant));
}

function buildOAuth2Auth(bundle, user) {
  // nodemailer 的 smtp-transport 走 `auth.type === 'OAUTH2'` 分支, 把整个
  // authData 当作 XOAuth2 的 options 传进去:
  //   options.accessUrl   令牌端点 (默认是 Google 的 ⇒ 必须覆盖)
  //   options.clientId / clientSecret / refreshToken
  //   options.accessToken 已有令牌 (可选, 只填它也能用, 但会过期)
  //   options.customParams 追加到刷新请求的 POST body (scope 只能走这里)
  const auth = { type: 'OAuth2', user };
  const clientId = trimmedOrUndefined(bundle.smtp_client_id);
  const clientSecret = trimmedOrUndefined(bundle.smtp_client_secret);
  const refreshToken = trimmedOrUndefined(bundle.smtp_refresh_token);
  const accessToken = trimmedOrUndefined(bundle.smtp_access_token);
  if (clientId) auth.clientId = clientId;
  if (clientSecret) auth.clientSecret = clientSecret;
  if (refreshToken) auth.refreshToken = refreshToken;
  if (accessToken) auth.accessToken = accessToken;

  const accessUrl =
    trimmedOrUndefined(bundle.smtp_oauth_access_url) ||
    buildMicrosoftTokenUrl(trimmed(bundle.smtp_oauth_tenant));
  if (accessUrl) auth.accessUrl = accessUrl;

  // scope **不是**刷新请求的必填项 —— 省略时由 refresh token 自带的授权
  // 范围决定。部分租户只同意了 SMTP.Send, 显式发 .default 反而被拒。
  const scope = trimmedOrUndefined(bundle.smtp_oauth_scope);
  if (scope) auth.customParams = { scope };

  return auth;
}

export function buildTransportOptions(smtp = {}) {
  const bundle = smtp && typeof smtp === 'object' ? smtp : {};
  const useImplicitTls = isTrue(bundle.smtp_secure);
  const requireTls = isTrue(bundle.smtp_require_tls);
  const timeoutSeconds = clampSmtpTimeoutSeconds(bundle.smtp_timeout_seconds);
  const authType = normalizeAuthType(bundle.smtp_auth_type);
  const user = trimmed(bundle.smtp_user);

  const options = {
    host: trimmed(bundle.smtp_host),
    port: normalizePort(bundle.smtp_port),
    // 隐式 TLS (465) 全程已是 TLS, 再要求 STARTTLS 自相矛盾 ⇒ requireTLS
    // 只在「明文起始 + STARTTLS 升级」这一种模式下生效。
    secure: useImplicitTls,
    requireTLS: !useImplicitTls && requireTls,
    connectionTimeout: timeoutSeconds * 1000,
    greetingTimeout: timeoutSeconds * 1000,
    socketTimeout: timeoutSeconds * 1000
  };

  if (authType === SMTP_AUTH_OAUTH2) {
    options.auth = buildOAuth2Auth(bundle, user);
  } else if (user) {
    options.auth = { user, pass: bundle.smtp_password };
  }
  // 没有用户名 ⇒ 不带 auth（匿名中继）。保留旧行为, 不新增报错。
  return options;
}

// ── validateSmtpConfig ────────────────────────────────────────────────────

// 配置体检。返回 { ok, error, warnings }:
//   ok=false  ⇒ 配置本身错了, 直接拒绝发信 (error 是可直接展示给操作员的中文)
//   warnings  ⇒ 不拦, 但操作员大概率要按提示改 (端口 25 / STARTTLS 没开 / …)
//
// ★ 分级原则: 只把**必然连不上**的组合判为 error, 其余一律 warning。
//   判据:
//     - 465 是全世界通用的隐式 TLS 端口 ⇒ 不开 SSL/TLS 必然连不上 → error
//     - 587 上的隐式 TLS 在 O365 必然失败, 但自建中继可能支持 ⇒ warning
//   这样既不会把"能用的自建配置"误伤成不可保存, 又能把 O365 的坑指出来。
export function validateSmtpConfig(smtp = {}) {
  const bundle = smtp && typeof smtp === 'object' ? smtp : {};
  const warnings = [];

  const host = trimmed(bundle.smtp_host);
  if (!host) {
    return { ok: false, error: 'SMTP 主机未配置', warnings };
  }

  const rawPort = trimmed(bundle.smtp_port);
  const port = normalizePort(bundle.smtp_port);
  if (rawPort !== '' && (!Number.isInteger(Number(rawPort)) || Number(rawPort) < 1 || Number(rawPort) > 65535)) {
    return { ok: false, error: `SMTP 端口无效: ${rawPort}（应为 1-65535 的整数）`, warnings };
  }

  const useImplicitTls = isTrue(bundle.smtp_secure);
  const requireTls = isTrue(bundle.smtp_require_tls);
  const authType = normalizeAuthType(bundle.smtp_auth_type);
  const user = trimmed(bundle.smtp_user);
  const from = trimmed(bundle.smtp_from);

  if (!useImplicitTls && port === 465) {
    return {
      ok: false,
      error: '端口 465 是隐式 TLS(SMTPS) 端口，请勾选「SSL/TLS」；或改用 587 + STARTTLS',
      warnings
    };
  }
  if (useImplicitTls && port === 587) {
    warnings.push('端口 587 是 STARTTLS 端口，请关闭「SSL/TLS」并打开「强制 STARTTLS」');
  }
  if (useImplicitTls && port !== 465 && port !== 587 && port !== 25) {
    warnings.push(`端口 ${port} 配了「SSL/TLS」= 隐式 TLS，请确认服务器确实支持`);
  }
  if (port === 25) {
    warnings.push('端口 25 被 Microsoft 365 默认封禁，建议改用 587 (STARTTLS)');
  }
  if (port === 587 && !useImplicitTls && !requireTls) {
    warnings.push('端口 587 建议打开「强制 STARTTLS」，否则认证信息可能在明文握手里被送出');
  }

  if (authType === SMTP_AUTH_OAUTH2) {
    if (!user) {
      return { ok: false, error: 'OAuth2 模式必须填写 SMTP 用户名（发信邮箱地址）', warnings };
    }
    const hasAccessToken = !!trimmedOrUndefined(bundle.smtp_access_token);
    const hasRefreshToken = !!trimmedOrUndefined(bundle.smtp_refresh_token);
    const hasClientId = !!trimmedOrUndefined(bundle.smtp_client_id);
    const hasClientSecret = !!trimmedOrUndefined(bundle.smtp_client_secret);
    if (!hasAccessToken && !(hasRefreshToken && hasClientId && hasClientSecret)) {
      return {
        ok: false,
        error: 'OAuth2 模式需要「刷新令牌 + 客户端 ID + 客户端密钥」三件套，或直接填一个「访问令牌」',
        warnings
      };
    }
    if (!trimmedOrUndefined(bundle.smtp_oauth_access_url) && !trimmedOrUndefined(bundle.smtp_oauth_tenant)) {
      return {
        ok: false,
        error: 'OAuth2 模式需要「租户 ID」（用于拼 Microsoft 令牌端点），或直接填完整的「令牌端点 URL」',
        warnings
      };
    }
    if (hasAccessToken && !hasRefreshToken) {
      warnings.push('只填了访问令牌：Microsoft 访问令牌通常 1 小时后过期，届时发信会失败；建议同时填刷新令牌');
    }
    if (!trimmedOrUndefined(bundle.smtp_oauth_scope)) {
      warnings.push('未填作用域：刷新请求将不带 scope，由刷新令牌自带的授权范围决定');
    }
  } else if (authType === SMTP_AUTH_PASSWORD) {
    if (!user) {
      warnings.push('未配置 SMTP 用户名，将以匿名方式投递（只对无鉴权中继有效）');
    }
  } else {
    return { ok: false, error: `未知的认证方式: ${bundle.smtp_auth_type}`, warnings };
  }

  if (from && user && from.toLowerCase() !== user.toLowerCase()) {
    warnings.push(`发件人地址(${from})与 SMTP 用户名(${user})不一致：Office 365 要求发件人与已认证账号一致`);
  }

  return { ok: true, error: null, warnings };
}
