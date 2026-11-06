// src/utils/data-dir.js — 内置包 payload 目录的**单一真源**。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// "内置包 payload 在磁盘上的哪个目录" 这一个问题，在树里被问了 4 次，
// 而 4 个答案**有两个是错的**:
//
//   · server.js:596 / server.js:642
//       getDataDir: () => join(repoRoot, 'data', 'packages')
//     repoRoot = <repo> ⇒ 指向 <repo>/data/packages —— **这个目录不存在**
//     (真正的目录是 <center>/data/packages)。注释还写着 "matches
//     seedBuiltinPackages dataDir convention" —— 而 seedBuiltinPackages
//     用的是 join(__dirname, 'data', 'packages')。**注释和代码互相矛盾**。
//
//   · src/db/index.js:116
//       getDataDir: opts.getDataDir ?? (opts.repoRoot ? () => join(opts.repoRoot, 'data', 'packages') : null)
//     同样的错误路径。
//
//   · src/init/schema-applier.js:662 / src/services/migrations.js:201
//       (getDataDir ? getDataDir() : null) || `${process.cwd()}/data/packages`
//     cwd 依赖启动方式（`cd center && node server.js` ⇒ cwd=center，对；
//     `node server.js` 从 repo 根跑 ⇒ cwd=repo，错）—— 同一个东西在两种
//     启动方式下解析到两个不同的目录。
//
// 这 4 个值唯一的用途是：给 **JS 数据迁移助手**（`migrateInstalledPackagesToTwoTable`）
// 定位内置包 payload。路径错了 ⇒ 助手读不到 payload ⇒ 数据迁移拿不到
// 脚本与策略 ⇒ `installed_packages` 表停在旧结构。
//
// ── 路径怎么算 ──────────────────────────────────────────────────────────────
// 本文件位于 <center>/src/utils/ ⇒ 上两级就是 <center>。
// 于是 `join(__dirname, '..', '..', 'data', 'packages')` = <center>/data/packages。
//
// ★ 用 __dirname 而不是 repoRoot：repoRoot 的深度取决于**谁在跑**（源树里是
//   <repo>，发布镜像里是 <repo>/publish/system），而 <center> 的相对位置
//   （本文件恒在 <center>/src/utils/）在两种布局下都一样 ⇒ 路径与布局无关。
//
// ★ 为什么还要一个 publish 候选：server.js 的 resolveBuiltinSourceDir()
//   除了 <center>/data/packages，还试 <repo>/publish/system/center/data/packages
//   （源树视图下 payload 可能只存在于 publish 镜像里）。这里保留同样的两个
//   候选，**顺序也一致**，避免两处解析出不同目录。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // <center>/src/utils
const centerRoot = join(here, '..', '..');             // <center>
const repoRoot = dirname(centerRoot);                  // <center> 的上一级

// 候选顺序与 server.js 的 builtinSourceCandidates 保持一致。
export const BUILTIN_PACKAGES_CANDIDATES = [
  join(repoRoot, 'publish', 'system', 'center', 'data', 'packages'),
  join(centerRoot, 'data', 'packages'),
];

/**
 * 找到内置包 payload 目录。
 * @returns {string|null} 存在的目录；一个都不存在时返回 null。
 */
export function findBuiltinPackagesDir() {
  return BUILTIN_PACKAGES_CANDIDATES.find((dir) => existsSync(dir)) ?? null;
}

/**
 * 内置包 payload 目录（尽力而为版）。
 * 一个候选都不存在时返回**最后一个**候选（而不是 null / 抛错）——
 * 调用方拿到的永远是一个字符串路径，"目录不存在"由它自己判空。
 * 需要硬失败的场景请用 findBuiltinPackagesDir() 或 server.js 的
 * resolveBuiltinSourceDir()。
 * @returns {string}
 */
export function getBuiltinPackagesDir() {
  return findBuiltinPackagesDir() ?? BUILTIN_PACKAGES_CANDIDATES[BUILTIN_PACKAGES_CANDIDATES.length - 1];
}
