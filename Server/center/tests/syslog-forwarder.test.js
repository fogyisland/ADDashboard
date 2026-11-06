// center/tests/syslog-forwarder.test.js
// R161.28 (2026-11-06) — syslog 转发的回归网。
//
// 覆盖：默认关闭 / 配置解析的每一条拒绝分支 / RFC 5424 报文格式 /
// 级别过滤 / UDP 真发（本地 dgram 收包）/ TCP 帧格式 / 队列上限丢最旧 /
// 日志路径不受转发故障影响。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import {
  parseSyslogConfig,
  formatRfc5424,
  createSyslogForwarder
} from '../src/services/syslog-forwarder.js';

function waitFor(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (cond()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('A. 默认关闭', () => {
  it('A1. 空配置 → enabled=false (syslog_enabled is off)', () => {
    const cfg = parseSyslogConfig({});
    assert.equal(cfg.enabled, false);
    assert.match(cfg.reason, /off/);
  });

  it('A2. syslog_enabled=0 → 关闭', () => {
    const cfg = parseSyslogConfig({ syslog_enabled: '0', syslog_host: '10.0.0.5' });
    assert.equal(cfg.enabled, false);
  });

  it('A3. 关闭时 forwarder 不建 socket，状态 enabled=false', () => {
    const fwd = createSyslogForwarder({});
    fwd.start(parseSyslogConfig({}));
    const s = fwd.getStatus();
    assert.equal(s.enabled, false);
    assert.equal(fwd._state.udpSocket, null);
    assert.equal(fwd._state.tcpSocket, null);
    fwd.stop();
  });
});

describe('B. 配置解析 —— 每一条拒绝分支都不能把中心带崩', () => {
  it('B1. 开了但没填 host → 关闭 + 原因', () => {
    const cfg = parseSyslogConfig({ syslog_enabled: '1', syslog_host: '  ' });
    assert.equal(cfg.enabled, false);
    assert.match(cfg.reason, /host is empty/);
  });

  it('B2. 端口越界 / 非数字 → 关闭 + 原因（不抛）', () => {
    for (const bad of ['0', '70000', 'abc', '', '-1', '51.4']) {
      const cfg = parseSyslogConfig({ syslog_enabled: '1', syslog_host: 'h', syslog_port: bad });
      assert.equal(cfg.enabled, false, `port=${JSON.stringify(bad)} should be rejected`);
      assert.match(cfg.reason, /syslog_port/);
    }
  });

  it('B3. 协议只认 udp/tcp', () => {
    const ok1 = parseSyslogConfig({ syslog_enabled: '1', syslog_host: 'h', syslog_protocol: 'udp' });
    assert.equal(ok1.enabled, true);
    assert.equal(ok1.protocol, 'udp');
    const ok2 = parseSyslogConfig({ syslog_enabled: '1', syslog_host: 'h', syslog_protocol: 'TCP' });
    assert.equal(ok2.protocol, 'tcp');
    const bad = parseSyslogConfig({ syslog_enabled: '1', syslog_host: 'h', syslog_protocol: 'tls' });
    assert.equal(bad.enabled, false);
  });

  it('B4. 默认值：port 514 / udp / info / queue 10000', () => {
    const cfg = parseSyslogConfig({ syslog_enabled: '1', syslog_host: 'h' });
    assert.equal(cfg.port, 514);
    assert.equal(cfg.protocol, 'udp');
    assert.equal(cfg.minLevel, 'info');
    assert.equal(cfg.queueMax, 10000);
    assert.equal(cfg.appName, 'addashboard-center');
  });

  it('B5. 非法 min_level 回落 info（不抛）', () => {
    const cfg = parseSyslogConfig({ syslog_enabled: '1', syslog_host: 'h', syslog_min_level: 'verbose' });
    assert.equal(cfg.minLevel, 'info');
  });

  it('B6. syslog_enabled=true 字符串也认', () => {
    const cfg = parseSyslogConfig({ syslog_enabled: 'true', syslog_host: 'h' });
    assert.equal(cfg.enabled, true);
  });
});

describe('C. RFC 5424 报文格式', () => {
  it('C1. PRI 正确 (facility=1 user, severity 由 level 映射)', () => {
    const info = formatRfc5424({ level: 30, msg: 'x' }, { hostname: 'h1' });
    assert.match(info, /^<14>1 /); // 1*8+6 = 14
    const warn = formatRfc5424({ level: 40, msg: 'x' }, { hostname: 'h1' });
    assert.match(warn, /^<12>1 /); // 1*8+4
    const err = formatRfc5424({ level: 50, msg: 'x' }, { hostname: 'h1' });
    assert.match(err, /^<11>1 /); // 1*8+3
  });

  it('C2. 头部字段齐全：VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG', () => {
    const line = formatRfc5424(
      { level: 30, time: Date.parse('2026-11-06T16:20:00.123Z'), component: 'agent', module: 'hb', msg: 'hello' },
      { appName: 'myapp', hostname: 'srv01' }
    );
    assert.match(line, /^<\d+>1 2026-11-06T16:20:00\.123Z srv01 myapp \d+ /);
    assert.ok(line.includes('[addashboard@32473 component="agent" module="hb"]'));
    assert.ok(line.trimEnd().endsWith('}'), 'MSG 部分应当是 JSON');
  });

  it('C3. STRUCTURED-DATA 转义 "\\\\] —— 否则接收端判 malformed', () => {
    const line = formatRfc5424(
      { level: 30, component: 'a"b\\c]d', msg: 'm' },
      { hostname: 'h' }
    );
    assert.ok(line.includes('component="a\\"b\\\\c\\]d"'), `got: ${line}`);
  });

  it('C4. 头部里的空格 / 控制字符被替换（否则字段错位）', () => {
    const line = formatRfc5424({ level: 30, msg: 'm' }, { hostname: 'bad host\x01', appName: 'a b' });
    const header = line.split(' [addashboard')[0];
    assert.ok(header.includes('bad-host-'), `header: ${header}`);
    assert.ok(header.includes('a-b'), `header: ${header}`);
  });

  it('C5. MSG 保留结构化 JSON（SIEM 可解析）', () => {
    const line = formatRfc5424({ level: 40, component: 'x', msg: 'boom', extra: 42 }, { hostname: 'h' });
    const jsonPart = line.slice(line.indexOf('] ') + 2);
    const parsed = JSON.parse(jsonPart);
    assert.equal(parsed.msg, 'boom');
    assert.equal(parsed.extra, 42);
  });
});

describe('D. 级别过滤', () => {
  it('D1. minLevel=warn 时 info 不转发、warn/error 转发', async () => {
    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '127.0.0.1', port: 1, protocol: 'udp', minLevel: 'warn', queueMax: 100, appName: 't' });
    // 用 _state.sent 观察
    const before = fwd.getStatus().sent;
    fwd.tap({ level: 30, msg: 'info' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fwd.getStatus().sent - before, 0, 'info 不该被转发');
    fwd.tap({ level: 40, msg: 'warn' });
    await waitFor(() => fwd.getStatus().sent - before >= 1, 1500);
    assert.ok(fwd.getStatus().sent - before >= 1, 'warn 应当被转发');
    fwd.stop();
  });
});

describe('E. 真发 UDP —— 本地 dgram 收包', () => {
  it('E1. 开启后 tap 的日志真的到达 UDP 套接字，且是 RFC 5424', async () => {
    const server = dgram.createSocket('udp4');
    const received = [];
    await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
    const port = server.address().port;
    server.on('message', (buf) => received.push(buf.toString('utf8')));

    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '127.0.0.1', port, protocol: 'udp', minLevel: 'info', queueMax: 100, appName: 'testapp' });
    fwd.tap({ level: 30, component: 'unit', msg: 'hello syslog' });

    const got = await waitFor(() => received.length > 0, 3000);
    fwd.stop();
    await new Promise((r) => server.close(r));

    assert.ok(got, '没收到 UDP 包');
    assert.match(received[0], /^<14>1 .* testapp /);
    assert.ok(received[0].includes('hello syslog'));
  });

  it('E2. sendTestMessage 在 UDP 上返回 ok:true', async () => {
    const server = dgram.createSocket('udp4');
    await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '127.0.0.1', port, protocol: 'udp', minLevel: 'info', queueMax: 100, appName: 't' });
    const r = await fwd.sendTestMessage('selftest');
    fwd.stop();
    await new Promise((res) => server.close(res));
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  it('E3. 未启用时 sendTestMessage 返回 ok:false + 原因（不抛）', async () => {
    const fwd = createSyslogForwarder({});
    fwd.start(parseSyslogConfig({}));
    const r = await fwd.sendTestMessage();
    assert.equal(r.ok, false);
    assert.match(r.error, /not enabled/);
    fwd.stop();
  });
});

