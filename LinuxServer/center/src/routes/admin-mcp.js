// R158.102 (2026-10-14) — MCP server admin router. 4 endpoints that drive
// the dual-key mcp_api_token rotation lifecycle for the /mcp Streamable HTTP
// server.
//
// Class admin.js:538-619 agent-token endpoints 1:1 parallel:
//   POST /api/admin/mcp-token/rotate — generate new token, stash old as previous
//   POST /api/admin/mcp-token/commit — clear previous once every AI Agent
//                                       has been reconfigured
//   GET  /api/admin/mcp-token        — state (NEVER the secret)
//   GET  /api/admin/mcp-token/reveal — operator-initiated read of the active
//                                       secret (high-severity audit row)
//
// All 4 endpoints carry [userAuth, requirePerm('admin:config')] — same
// posture as /api/admin/agent-token/* (R158.69 precedent). invalidateMcpTokenCache
// is called after every write so the very next /mcp request sees the new
// state without a server restart.
//
// `db` and `userAuth` are passed in by the factory caller (server.js) so
// tests can inject mocks — mirrors the dcsRouter / lockoutRouter factory
// shape (R117 / R107.1).
import { Router } from 'express';
import {
  getMcpTokenState,
  rotateMcpToken,
  commitMcpToken,
  revealMcpToken
} from '../services/mcp-token.js';
import { invalidateMcpTokenCache } from '../auth/mcp-token.js';

export function adminMcpRouter({ db, requireAuth, requirePerm }) {
  const r = Router();
  // Same auth chain as the rest of /api/admin/* (admin.js:538 precedent):
  // userAuth + admin:config perm. requirePerm('admin:config') is also what
  // jwt-secret / client-settings / agent-token use, so an operator with the
  // "Config" sidebar group can already see MCP token rotate/commit/reveal.
  const authConfig = [requireAuth, requirePerm('admin:config')];

  // POST /api/admin/mcp-token/rotate
  // Body: none. Returns { newToken, rotatedAt, version } so the McpTokenView
  // can show the new token ONCE for the operator to copy into the AI Agent
  // config. Class agent-token:548.
  r.post('/api/admin/mcp-token/rotate', authConfig, async (req, res) => {
    try {
      const out = await rotateMcpToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      invalidateMcpTokenCache();
      // F2 (2026-10-20) — body carries the NEW token in plaintext; don't let
      //   it linger in browser cache / history or a body-logging proxy.
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'mcp_token.rotate_failed', err: e?.message || String(e) }, 'mcp token rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  // POST /api/admin/mcp-token/commit
  // Body: none. Clears the previous token so old AI Agent configs immediately
  // stop working. Idempotent — returns { ok: true, didCommit: bool }.
  r.post('/api/admin/mcp-token/commit', authConfig, async (req, res) => {
    try {
      const out = await commitMcpToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      invalidateMcpTokenCache();
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'mcp_token.commit_failed', err: e?.message || String(e) }, 'mcp token commit failed');
      res.status(500).json({ error: 'commit failed' });
    }
  });

  // GET /api/admin/mcp-token
  // Returns the rotation state (no secret). Shape:
  //   { current_set, previous_set, rotatedAt, version }
  // Class agent-token:578.
  r.get('/api/admin/mcp-token', authConfig, async (_req, res) => {
    try {
      const s = await getMcpTokenState(db);
      res.json(s);
    } catch (e) {
      _req.log?.error?.({ event: 'mcp_token.state_failed', err: e?.message || String(e) }, 'mcp token state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });

  // GET /api/admin/mcp-token/reveal
  // Read-only reveal of the active mcp auth token. Audit-classifier marks
  // reveal_agent_token as high severity (R158.69 agent-token reveal precedent);
  // mcp_token_reveal gets the same severity. Body: { token, revealedAt, version }.
  r.get('/api/admin/mcp-token/reveal', authConfig, async (req, res) => {
    try {
      const out = await revealMcpToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      // F2 (2026-10-20) — Cache-Control: no-store. Response body is the live
      //   bearer credential for all 8 /mcp read tools.
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'mcp_token.reveal_failed', err: e?.message || String(e) }, 'mcp token reveal failed');
      res.status(500).json({ error: 'reveal failed' });
    }
  });

  return r;
}
