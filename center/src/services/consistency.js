// Cross-DC consistency scoring (Task 5). Reads the latest row per agent from
// pkg_ad_domain_consistency.metrics (Task 4 ingest path) and computes a
// majority-hash consensus per AD class (users, groups, GPOs). Outliers —
// agents whose hash disagrees with the consensus or whose hash is NULL due to
// a class-level failure — are surfaced separately.
//
// Read-only — this service never writes. The package's collect.ps1 owns the
// ingest path; this service is a scoring layer on top of the resulting table.
//
// Both MySQL + MSSQL are supported via db.sql.consistency.latestPerAgent.
// Both branches select the same column order so service code can iterate
// the result without per-dialect branching. ts is coerced to JS Date by the
// driver wrappers (mysql2 → Date, mssql → Date), so .getTime() works
// uniformly for tie-break comparisons.

import { getDb } from '../db/index.js';

const CLASS_NAMES = ['users', 'groups', 'gpos'];

/**
 * Empty shape for one class — used when the metrics table is missing
 * (fresh install before the ad_domain_consistency package has ever run)
 * AND when the table is present but empty. Matches the shape
 * buildClassShape returns for `[]` so callers can iterate uniformly.
 */
function emptyShape(className) {
  return {
    class: className,
    consensus_hash: null,
    consensus_count: 0,
    agent_count: 0,
    outliers: []
  };
}

/**
 * Detect "this table doesn't exist" errors from MySQL or MSSQL drivers so
 * the consistency route can degrade to an empty shape (200) instead of 500.
 * Both drivers surface a recognizable error code/number; MSSQL additionally
 * nests the InvalidObjectName in originalError.info.name.
 */
function isTableMissingError(e) {
  if (!e) return false;
  // MySQL (mysql2) — ER_NO_SUCH_TABLE 1146
  if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) return true;
  // MSSQL (mssql) — InvalidObjectName maps to ETABLE / number 208
  if (e.code === 'ETABLE' || e.number === 208) return true;
  const orig = e.originalError;
  if (orig && orig.info && orig.info.name === 'InvalidObjectName') return true;
  return false;
}

/**
 * Build the snake_case output shape for one class.
 *
 *   {
 *     class: 'users',
 *     consensus_hash: '<hex>' | null,
 *     consensus_count: N,
 *     agent_count: M,
 *     outliers: [
 *       { agent_id: '<host>', hash: '<hex>' | null, collected_at: '<iso>' }
 *     ]
 *   }
 *
 * `agent_count` is the number of distinct agents with a row in the most
 * recent batch (regardless of whether their hash matches consensus). When
 * all agents have null hash for a class (all-failed), `consensus_hash` is
 * `null`, `consensus_count` is 0, and every agent appears in `outliers`.
 *
 * @param {string} className    'users' | 'groups' | 'gpos'
 * @param {Array<{agent_id, hash, ts}>} rows  latest-per-agent rows
 * @returns {object}
 */
export function buildClassShape(className, rows) {
  // First pass: count distinct hashes. Map keyed by hash-or-null so nulls
  // share a single bucket (matches spec: "or whose *_hash IS NULL due to
  // class-level failure"). Tie-break: when two hashes have equal count, pick
  // the one with the most recent MAX(ts) across the agents that produced
  // it (i.e. the hash that "won" the most recent snapshot). Documented in
  // the brief + service header — see git history for the ruling.
  const counts = new Map(); // hash | '__NULL__' → { count, latestTs }
  for (const r of rows) {
    const key = r.hash == null ? '__NULL__' : r.hash;
    const rawTs = r.ts instanceof Date ? r.ts.getTime() : new Date(r.ts).getTime();
    const ts = Number.isFinite(rawTs) ? rawTs : 0;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      if (ts > existing.latestTs) existing.latestTs = ts;
    } else {
      counts.set(key, { count: 1, latestTs: ts });
    }
  }

  // Pick the winner. Empty inputs (no rows at all) → null consensus, count 0.
  // Sentinel: skip non-null buckets that didn't get any entries (impossible
  // since we only iterate counts.keys()) — start consensusTs at -1 so any
  // real positive ts wins the first comparison.
  let consensusHash = null;
  let consensusCount = 0;
  let consensusTs = -1;
  for (const [key, agg] of counts.entries()) {
    // Skip the null bucket for consensus selection — spec: "consensus_hash
    // is null when no agents have a non-null hash (all-failed class)".
    // The null bucket still shows up in outliers below.
    if (key === '__NULL__') continue;
    if (agg.count > consensusCount
      || (agg.count === consensusCount && agg.latestTs > consensusTs)) {
      consensusHash = key;
      consensusCount = agg.count;
      consensusTs = agg.latestTs;
    }
  }

  // Outliers: every agent whose hash ≠ consensus, OR whose hash IS NULL
  // (the "(or whose *_hash IS NULL due to class-level failure)" branch in
  // the brief's step 3). This means even the all-failed class has every
  // agent in `outliers` — they all need operator attention even though
  // they "agree" on null.
  //
  // Order: by agent_id ASC for stable test assertions + UI rendering.
  const outliers = [];
  const sortedRows = [...rows].sort((a, b) => {
    const ax = String(a.agent_id);
    const bx = String(b.agent_id);
    if (ax < bx) return -1;
    if (ax > bx) return 1;
    return 0;
  });
  for (const r of sortedRows) {
    if (r.hash == null || r.hash !== consensusHash) {
      outliers.push({
        agent_id: r.agent_id,
        hash: r.hash ?? null,
        collected_at: r.ts instanceof Date ? r.ts.toISOString() : new Date(r.ts).toISOString()
      });
    }
  }

  return {
    class: className,
    consensus_hash: consensusHash,
    consensus_count: consensusCount,
    agent_count: rows.length,
    outliers
  };
}

/**
 * Read latest-per-agent rows from pkg_ad_domain_consistency.metrics and
 * compute the cross-DC consensus shape for each class.
 *
 * @param {object|null} [db]  Optional db facade. Defaults to getDb().
 * @returns {Promise<{users: object, groups: object, gpos: object}>}
 */
export async function deriveConsistency(db = null) {
  const d = db ?? getDb();
  let rows;
  try {
    ({ rows } = await d.query(d.sql.consistency.latestPerAgent));
  } catch (e) {
    // Fresh install (or DB just bootstrapped without seeding ad_domain_consistency
    // metrics yet) raises ER_NO_SUCH_TABLE / InvalidObjectName. Degrade to the
    // empty shape for all 3 classes instead of 500 — operator still sees a
    // valid response with agent_count=0 and no outliers, which matches the
    // "table exists but empty" contract from buildClassShape([]).
    if (isTableMissingError(e)) {
      const result = {};
      for (const className of CLASS_NAMES) result[className] = emptyShape(className);
      return result;
    }
    throw e;
  }

  // Normalize rows into the shape buildClassShape expects. Snake-case keys
  // straight from the SQL result; js Date already from the driver wrappers.
  const perClassRows = {
    users: [], groups: [], gpos: []
  };
  for (const row of rows) {
    perClassRows.users.push({
      agent_id: row.agent_id,
      hash: row.user_hash,
      ts: row.ts
    });
    perClassRows.groups.push({
      agent_id: row.agent_id,
      hash: row.group_hash,
      ts: row.ts
    });
    perClassRows.gpos.push({
      agent_id: row.agent_id,
      hash: row.gpo_hash,
      ts: row.ts
    });
  }

  const result = {};
  for (const className of CLASS_NAMES) {
    result[className] = buildClassShape(className, perClassRows[className]);
  }
  return result;
}
