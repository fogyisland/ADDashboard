// center/src/services/license-validator.js
// R158.87 (2026-10-12) — License v1 验真 service.
//   3 export:
//     - validateLicenseFormat(rawKey)  格式 + 长度 + 前缀 校验
//     - sha256LicenseKey(key)          hex hash, 64 char
//     - computeInstanceId()            boot-time 生成 + 写文件, 永久绑定本机
//   1 hook (R158.87.x 留):
//     - validateLicenseRemote(licenseHash)  外部 license server 验真 (v1 = bypass)
//
// R158.License-config (2026-10-15) — 加 4 export 配合"生产 license 申请单" ship:
//     - readSignature(configPath)             从 appsettings.json 读 signature 字段
//     - readInstalledAt(configPath)           从 appsettings.json 读 installedAt 字段
//     - readInstanceId()                      包既有 computeInstanceId
//     - buildLicenseRequest({...})            拼 JSON 申请单 (5 字段 + signature + instance_id)
// 0 改既有 3+1 export.

import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { patchConfigAtomic } from '../init/config-writer.js';

const INSTANCE_ID_FILE = 'data/instance_id';

export function validateLicenseFormat(rawKey) {
  if (typeof rawKey !== 'string') {
    return { ok: false, error: 'license_key must be a string' };
  }
  const trimmed = rawKey.trim();
  if (trimmed.length < 16 || trimmed.length > 128) {
    return { ok: false, error: 'license_key length out of range [16,128]' };
  }
  if (!trimmed.startsWith('ADSPK-')) {
    return { ok: false, error: 'license_key must start with ADSPK-' };
  }
  const tail = trimmed.slice(6);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(tail)) {
    return { ok: false, error: 'license_key must match XXXX-XXXX-XXXX-XXXX after ADSPK- prefix' };
  }
  return { ok: true, normalizedKey: trimmed };
}

export function sha256LicenseKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function computeInstanceId() {
  // boot-time 生成 + 写文件, 永久绑定本机
  const filePath = INSTANCE_ID_FILE;
  if (existsSync(filePath)) {
    return readFileSync(filePath, 'utf8').trim();
  }
  const id = randomUUID();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, id, 'utf8');
  return id;
}

// R158.87.x 留 hook: 接外部 license server 时只换 body.
// v1 = bypass (任何 hash 都 valid, 永不过期, 无 notes). 这样 R158.87 ship
// 时 operator 拿 ADSPK-AAAA-BBBB-CCCC-DDDD 测试 license 就能演示完整 UI
// 流程, 不依赖外部服务.
export async function validateLicenseRemote(_licenseHash) {
  return { valid: true, expiresAt: null, notes: null };
}

// ============================================================================
// R158.License-config (2026-10-15) — 4 新 export 配合 "生产 license 申请单" ship.
// 0 改上面 R158.87 既有 3+1 export.
// ============================================================================

// readSignature — 从 appsettings.json 读 `signature` 字段. 失败 (缺/坏/非 32 hex) 返 null.
//   跟 operator 看 licenseKey 一样: signature = 本机身份指纹, 用于后续 license server
//   验证本机 (R158.License-activation 下轮 ship 接 license_key 校验时用).
//   0 抛错: caller 决定怎么 fallback (前端展示占位 "未生成").
export function readSignature(configPath) {
  try {
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const sig = cfg?.signature;
    if (typeof sig === 'string' && /^[0-9a-f]{32}$/i.test(sig)) return sig;
    return null;
  } catch {
    return null;
  }
}

// readInstalledAt — 从 appsettings.json 读 `installedAt` 字段. 失败 (缺/坏) 返 null.
//   R158.License-config.install (2026-10-15) — 操作员 directive: 格式 YYYY-MM-DD
//   (年-月-日, 不要搞太复杂). 0 接受 ISO 8601 / 任何 toISOString 输出. 中心第一次
//   正常启动时写一次, 之后 immutable (R158.License-config lesson #3: boot lazy 写盘
//   必 idempotent, 不覆盖 operator 编辑值).
export function readInstalledAt(configPath) {
  try {
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const ts = cfg?.installedAt;
    if (typeof ts !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ts)) return null;
    return ts;
  } catch {
    return null;
  }
}

