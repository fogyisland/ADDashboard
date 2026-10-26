// R158.15 (2026-10-01) -- ad_replication_status_probe post-hook service.
//
// Ingests per-peer probe rows from agents and appends them to
// ad_replication_probe_history (append-only, one row per
// (source_dc, dest_dc, naming_context) per 15-min probe cycle).
//
// Behaviour matrix (mirrors partner-discover's R157.4 directive):
//   agent_id  ∉ ad_dcs -> drop entire batch + push to result.errors
//                          (so agent can self-suspend; same pattern
//                           as R157.4 partner-discover + R157.9 M10).
//   peerDc    ∉ ad_dcs -> silent skip per row (NOT pushed to errors;
//                          topology drift is not a malformed payload,
//                          same R157.4 silent-skip decision).
//   INSERT failure    -> per-row error.push so agent sees retry hint.
//
// Returns { upserted, skipped_not_in_ad_dcs,
//           dropped_agent_not_in_ad_dcs, errors }.
// runner.js surfaces errors[].details.reason = 'agent_not_in_ad_dcs'
// so package-manager on agent side can self-suspend (R157.9 M10).

import { getKnownDcSet } from './partner-discover.js';

const CHUNK = 10;

/**
 * Coerce one probe row from PS1 wire shape into the centre-side INSERT
 * parameter order. Accepts both snake_case and camelCase for resilience.
 */
function normaliseProbe(p) {
  const sourceDc = String(p.source_dc ?? p.sourceDc ?? '').trim();
  const destDc   = String(p.dest_dc   ?? p.destDc   ?? '').trim();
  const nc       = String(p.naming_context ?? p.namingContext ?? '').trim();
  const attemptAt = p.attempt_at ?? p.attemptAt;
  return {
    source_dc: sourceDc,
    dest_dc:   destDc,
    naming_context: nc,
    attempt_at: attemptAt ? new Date(attemptAt) : new Date(),
    result:  p.result === 'success' ? 'success' : 'error',
    status_code: Number.isFinite(p.status_code)
      ? Number(p.status_code)
      : (Number.isFinite(p.statusCode) ? Number(p.statusCode) : 2),
    duration_ms: Number.isFinite(p.duration_ms)
      ? Number(p.duration_ms)
      : (Number.isFinite(p.durationMs) ? Number(p.durationMs) : null),
    objects_transferred: Number.isFinite(p.objects_transferred)
      ? Number(p.objects_transferred)
      : null,
    error_code: Number.isFinite(p.error_code)
      ? Number(p.error_code)
      : (Number.isFinite(p.errorCode) ? Number(p.errorCode) : null),
    error_message: p.error_message ?? p.errorMessage ?? null
  };
}

/**
 * Append-only probe history writer.
 *
 * @param {object} db centre db handle (must expose .sql.replication.insertProbeHistory)
 * @param {Array<object>} probes wire-shape array from agent envelope
 * @param {string} agentId X-Agent-Id header value
 * @param {object} [log] pino-style logger
 */
export async function upsertProbes(db, probes, agentId, log = null) {
  const summary = {
    upserted: 0,
    skipped_not_in_ad_dcs: 0,
    dropped_agent_not_in_ad_dcs: 0,
    errors: []
  };

  if (!Array.isArray(probes) || probes.length === 0) return summary;

  const norm = probes.map(normaliseProbe).filter(
    (p) => p.source_dc && p.dest_dc && p.naming_context
  );
  if (norm.length === 0) return summary;

  // ad_dcs Set membership (5-min TTL via partner-discover module cache).
  const known = await getKnownDcSet(db);

  // R157.4 partner-discover directive: agent_id not in ad_dcs -> drop
  // entire batch + push to result.errors (NOT silent skip).
  if (!known.has(agentId)) {
    summary.dropped_agent_not_in_ad_dcs = 1;
    summary.skipped_not_in_ad_dcs = norm.length;
    log?.warn?.(
      {
        event: 'replication_status_probe.dropped',
        agentId,
        count: norm.length
      },
      'agent_id not in ad_dcs -- dropping entire batch'
    );
    return summary;
  }

  const sql = db.sql?.replication?.insertProbeHistory;
  if (typeof sql !== 'string') {
    log?.error?.(
      { event: 'replication_status_probe.sql_missing' },
      'insertProbeHistory SQL key not found in db.sql.replication'
    );
    summary.errors.push({
      phase: 'sql_resolve',
      error: 'missing SQL: replication.insertProbeHistory'
    });
    return summary;
  }

  // Chunked INSERT (R157.8 M2 bound rationale -- keep individual
  // promises independent so a single row's failure doesn't poison
  // the batch).
  for (let i = 0; i < norm.length; i += CHUNK) {
    const slice = norm.slice(i, i + CHUNK);
    await Promise.allSettled(slice.map(async (p, jInChunk) => {
      const idx = i + jInChunk;
      // Silent skip for peerDc not in ad_dcs (R157.4 topology drift).
      if (!known.has(p.dest_dc)) {
        summary.skipped_not_in_ad_dcs++;
        log?.debug?.(
          { event: 'replication_status_probe.skip', peerDc: p.dest_dc },
          'peerDc not in ad_dcs -- silent skip'
        );
        return;
      }
      const errMsg = p.error_message
        ? String(p.error_message).slice(0, 512)
        : null;
      const params = [
        new Date(),                       // collected_at (centre clock)
        agentId,
        p.source_dc,
        p.dest_dc,
        p.naming_context,
        p.attempt_at,
        p.result,
        p.status_code,
        p.duration_ms,
        p.objects_transferred,
        p.error_code,
        errMsg
      ];
      try {
        await db.execute(sql, params);
        summary.upserted++;
      } catch (e) {
        summary.errors.push({
          index: idx,
          peerDc: p.dest_dc,
          namingContext: p.naming_context,
          error: e?.message || String(e)
        });
        log?.error?.(
          {
            event: 'replication_status_probe.upsert_failed',
            peerDc: p.dest_dc,
            err: e?.message
          },
          'INSERT probe history failed'
        );
      }
    }));
  }
  return summary;
}
