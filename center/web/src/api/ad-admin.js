// 2026-08-31 R75 — AD user/group management frontend API client.
//
// Mirrors the R66/R67 pattern (api/admin.js, api/packages.js) —
// the view talks directly to the API, no Pinia store. The backend
// routes live in center/src/routes/admin.js (3 endpoints) and
// center/src/routes/agent.js (2 endpoints).
//
// Endpoint reference (R75 spec §2.5 + §2.3 + §2.4):
//   GET  /api/dashboard/topology                  — DC picker source
//   POST /api/admin/ad-commands                   — queue a new command
//   GET  /api/admin/ad-commands                   — list (operator filter / status / paging)
//   GET  /api/admin/ad-commands/:id               — single full row incl params + result
//   GET  /api/agent/ad-commands?hostname=…        — agent poll (we don't call this from the UI)
//   POST /api/agent/ad-commands/:id/result        — agent ack (we don't call this from the UI)
//
// The 17 command types are enumerated in center/src/services/ad-admin-commands.js
// and the spec §2.2 — param shapes vary per type. This client is a thin
// transport; the views own the per-command-type param shape.
//
// listCommands default is `size=20` per the R75 spec §1.3 — the right-
// side history drawer renders the most recent 20 commands. Full list
// endpoints allow explicit page/size overrides when they need them.

import api from './client.js';

export const adAdminApi = {
  // DC picker — reuse /api/dashboard/topology (R45 surface, no new endpoint).
  // Returns { nodes: [{name, type:'site'|'dc', site?, isHub?}], links: [...] }.
  // Views flatten this into a unique-DC list (dedupes by dcName).
  listDcs: () => api.get('/api/dashboard/topology'),

  // Queue a new AD command. body = { targetDc, commandType, params }.
  // Returns 201 with the inserted row (id, status: 'queued', createdAt, ...).
  queueCommand: ({ targetDc, commandType, params }) =>
    api.post('/api/admin/ad-commands', { targetDc, commandType, params }),

  // History list. Accepts any subset of { operatorId, status, page, size }.
  // Defaults page=1 size=20 — matches the drawer "last 20" UX.
  listCommands: ({ operatorId, status, page = 1, size = 20 } = {}) => {
    const params = { page, size };
    if (operatorId != null) params.operatorId = operatorId;
    if (status) params.status = status;
    return api.get('/api/admin/ad-commands', { params });
  },

  // Single full row incl params_json + result_json. Used by the drawer's
  // "查看结果" expand.
  getCommand: (id) => api.get(`/api/admin/ad-commands/${id}`)
};