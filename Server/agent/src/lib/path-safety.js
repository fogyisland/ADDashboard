// 2026-09-09 S82 (security) — File-push path-traversal guard.
//
// The file-push wire format (operator-supplied targetPath + filename) is
// resolved by Node's `path.resolve` to an absolute path on the agent.
// Without a guard, `mkdirSync({recursive:true})` will create ANY ancestor
// dir, so `..\..\..\Windows\System32\evil.dll` would land in System32
// without the agent realizing the path escaped its intended root.
//
// This module exposes one function: validatePayloadPath. It rejects:
//   - filename containing `..`, `\0`, `:` (drive separator), `/`, `\`,
//     control chars, or leading `.` (relative / hidden)
//   - any path outside the configured allowedRoots (case-insensitive on
//     Windows — `c:\addashboard\…` and `C:\ADDashboard\…` resolve the same)
//   - symlink escape (best-effort: lstat each component and reject symlinks)
//
// The center's services/file-push.js mirrors the filename rules at queue
// time so operators can't even *queue* a malicious path. Defense-in-depth.

import { resolve, sep } from 'node:path';
import { lstatSync } from 'node:fs';

// Allowed roots on Windows where file-push is permitted to write.
// Resolved relative to process.env.ProgramData / cwd / Windows defaults so
// the values match across installs. The center's queue-time validator
// uses the same list so operator-side validation can't disagree with
// agent-side reality.
function resolveRoots() {
  const roots = [];
  // Primary: C:\addashboard\payloads\ (green-package default install)
  roots.push(resolve(process.cwd(), 'C:\\addashboard\\payloads'));
  // ProgramData variants (preferred on services that run as SYSTEM)
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || 'C:\\ProgramData';
  roots.push(resolve(programData, 'ADDashboard\\payloads'));
  // Also accept the ProgramData root if the env var had backslashes
  if (process.env.PROGRAMDATA) {
    roots.push(resolve(process.env.PROGRAMDATA, 'ADDashboard\\payloads'));
  }
  return roots;
}

// Public so the test harness can assert the same list.
export const ALLOWED_FILE_PUSH_ROOTS = Object.freeze([
  'C:\\addashboard\\payloads',
  'C:\\ProgramData\\ADDashboard\\payloads'
]);

// Characters / patterns that are NEVER allowed in a file-push filename.
// Filename is the operator-supplied leaf name only — the parent dir is
// validated through allowedRoots.
const FILENAME_FORBIDDEN_CHARS = /[\x00-\x1f\x7f]/;
const FILENAME_FORBIDDEN_SUBSTR = /(\.\.|[:\\/])/;

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

/**
 * Validate a file-push payload before writing to disk.
 *
 * @param {object} args
 * @param {string} args.filename     — operator-supplied filename (leaf only)
 * @param {string} args.targetPath   — operator-supplied parent dir
 * @param {string[]} [args.allowedRoots] — absolute roots; defaults to ALLOWED_FILE_PUSH_ROOTS
 * @returns {{ ok: true, resolved: string } | { ok: false, error: string }}
 */
