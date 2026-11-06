import { writeFileSync, renameSync, unlinkSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { loadConfig, validateConfigObject } from '../config.js';

// R161.25 (2026-10-29 部署审计) — appsettings.json 里是 **DB 口令 + jwtSecret
// + agentToken**，是整个部署里**权限要求最高**的一个文件。
//
// 旧实现用 writeFileSync(tmp, ..., 'utf8') 写临时文件 ⇒ 文件按 umask 落地
// (POSIX 上典型是 0644 = **同机任何用户可读**) ⇒ 目标机上一条
// `cat appsettings.json` 就把 DB 口令和 agentToken 交出去了。
//
// 修法要点:
//   ① 权限在**写的时候**就定死 (mode: 0o600), 而不是写完再 chmod ——
//      "先 0644 落地、再 chmod 0600" 中间有一个**任何人都能读**的窗口;
//   ② rename 保留 inode 的权限 ⇒ 最终文件就是 0600;
//   ③ writeFileSync 的 mode **只在新建文件时生效** —— 临时文件可能是上一轮
//      留下的 (0644) ⇒ 落盘后再显式 chmod 一次, 保证结果与"新建"一致;
//   ④ Windows 上 chmod 只映射到"只读属性", **不是** ACL ⇒ 这条修复的实际
//      收益在 Linux 交付包上。Windows 的等价防护是 NTFS ACL (安装脚本
//      收紧目录权限), 不在本文件的职责范围内 —— 这里只保证"不比现状更差"。
const SECURE_FILE_MODE = 0o600; // -rw-------

function writeFileSecure(path, content) {
  writeFileSync(path, content, { encoding: 'utf8', mode: SECURE_FILE_MODE });
  try {
    chmodSync(path, SECURE_FILE_MODE);
  } catch (err) {
    // 权限收紧失败**不阻断**写配置: 配置已经落盘, 继续往下走让调用方拿到
    // 明确结果 (而不是"因为 chmod 失败所以配置没写" —— 那更糟)。
    // 失败时把原因带到 stderr, 便于操作员事后审计。
    process.stderr.write(
      `[config-writer] WARNING: could not tighten permissions (0600) on ${path}: ${err?.message || err}\n`
    );
  }
}

export function writeConfig({ path, dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir }) {
  const cfg = {
    db: {
      dialect,
      [dialect]: connParams
    },
    listenPort,
    jwtSecret,
    agentToken,
    staticDir,
    logLevel: logLevel || 'info',
    env: env || 'prod'
  };
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSecure(tmpPath, JSON.stringify(cfg, null, 2));
  renameSync(tmpPath, path);
  // Post-write validation: ensure written file is parseable and meets loadConfig's required-key contract.
  // If validation fails, delete the file and rethrow so the caller sees a clear error and no half-baked config remains.
  try {
    loadConfig(path);
  } catch (err) {
    try { unlinkSync(path); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }
  return cfg;
}

// R158.License-config (2026-10-15) — patchConfigAtomic: read-modify-write appsettings.json
// atomically (write tmp + rename, same idiom as writeConfig). Used by
// ensureSignatureAndInstalledAt at boot to lazy-add `signature` + `installedAt`
// without overwriting operator-edited values.
//
// Returns { changed: bool, cfg: object } so the boot caller can log what landed.
// If the file is missing or invalid, throws — caller decides whether to swallow
// (boot-time failure is non-fatal, see server.js ensureSignatureAndInstalledAt).
//
// Post-write validation runs loadConfig to confirm the patched file still
// satisfies the required-key contract (dialect + listenPort + jwtSecret +
// agentToken + staticDir). If validation fails, the file is unlinked so the
// next boot re-enters the init wizard rather than serving half-baked config.
export function patchConfigAtomic({ path, patch }) {
  if (!existsSync(path)) {
    throw new Error(`patchConfigAtomic: file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);
  const next = { ...cfg, ...patch };
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSecure(tmpPath, JSON.stringify(next, null, 2));
  renameSync(tmpPath, path);
  try {
    loadConfig(path);
  } catch (err) {
    try { unlinkSync(path); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }
  // changed = true iff at least one patched key differs from the original
  const changed = Object.keys(patch).some(k => cfg[k] !== next[k]);
  return { changed, cfg: next };
}

// R161.25 (2026-10-29 部署审计) — 安全地改 appsettings.json 里的端口。
//
// ★ 为什么不能直接用 patchConfigAtomic 改端口:
//   patchConfigAtomic 写完会 loadConfig 复验, **校验不过就 unlink 掉这个文件**
//   (设计意图: 启动期补字段写坏了就退回初始化向导重来)。但端口这条路径是
//   **运行期**的 —— 一次手滑的值就会把**装着 DB 口令 + jwtSecret + agentToken
//   的生产凭据文件删掉**, 服务随即掉进"配置没了"的状态 (marker 已锁 ⇒
//   直接 exit 2, 中心起不来)。
//
// ★ 本函数的契约:
//   ① 落盘**前**用 validateConfigObject 校验"合并后的对象" —— 不合格直接
//      throw, **磁盘上什么都不动** (没有临时文件, 没有 unlink);
//   ② 落盘用 0600 (含凭据的文件不能是 0644);
//   ③ 只改 listenPort 一个键, 其余字段 (凭据) 一个字节都不动;
//   ④ 临时文件用完即删, 失败也不留残留。
export function patchListenPortAtomic({ path, listenPort }) {
  if (!existsSync(path)) {
    throw new Error(`patchListenPortAtomic: file not found: ${path}`);
  }
  const port = Number(listenPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`patchListenPortAtomic: listenPort must be an integer in 1024..65535; got ${JSON.stringify(listenPort)}`);
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const next = { ...cfg, listenPort: port };
  // 校验合并后的对象 (而不是文件) —— 校验不过就 throw, 不落盘。
  validateConfigObject(next);

  const tmpPath = join(dirname(path), `.${basename(path)}.tmp`);
  try {
    writeFileSecure(tmpPath, JSON.stringify(next, null, 2));
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }
  return { changed: cfg.listenPort !== port, cfg: next };
}