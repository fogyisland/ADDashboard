// R161.35 第 3 步 (2026-11-22) — 读出口再校验 (claim-time re-validation)。
//
// ★ 威胁模型: 第 2 步把「自由 PowerShell」换成密封动作 { scriptId, args },
//   并在 **queue 时** 校验参数。但 queue 时校验只保护"通过 API 下发的命令"。
//   中心被拿下的情形下, 攻击者最直接的做法是**直接往 ad_member_commands
//   插一行** (或改一行的 params_json), 完全绕过 queueCommand。
//
//   本步把闸门搬到「读出口」: 不论行是谁写进来的, 只要参数不合 schema,
//   claimForAgent 就不下发给 agent, 而是当场置 failed 并写明原因, 路由再落
//   一条 `ad_member_command_rejected` 审计 —— 攻击尝试**可见**, 而不是变成
//   一条 30 秒后被扫成 timeout 的"谜之行"。
//
// 本文件锁住:
//   E. claimForAgent 必须**解析** params_json (文本列 ⇒ 对象), 否则每一行都会
//      被误判非法 (正常命令 100% 被拒) —— 这是改造时删掉 parseParamsJson 引入的
//      缺陷, 必须回归住。
//   F. partitionClaims 的分流判据 (未知 scriptId / 多余字段 / 非 member_action /
//      非 JSON 文本 / 归一化后下发)。
//   G. 两种方言的 rejectClaims SQL 都存在 (MySQL + MSSQL, 这是双方言硬规则)。
//   H. 端到端: 路由只把 accepted 发给 agent; 被拒行置 failed + 一条 rejected 审计。
//   I. agent 侧: drainer 对未声明 commandType 不投给 dispatcher, 而是回报失败。

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const { _setDbForTest } = await import('../../src/db/index.js');
const memberCmd = await import('../../src/services/member-commands.js');

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const AUDIT_WRITE_SQL = 'INSERT INTO audit_logs (user_id, action, target, payload, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())';

/**
 * A db that answers the three statements claimForAgent issues, in order:
 *   1) claimPick  → [{ id }, ...]
 *   2) claim      → execute
 *   3) loadByIds  → the rows the test wants the service to see
 *   4) rejectClaims (only when something is rejected) → execute
 * Every statement is recorded so the assertions can look at what ran.
 */
