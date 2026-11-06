// center/src/services/syslog-forwarder.js
//
// R161.28 (2026-11-06) — 运维日志转发到 syslog 服务器（UDP / TCP，RFC 5424）。
//
// 需求（操作员 2026-11-06）:
//   「需要在运维日志中提供一个 syslog 服务器的转发功能，默认为关闭，
//     但是开启设定了日志转发之后就可以将日志发送到 log 服务器中」
//
// 设计要点
// --------
// 1. **零新依赖** —— 只用 Node 内置的 `node:dgram`（UDP）与 `node:net`（TCP）。
//    UDP 走 RFC 5424 §6.4 的帧格式（PRI 优先，超长则按字节数交给 syslog 库
//    自行拆分）；TCP 走 RFC 6587 octet-counting 帧（`<len> SP <msg>`），这是
//    rsyslog / syslog-ng / Graylog 的通用接收方式。
//
// 2. **默认关闭** —— `syslog_enabled` 默认 '0'。关闭时本模块**不建任何 socket**，
//    也不注册任何 pino hook，对现有日志路径零影响（目标机行为一个字节都不变）。
//
// 3. **不改动文件日志路径** —— 文件日志仍然由 pino-roll 写；syslog 是
//    **旁路 tap**：由 pino 的 `hooks.logMethod` 在每条日志写出时复制一份。
//    这样：
//      · 文件写到磁盘是既有行为，不因 syslog 故障而丢；
//      · syslog 服务器不可达时**只影响转发**，不影响中心本体（fail-open）；
//      · 不需要 pino.transport 的 worker 线程（那会改变 pino-roll 的写入线程
//        语义，风险远大于收益）。
//
// 4. **背压有界** —— 内存队列上限 `SYSLOG_QUEUE_MAX`（默认 10000 条）。满了
//    按 **丢最旧** 策略（保留最新，运维更关心刚发生的事），并累计
//    `droppedCount`，定期以一条 `warning` 级别日志自报 —— 绝不无限增长吃内存。
//
// 5. **可热更新** —— 管理后台保存配置后调 `applyConfig()`，无需重启中心
//    （与 email_enabled / retention 等现有 KV 热更新 1:1 平行）。
//
// 6. **机密** —— syslog 本身不涉及口令，但 `syslog_host` 属于网络拓扑信息，
//    读取时原样返回（运维要看到它才敢改）；不写进 audit_logs 之外的地方。
//
// 7. **可观测** —— `getStatus()` 回报：是否启用、已发送条数、丢弃条数、最近
//    一次错误、连接状态（TCP）。管理后台的「测试连接」按钮就是调它 + 发一条
//    自检日志。

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

// RFC 5424 severity (0 = emergency … 7 = debug). pino level number → syslog severity.
// pino: 10 trace / 20 debug / 30 info / 40 warn / 50 error / 60 fatal
const PINO_TO_SEVERITY = {
  10: 7, // debug
  20: 7, // debug
  30: 6, // info
  40: 4, // warning
  50: 3, // error
  60: 2, // critical
  70: 2  // alert
};

// RFC 5424 facility. 1 = user-level (默认，不污染系统日志分类)。
const FACILITY_USER = 1;

// 「中心」自身作为 syslog 发送者时用的 APP-NAME —— 超过 48 字符会被截断
// (RFC 5424 §6.2.3)。
const DEFAULT_APP_NAME = 'addashboard-center';

const QUEUE_MAX_DEFAULT = 10000;
const RECONNECT_DELAY_MS = 5000;

// 从配置 bundle 里解析出转发参数。任何一项不合法 → `{ enabled: false, reason }`
// —— **绝不因为配置写错就把中心带崩**（运维场景下「少转发」远好于「服务起不来」）。
export function parseSyslogConfig(bundle = {}) {
  const rawEnabled = String(bundle.syslog_enabled ?? '0').trim();
  const enabled = rawEnabled === '1' || rawEnabled.toLowerCase() === 'true';
  if (!enabled) {
    return { enabled: false, reason: 'syslog_enabled is off' };
  }

  const host = String(bundle.syslog_host ?? '').trim();
  if (!host) {
    return { enabled: false, reason: 'syslog_host is empty' };
  }

  const protocol = String(bundle.syslog_protocol ?? 'udp').trim().toLowerCase();
  if (protocol !== 'udp' && protocol !== 'tcp') {
    return { enabled: false, reason: `syslog_protocol must be udp or tcp, got ${JSON.stringify(protocol)}` };
  }

  const portRaw = String(bundle.syslog_port ?? '514').trim();
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { enabled: false, reason: `syslog_port must be an integer in 1..65535, got ${JSON.stringify(portRaw)}` };
  }

  // minLevel: 只转发 >= 该级别的日志。默认 'info'（运维通常不想把 debug 刷到
  // 中央日志服务器，那会把 SIEM 淹掉）。
  const minLevelRaw = String(bundle.syslog_min_level ?? 'info').trim().toLowerCase();
  const allowed = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const minLevel = allowed.includes(minLevelRaw) ? minLevelRaw : 'info';

  const queueMaxRaw = Number(String(bundle.syslog_queue_max ?? QUEUE_MAX_DEFAULT).trim());
  const queueMax = Number.isInteger(queueMaxRaw) && queueMaxRaw > 0 ? queueMaxRaw : QUEUE_MAX_DEFAULT;

  return {
    enabled: true,
    host,
    port,
    protocol,
    minLevel,
    queueMax,
    appName: String(bundle.syslog_app_name ?? '').trim() || DEFAULT_APP_NAME
  };
}

