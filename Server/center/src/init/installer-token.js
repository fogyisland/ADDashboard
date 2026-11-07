// R161.30 — S1 (安全审查修复): init 向导窗口期认证令牌。
//
// ★ 背景: init 模式下 /api/init/db/test、/db/apply、/admin/create、/finalize
//   四个端点完全无认证 —— 任何能路由到中心端口的人都可以在内网抢先 finalize
//   (写入自己的管理员 + agentToken + jwtSecret 接管整个部署), 或借 /db/test
//   让服务器向任意 host:port 发起连接 (SSRF 探测)。
//
// 方案: installer token — 中心在进入 init 模式时生成一个随机令牌, 落在
// <installPath>/.installer-token (与服务同机、仅操作员可读), 向导前端要求
// 操作员把它粘贴进第 1 步; 四个写操作端点都校验 x-installer-token 请求头
// (常量时间比较)。/status 保持公开 (前端 initState gate 依赖它, 且只回
// { needsInit: bool } 一个布尔值, 无信息泄露)。
//
// 生命周期:
//   · ensureInstallerToken(installPath) — init 模式启动时调用; 文件已存在则
//     复用 (向导跨重启续跑时令牌不变), 否则生成 48 字节 hex 并写入。
//   · clearInstallerToken(installPath) — /finalize 成功后调用; 向导已被
//     marker 锁死, 令牌留着没有意义, 清掉 (纵深防御)。
//
// 权限说明: POSIX 上显式 chmod 0600; Windows 上 Node 无法设置 ACL, 文件落在
// 服务账号拥有的安装目录内, 依赖目录 ACL (与 appsettings.json 同一防线)。

import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const INSTALLER_TOKEN_HEADER = 'x-installer-token';
export const INSTALLER_TOKEN_FILE = '.installer-token';

function tokenFilePath(installPath) {
  if (typeof installPath !== 'string' || installPath.trim() === '') {
    throw new TypeError(`tokenFilePath: installPath must be a non-empty string, got ${typeof installPath}`);
  }
  return join(installPath, INSTALLER_TOKEN_FILE);
}

function isValidTokenShape(value) {
  // 48 字节 hex = 96 字符。旧文件内容损坏 (空 / 非十六进制 / 长度不对) 时不信任,
  // 重新生成, 避免把垃圾值当成有效防线。
  return typeof value === 'string' && /^[0-9a-f]{96}$/.test(value);
}

/** 读取现有令牌; 不存在或形状非法返回 null。 */
export function readInstallerToken(installPath) {
  const file = tokenFilePath(installPath);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch (e) {
    throw new Error(`installer token file unreadable at ${file}: ${e.message}`);
  }
  return isValidTokenShape(raw) ? raw : null;
}

/**
 * init 模式启动时调用: 复用已有令牌或生成新令牌并落盘。
 * 返回令牌明文 (只进内存 / 传给 router 校验, 绝不写日志)。
 */
export function ensureInstallerToken(installPath, logger) {
  const file = tokenFilePath(installPath);
  const existing = readInstallerToken(installPath);
  if (existing) {
    if (logger) logger.info({ file }, 'init installer token: reusing existing token file');
    return existing;
  }
  const token = randomBytes(48).toString('hex');
  writeFileSync(file, token + '\n', 'utf8');
  try {
    chmodSync(file, 0o600);
  } catch (e) {
    // Windows 上 chmod 是近 no-op; 失败不致命, 记 warn 即可。
    if (logger) logger.warn({ err: e.message, file }, 'installer token chmod failed (non-fatal)');
  }
  if (logger) {
    // 只落文件路径, 不落令牌值 —— 日志可能进 heartbeat 流/审计。
    logger.info({ file }, 'init installer token generated — operator: paste this file\'s content into the wizard step 1');
  }
  return token;
}

/** /finalize 成功后清理令牌文件; 缺失/已删不算错。 */
export function clearInstallerToken(installPath) {
  const file = tokenFilePath(installPath);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch (e) {
    throw new Error(`installer token file cleanup failed at ${file}: ${e.message}`);
  }
}