describe('F. 真发 TCP —— RFC 6587 octet-counting 帧', () => {
  it('F1. TCP 收到的帧带 "<len> " 前缀，且内容与长度一致', async () => {
    const received = [];
    const server = net.createServer((sock) => {
      sock.on('data', (buf) => received.push(buf));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '127.0.0.1', port, protocol: 'tcp', minLevel: 'info', queueMax: 100, appName: 'tcptest' });
    // 等连接建立
    await waitFor(() => fwd.getStatus().connected === true, 3000);
    fwd.tap({ level: 30, msg: 'over tcp' });

    const got = await waitFor(() => received.length > 0, 3000);
    fwd.stop();
    await new Promise((res) => server.close(res));

    assert.ok(got, 'TCP 没收到数据');
    const text = Buffer.concat(received).toString('utf8');
    const m = /^(\d+) /.exec(text);
    assert.ok(m, `缺少 octet-counting 前缀: ${text.slice(0, 80)}`);
    const declared = Number(m[1]);
    const body = text.slice(m[0].length);
    assert.equal(Buffer.byteLength(body, 'utf8'), declared, '声明长度与实际不符');
    assert.ok(body.includes('over tcp'));
    assert.match(body, /^<14>1 /);
  });
});

describe('G. 队列与故障隔离', () => {
  it('G1. 队列满时丢最旧，dropped 计数递增（不无限吃内存）', () => {
    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '127.0.0.1', port: 1, protocol: 'tcp', minLevel: 'info', queueMax: 3, appName: 'q' });
    // TCP 未连接 ⇒ 全部入队
    for (let i = 0; i < 10; i++) fwd.tap({ level: 30, msg: `m${i}` });
    assert.equal(fwd._state.queue.length, 3);
    assert.equal(fwd.getStatus().dropped, 7);
    fwd.stop();
  });

  it('G2. 转发目标不可达不影响调用方（tap 永不抛）', () => {
    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '203.0.113.1', port: 9, protocol: 'udp', minLevel: 'info', queueMax: 10, appName: 'x' });
    assert.doesNotThrow(() => {
      for (let i = 0; i < 20; i++) fwd.tap({ level: 50, msg: `e${i}` });
    });
    fwd.stop();
  });

  it('G3. 停止后 tap 不再发送', async () => {
    const fwd = createSyslogForwarder({});
    fwd.start({ enabled: true, host: '127.0.0.1', port: 9, protocol: 'udp', minLevel: 'info', queueMax: 10, appName: 'x' });
    fwd.stop();
    const before = fwd.getStatus().sent;
    fwd.tap({ level: 30, msg: 'after stop' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(fwd.getStatus().sent, before);
  });
});
