// center/src/routes/email-outbox-common.js
// R161.11 (2026-10-26) — 邮件队列 / 邮件历史 两个端点共用的降级与留痕逻辑
//
// ★ 为什么单独抽一个文件:
//   email-queue.js (R158.100.B) 和 email-history.js (R158.69) 是 1:1 平行的
//   一对路由, 历史上各自复制粘贴了 catch 块。两边的 catch 都是
//     catch (err) { res.status(500).json({ error: '...', detail: err.message }); }
//   ⇒ 三个问题同时存在:
//     1. **不落 pino** —— 页面 500, 服务端日志里**一个字都没有**。NSSM 的
//        AppStderr='' 把 stderr 丢了, 连 console.error 也留不下痕迹。
//     2. **空数据与故障不可分** —— 操作员的原话:「数据如果是空感觉会出问题」。
//        队列表压根没建 (schema 漂移) 和"队列表建好了但一行都没有" 在页面上
//        长得一模一样 (都是拿不到数据), 前者却是 500。
//     3. **错误原因被前端丢掉** —— 响应体里的 detail (MySQL 的真实原因) 前端
//        根本没显示, 操作员只能在 DevTools 里翻。
//   ⇒ 抽出来, 两边共用, 改一处两边同时生效。
//
// ★ 降级策略 (本文件的核心契约):
//   - **表/列缺失** (schema 漂移) ⇒ HTTP 200 + { rows: [], count: 0,
//     degraded: true, reason, detail }。页面能开、能显示"空队列 + 缺表提示",
//     同时 pino 里留 error 级日志 ⇒ 既不静默, 也不挡路。
//   - **其它错误** (连接断/权限/SQL 写错) ⇒ 保持 500, 但响应体补 errorCode /
//     errorKind, 且**必定**落 pino error 日志。
//   - 判定依据 = utils/dbError.js 的 classifyDbError (MySQL + MSSQL 双方言)。

import {
  classifyDbError,
  isDegradableKind,
  DEGRADE_REASON_TEXT
} from '../utils/dbError.js';

// 诊断端点 (admin:config) —— 操作员拿到"到底缺什么表"的唯一入口。
export const OUTBOX_DIAGNOSTICS_URL = '/api/admin/system-settings-v2/email-outbox-diagnostics';

/**
 * 统一的错误留痕。
 * logger 是 pino (server.js 传入); 没有 logger 时退回 console.error ——
 * NSSM 会丢 stderr, 但那总比什么都不留强, 且**不会**静默吞掉。
 */
export function logRouteError(logger, scope, err, info, extra = {}) {
  const payload = {
    scope,
    err: err?.message ?? String(err),
    kind: info?.kind ?? null,
    code: info?.code ?? null,
    errno: info?.errno ?? null,
    number: info?.number ?? null,
    missingTable: info?.missingTable ?? null,
    missingColumn: info?.missingColumn ?? null,
    ...extra
  };
  if (logger && typeof logger.error === 'function') {
    logger.error(payload, `${scope} 失败`);
    return;
  }
  console.error(`[${scope}] ${payload.err} (kind=${payload.kind})`);
}

/**
 * 构造"降级"响应体 —— 空列表 + 显式 degraded 标记。
 * @param {object} info classifyDbError 的结果
 * @param {object} extra 该端点自己的附加字段 (limit / days / kind ...)
 */
export function buildDegradedPayload(info, extra = {}) {
  return {
    rows: [],
    count: 0,
    ...extra,
    degraded: true,
    reason: info?.kind ?? 'other',
    reasonText: DEGRADE_REASON_TEXT[info?.kind] ?? '邮件数据暂不可用',
    detail: info?.message ?? '',
    missingTable: info?.missingTable ?? null,
    missingColumn: info?.missingColumn ?? null,
    diagnosticsUrl: OUTBOX_DIAGNOSTICS_URL
  };
}

/**
 * 处理一次列表查询的失败。
 *
 * @param {object} opts
 *   - logger    pino logger
 *   - scope     日志作用域名 ('email-queue' / 'email-history')
 *   - err       捕获到的错误
 *   - extra     降级响应里该端点自己的字段
 *   - res       express response
 * @returns {boolean} true = 已降级 (200), false = 需要调用方回 500
 */
export function handleListFailure({ logger, scope, err, extra = {}, res }) {
  const info = classifyDbError(err);
  logRouteError(logger, scope, err, info, extra);
  if (isDegradableKind(info.kind)) {
    res.json(buildDegradedPayload(info, extra));
    return true;
  }
  res.status(500).json({
    error: `${scope} query failed`,
    errorCode: info.code ?? null,
    errorKind: info.kind,
    detail: info.message,
    diagnosticsUrl: OUTBOX_DIAGNOSTICS_URL
  });
  return false;
}
