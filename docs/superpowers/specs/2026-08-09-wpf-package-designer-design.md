# WPF Package Designer — Design Spec

**Date**: 2026-08-09
**Status**: Draft (pending user approval of written spec)
**Scope**: new subsystem — Windows GUI tool for authoring v2 monitoring packages locally + publishing to center
**Supersedes**: nothing — new project, additive to the v2 plugin system (`2026-08-09-self-contained-monitoring-package-design.md`)
**Related**:
- v2 plugin system spec → tool is the **authoring counterpart** to center's installer
- DDL sandbox in `center/src/packages/ddl-sandbox.js` → tool ports this 1:1 to .NET
- Manifest schema in `center/src/packages/manifest.js` → tool's PackageManifest class mirrors this

---

## Goal

Provide an internal **Windows-only WPF tool** that lets a package author (you/me) create, edit, validate, and publish v2 monitoring packages to a running center instance — without touching raw zip files or hand-editing `manifest.json` + DDL + `collect.ps1`. The tool is the GUI counterpart to center's `installer.installPackage` REST endpoint, sharing the same v2 package contract and (after port) the same DDL sandbox algorithm.

## Motivation

Today, authoring a v2 package means:

1. Open a terminal, `mkdir my-pkg && cd my-pkg`
2. Hand-write `manifest.json` (ajv schema has 14+ fields including nested `database.metricSchema`)
3. Hand-write `migrations/001_initial.sql` (must match `metricSchema` column-by-column after type normalization)
4. Hand-write `collect.ps1` (must satisfy center's stdout JSON contract)
5. Hand-write `package.json` registry entry
6. `zip -r ../my-pkg-1.0.0.zip .`
7. `curl -X POST .../api/admin/packages/install -d @zip.b64` (with manual base64)

Every mistake (typo in field name, mismatched metric column type, missing FK reference, dropped table in DDL) is only caught by center — and the failure message comes back as opaque error code. There's no local sandbox, no schema-aware editor, no validation pre-flight. The author's first feedback is "package rejected" with a log dump.

The WPF tool replaces steps 1-7 with a structured editor (form for manifest + syntax-highlighted text editors for SQL/PS1), runs a local DDL sandbox before publish, and shows the center's response with full error details on failure.

## Scope

**In scope:**
1. Single-file .NET 8 self-contained Windows exe (~70MB), MVVM-lite, no installer.
2. Multi-document UI — open multiple packages simultaneously (VS-style top-level tabs).
3. Manifest editor — XAML form bound to `PackageManifest` C# class, derived from `center/src/packages/manifest.js` JSON schema.
4. SQL editor — AvalonEdit with keyword set = sandbox `ALLOWED_KEYWORDS` (rejects unknown keywords visually).
5. PowerShell editor — AvalonEdit with standard PS1 keyword set.
6. Local DDL sandbox — .NET port of `center/src/packages/ddl-sandbox.js`, byte-identical to Node.js version, verified by golden file tests.
7. JSON Schema validation — embed `manifest.schema.json` (compiled from `manifest.js` ajv schema), validate locally via NJsonSchema.
8. Persistence — `.pkgproj` file + workspace dir for stateful editing across sessions, with auto-save every 30s and crash recovery.
9. Publish — POST to center's `/api/admin/packages/install` with JSON body `{source, packageRef, buffer: <base64 zip>, confirmDropSchema: false}`. Token from Windows Credential Manager. Streaming upload via `IProgress<double>`.
10. Settings — `%APPDATA%\PackageDesigner\settings.json` for center URL.
11. Tests — unit (sandbox / validator / viewmodels) + golden file (sandbox byte-identical to Node.js) + integration (publish with mock HTTP).

**Out of scope (deferred):**
- **Cross-platform** — WPF is Windows-only; no Avalonia port in this plan.
- **Code signing / Authenticode** — center doesn't verify package signatures today; defer.
- **v1 → v2 upgrade wizard** — author writes fresh v2 packages; v1 packages stay in their existing flow.
- **Package marketplace / registry hosting** — author pushes directly to a known center URL.
- **Multiple centers batch publish** — single target per session.
- **Project file format beyond .pkgproj** — no `.sln`-style grouping; .pkgproj is per-package.
- **License management** — internal tool, license field is free-form text.
- **i18n** — UI in zh-CN only.
- **Auto-update** — exe is replaced by manual download; no ClickOnce / Squirrel.
- **Telemetry / crash reporting** — internal, no instrumentation; crash recovery uses local auto-save log only.

## Architecture

### Tech stack

| Component | Choice | Why |
|-----------|--------|-----|
| Runtime | .NET 8 LTS | Long-term support, latest C# 12 features, matches current Microsoft strategic direction |
| Deployment | `dotnet publish -c Release -r win-x64 --self-contained` | Single .exe, no runtime install; ~70MB |
| UI framework | WPF (built-in) | XAML + code-behind, MVVM-lite (manual `INNotifyPropertyChanged`, no Prism/MVVM Toolkit) |
| Text editor | AvalonEdit (NuGet `AvalonEdit`) | Built-in syntax highlighting for arbitrary keyword sets; matches SQL + PS1 needs |
| JSON Schema | NJsonSchema (NuGet `NJsonSchema`) | Validates embedded `manifest.schema.json` at save / publish time |
| Credential storage | `Meziantou.Framework.Win32.CredentialManager` (NuGet) | P/Invoke wrapper for Windows Credential Manager; no hand-rolled interop |
| Zip I/O | `System.IO.Compression.ZipFile` + `System.IO.Packaging` | .NET BCL, no third-party dep |
| Tests | xUnit + FluentAssertions | Standard .NET test stack; matches what other .NET codebases use |
| HTTP mock | `RichardSzalay.MockHttp` | Mock `HttpMessageHandler` for publish flow tests |

### Module layout

```
PackageDesigner/
├── PackageDesigner.csproj          # net8.0-windows, self-contained, win-x64
├── App.xaml / App.xaml.cs          # composition root + DI lite (manual new())
├── MainWindow.xaml / .cs           # top-level TabControl + menu + toolbar
├── Views/
│   ├── PackageTabView.xaml         # one opened package (tree + editors)
│   ├── ManifestFormView.xaml       # XAML form, bound to ManifestVM
│   ├── SqlEditorView.xaml          # AvalonEdit + sandbox status strip
│   ├── PowerShellEditorView.xaml   # AvalonEdit
│   ├── MigrationsListView.xaml     # ordered list + add/remove
│   └── SettingsDialog.xaml         # center URL + token management
├── ViewModels/
│   ├── MainWindowViewModel.cs      # list of PackageTabViewModels
│   ├── PackageTabViewModel.cs      # single opened package
│   ├── FileTabViewModel.cs         # base class for opened files in editors
│   ├── ManifestViewModel.cs        # PackageManifest + form state + errors
│   ├── SqlFileViewModel.cs         # DDL or migration SQL file
│   ├── PowerShellFileViewModel.cs  # collect.ps1 (or any agent.script file)
│   └── SettingsViewModel.cs
├── Models/
│   ├── PackageManifest.cs          # C# class mirroring center/src/packages/manifest.js
│   ├── DatabaseConfig.cs           # nested under PackageManifest
│   ├── AgentConfig.cs              # nested under PackageManifest
│   ├── MetricDef.cs                # nested under metricSchema entry
│   ├── PackageFile.cs              # {path, role, checksum}
│   ├── PackageProject.cs           # .pkgproj deserialization target
│   ├── SandboxResult.cs            # {errors[], warnings[], tokenCount, scanDurationMs}
│   └── SandboxError.cs             # {token, line, column, code, message}
├── Services/
│   ├── PackageService.cs           # zip I/O (open/save), extracts to workspace
│   ├── PublishService.cs           # POST to center
│   ├── SandboxService.cs           # public entry; uses Sandbox/ submodule
│   ├── AutoSaveService.cs          # 30s heartbeat + 5s idle save
│   ├── CredentialService.cs        # wraps Meziantou.Framework.Win32.CredentialManager
│   ├── SettingsService.cs          # %APPDATA%\PackageDesigner\settings.json
│   └── RecoveryService.cs          # startup scan for orphan .pkgproj + auto-save.log
├── Sandbox/                        # .NET port of center/src/packages/ddl-sandbox.js
│   ├── Tokenizer.cs                # SQL string → token list
│   ├── KeywordChecker.cs           # ALLOWED_KEYWORDS HashSet + case strategy
│   ├── PatternChecker.cs           # BLOCKED_PATTERNS compiled-once regex array
│   ├── TokenWalker.cs              # single-pass scan → errors[]
│   └── SandboxSelfReference.cs     # selfPackage check (allow own pkg_<name>.x refs)
└── Resources/
    └── manifest-schema.json        # EmbeddedResource; derived from manifest.js ajv schema
```

### Process flow

```
[user clicks "New Package" or "Open .zip" or "Open .pkgproj"]
            │
            ▼
  PackageService.LoadAsync(source)
            │
            ├── new:        create empty PackageProject, manifest skeleton
            ├── .zip:       extract to workspace, build PackageProject
            └── .pkgproj:   read JSON, hydrate files from workspace
            │
            ▼
  MainWindow adds new PackageTabViewModel to tabs[]
            │
            ▼
  [user edits manifest form / DDL / PS1 in editors]
            │
            ├── every 5s idle:  AutoSaveService writes changed files to workspace + .pkgproj
            ├── every 30s:       forced full flush
            └── on user Ctrl+S:  explicit save (.pkgproj only)
            │
            ▼
  [user clicks "Save .zip" or "Publish"]
            │
            ├── Save .zip: PackageService.PackAsync(workspace, destPath) → bytes
            │
            └── Publish:
                  PublishService.PublishAsync(package, centerUrl, token)
                    1. completeness check (form errors, file references)
                    2. NJsonSchema validate PackageManifest
                    3. SandboxService.ScanAllAsync(ddlFiles + migrationFiles)
                    4. reachability HEAD probe
                    5. user confirm modal
                    6. POST multipart JSON body to center
                    7. handle response (200/400/401/409/422/500/timeout)
                    8. update .pkgproj lastPublishedAt
```

## Package format (the input / output)

The tool's output is a v2 zip, byte-compatible with `center/src/packages/installer.js > parseBuffer`. Layout:

```
<packageName>-<version>.zip
├── manifest.json
├── collect.ps1
├── migrations/
│   ├── 001_initial.sql
│   └── 002_add_swap_pct.sql
├── icon.svg                    ← optional
├── default-config.json         ← optional
└── widget.vue                  ← optional (deferred in v1, still deferred)
```

Tool enforces **only the required files**: `manifest.json` + `collect.ps1` + at least one file in `migrations/`. Optional files (`icon.svg`, `default-config.json`, `widget.vue`) can be added via toolbar "Add Optional File" — they pass through unchanged.

### `manifest.json` — JSON Schema (embedded as EmbeddedResource)

Schema derived 1:1 from `center/src/packages/manifest.js > manifestSchema`. The .NET tool embeds a JSON Schema draft-07 equivalent (compiled from the same source) and validates via NJsonSchema at save + publish time. Any drift between this schema and the ajv schema in center is a bug; both must be updated in lockstep.

Top-level structure (full schema in `Resources/manifest-schema.json`):

```jsonc
{
  "type": "object",
  "required": ["name", "version", "type"],
  "additionalProperties": false,
  "properties": {
    "name":          { "type": "string", "pattern": "^[a-z0-9-]+(\\.[a-z0-9-]+)*$" },
    "version":       { "type": "string" },                       // SemVer — validated separately by SemVer lib
    "type":          { "enum": ["gauge", "counter", "timeseries", "status"] },
    "description":   { "type": "string" },
    "author":        { "type": "string" },
    "license":       { "type": "string" },
    "agent": {
      "type": "object",
      "required": ["minVersion", "script", "intervalSec"],
      "additionalProperties": false,
      "properties": {
        "minVersion":   { "type": "string" },
        "platforms":    { "type": "array", "items": { "enum": ["windows"] } },
        "runtime":      { "enum": ["powershell"] },
        "script":       { "type": "string" },
        "timeoutMs":    { "type": "integer", "minimum": 1000, "maximum": 600000 },
        "intervalSec":  { "type": "integer", "minimum": 5, "maximum": 86400 }
      }
    },
    "center": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "minVersion": { "type": "string" },
        "maxVersion": { "type": "string" }
      }
    },
    "metrics": { /* v1 unchanged */ },
    "params":   { /* v1 unchanged */ },
    "widget":   { /* v1 unchanged */ },
    "dependencies": { "type": "array", "items": { "type": "object" } },
    "database": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schemaName", "migrations", "metricTable", "metricSchema"],
      "properties": {
        "schemaName":   { "type": "string", "pattern": "^pkg_[a-z0-9_]+$" },
        "migrations":   { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
        "metricTable":  { "type": "string", "pattern": "^[a-z0-9_]+$" },
        "metricSchema": {
          "type": "object",
          "minProperties": 3,
          "additionalProperties": {
            "type": "object",
            "additionalProperties": false,
            "required": ["type"],
            "properties": {
              "type":     { "type": "string", "pattern": "<canonical types>" },
              "nullable": { "type": "boolean" }
            }
          }
        }
      }
    }
  }
}
```

**Post-validation hook** (mirrors `manifest.js > extraCheck`):
- `database.metricSchema.agent_id` must exist with `nullable: false`
- `database.metricSchema.ts` must exist with `nullable: false`

### `collect.ps1` — PowerShell contract

The script must output a JSON object to stdout in the shape:
```json
{ "metrics": { ... }, "error": null }
```

(Or `error: "<message>"` on failure.) The tool's PS1 editor doesn't validate this contract — center's `runner.js` validates at run time. The editor only provides syntax highlighting + line numbers. A separate "Test PS1 Locally" feature is out of scope.

### Migrations — DDL files

Each file in `migrations/` (and the implicit `ddl/` files at v2 root if the author uses that layout — but the v2 spec mandates `migrations/`) is subject to the DDL sandbox before publish. The tool runs the sandbox on each file as it's edited (debounced 500ms) and shows status in the editor tab strip.

## UI structure

### Main window

```
┌──────────────────────────────────────────────────────────────────────┐
│ [File] [Edit] [Tools] [Help]      Center: https://prod1 ✓connected  │
├──────────────────────────────────────────────────────────────────────┤
│ [📁 New] [📂 Open .zip] [📂 Open .pkgproj] [💾 Save .zip]            │
│ [💾 Save .pkgproj] [🚀 Publish] [🗑️ Clean Workspace]                 │
├──────────────────────────────────────────────────────────────────────┤
│ ┌─ ad_monitoring 1.0.0 ─┬─ ad_dcs 2.1.0 ─┬─ + ─┐ ← 顶层包 tab     │
│ │                                                                │ │
│ │  ┌─Files───┐ ┌─Editors (TabControl)────────────────────┐      │ │
│ │  │▼ manifest│ │ [manifest (form)] [ddl/metrics.sql] [collect.ps1] │ │
│ │  │▼ ddl/   │ │                                       │      │ │
│ │  │   metrics.sql ✓                                       │      │ │
│ │  │▶ ps1/   │ │  Package name: [ad_monitoring       ]   │      │ │
│ │  │▶ migrations/│ Version:  [1.0.0]                      │      │ │
│ │  │   001.sql │ Database: ( ) mysql  (•) mssql            │      │ │
│ │  │   002.sql │ Schema:   [pkg_ad_monitoring          ]   │      │ │
│ │  │          │ Agent ID: [ad-monitoring-agent          ]   │      │ │
│ │  │ [+ Add]  │ Metric schema:                            │      │ │
│ │  │ [+ Add]  │   [agent_id] varchar(64) NOT NULL  [x]    │      │ │
│ │  └──────────┘   [ts]       datetime      NOT NULL  [x]    │      │ │
│ │                  [cpu_pct]  double                     [x]   │      │ │
│ │                  [+ Add metric]                             │      │ │
│ │                                                                │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Status: ⚠ 2 unsaved │ Auto-saved 12s ago │ Sandbox: 3 OK     │ │
│ └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Behavior

- **Top-level TabControl**: one tab per opened package; `+` tab at the end opens new package dialog (name + type).
- **Per-package tab**:
  - Left `TreeView`, grouped by file role: `manifest`, `ddl/`, `ps1/`, `migrations/`. Each group has `+ Add` button.
  - Right `TabControl` for opened file editors; clicking a tree node opens / activates its tab.
  - File node icons: `✓` (clean), `✗ N errors` (validation failed), `●` (unsaved modification).
- **Closing file tab** with unsaved changes: prompt `Save / Discard / Cancel`.
- **Closing package tab** with unsaved changes: prompt `Save .pkgproj / Discard / Cancel`.
- **Manifest form** is the only non-text editor for manifest; SQL/PS1 use AvalonEdit.
- **Sandbox status strip** per SQL file tab: `Sandbox: 3 OK / 0 errors` updated on each debounced re-scan.
- **Error glyph** click → jump to token location in editor.
- **Empty state**: when all tabs closed, main window shows centered "Open or create a package to get started" + recent files list.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New package |
| Ctrl+O | Open .zip |
| Ctrl+Shift+O | Open .pkgproj |
| Ctrl+S | Save .pkgproj (active package) |
| Ctrl+Shift+S | Save .zip (active package) |
| Ctrl+Enter | Publish (active package) |
| Ctrl+W | Close active package tab |
| Ctrl+Tab | Cycle editor tabs within active package |
| Ctrl+1 / Ctrl+2 / ... | Jump to Nth editor tab |
| F5 | Re-run sandbox scan on active SQL file |

### Settings dialog

- Center URL (text input; validated as absolute HTTPS URL)
- Token management: `[Set Token]` opens credential prompt (password input) → saves to Credential Manager under target `PackageDesigner:<centerUrl>`; `[Clear Token]` removes from Credential Manager
- `[Test Connection]` does HEAD probe (`/api/admin/packages/registry`) and shows status + 401/200 result

## Sandbox integration

### Port strategy

The .NET port of `center/src/packages/ddl-sandbox.js` is **byte-for-byte equivalent** to the Node.js version at the token / result level. This is enforced via golden file tests (see Testing section). Any drift is a bug.

The algorithm (1:1 translation, no improvements, no shortcuts):

1. **Input**: `(string sql, SandboxContext ctx) → SandboxResult`
2. **Strip comments**: `/* ... */` block + `-- ...` line
3. **Self-reference replace**: if `ctx.selfPackage` is set, replace all `\\b<selfPackage>\\.[a-z0-9_]+` occurrences with `__SELF_REF__` so cross-package check (regex index 7) does not false-positive
4. **Apply BLOCKED_PATTERNS** in declared order (order-sensitive — multi-statement check at index 0 must run first)
5. **Tokenize** on `[\s(),;]+` (note: `.` is NOT a splitter — schema-qualified `pkg_foo.metrics` references are handled by the self-reference replacement in step 3, which substitutes `__SELF_REF__` before tokenization. If a `pkg_<name>.x` reference survives step 3, it should already have been rejected by `BLOCKED_PATTERNS[7]`. A non-`pkg_` schema-qualified identifier like `myschema.mytable` hits the `unparseable token` check because `.` is not in the identifier character class — this is intentional, since custom schemas are not permitted.)
6. **Per-token checks**:
   - Numeric literal `^-?\\d+(\\.\\d+)?$` → allowed
   - String literal `^'[^']*'$` → allowed
   - Identifier `/^[a-z_][a-z0-9_]*$/i` → allowed freely
     - If identifier is entirely `^[A-Z_]+$` and NOT in `ALLOWED_KEYWORDS` → reject (defense-in-depth: catches `DROPPED`, `WHEREEVER`)
   - Anything else → reject as `unparseable token`
