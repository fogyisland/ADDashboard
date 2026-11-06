// R161.24 — email.send() 与投递链路的 transport 回归网
//
// R161.24 把 transport 的构造从「send() 里手搓一个对象字面量」改成
// 「services/smtp-transport.js 的 buildTransportOptions()」。这个文件锁住
// 三件事:
//
//   1. **0 回归**: 密码认证路径传给 nodemailer 的参数跟旧实现逐字等价
//      (host / port / secure / auth.user / auth.pass)。
//   2. **配置错误在开 socket 之前就被拦下** —— createTransport 根本不会被
//      调用。这条是现场价值的核心: 旧实现配错了只能看到 nodemailer 的
//      "Invalid login", 操作员分不清是 587 勾了隐式 TLS、OAuth2 没配、
//      还是密码错。
//   3. **投递链路只把 smtp_* 白名单交给 send()** —— getSystemConfig() 返回
//      的是**整张** system_config (含 access_domain / jwt_secret_current),
//      直接透传给 nodemailer 会把无关的机密带进 transport options。
//
// 全部离线: 不连数据库, 不开 socket (createTransport 是假的)。
//
// 用法: cd Server/center && node --test tests/email-send-transport.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { send, createEmailDeliveryLoop } from '../src/services/email.js';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 记录传给 nodemailer 的 transport 参数的假 transport 工厂。 */
function makeFakeTransport({ failWith = null } = {}) {
  const calls = { options: null, mail: null };
  const createTransport = (options) => {
    calls.options = options;
    return {
      async sendMail(mail) {
        calls.mail = mail;
        if (failWith) throw failWith;
        return { accepted: [mail.to], messageId: 'fake-1' };
      }
    };
  };
  return { createTransport, calls };
}

/** 只放行 system_alert_outbox 的假 db。 */
function makeFakeDb(pendingRows) {
  const executed = [];
  // 4 张 outbox 表各有自己的 listPending SQL (真实实现里形状不同),
  // 这里用不同字符串区分, 让 query 只对 system_alert 那张表返回待发行行。
  const outboxSql = (tag) => ({
    listPending: `LIST_PENDING_${tag}`,
    markSent: 'MARK_SENT',
    markFailed: 'MARK_FAILED',
    scheduleRetry: 'SCHEDULE_RETRY',
    markExhausted: 'MARK_EXHAUSTED'
  });
  return {
    dialect: 'mysql',
    executed,
    sql: {
      systemAlertOutbox: outboxSql('ALERT'),
      reportEmailOutbox: outboxSql('REPORT'),
      adNotifyOutbox: outboxSql('AD_NOTIFY'),
      licenseEmailOutbox: outboxSql('LICENSE'),
      reportRun: { markStatus: { mysql: 'MARK_STATUS', mssql: 'MARK_STATUS' } }
    },
    async query(sql) {
      if (sql === 'LIST_PENDING_ALERT' && pendingRows) return { rows: pendingRows };
      return { rows: [] };
    },
    async execute(sql, params) {
      executed.push([sql, params]);
      return { affectedRows: 1 };
    }
  };
}

// ---------------------------------------------------------------------------
// 1. 密码认证: 0 回归
// ---------------------------------------------------------------------------

