// R156 — partner-discover service module. Companion to
// src/services/partner-port-probe.js (R155.3/R155.4). Where
// partner-port-probe ingests TCP-port probe rows from agents and
// pushes "missing peer_dc" skips into the agent-visible errors
// channel (R132 fix), partner-discover ingests DC topology rows and
// silently skips any peer whose name isn't in ad_dcs.
//
// Operator directive 2026-09-30:
//   "当前的 agentid 必须存在 partner 也必须在 ad_dcs 存在"
//
// Behaviour matrix:
//   agent_id ∉ ad_dcs          → log.warn + { upserted: 0,
//                                  skipped_not_in_ad_dcs: peerCount,
//                                  dropped_agent_not_in_ad_dcs: 1,
//                                  errors: [] }
//   peerDc ∈ ad_dcs            → UPSERT into ad_partner_inbound /
//                                ad_partner_outbound
//   peerDc ∉ ad_dcs            → log.debug + skipped++ (no errors.push,
//                                silent skip per operator directive)
//
// Errors array is ALWAYS empty (operator directive: "丢信息只 log debug").
// This is a deliberate divergence from partner-port-probe's
// errors.push-on-skip path — discover skips reflect topology truth
// (DC was just retired) rather than a malformed agent payload.
//
// Module-level 5-min TTL cache for ad_dcs Set mirrors R155.6
// dc-partners-refresh.js cadence. Cache is invalidated by
// invalidateDcSetCache() (exported) so the cron-scheduler can force
// a refresh after each 30-day discover trigger cycle.

import { getDb } from '../db/index.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedDcSet = null;
let cachedAt = 0;

/**
 * Fetch ad_dcs.dc_name set, cached for 5 min. Throws on DB error.
 * R158.15 — export so other post-hook services (e.g.
 * replication-status-probe) can share the same 5-min cached Set
 * instead of re-querying ad_dcs.
 */
export async function getKnownDcSet(db) {
  if (cachedDcSet && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedDcSet;
  }
  const { rows } = await db.execute(db.sql.replication.knownDcNames, []);
  cachedDcSet = new Set(rows.map((r) => r.dc_name || r.DC_NAME));
  cachedAt = Date.now();
  return cachedDcSet;
}

/**
 * Force the next call to re-query ad_dcs. cron-scheduler calls this
 * after writing a new trigger so the next cycle picks up any newly
 * onboarded DC.
 */
export function invalidateDcSetCache() {
  cachedDcSet = null;
  cachedAt = 0;
}

/**
 * Bulk upsert for partner-discover packages. Returns a summary;
 * runner.js reads summary.errors (always empty) to decide whether
 * to flag agent-visible errors.
 *
 * @param {object} db centre db handle
 * @param {string} packageName 'ad_partner_inbound_discover' | 'ad_partner_outbound_discover'
 * @param {string} agentId X-Agent-Id header value
 * @param {Array<{destDc?: string, peerDc?: string, peer_dc?: string,
 *               collectedAt?: string|Date}>} peers wire shape
 * @param {object} [log] pino-style logger
 */