7. **Reserved-resource check** (Node.js's `RESERVED_CENTER_RESOURCES` Set, applied via per-token lookup)
8. **Return** `{ok: true}` or `{ok: false, blocked: '<pattern source or token>'}`

### `ALLOWED_KEYWORDS` (verbatim from Node.js)

```csharp
private static readonly HashSet<string> ALLOWED_KEYWORDS = new(StringComparer.Ordinal) {
  // DDL
  "CREATE", "TABLE", "SCHEMA", "DATABASE", "INDEX", "UNIQUE", "VIEW",
  "IF", "NOT", "EXISTS",
  "ALTER", "ADD", "COLUMN", "CONSTRAINT", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
  "DEFAULT", "NULL", "CHECK", "ON", "UPDATE", "DELETE", "CASCADE", "NO", "ACTION", "RESTRICT", "SET",
  // table options
  "ENGINE", "CHARSET", "COLLATE",
  // index options
  "ASC", "DESC", "USING", "BTREE", "HASH",
  // types
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT",
  "VARCHAR", "CHAR", "TEXT", "NVARCHAR", "NTEXT",
  "DOUBLE", "FLOAT", "DECIMAL", "NUMERIC",
  "DATETIME", "TIMESTAMP", "DATETIMEOFFSET", "DATE",
  "JSON", "BOOLEAN", "BIT",
  // dialect-specific
  "AUTO_INCREMENT", "IDENTITY",
};
```

### `BLOCKED_PATTERNS` (verbatim, in declared order)

```csharp
private static readonly Regex[] BLOCKED_PATTERNS = new[] {
  new Regex(@";\s*\S",            RegexOptions.Compiled),  // multi-statement
  new Regex(@"\bDROP\b",          RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\b(TRUNCATE|RENAME|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\bINSERT\s+INTO\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\bUPDATE\s+(?!CASCADE\b)[a-z_]", RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\bDELETE\s+FROM\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\b(MERGE|SELECT)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\bpkg_[a-z0-9_]+\.[a-z0-9_]+", RegexOptions.Compiled | RegexOptions.IgnoreCase),
  new Regex(@"\b(main|installed_packages|metric_gauge|metric_counter|metric_timeseries|metric_status|package_runs|orphan_schemas|system_config|audit_logs|schema_migrations)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
};
```

### Self-reference (preserved from Node.js v2)

When the user is editing a v2 package with `database.schemaName = pkg_ad_monitoring`, the sandbox is called with `SandboxContext { SelfPackage = "pkg_ad_monitoring" }`. This causes:

```csharp
var selfRe = selfPackage != null
  ? new Regex($@"\b{Regex.Escape(selfPackage)}\.[a-z0-9_]+", RegexOptions.IgnoreCase)
  : null;
var scanStripped = selfRe != null
  ? selfRe.Replace(stripped, "__SELF_REF__")
  : stripped;
```

before applying `BLOCKED_PATTERNS[7]` (the cross-package check). This matches the Node.js behavior exactly (see `ddl-sandbox.js:62-71`).

### Sync between Node.js and .NET

- `docs/superpowers/specs/2026-08-09-self-contained-monitoring-package-design.md > DDL sandbox` is the **single source of truth** for the algorithm.
- Any change to the algorithm (new allowed keyword, new blocked pattern, new reserved resource) MUST be made in:
  1. The Node.js sandbox (`center/src/packages/ddl-sandbox.js`)
  2. The .NET sandbox (`PackageDesigner/Sandbox/`)
  3. The shared test fixtures (`tests/fixtures/sandbox-cases.json`)
- CI in the **center** repo runs both Node.js tests and a generated golden file from .NET output; both must pass.
- The .NET repo's CI runs only .NET tests + golden file diff against the committed `sandbox-cases.json`.

### Sandbox integration in UI

- AvalonEdit's SQL syntax highlighting keyword set = `ALLOWED_KEYWORDS` (allows override via `SyntaxDefinition.xml` — tool ships a `sql-mysql.xml` and `sql-mssql.xml` variant, selected by manifest's `database.type`).
- Per SQL file tab, top status strip shows `Sandbox: N OK / M errors`. Re-scans on every save (debounced 500ms).
- Errors shown inline as red squiggles in editor (AvalonEdit `IHighlighter` custom marker). Click error → jump to token line/column.
- "Test Sandbox" button per file forces immediate re-scan.

