# Init Wizard — Design Spec

**Date:** 2026-07-13
**Status:** Approved (brainstorming complete)
**Supersedes:** PowerShell `install-center.ps1` schema/seed/admin/config steps

## Goal

Replace the schema/seed/admin/config portion of `scripts/install-center.ps1` with a browser-based 3-screen wizard served by the center service. The wizard runs on first boot when no admin user exists, walks the operator through database connection setup, admin user creation, and seed initialization, then writes `appsettings.json` so the service transitions to normal mode.

## Motivation

The current `install-center.ps1` PowerShell installer is monolithic: it does deployment (NSSM, file copy) and application init (DB, admin, config) in one script. The init portion is awkward — SQL strings are escaped inside PowerShell, password generation is shell-based, and there's no UI for operators who aren't comfortable with command-line DB clients.

The wizard moves the application init into a Vue 3 SPA served by the center Node service itself. The PowerShell installer keeps only the deployment parts (which genuinely require a Windows shell). Operators can complete init via browser on first boot.

## Decisions (already locked)

| Decision | Choice |
|---|---|
| Relationship to PS installer | Wizard replaces the schema/seed/admin/config portion of `install-center.ps1`; PS keeps deployment only |
| Wizard trigger | Server boots in init mode when `sys_users` is empty (also when appsettings.json missing or DB unreachable) |
| Once-init access guard | `/init` route and `/api/init/*` endpoints return 404 forever once any admin user exists |
| PS installer scope post-change | Keeps: NSSM service registration, file copy, directory creation, service start. Removes: DB schema/seed/admin/config |

## Architecture

### Boot-time mode detection (`center/server.js`)

The server decides init mode vs normal mode before mounting any non-init routes:

| State | Condition | Mode |
|---|---|---|
| No config | `appsettings.json` missing | Init mode (built-in defaults: `listenPort=8080`, no DB) |
| Config but no DB block | `appsettings.json` exists but `db.dialect` missing | Init mode |
| DB unreachable | Config valid, but `db.healthcheck()` fails | Init mode (log warning) |
| DB reachable, no admin | Config valid, DB up, `SELECT COUNT(*) FROM sys_users` returns 0 | Init mode |
| Normal | Config valid, DB up, `sys_users` has ≥1 row | Normal mode (current behavior) |

Mode is determined on every boot (cheap `SELECT COUNT(*)`, ~5ms).

### Route surface per mode

| Path | Init mode | Normal mode |
|---|---|---|
| `GET/POST /api/init/*` | Public, executes wizard actions | **404** (guard middleware) |
| `GET /api/init/status` | Returns `{needsInit: true, dialect?: 'mysql'\|'mssql'}` | Returns `{needsInit: false}` |
| `GET /init` (frontend) | Renders wizard | Redirects to `/login` |
| All other routes | 404 or redirect to `/init` | Normal auth + RBAC |

### Wizard facade caching

The init router holds a single **wizard facade** in module scope (separate from the global facade):
- `POST /db/test` creates the wizard facade (or rebuilds if params changed). Subsequent calls reuse it.
- `POST /db/apply` and `POST /admin/create` reuse the existing wizard facade.
- `POST /finalize` writes the config file; doesn't touch the facade.
- The wizard facade is closed on `/finalize` success or server shutdown.

## Backend — `center/src/init/`

### `router.js` — 5 routes

| Route | Body | Behavior |
|---|---|---|
| `GET /status` | — | Returns `{needsInit: bool, dialect?: 'mysql'\|'mssql'}` |
| `POST /db/test` | `{dialect, host\|server, port, database, user, password, encrypt?}` | Wizard facade → `SELECT 1`. Returns `{ok, error?}`. Does not mutate global facade. |
| `POST /db/apply` | `{dialect, connParams, createDatabase: bool}` | Creates DB (mysql only, if `createDatabase: true`), applies `01-tables.sql`, `02-seed-roles.sql`, all migrations. Idempotent. |
| `POST /admin/create` | `{dialect, connParams, username, password}` | INSERTs admin into `sys_users`. Pre-check: `SELECT COUNT(*) FROM sys_users` must be 0, else 409. |
| `POST /finalize` | `{listenPort, agentToken, jwtSecret, logLevel, env, dialect, connParams}` | Writes `appsettings.json`. Returns `{ok: true, path}`. |