function makeClaimDb({ ids = [], rows = [], dialect = 'mysql' } = {}) {
  const executed = [];
  const queried = [];
  const rowSql = dialect === 'mssql'
    ? 'SELECT TOP 10 id FROM ad_member_commands WHERE status = CAST(\'queued\' AS NVARCHAR(16))'
    : 'SELECT id FROM ad_member_commands WHERE status = \'queued\' LIMIT ?';
  return {
    dialect,
    executed,
    queried,
    sql: {
      adMemberCommands: {
        claimPick: dialect === 'mssql' ? (limit) => `${rowSql} /* ${limit} */` : rowSql,
        claim: (n) => `UPDATE ad_member_commands SET status = 'running' WHERE id IN (${'?, '.repeat(n).replace(/, $/, '')})`,
        loadByIds: (n) => `SELECT id, command_type, params_json, status FROM ad_member_commands WHERE id IN (${'?, '.repeat(n).replace(/, $/, '')})`,
        rejectClaims: (n) => `UPDATE ad_member_commands SET status = 'failed' WHERE id IN (${'?, '.repeat(n).replace(/, $/, '')}) AND status = 'running'`,
      },
      audit: { write: AUDIT_WRITE_SQL },
    },
    query: async (sql, params) => {
      queried.push({ sql: String(sql), params });
      if (/^SELECT id FROM ad_member_commands/.test(String(sql)) || /SELECT TOP \d+ id FROM ad_member_commands/.test(String(sql))) {
        return { rows: ids.map((id) => ({ id })) };
      }
      return { rows };
    },
    execute: async (sql, params) => {
      executed.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };
}

after(() => {
  _setDbForTest(undefined);
});

// ---------------------------------------------------------------------------
// E. params_json 必须被解析
// ---------------------------------------------------------------------------

describe('R161.35 第 3 步 E — params_json 文本列必须解析后才校验', () => {
  test('E1. parseCommandParams: 文本 / Buffer / 对象 / 坏 JSON / null', () => {
    const { parseCommandParams } = memberCmd._testInternals;
    assert.deepEqual(parseCommandParams('{"scriptId":"restart_service","args":{"serviceName":"Spooler"}}'),
      { scriptId: 'restart_service', args: { serviceName: 'Spooler' } }, 'MySQL 文本列');
    assert.deepEqual(parseCommandParams(Buffer.from('{"scriptId":"restart_service","args":{}}', 'utf8')),
      { scriptId: 'restart_service', args: {} }, 'Buffer 列 (mysql2 可能给 Buffer)');
    const obj = { scriptId: 'restart_service', args: {} };
    assert.equal(parseCommandParams(obj), obj, '已经是对象 ⇒ 原样返回');
    assert.equal(parseCommandParams('not json'), null, '坏 JSON ⇒ null (会被当作非法载荷拒绝)');
    assert.equal(parseCommandParams(''), null);
    assert.equal(parseCommandParams(null), null);
  });

  test('E2. claimForAgent 必须把合法的文本行当对象下发 (回归: 不能 100% 全拒)', async () => {
    const goodRow = {
      id: 11,
      command_type: 'member_action',
      // ★ 关键: 驱动返回的是**字符串**, 与真实 MySQL 行为一致。
      params_json: JSON.stringify({ scriptId: 'restart_service', args: { serviceName: 'Spooler', force: true } }),
      status: 'running',
    };
    const db = makeClaimDb({ ids: [11], rows: [goodRow] });
    _setDbForTest(db);

    const result = await memberCmd.claimForAgent('member-01', 5);

    assert.ok(!Array.isArray(result), '第 3 步起返回 { accepted, rejected }');
    assert.equal(result.accepted.length, 1, '合法行必须被接受');
    assert.equal(result.rejected.length, 0, '合法行不得被拒');
    assert.deepEqual(result.accepted[0].params_json,
      { scriptId: 'restart_service', args: { serviceName: 'Spooler', force: true } },
      '下发给 agent 的必须是对象, 不是 JSON 文本');
    assert.ok(!db.executed.some((e) => /status = 'failed'/.test(e.sql)), '没有拒绝行就不该跑 rejectClaims');
  });
});

// ---------------------------------------------------------------------------
// F. partitionClaims 判据
// ---------------------------------------------------------------------------

describe('R161.35 第 3 步 F — partitionClaims 分流判据', () => {
  const { partitionClaims } = memberCmd._testInternals;

  test('F1. 合法 / 未知 scriptId / 多余字段 / 非法类型 各归其位', () => {
    const { accepted, rejected } = partitionClaims([
      { id: 1, command_type: 'member_action', params_json: { scriptId: 'restart_service', args: { serviceName: 'Spooler' } } },
      { id: 2, command_type: 'member_action', params_json: { scriptId: 'evil_action', args: {} } },
      { id: 3, command_type: 'member_action', params_json: { scriptId: 'restart_service', args: { serviceName: 'Spooler', cmd: 'whoami' } } },
      { id: 4, command_type: 'member_action', params_json: { script: 'Invoke-Expression $x' } },
      { id: 5, command_type: 'member_script', params_json: { script: 'Invoke-Expression $x' } },
      { id: 6, command_type: 'member_action', params_json: null },
    ]);
    assert.deepEqual(accepted.map((r) => r.id), [1], '只有 id=1 合法');
    assert.deepEqual(rejected.map(({ row }) => row.id), [2, 3, 4, 5, 6]);
    for (const { reason } of rejected) {
      assert.equal(typeof reason, 'string');
      assert.ok(reason.length > 0, '每条拒绝都必须带原因 (会写进 error_message)');
    }
    assert.match(rejected.find((r) => r.row.id === 2).reason, /unknown scriptId/i);
    assert.match(rejected.find((r) => r.row.id === 3).reason, /unknown arg/i);
    assert.match(rejected.find((r) => r.row.id === 4).reason, /retired|scriptId/i,
      'params.script (自由 PowerShell) 必须被显式拒绝');
    assert.match(rejected.find((r) => r.row.id === 5).reason, /unsupported commandType/i);
  });

  test('F2. 被接受的行下发的 params_json 是**归一化后**的对象 (未声明字段不进 wire)', () => {
    const { accepted } = partitionClaims([
      { id: 7, command_type: 'member_action', params_json: { scriptId: 'restart_service', args: { serviceName: 'Spooler', force: 'nope-not-a-bool' } } },
    ]);
    // force 不是合法 bool ⇒ 整行被拒, 而不是"丢掉 force 继续执行"。
    assert.equal(accepted.length, 0);
  });

  test('F3. 空输入 / 非数组输入不得抛', () => {
    assert.deepEqual(partitionClaims([]), { accepted: [], rejected: [] });
    assert.deepEqual(partitionClaims(null), { accepted: [], rejected: [] });
    assert.deepEqual(partitionClaims(undefined), { accepted: [], rejected: [] });
  });
});

// ---------------------------------------------------------------------------
// G. 双方言 SQL
// ---------------------------------------------------------------------------

describe('R161.35 第 3 步 G — rejectClaims 两种方言都必须存在', () => {
  test('G1. MySQL + MSSQL 都有 rejectClaims, 且只在 running 上生效', async () => {
    const { buildSql } = await import('../../src/db/sql.js');
    for (const dialect of ['mysql', 'mssql']) {
      const block = buildSql(dialect).adMemberCommands;
      assert.equal(typeof block.rejectClaims, 'function', `${dialect}: rejectClaims 必须存在`);
      const text = block.rejectClaims(3);
      assert.match(text, /SET status = ('failed'|CAST\('failed' AS NVARCHAR\(16\)\))/);
      assert.match(text, /running/, '只翻转仍处于 running 的行 (幂等)');
      assert.match(text, /error_message = /, '必须写明拒绝原因');
      assert.equal((text.match(/\?/g) || []).length, 1 + 3, '1 个 message + 3 个 id 占位符');
    }
  });

  test('G2. 源码级: 两个 adMemberCommands 块都定义了 rejectClaims', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'db', 'sql.js'), 'utf8');
    const matches = src.match(/rejectClaims:\s*\(idCount\)/g) || [];
    assert.equal(matches.length, 2,
      'MySQL 与 MSSQL 各一份 (双方言硬规则: 任何 SQL 变更两边都要有)');
    assert.match(src, /rejectClaims: \(idCount\) => `UPDATE ad_member_commands/, '必须真的是一条 UPDATE');
  });
});

// ---------------------------------------------------------------------------
// H. 端到端: 路由只下发 accepted, 被拒行 failed + 审计
// ---------------------------------------------------------------------------

function signAgent(token, hostname, agentId) {
  // ★ 与 tests/security/agent-identity-grace.test.js 的 sign() 完全一致:
  //   Express 给 GET 的 body 是 `{}` (express.json 的默认), 而 agent-identity
  //   的 message 对"空对象"序列化为空串 ⇒ `${hostname}:${agentId}:`。
  return crypto.createHmac('sha256', token).update(`${hostname}:${agentId}:`).digest('hex');
}

describe('R161.35 第 3 步 H — 端到端: 被拒行不下发、置 failed、落审计', () => {
  test('H1. GET /api/agent/member-commands 只返回 accepted; 被拒行进审计', async () => {
    // ★ agentRouter() 在**构造时**就调用 getDb() (agentToken({ db: getDb() })),
    //   所以 db 必须先装好再建路由 —— 反了就是同步 throw, 不是 hang。
    const { invalidateAgentTokenCache } = await import('../../src/auth/agent-token.js');
    invalidateAgentTokenCache();

    const TOKEN = 'c'.repeat(96);
    const HOST = 'member-01';
    let resolveRows = [];
    const executed = [];

    const db = {
      dialect: 'mysql',
      sql: {
        config: { getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous')` },
        adMemberCommands: {
          claimPick: "SELECT id FROM ad_member_commands WHERE status = 'queued' LIMIT ?",
          claim: (n) => `UPDATE ad_member_commands SET status = 'running' WHERE id IN (${Array(n).fill('?').join(',')})`,
          loadByIds: (n) => `SELECT id, hostname, command_type, params_json, status, created_at, claimed_at FROM ad_member_commands WHERE id IN (${Array(n).fill('?').join(',')})`,
          rejectClaims: (n) => `UPDATE ad_member_commands SET status = 'failed', error_message = ? WHERE id IN (${Array(n).fill('?').join(',')})`,
        },
        audit: { write: AUDIT_WRITE_SQL },
      },
      query: async (sql) => {
        const text = String(sql);
        if (/agent_token_current/.test(text)) {
          return { rows: [{ config_key: 'agent_token_current', config_value: TOKEN }] };
        }
        // ★ 顺序: loadByIds 的 SELECT 也以 "SELECT id," 开头, 必须先判它。
        if (/SELECT id, hostname, command_type/.test(text)) {
          return { rows: resolveRows };
        }
        if (/^SELECT id FROM ad_member_commands/.test(text)) {
          return { rows: resolveRows.map((r) => ({ id: r.id })) };
        }
        return { rows: [] };
      },
      execute: async (sql, params) => {
        executed.push({ sql: String(sql), params });
        return { rows: [] };
      },
    };
    _setDbForTest(db);

    const { agentRouter } = await import('../../src/routes/agent.js');
    const router = agentRouter({
      config: {},
      mount: 'full',
    });

    resolveRows = [
      { id: 101, hostname: HOST, command_type: 'member_action', status: 'running', created_at: '2026-11-22T00:00:00Z', claimed_at: '2026-11-22T00:00:01Z',
        params_json: JSON.stringify({ scriptId: 'restart_service', args: { serviceName: 'Spooler' } }) },
      { id: 102, hostname: HOST, command_type: 'member_action', status: 'running', created_at: '2026-11-22T00:00:00Z', claimed_at: '2026-11-22T00:00:01Z',
        // ★ 直接写库注入的行: 合法 scriptId + 未声明字段
        params_json: JSON.stringify({ scriptId: 'restart_service', args: { serviceName: 'Spooler', extra: 'x' } }) },
      { id: 103, hostname: HOST, command_type: 'member_script', status: 'running', created_at: '2026-11-22T00:00:00Z', claimed_at: '2026-11-22T00:00:01Z',
        params_json: JSON.stringify({ script: 'Invoke-Expression $x' }) },
    ];

    // 直接驱动路由栈 (不启 HTTP 端口): 找到 member-commands 的 GET 层。
    const layer = router.stack.find((l) => l.route
      && l.route.path === '/api/agent/member-commands'
      && l.route.methods.get);
    assert.ok(layer, '必须存在 GET /api/agent/member-commands');
    const stack = layer.route.stack;

    const req = {
      method: 'GET',
      url: '/api/agent/member-commands',
      path: '/api/agent/member-commands',
      query: { hostname: HOST },
      body: {},
      headers: {
        'x-agent-token': TOKEN,
        'x-agent-hostname': HOST,
        'x-agent-id': 'agent-member-01',
        'x-agent-signature': signAgent(TOKEN, HOST, 'agent-member-01'),
      },
    };
    const out = { statusCode: 200, body: null };
    const res = {
      status(code) { out.statusCode = code; return this; },
      json(payload) { out.body = payload; return this; },
      setHeader() {},
      getHeader() { return undefined; },
    };

    // 直接驱动中间件 + 处理函数 (Express 会把 res 绑成 this)。
    // agentMw 成功时调用 next() ⇒ 交给处理函数; 401/503 则直接写 res 终结。
    const mw = stack[0].handle;
    const handler = stack[1].handle;
    const passed = await new Promise((done) => {
      const next = (err) => done({ err: err || null });
      const ret = mw.call(res, req, res, next);
      if (ret && typeof ret.then === 'function') ret.catch((e) => done({ err: e }));
      // 中间件同步终结了请求 ⇒ 已经不会再调 next
      if (out.body !== null) done({ err: null });
    });
    if (passed.err) throw passed.err;
    assert.equal(out.body, null, `agentMw 必须放行 (实际 ${out.statusCode}: ${JSON.stringify(out.body)})`);
    await handler.call(res, req, res, () => {});

    assert.equal(out.statusCode, 200, `路由必须 200, 实际 ${out.statusCode}: ${JSON.stringify(out.body)}`);
    const commands = out.body?.commands ?? [];
    assert.deepEqual(commands.map((c) => c.id), [101],
      '★ 只有合法的 101 能下发给 agent; 102/103 是注入行, 绝不下发');
    assert.equal(typeof commands[0].params, 'object', 'params 必须是对象');

    const rejectCall = executed.find((e) => /status = 'failed'/.test(e.sql));
    assert.ok(rejectCall, '被拒行必须被置 failed');
    assert.deepEqual(rejectCall.params.slice(1), [102, 103], '两个注入行都要被置 failed');
    assert.match(String(rejectCall.params[0]), /rejected at claim \(R161\.35\)/,
      'error_message 必须写明是领取时拒绝, 操作员看得到');

    const auditActions = executed
      .filter((e) => /INSERT INTO audit_logs/.test(e.sql))
      .map((e) => e.params[1]);
    assert.equal(auditActions.filter((a) => a === 'ad_member_command_rejected').length, 2,
      '每条被拒行一条 rejected 审计 (攻击尝试可见)');
    assert.equal(auditActions.filter((a) => a === 'ad_member_command_claimed').length, 1,
      '只有 accepted 行才写 claimed 审计');
  });
});

