// R161.35 (2026-11-22) — member 命令链的三个缺陷修复的回归网。
//
// ★ 背景 (来自「从黑客的角度检查漏洞」审计):
//   member-script 通道是**自由格式 PowerShell**, 以 SYSTEM 身份在成员机上
//   执行 (run-member-script.ps1:99-112 → Invoke-Expression)。整条链把全部
//   信任押在服务器端 (PS1 注释自陈 "trusts the upstream guard rails"),
//   而服务器端唯一的文本闸门是 16 条正则黑名单 (member-commands.js:58-75)。
//
// ★ 本步 (R161.35 第 1 步) 修的三个缺陷 —— 都不是新功能, 是把"缺口"补上:
//   A. `ad_member_command_timed_out` 审计**从未被写入**
//      (sweepTimeouts 不写审计 + server.js 未传 logger)
//      ⇒ 一条超时的成员命令在操作员可见的审计链里**完全消失**。
//      ★ 对安全工作的意义: 拒绝/超时路径必须可见 —— 审计缺口正是
//        攻击者最想藏东西的地方。
//   B. agent 侧临时目录**泄漏**: writeParamsFile() 每次 mkdtempSync() 建一个
//      目录, 但 finally 只 unlink 了 params.json ⇒ 目录残留; 且 params.json
//      里是**完整脚本文本**, 异常路径下会残留可读文件。
//   C. `force` 字段**无声失败**: UI 把它放进 params, 服务端只从 query 读,
//      且 params 归一化会静默丢弃它 ⇒ 那个"跳过在线检查"复选框是摆设。
//
// ★ 本文件锁住这三件事, 并且**必须包含负向测试** —— 一个永远报绿的测试
//   比没有测试更糟 (它训练人忽略失败)。
//
// 用法: cd Server/center && node --test tests/security/member-command-audit-and-cleanup.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTER_ROOT = path.resolve(HERE, '..', '..');
const SERVER_ROOT = path.resolve(CENTER_ROOT, '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const AGENT_DISPATCHER = path.join(SERVER_ROOT, 'agent', 'src', 'dispatchers', 'member-commands.js');
const NOAD_DISPATCHER = path.join(SERVER_ROOT, 'noadagent', 'src', 'dispatchers', 'member-commands.js');

const { _setDbForTest } = await import('../../src/db/index.js');
const memberCmd = await import('../../src/services/member-commands.js');

// ---------------------------------------------------------------------------
// A. sweepTimeouts 必须写审计
// ---------------------------------------------------------------------------

// A mock DB that records every SQL statement it is asked to run and lets the
// test control what SELECT returns.
function makeMockDb({ selectRows = [], dialect = 'mysql' } = {}) {
  const executed = [];
  const queried = [];
  return {
    dialect,
    executed,
    queried,
    query: async (sql, params) => {
      queried.push({ sql, params });
      return { rows: selectRows };
    },
    execute: async (sql, params) => {
      executed.push({ sql, params });
      return { insertId: 1, rows: [] };
    }
  };
}

describe('R161.35 A — member 命令超时审计补全', () => {
  let auditWrites;
  let originalWriteAuditRequired;

  before(async () => {
    // Intercept the audit module. The service imports it lazily
    // (`await import('./audit.js')`), so we have to patch the module's
    // export — ESM live bindings make that impossible, so instead we
    // record what the real audit module would do by stubbing the DB
    // execute and asserting on the INSERT that reaches it.
    //
    // The real writeAuditRequired() calls `conn.execute(conn.sql.audit.write, ...)`.
    // So we give the mock db a `sql.audit.write` slot and assert the
    // INSERT reached the DB. That tests the REAL audit module, not a stub.
    auditWrites = [];
  });

  after(() => {
    _setDbForTest(undefined);
  });

  test('A1. sweepTimeouts 必须写 ad_member_command_timed_out 审计行', async () => {
    const victim = {
      id: 4242,
      hostname: 'member-01',
      command_type: 'member_script',
      operator_id: 7,
      params_json: JSON.stringify({ script: 'Get-Service' })
    };
    const db = makeMockDb({ selectRows: [victim] });
    db.sql = {
      adMemberCommands: { sweepTimeouts: 'UPDATE ad_member_commands SET status=?' },
      audit: { write: 'INSERT INTO audit_logs (user_id, action, target, payload, created_at) VALUES (?,?,?,?,?)' }
    };
    _setDbForTest(db);

    const swept = await memberCmd.sweepTimeouts({ timeoutMs: 30000, logger: null });

    // 1) the lifecycle UPDATE must have run
    assert.ok(
      db.executed.some((e) => /UPDATE ad_member_commands/i.test(e.sql)),
      '生命周期表必须被更新成 timeout'
    );

    // 2) the audit INSERT must have run, with the right action + target
    const auditInserts = db.executed.filter((e) => /INSERT INTO audit_logs/i.test(e.sql));
    assert.equal(
      auditInserts.length, 1,
      `★ 超时必须写一条 audit_logs —— 审计链缺这一环时, 超时的成员命令会`
      + `从操作员可见的审计里彻底消失。实际写入 ${auditInserts.length} 条。`
    );
    const [, action, target, payloadJson] = auditInserts[0].params;
    assert.equal(action, 'ad_member_command_timed_out',
      '审计 action 必须是 ad_member_command_timed_out (分类器已注册这个 action)');
    assert.equal(target, 'cmd:4242', '审计 target 必须是 cmd:<id>');

    const payload = JSON.parse(payloadJson);
    assert.equal(payload.commandId, 4242);
    assert.equal(payload.hostname, 'member-01');
    assert.equal(payload.commandType, 'member_script');
    assert.equal(payload.operatorId, 7);
    assert.ok(payload.errorMessage, '审计 payload 必须带 errorMessage');

    // 3) the swept count must reflect the victims, not a hardcoded 0
    assert.equal(swept, 1, 'sweepTimeouts 必须返回被清扫的行数');
  });

  test('A2. MSSQL 方言下 sweepTimeouts 也能写审计 (双方言支持)', async () => {
    const victim = {
      id: 99,
      hostname: 'member-mssql',
      command_type: 'member_script',
      operator_id: null,
      params_json: '{}'
    };
    const db = makeMockDb({ selectRows: [victim], dialect: 'mssql' });
    db.sql = {
      adMemberCommands: { sweepTimeouts: 'UPDATE ad_member_commands SET status=?' },
      audit: { write: 'INSERT INTO audit_logs (user_id, action, target, payload, created_at) VALUES (?,?,?,?,?)' }
    };
    _setDbForTest(db);

    await memberCmd.sweepTimeouts({ timeoutMs: 30000, logger: null });

    const auditInserts = db.executed.filter((e) => /INSERT INTO audit_logs/i.test(e.sql));
    assert.equal(auditInserts.length, 1,
      'MSSQL 方言下同样必须写审计 —— 双方言的每一处改动都必须同时成立');
  });

  test('A3. SELECT 失败不得阻断生命周期更新 (fail-open on audit, fail-closed on status)', async () => {
    const db = makeMockDb({ selectRows: [] });
    db.sql = {
      adMemberCommands: { sweepTimeouts: 'UPDATE ad_member_commands SET status=?' },
      audit: { write: 'INSERT INTO audit_logs (user_id, action, target, payload, created_at) VALUES (?,?,?,?,?)' }
    };
    // make the SELECT blow up, but the UPDATE work
    const realQuery = db.query;
    db.query = async (sql, params) => {
      if (/^\s*SELECT/i.test(sql)) throw new Error('simulated SELECT failure');
      return realQuery(sql, params);
    };
    _setDbForTest(db);

    const swept = await memberCmd.sweepTimeouts({ timeoutMs: 30000, logger: null });

    assert.ok(
      db.executed.some((e) => /UPDATE ad_member_commands/i.test(e.sql)),
      '★ SELECT 失败也必须继续更新生命周期表 —— 一行永远停在 running 比缺审计更糟'
    );
    assert.equal(swept, 0, 'SELECT 失败时没有 victim, 返回 0');
  });

  test('A4. server.js 必须给 member sweeper 传 logger (否则审计写不出来)', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'server.js'), 'utf8');
    const idx = src.indexOf("src/services/member-commands.js");
    assert.notEqual(idx, -1, 'server.js 必须 import member-commands 的 sweepTimeouts');
    const window = src.slice(idx, idx + 600);
    assert.match(
      window,
      /sweepTimeouts\(\{[^}]*logger/,
      '★ member sweeper 必须传 logger —— 对照 AD 面 (server.js ~1790) 早就传了,'
      + 'member 面漏了导致审计写不出来'
    );
  });
});