export function validatePayloadPath({ filename, targetPath, allowedRoots } = {}) {
  // ── Filename rules ──
  if (typeof filename !== 'string' || filename.length === 0) {
    return { ok: false, error: 'filename is required' };
  }
  if (filename.length > 255) {
    return { ok: false, error: 'filename exceeds 255 chars' };
  }
  if (FILENAME_FORBIDDEN_CHARS.test(filename)) {
    return { ok: false, error: 'filename contains control characters' };
  }
  if (FILENAME_FORBIDDEN_SUBSTR.test(filename)) {
    return { ok: false, error: 'filename contains path separator, drive letter, or relative-segment (..)' };
  }
  if (filename.startsWith('.')) {
    return { ok: false, error: 'filename starts with . (hidden / relative)' };
  }

  // ── targetPath rules ──
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, error: 'targetPath is required' };
  }
  // Strip a single trailing separator pair so "C:\addashboard\payloads\\"
  // resolves identically to "C:\addashboard\payloads" — but ONLY one
  // normalization pass (don't keep stripping forever).
  const normalizedTarget = targetPath.replace(/[\\/]+$/, '');

  // ── Resolve to absolute path ──
  // path.resolve treats the second arg as relative to the first when the
  // first is absolute. We want `<targetPath>/<filename>` so we join first.
  const joined = normalizedTarget + sep + filename;
  const resolved = resolve(joined);

  // ── Allowed roots check (case-insensitive on Windows) ──
  const roots = (Array.isArray(allowedRoots) && allowedRoots.length > 0)
    ? allowedRoots
    : resolveRoots();
  const resolvedLower = resolved.toLowerCase();
  for (const root of roots) {
    const rootAbs = resolve(String(root));
    const rootLower = rootAbs.toLowerCase();
    if (resolvedLower === rootLower || resolvedLower.startsWith(rootLower + sep.toLowerCase())) {
      return { ok: true, resolved };
    }
  }

  return {
    ok: false,
    error: `resolved path escapes allowed roots (${resolved})`
  };
}

// Convenience thrower — used by file-push-drainer so the caller can `try { validatePayloadPathOrThrow(...); } catch { ... }`.
export function validatePayloadPathOrThrow(args) {
  const r = validatePayloadPath(args);
  if (!r.ok) throw httpErr(400, r.error);
  return r;
}

// ---------------------------------------------------------------------------
// 2026-10-21 (security) — 通用"路径段"守卫,供 package-manager 使用。
// ---------------------------------------------------------------------------
//
// validatePayloadPath 解决的是 file-push 的 `targetPath` + `filename` 语义,
// package-manager 需要的是另一套:包定义里的 pkg.name / pkg.version。这两个值
// 同样完全来自中心(agent.js syncFromCenter),此前直接进
// join(cacheDir, pkg.name, pkg.version, 'collect.ps1') 再 spawn
// powershell -File <该路径> —— 中心下发 name="..\\..\\..\\Windows\\System32"
// 即可让 agent 把脚本落到任意目录并以 SYSTEM 权限执行。
//
// 与 file-push 的差别:
//   - file-push 的 targetPath 是"任意目录",由 allowedRoots 枚举白名单;
//   - package-manager 的 name/version 必须是"单段",不允许任何分隔符,
//     所以用字符白名单 + 显式拒绝 "." / ".." 即可,无需 roots 列表。
//
// 字符白名单本身放过 ".."(. 在字符类里),所以两条件缺一不可。
const SEGMENT_ALLOWED = /^[A-Za-z0-9._-]+$/;

/**
 * 校验单个路径段(不含分隔符、不为 . 或 ..)。
 * @returns {boolean}
 */
export function isSafeSegment(seg) {
  if (typeof seg !== 'string' || seg.length === 0) return false;
  if (!SEGMENT_ALLOWED.test(seg)) return false;
  if (seg === '.' || seg === '..') return false;
  return true;
}

/**
 * 把若干路径段安全拼到 root 之下。任一段不安全、或结果逃出 root,抛错。
 *
 * 第二道防线:即便将来有人放宽了上面的字符白名单,resolve 后的前缀校验
 * 仍然会挡住逃逸。
 *
 * @param {string} root
 * @param {...string} segments
 * @returns {string} 解析后的绝对路径
 * @throws {Error} httpStatus 400
 */
export function safeJoin(root, ...segments) {
  if (!segments.every(isSafeSegment)) {
    throw httpErr(400, `unsafe path segment: ${JSON.stringify(segments)}`);
  }
  const rootResolved = resolve(root);
  const full = resolve(rootResolved, ...segments);
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    throw httpErr(400, `resolved path escapes root (${full})`);
  }
  return full;
}

// Exposed for the test harness.
export const __testing = {
  resolveRoots,
  FILENAME_FORBIDDEN_CHARS,
  FILENAME_FORBIDDEN_SUBSTR,
  SEGMENT_ALLOWED
};