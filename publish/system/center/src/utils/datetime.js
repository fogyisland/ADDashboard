// Convert ISO 8601 (e.g. "2026-07-12T09:00:04.931Z") or Date to MySQL naive
// DATETIME format ("2026-07-12 09:00:04"). Returns null for null/undefined/
// empty/invalid input. MySQL DATETIME columns (without (3) fractional
// modifier) reject the "Z" and fractional seconds; this is the boundary
// where ISO-in becomes MySQL-friendly-out. SQL Server datetime2 columns
// accept ISO strings natively and do not need this transformation.

export function toMysqlDatetime(input) {
  if (input == null || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