describe('R161.24 email.send — 密码认证 0 回归', () => {
  test('传给 nodemailer 的参数跟旧实现逐字等价', async () => {
    const { createTransport, calls } = makeFakeTransport();
    const r = await send({
      smtp: {
        smtp_host: 'smtp.qq.com',
        smtp_port: 465,
        smtp_secure: 'true',
        smtp_user: 'a@b.com',
        smtp_password: 'pw'
      },
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 's',
      text: 't'
    }, { createTransport, emailEnabledOverride: true });

    assert.equal(r.ok, true);
    assert.equal(calls.options.host, 'smtp.qq.com');
    assert.equal(calls.options.port, 465);
    assert.equal(calls.options.secure, true);
    assert.deepEqual(calls.options.auth, { user: 'a@b.com', pass: 'pw' });
    assert.equal(calls.mail.to, 'c@d.com');
  });

  test("smtp_secure='false' ⇒ secure=false (Boolean('false') 那个坑)", async () => {
    const { createTransport, calls } = makeFakeTransport();
    await send({
      smtp: { smtp_host: 'h', smtp_port: 587, smtp_secure: 'false', smtp_user: 'u', smtp_password: 'p' },
      from: 'u@x.com', to: 'c@d.com', subject: 's', text: 't'
    }, { createTransport, emailEnabledOverride: true });
    assert.equal(calls.options.secure, false);
  });

  test('nodemailer 抛错 ⇒ {ok:false, error} (不抛给调用方)', async () => {
    const { createTransport } = makeFakeTransport({ failWith: new Error('Invalid login') });
    const r = await send({
      smtp: { smtp_host: 'h', smtp_port: 587, smtp_secure: 'false', smtp_user: 'u', smtp_password: 'p' },
      from: 'u@x.com', to: 'c@d.com', subject: 's', text: 't'
    }, { createTransport, emailEnabledOverride: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'Invalid login');
  });
});

// ---------------------------------------------------------------------------
// 2. 配置错误在开 socket 之前被拦下
// ---------------------------------------------------------------------------

describe('R161.24 email.send — 配置体检前置', () => {
  test('★ 主机为空 ⇒ createTransport 根本没被调用', async () => {
    const { createTransport, calls } = makeFakeTransport();
    const r = await send({
      smtp: { smtp_port: 587, smtp_user: 'u', smtp_password: 'p' },
      from: 'u@x.com', to: 'c@d.com', subject: 's', text: 't'
    }, { createTransport, emailEnabledOverride: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /主机/);
    assert.equal(calls.options, null, '配置不合法时**不允许**建 transport (不碰 socket)');
  });

  test('★ 465 没开 SSL/TLS ⇒ 中文错误 + 不建 transport', async () => {
    const { createTransport, calls } = makeFakeTransport();
    const r = await send({
      smtp: { smtp_host: 'h', smtp_port: 465, smtp_secure: 'false', smtp_user: 'u', smtp_password: 'p' },
      from: 'u@x.com', to: 'c@d.com', subject: 's', text: 't'
    }, { createTransport, emailEnabledOverride: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /465/);
    assert.equal(calls.options, null);
  });

  test('★ OAuth2 缺凭据 ⇒ 中文错误 + 不建 transport', async () => {
    const { createTransport, calls } = makeFakeTransport();
    const r = await send({
      smtp: {
        smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_auth_type: 'oauth2',
        smtp_user: 'ops@corp.com'
      },
      from: 'ops@corp.com', to: 'c@d.com', subject: 's', text: 't'
    }, { createTransport, emailEnabledOverride: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /刷新令牌/);
    assert.equal(calls.options, null);
  });

  test('smtp 对象整个缺失 ⇒ 不炸, 返回可读错误', async () => {
    const { createTransport } = makeFakeTransport();
    const r = await send({ from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't' },
      { createTransport, emailEnabledOverride: true });
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 3. OAuth2 走通
// ---------------------------------------------------------------------------

describe('R161.24 email.send — OAuth2', () => {
  test('★ 完整的 Office 365 配置 ⇒ transport 带 OAuth2 认证', async () => {
    const { createTransport, calls } = makeFakeTransport();
    const r = await send({
      smtp: {
        smtp_host: 'smtp.office365.com',
        smtp_port: 587,
        smtp_secure: 'false',
        smtp_require_tls: 'true',
        smtp_auth_type: 'oauth2',
        smtp_user: 'ops@corp.com',
        smtp_client_id: 'cid',
        smtp_client_secret: 'csec',
        smtp_refresh_token: 'rtok',
        smtp_oauth_tenant: 'tenant-guid',
        smtp_oauth_scope: 'https://outlook.office365.com/.default'
      },
      from: 'ops@corp.com',
      to: 'c@d.com',
      subject: 's',
      text: 't'
    }, { createTransport, emailEnabledOverride: true });

    assert.equal(r.ok, true);
    assert.equal(calls.options.auth.type, 'OAuth2');
    assert.equal(calls.options.auth.user, 'ops@corp.com');
    assert.equal(calls.options.auth.refreshToken, 'rtok');
    assert.equal(calls.options.auth.accessUrl,
      'https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token');
    assert.equal(calls.options.requireTLS, true);
    assert.deepEqual(calls.options.auth.customParams, { scope: 'https://outlook.office365.com/.default' });
  });
});

// ---------------------------------------------------------------------------
// 4. 投递链路的 smtp_* 白名单收敛
// ---------------------------------------------------------------------------

describe('R161.24 投递链路 — 只把 smtp_* 白名单交给 send()', () => {
  test('★ access_domain / jwt_secret_current 等无关键不会进 transport', async () => {
    const db = makeFakeDb([{
      id: 1, to_addrs: 'c@d.com', cc_addrs: null, subject: 's',
      body_text: 't', body_html: null, attempt_count: 0
    }]);
    let captured = null;
    const loop = createEmailDeliveryLoop({
      db,
      getIntervalSeconds: async () => 60,
      getSystemConfig: async () => ({
        email_enabled: '1',
        alert_email_max_attempts: '5',
        alert_email_initial_backoff_seconds: '30',
        smtp_host: 'smtp.office365.com',
        smtp_port: '587',
        smtp_secure: 'false',
        smtp_require_tls: 'true',
        smtp_auth_type: 'oauth2',
        smtp_user: 'ops@corp.com',
        smtp_client_id: 'cid',
        smtp_client_secret: 'csec',
        smtp_refresh_token: 'rtok',
        smtp_oauth_tenant: 'tenant-guid',
        smtp_from: 'ops@corp.com',
        // ↓ 这些**绝不能**出现在 smtp bundle 里
        access_domain: 'dashboard.corp.com',
        jwt_secret_current: 'super-secret',
        ad_bind_password: 'ldap-secret',
        agent_token_current: 'agent-secret'
      }),
      sendImpl: async (args) => { captured = args; return { ok: true }; },
      logger: { error() {}, warn() {}, info() {} }
    });

    await loop.tick();

    assert.ok(captured, 'sendImpl 应当被调用过');
    assert.equal(captured.smtp.smtp_host, 'smtp.office365.com');
    assert.equal(captured.smtp.smtp_auth_type, 'oauth2');
    assert.equal(captured.from, 'ops@corp.com');
    assert.equal(captured.smtp.access_domain, undefined);
    assert.equal(captured.smtp.jwt_secret_current, undefined);
    assert.equal(captured.smtp.ad_bind_password, undefined);
    assert.equal(captured.smtp.agent_token_current, undefined);
  });

  test('smtp_host 为空 ⇒ 不调 send, 走重试路径 (原有行为不变)', async () => {
    const db = makeFakeDb([{
      id: 1, to_addrs: 'c@d.com', cc_addrs: null, subject: 's',
      body_text: 't', body_html: null, attempt_count: 0
    }]);
    let called = false;
    const loop = createEmailDeliveryLoop({
      db,
      getIntervalSeconds: async () => 60,
      getSystemConfig: async () => ({ email_enabled: '1', alert_email_max_attempts: '5' }),
      sendImpl: async () => { called = true; return { ok: true }; },
      logger: { error() {}, warn() {}, info() {} }
    });
    await loop.tick();
    assert.equal(called, false);
    assert.ok(db.executed.some(([sql]) => sql === 'MARK_FAILED'));
  });
});
