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
//
// ★ R161.35 第 2 步 (2026-11-22) 改写了这里的契约: params 不再是
//   { script, timeoutSec }, 而是 { scriptId, args }。但 C 组要守的**性质**
//   没变 —— 未知字段必须响亮拒绝 (而不是静默丢弃), force 必须走 query。
// ---------------------------------------------------------------------------

describe('R161.35 C — force 字段无声失败 / 未知字段拒绝', () => {
  test('C1. 服务端 params 校验必须拒绝未知顶层字段 (并给出允许清单)', () => {
    const validate = memberCmd._testInternals.validateMemberAction;
    assert.ok(validate, '_testInternals 必须暴露 validateMemberAction');

    // force is still not a command parameter — it belongs on the query string
    const withForce = validate({ scriptId: 'restart_service', args: { serviceName: 'Spooler' }, force: true });
    assert.equal(withForce.ok, false, 'params.force 必须被拒绝');
    assert.match(withForce.error, /force/);
    assert.match(withForce.error, /scriptId/, '错误信息必须列出允许的字段 (可操作)');

    // a typo'd field is not silently swallowed
    const withUnknown = validate({ scriptId: 'restart_service', args: { serviceName: 'Spooler' }, timeout_secs: 30 });
    assert.equal(withUnknown.ok, false, '未知顶层字段必须被拒绝');
    assert.match(withUnknown.error, /timeout_secs/);
  });

  test('C2. validateMemberAction 接受 { scriptId, args } 并按 schema 归一化', () => {
    const validate = memberCmd._testInternals.validateMemberAction;

    const ok = validate({ scriptId: 'restart_service', args: { serviceName: 'Spooler' } });
    assert.equal(ok.ok, true, `正常路径不能被误伤: ${ok.error || ''}`);
    assert.deepEqual(ok.normalized, { scriptId: 'restart_service', args: { serviceName: 'Spooler' } });
  });

  test('C2b. ★ 自由 PowerShell (params.script) 必须被明确拒绝, 且错误可操作', () => {
    const validate = memberCmd._testInternals.validateMemberAction;
    const retired = validate({ script: 'Get-Service', timeoutSec: 30 });
    assert.equal(retired.ok, false, '★ 自由脚本文本必须被拒绝 —— 整个第 2 步就是为了删掉它');
    assert.match(retired.error, /retired/i, '错误必须说明这是"已退役"的通道, 不是拼写错误');
    assert.match(retired.error, /scriptId/, '错误必须告诉调用方改用 { scriptId, args }');
  });

  test('C2c. 未知 scriptId / 未知 arg / 缺失必填 arg 都必须被拒绝', () => {
    const validate = memberCmd._testInternals.validateMemberAction;

    const badScript = validate({ scriptId: 'rm_rf', args: {} });
    assert.equal(badScript.ok, false);
    assert.match(badScript.error, /unknown scriptId/);

    const badArg = validate({ scriptId: 'restart_service', args: { serviceName: 'Spooler', extra: 1 } });
    assert.equal(badArg.ok, false);
    assert.match(badArg.error, /extra/);

    const missing = validate({ scriptId: 'restart_service', args: {} });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /serviceName/);

    // schema violation: serviceName with a space can never reach Get-Service
    const pattern = validate({ scriptId: 'restart_service', args: { serviceName: 'Spooler; calc' } });
    assert.equal(pattern.ok, false, 'serviceName 必须匹配白名单正则');
  });

  test('C2d. 服务层的 COMMAND_TYPES 只接受 member_action', () => {
    const { COMMAND_TYPES, VALIDATORS } = memberCmd._testInternals;
    assert.deepEqual([...COMMAND_TYPES], ['member_action'], '只允许 member_action');
    assert.equal(typeof VALIDATORS.member_action, 'function', 'VALIDATORS 必须挂在 member_action 上');
    assert.equal(VALIDATORS.member_script, undefined, 'member_script 不得再有校验器 (已退役)');
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
    const paramsBlock = modalSrc.match(/params:\s*\{[^}]*\}/);
    assert.ok(paramsBlock, 'modal 必须有 params 块');
    assert.doesNotMatch(
      paramsBlock[0],
      /force/,
      '★ modal 不得再把 force 放进 params —— 那样它会被服务端拒绝 (或静默丢弃, 复选框变摆设)'
    );
    // but it must still be sent, at the top level of the request
    assert.match(modalSrc, /force:\s*form\.force/, 'modal 必须仍然发送 force (只是换到 query 上)');

    // and the modal must no longer send script text
    assert.doesNotMatch(modalSrc, /script:\s*form\.script/, '★ modal 不得再提交自由脚本文本');
  });

  test('C4. ★ 负向测试: 旧的"塞进 params"实现必须被 C3 的判据抓出来', () => {
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
    const paramsBlock = oldModal.match(/params:\s*\{[^}]*\}/);
    assert.match(paramsBlock[0], /force/,
      '旧实现的 params 里含 force, 必须被 C3 的判据抓到');
    assert.match(oldModal, /script:\s*form\.script/,
      '旧实现的 params 里含脚本文本, 必须被 C3 的"不得提交脚本文本"判据抓到');
  });
});