Guard middleware on every route: returns **404** if `needsInit === false` (init complete). 404 (not 401/403) to avoid leaking wizard existence.

### `db-tester.js`

`withOneShotFacade(dialect, connParams, async (db) => ...)` helper. Creates a fresh driver (mysql2 pool or mssql pool), wraps it as a facade, runs the callback, closes the pool. Used by the test route. The wizard facade is a singleton version of this held in module scope.

### `schema-applier.js`

Reads SQL files from disk:
```
db/schema/{dialect}/01-tables.sql
db/schema/{dialect}/02-seed-roles.sql
db/migrations/{dialect}/*.sql  (sorted)
```

Splits each file into statements on `;\n` (newline-aware, ignores `;` inside `'string'`/`"string"` literals — small hand-written tokenizer, ~30 LOC). For MSSQL the IF/END blocks are kept as one logical statement per the splitter. Each statement → `db.execute(sql, [])`.

All files are idempotent by design:
- MySQL: `CREATE TABLE IF NOT EXISTS ...`
- MSSQL: `IF OBJECT_ID('table', 'U') IS NULL BEGIN ... END`
- Seed rows: `IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin') INSERT ...`

So re-running is safe even if a previous attempt partially succeeded.

### `admin-creator.js`

Inserts via SQL registry (new keys, see below). Uses existing `hashPassword` helper from `center/src/auth/password.js`. Pre-check: `SELECT COUNT(*) FROM sys_users` — must be 0, else 409.

### `config-writer.js`

Assembles the `appsettings.json` shape (same as current `loadConfig` output) and writes atomically (write to `.tmp`, rename). Validates via `loadConfig` after write to ensure it's parseable.

### Server wiring (`center/server.js`)

```js
const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const config = loadConfigOrNull(configPath);   // returns null if file missing
let db = null;
if (config) {
  try { await init(config); db = getDb(); }
  catch (e) { logger.warn({err: e}, 'db init failed, falling back to init mode'); }
}
const needsInit = await checkNeedsInit(db);   // null db → true; throws → true; count===0 → true

const app = createApp({ config: config || defaultConfig(), db, logger, needsInit });
if (needsInit) {
  app.use(initRouter({ logger }));
} else {
  app.use(authRouter({ config, logger }));
  app.use(agentRouter({ config, logger }));
  app.use(dashboardRouter({ config, logger }));
  app.use(adminRouter({ config, logger }));
}
```

Graceful shutdown also closes the wizard facade if open.

### New SQL registry keys (`center/src/db/sql.js`)

- `users.createAdmin` (mysql + mssql variants):
  - mysql: `INSERT INTO sys_users (username, password_hash, role_id) VALUES (?, ?, (SELECT id FROM sys_roles WHERE role_name = 'admin'))`
  - mssql: `INSERT INTO sys_users (username, password_hash, role_id) SELECT ?, ?, id FROM sys_roles WHERE role_name = 'admin'`
- `users.count` (mysql + mssql variants, for the pre-check): `SELECT COUNT(*) AS n FROM sys_users`

## Frontend — `frontend/src/views/init/`

### Route + bootstrap guard

New public route in `frontend/src/router.js`:
```js
{ path: '/init', component: InitWizardView, meta: { public: true } }
```

Replace existing `beforeEach` with init-aware guard (cached status, fetched once per session):
```js
let initStatusCache = null;
router.beforeEach(async (to) => {
  if (initStatusCache === null) {
    const r = await api.get('/api/init/status');
    initStatusCache = r.data;
  }
  const { needsInit } = initStatusCache;
  if (needsInit && to.path !== '/init') return { path: '/init' };
  if (!needsInit && to.path === '/init') return { path: '/login' };
  if (to.meta.public) return true;
  const t = localStorage.getItem('ad_token');
  if (!t) return { path: '/login', query: { redirect: to.fullPath } };
  return true;
});
```

### Components

**`InitWizardView.vue`** — top-level shell:
- Stepper at top (1. Connection / 2. Admin / 3. Initialize)
- Renders the current step component from the store
- Two-way data flow via Pinia store (no props/events spaghetti)

