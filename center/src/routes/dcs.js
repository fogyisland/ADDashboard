import { Router } from 'express';
import { getDb } from '../db/index.js';

// GET /api/dcs/summary?siteId=N
//   - Returns one row per DC, latest summary entry (naming_context = '__dc_summary__').
//   - If siteId is missing/empty/non-numeric -> returns all DCs (no filter).
//   - If siteId is a positive integer -> filters by ad_dcs.site_id = siteId.
//   - Sorted by dcHost ASC.
//   - partnersCount = count of replication_status rows for the DC with
//     naming_context <> '__dc_summary__' within ±5 minutes of this summary's
//     collected_at (cheap same-cycle approximation).
//   - Auth: requires [userAuth, requirePerm('admin:users')] — same as other admin
//     read endpoints.

export function dcsRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/dcs/summary', ...auth, async (req, res) => {
    try {
      const db = getDb();

      const siteIdRaw = req.query.siteId;
      // Treat empty / missing / non-numeric as "all sites". Reject only if a
      // value is present but isn't a positive integer.
      const siteId =
        siteIdRaw === undefined || siteIdRaw === '' || siteIdRaw === null
          ? null
          : Number(siteIdRaw);
      if (siteId !== null && (!Number.isInteger(siteId) || siteId <= 0)) {
        return res.status(400).json({ error: 'siteId must be a positive integer' });
      }

      const { rows } = await db.query(db.sql.replication.latestSummaryPerDc);

      // 2nd pass: look up siteName + siteId for each DC by hostname.
      // We do it in a single IN-keyed query rather than N+1.
      const dcHosts = rows.map((r) => r.source_dc);
      let dcRows = [];
      if (dcHosts.length > 0) {
        const placeholders = dcHosts.map(() => '?').join(',');
        const dcsRes = await db.query(
          `SELECT d.dc_name AS dcHost, s.site_name AS siteName, d.site_id AS siteId
             FROM ad_dcs d LEFT JOIN ad_sites s ON d.site_id = s.site_id
            WHERE d.dc_name IN (${placeholders})`,
          dcHosts
        );
        dcRows = dcsRes.rows;
      }

      const siteMap = new Map(dcRows.map((d) => [d.dcHost, d]));
      const out = [];
      for (const row of rows) {
        const meta = siteMap.get(row.source_dc);
        if (siteId !== null && meta?.siteId !== siteId) continue;
        out.push({
          dcHost: row.source_dc,
          siteName: meta?.siteName ?? null,
          partnersCount: 0, // populated below
          usersCount: row.users_count,
          groupsCount: row.groups_count,
          gposCount: row.gpos_count,
          lockedCount: row.locked_count,
          collectedAt: row.collected_at
        });
      }

      // Count replication partners per DC from the same cycle (within ±5 min
      // of this summary's collected_at). Cheap and good enough — we don't
      // need exact same-tick matching.
      for (const card of out) {
        const partnersRes = await db.query(
          `SELECT COUNT(*) AS c FROM ad_replication_status
            WHERE source_dc = ? AND naming_context <> '__dc_summary__'
              AND collected_at BETWEEN ? - INTERVAL 5 MINUTE AND ? + INTERVAL 5 MINUTE`,
          [card.dcHost, card.collectedAt, card.collectedAt]
        );
        card.partnersCount = Number(partnersRes.rows[0]?.c ?? 0);
      }

      out.sort((a, b) => a.dcHost.localeCompare(b.dcHost));
      res.json(out);
    } catch (e) {
      req.log?.error?.({ err: e }, 'dcs summary fetch failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