## Persistence

### `.pkgproj` file format

JSON file representing the project's saved state. Located at `<workspaceDir>\<packageName>.pkgproj`.

```jsonc
{
  "version": "1",
  "packageId": "uuid-v4",
  "manifest": { /* PackageManifest JSON, matches schema */ },
  "files": [
    { "path": "migrations/001_initial.sql", "role": "migration", "checksum": "sha256:<hex>" },
    { "path": "migrations/002_add_swap.sql", "role": "migration", "checksum": "sha256:<hex>" },
    { "path": "collect.ps1", "role": "ps1", "checksum": "sha256:<hex>" }
  ],
  "originalZipPath": "C:\\path\\to\\source.zip",  // null if package created from scratch
  "lastSavedAt": "2026-08-09T12:34:56Z",
  "autoSaveRevision": 17,
  "lastPublishedAt": "2026-08-09T13:00:00Z",       // null if never published
  "lastPublishedTo": "https://prod1",             // center URL of last publish
  "publishedVersion": "ad_monitoring-1.0.0.zip"   // zip filename
}
```

### Workspace directory layout

`%APPDATA%\PackageDesigner\projects\<packageId>\`

```
<pkg-id>/
├── <pkg-name>.pkgproj                    # metadata
├── content/
│   ├── collect.ps1
│   ├── migrations/
│   │   ├── 001_initial.sql
│   │   └── 002_add_swap.sql
│   └── (any optional files the user added)
├── auto-save.log                         # append-only log of save events
└── workspace.lock                        # PID lock so two PackageDesigner instances don't trample
```

### Save triggers

| Trigger | Action |
|---------|--------|
| Edit pause (5s of no changes) | Incremental write: only changed files + `.pkgproj` with updated checksums |
| User `Ctrl+S` | Full flush (all files + .pkgproj) |
| 30s heartbeat timer | Full flush (safety net against incremental loss) |
| Closing package tab / exit app | Check unsaved → prompt `Save / Discard / Cancel` → flush if Save |
| Process crash | See Recovery below |

### Crash recovery

On startup, `RecoveryService` scans `%APPDATA%\PackageDesigner\projects\` for `.pkgproj` files and reads the tail of each `auto-save.log`:

```jsonl
{"ts":"2026-08-09T12:00:00Z","event":"incremental","pkgId":"...","revision":17}
{"ts":"2026-08-09T12:00:05Z","event":"full","pkgId":"...","revision":18,"filesWritten":3}
{"ts":"2026-08-09T12:00:08Z","event":"incremental","pkgId":"...","revision":19,"file":"migrations/002.sql"}  // last write was incomplete
```

If the last line is `incremental` without a matching `full` ack, the `.pkgproj` may be mid-write. `RecoveryService`:

1. Detects mid-write by comparing the last `autoSaveRevision` in `.pkgproj` against the log's last completed event.
2. Rebuilds workspace from the last completed full-flush revision (re-reading `.pkgproj` files and using checksums to detect drift).
3. Shows recovery dialog on startup: lists affected packages, offers `Restore / Discard / Skip`.

### Concurrency

- Single-process lock via `workspace.lock` (PID file). If a second `PackageDesigner.exe` tries to open the same `.pkgproj`, it gets a "already open in another instance" error.
- `.pkgproj` writes use temp + rename (atomic on NTFS).
- File content writes use `File.WriteAllText` which is atomic for sub-4GB files on SMB/NTFS.

## Publishing flow

### Pre-publish checks

Before POST, `PublishService.PublishAsync` runs:

```
1. Completeness:
   - manifest.name, version, database.schemaName, database.agent.id all non-empty
   - all files in database.migrations exist in workspace
   - database.metricSchema names are unique + lowercase + non-empty