export async function upsertDiscovers(db, packageName, agentId, peers, log = null) {
  const summary = {
    upserted: 0,
    deleted: 0,
    skipped_not_in_ad_dcs: 0,
    dropped_agent_not_in_ad_dcs: 0,
    errors: []
  };

  // R157.4 (2026-09-30 30) — operator directive reconciliation:
  //   "复制伙伴增加则写入,复制伙伴少了则删除"
  // We do NOT early-return on empty peers anymore. Pre-R157.4 the
  // empty-payload path was a silent no-op (table count=0 forever).
  // Post-R157.4 an empty peers list means "this agent has zero
  // partners in this direction right now" — we DELETE all rows for
  // this agent+direction. This matches the user's mental model:
  // partner missing from agent's view → row should disappear.
  // peers is normalised to an array (we accept undefined as empty).
  const peersList = Array.isArray(peers) ? peers : [];

  // R157.8 — resolve SQL keys BEFORE getKnownDcSet so a missing SQL
  // key surfaces immediately (was code review C5: missing-SQL guard
  // ran AFTER getKnownDcSet, wasting a DB round-trip and skipping
  // Phase 2 reconciliation DELETE entirely — stale rows accumulated).
  const [sqlDomain, sqlQuery] = packageName === 'ad_partner_inbound_discover'
    ? ['replication', 'upsertPartnerInbound']
    : ['replication', 'upsertPartnerOutbound'];
  const upsertSql = db.sql?.[sqlDomain]?.[sqlQuery];
  if (typeof upsertSql !== 'string') {
    log?.error?.({
      event: 'partner_discover.sql_missing',
      packageName,
      sqlDomain,
      sqlQuery,
      hasReplication: Boolean(db.sql?.replication),
      availableReplicationKeys: db.sql?.replication ? Object.keys(db.sql.replication) : null
    }, 'partner-discover upsert SQL key not found in db.sql registry');
    summary.errors.push({ phase: 'sql_resolve', error: `missing SQL: ${sqlDomain}.${sqlQuery}` });
    return summary;
  }

  const known = await getKnownDcSet(db || getDb());

  // (a) agent_id not in ad_dcs → drop entire batch (operator directive).
  if (!known.has(agentId)) {
    log?.warn?.({
      event: 'partner_discover.dropped',
      packageName,
      agentId,
      peerCount: peersList.length
    }, 'agent_id not in ad_dcs — dropping entire batch');
    summary.dropped_agent_not_in_ad_dcs = 1;
    summary.skipped_not_in_ad_dcs = peersList.length;
    return summary;
  }

  // Phase 1 — UPSERT each peer present in the current envelope
  // (concurrent per R157.1 Promise.allSettled). Each peer is also
  // validated against ad_dcs (silent skip if not in known DC set —
  // operator directive 2026-09-30: "sourcedc 或 destdc 必须在 ad_dc
  // 名中存在"). We collect the surviving peerDc values into a
  // `currentSourceDcList` / `currentDestDcList` set for Phase 2.
  const currentSourceDcList = []; // for inbound: peerDc values; for outbound: [agentId] only
  const currentDestDcList = [];   // for inbound: [agentId] only; for outbound: peerDc values

  // R157.8 — chunked concurrency (was code review M2 finding): 50 peers
  // × Promise.allSettled fans out 50 concurrent UPSERTs hitting the pool
  // (pool.max=25), serializing the rest behind the FIFO queue and
  // starving inbound / heartbeat / partner-port paths. CHUNK=10 keeps
  // peak in-flight at 10, well under pool capacity.
  const CHUNK = 10;
  const tasks = peersList.map((peer, i) => async () => {
    const peerDc = peer.destDc || peer.peerDc || peer.peer_dc || null;
    if (!peerDc) {
      log?.debug?.({
        event: 'partner_discover.skip',
        packageName,
        agentId,
        index: i,
        reason: 'missing peerDc field'
      }, 'peerDc missing in wire shape — silent skip');
      summary.skipped_not_in_ad_dcs++;
      return null;
    }
    if (!known.has(peerDc)) {
      log?.debug?.({
        event: 'partner_discover.skip',
        packageName,
        agentId,
        peerDc,
        reason: 'not_in_ad_dcs'
      }, 'peerDc not in ad_dcs — silent skip');
      summary.skipped_not_in_ad_dcs++;
      return null;
    }
    // R157.8 — self-loop guard (code review C2): if agent reports itself
    // as a peer, the UPSERT writes (agent_id, source_dc, dest_dc) where
    // source_dc == dest_dc. Phase 2 reconciliation DELETE would normally
    // re-delete this row every cycle (churn). Skip the UPSERT AND ensure
    // we don't leak the row — explicitly delete the self-loop row so
    // ad_partner_inbound/outbound never carries agent==peer relationships.
    if (peerDc === agentId) {
      log?.debug?.({
        event: 'partner_discover.skip',
        packageName,
        agentId,
        peerDc,
        reason: 'self_loop'
      }, 'self-loop peerDc === agentId — silent skip + cleanup');
      summary.skipped_not_in_ad_dcs++;
      try {
        // R158.10 — 硬编码 direction='inbound' (outbound 已下线)
        const cleanupResult = await deleteStalePartners(
          db, 'inbound', agentId, /* excludeList = */ [agentId], log
        );
        summary.deleted += cleanupResult.deleted;
      } catch (e) {
        log?.warn?.({
          event: 'partner_discover.self_loop_cleanup_failed',
          packageName, agentId, err: e?.message || String(e)
        }, 'self-loop cleanup DELETE failed');
      }
      return null;
    }
    const collectedAt = peer.collectedAt
      ? (peer.collectedAt instanceof Date ? peer.collectedAt : new Date(peer.collectedAt))
      : new Date();
    // Direction binding (R155.5 swap pattern):
    //   inbound  → source_dc = upstream peer, dest_dc = self
    // R158.10 (2026-10-01) — outbound 分支删除 (operator decision:
    //   不需要 outbound partner)。packageName 只剩
    //   ad_partner_inbound_discover, 所以方向硬编码 inbound。
    const sourceDc = peerDc;
    const destDc = agentId;
    currentSourceDcList.push(peerDc);
    const params = [collectedAt, agentId, sourceDc, destDc, collectedAt];
    return db.execute(upsertSql, params)
      .then(() => {
        summary.upserted++;
        return null;
      })
      .catch((e) => {
        log?.error?.({
          event: 'partner_discover.upsert_failed',
          packageName,
          agentId,
          peerDc,
          sqlDomain: sqlDomain,
          sqlQuery: sqlQuery,
          paramsTypes: params.map((p, pi) => `[${pi}]${typeof p}${p instanceof Date ? ':Date' : ''}`),
          err: e?.message || String(e),
          stack: e?.stack?.split('\n').slice(0, 4).join('\n')
        }, 'partner-discover upsert failed (DB error, not a skip)');
        summary.errors.push({ index: i, peerDc, error: e?.message || String(e) });
        return null;
      });
  });
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const slice = tasks.slice(i, i + CHUNK);
    await Promise.allSettled(slice.map(fn => fn()));
  }

  // Phase 2 — RECONCILIATION DELETE (R157.4). Rows for this agent+direction
  // whose source_dc / dest_dc is NOT in the current envelope get
  // deleted. This is the user's "复制伙伴少了则删除" semantic.
  // For inbound: anchor on dest_dc = agentId, exclude source_dc list.
  // R158.10 (2026-10-01) — outbound 删除, 只剩 inbound:
  //   deleteStalePartners 永远传 'inbound' + currentSourceDcList.
  // Empty currentList (e.g. peersList was empty) → DELETE all rows
  // for this agent (the agent has zero inbound partners right now).
  try {
    const result = await deleteStalePartners(db, 'inbound', agentId, currentSourceDcList, log, agentId);
    summary.deleted += result.deleted;
    if (result.errors.length) summary.errors.push(...result.errors);
  } catch (e) {
    log?.error?.({
      event: 'partner_discover.delete_failed',
      packageName,
      agentId,
      err: e?.message || String(e)
    }, 'partner-discover reconciliation DELETE failed');
    summary.errors.push({ phase: 'reconcile_delete', error: e?.message || String(e) });
  }

  return summary;
}