// ---------------------------------------------------------------------------
// D. 退役证明: 自由脚本执行链必须整条消失
//
// ★ 这些是"负向不变量" —— 断言某些东西**不存在**。它们比断言"新东西存在"
//   更容易因为合法注释而误报, 所以 D2 会先剥掉注释, 再由 D4 证明剥离逻辑
//   既不会漏掉真调用, 也不会把注释当成调用。
// ---------------------------------------------------------------------------

// Strip // and /* */ comments so "the code used to do X" notes don't trip
// the negative invariants above. Deliberately dumb: this only ever runs on
// our own source, and a wrong strip is caught by D4.
//
// ★ 第一版的判据是「排除冒号」的行内注释正则 —— 想避开 http:// 这种 URL,
//   结果是把注释**删掉**而不是保留, 于是「注释里的 Invoke-Expression」和
//   「真调用」都变成不存在, 判据完全分不开 (D4 当场抓到了这个假绿)。
//   现在按行处理: 整行注释直接丢弃, 行尾注释截断 (引号后的 // 不算注释)。
//
// ★ 正则用 RegExp 构造器写, 是为了让这个文件本身不出现裸的 /* 序列,
//   免得本文件被别的、更粗的剥离器误伤 —— 教训来自 R161.35 第 2 步里
//   反复踩的「注释/字符串里的特殊字符被当成代码」这一类。
const BLOCK_COMMENT_RE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINE_SPLIT_RE = new RegExp('\r?\n');
const FULL_LINE_COMMENT_RE = new RegExp('^\\s*//');
const TRAILING_COMMENT_RE = new RegExp("(^|[^:'\"])\\/\\/.*$");
function stripComments(src) {
  return src
    .replace(BLOCK_COMMENT_RE, '')
    .split(LINE_SPLIT_RE)
    .filter((line) => !FULL_LINE_COMMENT_RE.test(line))
    .map((line) => line.replace(TRAILING_COMMENT_RE, '$1'))
    .join(String.fromCharCode(10));
}

describe('R161.35 第 2 步 D — 自由 PowerShell 执行链退役', () => {
  test('D1. run-member-script.ps1 必须在四棵树里都不存在', () => {
    const candidates = [
      path.join(SERVER_ROOT, 'agent', 'scripts', 'run-member-script.ps1'),
      path.join(SERVER_ROOT, 'noadagent', 'scripts', 'run-member-script.ps1'),
      path.join(REPO_ROOT, 'ADAgent', 'agent', 'scripts', 'run-member-script.ps1'),
      path.join(REPO_ROOT, 'MemberAgent', 'agent', 'scripts', 'run-member-script.ps1')
    ];
    for (const f of candidates) {
      assert.equal(fs.existsSync(f), false,
        `★ ${f} 必须被删除 —— 它是 Invoke-Expression 的执行入口, 留着就等于留着 RCE`);
    }
  });

  test('D2. 四棵树的 dispatcher 都不得再出现 Invoke-Expression / -Command', () => {
    const dispatchers = [
      path.join(SERVER_ROOT, 'agent', 'src', 'dispatchers', 'member-commands.js'),
      path.join(SERVER_ROOT, 'noadagent', 'src', 'dispatchers', 'member-commands.js'),
      path.join(REPO_ROOT, 'ADAgent', 'agent', 'src', 'dispatchers', 'member-commands.js'),
      path.join(REPO_ROOT, 'MemberAgent', 'agent', 'src', 'dispatchers', 'member-commands.js')
    ];
    for (const f of dispatchers) {
      assert.ok(fs.existsSync(f), `${f} 必须存在 (它现在只调度密封动作)`);
      const stripped = stripComments(fs.readFileSync(f, 'utf8'));
      assert.doesNotMatch(stripped, /Invoke-Expression/i,
        `${f}: 不得调用 Invoke-Expression (注释里的历史说明不算)`);
      assert.doesNotMatch(stripped, /['"]-Command['"]/,
        `${f}: 不得再用 powershell -Command 传代码 —— 只能是 -File + -ParamsPath`);
    }
  });

  test('D3. 中心侧的 deny-list 不得复活', () => {
    const { DENIED_PATTERNS } = memberCmd._testInternals;
    assert.equal(DENIED_PATTERNS.length, 0,
      '★ 正则黑名单不能复活 —— 它守不住 PowerShell, 真正的闸门是密封清单');
  });

  test('D4. ★ 负向测试: 判据必须能区分真调用与历史注释', () => {
    const broken = [
      "const args = ['-NoProfile', '-Command', body];",
      'Invoke-Expression $body;',
      '// 历史注释: 以前这里就是 Invoke-Expression $body;'
    ].join('\n');
    assert.match(stripComments(broken), /Invoke-Expression/i, '判据必须能抓到真调用');
    assert.match(stripComments(broken), /['"]-Command['"]/);
    const clean = [
      '// historical: used to call Invoke-Expression, see R161.35',
      "const args = ['-File', scriptPath, '-ParamsPath', paramsPath];"
    ].join('\n');
    assert.doesNotMatch(stripComments(clean), /Invoke-Expression/i, '纯注释不得误报');
  });
});
