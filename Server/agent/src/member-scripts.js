// R161.35 第 2 步 (2026-11-22) — member-server 命令**脚本封装**清单。
//
// ★ 这个文件解决什么问题:
//   R81 的 member-script 通道让操作员在 Web 上写**任意 PowerShell 全文**,
//   agent 侧用 `Invoke-Expression` 直接执行 (run-member-script.ps1),
//   以 SYSTEM 身份跑在成员机上。唯一的闸门是中心侧 16 条正则黑名单
//   —— 而黑名单结构上拦不住 PowerShell (编码执行 / 反射 / 动态构造 /
//   未列入的持久化工具)。审计结论: 这条通道等价于"任意代码执行"。
//
// ★ 修法 = 把「代码」和「数据」彻底分开:
//   代码 (PS1 文件)  —— 固定在磁盘上, 随 agent 分发, 可 review, 有 sha256
//   数据 (参数)      —— 结构化 JSON, 每个 scriptId 一套 schema
//   操作员只能选 scriptId + 填参数, **不能传脚本**。
//
// ★ 为什么不只做 schema 还要做 sha256:
//   光有 schema 挡的是"参数乱填", 挡不住"脚本文件被改"。
//   操作员的原始问题是「黑客修改了 PowerShell 代码」—— 那正好是
//   sha256 清单直接回答的: 执行前比对文件哈希, 任何改动当场拒绝。
//
// ★ 这个清单是 **SSOT**:
//   · agent 侧 dispatcher 用它 (白名单 + 哈希校验)
//   · 中心侧 services/member-scripts.js 用同一份形状校验参数
//   · scripts/audit/check-member-script-manifest.mjs 校验两侧一致 + 哈希正确
//   三处漂移 = 守卫报红。改动任何一个 PS1 **必须**同步更新这里的 sha256。
//
// ★ 新加一个能做的事 = 写一个 PS1 + 在这里登记 + 发版。这一次摩擦是
//   有意的: 它把"服务器端被攻破"的攻击面从「任意代码」压成「清单里的
//   有限动作」, 而攻击者没有构建链私钥就改不了这份清单所在的发布包。

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
// member-scripts.js lives in agent/src/ ⇒ scripts/ is two levels up.
const DEFAULT_SCRIPTS_DIR = resolve(dirname(__filename), '..', '..', 'scripts');

/**
 * The manifest. Every entry is:
 *   scriptId  — the ONLY thing the operator can name in a command
 *   file      — fixed PS1 filename inside scripts/
 *   sha256    — hex digest of that exact file (see scripts/audit guard)
 *   timeoutSec — hard timeout for this action (clamped again in the PS1)
 *   args      — parameter schema (see validateArgs)
 *
 * ★ arg schema types:
 *   'string'  — required, no control chars, <= maxLen
 *   'enum'    — required, must be one of `values`
 *   'int'     — required, integer in [min, max]
 *   'bool'    — required, literal true/false
 *
 * ★ Every arg is REQUIRED unless `optional: true`. That is deliberate:
 *   an omitted required arg must be a loud 400, not a silent default.
 */
export const MEMBER_SCRIPTS = Object.freeze({
  // ── 重启 Windows 服务 ────────────────────────────────────────────────
  // The single most common ops action on a member server, and exactly the
  // kind of thing that used to require a free-form script.
  restart_service: {
    file: 'member-restart-service.ps1',
    sha256: 'd7bfcc36c35885664e6d26da4887bc6a29dc4f0d465f920d4d1d2e1584f1a5dc',           // filled by scripts/audit/refresh-member-script-hashes.mjs
    timeoutSec: 60,
    args: {
      serviceName: { type: 'string', pattern: '^[A-Za-z0-9_.\\-]{1,128}$', maxLen: 128 },
      force: { type: 'bool', optional: true }
    }
  },

  // ── 触发一次采集 ─────────────────────────────────────────────────────
  // Runs one of the agent's own bundled collectors and returns its result.
  // No arbitrary script — the collector file is already on disk and
  // already runs on the heartbeat.
  collect_now: {
    file: 'member-collect-now.ps1',
    sha256: '54ecf5743c41f09bf27d96522488edd1edee1dcc95fc0899e810f0d74fc4cb1c',
    timeoutSec: 60,
    args: {
      kind: { type: 'enum', values: ['collector'] }
    }
  },

  // ── 只读诊断 ─────────────────────────────────────────────────────────
  // Strictly read-only: service list / recent event log / disk usage.
  // ★ Deliberately no "run arbitrary command" variant.
  agent_diagnostics: {
    file: 'member-diagnostics.ps1',
    sha256: 'da0423d919f41d086bfd1d051f17d86d26879776205a1cad6c3ca38313a56f1e',
    timeoutSec: 30,
    args: {
      kind: { type: 'enum', values: ['services', 'disk', 'eventlog'] },
      // eventlog only: how many recent entries (bounded hard at 200).
      maxEntries: { type: 'int', min: 1, max: 200, optional: true }
    }
  }
});

