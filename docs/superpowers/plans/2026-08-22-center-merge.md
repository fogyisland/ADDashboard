# Center + Frontend Workspace Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 3-dist-location + cpSync mess by merging the frontend workspace into `center/web/` and letting vite output directly to `center/dist/`.

**Architecture:** Single npm workspace (`center`) for backend + frontend. Vite config `outDir: '../dist'` makes `vite build` write to `center/dist/` (the path Express serves). Scripts/installers reference only `center/dist` (single canonical location). Publish mirror drops `publish/system/frontend/`, gains `publish/system/center/dist/`.

**Tech Stack:** Node.js (Express backend, ESM), Vue 3 + Vite 5 (frontend), npm workspaces, PowerShell 5.1 (install/upgrade scripts), Pester 5 (PowerShell tests), WiX 5 (MSI — out of scope).

**Spec:** `docs/superpowers/specs/2026-08-22-center-merge-design.md` (commit `d2fe308`)

## Global Constraints

- **Single canonical dist**: `center/dist/`. No `frontend/dist/`, no `publish/system/frontend/dist/`, no copy step.
- **Express runtime contract unchanged**: `center/src/app.js:15` still does `app.use(express.static(config.staticDir, …))`. `config.staticDir` must resolve to `<InstallPath>/dist/` after merge.
- **Test isolation**: `npm run test` (backend `node --test`) stays backend-only; `npm run test:web` (vitest) is separate. They MUST NOT pollute each other's process.
- **Mirror parity**: `publish/system/center/` mirrors `center/` (excluding `node_modules/`, `dist/`, `tests/`, `appsettings.json`). After merge: `publish/system/center/dist/index.html` is tracked; `publish/system/frontend/` is removed.
- **PowerShell 5.1**: scripts must run on Windows PowerShell 5.1 (not pwsh 7+). No `[ordered]@{}` quirks, no `3-arg Join-Path`. See memory `feedback_powershell_51.md`.
- **Mirror parity byte-identical**: any `scripts/<file>.ps1` referenced by `publish/system/scripts/<file>.ps1` must be byte-identical, verified by `diff -q` (or Pester regression test). Mirror lag = silent prod breakage.
- **Pester regression tests assert behavior, not implementation details**: avoid asserting exact string literals that could break on cosmetic refactors. The lesson-61 guard pattern (`Should -Not -Match 'WebWeb'`) is the model.
- **No behavior change for existing install**: first-time upgrade on an existing install must not break. The shipped-dist branch in `upgrade-center.ps1` reads `Test-Path center/dist/index.html`; after merge this is the new shipped location.
- **WPF compatibility**: `MainWindow.xaml.cs`, `Common/`, `Converters/`, `Models/`, and any WPF csproj must not reference `frontend/dist` paths after merge.

---

## Task 1: Move frontend/ → center/web/ + update vite.config outDir

**Files:**
- Modify: `frontend/vite.config.js` → `center/web/vite.config.js` (via move + outDir change)
- Move: `frontend/src/` → `center/web/src/`
- Move: `frontend/index.html` → `center/web/index.html`
- Move: `frontend/tests/` → `center/web/tests/`
- Move: `frontend/vitest.config.js` → `center/web/vitest.config.js`
- Delete: `frontend/` (after move complete)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `center/web/vite.config.js` with `outDir: '../dist'`; `center/web/src/`, `center/web/tests/`, `center/web/index.html`, `center/web/vitest.config.js` all present at the new paths.

- [ ] **Step 1: Confirm baseline**

```bash
ls frontend/  # expect: dist, index.html, node_modules, package.json, src, tests, vite.config.js, vitest.config.js
```

- [ ] **Step 2: Create center/web/ directory and move source/test files**

```bash
mkdir -p center/web
mv frontend/src      center/web/src
mv frontend/index.html center/web/index.html
mv frontend/tests    center/web/tests
mv frontend/vitest.config.js center/web/vitest.config.js
```

- [ ] **Step 3: Move and edit vite.config.js**

```bash
mv frontend/vite.config.js center/web/vite.config.js
```

Then edit `center/web/vite.config.js`:

```js
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/healthz': { target: 'http://localhost:8080', changeOrigin: true }
    }
  },
  build: { outDir: '../dist', emptyOutDir: true }
});
```

The only change vs the current `frontend/vite.config.js` is `outDir: 'dist'` → `outDir: '../dist'`.

- [ ] **Step 4: Delete the now-empty frontend/ directory**

```bash
ls frontend/  # expect: only node_modules, package.json, package-lock.json, dist
rm -rf frontend/node_modules frontend/dist frontend/package.json frontend/package-lock.json
rmdir frontend  # should now be empty
```

> **Note:** `frontend/package.json` and `frontend/package-lock.json` will be deleted here, but the deps in `frontend/package.json` get re-added to `center/package.json` in Task 2. Do NOT add the deps yet — that's Task 2's job. Keep this task focused on file moves.

- [ ] **Step 5: Verify vite build produces center/dist/index.html**

