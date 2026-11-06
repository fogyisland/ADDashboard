// R158.113 (2026-10-17) — MCP write tools admin router. 1:1 平行 admin-mcp.js
// 范式 (R158.102). 唯一差异: 服务 mcp_write_token 4 KV 跟 mcpw_ prefix. 0
// me 端入口 (操作员 directive "个人账户默认不能申请写入, 写入 tokens 旨在 a
// 管理员 MCP 定义一面泄露"). 4 endpoint 全部 [userAuth, requirePerm('admin:config')]
// 跟 admin-mcp.js:36 1:1 平行.
import { Router } from 'express';
import {
  getMcpWriteTokenState,
  rotateMcpWriteToken,
  commitMcpWriteToken,
  revealMcpWriteToken
} from '../services/mcp-write-token.js';
import { invalidateMcpWriteTokenCache } from '../auth/mcp-write-token.js';

export function adminMcpWriteRouter({ db, requireAuth, requirePerm }) {
  const r = Router();
  const authConfig = [requireAuth, requirePerm('admin:config')];

  r.post('/api/admin/mcp-write-token/rotate', authConfig, async (req, res) => {
    try {
      const out = await rotateMcpWriteToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      invalidateMcpWriteTokenCache();
      // F2 (2026-10-20) — body carries the NEW write token in plaintext. This
      //   credential gates all 6 AD write tools, so no-store it.
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'mcp_write_token.rotate_failed', err: e?.message || String(e) }, 'mcp write token rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  r.post('/api/admin/mcp-write-token/commit', authConfig, async (req, res) => {
    try {
      const out = await commitMcpWriteToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      invalidateMcpWriteTokenCache();
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'mcp_write_token.commit_failed', err: e?.message || String(e) }, 'mcp write token commit failed');
      res.status(500).json({ error: 'commit failed' });
    }
  });

  r.get('/api/admin/mcp-write-token', authConfig, async (_req, res) => {
    try {
      const s = await getMcpWriteTokenState(db);
      res.json(s);
    } catch (e) {
      _req.log?.error?.({ event: 'mcp_write_token.state_failed', err: e?.message || String(e) }, 'mcp write token state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });

  r.get('/api/admin/mcp-write-token/reveal', authConfig, async (req, res) => {
    try {
      const out = await revealMcpWriteToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      // F2 (2026-10-20) — Cache-Control: no-store. Live bearer credential for
      //   the 6 AD write tools; mirrors admin-mcp.js.
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'mcp_write_token.reveal_failed', err: e?.message || String(e) }, 'mcp write token reveal failed');
      res.status(500).json({ error: 'reveal failed' });
    }
  });

  return r;
}