/** All script ids, for the guard + the center-side allowlist. */
export const SCRIPT_IDS = Object.freeze(Object.keys(MEMBER_SCRIPTS));

/**
 * Validate `args` against the schema for `scriptId`.
 * Returns { ok: true, normalized } or { ok: false, error }.
 *
 * ★ Unknown keys are REJECTED, never dropped — a silently-dropped field is
 *   indistinguishable from a broken one on the operator's side (this is the
 *   same lesson as the `force` bug in R161.35 step 1).
 */
export function validateArgs(scriptId, args) {
  const entry = MEMBER_SCRIPTS[scriptId];
  if (!entry) {
    return { ok: false, error: `unknown scriptId: ${scriptId}` };
  }
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object' };
  }

  const allowed = new Set(Object.keys(entry.args));
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown arg(s) for ${scriptId}: ${unknown.map((k) => `"${k}"`).join(', ')} `
        + `(allowed: ${[...allowed].join(', ') || '(none)'})`
    };
  }

  const normalized = {};
  for (const [name, spec] of Object.entries(entry.args)) {
    const raw = args[name];
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
        // A schema type we don't understand must FAIL CLOSED — otherwise a
        // typo in the manifest silently disables validation for one arg.
        return { ok: false, error: `internal: unknown arg type "${spec.type}" for ${name}` };
    }
  }
  return { ok: true, normalized };
}

/** sha256 of a file, or null if it cannot be read. */
export function sha256File(absPath) {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Resolve + integrity-check the script file for `scriptId`.
 * Returns { ok: true, scriptPath, entry } or { ok: false, error }.
 *
 * ★ This is the answer to "黑客修改了 PowerShell 代码": the file's bytes
 *   must hash to exactly the digest baked into the manifest that shipped
 *   with this agent. Any edit — one character, one added line — fails here
 *   and the command is refused BEFORE powershell.exe is spawned.
 */
export function resolveScriptFile(scriptId, scriptsDir = DEFAULT_SCRIPTS_DIR) {
  const entry = MEMBER_SCRIPTS[scriptId];
  if (!entry) return { ok: false, error: `unknown scriptId: ${scriptId}` };

  const scriptPath = join(scriptsDir, entry.file);
  if (!existsSync(scriptPath)) {
    return { ok: false, error: `script file missing: ${entry.file}` };
  }
  if (!entry.sha256 || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    // Empty / malformed digest means the manifest was never sealed.
    // Fail closed: an unsealed manifest provides no integrity at all.
    return {
      ok: false,
      error: `manifest digest missing for ${scriptId} (run scripts/audit/refresh-member-script-hashes.mjs)`
    };
  }
  const actual = sha256File(scriptPath);
  if (actual !== entry.sha256) {
    return {
      ok: false,
      error: `script integrity check failed for ${scriptId}: `
        + `expected ${entry.sha256.slice(0, 12)}…, got ${String(actual).slice(0, 12)}… `
        + '(the file on disk does not match the manifest shipped with this agent)'
    };
  }
  return { ok: true, scriptPath, entry };
}

export const _testing = Object.freeze({ DEFAULT_SCRIPTS_DIR, sha256File });
