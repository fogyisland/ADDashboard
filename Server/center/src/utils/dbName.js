// center/src/utils/dbName.js
// R161.6 (2026-10-26) — 数据库名白名单校验。
//
// ★ 为什么需要: 库名会被**拼进 DDL 文本** (不是参数化占位符):
//     CREATE DATABASE IF NOT EXISTS `<name>` CHARACTER SET utf8mb4 ...
//   MySQL 的库名不能用占位符传, 只能拼接 + 反引号转义 —— 但反引号转义
//   挡不住"名字里本身带反引号"的注入 (`` `a`; DROP DATABASE x; -- `` )。
//   ⇒ 入口处用白名单卡死, 只放行 MySQL 合法且安全的字符集。
//
// ★ 放行范围: 字母 / 数字 / 下划线 / $ (1..64 字符)。
//   MySQL 本身还允许更多字节, 但生产库名都是 ASCII, 放行更多只会扩大注入面。
//   这不是"功能限制" —— 任何真实的库名都落在这个集合里。

const DB_NAME_RE = /^[A-Za-z0-9_$]{1,64}$/;

/**
 * 校验并归一化一个数据库名。
 *
 * @param {unknown} dbName 原始库名
 * @returns {string} 校验通过的库名 (去掉了首尾空白)
 * @throws {Error} 库名为空或含不允许的字符
 */
export function assertValidDatabaseName(dbName) {
  const name = String(dbName ?? '').trim();
  if (!name) {
    throw new Error('数据库名不能为空');
  }
  if (!DB_NAME_RE.test(name)) {
    throw new Error(
      `非法数据库名 ${JSON.stringify(name)} —— 只允许字母/数字/下划线/$ (1..64 字符)`
    );
  }
  return name;
}
