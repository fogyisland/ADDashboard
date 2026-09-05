// 2026-09-05 R81 — member-server PowerShell command execution frontend API client.
//
// Mirrors the R75 pattern (api/ad-admin.js) — the view talks directly to
// the API, no Pinia store. Backend routes:
//   center/src/routes/admin.js (3 endpoints)
//   center/src/routes/agent.js (2 endpoints, not called from UI)
//
// Endpoint reference (R81 spec §2 + §6):
//   GET  /api/admin/member-commands/hosts   — registered hostnames (heartbeat tokenDeliveryList)
//   POST /api/admin/member-commands         — queue a new member_script command
//   GET  /api/admin/member-commands         — history (filter by hostname/status, paginated)
//   GET  /api/admin/member-commands/:id     — single row incl params + result (password-redacted)
//
// `listCommands` defaults page=1 size=50 per R81 spec §1.1 ("最近 50 条命令").

import api from './client.js';

export const memberCommandsApi = {
  // Registered hosts (the host picker source). Server returns
  // { hosts: [{ hostname, lastHeartbeatAt }] } — heartbeat-driven list
  // mirrors what the agent itself sees when polling /api/agent/member-commands.
  listHosts: () => api.get('/api/admin/member-commands/hosts'),

  // Queue a new command. body = { hostname, commandType, params }.
  // commandType is always 'member_script' for R81; params = { script, timeoutSec }.
  // Returns 201 with the inserted row (id, status: 'queued', createdAt, ...).
  queueCommand: ({ hostname, commandType = 'member_script', params }) =>
    api.post('/api/admin/member-commands', { hostname, commandType, params }),

  // History list. Accepts any subset of { hostname, status, page, size }.
  // Defaults page=1 size=50 — matches the drawer "last 50" UX per R81 spec §1.1.
  listCommands: ({ hostname, status, page = 1, size = 50 } = {}) => {
    const params = { page, size };
    if (hostname != null && hostname !== '') params.hostname = hostname;
    if (status) params.status = status;
    return api.get('/api/admin/member-commands', { params });
  },

  // Single full row incl params + result. Server redacts password/newPassword/token
  // before responding (R81 §3 guard rail).
  getCommand: (id) => api.get(`/api/admin/member-commands/${id}`)
};