```bash
cd center && npx vite build --config web/vite.config.js
ls -la dist/  # expect: index.html + assets/ directory
cat dist/index.html | head -5  # expect: <!doctype html>...
cd ..
```

Expected: `center/dist/index.html` is created. If `outDir: '../dist'` resolves to `center/web/dist` instead, double-check the vite.config.js edit.

- [ ] **Step 6: Verify the existing frontend test suite still runs from the new location**

```bash
cd center/web && npx vitest run --config vitest.config.js
cd ../..
```

Expected: same number of tests pass as before the move (currently 240 from the local build). Vitest's own cwd handling shouldn't care about the directory containing `vite.config.js`; if a test does, fix it before commit.

- [ ] **Step 7: Commit**

```bash
git add -A
git status --short  # expect: frontend/ gone, center/web/ added
git commit -m "refactor(center): move frontend/ files into center/web/

T1 of center+frontend workspace merge. Moves src/, tests/, index.html,
vitest.config.js, vite.config.js into center/web/. Vite outDir changes
from 'dist' (which would land at center/web/dist/) to '../dist' (lands
at center/dist/, the canonical build output).

Drops frontend/{package.json,package-lock.json,node_modules,dist} — Task 2
re-adds the deps to center/package.json. Frontend workspace entry drops
from root package.json in Task 2.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.1

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Merge frontend deps into center/package.json + retarget root scripts

**Files:**
- Modify: `center/package.json` (add vue + vite + dev deps; add `build:web` and `test:web` scripts)
- Modify: `package.json` (root) — drop `frontend` from `workspaces`, rename `test:frontend` → `test:web`, rename `build:frontend` → `build:web`, retarget to `center` workspace.

**Interfaces:**
- Consumes: T1's `center/web/` (already moved); `frontend/package.json` (already deleted, but its dep list is known — see Step 1).
- Produces: `center/package.json` with a `build:web` script; root `package.json` without a `frontend` workspace.

- [ ] **Step 1: Read frontend/package.json (it should still exist in git history if needed)**

```bash
git show HEAD~1:frontend/package.json  # before T1 commit, the file existed
```

If T1 already committed and the file is gone from working tree, use this command to inspect its prior content. Save the dep list — you'll merge it into `center/package.json`.

- [ ] **Step 2: Edit center/package.json**

Add these dependencies to the existing `center/package.json` (merge, don't replace):

```json
{
  "dependencies": {
    "axios": "^1.7.7",
    "echarts": "^6.1.0",
    "papaparse": "^5.5.4",
    "pinia": "^2.2.4",
    "vue": "^3.5.12",
    "vue-router": "^4.4.5",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.1.4",
    "@vue/test-utils": "^2.4.6",
    "cross-env": "^10.1.0",
    "jsdom": "^25.0.1",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

Add these scripts to `center/package.json`:

```json
{
  "scripts": {
    "start": "node server.js",
    "build:web": "vite build --config web/vite.config.js",
    "test:web": "vitest run --config web/vitest.config.js",
    "test": "node --test tests/*.test.js tests/auth/*.test.js tests/init/*.test.js tests/routes/*.test.js tests/services/*.test.js tests/db/*.test.js tests/sql/*.test.js tests/packages/*.test.js tests/integration/*.test.js tests/e2e/*.test.js"
  }
}
```

> **Why web tests are NOT in the backend `test` script:** `node --test` matches only the explicit globs. `center/web/tests/*.test.js` does NOT match the listed globs (`tests/*.test.js`, `tests/auth/*.test.js`, …), so vitest tests stay isolated from the backend test runner.

- [ ] **Step 3: Edit root package.json**

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

Removed: `"test:frontend"` and `"build:frontend"` scripts; `"frontend"` workspace entry.

- [ ] **Step 4: Reinstall and verify npm workspace resolves**

```bash
rm -rf node_modules center/node_modules agent/node_modules  # fresh
rm package-lock.json center/package-lock.json agent/package-lock.json  # fresh
npm install
ls node_modules/@ad-dashboard/  # expect: center, agent (NOT frontend)
ls node_modules/vue  # expect: vue exists (hoisted to root)
ls center/dist/  # may or may not exist; build it next
```

- [ ] **Step 5: Verify build:web works through root npm script**

```bash
rm -rf center/dist
npm run build:web
ls center/dist/index.html  # expect: file exists
```

- [ ] **Step 6: Verify all three test suites pass**

```bash
npm run test:center   # expect: backend tests green (~998 + 64 skipped = current count)
npm run test:agent    # expect: agent tests green
npm run test:web      # expect: vitest passes (~240 from current frontend count)
```

If `npm install` produced a different lockfile than the committed `package-lock.json`, that's expected (frontend deps were merged). Commit the new lockfile alongside `center/package.json`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json center/package.json center/package-lock.json
git commit -m "refactor(root): merge frontend workspace into center/

T2 of center+frontend workspace merge. Drops 'frontend' workspace entry,
retargets build:web/test:web to run from center/ workspace via
--workspace=center flag.

Adds vue + vite + web deps to center/package.json dependencies. Adds
build:web and test:web scripts to center/ that invoke vite and vitest
against the merged center/web/ subdirectory.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.2

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Simplify scripts/start-prod.js (drop cpSync)

**Files:**
- Modify: `scripts/start-prod.js`

**Interfaces:**
- Consumes: T2's `npm run build:web --workspace=center` (already wired).
- Produces: `scripts/start-prod.js` with no `cpSync` call.

- [ ] **Step 1: Read current scripts/start-prod.js**

```bash
cat scripts/start-prod.js
```

The current file has a `cpSync(frontendDist, centerDist, ...)` call that is **not imported** anywhere in the file — the only `node:fs` import is `existsSync`. This is a pre-existing silent crash (the file would throw `ReferenceError: cpSync is not defined` if `frontend/dist/index.html` was present, which it usually is). T3 fixes it by replacing the whole body.

- [ ] **Step 2: Rewrite scripts/start-prod.js**

```javascript
// start-prod: build the web bundle (vite) on cold start, then start the
// Express server from center/. center/dist/ is the single canonical output
// location — vite outputs there directly via outDir='../dist' in
// center/web/vite.config.js. No copy step.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const centerDist = resolve(root, 'center/dist');

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    p.on('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`${cmd} exited ${code}`)));
    p.on('error', rejectRun);
  });
}

if (!existsSync(resolve(centerDist, 'index.html'))) {
  console.log('[start-prod] center/dist missing — running build:web...');
  await run('npm', ['run', 'build:web', '--workspace=center'], { cwd: root });
}

console.log('[start-prod] starting center server');
await run('npm', ['start', '--workspace=center'], { cwd: root });
```

> **Note:** This rewrite drops the `cpSync(frontendDist, centerDist, { recursive: true })` line entirely. That line was a pre-existing latent bug — `cpSync` was never imported in the file, so on any cold start the script would have thrown `ReferenceError: cpSync is not defined` if the cpSync line ever executed (in practice it didn't because `frontend/dist/index.html` was always present, masking the bug). The merge surfaces the bug and the rewrite fixes it.

- [ ] **Step 3: Verify on a fresh build**

```bash
rm -rf center/dist
node scripts/start-prod.js &  # background it
SERVER_PID=$!
sleep 8  # allow cold start + first boot
curl -fsS http://localhost:8080/ | head -5  # expect: Vue index.html served
kill $SERVER_PID
sleep 2
ls center/dist/index.html  # expect: file exists (proves cpSync was NOT needed)
```

If the curl returns the Vue index.html and `center/dist/index.html` exists, the cpSync removal is correct.

- [ ] **Step 4: Commit**

```bash
git add scripts/start-prod.js
git commit -m "refactor(scripts): drop cpSync from start-prod.js

T3 of center+frontend workspace merge. Vite outputs directly to
center/dist/ via outDir='../dist' in center/web/vite.config.js, so the
frontend/dist → center/dist copy step is no longer needed.

build:web invocation now uses --workspace=center to run from the merged
workspace. After build, spawns 'npm start --workspace=center' which
runs center/server.js. The single canonical dist location is center/dist/.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.5

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Update scripts/install-center.ps1 paths + npm script names

**Files:**
- Modify: `scripts/install-center.ps1` (7 path references)
- Modify: `publish/system/scripts/install-center.ps1` (mirror sync)

**Interfaces:**
- Consumes: T2's `npm run build:web --workspace=center` is available from repo root.
- Produces: install-center.ps1 references `center\dist` exclusively; mirror is byte-identical.

- [ ] **Step 1: Read current install-center.ps1 sections that reference frontend**

```bash
grep -n "frontend" scripts/install-center.ps1
```

- [ ] **Step 2: Edit each frontend reference**

The 9 sites (line numbers from current file):

| Line | Current | After |
|------|---------|-------|
| 104 | `$distPath = Join-Path $projectRoot 'frontend\dist'` | `$distPath = Join-Path $projectRoot 'center\dist'` |
| 108-109 (comment) | references to `npm run build:frontend` | references to `npm run build:web --workspace=center` |
| 116 | `npm run build:frontend` | `npm run build:web --workspace=center` |
| 129 | `$shippedDist = Join-Path $projectRoot 'frontend\dist'` | `$shippedDist = Join-Path $projectRoot 'center\dist'` |
| 140 (comment) | `(in-place)` references | `(in-place)` references (kept) |
| 145-146 | `(Join-Path $projectRoot 'frontend\node_modules')` | `(Join-Path $projectRoot 'center\web\node_modules')` |
| 147 | `Push-Location (Join-Path $projectRoot 'frontend')` | `Push-Location (Join-Path $projectRoot 'center')` (we run from center/, vite config is at center/web/vite.config.js) |
| 150 | `Push-Location (Join-Path $projectRoot 'frontend')` | `Push-Location (Join-Path $projectRoot 'center')` |
| 154 | `(Join-Path $projectRoot 'frontend\dist\*')` | `(Join-Path $projectRoot 'center\dist\*')` |

The `npm run build` invocation at line 116 needs to become `npm run build:web --workspace=center` (running from repo root, not from inside a workspace dir).

- [ ] **Step 3: Verify no remaining frontend references**

```bash
grep -n "frontend" scripts/install-center.ps1  # expect: empty output
```

If anything remains, that's a missed reference — fix it before commit.

- [ ] **Step 4: Mirror sync**

```bash
diff -q scripts/install-center.ps1 publish/system/scripts/install-center.ps1
# expect: Files differ (we just edited the source)
cp scripts/install-center.ps1 publish/system/scripts/install-center.ps1
diff -q scripts/install-center.ps1 publish/system/scripts/install-center.ps1
# expect: (no output = identical)
```

- [ ] **Step 5: Run Pester tests**

```bash
Invoke-Pester ./scripts/tests/install-center.Tests.ps1 -Output Detailed
```

Expected: 0 failures. Some tests will need updating (T9 handles regex updates); for now, if a test fails because it asserts a `frontend/dist` regex and we changed the path, **note the test name and continue** — T9 will fix it. If a test fails for an unrelated reason, investigate before commit.

- [ ] **Step 6: Live verify with -InPlace (only if previous install is present)**

```bash
# Only run if you have an existing install at $InstallPath
pwsh -NoProfile -File scripts/install-center.ps1 -InPlace -AdminPassword '<your-password>'
```

Skip this step if no existing install. The Pester test is the canonical gate.

- [ ] **Step 7: Commit**

```bash
git add scripts/install-center.ps1 publish/system/scripts/install-center.ps1
git commit -m "refactor(scripts): update install-center.ps1 paths to center\dist

T4 of center+frontend workspace merge. Seven path references updated:
- shipped dist path: frontend\dist → center\dist
- npm install location: frontend\ → center\ (we run from merged workspace)
- npm script name: build:frontend → build:web --workspace=center

Mirror byte-identical sync.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.6

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Update scripts/upgrade-center.ps1 paths + npm script names

**Files:**
- Modify: `scripts/upgrade-center.ps1` (9 path references + npm script name)
- Modify: `publish/system/scripts/upgrade-center.ps1` (mirror sync)

**Interfaces:**
- Consumes: T2's npm script retarget; T4's pattern for `center\dist` paths.
- Produces: upgrade-center.ps1 references `center\dist`; this is the **install-time user-facing** entry (parallel to `update.ps1`).
- **Side benefit:** also fixes the `npm run build:frontend` Missing script bug surfaced in the earlier debugging session.

- [ ] **Step 1: Read current upgrade-center.ps1 sections that reference frontend**

```bash
grep -n "frontend\|build:frontend" scripts/upgrade-center.ps1
```

- [ ] **Step 2: Edit each frontend reference**

The 9 sites (line numbers from current file):

| Line | Current | After |
|------|---------|-------|
| 12-15 (header comment) | mentions `-RebuildFrontend` + `npm run build:frontend` semantics | header kept, but mention `npm run build:web --workspace=center` |
| 123-130 (priority comment) | same — `npm run build:frontend` | `npm run build:web --workspace=center` |
| 132 | `$shippedDist = Join-Path $projectRoot 'frontend\dist'` | `$shippedDist = Join-Path $projectRoot 'center\dist'` |
| 134 | `Write-Step "rebuilding frontend (npm run build:frontend)"` | `Write-Step "rebuilding frontend (npm run build:web --workspace=center)"` |
| 135 | `Push-Location (Join-Path $projectRoot 'frontend')` | `Push-Location $projectRoot` (run from repo root, `--workspace=center` targets the right place) |
| 137-139 (`node_modules` check) | `'node_modules'` and `npm install` paths | unchanged (the local-dist path is center/web/node_modules; adjust if needed) |
| 141 | `npm run build:frontend` | `npm run build:web --workspace=center` |
| 143 | `$localDist = Join-Path $projectRoot 'frontend\dist'` | `$localDist = Join-Path $projectRoot 'center\dist'` |
| 145 | `(Join-Path $localDist 'index.html')` | unchanged (path math still works) |
| 156-166 (fallback build branch) | `'frontend\dist'`, `'frontend\node_modules'`, `Push-Location (Join-Path $projectRoot 'frontend')`, `npm run build`, `'frontend\dist\*'` | `'center\dist'`, `'center\web\node_modules'`, `Push-Location $projectRoot`, `npm run build:web --workspace=center`, `'center\dist\*'` |

The **`npm run build:frontend` Missing script bug** from the prior conversation is fixed by changing line 141 to `npm run build:web --workspace=center`.

- [ ] **Step 3: Verify no remaining frontend references**

```bash
grep -n "frontend\|build:frontend" scripts/upgrade-center.ps1  # expect: empty output
```

- [ ] **Step 4: Mirror sync**

```bash
diff -q scripts/upgrade-center.ps1 publish/system/scripts/upgrade-center.ps1
# expect: Files differ
cp scripts/upgrade-center.ps1 publish/system/scripts/upgrade-center.ps1
diff -q scripts/upgrade-center.ps1 publish/system/scripts/upgrade-center.ps1
# expect: (no output)
```

- [ ] **Step 5: Update the Pester test that asserts `npm run build:frontend`**

In `scripts/tests/upgrade-center.Tests.ps1`, the test at line 89-92:

```powershell
It 'runs npm run build:frontend when -RebuildFrontend is set' {
  $script:srcContent | Should -Match 'npm run build:frontend' `
    'upgrade-center.ps1 must invoke npm run build:frontend in the RebuildFrontend branch.'
}
```

Change to assert the new script name:

```powershell
It 'runs npm run build:web --workspace=center when -RebuildFrontend is set' {
  $script:srcContent | Should -Match 'npm run build:web\s+--workspace=center' `
    'upgrade-center.ps1 must invoke npm run build:web --workspace=center in the RebuildFrontend branch (frontend workspace merged into center/).'
}
```

- [ ] **Step 6: Run Pester tests**

```bash
Invoke-Pester ./scripts/tests/upgrade-center.Tests.ps1 -Output Detailed
```

Expected: 31 tests pass (or current count + any new ones added in T9 — handle that task's edits first if they were already drafted).

- [ ] **Step 7: Commit**

```bash
git add scripts/upgrade-center.ps1 publish/system/scripts/upgrade-center.ps1 scripts/tests/upgrade-center.Tests.ps1
git commit -m "refactor(scripts): update upgrade-center.ps1 paths to center\dist

T5 of center+frontend workspace merge. Nine path references updated,
plus the npm script name change (build:frontend → build:web --workspace=center).

Side benefit: fixes the 'Missing script: build:frontend' bug surfaced
during the earlier debugging session — the script name was wrong
because there is no 'build:frontend' script in the merged workspace.

Pester regression test updated to assert the new script name.

Mirror byte-identical sync.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.6

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Update scripts/update-center.ps1 paths (deprecated, but mirror)

**Files:**
- Modify: `scripts/update-center.ps1`
- Modify: `publish/system/scripts/update-center.ps1` (mirror sync)

**Interfaces:**
- Consumes: T4/T5 patterns.
- Produces: a deprecation header update mentioning the merge + new path references.

- [ ] **Step 1: Read current update-center.ps1**

```bash
grep -n "frontend\|build:frontend" scripts/update-center.ps1
```

- [ ] **Step 2: Apply the same path retarget pattern as T4/T5**

If `update-center.ps1` has `frontend\dist` references, change them to `center\dist`. If it has `npm run build:frontend`, change to `npm run build:web --workspace=center`.

If the script's entire purpose has been superseded by `publish/system/update.ps1` (the post-install unified entry from commit 3fdbebd), consider whether the edits are even necessary. **For this task: keep the script functional.** The deprecation header already points operators to `publish/system/update.ps1`.

- [ ] **Step 3: Mirror sync**

```bash
diff -q scripts/update-center.ps1 publish/system/scripts/update-center.ps1
cp scripts/update-center.ps1 publish/system/scripts/update-center.ps1
diff -q scripts/update-center.ps1 publish/system/scripts/update-center.ps1  # expect: identical
```

- [ ] **Step 4: Run Pester tests**

```bash
Invoke-Pester ./scripts/tests/update-center.Tests.ps1 -Output Detailed
```

- [ ] **Step 5: Commit**

```bash
git add scripts/update-center.ps1 publish/system/scripts/update-center.ps1
git commit -m "refactor(scripts): update update-center.ps1 paths to center\dist

T6 of center+frontend workspace merge. Mirror byte-identical sync.

update-center.ps1 is deprecated in favor of publish/system/update.ps1
(commit 3fdbebd) but kept functional for operator parity.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.6

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Update .gitignore

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: T1's deleted `frontend/` (no longer a tracked directory).
- Produces: `.gitignore` that ignores `center/dist/` (build output) but tracks `publish/system/center/dist/` (shipped bundle).

- [ ] **Step 1: Read current .gitignore**

```bash
grep -n "frontend\|center/dist\|publish/system/frontend" .gitignore
```

Current relevant lines:

```
dist/
...
publish/center/node_modules/
publish/agent/node_modules/
publish/frontend/node_modules/
publish/center/dist/
!publish/system/frontend/dist/
```

- [ ] **Step 2: Edit .gitignore**

Remove these lines:

```
publish/frontend/node_modules/
publish/center/dist/
!publish/system/frontend/dist/
```

Add these lines (in the publish section, replacing the ones removed):

```
publish/center/node_modules/
!publish/system/center/dist/    # shipped web bundle — tracked
```

Keep `dist/` (top-level, matches anything called dist/, including center/dist).

- [ ] **Step 3: Verify ignore pattern correctness**

```bash
git check-ignore -v center/dist/index.html  # expect: matches dist/ pattern, ignored
git check-ignore -v publish/system/center/dist/index.html  # expect: NOT ignored (the ! exception)
git check-ignore -v frontend/dist/index.html  # expect: error (frontend doesn't exist — perfect)
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): drop frontend/ paths, track publish/system/center/dist/

T7 of center+frontend workspace merge. Removes publish/frontend/* and
publish/system/frontend/dist/ references (frontend/ no longer exists).
Adds the new !publish/system/center/dist/ exception so the shipped web
bundle stays tracked.

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.8

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Update verify-mirror.ps1 + rebuild publish mirror

**Files:**
- Modify: `scripts/verify-mirror.ps1` (drop frontend checks, add center/dist check)
- Modify: mirror tree under `publish/system/center/` (rebuild via build-publish.ps1 or manual sync)
- Delete: `publish/system/frontend/` (no longer shipped)

**Interfaces:**
- Consumes: T1-T7's output (the merged layout).
- Produces: a green `verify-mirror.ps1` run; `publish/system/center/dist/index.html` exists; `publish/system/frontend/` is absent.

- [ ] **Step 1: Read current verify-mirror.ps1**

```bash
grep -n "frontend" scripts/verify-mirror.ps1
```

- [ ] **Step 2: Update verify-mirror.ps1 path expectations**

Replace any `publish/system/frontend/` checks with `publish/system/center/dist/` checks. Specifically:

- If the script asserts `publish/system/frontend/dist/index.html` exists → assert `publish/system/center/dist/index.html` exists instead.
- If the script asserts `publish/system/frontend/` is present → assert `publish/system/frontend/` is ABSENT (regression test guarding against accidental resurrection).

- [ ] **Step 3: Rebuild the publish mirror**

Check if there's a `scripts/build-publish.ps1` or similar:

```bash
ls scripts/build*.ps1 2>/dev/null
ls scripts/publish*.ps1 2>/dev/null
```

If a build-publish script exists, run it. Otherwise, the mirror copy is a manual `cp -r center/ publish/system/center/` (with exclude filters per `mirror` config).

- [ ] **Step 4: Remove publish/system/frontend/ from the mirror**

```bash
rm -rf publish/system/frontend
ls publish/system/  # expect: no 'frontend' directory
```

- [ ] **Step 5: Verify mirror is correct**

```bash
pwsh -NoProfile -File scripts/verify-mirror.ps1
```

Expected: 0 drift, 0 missing, 0 orphan. If the script asserts `publish/system/center/dist/index.html` exists and that's the case after the rebuild, pass.

- [ ] **Step 6: Commit**

```bash
git add -A  # verify-mirror changes + mirror tree changes
git status --short  # expect: publish/system/frontend/ deleted, publish/system/center/dist/ tracked
git commit -m "chore(publish): rebuild mirror with merged center/dist

T8 of center+frontend workspace merge. Drops publish/system/frontend/
(no longer shipped). Builds publish/system/center/dist/index.html
through vite and commits it as the new shipped web bundle.

verify-mirror.ps1 updated to assert the new layout and to guard against
publish/system/frontend/ resurrection (regression test).

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.7

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Update Pester tests + add regression tests for the new layout

**Files:**
- Modify: `scripts/tests/install-center.Tests.ps1` (regex updates)
- Modify: `scripts/tests/upgrade-center.Tests.ps1` (regex updates; the build:frontend regex already fixed in T5)
- Modify: `scripts/tests/update-center.Tests.ps1` (regex updates)
- Modify: `scripts/tests/verify-mirror.Tests.ps1` if exists (new layout assertions)

**Interfaces:**
- Consumes: T1-T8's output.
- Produces: All Pester tests pass on the merged layout. New regression tests assert:
  1. `publish/system/frontend/` must NOT exist.
  2. `publish/system/center/dist/index.html` MUST exist.
  3. `frontend/` must NOT exist (catches accidental restoration).
  4. `center/web/vite.config.js` MUST contain `outDir: '../dist'`.

- [ ] **Step 1: Find every `frontend` reference in Pester tests**

```bash
grep -rn "frontend" scripts/tests/
```

- [ ] **Step 2: Categorize each match**

For each match, decide:
- **Path assertion** (e.g. `Should -Match 'frontend\\dist'`) → update to `center\\dist`.
- **Behavior assertion** that no longer makes sense → remove or rewrite.
- **Negative guard** (e.g. `Should -Not -Match 'frontend'`) → keep, but update the test description.

- [ ] **Step 3: Apply the updates**

Per-test file:

**`scripts/tests/install-center.Tests.ps1`:**
- Update all `frontend\\dist` regexes → `center\\dist`.
- Update `Push-Location.*frontend` assertions → `Push-Location.*center` (or `center\web`).
- Update `npm run build:frontend` regex → `npm run build:web --workspace=center`.

**`scripts/tests/upgrade-center.Tests.ps1`:**
- Already partially updated in T5 (line 89-92). Update remaining `frontend\\dist` references.
- Update `Push-Location.*frontend` → `Push-Location $projectRoot` (T5 changed this).

**`scripts/tests/update-center.Tests.ps1`:**
- Mirror the install-center.ps1 / upgrade-center.ps1 changes.

- [ ] **Step 4: Add new layout regression tests**

Append a new `Describe` block at the end of `scripts/tests/install-center.Tests.ps1`:

```powershell
Describe 'center+frontend workspace merge layout' {
  It 'frontend/ directory must NOT exist' {
    Test-Path (Join-Path (Join-Path $PSScriptRoot '..') '..\frontend') | Should -BeFalse `
      'frontend/ directory must be removed after the merge — its files now live at center/web/.'
  }

  It 'center/web/ must contain the merged frontend source' {
    Test-Path (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'center\web') 'vite.config.js') | Should -BeTrue `
      'center/web/vite.config.js must exist after the merge.'
    Test-Path (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'center\web') 'index.html') | Should -BeTrue `
      'center/web/index.html must exist after the merge.'
  }

  It 'center/web/vite.config.js must output to ../dist' {
    $viteConfig = Get-Content (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'center\web') 'vite.config.js') -Raw
    $viteConfig | Should -Match "outDir:\s*'\.\./dist'" `
      'center/web/vite.config.js must declare outDir: "../dist" so vite writes to center/dist/.'
  }

  It 'publish/system/frontend/ must NOT exist (no shipped frontend tree)' {
    Test-Path (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system') 'frontend') | Should -BeFalse `
      'publish/system/frontend/ must be removed after the merge — shipped dist now lives at publish/system/center/dist/.'
  }

  It 'publish/system/center/dist/index.html MUST exist (shipped dist sanity)' {
    Test-Path (Join-Path (Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $PSScriptRoot '..') '..') 'publish\system') 'center\dist') 'index.html') | Should -BeTrue `
      'publish/system/center/dist/index.html must be tracked (the shipped web bundle).'
  }
}
```