2. JSON Schema:  NJsonSchema.validate(manifest) against embedded manifest-schema.json
3. Post-validation hook: extraCheck() (agent_id/ts nullable=false)
4. Sandbox: SandboxService.ScanAllAsync(all .sql files) — must return 0 errors
5. Reachability: HEAD /api/admin/packages/registry (401 = token wrong, 200 = ok)
6. Confirmation modal: "Publish <name> <version> to <centerUrl>?"
```

Any failure aborts before HTTP call and shows error in source location.

### HTTP request

The center endpoint `POST /api/admin/packages/install` (see `center/src/packages/router.js:210`) accepts JSON body with base64-encoded buffer:

```http
POST /api/admin/packages/install HTTP/1.1
Host: <centerHost>
Authorization: Bearer <token from Credential Manager>
Content-Type: application/json

{
  "source": "local",
  "packageRef": "<packageName>-<version>",
  "buffer": "<base64-encoded zip bytes>",
  "confirmDropSchema": false
}
```

Tool sends via `HttpClient.PostAsync` with `StringContent(json, Encoding.UTF8, "application/json")`. For large zips (>10MB), use `StreamContent` over a `MemoryStream` to avoid base64 string allocation; for very large files (>100MB) the tool should pre-warn the user.

> **Note**: The v1 spec originally listed multipart/form-data; that was incorrect. The actual API uses JSON + base64 buffer. Confirmed against `center/src/packages/router.js:211`.

### Response handling

| HTTP | Center response body | UI action |
|------|----------------------|-----------|
| 200 | `{ok: true, data: {packageName, version}}` | Green toast "Published ✓"; `.pkgproj` updated with `lastPublishedAt` |
| 400 | `{ok: false, error: {code: "PKG_INVALID_MANIFEST", message: ...}}` | Red modal, full error text + which field; **no auto-retry** |
| 401 | `{ok: false, error: "unauthorized"}` | Red modal "Token invalid"; button `Update Token` → opens credential prompt → retry once |
| 409 | `{ok: false, error: {code: "PKG_NAME_CONFLICT"\|"PKG_SCHEMA_EXISTS", ...}}` | Yellow modal "Already installed"; button `Upgrade` / `Cancel` |
| 422 | `{ok: false, error: {code: "DDL_SANDBOX", details: [...]}}` | Red modal listing sandbox errors (local scan should have caught these; 422 is a fallback) |
| 5xx | `{ok: false, error: "internal"}` | Red modal "Server error"; button `Retry` (after 3 auto-retries with exponential backoff) |
| Network | timeout / DNS fail / connection refused | Red modal "Network: <details>"; button `Retry` / `Cancel` |

### Progress feedback

- Publish click → modal `Uploading... 2.3MB / 5.1MB (45%)` driven by `IProgress<double>` over `StreamContent.CopyToAsync`.
- Cancel button → `CancellationTokenSource.Cancel()`, HttpClient aborts.
- On 200, modal closes, toast appears, focus returns to editor.

## Settings

`%APPDATA%\PackageDesigner\settings.json`:

```jsonc
{
  "version": "1",
  "centerUrl": "https://center.example.com",
  "credentialTargetSuffix": "PackageDesigner",   // used as CredentialManager target prefix
  "ui": {
    "language": "zh-CN",
    "theme": "system"                            // system | light | dark
  },
  "recentFiles": [
    "C:\\...\\ad_monitoring-1.0.0.zip",
    "C:\\...\\ad_dcs-2.1.0.zip"
  ]                                              // last 10, MRU order
}
```

`CredentialService` stores tokens under target `PackageDesigner:<sanitized-centerUrl>` in Windows Credential Manager (Generic Credential type).

## Testing strategy

### Sandbox golden file tests

**Top priority.** `tests/Sandbox/GoldenFileTests.cs`:

```csharp
[Theory]
[MemberData(nameof(LoadCases))]
public void Sandbox_MatchesNodeJsOutput(SandboxCase c) {
  var result = SandboxService.Scan(c.Sql, c.SelfPackage);
  // Compare against expected: {ok, blocked, errors}
  result.Should().BeEquivalentTo(c.Expected);
}

