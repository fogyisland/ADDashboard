# Center + Frontend Workspace Merge — Design Spec

**Date:** 2026-08-22
**Status:** Design (pending user review)
**Branch:** TBD (implementer to confirm before SDD dispatch)
**Authors:** user + implementer (post-approval)

## 1. Problem

The current repo has **two npm workspaces** (`center` and `frontend`) shipping a single application, which produces **three dist locations** and a copy step that can silently desync:

| Location | Purpose | Tracked? |
|----------|---------|----------|
| `frontend/dist/` | vite build output (gitignored) | no |
| `center/dist/` | Express static-serve root (gitignored), populated by `scripts/start-prod.js:cpSync` | no |
| `publish/system/frontend/dist/` | Shipped bundle artifact (tracked, exception in `.gitignore`) | **yes** |

`scripts/start-prod.js:7-19` does the runtime merge:

```javascript
const frontendDist = resolve(root, 'frontend/dist');
const centerDist   = resolve(root, 'center/dist');
if (!existsSync(resolve(frontendDist, 'index.html'))) {
  await run('npm', ['run', 'build:frontend'], { cwd: root });
}
cpSync(frontendDist, centerDist, { recursive: true });
```

The user-visible cost: a developer running `npm run build:frontend` sees `frontend/dist/` populated but `center/dist/` stays stale until `start-prod.js` runs again — and the shipped `publish/system/frontend/dist/` is whatever was committed last, with no obvious signal that it's behind.

## 2. Goals

- **G1.** Eliminate the cpSync step. Vite outputs directly to the path Express serves.
- **G2.** One npm workspace (`center`) for both backend and frontend code.
- **G3.** One canonical dist location: `center/dist/`.
- **G4.** All deploy scripts (install / upgrade / update) and the publish mirror reference `center/dist/` — no `frontend/dist` paths remain.
- **G5.** Tests stay split (vitest for web, node:test for backend) under `center/`; CI workflow simplified.
- **G6.** WPF tooling (`MainWindow.xaml.cs` + `Common/`, `Converters/`, `Models/`) references no `frontend/dist` paths and continues to build.

## 3. Non-goals

- **N1.** No change to runtime Express startup, port config, or static-serve contract. Express still serves `<repoRoot>/dist/` from `node server.js`; the runtime CWD becomes `center/` so `<repoRoot>/dist/` resolves to `center/dist/`.
- **N2.** No change to the agent workspace (`agent/`) or MSI installer (`installer/`). Agent is shipped via WiX, not the npm workspace; out of scope for this refactor.
- **N3.** No change to appsettings.json location (parked under separate task 2026-08-22 morning note).
- **N4.** No new build orchestration tool (npm workspaces already cover this).

## 4. New Layout

```
repo/
  center/                              ← single workspace (was: center + frontend)
    src/                               (backend, unchanged)
    web/                               ← moved from frontend/
      src/                             (Vue source, unchanged)
      index.html                       (unchanged)
      vite.config.js                   (outDir stays 'dist' — resolves to center/dist/)
      vitest.config.js                 (unchanged)
      tests/                           (moved from frontend/tests/)
    server.js                          (unchanged — Express still serves ../dist/)
    package.json                       (merged deps + new build:web script)
    dist/                              (vite output, gitignored)
    tests/                             (backend tests, unchanged)
    ...                                (everything else unchanged)
  agent/                               (unchanged)
  installer/                           (unchanged)
  publish/
    system/
      center/                          ← merged center + dist (was: center + frontend + frontend/dist)
        server.js
        src/
        web/
        dist/                          ← shipped dist (was: publish/system/frontend/dist/)
        package.json
        ...
      ...
  scripts/                             (install/upgrade/start — paths updated)
```

## 5. Design

### 5.1. Vite output is canonical

`center/web/vite.config.js` already declares `build: { outDir: 'dist', emptyOutDir: true }`. Vite resolves `outDir` relative to `vite.config.js`'s location, so:

- `vite.config.js` at `center/web/vite.config.js`
- `outDir: 'dist'` → `center/web/dist/` ❌ (NOT what we want)