> **Note:** Join-Path is intentionally not used because it would produce mixed slashes; use string concatenation with `\` to match the .ps1 convention in this test file.

- [ ] **Step 5: Run the full Pester suite**

```bash
Invoke-Pester ./scripts/tests,./scripts/common/tests -Output Detailed
```

Expected: 0 failures. If a pre-existing test breaks for an unrelated reason, investigate before commit. Pre-existing failures should be parked, not fixed in this task.

- [ ] **Step 6: Commit**

```bash
git add scripts/tests/
git commit -m "test(scripts): update Pester paths + add layout regression tests

T9 of center+frontend workspace merge. Updates regexes in
install-center.Tests.ps1, upgrade-center.Tests.ps1, update-center.Tests.ps1
to assert the new center\dist paths and the npm run build:web
--workspace=center script name.

Adds new 'center+frontend workspace merge layout' Describe block with
5 regression tests:
1. frontend/ directory does NOT exist
2. center/web/ contains the merged source (vite.config.js + index.html)
3. center/web/vite.config.js outDir is '../dist'
4. publish/system/frontend/ does NOT exist
5. publish/system/center/dist/index.html EXISTS (shipped dist sanity)

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.9

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Update CI workflow

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: T2's new `test:web` and `build:web` root scripts.
- Produces: CI workflow uses the renamed commands; no `frontend` workspace step remains.

