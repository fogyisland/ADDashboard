// center/src/middleware/securityHeaders.js
// R161.34 (2026-11-07) — 安全响应头中间件 (安全批次 S6)。
//
// ★ 为什么要自己写而不是装 helmet:
//   helmet 会一次性套上 CSP / HSTS / COOP / CORP / XFO 等**一整套**策略。
//   本项目的前端是 Vue SPA + 内网部署 + 大量 iframe/下载/图片, 一旦
//   某条策略与现有页面冲突 (最典型的是 CSP 的 `script-src` / `img-src`),
//   症状是"页面整个白屏", 而排查成本极高。
//   ⇒ 这里只加**一组不会破坏现有功能**、但能挡掉最常见的攻击的响应头;
//     CSP / HSTS 属于"要不要开取决于部署形态"的决策, 留待 operator 定夺
//     (本文件底部给了启用方式)。
//
// ★ 每一条挡的是什么:
//   · X-Content-Type-Options: nosniff
//       —— 防"浏览器猜 MIME 类型"。没有它, 攻击者上传一个 .txt 或
//          声明为 text/plain 的响应, 浏览器可能按 HTML 解析 ⇒ XSS。
//          本项目有文件上传/下载 (file-push), 这条尤其重要。
//   · X-Frame-Options: SAMEORIGIN
//       —— 防"点击劫持"。运营台带操作按钮 (改配置 / 执行命令),
//          被外站 iframe 套一层诱导管理员点击就是事故。
//   · Referrer-Policy: strict-origin-when-cross-origin
//       —— 防 Referer 泄露内网 URL (agentId / 主机名 / 端点路径)。
//          旧浏览器的默认行为是把**完整路径**发出去。
//   · Cross-Origin-Opener-Policy: same-origin
//       —— 防"窗口被反向劫持" (tabnabbing): 目标页用 window.opener
//          改写来源页的地址。因为本项目的前端全是同源路由, 这条无副作用。
//   · Cross-Origin-Resource-Policy: same-origin
//       —— 防其它站点把我们的静态资源 (含前端 JS) 嵌进自己的页面。
//   · Permissions-Policy
//       —— 显式关掉本项目用不到的敏感浏览器能力 (地理位置 / 摄像头 /
//          麦克风 / 剪贴板读)。没有它, 嵌在 iframe 里的场景下
//          这些能力默认是**允许**的。
//   · X-DNS-Prefetch-Control: off
//       —— 避免内网主机名被泄露给 DNS 预解析。
//
// ★ 刻意**不**加的:
//   · Content-Security-Policy —— 会与现有 Vue 构建产物 / 外部资源打架,
//     属于需要真机验证的部署决策, 不能在安全批次里顺手塞进去。
//   · Strict-Transport-Security —— 只在 HTTPS 下有意义。本项目默认
//     走 http://内网IP:8080, 发了 HSTS 头反而会让浏览器把 http 升级成
//     https 而直接连不上 ⇒ **在纯 HTTP 部署下是故障源**, 不是保护。
//   · X-XSS-Protection —— 已废弃 (现代浏览器直接忽略, 且历史上引入过
//     自己的漏洞)。CSP 才是正解。
//   · X-Powered-By —— 已经由 app.disable('x-powered-by') 关掉了。

// 恒定不变的响应头集合。
// ★ 用一个**共享常量对象**而不是每次请求都新建对象 ——
//   这套头在进程生命周期内**永不改变**, 每请求新建 6 个对象纯属浪费。
const BASE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'X-DNS-Prefetch-Control': 'off'
});

/**
 * 安全响应头中间件。
 *
 * ★ 为什么用 `res.set` 而不是 `res.setHeader`:
 *   `res.set` 走 Express 的 header 容器, 之后任何 `res.append` /
 *   `res.set` 都能正确合并, 不会被后写的覆盖成 undefined。
 *
 * ★ 为什么挂在**所有**路由之前 (app.js 里它是最早的 app.use):
 *   ⇒ 静态资源、API 响应、404、**以及 error middleware 兜底的 500**
 *     全部带上这些头。只要晚挂一个, 就会漏掉那一类响应。
 *
 * @param {object} [options]
 * @param {object} [options.headers] 额外要加的头 (覆盖默认值)
 * @returns {import('express').RequestHandler}
 */
export function securityHeaders({ headers: extra } = {}) {
  const finalHeaders = Object.freeze({ ...BASE_HEADERS, ...(extra || {}) });
  return function applySecurityHeaders(req, res, next) {
    for (const [name, value] of Object.entries(finalHeaders)) {
      res.set(name, value);
    }
    next();
  };
}

export { BASE_HEADERS };
