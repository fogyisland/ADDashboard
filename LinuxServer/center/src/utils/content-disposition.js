// R161.30 (2026-11-07) — S5 修复: Content-Disposition filename 安全拼装。
//
// ★ 背景 (安全审查 S5): 3 个下载端点 (file-push.js / agent.js / admin.js
//   审计导出) 都直接 `filename="${raw}"` 进响应头。任务名含双引号时
//   (`p.sh" ; evil="x`) 注入任意 disposition 参数; 含 CR/LF 时甚至拆分
//   HTTP 响应 (header 注入)。
//
// 规则 (RFC 6266 quoted-string):
//   · CR / LF / NUL / 其它 C0 控制字符 / DEL → 直接剥掉 (文件名不该有)
//   · `"` 与 `\` → 以 `\"` / `\\` 转义
//   · 空 / 非字符串 → 兜底 'file'
//
// 用法:
//   res.setHeader('Content-Disposition',
//     `attachment; filename="${contentDispositionFilename(t.filename)}"`);

/**
 * 把任意来源的文件名转成可安全放入 quoted-string 的形态。
 *
 * @param {unknown} filename 任意输入 (DB 字段, 可能缺省 / 脏值)
 * @returns {string} 安全文件名
 */
export function contentDispositionFilename(filename) {
  return String(filename ?? 'file')
    // 剥控制字符 (含 CR/LF/NUL/DEL) — header 注入与拆分的载体
    .replace(/[\r\n\0-\x1f\x7f]/g, '')
    // RFC 6266 quoted-string: `"` 与 `\` 转义
    .replace(/(["\\])/g, '\\$1')
    // 全剥空了 (名字全是控制字符) ⇒ 兜底
    || 'file';
}
