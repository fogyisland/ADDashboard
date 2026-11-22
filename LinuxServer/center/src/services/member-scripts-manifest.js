// R161.35 第 2 步 (2026-11-22) — 中心侧 member 命令**脚本封装**清单。
//
// ★ 这是 agent/src/member-scripts.js 的**镜像**。
//   两侧必须逐项一致 (scriptId 集合 + 每个参数的 schema), 由
//   Server/scripts/audit/check-member-script-manifest.mjs 守卫。
//
// ★ 为什么中心侧要有一份副本而不是 import agent 那份:
//   中心和 agent 是**独立交付物** (Server/center 与 ADAgent/MemberAgent
//   各自打包装到不同机器上)。中心机上根本没有 agent 的源码树, 所以
//   不能 import。两份副本 + 守卫比一个跨树相对路径 import 更安全 ——
//   跨树 import 在打包后必然 404。
//
// ★ 为什么中心侧也要校验 schema:
//   校验必须发生在 **queue 时** (行还没入库)。如果只在 agent 侧校验,
//   一个坏命令会先被写进 ad_member_commands, 轮到 agent 领取才失败,
//   操作员看到的是一次"成功排队但执行失败", 排查成本高。中心先拦 ⇒
//   操作员立刻得到 400 + 可读错误。
//
// ★ 中心侧**不需要** sha256: 它不执行脚本, 不做完整性比对。哈希校验是
//   agent 侧的事 (那边才是真正把字节交给 powershell.exe 的地方)。

/**
 * Script schema mirror. Keep the `args` blocks in lockstep with
 * agent/src/member-scripts.js — the guard compares them field by field.
 *
 * ★ `timeoutSec` here is for validation/preview only. The agent's manifest
 *   value is what actually bounds the run.
 */
export const MEMBER_SCRIPTS = Object.freeze({
  restart_service: {
    timeoutSec: 60,
    label: '重启服务',
    args: {
      serviceName: { type: 'string', pattern: '^[A-Za-z0-9_.\\-]{1,128}$', maxLen: 128, label: '服务名' },
      force: { type: 'bool', optional: true, label: '强制 (连带重启依赖项)' }
    }
  },
  collect_now: {
    timeoutSec: 60,
    label: '立即采集',
    args: {
      kind: { type: 'enum', values: ['replication', 'discovery'], label: '采集类型' }
    }
  },
  agent_diagnostics: {
    timeoutSec: 30,
    label: '只读诊断',
    args: {
      kind: { type: 'enum', values: ['services', 'disk', 'eventlog'], label: '诊断类型' },
      maxEntries: { type: 'int', min: 1, max: 200, optional: true, label: '最多条数 (事件日志)' }
    }
  }
});

export const SCRIPT_IDS = Object.freeze(Object.keys(MEMBER_SCRIPTS));

/**
 * Validate `args` against the schema for `scriptId`.
 * Returns { ok: true, normalized } or { ok: false, error }.
 *
 * ★ Identical semantics to the agent-side validator: unknown args are
 *   REJECTED (never dropped), missing required args are a loud error, and
 *   an unknown schema type fails closed.
 */
export function validateArgs(scriptId, args) {
  const entry = MEMBER_SCRIPTS[scriptId];
  if (!entry) {
    return { ok: false, error: `unknown scriptId: ${scriptId}` };
  }
  // ★ Guard against prototype-pollution-style keys: a payload like
  //   { "__proto__": {...} } must not be treated as a known arg.
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object' };
  }

  const allowed = new Set(Object.keys(entry.args));
  const unknown = Object.keys(args)
    .filter((k) => !allowed.has(k) && k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown arg(s) for ${scriptId}: ${unknown.map((k) => `"${k}"`).join(', ')} `
        + `(allowed: ${[...allowed].join(', ') || '(none)'})`
    };
  }

  const normalized = {};
  for (const [name, spec] of Object.entries(entry.args)) {
    const raw = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : undefined;
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (spec.optional) continue;
      return { ok: false, error: `missing arg: ${name}` };
    }

    switch (spec.type) {
      case 'string': {
        if (typeof raw !== 'string') {
          return { ok: false, error: `arg ${name} must be a string` };
        }
        if (spec.maxLen && raw.length > spec.maxLen) {
          return { ok: false, error: `arg ${name} exceeds ${spec.maxLen} chars` };
        }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(raw)) {
          return { ok: false, error: `arg ${name} contains control characters` };
        }
        if (spec.pattern && !new RegExp(spec.pattern).test(raw)) {
          return { ok: false, error: `arg ${name} does not match the required format` };
        }
        normalized[name] = raw;
        break;
      }
      case 'enum': {
        if (!spec.values.includes(raw)) {
          return { ok: false, error: `arg ${name} must be one of: ${spec.values.join(', ')}` };
        }
        normalized[name] = raw;
        break;
      }
      case 'int': {
        const n = Number(raw);
        if (!Number.isInteger(n)) {
          return { ok: false, error: `arg ${name} must be an integer` };
        }
        if (n < spec.min || n > spec.max) {
          return { ok: false, error: `arg ${name} must be in [${spec.min}, ${spec.max}]` };
        }
        normalized[name] = n;
        break;
      }
      case 'bool': {
        if (typeof raw !== 'boolean') {
          return { ok: false, error: `arg ${name} must be true or false` };
        }
        normalized[name] = raw;
        break;
      }
      default:
        return { ok: false, error: `internal: unknown arg type "${spec.type}" for ${name}` };
    }
  }
  return { ok: true, normalized };
}