// ---------------------------------------------------------------------------
// B. agent 侧临时目录必须被整个删除
// ---------------------------------------------------------------------------

describe('R161.35 B — agent 侧临时目录泄漏', () => {
  test('B1. dispatcher 必须递归删除整个临时目录, 而不是只删 params.json', () => {
    for (const file of [AGENT_DISPATCHER, NOAD_DISPATCHER]) {
      const src = fs.readFileSync(file, 'utf8');
      assert.match(
        src,
        /rmSync\(\s*paramsDir\s*,\s*\{\s*recursive:\s*true/,
        `${file}: 必须用 rmSync(paramsDir, { recursive: true }) 删除整个临时目录 —— `
        + '只 unlink params.json 会留下空目录, 且异常路径下 params.json (含完整脚本文本) 会残留'
      );
      assert.match(
        src,
        /paramsDir\s*=\s*tmp\.dir/,
        `${file}: 必须记住 tmp.dir 才有得删`
      );
    }
  });

  test('B2. 两棵 agent 树 (agent / noadagent) 必须逐字节相同', () => {
    const a = fs.readFileSync(AGENT_DISPATCHER, 'utf8');
    const b = fs.readFileSync(NOAD_DISPATCHER, 'utf8');
    assert.equal(a, b,
      'Server/agent 与 Server/noadagent 的 member-commands dispatcher 必须逐字节相同 —— '
      + '两边现在是同一份代码的分叉, 任何一边单独改都会造成行为漂移');
  });

  test('B3. ★ 负向测试: 泄漏的实现必须被测出来 (回归保护)', () => {
    // 读一份"未修复"的源码 (只 unlink params.json, 不删目录),
    // 断言 B1 的判据在它上面**不成立** —— 否则 B1 只是个永远为真的摆设。
    const broken = [
      "import { unlinkSync } from 'node:fs';",
      'let paramsPath = null;',
      'try {',
      '  paramsPath = tmp.file;',
      '} finally {',
      '  if (paramsPath) { try { unlinkSync(paramsPath); } catch {} }',
      '}'
    ].join('\n');
    const hasFix = /rmSync\(\s*paramsDir\s*,\s*\{\s*recursive:\s*true/.test(broken);
    assert.equal(hasFix, false,
      '★ 守卫判据本身必须能区分"修好"和"没修" —— 如果连明显的泄漏实现都能通过, '
      + '那这个测试就是在训练人忽略失败');
  });
});

// ---------------------------------------------------------------------------
// C. force 字段必须真正生效, 未知字段必须被拒绝
// ---------------------------------------------------------------------------

describe('R161.35 C — force 字段无声失败', () => {
  test('C1. 服务端必须拒绝 params 里的 force (并指向 query)', () => {
    const src = fs.readFileSync(path.join(CENTER_ROOT, 'src', 'services', 'member-commands.js'), 'utf8');
    assert.match(
      src,
      /force is not a command parameter/,
      '★ 服务端必须对 params.force 给出明确错误 (而不是静默丢弃) —— '
      + '静默丢弃让操作员以为"跳过在线检查"生效了, 实际没有'
    );
    assert.match(
      src,
      /unknown field\(s\)/,
      '必须拒绝一切未知 params 字段 —— 拼错的字段名 (timeout_secs) 不该被静默吞掉'
    );
  });

  test('C2. validateMemberScript 必须拒绝 force, 接受 script + timeoutSec', () => {
    const svc = memberCmd._testInternals;
    assert.ok(svc, 'member-commands 服务必须导出 _testInternals');
    const validate = svc.validateMemberScript;
    assert.ok(validate, '_testInternals 必须暴露 validateMemberScript');

    // force in params => rejected, with the actionable message
    const withForce = validate({ script: 'Get-Service', timeoutSec: 30, force: true });
    assert.equal(withForce.ok, false, 'params.force 必须被拒绝');
    assert.match(withForce.error, /force/);
    assert.match(withForce.error, /query/i, '错误信息必须指向 query 参数 (可操作)');

    // unknown field => rejected
    const withUnknown = validate({ script: 'Get-Service', timeoutSec: 30, timeout_secs: 30 });
    assert.equal(withUnknown.ok, false, '未知字段必须被拒绝');
    assert.match(withUnknown.error, /timeout_secs/);

    // the happy path still works
    const ok = validate({ script: 'Get-Service', timeoutSec: 30 });
    assert.equal(ok.ok, true, '正常路径不能被误伤');
    assert.deepEqual(
      ok.normalized, { script: 'Get-Service', timeoutSec: 30 },
      '归一化结果必须只含 script + timeoutSec'
    );
  });

  test('C3. 前端必须把 force 放进 query 而不是 params', () => {
    const apiSrc = fs.readFileSync(path.join(CENTER_ROOT, 'web', 'src', 'api', 'member-commands.js'), 'utf8');
    assert.match(
      apiSrc,
      /params:\s*force\s*\?\s*\{\s*force:\s*'true'\s*\}/,
      '★ api 层必须把 force 发成 query 参数 —— 服务端只从 req.query 读它'
    );

    const modalSrc = fs.readFileSync(
      path.join(CENTER_ROOT, 'web', 'src', 'components', 'admin', 'ExecuteCommandModal.vue'), 'utf8');
    // the modal must NOT put force inside params any more
    const paramsBlock = modalSrc.match(/params:\s*\{[\s\S]*?\}/);
    assert.ok(paramsBlock, 'modal 必须有 params 块');
    assert.doesNotMatch(
      paramsBlock[0],
      /force/,
      '★ modal 不得再把 force 放进 params —— 那样它会被服务端静默丢弃 (复选框变摆设)'
    );
    // but it must still be sent, at the top level of the request
    assert.match(
      modalSrc,
      /force:\s*form\.force/,
      'modal 必须仍然发送 force (只是换到 query 上), 否则功能被砍掉了'
    );
  });

  test('C4. ★ 负向测试: 旧的"塞进 params"实现必须被 C1/C3 的判据抓出来', () => {
    const oldApi = [
      "queueCommand: ({ hostname, commandType = 'member_script', params }) =>",
      "  api.post('/api/admin/member-commands', { hostname, commandType, params }),"
    ].join('\n');
    assert.equal(
      /params:\s*force\s*\?\s*\{\s*force:\s*'true'\s*\}/.test(oldApi),
      false,
      '★ 判据必须能区分新旧实现 —— 否则 C3 是个永远为真的摆设'
    );

    const oldModal = 'params: { script: form.script, timeoutSec: form.timeoutSec, force: form.force }';
    const paramsBlock = oldModal.match(/params:\s*\{[\s\S]*?\}/);
    assert.match(paramsBlock[0], /force/,
      '旧实现的 params 里含 force, 必须被 C3 的判据抓到');
  });
});