**Change required:** `outDir` becomes `'../dist'` so it lands at `center/dist/`. `emptyOutDir: true` continues to wipe any stale build before regenerating.

```js
// center/web/vite.config.js
export default defineConfig({
  plugins: [vue()],
  server: { /* dev server proxy unchanged */ },
  build: { outDir: '../dist', emptyOutDir: true }
});
```

This is the **only** vite.config.js change. `index.html`, `src/`, `tests/` move with the directory and need no edits.

### 5.2. Single package.json (center)

`center/package.json` (current) is a Node-only manifest (express, mysql2, mssql, jsonwebtoken, pino, …). After merge it adds the web deps and a build script:

```json
{
  "name": "@ad-dashboard/center",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "build:web": "vite build --config web/vite.config.js",
    "test:web": "vitest run --config web/vitest.config.js",
    "test": "node --test tests/*.test.js tests/auth/*.test.js tests/init/*.test.js tests/routes/*.test.js tests/services/*.test.js tests/db/*.test.js tests/sql/*.test.js tests/packages/*.test.js tests/integration/*.test.js tests/e2e/*.test.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "...": "...(existing center deps, unchanged)"
  },
  "devDependencies": {
    "...": "...(existing center devDeps)",
    "vite": "^5.4.10",
    "@vitejs/plugin-vue": "^5.1.4",
    "@vue/test-utils": "^2.4.6",
    "vitest": "^2.1.4",
    "cross-env": "^10.1.0",
    "jsdom": "^25.0.1"
  }
}
```

`scripts.build:web` runs vite against the web config; `scripts.test:web` runs vitest against the web tests. Both run from `center/` (npm workspace cwd). Backend `test` script continues to enumerate `tests/` paths explicitly — web tests are **excluded** by globs so `npm test` stays backend-only and fast.

**Why not add `web/tests/` to `npm test`?** vitest's runtime conflicts with `node --test` (separate globals, separate assertion libs, separate process model). Keeping them under separate `npm run test:web` matches the existing convention of `npm run test:center` / `test:agent` / `test:frontend` at the root.

### 5.3. Root package.json scripts

Root `package.json` works as the orchestrator:

```json
{
  "workspaces": ["center", "agent"],
  "scripts": {
    "test:center":  "npm run test --workspace=center",
    "test:agent":   "npm run test --workspace=agent",
    "test:web":     "npm run test:web --workspace=center",
    "test":         "npm run test:center && npm run test:agent && npm run test:web",
    "build:web":    "npm run build:web --workspace=center",
    "start":        "node scripts/start-prod.js"
  }
}
```

Frontend workspace entry removed. CI workflow `test:frontend` step replaced with `test:web`.

### 5.4. Express runtime contract unchanged

`center/src/app.js:15`:
```javascript
app.use(express.static(config.staticDir, { index: 'index.html', extensions: ['html'] }));
```

