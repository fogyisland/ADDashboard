# Non-AD server management — smoke test (2026-08-09)

**Branch:** feat/non-ad-server-management  
**Base:** 17b6db3 (origin/main)  
**Commits:** 23 commits ahead of base

This is a **runbook**, not a record of an executed run. The scenarios below need a
real Windows environment with AD + center + agent installed; they were not executed
in the development worktree. Tick the boxes during the production smoke.

Automated gates at the time of writing (these *were* executed):

| Suite | Result |
| --- | --- |
| center (`npm test`) | 752 pass, 0 fail, 58 skipped (810 total) |
| frontend (`npx vitest run`) | 236 pass, 0 fail (50 files) |
| agent (`node --test tests/*.test.js`) | 60 pass, 0 fail |
| mirror (`scripts/verify-mirror.ps1`) | 45 pass, 0 drift, 0 missing |

## Scenarios

### 1. Init — migration 014 applies
- [ ] Fresh install of center + agent (or upgrade over existing install)
- [ ] center/server.js boot runs migrations → migration 014 applied → 8 new tables present (ad_member_servers, ad_member_server_packages, ad_alert_rules, ad_alert_rule_state, ad_alert_events, ad_alert_email_outbox, pkg_ad_os_baseline.metrics, server_group_members)
- [ ] SMTP config defaults seeded (smtp_host=null initially; center never auto-fills credentials)

### 2. Built-in seed
- [ ] First normal-mode start → `data/packages/ad_os_baseline/1.0.0/manifest.json` present
- [ ] `audit_log` contains a `seed_builtin_ad_os_baseline` row

### 3. Self-register
- [ ] On a member server: `install-agent.ps1 -AgentType non-ad -ComputerName SRV-A -CenterUrl ... -AgentToken ...`
- [ ] NSSM DisplayName = "AD Dashboard Agent (Member)"; Description = "AD Dashboard member-server monitor..."
- [ ] Restart the service → 5s later, `ad_member_servers.hostname=SRV-A` row appears with `discovered_via='self-register'`, `agent_version='0.1.0'`, `os_version`, `ip_address` populated
- [ ] Heartbeat updates `last_seen_at` every 5s

### 4. Package pull
- [ ] In admin UI: enable `ad-os-baseline` globally (or via server group)
- [ ] Agent polls `/api/admin/agent/packages-for-host?hostname=SRV-A` → returns 1 manifest
- [ ] Filter accepts (agent.type='non-ad', platforms=['windows']) → starts timer
- [ ] `collect.ps1` runs every 60s → metrics insert into `pkg_ad_os_baseline.metrics`

### 5. Disable built-in
- [ ] Try `POST /api/admin/packages/install` with `ad-os-baseline` (global install) → 200 + audit
- [ ] Try `installer.uninstallPackage({name:'ad-os-baseline'})` → 400 with `code: 'PKG_BUILTIN'` (re-2)
- [ ] Per-server `DELETE /api/admin/member-servers/SRV-A/packages/ad-os-baseline` → 200 + audit `disable_builtin_ad_os_baseline`

### 6. Alert rule create + fire
- [ ] Create a rule on SRV-A with `cpu_pct > 50 for 1 minute` (override for_minutes for testing)
- [ ] Generate synthetic metrics that exceed threshold for 2 minutes
- [ ] `alert_rule_state.state='firing'`, `alert_events.firing` row, `alert_email_outbox` row created

### 7. Email send
- [ ] Configure SMTP via admin UI (EmailConfigCard) → use a real test mailbox or local mailhog
- [ ] `EmailDeliveryLoop` drains the outbox → `sent_at` set → email received with condition snapshot

> **Blocked by follow-up 1 below.** As of this commit, delivery cannot succeed against a
> real SMTP server. Fix that defect before running scenarios 7 and 8.

### 8. Recovery
- [ ] Wait for metrics to drop below threshold for `for_minutes`
- [ ] `last_recovered_at` set → recovery email sent (separate outbox row with `event='recovered'`)

### 9. Frontend
- [ ] Login admin → `/admin/member-servers` shows SRV-A
- [ ] `/admin/member-servers/SRV-A` shows packages + alerts tabs + baseline tile grid
- [ ] Rule editor save → reload page → rule persists

### 10. Cooldown
- [ ] Force a second firing while `cooldown_minutes` is active
- [ ] No second outbox row created (suppressed)

## Known follow-ups (parked from review)

1. **`center/src/services/email.js` — SMTP field-name mismatch makes real delivery fail.**
   `send()` reads `smtp.host` / `.port` / `.user` / `.password` (lines 44-47), but
   `createEmailDeliveryLoop` passes the snake_case `system_config` map straight through as
   `smtp` (line 199), whose keys are `smtp_host` / `smtp_port` / `smtp_user` / `smtp_password`.
   All four reads resolve to `undefined`, so nodemailer gets `host: undefined` and every
   outbox row burns its retry budget. Verified still present at `c0ec015`.
   The loop's own `if (!smtp.smtp_host)` guard (line 189) reads the snake_case key correctly,
   so the mismatch is confined to the `send()` boundary.
   Unit tests do not catch this: they inject `sendImpl`, so the real `send()` is never
   exercised by the loop. **Fix before the first production deployment**; add a test that
   drives the loop through the real `send()` with a stubbed `createTransport` so the
   transport options are asserted.
2. Empty SMTP password doesn't clear (T15 brief vs T12 backend contract mismatch).
   `********` masks, `''` preserves — both are intentional; only the UI was inconsistent.
3. Member-server frontend detail view's `listByHostname` lacks server-side LIMIT
   (capped client-side via `rows.slice(0,200)`).

## Cross-task concerns from whole-branch review

The whole-branch opus review had not run at the time this document was written
(it is the next SDD step after Task 17). Record its findings here once the
verdict lands.