**`DbConnStep.vue`** (Screen 1):
- Dialect picker: two large cards (radio cards), MySQL or SQL Server
- Conditional form fields based on dialect:
  - **MySQL**: `host` (text, default `127.0.0.1`), `port` (number, default 3306), `database` (text), `user` (text, default `root`), `password` (password)
  - **SQL Server**: `server` (text, supports `host\instance` or `host,port`), `port` (number, default 1433), `database` (text), `user` (text, default `sa`), `password` (password), `encrypt` (checkbox, default false), `trust server cert` (checkbox)
- "测试连接" button → `POST /api/init/db/test`. Spinner during, error banner on fail with hint.
- "下一步" button enabled only after a successful test

**`AdminStep.vue`** (Screen 2):
- Username input (default `admin`, editable, ≥3 chars)
- Password input (≥8 chars, with strength indicator: weak/medium/strong)
- Confirm password (must match)
- "上一步" + "下一步" buttons
- Client-side validation only at this step; server-side check on `/admin/create`

**`InitStep.vue`** (Screen 3):
- On mount, runs the full initialization sequence:
  1. `POST /api/init/db/apply` (with connParams from store)
  2. `POST /api/init/admin/create` (with admin from store)
  3. `POST /api/init/finalize` (with everything)
- Progress UI: vertical list of stages, each with status icon (○ pending, ◌ in-progress, ✓ done, ✗ failed)
- On failure: shows error message + "重试" button (restarts from failed stage)
- On success: shows success screen + "前往登录" button → `/login`

### State: `frontend/src/stores/init.js` (Pinia)

State:
- `currentStep` (1|2|3)
- `dialect` ('mysql'|'mssql'|null)
- `connParams` ({host|server, port, database, user, password, encrypt?})
- `admin` ({username, password})
- `initStatus` ({needsInit, dialect?})
- `dbTestResult` ({ok, error?})

Actions: `loadStatus`, `setDialect`, `setConnParams`, `setAdmin`, `testDb`, `next`, `prev`, `reset`.

### API: `frontend/src/api/init.js`

Wraps the 5 init endpoints using the existing axios client.

## PS installer slim-down

`scripts/install-center.ps1`:
- **Keep**: verify SQL client on PATH (informational only now, since wizard uses Node drivers), create directories, verify Node, build frontend if dist missing, copy center files, npm install --omit=dev if needed, NSSM service registration, start service, probe health.
- **Remove**: apply schema, apply seed, set agent token in DB, create admin user, write appsettings.json.
- **Reduce params**: remove `-DbDialect`, `-DbHost`, `-DbPort`, `-DbDatabase`, `-DbUser`, `-DbPassword`. Keep `-InstallPath`, `-ListenPort`, `-AgentToken` (optional, generated if missing), `-JwtSecret` (optional, generated if missing).
- **Update help text + comments** to reference the wizard.

## Testing strategy

### Backend (center) — new test files

**Unit (mock-based):**
- `center/tests/init/router.test.js` — 5 routes, mocked facade + fs + bcrypt. Verifies route paths, status codes, guard middleware returns 404 when needsInit=false.
- `center/tests/init/schema-applier.test.js` — feeds fixture SQL files (with `IF NOT EXISTS` blocks, semicolons in strings, multi-line IF/END) through the splitter. Asserts statement count + content. ~6 tests.
- `center/tests/init/admin-creator.test.js` — mocks facade, asserts SQL shape + bcrypt call + 409 on pre-check fail. ~3 tests.
- `center/tests/init/config-writer.test.js` — writes to temp file, reads back, asserts JSON shape. ~3 tests.
- `center/tests/init/server-needs-init.test.js` — unit-tests the `checkNeedsInit(db)` helper: returns `true` when facade null, when query throws, when `sys_users` empty; returns `false` when count > 0. ~4 tests.

**Integration (env-gated, matches T17-T21 pattern):**
- `center/tests/integration/init.integration.test.js` — end-to-end against real mysql:
  1. Drop sys_users (clean slate)
  2. `POST /api/init/db/test` with test conn params → `{ok: true}`
  3. `POST /api/init/db/apply` → schema + seed + migrations applied; verify tables exist, seed rows present
  4. `POST /api/init/admin/create` → admin inserted
  5. `POST /api/init/finalize` → appsettings.json written
  6. `GET /api/init/status` → `{needsInit: false}`
  7. `POST /api/init/db/test` → 404 (guard active)
  8. Cleanup: drop tables, restore state