// RFC 5424 HEADER 里不允许出现的字符（SP / 控制字符）会被替换成 '-'，
// 否则接收方解析器会错位。RFC 5424 §6.2: PRINTUSASCII except SP。
function sanitizeHeaderToken(value, fallback = '-') {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  const cleaned = s.replace(/[\s\u0000-\u001F\u007F]/g, '-');
  return cleaned.slice(0, 48) || fallback;
}

// RFC 5424 STRUCTURED-DATA 里的 PARAM-VALUE 需要转义 `"` `\` `]`（§6.3.3）。
function escapeSdValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\]/g, '\\]');
}

// 把一条 pino 日志（已 JSON.parse 的对象）格式化成 RFC 5424 文本。
// 形如：
//   <PRI>1 2026-11-06T16:20:00.123Z host app procid - [addashboard@32473 component="agent" level="info"] {"msg":...}
// 注意：MSG 部分保留原始 JSON —— 对 SIEM 最友好（可解析字段），同时人也能读。
export function formatRfc5424(record, { appName = DEFAULT_APP_NAME, hostname } = {}) {
  const levelNum = Number(record?.level);
  const severity = PINO_TO_SEVERITY[levelNum] ?? 6;
  const pri = FACILITY_USER * 8 + severity;

  const ts = record?.time
    ? new Date(record.time).toISOString()
    : new Date().toISOString();

  const host = sanitizeHeaderToken(hostname ?? os.hostname(), '-');
  const app = sanitizeHeaderToken(appName, DEFAULT_APP_NAME);
  const procid = sanitizeHeaderToken(process.pid, '-');
  const msgid = sanitizeHeaderToken(record?.event ?? record?.msg, '-');

  // STRUCTURED-DATA: 私有的 SD-ID 必须带 enterprise number（RFC 5424 §7.2.2）。
  // 32473 是 IANA 文档示例企业号，正式注册后应替换 —— 接收端不校验它，但
  // 格式必须正确，否则 rsyslog 会把整条消息判为 malformed。
  const sdComponent = escapeSdValue(record?.component ?? '-');
  const sdModule = escapeSdValue(record?.module ?? '-');
  const sd = `[addashboard@32473 component="${sdComponent}" module="${sdModule}"]`;

  const msg = JSON.stringify(record ?? {});
  return `<${pri}>1 ${ts} ${host} ${app} ${procid} ${msgid} ${sd} ${msg}`;
}

