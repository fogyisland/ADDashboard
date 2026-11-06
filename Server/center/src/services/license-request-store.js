// R158.LA (2026-10-15) — license_request JSON 落盘 + 读盘 service.
// 每次 operator 在卡片 3 生成 license 申请单, export-request 端点调用本
// service 把 request JSON 落盘到 <installPath>/data/license-requests/<id>.json.
// 落盘跟 patchConfigAtomic (init/config-writer.js) 同 idiom: tmp+rename 原子写,
// 失败不污染现盘.
//
// 后续 verify / activate 端点 (system-settings-v2.js) 调 loadLicenseRequest
// 拿 (data, jsonPath) 喂给 license-codec.js verifyLicenseCode — HMAC 路径
// 绑定靠 jsonPath 1:1 一致, 所以 path 必保留绝对路径形态, 不能做 normalize.

import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// ── request id 生成: ts + 8 hex (跟 D:\verify\license-request-*.json 文件名 1:1 平行) ──
function _genRequestId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rnd = randomBytes(4).toString('hex');
  return `${ts}-${rnd}`;
}

// _licenseRequestsDir — 暴露给端点用, 单测可 mock installPath.
//   永远走绝对路径 + mkdir recursive, 跟 <installPath>/data 1:1 平行.
function _licenseRequestsDir(installPath) {
  const dir = resolve(installPath, 'data', 'license-requests');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// saveLicenseRequest — 落盘 request JSON + 返 (requestId, jsonPath, data).
//   jsonPath = <installPath>/data/license-requests/<requestId>.json 绝对路径.
//   写盘走 tmp+rename 范式 (跟 init/config-writer.js:patchConfigAtomic 1:1 平行).
//   失败抛 err, caller 决定怎么处理 (export-request 端点 500, 0 写 audit / 邮件).
export function saveLicenseRequest({ installPath, data }) {
  if (!installPath || typeof installPath !== 'string') {
    throw new Error('saveLicenseRequest: installPath required');
  }
  if (!data || typeof data !== 'object') {
    throw new Error('saveLicenseRequest: data required');
  }
  const requestId = _genRequestId();
  const dir = _licenseRequestsDir(installPath);
  const jsonPath = join(dir, `${requestId}.json`);
  const tmpPath = join(dir, `.${requestId}.json.tmp`);

  // 1:1 落盘 — 跟 buildLicenseRequest 的 wire shape 1:1 平行, 0 改字段.
  // 包含 company 字段 (license-codec.js 内部 delete data.company, 不依赖本文件 strip).
  const content = JSON.stringify(data, null, 2);
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, jsonPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch (_) { /* best-effort cleanup */ }
    throw new Error(`saveLicenseRequest: write failed at ${jsonPath}: ${err.message}`);
  }
  return { requestId, jsonPath, data };
}

// loadLicenseRequest — 读盘拿 (data, jsonPath) 给 verify / activate 端点用.
//   requestId 找不到对应文件 → 抛 ENOENT, caller 转 400 invalid_request_id.
//   返回 data = 已 strip company (跟 .NET 端 1:1 平行, license-codec.js 期望
//   没 company 字段). jsonPath 返绝对路径, verifyLicenseCode 直接用.
export function loadLicenseRequest({ installPath, requestId }) {
  if (!installPath || typeof installPath !== 'string') {
    throw new Error('loadLicenseRequest: installPath required');
  }
  if (!requestId || typeof requestId !== 'string') {
    throw new Error('loadLicenseRequest: requestId required');
  }
  const dir = _licenseRequestsDir(installPath);
  const jsonPath = join(dir, `${requestId}.json`);
  if (!existsSync(jsonPath)) {
    const err = new Error(`loadLicenseRequest: file not found: ${jsonPath}`);
    err.code = 'ENOENT';
    throw err;
  }
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  // strip company — 跟 D:\verify\server\verify.js delete data.company 1:1 平行.
  const { company, ...data } = raw;
  return { data, jsonPath: resolve(jsonPath) };
}