/**
 * R157.4 — reconciliation DELETE. Remove rows for (this agent,
 * this direction) whose partner column is no longer in the agent's
 * current peer list.
 *
 * SQL is generated dynamically with exactly `1 + excludeList.length`
 * `?` placeholders to avoid the NULL-padding trap of a fixed-shape
 * `IN (?, ?, NULL, NULL)` query (a VARCHAR NOT NULL column treated
 * with NULL in the IN list behaves unpredictably across drivers).
 * The driver wrapper's `?` → `@pN` rewriting handles the MSSQL side
 * transparently.
 *
 * R157.8 — defence-in-depth: assert direction + filter on agent_id
 * (code review C3 / M15). Without the agent_id filter, the DELETE
 * would remove any row whose partnerCol matches anchorCol regardless
 * of which agent reported it — a multi-agent mutual-replication fleet
 * (A↔B) would lose rows when A's empty-peers reconciliation fires.
 * unique key is (source_dc, dest_dc), not (agent_id, ...), so the
 * filter is required.
 *
 * @param {object} db centre db handle
 * @param {'inbound'|'outbound'} direction — controls which table / column
 * @param {string} anchorCol agentId to anchor the DELETE on (dest_dc for
 *   inbound, source_dc for outbound)
 * @param {string[]} excludeList peer DC names to KEEP (rows with these
 *   values in the partner column are not deleted)
 * @param {object} [log] pino-style logger
 * @param {string} [agentIdFilter] reporting agent's id — gates DELETE on
 *   agent_id column to prevent cross-agent row deletion (R157.8).
 * @returns {Promise<{deleted:number, errors:Array}>}
 */