- [ ] **Step 1: Read .github/workflows/ci.yml**

```bash
cat .github/workflows/ci.yml
```

Current relevant lines:

```yaml
- name: Center tests
  run: npm run test:center
- name: Agent tests
  run: npm run test:agent
- name: Frontend tests
  run: npm run test:frontend
- name: Frontend build (sanity)
  run: npm run build:frontend
```

- [ ] **Step 2: Edit ci.yml**

Replace:

```yaml
- name: Frontend tests
  run: npm run test:frontend
- name: Frontend build (sanity)
  run: npm run build:frontend
```

With:

```yaml
- name: Web tests (vitest)
  run: npm run test:web
- name: Web build (sanity)
  run: npm run build:web
```

Also update the `name:` line for the `Node` job: `Node (center + agent + frontend)` → `Node (center + agent + web)`.

- [ ] **Step 3: Verify the file structure**

```bash
cat .github/workflows/ci.yml | grep -E "test:|build:|workspace"  # expect: no 'frontend'
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: rename frontend steps to web + retarget npm scripts

T10 of center+frontend workspace merge. Updates CI workflow:
- 'Frontend tests' step → 'Web tests (vitest)', command npm run test:web
- 'Frontend build (sanity)' step → 'Web build (sanity)', command npm run build:web
- Job display name updated: 'Node (center + agent + frontend)' →
  'Node (center + agent + web)'

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md (N/A — CI config)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: WPF build verification + path cleanup

**Files:**
- Potentially modify: WPF files referencing `frontend/` paths (none expected per spec §5.10)
- Verify: `PackageDesigner.csproj` + `PackageDesigner.sln` build cleanly

**Interfaces:**
- Consumes: T1-T10's output.
- Produces: WPF solution still builds; no references to the deleted `frontend/` directory remain.

- [ ] **Step 1: Re-grep WPF for any frontend/ references**

```bash
grep -rn "frontend" MainWindow.xaml.cs Common/ Converters/ Models/ 2>&1
grep -rn "frontend" --include="*.cs" --include="*.csproj" --include="*.sln" --include="*.xaml" 2>&1
```

Expected: empty output. If anything matches, fix it before commit.

- [ ] **Step 2: Build the WPF solution**

```bash
dotnet build -c Release
```

Expected: 0 errors, 0 new warnings vs the baseline. If anything fails for unrelated reasons, investigate.

- [ ] **Step 3: Commit (if any changes were needed)**

If the grep returned no matches and the dotnet build succeeded with no new warnings, this task may have no commit. In that case, skip to the next task. If you had to edit something, write a commit message that names the specific files you changed, e.g.:

```bash
git add <specific-file-paths>
git commit -m "refactor(wpf): remove stale frontend/ path references