// readInstanceId — 包既有 computeInstanceId, 给 license 申请单用.
//   0 改原函数 (R158.86.6 复用维度); 名字区分: read = 立即读, compute = boot 触发.
export function readInstanceId() {
  return computeInstanceId();
}

// buildLicenseRequest — 拼 JSON 申请单, 5 字段 (company / mac / months / maxNodes / installedAt)
//   + signature (来自 appsettings) + instance_id (本机 UUID). 操作员复制发邮件给
//   fogyisland_x@hotmail.com, 后续 R158.License-activation ship 拿这串换 license_key.
//
//   参数校验:
//     company:  必填, 1-100 字符, trim 后非空
//     mac:      必填, 1-64 字符 (MAC 格式 17 字符 + 留 buffer)
//     months:   必填, 1-120 整数
//     maxNodes: 必填, 1-10000 整数
//     installedAt / signature / instanceId: 由 caller 传, 不校验
//
//   返 { ok, request } 或 { ok: false, error }.
export function buildLicenseRequest({ company, mac, months, maxNodes, installedAt, signature, instanceId }) {
  // company
  if (typeof company !== 'string') return { ok: false, error: 'company_must_be_string' };
  const companyTrim = company.trim();
  if (companyTrim.length < 1 || companyTrim.length > 100) {
    return { ok: false, error: 'company_length_out_of_range:1-100' };
  }
  // mac
  if (typeof mac !== 'string') return { ok: false, error: 'mac_must_be_string' };
  const macTrim = mac.trim();
  if (macTrim.length < 1 || macTrim.length > 64) {
    return { ok: false, error: 'mac_length_out_of_range:1-64' };
  }
  // months
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    return { ok: false, error: 'months_out_of_range:1-120' };
  }
  // maxNodes
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 10000) {
    return { ok: false, error: 'max_nodes_out_of_range:1-10000' };
  }
  return {
    ok: true,
    request: {
      company: companyTrim,
      mac_address: macTrim,
      months,
      max_nodes: maxNodes,
      installed_at: installedAt || null,
      signature: signature || null,
      instance_id: instanceId || null
    }
  };
}

// ensureSignatureAndInstalledAt — boot-time lazy 写盘.
//   若 cfg.signature 缺 / 不是 32 hex → 生成 randomBytes(16).toString('hex') 写回
//   若 cfg.installedAt 缺 / 不是有效 ISO → 写 new Date().toISOString()
//   走 patchConfigAtomic (init/config-writer.js tmp+rename), 失败不致命 (warn log).
//   在 server.js !needsInit 分支调, init-mode 不写 (wizard 期间不污染 config).
export function ensureSignatureAndInstalledAt(configPath, logger) {
  try {
    if (!existsSync(configPath)) {
      logger?.warn?.({ configPath }, 'ensureSignatureAndInstalledAt: file missing; skipped');
      return { changed: false, reason: 'file_missing' };
    }
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const patch = {};
    const sigValid = typeof cfg.signature === 'string' && /^[0-9a-f]{32}$/i.test(cfg.signature);
    if (!sigValid) {
      patch.signature = randomBytes(16).toString('hex');
    }
    const installedAtValid = typeof cfg.installedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cfg.installedAt);
    if (!installedAtValid) {
      // R158.License-config.install (2026-10-15) — 操作员 directive: 安装时间格式 YYYY-MM-DD
      // 即可 ("年-月-日, 不要搞太复杂"). 0 用 ISO 8601 with time (Date().toISOString()),
      // 0 用 toLocaleDateString (locale-dependent 风险). 中心时区 (server time) 决定日期.
      const d = new Date();
      patch.installedAt = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (Object.keys(patch).length === 0) {
      return { changed: false, reason: 'already_present' };
    }
    const result = patchConfigAtomic({ path: configPath, patch });
    logger?.info?.({ changed: result.changed, keys: Object.keys(patch) }, 'ensureSignatureAndInstalledAt: patched');
    return { changed: true, keys: Object.keys(patch), cfg: result.cfg };
  } catch (err) {
    logger?.warn?.({ err: err.message, configPath }, 'ensureSignatureAndInstalledAt failed; non-fatal');
    return { changed: false, reason: 'error', error: err.message };
  }
}
