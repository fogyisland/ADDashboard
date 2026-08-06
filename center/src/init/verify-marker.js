// Parses `-- verify: table X` / `-- verify: column X.Y` markers from the top
// of a SQL migration file. Returns an array of {kind, name} objects.
// Returns [] when no markers are present.
//
// Scan rules:
//   - only the first 50 non-empty lines (marker must live near the top so
//     reviewers see it before the body);
//   - lines inside /* ... */ block comments are ignored (the marker must be
//     outside any block-comment wrapping);
//   - the keyword is case-insensitive;
//   - whitespace between the tokens is collapsed.
const MAX_SCAN_LINES = 50;
const MARKER_RE = /^\s*--\s*verify:\s*(table|column)\s+(\S+)\s*$/i;

export function parseVerifyMarker(sql) {
  const lines = sql.split('\n').slice(0, MAX_SCAN_LINES);
  const out = [];
  let inBlockComment = false;
  for (const line of lines) {
    if (inBlockComment) {
      const closeIdx = line.indexOf('*/');
      if (closeIdx >= 0) {
        // resume after */
        const rest = line.slice(closeIdx + 2);
        inBlockComment = false;
        // process the rest of this line as if it were a new line
        if (rest.trim().length > 0) {
          // recurse via a one-shot: extract marker from `rest`
          const m = MARKER_RE.exec(rest);
          if (m) out.push({ kind: m[1].toLowerCase(), name: m[2] });
        }
      }
      continue;
    }
    // Look for block-comment start
    const bcStart = line.indexOf('/*');
    const beforeBc = bcStart >= 0 ? line.slice(0, bcStart) : line;
    const m = MARKER_RE.exec(beforeBc);
    if (m) out.push({ kind: m[1].toLowerCase(), name: m[2] });
    if (bcStart >= 0 && line.indexOf('*/', bcStart + 2) < 0) {
      inBlockComment = true;
    }
  }
  return out;
}