`config.staticDir` is set in `center/src/config.js`. **Verify after implementation** that `staticDir` resolves to `<cwd>/dist/` when cwd is `center/` (the NSSM service's CWD). The runtime startup path is `cd $InstallPath && node server.js` (per `scripts/install-center.ps1`), which puts cwd at `InstallPath/` — i.e. `center/` in the merged layout. So `dist/` resolves to `center/dist/` as desired.

This is a **verification item** in the plan, not an assumption: post-merge `start` and `curl /` must return the Vue index.html.

### 5.5. start-prod.js simplified

`scripts/start-prod.js` becomes:

```javascript
import { resolve, existsSync } from 'node:path';
import { run } from './lib/run.js'; // or inline spawn
const root = resolve(import.meta.dirname, '..');
const webDist = resolve(root, 'center/dist');
if (!existsSync(resolve(webDist, 'index.html'))) {
  console.log('[start-prod] center/dist missing — running vite build...');
  await run('npm', ['run', 'build:web', '--workspace=center'], { cwd: root });
}
console.log('[start-prod] center/dist ready');
```

The `cpSync` line is gone. The check ensures we still rebuild on cold start when `center/dist/` is missing.

### 5.6. install / upgrade / update scripts

All three currently reference `frontend\dist`:

- `scripts/install-center.ps1:104,129,140,145-154` — 7 references
- `scripts/upgrade-center.ps1:132,134,141,143,156-166` — 9 references
- `scripts/update-center.ps1` — deprecation header only; lives at `publish/system/scripts/`; same scope

After merge, all path joins become `center\dist`:

```powershell
# was: $shippedDist = Join-Path $projectRoot 'frontend\dist'
$shippedDist = Join-Path $projectRoot 'center\dist'
```

`Push-Location (Join-Path $projectRoot 'frontend')` → `Push-Location (Join-Path $projectRoot 'center\web')` for the `npm install` + `npm run build` calls (install-center.ps1:147-153 has the inline build).

The build invocation name changes from `npm run build:frontend` to `npm run build` (matching the script inside `center/web` … wait, no — there's no `package.json` inside `center/web/`. The script is at `center/package.json`, run from `center/` cwd). So:

```powershell
Push-Location (Join-Path $projectRoot 'center')
try { npm run build:web } finally { Pop-Location }
```

### 5.7. Publish mirror

`publish/system/frontend/` is removed entirely. `publish/system/center/dist/` ships the web build, `publish/system/center/server.js` + `src/` ship the backend.

The mirror script that copies source → `publish/system/center/` (the one that produced the existing `publish/system/center/` tree) updates its filter to skip `frontend/`:

```
exclude:
  - frontend/         # gone
include:
  - center/web/dist/  # shipped (web build output, git-tracked)
```

`verify-mirror.ps1` is updated to assert `publish/system/frontend/` is absent and `publish/system/center/dist/index.html` is present.

### 5.8. .gitignore

Drop these lines:

```
publish/center/dist/
!publish/system/frontend/dist/
publish/frontend/node_modules/
publish/center/node_modules/  # may stay if center/dev dependencies ever go there; current local config puts center node_modules at root
```

Add (or keep, depending on current behavior):

```
center/dist/                   # canonical build output
center/web/node_modules/       # if vite ever writes its own
!publish/system/center/dist/   # shipped dist is tracked
```

### 5.9. Pester tests

`scripts/tests/install-center.Tests.ps1`, `upgrade-center.Tests.ps1`, `update-center.Tests.ps1` (already grepped) all assert `frontend\dist` or `frontend/dist` paths. After merge:

- Update each regex/grep to `center\dist` / `center/dist`
- Add new regression test: `publish/system/frontend/` must NOT exist
- Add new regression test: `publish/system/center/dist/index.html` must exist (the shipped bundle sanity check)
- The existing "shipped-dist check" priority-order test (install-center.Tests.ps1 line 399) gets ported to the new path

The migration rule: every Pester test that grepped `frontend` paths becomes a path-update task in the plan; new tests assert the new layout.

### 5.10. WPF

`MainWindow.xaml.cs`, `Common/`, `Converters/`, `Models/` — initial grep showed no `frontend` references. Re-verify after merge: `dotnet build` of the WPF solution must succeed. If `PackageDesigner.csproj` or similar references any web artifact path, update it.

## 6. Migration plan (high-level, decomposed in plan)

The implementation plan (separate document at `docs/superpowers/plans/2026-08-22-center-merge.md`) will decompose these into SDD tasks. Approximate order:

1. **T1.** Move `frontend/src/`, `frontend/tests/`, `frontend/index.html`, `frontend/vite.config.js`, `frontend/vitest.config.js` → `center/web/`. Update `vite.config.js` `outDir: '../dist'`. Verify `cd center && npx vite build --config web/vite.config.js` produces `center/dist/index.html`.
2. **T2.** Merge `frontend/package.json` deps into `center/package.json`. Drop the frontend workspace entry from root `package.json`. Update root scripts. Verify `npm install` at repo root succeeds; verify `npm run build:web --workspace=center` succeeds.
3. **T3.** Update `scripts/start-prod.js` to drop cpSync. Verify locally: delete `center/dist/`, run `node scripts/start-prod.js`, see `npm run build:web` fire and `center/dist/index.html` appear without any cpSync call.
4. **T4.** Update `scripts/install-center.ps1` path references (7 paths). Verify Pester passes; live-verify on local install via `-InPlace`.
5. **T5.** Update `scripts/upgrade-center.ps1` (9 paths + the npm run name fix that was parked earlier). Mirror sync.
6. **T6.** Update `scripts/update-center.ps1` and any other scripts/ files referencing `frontend/dist`. Mirror sync.
7. **T7.** Update `.gitignore` per §5.8.
8. **T8.** Update `verify-mirror.ps1` and `scripts/verify-mirror.ps1`. Mirror rebuild via `installer/build-publish.ps1` (or equivalent).
9. **T9.** Update Pester tests: install-center.Tests.ps1, upgrade-center.Tests.ps1, update-center.Tests.ps1 path regex; add regression tests for the new layout.
10. **T10.** Update CI workflow `.github/workflows/ci.yml`: rename `Frontend tests` step to `Web tests` and run `npm run test:web`; rename `Frontend build` step to `Web build (sanity)` and run `npm run build:web`.
11. **T11.** WPF: re-grep for any missed references; `dotnet build` of WPF solution; mirror WPF package if applicable.
12. **T12.** Whole-branch review + commit + push.

Approximate diff size: 14 files modified (per impact table in the conversation), 1 directory moved (`frontend/` → `center/web/`), 1 directory deleted (`frontend/`), 4 mirror-touch points.

## 7. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **R1.** `outDir: '../dist'` resolves differently in vitest than vite build (vitest has its own cwd handling). | Confirm `vitest.config.js` doesn't reference `outDir`; vitest's `resolve.alias` is independent. Verify by running `npm run test:web` post-merge. |
| **R2.** `npm run build:web --workspace=center` runs from repo root, but vite resolves `outDir` relative to `vite.config.js` — should land at `center/dist/`. Verify the directory after one build. |
| **R3.** Pester test grep regexes for `frontend` paths may catch unintended matches (e.g. `frontend-dist` as a substring). | `update-center.Tests.ps1` already has a `WebWeb` lesson-61-style guard; mirror the negative-assertion style for `frontend` as a whole-word check. |
| **R4.** Existing installs have `publish/system/frontend/dist/` from previous bundle. After merge this path is gone — first-time update will throw if the script expects it. | The shipped-dist branch in upgrade-center.ps1 checks `Test-Path (Join-Path $shippedDist 'index.html')`. After merge `$shippedDist` = `center/dist` and that's where the bundle ships. No first-run regression. |
| **R5.** A user runs `cd frontend && npm run build` (old mental model) and gets an error because `frontend/` is gone. | Update README + CONTRIBUTING (out-of-scope for this spec; flagged as drive-by). |
| **R6.** WPF smoke tests were deferred (Task #272 blocked on VM access). Post-merge WPF might reference paths that have changed. | T11 re-greps and re-builds. If a hidden path slips through, VM smoke catches it. |

## 8. Out of scope (parked)

- Agent workspace merge (agent ships via MSI WiX, different mechanism)
- appsettings.json location change (separate task)
- Dist compression or fingerprint (separate optimization)
- README + CONTRIBUTING update (drive-by)
- Removing the legacy deprecation header on `update-center.ps1` (deprecation still applies; merge doesn't make the script redundant — it remains the operator-facing low-level entry parallel to `upgrade-center.ps1`)

## 9. Verification

After T12 completes:

```bash
# Unit tests
Invoke-Pester ./scripts/tests,./scripts/common/tests -Output Detailed
npm run test                            # backend + agent
npm run test:web                        # vitest

# Build sanity
npm run build:web --workspace=center    # → center/dist/index.html
node scripts/start-prod.js              # no cpSync, no error

# Mirror parity
pwsh -NoProfile -File scripts/verify-mirror.ps1   # 0 drift, no missing, no orphan

# Live (post-merge)
cd center && node server.js &  # boot, curl http://localhost:8080/, expect Vue index.html
```

Expected: full green; `verify-mirror` shows `publish/system/frontend/` as absent (regression test guards); `center/dist/` contains 1 index.html + assets/.

## 10. SDD execution mode

Per user preference: **subagent-driven-development**. Plan (separate doc) decomposes §6 into discrete tasks, each with a fresh implementer subagent + task review + final whole-branch review.