T11 of center+frontend workspace merge. Updated <N> WPF files
(<list them>) that referenced frontend/dist paths. None expected per
spec §5.10; this commit is a defensive cleanup if any did.

Verified via dotnet build -c Release (0 new warnings).

Spec: docs/superpowers/specs/2026-08-22-center-merge-design.md §5.10

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Whole-branch review + merge + push

**Files:** none modified; this task is a coordination gate.

- [ ] **Step 1: Confirm all tests green**

```bash
Invoke-Pester ./scripts/tests,./scripts/common/tests -Output Detailed  # expect: 0 fail
npm run test                                  # expect: backend + agent + web all green
pwsh -NoProfile -File scripts/verify-mirror.ps1  # expect: 0 drift, 0 missing, 0 orphan
```

- [ ] **Step 2: Capture pre-merge HEAD**

```bash
git rev-parse HEAD  # save this — the whole-branch review needs it as BASE
```

- [ ] **Step 3: Dispatch whole-branch reviewer (opus)**

Per the SDD workflow, dispatch the final whole-branch reviewer with the pre-merge HEAD as BASE. Provide the reviewer:
- The spec (`docs/superpowers/specs/2026-08-22-center-merge-design.md`)
- The plan (this document)
- The diff range (`git diff <BASE>..HEAD`)
- The pre-merge HEAD captured in Step 2

