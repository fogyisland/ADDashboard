// R158.113 (2026-10-17) — MCP write tools (原 6 AD write actions, 现 5). 1:1 平行
// routes/mcp.js (R158.102) 范式. 唯一差异:
//   (1) mount 在 /mcp-write (跟 /mcp 1:1 平行, R158.103 锁 path-scope)
//   (2) 5 write tool 走 adAdminCommands.queueCommand + adAdminCommands._testInternals.validators
//   (3) site_keyword 解析 + Hub fallback (ad-command-dispatch.js)
//   (4) audit action: 'mcp.write.request' / 'mcp.write.request.failed' (R158.113
//       跟 mcp.read 区分; audit-classifier.js 加 2 entry)
//
// R158.X.99.36 (2026-10-22) — 摘掉 mcp_write_ad_user_delete (原第 6 个 tool).
//   操作员 directive: 「去掉这个删除，因为系统已经删除了删除操作」+「已经不存在
//   节点，我们也不需要这个危险功能」—— 底层 DC 节点已不存在, 该能力永不可用.
//
//   为什么删 tool 而 0 删底层 (分层原则):
//     删 MCP tool = **收窄对外暴露面** (LLM 的决策依据里不再有这个选项)
//     删 HTTP 端点/commandType = **删既有能力** (影响 UI 等其它消费方)
//     本次只做前者. 保留不动的部分 (有意为之, 不是漏改):
//       - services/ad-admin-commands.js:45 COMMAND_TYPES 里的 'user_delete'
//       - services/ad-admin-commands.js:214 validators.user_delete
//       - routes/admin.js POST /api/admin/ad-commands 的通用 dispatch
//     依据: 操作员 directive「用到端点就新建, 端点不要改」(lesson 13 家族).
//
//   顺带消失的 1 处既有不一致 (0 需额外改动):
//     摘掉前 'confirm=true 强制' 实际**只在本 MCP tool 层**强制 (本文件旧 :280).
//     而两个 UI 入口 (UserDeleteConfirmModal.vue:94 / UserPropertyPanel.vue:570)
//     直接发 commandType='user_delete' **不带 confirm**, 服务端也不校验 ——
//     即 confirm 只挡住了 LLM, 没挡住人. 摘掉 MCP tool 后该不一致一并消失.
//
//   0 改 agent 端: 真正的 Remove-ADUser 在 agent/scripts/ad-admin-users.ps1:337,
//   经 dispatchers/ad-admin.js:104 的 **prefix 分派** (user_ 前缀 → 脚本), 不是逐
//   case. 属 agent 版本管辖范围 (R158.56c directive: 任何 agent 版本不能自动
//   升级, 必 operator push + restart), 本次 0 碰. 中心端摘 tool 无需动 agent.
//
// 5 write tool 1:1 映射 3 on-demand 包 (ad_ad_users_write / ad_ad_groups_write /
// ad_ad_account_quickfix). 0 改 agent binary (R158.69.3 锁). 0 改 schema.
// 0 改 12 read tool (mcp.js 全保留).
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { writeAudit } from '../services/audit.js';
import { _clientIp } from '../auth/mcp-token.js';
import { resolveTargetDc, buildAdParams, redactForAudit, HttpErr } from '../services/ad-command-dispatch.js';
// R161.6 (2026-10-26) — flag 判定语义抽到公共函数 (与 mcp.js /
//   report-center.js / 前端 web/src/lib/featureFlag.js 同一份定义)。
import { readFeatureFlag } from '../utils/featureFlag.js';

const TOOL_TIMEOUT_MS = 30_000;
const JSONRPC_INTERNAL_ERROR = -32603;

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    t.unref?.();
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e); });
  });
}

function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true
  };
}

// 共享 write 工具: 走 resolveTargetDc + buildAdParams + queueCommand 5 步 pipeline.
// adAdminCommands 懒加载 (跟 admin.js:1854 await import 1:1 平行, 0 顶层 import
// 防止 server.js 启动期 cycle).
async function _loadAdAdminCommands() {
  if (!_svcAdAdminCommands) _svcAdAdminCommands = await import('../services/ad-admin-commands.js');
  return _svcAdAdminCommands;
}
let _svcAdAdminCommands = null;