// ---------------------------------------------------------------------------
// I. agent 侧: drainer 对未声明类型不执行
// ---------------------------------------------------------------------------

describe('R161.35 第 3 步 I — agent drainer 对未声明 commandType 不执行', () => {
  test('I1. drainer 拒绝未知 commandType 并回报 failed, 不调 dispatcher', async () => {
    const drainer = await import(pathToFileURL(path.join(SERVER_ROOT, 'agent', 'src', 'member-commands-drainer.js')).href);
    const dispatched = [];
    const posted = [];
    const summary = await drainer.drainMemberCommands({
      hostname: 'member-01',
      token: 't',
      centerUrl: 'http://center',
      httpGetJson: async () => ({
        ok: true,
        status: 200,
        data: { commands: [
          { id: 1, commandType: 'member_script', params: { script: 'Invoke-Expression $x' } },
          { id: 2, commandType: 'member_action', params: { scriptId: 'restart_service', args: { serviceName: 'Spooler' } } },
        ] },
      }),
      httpPostJson: async ({ url, body }) => {
        posted.push({ url, body });
        return { ok: true, status: 200 };
      },
      dispatchMemberCommand: async (arg) => {
        dispatched.push(arg);
        return { success: true, data: null, error: null, exitCode: 0, durationMs: 1 };
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(dispatched.length, 1, '★ 只有 member_action 能进 dispatcher');
    assert.equal(dispatched[0].commandType, 'member_action');
    assert.match(posted[0].url, /\/member-commands\/1\/result$/, '被拒行也要回报结果');
    assert.equal(posted[0].body.success, false);
    assert.match(String(posted[0].body.error), /unsupported commandType: member_script/);
    assert.equal(summary.processed, 2);
    assert.equal(summary.failed, 1);
  });

  test('I2. 源码级: 四棵树的 drainer 都有类型收口', () => {
    const trees = ['agent', 'noadagent'];
    const greens = [path.join(REPO_ROOT, 'ADAgent', 'agent'), path.join(REPO_ROOT, 'MemberAgent', 'agent')];
    for (const t of trees) {
      const f = path.join(SERVER_ROOT, t, 'src', 'member-commands-drainer.js');
      const src = fs.readFileSync(f, 'utf8');
      assert.match(src, /commandType !== 'member_action'/, `${f}: 必须有 commandType 收口`);
    }
    for (const g of greens) {
      const f = path.join(g, 'src', 'member-commands-drainer.js');
      if (!fs.existsSync(f)) continue;
      assert.match(fs.readFileSync(f, 'utf8'), /commandType !== 'member_action'/, `${f}: 绿包也要有收口`);
    }
  });
});
