// Time formatting helpers. Extracted from per-view inline copies so
// SystemAlertsView (R158.68) can import the canonical implementation
// instead of duplicating it.
//
// R158.60.2 (2026-10-09) — ms-precision + CST-fixed "原始周一" display:
// `toLocaleString` was breaking under cross-region operator TZ. The
// CST fix here adds 8h to UTC milliseconds BEFORE formatting, so a
// UTC midnight becomes 08:00 CST regardless of operator locale.
//
// R158.68 (2026-10-10) — promoted to shared lib (web/src/lib/time.js)
// so SystemAlertsView can reuse without duplication.

export function fmtTsCstMs(t) {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  const cstMs = d.getTime() + 8 * 3600_000;
  const cst = new Date(cstMs);
  const MM = String(cst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(cst.getUTCDate()).padStart(2, '0');
  const hh = String(cst.getUTCHours()).padStart(2, '0');
  const mm = String(cst.getUTCMinutes()).padStart(2, '0');
  const ss = String(cst.getUTCSeconds()).padStart(2, '0');
  const mmm = String(cst.getUTCMilliseconds()).padStart(3, '0');
  return `${MM}-${DD} ${hh}:${mm}:${ss}.${mmm}`;
}