async function dispatchWrite(db, logger, { commandType, params, siteKeyword, explicitDc }) {
  // 1. resolve dc
  let resolved;
  try {
    resolved = await resolveTargetDc({ siteKeyword, explicitDc, db });
  } catch (e) {
    if (e instanceof HttpErr) {
      return { ok: false, status: e.status, error: e.message };
    }
    throw e;
  }
  if (resolved.ambiguous) {
    return {
      ok: false,
      status: 300,
      error: 'multiple sites match site_keyword — please narrow or pass target_dc explicitly',
      candidates: resolved.candidates
    };
  }
  // 2. validate params
  const adAdminCommands = await _loadAdAdminCommands();
  let normalized;
  try {
    normalized = await buildAdParams(commandType, params, adAdminCommands);
  } catch (e) {
    if (e instanceof HttpErr) {
      return { ok: false, status: e.status, error: e.message };
    }
    throw e;
  }
  // 3. queue command
  const row = await adAdminCommands.queueCommand({
    targetDc: resolved.dc,
    commandType,
    params: normalized,
    operatorId: null
  });
  // 4. audit (mcp.write.request — R158.113 跟 mcp.read 区分)
  await writeAudit({
    userId: null,
    action: 'ad_command_queued',
    target: `${commandType}:${normalized.sam || normalized.name || 'n/a'}`,
    payload: {
      tool: `mcp_write_${commandType}`,
      commandId: row.id,
      dc: resolved.dc,
      source: resolved.source,
      params: redactForAudit(normalized)
    },
    logger
  });
  return {
    ok: true,
    commandId: row.id,
    targetDc: resolved.dc,
    source: resolved.source,
    commandType,
    status: 'queued'
  };
}