async function deleteStalePartners(db, direction, anchorCol, excludeList, log = null, agentIdFilter = null) {
  // R157.8 — defensive assert on direction (code review M15 foot-gun).
  // Today the only callers pass 'inbound' / 'outbound' literals, but the
  // function is module-private — assert cheap, prevent future regression
  // from silently writing `DELETE FROM <whatever>` if a caller passes a
  // typo.
  // R158.10 (2026-10-01) — outbound 已下线, 但为防御性保留 assert
  // (万一有人未来从遗留代码 / 测试路径再传 'outbound' 也不会
  // 静默触发 outbound 表的 DELETE — 会以 bad_direction 拒掉)。
  if (direction !== 'inbound' && direction !== 'outbound') {
    const err = new Error(`deleteStalePartners: invalid direction ${direction}`);
    log?.error?.({ event: 'partner_discover.bad_direction', direction }, 'reconciliation DELETE refused');
    return { deleted: 0, errors: [{ phase: 'reconcile_delete', error: err.message }] };
  }
  if (direction === 'outbound') {
    // R158.10 — outbound 表已不再有 ETL 写入, 这里只对 inbound 处理;
    //   若 caller 误传 'outbound', 直接拒掉并返回 0 deleted。
    log?.warn?.({
      event: 'partner_discover.outbound_deprecated',
      agentId: agentIdFilter
    }, 'deleteStalePartners called with direction=outbound — package retired R158.10; refusing DELETE');
    return { deleted: 0, errors: [] };
  }
  const out = { deleted: 0, errors: [] };
  // R158.10 — table / partnerCol / anchorSide 现在常量 (direction === 'inbound')
  const table = 'ad_partner_inbound';
  const partnerCol = 'source_dc';
  const anchorSide = 'dest_dc';

  // R157.8 — the agent_id filter is the column-level ownership gate.
  // Bind as a parameter (? → @p1) so SQL injection-safe. If the table
  // does not carry an agent_id column (legacy schema, pre-R157.4
  // migration), we fall back to the partnerCol-anchor DELETE which is
  // correct for legacy single-tenant deployments.
  let sql;
  let params;
  const agentFilterClause = agentIdFilter ? ' AND agent_id = ?' : '';
  const agentFilterParam = agentIdFilter ? [agentIdFilter] : [];
  if (excludeList.length === 0) {
    sql = `DELETE FROM ${table} WHERE ${anchorSide} = ?${agentFilterClause}`;
    params = [anchorCol, ...agentFilterParam];
  } else {
    const placeholders = excludeList.map(() => '?').join(',');
    sql = `DELETE FROM ${table}
           WHERE ${anchorSide} = ?
             AND ${partnerCol} NOT IN (${placeholders})${agentFilterClause}`;
    params = [anchorCol, ...excludeList, ...agentFilterParam];
  }

  try {
    const r = await db.execute(sql, params);
    out.deleted = Number(r?.affectedRows ?? r?.rowsAffected ?? 0);
    log?.debug?.({
      event: 'partner_discover.reconcile_deleted',
      direction,
      anchorCol,
      excludeCount: excludeList.length,
      deleted: out.deleted
    }, `reconciliation DELETE: ${out.deleted} stale row(s) removed`);
  } catch (e) {
    log?.error?.({
      event: 'partner_discover.reconcile_failed',
      direction,
      anchorCol,
      err: e?.message || String(e)
    }, 'reconciliation DELETE threw');
    out.errors.push({ phase: 'reconcile_delete', direction, anchorCol, error: e?.message || String(e) });
  }
  return out;
}