The reviewer should produce a verdict (READY TO MERGE / NEEDS FIXES / NEEDS REWORK) with categorized findings (Critical / Important / Minor / Informational).

- [ ] **Step 4: Apply review fixes if any**

If the reviewer returned NEEDS FIXES, dispatch one fix-round subagent (sonnet or haiku per the fix's complexity). Re-run the reviewer once with the fix-diff scope. Park any Minor / Informational findings (the user's preference for ship-clean over drive-bys).

- [ ] **Step 5: Merge to main and push**

```bash
git checkout main
git merge --no-ff <feature-branch>
git push origin main
```

- [ ] **Step 6: Verify on origin**

```bash
git log --oneline origin/main | head -5  # expect: merge commit + the 12 task commits
```

- [ ] **Step 7: Update memory**

Write a memory entry capturing:
- The merge is shipped (main @ <hash>)
- Test counts (e.g., center 998 + agent 86 + web 240)
- Lessons learned (especially any from the reviewer)
- Any parked follow-ups

Add the entry to `progress_2026_08_22_center_merge.md` and update `MEMORY.md` index.

---

## Verification

After T12 completes, the following must all be green:

```bash
# Unit tests
Invoke-Pester ./scripts/tests,./scripts/common/tests -Output Detailed
npm run test                            # backend + agent + web
npm run build:web --workspace=center    # → center/dist/index.html
pwsh -NoProfile -File scripts/verify-mirror.ps1  # 0 drift, no missing, no orphan

# Live (post-merge)
cd center && node server.js &   # boot, curl http://localhost:8080/, expect Vue index.html
```

Expected outputs:
- Pester: 0 failures (current 31/31 + the new layout tests)
- Backend tests: 998 + 64 skipped (unchanged from baseline)
- Agent tests: 86 + 1 skipped (unchanged from baseline)
- Web tests: 240 (vitest, unchanged from baseline)
- verify-mirror: 0 drift, 0 missing, 0 orphan (with the regression guards for the new layout)
- Live curl: returns Vue `<!doctype html>` page

---

## Out of scope (parked, follow-up tasks)

- **README + CONTRIBUTING update**: drive-by, mention `frontend/` is now `center/web/`. Logged for future cleanup.
- **appsettings.json location move**: separate task (2026-08-22 morning note).
- **Dist compression or content fingerprint**: separate optimization.
- **Removing `update-center.ps1` entirely**: still kept as deprecated-but-functional. Re-evaluate after one release cycle.
- **Removing `frontend/dist/` from .gitignore entirely** (it doesn't exist, but the literal string is still in the file via Task 7's edits). Verify post-T7 with `grep -n "frontend" .gitignore` (expect: empty).