// ---- 6 tool handlers ------------------------------------------------------
function buildServer({ db, logger }) {
  const server = new McpServer(
    { name: 'dashboard-center-write', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // 1. password reset
  server.tool(
    'mcp_write_ad_user_password_reset',
    'Reset the password for an AD user. Routes to ad_ad_users_write package, commandType=user_password_reset. site_keyword optional — falls back to hub site. force=true skips DC-online pre-flight.',
    {
      site_keyword: z.string().optional().describe('Site name keyword (LIKE match on ad_sites.site_name). Optional — falls back to hub site if 0 match. If several sites match (e.g. keyword "枫林" matches both "SPH枫林" and "康德乐枫林"), the call returns an ambiguity error listing candidates — re-ask the user which one rather than guessing, since this selects the DC that will execute the write.'),
      target_dc: z.string().optional().describe('Explicit DC name. Overrides site_keyword if both given.'),
      sam: z.string().describe('AD user SAM (sAMAccountName)'),
      newPassword: z.string().min(12).describe('New password (min 12 chars)'),
      mustChangePassword: z.boolean().optional().describe('Force change at next logon (default false)'),
      unlockAccount: z.boolean().optional().describe('Also unlock the account (default true)'),
      force: z.boolean().optional().describe('Skip DC-online pre-flight (default false)')
    },
    async (args) => {
      const result = await dispatchWrite(db, logger, {
        commandType: 'user_password_reset',
        params: { sam: args.sam, newPassword: args.newPassword, mustChangePassword: args.mustChangePassword, unlockAccount: args.unlockAccount },
        siteKeyword: args.site_keyword,
        explicitDc: args.target_dc
      });
      if (!result.ok) return errorResult(`${result.status} ${result.error}`);
      return textResult(result);
    }
  );

  // 2. user create
  server.tool(
    'mcp_write_ad_user_create',
    'Create a new AD user. commandType=user_create. Requires sam + password (min 12).',
    {
      site_keyword: z.string().optional(),
      target_dc: z.string().optional(),
      sam: z.string().describe('AD user SAM (sAMAccountName)'),
      password: z.string().min(12).describe('Initial password (min 12 chars)'),
      givenName: z.string().optional(),
      surname: z.string().optional(),
      displayName: z.string().optional(),
      upn: z.string().optional(),
      ouPath: z.string().optional(),
      description: z.string().optional(),
      mustChangePassword: z.boolean().optional(),
      force: z.boolean().optional()
    },
    async (args) => {
      const result = await dispatchWrite(db, logger, {
        commandType: 'user_create',
        params: {
          sam: args.sam, password: args.password,
          givenName: args.givenName, surname: args.surname,
          displayName: args.displayName, upn: args.upn,
          ouPath: args.ouPath, description: args.description,
          mustChangePassword: args.mustChangePassword
        },
        siteKeyword: args.site_keyword,
        explicitDc: args.target_dc
      });
      if (!result.ok) return errorResult(`${result.status} ${result.error}`);
      return textResult(result);
    }
  );

  // 3. group create
  server.tool(
    'mcp_write_ad_group_create',
    'Create a new AD group. commandType=group_create. Requires name + category (Security/Distribution) + scope (DomainLocal/Global/Universal).',
    {
      site_keyword: z.string().optional(),
      target_dc: z.string().optional(),
      name: z.string().describe('Group name (sAMAccountName for groups)'),
      category: z.enum(['Security', 'Distribution']).describe('Group category'),
      scope: z.enum(['DomainLocal', 'Global', 'Universal']).describe('Group scope'),
      sam: z.string().optional(),
      displayName: z.string().optional(),
      ouPath: z.string().optional(),
      description: z.string().optional(),
      mail: z.string().optional(),
      force: z.boolean().optional()
    },
    async (args) => {
      const result = await dispatchWrite(db, logger, {
        commandType: 'group_create',
        params: {
          name: args.name, category: args.category, scope: args.scope,
          sam: args.sam, displayName: args.displayName,
          ouPath: args.ouPath, description: args.description, mail: args.mail
        },
        siteKeyword: args.site_keyword,
        explicitDc: args.target_dc
      });
      if (!result.ok) return errorResult(`${result.status} ${result.error}`);
      return textResult(result);
    }
  );

  // 4. user unlock
  server.tool(
    'mcp_write_ad_user_unlock',
    'Unlock a locked-out AD user. commandType=user_unlock. Only sam required.',
    {
      site_keyword: z.string().optional(),
      target_dc: z.string().optional(),
      sam: z.string().describe('AD user SAM'),
      force: z.boolean().optional()
    },
    async (args) => {
      const result = await dispatchWrite(db, logger, {
        commandType: 'user_unlock',
        params: { sam: args.sam },
        siteKeyword: args.site_keyword,
        explicitDc: args.target_dc
      });
      if (!result.ok) return errorResult(`${result.status} ${result.error}`);
      return textResult(result);
    }
  );

  // 5. user enable/disable (boolean routes 2 commandType)
  server.tool(
    'mcp_write_ad_user_enable_disable',
    'Enable or disable an AD user. commandType=user_enable or user_disable based on enabled flag.',
    {
      site_keyword: z.string().optional(),
      target_dc: z.string().optional(),
      sam: z.string().describe('AD user SAM'),
      enabled: z.boolean().describe('true = enable, false = disable'),
      force: z.boolean().optional()
    },
    async (args) => {
      const commandType = args.enabled ? 'user_enable' : 'user_disable';
      const result = await dispatchWrite(db, logger, {
        commandType,
        params: { sam: args.sam },
        siteKeyword: args.site_keyword,
        explicitDc: args.target_dc
      });
      if (!result.ok) return errorResult(`${result.status} ${result.error}`);
      return textResult(result);
    }
  );

  // R158.X.99.36 (2026-10-22) — 原第 6 个 tool mcp_write_ad_user_delete 已摘除.
  //   理由与保留边界见文件头注释. 剩下 5 个 tool 编号沿用原序 (1~5), 0 重排 ——
  //   重排会让"第 N 个"这种外部引用漂移, 而编号本身对 LLM 无意义.
  //
  //   剩余 5 个 (均非破坏性终态操作):
  //     1. mcp_write_ad_password_reset
  //     2. mcp_write_ad_user_create
  //     3. mcp_write_ad_group_create
  //     4. mcp_write_ad_user_unlock
  //     5. mcp_write_ad_user_enable_disable

  return server;
}

// ---- HTTP router ----------------------------------------------------------
// 1:1 平行 mcpRouter R158.102 + R158.110 范式. session 命名 'mcp-write-session'
// 跟 mcp read 区分, SDK 1.x onsessioninitialized 钩子登记真实 sid.
export function mcpWriteRouter({ logger, db, adAdminCommands }) {
  const r = Router();

  // R158.X.116.k (2026-10-23) — feature flag `mcp_write.enabled` 后端闸门。
  //   关闭时 POST/GET/DELETE /mcp-write 一律 503, 已持有的 mcpw_ token
  //   彻底失效 —— 这是"关掉 = 真关掉", 跟只藏前端 tab 有本质区别
  //   (持有 token 的人本来就能绕过 UI 直接调 5 个写 tool)。
  //
  //   /healthz **不拦**: 它是公开端点 (R158.103  precedent, mcpToken
  //   middleware 内部短路), 存在的意义就是让外部探针知道服务状态。
  //   但要把 enabled=false 如实报出去, 否则探针会以为服务还活着而
  //   反复重试一个被刻意关掉的东西。
  //
  //   fail-open: 查询失败 → 放行。理由同前端 router guard (R158.X.116.i)
  //   与 license gate: 一次 DB 抖动不该把运维的写通道锁死。关掉是**显式**
  //   动作 (operator 在开关页点), 不是故障的副作用。
  async function isWriteEnabled() {
    // R161.6 — 判定逻辑搬进 src/utils/featureFlag.js, 语义与原实现**逐字相同**
    //   (缺行=不拦 / 读库失败=fail-open / '1'|1|true=放行 / 其它值=拦), 行为零变化。
    return readFeatureFlag(db, 'mcp_write.enabled', logger, 'mcp-write');
  }

  r.get('/healthz', async (_req, res) => {
    const enabled = await isWriteEnabled();
    res.json({
      ok: enabled,
      enabled,
      server: 'dashboard-center-mcp-write',
      version: '1.0.0',
      tool_count: 5,   // R158.X.99.36: 6 → 5 (摘掉 mcp_write_ad_user_delete)
      protocol: 'streamable-http',
      scope: 'ad-write',
      ...(enabled ? {} : { reason: 'disabled_by_feature_flag:mcp_write.enabled' })
    });
  });

  async function gate(req, res, next) {
    const enabled = await isWriteEnabled();
    if (enabled) return next();
    logger?.warn?.({ method: req.method, path: req.path, clientIp: _clientIp(req) },
      'mcp-write request blocked: feature flag mcp_write.enabled is off');
    // 503 + JSON-RPC shape: MCP 客户端 (Claude/Cursor) 期望 JSON-RPC 错误,
    // 给 HTML/纯文本会让它们报难以理解的解析错误。
    res.status(503).json(jsonRpcError(null, JSONRPC_INTERNAL_ERROR,
      'MCP write server is disabled by feature flag (mcp_write.enabled)'));
  }

  const sessions = new Map();
  const _pendingInit = new Map();

  async function getOrCreateSession(req) {
    const headerSession = req.headers['mcp-session-id'];
    if (headerSession) {
      const existing = sessions.get(headerSession);
      if (existing) return existing;
      const pending = _pendingInit.get(headerSession);
      if (pending) return pending;
    } else {
      const pending = _pendingInit.get(undefined);
      if (pending) return pending;
    }

    const entry = { transport: null, server: null, inFlight: false };
    const initPromise = (async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, entry);
          _pendingInit.delete(headerSession || undefined);
          entry._sid = sid;
          logger?.debug?.({ event: 'mcp-write.session.initialized', sid }, 'mcp-write session initialized');
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
          _pendingInit.delete(sid);
          logger?.debug?.({ event: 'mcp-write.session.closed', sid }, 'mcp-write session closed via DELETE');
        }
      });
      const server = buildServer({ db, logger });
      entry.transport = transport;
      entry.server = server;
      transport.onclose = () => {
        const sid = entry._sid;
        if (sid && sessions.get(sid) === entry) sessions.delete(sid);
        else {
          for (const [k, v] of sessions) {
            if (v === entry) { sessions.delete(k); break; }
          }
        }
        server.close().catch((err) => {
          logger?.error?.({ event: 'mcp-write.server.close_failed', err: err?.message }, 'mcp-write server close failed');
        });
      };
      await server.connect(transport);
      return entry;
    })();

    _pendingInit.set(headerSession || undefined, initPromise);
    try {
      return await initPromise;
    } finally {
      if (_pendingInit.get(headerSession || undefined) === initPromise) {
        _pendingInit.delete(headerSession || undefined);
      }
    }
  }

  async function handleMcp(req, res) {
    const session = await getOrCreateSession(req);
    const startMs = Date.now();
    let auditMeta = {
      method: req.method,
      path: req.path,
      sessionId: session.transport.sessionId,
      // R158.X.99.report (2026-10-21) — 补 clientIp, 1:1 平行 mcp.js:511.
      //   日报「MCP 调用统计」段按 IP 聚合. 复用 mcp-token.js 的 _clientIp
      //   单一真源, 与本文件自己的 IP 白名单判定 (mcp-write-token.js, R158.X.99.28
      //   已收敛到同一 helper) 取值口径一致 —— 报告里显示的必须是实际被鉴权的那个 IP.
      clientIp: _clientIp(req)
    };
    try {
      await withTimeout(
        session.transport.handleRequest(req, res, req.body),
        TOOL_TIMEOUT_MS,
        'mcp-write request'
      );
      auditMeta.duration_ms = Date.now() - startMs;
      writeAudit({
        userId: null,
        action: 'mcp.write.request',
        target: 'mcp-write',
        payload: auditMeta,
        logger
      }).catch(() => {});
    } catch (e) {
      auditMeta.duration_ms = Date.now() - startMs;
      auditMeta.error = e?.message || String(e);
      writeAudit({
        userId: null,
        action: 'mcp.write.request.failed',
        target: 'mcp-write',
        payload: auditMeta,
        logger
      }).catch(() => {});
      logger.error({ err: e?.message, method: req.method, path: req.path }, 'mcp-write request failed');
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(null, JSONRPC_INTERNAL_ERROR, 'mcp-write request failed'));
      }
    }
  }

  // R158.X.116.k — gate 挂在 handleMcp **之前**, 且刻意排除 /healthz
  //   (healthz 自己注册在前面, Express 按注册顺序匹配, 不受影响)。
  r.post('/', gate, handleMcp);
  r.get('/', gate, handleMcp);
  r.delete('/', gate, handleMcp);

  return r;
}