### Frontend (vitest + @vue/test-utils) — new test files

- `frontend/tests/init/wizard.test.js` — mounts `InitWizardView` with `vi.mock('axios')`. Tests:
  - renders step 1 by default
  - dialect picker updates store
  - "test connection" disabled until dialect picked, enabled after, disabled with error after fail
  - "下一步" advances to step 2
  - password mismatch → "下一步" stays disabled
  - mock `/api/init/db/apply` + `/admin/create` + `/finalize` all returning ok → progress shows all ✓ → success screen
- `frontend/tests/init/guard.test.js` — verifies router redirect:
  - when `/api/init/status` returns `needsInit: true`, navigating to `/` redirects to `/init`
  - when `/api/init/status` returns `needsInit: false`, navigating to `/init` redirects to `/login`

### Manual smoke (documented in runbook)

- Deploy via slimmed PS installer
- Restart service
- Open browser to `http://server:8080/init`
- Complete all 3 screens
- Verify login works with new admin credentials
- Verify subsequent restart does NOT show wizard

## Out of scope for v1

- "Re-run wizard" feature after init completes (admin exists → wizard 404 forever)
- DB migration (repointing an existing install to a new DB host) — wizard only handles fresh init
- Multi-admin creation in the wizard (only one initial admin)
- Email / webhook on init complete
- Audit logging of init actions
- Wizard-driven SQL Server `CREATE DATABASE` (operator pre-creates, same constraint as current PS installer)
- Reverse-proxy / TLS configuration in wizard

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| SQL splitter misses edge cases in schema files (string literals, comments, multi-line IF/END) | Unit tests with all real schema files + edge-case fixtures; integration test runs against real DB |
| Boot-time DB ping + `SELECT COUNT(*)` adds latency | One fast query (~5ms); acceptable |
| Concurrent wizard requests from two browsers | `users.count` pre-check in `/admin/create` returns 409; schema files are idempotent (safe to re-apply) |
| Wizard facade leaks connections on bad exits | Try/finally around all init operations; close on finalize + on server shutdown |
| Operator forgets to pre-create SQL Server DB | `/db/test` accepts the conn params; if "database doesn't exist" error from mssql driver, the wizard surfaces it in the error banner with a hint: "请先在 SQL Server 中手动创建空数据库" |

## Commit plan (will become SDD task list)

1. Backend: `loadConfigOrNull` + `checkNeedsInit` + their tests
2. Backend: `db/sql.js` additions (`users.createAdmin`, `users.count`)
3. Backend: `init/db-tester.js` (with wizard facade state) + tests
4. Backend: `init/schema-applier.js` (with SQL splitter) + tests
5. Backend: `init/admin-creator.js` + tests
6. Backend: `init/config-writer.js` + tests
7. Backend: `init/router.js` (5 routes + guard middleware) + tests
8. Backend: `server.js` wiring (mode detection, init router mount, graceful shutdown closes wizard facade)
9. Backend: `tests/integration/init.integration.test.js` (env-gated end-to-end)
10. Frontend: `api/init.js` + `stores/init.js`
11. Frontend: `views/init/{DbConnStep,AdminStep,InitStep}.vue` + tests
12. Frontend: `views/init/InitWizardView.vue` + router `/init` + bootstrap guard
13. PS installer slim-down + tests
14. Runbook + README updates

14 tasks. Estimated test delta: +20-25 backend, +6-8 frontend. Total post-task: center ~115/1/0, frontend ~36-38/0/0.

## Acceptance criteria

1. After fresh deploy (no `appsettings.json`, no `sys_users`), server boots and serves `/init` at `http://server:8080/init`.
2. Wizard's 3 screens walk operator through DB connection, admin creation, and seed init.
3. After wizard completes, `appsettings.json` exists on disk with correct shape; `sys_users` has the new admin; `sys_roles` has the 3 default roles; `system_config` has the 7 default keys.
4. Subsequent server boots serve normal `/login` page; `/init` redirects to `/login`; `/api/init/*` returns 404.
5. All existing functionality (auth, dashboard, agent, admin routes) continues to work post-init.
6. All 14 commit-plan tasks land as atomic commits; each has tests passing.
7. Integration test passes against real mysql (env-gated).
8. PS installer no longer has DB-side params; running it deploys + starts service + opens wizard in browser (no schema/seed/admin/config steps).