public static IEnumerable<object[]> LoadCases() {
  // Read tests/fixtures/sandbox-cases.json
  // Each case: { sql, selfPackage, expected }
}
```

Cases live in `tests/fixtures/sandbox-cases.json` (50+ entries covering each `BLOCKED_PATTERNS` index, `ALLOWED_KEYWORDS` whitelist edge cases, identifier policy edge cases including `DROPPED` / `WHEREEVER`, multi-statement, self-reference allowed + blocked scenarios).

**Cross-implementation check** (runs in **center** repo CI):

```bash
node scripts/run-sandbox-fixtures.js > /tmp/node-output.json
dotnet test --filter Sandbox --logger "console;output=json" > /tmp/dotnet-output.json
diff /tmp/node-output.json /tmp/dotnet-output.json   # must be empty
```

Both must produce identical JSON output for the same fixtures. Drift caught in center CI before merge.

### PackageManifest validator tests

`tests/Models/PackageManifestValidatorTests.cs` — 30+ cases covering each schema rule:
- name regex (lowercase alphanumeric + dashes, dots in segments allowed)
- version SemVer
- schemaName pattern
- metricSchema types (canonical vocabulary)
- agent_id / ts nullable=false post-check
- additionalProperties:false rejection

### PackageService tests

`tests/Services/PackageServiceTests.cs`:
- Round-trip: create PackageManifest + files → save .zip → re-open → manifest + files byte-identical
- Cross-platform zip: read zip created by Linux/macOS tools (verify no NTFS-only attributes break)
- Large file: 50MB SQL file streams correctly

### PublishService tests

`tests/Services/PublishServiceTests.cs` with `MockHttpMessageHandler`:
- One test per HTTP status code (200/400/401/409/422/500/timeout)
- Verify: 401 triggers credential prompt callback; 422 errors surface to UI; timeout retries 3x then yields to user
- Verify: progress reporting (IProgress<double>) receives expected number of updates

### CredentialService tests

`tests/Services/CredentialServiceTests.cs`:
- Mock `ICredentialStore` (in-memory dict) — production uses Windows Credential Manager
- Save / load / delete round-trip
- Target naming convention (`PackageDesigner:<sanitized-url>`)
- Real Credential Manager integration test marked `[Trait("category", "Integration")]` and skipped on CI (requires Windows + user profile)

### ViewModel tests

`tests/ViewModels/PackageTabViewModelTests.cs`:
- Open .zip → manifest form populates → edit name → INotifyPropertyChanged fires → save .pkgproj → re-open state matches
- Auto-save trigger via `ITestableAutoSaveService` (mock timer)
- Multi-tab: open 2 packages, edit one, ensure other unaffected

### Manual smoke test

`docs/operations/package-designer-smoke.md` — 5-minute manual script:
1. Launch exe, see empty state
2. File → New Package → "ad_smoke" / gauge / mssql
3. Manifest form: name, version, database.type=mssql, schemaName=`pkg_ad_smoke`, agent.id=`ad-smoke-agent`, intervalSec=60
4. Add `migrations/001_initial.sql` with `CREATE TABLE pkg_ad_smoke.metrics (...)` + agent_id + ts + 1 metric column
5. Add `collect.ps1` with valid JSON stdout
6. Manifest form: metricSchema entries matching the DDL exactly
7. Verify sandbox status: `0 errors`
8. Save .zip
9. Re-open .zip, verify state restored
10. Settings → set center URL + token
11. Publish → confirm modal → see success toast
12. Verify in center UI: package appears in /admin/packages

### Test execution

```bash
dotnet test                                 # all unit + integration
dotnet test --filter Sandbox                # sandbox only
dotnet test --filter "category=Integration" # real Center / real Credential Manager
pwsh scripts/verify-sandbox.ps1             # cross-impl check (center repo only)
```

## Global Constraints

These are non-negotiable requirements binding every task in the implementation plan. Implementation MUST satisfy all of these.

1. **Single .NET 8 self-contained Windows .exe**, no installer, no runtime dependency. Target: `win-x64`.
2. **Windows-only** — no Linux/macOS support. WPF is Windows-only by design.
3. **DDL sandbox .NET port MUST produce byte-identical output to `center/src/packages/ddl-sandbox.js`** for all shared test fixtures. Any drift is a bug, not a feature.
4. **All v2 package fields match `center/src/packages/manifest.js`** JSON schema, including `additionalProperties: false`. Schema embedded as `Resources/manifest-schema.json` (EmbeddedResource).
5. **Token storage uses Windows Credential Manager** (Generic Credential type). NEVER store tokens in plain text files. Target format: `PackageDesigner:<sanitized-centerUrl>`.
6. **No local validation may conflict with center validation.** Local NJsonSchema check is a pre-flight; center's ajv check is authoritative.
7. **`.pkgproj` writes are atomic** (temp + rename). Workspace file writes use atomic BCL APIs.
8. **Auto-save must not block the UI thread.** All file I/O on `Task.Run` background threads.
9. **Settings file is `%APPDATA%\PackageDesigner\settings.json`** — never in `Program Files`, never in repo, never in source-controlled paths.
10. **Crash recovery must not silently lose work.** Recovery dialog must always appear on startup if any `.pkgproj` has incomplete auto-save state.
11. **All publish HTTP requests must be cancellable** via `CancellationToken` — no fire-and-forget.
12. **No telemetry, no crash reporting to external services** — internal tool.
13. **No third-party MVVM framework** — manual `INotifyPropertyChanged` only. Reason: keep dependency surface minimal; MVVM toolkit adds 2MB+ for marginal benefit on this scope.
14. **AvalonEdit + NJsonSchema + Meziantou.Framework.Win32.CredentialManager are the only third-party NuGet deps** beyond BCL. No other deps without spec amendment.
15. **Test suite MUST include sandbox golden file tests** that fail if the .NET port drifts from Node.js output.

## Risks and open questions

1. **Manifest schema drift** — `manifest-schema.json` (embedded) must stay in lockstep with `manifest.js` ajv schema. CI in center repo runs a JSON-schema-equivalence check (compile both → compare AST). Drift caught pre-merge.

2. **Sandbox golden file maintenance** — when adding new allowed keyword / blocked pattern, fixtures must update in both repos. Owner: whoever touches the spec's "DDL sandbox" section.

3. **Workspace lock with multiple PackageDesigner instances** — `workspace.lock` is best-effort (PID check). If two instances target the same `.pkgproj`, second instance gets blocked but no guarantee against same-user-different-process races on NTFS. Acceptable risk for single-author tool.

4. **Large zip performance** — 100MB+ packages are unusual but possible (large PS1 + many migration files). Tool pre-warns above 50MB; uploads stream via `StreamContent` to avoid full base64 in memory.

5. **Credential Manager fallback** — if Windows Credential Manager is unavailable (corrupt profile, group policy), tool falls back to prompting per publish. UI shows warning banner until token re-saved.

6. **AvalonEdit version pinning** — AvalonEdit hasn't had a release in some time; WPF .NET 8 compatibility is community-maintained. Pin to a known-good version (`AvalonEdit 6.3.x` or later) and validate against sample syntax highlighting before committing.

7. **No automated UI tests** — WPF UI testing (FlaUI, Appium.Windows) is heavy and brittle. Manual smoke test (`docs/operations/package-designer-smoke.md`) is the contract. If regressions become a problem, add a single happy-path FlaUI test for the publish flow in a follow-up plan.

## Future work (out of scope)

- **Package marketplace** — multi-author registry, search, ratings.
- **v1 → v2 upgrade wizard** — open v1 .zip, convert manifest, generate default migrations.
- **Code signing** — Authenticode + center verification.
- **CRUD against live center** — list installed packages, edit config in-place, uninstall from tool.
- **Schema diff viewer** — compare current package's DDL against center's installed version.
- **Multiple center targets** — push same package to dev/staging/prod in one click.
- **PS1 local test harness** — run collect.ps1 against a sandbox test DB, capture stdout JSON, validate against metricSchema.
- **Cross-platform via Avalonia** — port UI for macOS/Linux.

## Acceptance criteria

The plan is complete when ALL of:

1. `dotnet test` passes with sandbox golden tests, validator tests, package service tests, publish service tests.
2. `pwsh scripts/verify-sandbox.ps1` in center repo shows zero diff between Node.js and .NET sandbox outputs.
3. Manual smoke test (see Testing section) succeeds end-to-end: new package → edit → sandbox clean → publish → package visible in center UI.
4. `dotnet publish -c Release -r win-x64 --self-contained` produces a single .exe that runs on a clean Windows 11 VM without .NET runtime install.
5. Crash recovery: kill PackageDesigner mid-edit → relaunch → recovery dialog appears → restore succeeds → workspace state matches pre-crash.
6. Multi-package session: open 3 packages → edit each → publish one → close others → re-open → all state restored.