// RFC 6587 octet-counting 帧（TCP）。
function frameOctetCounting(payload) {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

/**
 * 创建一个 syslog 转发器实例。**不自动启动** —— 调用方拿到 config 后调
 * `start(cfg)`；配置变更调 `applyConfig(cfg)`；进程退出调 `stop()`。
 *
 * 返回的对象同时可作为「旁路 tap」挂到 pino 的 hooks.logMethod 上：
 * `forwarder.tap(record)` 期望收到 **已解析的日志对象**。
 */
export function createSyslogForwarder({ logger, hostname } = {}) {
  const state = {
    disabled: true,
    reason: 'not configured',
    config: null,
    queue: [],
    dropped: 0,
    sent: 0,
    errors: 0,
    lastError: null,
    lastSentAt: null,
    connected: false,
    udpSocket: null,
    tcpSocket: null,
    reconnectTimer: null,
    flushTimer: null,
    stopped: false
  };

  const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

  function minLevelNum() {
    return LEVELS[state.config?.minLevel] ?? 30;
  }

  // ---- 传输层 -------------------------------------------------------------
  function ensureUdpSocket() {
    if (state.udpSocket) return state.udpSocket;
    const socket = dgram.createSocket('udp4');
    // UDP 是无连接的 —— "error" 事件是唯一能拿到失败（如 ICMP 端口不可达）
    // 的地方；不挂监听器 = 未捕获异常 = 进程崩。这与 mysql2 的教训同源。
    socket.on('error', (err) => {
      state.errors += 1;
      state.lastError = `udp: ${err?.message ?? err}`;
      try { socket.close(); } catch { /* already closed */ }
      state.udpSocket = null;
    });
    state.udpSocket = socket;
    return socket;
  }

  function ensureTcpSocket() {
    if (state.tcpSocket) return state.tcpSocket;
    const cfg = state.config;
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    socket.on('connect', () => {
      state.connected = true;
      state.lastError = null;
      drain();
    });
    socket.on('error', (err) => {
      state.connected = false;
      state.errors += 1;
      state.lastError = `tcp: ${err?.message ?? err}`;
      scheduleReconnect();
    });
    socket.on('close', () => {
      state.connected = false;
      state.tcpSocket = null;
      scheduleReconnect();
    });
    // 消费 backpressure 的 'drain' —— 见 send() 里的 socket.write 返回值处理。
    socket.on('drain', () => drain());

    state.tcpSocket = socket;
    return socket;
  }

  function scheduleReconnect() {
    if (state.stopped || state.reconnectTimer || state.disabled) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.stopped || state.disabled) return;
      // 重连后把积压的点再冲一遍
      if (state.queue.length > 0) drain();
    }, RECONNECT_DELAY_MS);
    // Node 不该因为一个后台重连定时器把进程钉住 —— 允许进程正常退出。
    if (typeof state.reconnectTimer.unref === 'function') state.reconnectTimer.unref();
  }

  // ---- 发送 ---------------------------------------------------------------
  function send(payload) {
    const cfg = state.config;
    if (cfg.protocol === 'tcp') {
      const socket = ensureTcpSocket();
      if (!state.connected) {
        // 还没连上 —— 放回队列头，等 connect 后 drain。若队列已满，丢最旧。
        enqueue(payload, { toFront: true });
        return;
      }
      try {
        const ok = socket.write(frameOctetCounting(payload));
        state.sent += 1;
        state.lastSentAt = new Date().toISOString();
        if (!ok) {
          // 内核缓冲区满 —— 暂停发送，等 'drain'。不在这里阻塞。
          state.paused = true;
        }
      } catch (err) {
        state.errors += 1;
        state.lastError = `tcp write: ${err?.message ?? err}`;
        state.connected = false;
        enqueue(payload, { toFront: true });
      }
      return;
    }

    // UDP：单条报文超过 MTU 会被内核分片（或直接 EMSGSIZE）。RFC 5424 §6.4
    // 建议接收方支持至少 480 字节、至多 2048 字节的报文；这里截断到 2048 并
    // 在尾部加标记 —— 宁可丢字段也不让一条超长日志把整个发送路径搞挂。
    const LIMIT = 2048;
    let body = payload;
    if (Buffer.byteLength(body, 'utf8') > LIMIT) {
      const buf = Buffer.from(body, 'utf8').subarray(0, LIMIT - 16);
      body = buf.toString('utf8').replace(/�+$/, '') + ' ...[truncated]';
    }
    const socket = ensureUdpSocket();
    try {
      socket.send(Buffer.from(body, 'utf8'), cfg.port, cfg.host, (err) => {
        if (err) {
          state.errors += 1;
          state.lastError = `udp send: ${err.message}`;
          return;
        }
        state.sent += 1;
        state.lastSentAt = new Date().toISOString();
      });
    } catch (err) {
      state.errors += 1;
      state.lastError = `udp send: ${err?.message ?? err}`;
    }
  }

  // ---- 队列 ---------------------------------------------------------------
  function enqueue(payload, { toFront = false } = {}) {
    const max = state.config?.queueMax ?? QUEUE_MAX_DEFAULT;
    if (state.queue.length >= max) {
      // 丢最旧 —— 运维更关心刚发生的事。
      if (toFront) {
        state.queue.pop();
      } else {
        state.queue.shift();
      }
      state.dropped += 1;
      if (state.dropped % 1000 === 1) {
        logger?.warn?.(
          { component: 'syslog', dropped: state.dropped, queued: state.queue.length, queueMax: max },
          'syslog queue full — dropping oldest entries'
        );
      }
    }
    if (toFront) state.queue.unshift(payload);
    else state.queue.push(payload);
  }

  function drain() {
    if (state.disabled || state.stopped) return;
    if (state.config?.protocol === 'tcp' && !state.connected) return;
    if (state.paused) return;
    while (state.queue.length > 0) {
      const payload = state.queue.shift();
      send(payload);
      if (state.paused) break;
    }
  }

  // ---- 对外 API -----------------------------------------------------------
  /**
   * 旁路 tap —— 由 pino `hooks.logMethod` 在每条日志写出时调用。
   * 入参是**已序列化的日志对象**（pino hook 拿到的是合并后的对象）。
   * 本函数必须**永不抛** —— 它挂在整个进程的日志路径上。
   */
  function tap(record) {
    try {
      if (state.disabled || state.stopped) return;
      if (!record || typeof record !== 'object') return;
      const level = Number(record.level);
      if (!Number.isFinite(level) || level < minLevelNum()) return;
      const payload = formatRfc5424(record, { appName: state.config.appName, hostname });
      if (state.config.protocol === 'tcp' && (!state.connected || state.paused)) {
        enqueue(payload);
        return;
      }
      send(payload);
    } catch (err) {
      // 日志转发失败绝不能影响业务日志路径。只计数，不抛、不再记日志
      // （记日志会再次进入 tap ⇒ 无限递归）。
      state.errors += 1;
      state.lastError = `tap: ${err?.message ?? err}`;
    }
  }

  function start(cfg) {
    state.config = cfg;
    state.disabled = cfg.enabled !== true;
    state.reason = cfg.reason ?? (cfg.enabled ? '' : 'disabled');
    if (state.disabled) return state;
    if (cfg.protocol === 'tcp') ensureTcpSocket();
    else ensureUdpSocket();
    logger?.info?.(
      { component: 'syslog', host: cfg.host, port: cfg.port, protocol: cfg.protocol, minLevel: cfg.minLevel },
      'syslog forwarding enabled'
    );
    return state;
  }

  // 配置热更新：关闭 → 拆 socket；开启/改目标 → 重建 socket。
  function applyConfig(cfg) {
    stop({ keepQueue: true });
    state.stopped = false;
    return start(cfg);
  }

  function stop({ keepQueue = false } = {}) {
    state.stopped = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.udpSocket) {
      try { state.udpSocket.close(); } catch { /* already closed */ }
      state.udpSocket = null;
    }
    if (state.tcpSocket) {
      try { state.tcpSocket.end(); } catch { /* already closed */ }
      state.tcpSocket = null;
    }
    state.connected = false;
    state.paused = false;
    if (!keepQueue) state.queue.length = 0;
  }

  function getStatus() {
    return {
      enabled: !state.disabled && !state.stopped,
      reason: state.reason,
      target: state.config && state.config.enabled
        ? `${state.config.protocol}://${state.config.host}:${state.config.port}`
        : null,
      minLevel: state.config?.minLevel ?? null,
      connected: state.config?.protocol === 'tcp' ? state.connected : null,
      sent: state.sent,
      dropped: state.dropped,
      errors: state.errors,
      queued: state.queue.length,
      lastError: state.lastError,
      lastSentAt: state.lastSentAt
    };
  }

  // 测试连接：发一条自检日志（level=info），返回发送前后的 sent 增量。
  // 供管理后台「测试转发」按钮调用。
  async function sendTestMessage(text = 'syslog test message from ADDashboard Center') {
    if (state.disabled || state.stopped) {
      return { ok: false, error: `forwarder is not enabled (${state.reason})` };
    }
    const before = state.sent;
    const record = {
      level: 30,
      time: Date.now(),
      component: 'syslog',
      module: 'selftest',
      msg: text
    };
    tap(record);
    // UDP 是异步回调计数，给 1500ms 让 sent 落地（不阻塞 UI 超时）
    const deadline = Date.now() + 1500;
    while (state.sent === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (state.sent > before) return { ok: true, target: getStatus().target };
    return { ok: false, error: state.lastError || 'no confirmation from transport (UDP is fire-and-forget; check the syslog server)' };
  }

  return { start, applyConfig, stop, tap, getStatus, sendTestMessage, _state: state };
}

// 进程级单例 —— server.js 在启动时创建并挂到 pino hooks 上；管理后台路由
// 通过 `getSyslogForwarder()` 访问同一实例（热更新 / 状态查询 / 测试发送）。
let singleton = null;

export function getSyslogForwarder() {
  return singleton;
}

export function setSyslogForwarder(instance) {
  singleton = instance;
  return singleton;
}
