import { Router } from 'express';
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

const MIN_SINCE_HOURS = 1;
const MAX_SINCE_HOURS = 168; // 7 days

export function lockoutRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/lockout-events/search', ...auth, async (req, res) => {
    try {
      const targetUser = String(req.query.targetUser ?? '').trim();
      const dc         = String(req.query.dc ?? '').trim();
      const caller     = String(req.query.caller ?? '').trim();
      const sinceHoursRaw = req.query.sinceHours;

      if (!targetUser && !dc && !caller) {
        return res.status(400).json({ error: 'at least one of targetUser/dc/caller is required' });
      }
      const sinceHours = Number(sinceHoursRaw);
      if (!Number.isInteger(sinceHours) || sinceHours < MIN_SINCE_HOURS || sinceHours > MAX_SINCE_HOURS) {
        return res.status(400).json({
          error: `sinceHours must be an integer in [${MIN_SINCE_HOURS}, ${MAX_SINCE_HOURS}]`
        });
      }

      const db = getDb();
      // Compute the since-timestamp in JS (using the same helper the rest of
      // the app uses for DATETIME columns). Pass it as the first bind param.
      const since = new Date(Date.now() - sinceHours * 3600_000);
      const sinceTs = toMysqlDatetime(since);

      const dbRes = await db.query(db.sql.lockout.search, [
        sinceTs,
        targetUser, targetUser,
        dc,         dc,
        caller,     caller
      ]);

      // isSource is computed in JS, not SQL: it's true only when (a) the
      // query was unambiguously about a single user (no dc, no caller
      // filters), and (b) this is the first row in the result set (which
      // is already sorted ASC by occurred_at by the SQL ORDER BY).
      const sourceCandidate = !dc && !caller;
      const rows = (dbRes.rows || []).map((r, i) => ({
        occurredAt:         r.occurred_at,
        dcName:             r.dc_name,
        targetUserName:     r.target_user_name,
        subjectUserName:    r.subject_user_name,
        subjectDomain:      r.subject_domain,
        callerComputerName: r.caller_computer_name,
        isSource:           sourceCandidate && i === 0
      }));
      res.json(rows);
    } catch (e) {
      req.log?.error?.({ err: e.message }, 'lockout search failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}