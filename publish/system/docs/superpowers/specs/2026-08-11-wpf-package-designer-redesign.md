# WPF Package Designer — Metric-Centric Redesign

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Replace the WPF Package Designer's raw manifest form + raw SQL/PS1 editors
with a **metric-centric, template-driven editor**: the user picks from a
catalog of 5 built-in metrics (CPU%, memory%, disk free%, service status,
AD replication lag), configures thresholds, and the designer auto-generates
`manifest.json`, `migrations/001_initial.sql`, and `collect.ps1` from
those picks. Existing v2 package format on disk is preserved verbatim — the
agent runtime and center validation pipeline are unaffected.

## Background / Context

The current Package Designer exposes 3 tabs in the inner pane
(`ManifestFormView`, `MigrationsListView`, `SqlEditorView`,
`PowerShellEditorView`) that the user has to manually keep in sync: edit
manifest fields, write SQL by hand for migrations, write raw PowerShell
for `collect.ps1`. Manual testing flagged the experience as confusing
("Migrations 界面让人无所是从" — the migrations UI is bewildering) and the
workflow as error-prone (three places to keep in sync).

The redesign collapses these 3 tabs into one editor driven by a metric
catalog. Each catalog entry ships a PowerShell snippet; the generator
composes the final `collect.ps1` from the picked snippets. The
`migrations/001_initial.sql` is auto-generated from the picked metric
columns. The user's job: pick metrics, set thresholds, save. The system's
job: keep all three artifacts consistent.

## Architecture

Two new domain concepts sit between the user and the file output:

- **`MetricCatalog`** — static, embedded list of 5 metric entries. Each
  entry: `key`, `label`, `unit`, `sqlType`, `description`,
  `powerShellSnippet`, default `warn`/`crit`. Shipped as
  `MetricCatalog.All` in `Models/MetricCatalog.cs`.
- **`MetricGenerator`** — pure-function service that takes a manifest +
  picked metric selections + a database config and produces three strings:
  regenerated `manifest.json`, regenerated `migrations/001_initial.sql`,
  regenerated `collect.ps1`. No IO; caller writes via `PersistenceService`.

```
+--- MetricCatalog (static) ---+
| cpu_pct / memory_pct / ...   |
| powerShellSnippet per entry  |
+------------------------------+

                       +------- PackageManifest -------+
                       | name, version, type, agent... |
                       +-------------------------------+

                                       |
                                       v
                          +-----------+-----------+
                          |   MetricGenerator     |   (pure fn)
                          +----+----+----+----+----+
                               |    |    |
                  manifest.json |    |    |
             001_initial.sql   |    |    |
                 collect.ps1   |    |    |
                               |    |    |
                          (string outputs, no IO)
```

The view layer gets one new view: `MetricEditorView.xaml`. The existing
`ManifestFormView`, `MigrationsListView`, `SqlEditorView`,
`PowerShellEditorView` are deleted along with their code-behinds.

```
+--------------------------------------------------------------+
| [Package metadata strip: name / version / description /      |
|  agent type / interval / timeout / schema / table]           |
+----------------+----------------------+-----------------------+
|                |                      |                       |
|   CATALOG      |   CONFIGURED         |   PREVIEW             |
|   (5 metrics   |   METRICS            |   (3 tabs:            |
|    checkboxes) |   (picked metrics    |    manifest.json      |
|                |    with editable     |    001_initial.sql     |
|                |    thresholds/labels)|    collect.ps1)       |
|                |                      |                       |
+----------------+----------------------+-----------------------+
```

The PackageTabView's tree node collapses from 3 entries
(`manifest / migrations / collect.ps1`) to a single `package` node since
the new editor handles all three.

## Tech Stack

- **.NET 8 net8.0-windows**, WPF (existing)
- **C# 12**, xUnit 2.9.0 (existing)
- **MVVM** with manual `INotifyPropertyChanged` (existing pattern)
- **Self-contained win-x64** publish (existing)

## Global Constraints

1. **Format on disk is unchanged.** Generated `manifest.json`,
   `migrations/*.sql`, and `collect.ps1` are byte-for-byte compatible
   with the v2 package format. The agent runtime and center validation
   pipeline require no changes.
2. **Embedded catalog only.** `MetricCatalog.All` ships as a static
   class — no remote fetch, no disk-loaded overlay, no user-editable
   catalog JSON. To add a metric, edit code + ship a new build.
3. **Auto-generation is the only path.** No raw `manifest.json`,
   `migrations/*.sql`, or `collect.ps1` editor. Custom migrations beyond
   the auto-generated `001_initial.sql` are allowed, but they are added
   as opaque file paths (not edited in the designer).
4. **The old form is deleted.** `ManifestFormView`,
   `MigrationsListView`, `SqlEditorView`, `PowerShellEditorView`,
   `ManifestViewModel`, `MigrationsListViewModel` are removed.
6. **Generator is pure.** `MetricGenerator` is a static class with no
   IO, no state, no injected services. Inputs in, strings out. Tests
   cover it without mocks.
7. **Auto-001 is regenerated on every save.** User-added custom
   migrations (`002_add_ad.sql`, etc.) are preserved verbatim. The
   `001_initial.sql` is owned by the generator and rewritten whenever
   the set of picked metrics changes.
8. **Custom (unknown) metrics excluded from auto-PS1.** If a loaded
   package contains metrics not in the built-in catalog, the editor
   surfaces them as flagged `IsCustom` rows but does not generate PS1
   snippets for them (no source-of-truth snippet exists). The user sees
   a warning in the preview pane: "X custom metric(s) excluded from
   PS1 — pick from the catalog for full auto-generation."
9. **WPF parameterless constructor.** Every view with declarative XAML
   instantiation (`UserControl` declared in `PackageTabView.xaml`'s
   content template) gets a parameterless ctor; VM is read from
   `DataContext` (existing pattern, regression-tested).
10. **WPF TwoWay binding requires INPC.** Every VM property bound
    OneWay/TwoWay in XAML has setter + `PropertyChanged` (existing
    pattern, regression-tested).
11. **Preview regeneration runs synchronously** on the UI thread.
    Generator is <5 ms for 5 metrics; no debouncing.

## Components

### Models layer

**New file `Models/MetricCatalogEntry.cs`**:
```csharp
public sealed class MetricCatalogEntry
{
    public required string Key { get; init; }                 // "cpu_pct"
    public required string Label { get; init; }               // "CPU usage"
    public required string Unit { get; init; }                // "%"
    public required string SqlType { get; init; }             // "double"
    public required string Category { get; init; }            // "Host / Performance"
    public required string Description { get; init; }
    public required string PowerShellSnippet { get; init; }   // expression string
    public double? DefaultWarn { get; init; }
    public double? DefaultCrit { get; init; }
}
```

**New file `Models/MetricCatalog.cs`**:
```csharp
public static class MetricCatalog
{
    public static IReadOnlyList<MetricCatalogEntry> All { get; } = new[]
    {
        new MetricCatalogEntry
        {
            Key = "cpu_pct",
            Label = "CPU usage",
            Unit = "%",
            SqlType = "double",
            Category = "Host / Performance",
            Description = "Total processor utilization across all cores.",
            PowerShellSnippet = "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
            DefaultWarn = 80,
            DefaultCrit = 95,
        },
        new MetricCatalogEntry
        {
            Key = "memory_pct",
            Label = "Memory used",
            Unit = "%",
            SqlType = "double",
            Category = "Host / Performance",
            Description = "Percentage of visible memory in use.",
            PowerShellSnippet = "[math]::Round(($(Get-CimInstance Win32_OperatingSystem) | ForEach-Object { ($_.TotalVisibleMemorySize - $_.FreePhysicalMemory) / $_.TotalVisibleMemorySize * 100 })[0], 2)",
            DefaultWarn = 80,
            DefaultCrit = 95,
        },
        new MetricCatalogEntry
        {
            Key = "disk_free_pct",
            Label = "Disk free",
            Unit = "%",
            SqlType = "double",
            Category = "Host / Performance",
            Description = "Free space percentage on the system drive.",
            PowerShellSnippet = "[math]::Round((Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { ($_.Free / ($_.Used + $_.Free)) * 100 } | Measure-Object -Average).Average, 2)",
            DefaultWarn = 20,
            DefaultCrit = 10,
        },
        new MetricCatalogEntry
        {
            Key = "service_status",
            Label = "Critical services status",
            Unit = "",
            SqlType = "int",
            Category = "Host / Services",
            Description = "Count of running critical services (NTDS, DNS, KDC).",
            PowerShellSnippet = "(@('NTDS','DNS','KDC') | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue } | Where-Object { $_.Status -eq 'Running' }).Count",
            DefaultWarn = 2,
            DefaultCrit = 1,
        },
        new MetricCatalogEntry
        {
            Key = "ad_repl_lag",
            Label = "AD replication lag",
            Unit = "s",
            SqlType = "int",
            Category = "AD / Replication",
            Description = "Maximum replication lag in seconds across all partners.",
            PowerShellSnippet = "(Get-ADReplicationPartnerMetadata -Target * -ErrorAction SilentlyContinue | Measure-Object -Property LastReplicationResult -Maximum).Maximum / 1",
            DefaultWarn = 300,
            DefaultCrit = 900,
        },
    };

    public static bool TryGet(string key, out MetricCatalogEntry entry)
    {
        foreach (var e in All)
            if (e.Key == key) { entry = e; return true; }
        entry = null!;
        return false;
    }
}
```

**Existing models unchanged.** `MetricDef`, `PackageManifest`,
`AgentConfig`, `DatabaseConfig`, `PackageProject`, `PackageFile`,
`StarterTemplate` are reused without modification.

### Services layer

**New file `Services/MetricGenerator.cs`**:
```csharp
public static class MetricGenerator
{
    public sealed record Selection(MetricCatalogEntry Catalog, MetricDef Column);

    public static string GenerateManifestJson(
        PackageManifest m,
        IReadOnlyList<Selection> selections);

    public static string GenerateMigration001(
        string schemaName,
        string tableName,
        IReadOnlyList<Selection> selections);

    public static string GenerateCollectScript(
        IReadOnlyList<Selection> selections);
}
```

The generator emits:

- **`GenerateManifestJson`**: writes `metrics[]` (key, label, unit, thresholds),
  `database.metricSchema` (per-selection column type + nullable),
  `database.migrations` (`["migrations/001_initial.sql", ...custom]`),
  `agent.script = "collect.ps1"`, `agent.runtime = "powershell"`. Uses
  `JsonSerializerOptions { WriteIndented = true, Converters = { new
  JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) } }` matching
  `ManifestValidator.SerializerOptions`.
- **`GenerateMigration001`**: emits
  ```sql
  CREATE TABLE <schemaName>.<metricTable> (
    agent_id VARCHAR(64) NOT NULL,
    ts       DATETIME    NOT NULL,
    <key1> <sqlType1> NULL,
    <key2> <sqlType2> NULL,
    ...
  );
  ```
  One column per selection. Columns are NULLable (the agent writes
  nullable JSON values when a metric collection fails).
- **`GenerateCollectScript`**: emits
  ```powershell
  $ErrorActionPreference = 'Stop'
  $agent_id = $env:COMPUTERNAME
  $ts       = (Get-Date).ToUniversalTime().ToString('o')
  $metrics = [ordered]@{
    <key1> = <snippet1>
    <key2> = <snippet2>
    ...
  }
  @{ agent_id = $agent_id; ts = $ts; metrics = $metrics } | ConvertTo-Json -Compress
  ```
  Snippets are emitted verbatim (caller is responsible for ensuring the
  snippet is a valid PowerShell expression — the catalog is the source
  of truth and is validated by `MetricCatalogTests`).

**Modified `Services/StarterTemplateService.cs`**: the existing logic
stays; it returns a `PackageProject` and the caller decides how to
display it. No change needed since the VM does the reconciliation.

**Modified `Services/PersistenceService.cs`**: no API change. Save still
takes `(PackageProject, string filePath)` and writes the zip. Load still
returns a `PackageProject`. The editor handles auto/custom migration
split in-memory before calling Save.

### ViewModels layer

**New file `ViewModels/MetricEditorViewModel.cs`** — replaces
`ManifestViewModel` + `MigrationsListViewModel`:

```csharp
public sealed class MetricEditorViewModel : INotifyPropertyChanged
{
    public PackageProject Project { get; }
    public PackageMetaViewModel PackageMeta { get; }
    public ObservableCollection<MetricCatalogEntry> Catalog { get; }       // mirror of MetricCatalog.All
    public ObservableCollection<MetricSelectionViewModel> SelectedMetrics { get; } = new();
    public ObservableCollection<CustomMigrationViewModel> CustomMigrations { get; } = new();

    public string PreviewManifestJson { get; private set; } = "";
    public string PreviewMigrationSql { get; private set; } = "";
    public string PreviewCollectScript { get; private set; } = "";

    public bool HasValidationErrors => _validationErrors.Count > 0;
    public string ValidationMessage => string.Join("; ", _validationErrors);

    public MetricEditorViewModel(PackageProject project) { /* populate from project */ }
    public void ToggleMetric(MetricCatalogEntry entry);
    public void AddCustomMigration(string path);
    public void RemoveCustomMigration(CustomMigrationViewModel item);
    public ValidationResult SaveTo(string filePath);
}
```

`MetricSelectionViewModel` wraps a `MetricSelection` (catalog entry +
column def) and exposes editable: `Key` (locked), `Label`, `Unit`, `Warn`,
`Crit`. Editing any of these triggers the parent's regeneration. An
`IsCustom` flag marks loaded-but-unknown metrics.

`CustomMigrationViewModel` wraps a `(string Path, string Content)` pair
for user-added migrations. `Content` is read from disk on load; user can
edit `Content` inline (in a future enhancement, not v1).

`PackageMetaViewModel` exposes `Name`, `Version`, `Description`,
`AgentType`, `IntervalSec`, `TimeoutMs`, `SchemaName`, `MetricTable`.
Editing any of these triggers regeneration.

`MetricEditorViewModel` subscribes to `SelectedMetrics.CollectionChanged`
and to `MetricSelectionViewModel.PropertyChanged` for each child (forwarded
via `HookChildEvents`). On any change: re-runs all three generators, sets
the three `Preview*` properties (raises `PropertyChanged`), and re-runs
validation.

### Views layer

**New file `Views/MetricEditorView.xaml`** — UserControl, parameterless
ctor, DataContext = `MetricEditorViewModel`. Layout (top-down):

1. **Metadata strip** (top, ~80px tall, single Border):
   `PackageMeta.Name`, `Version`, `Description`, `AgentType` (ComboBox),
   `IntervalSec`, `TimeoutMs`, `SchemaName`, `MetricTable` — 8 fields in
   a 4-column grid.

2. **Body grid** (3-column split):
   - **Left** (`Width="280"`): `ListBox` bound to `Catalog`, `ItemTemplate`
     shows checkbox + label + tooltip with description + snippet preview.
   - **Middle** (`Width="*"`): `ListView` (or `DataGrid`) bound to
     `SelectedMetrics`. Columns: key (read-only), label (editable), unit
     (editable), warn (editable), crit (editable), IsCustom flag icon.
   - **Right** (`Width="420"`): `TabControl` with 3 tabs:
     - `manifest.json` — read-only styled TextBox bound to `PreviewManifestJson`.
     - `migrations/001_initial.sql` — bound to `PreviewMigrationSql`.
     - `collect.ps1` — bound to `PreviewCollectScript`.

3. **Custom migrations section** (below body): collapsible
   `Expander` titled "Custom migrations" with a `ListBox` of
   `CustomMigrations` and `+` / `−` buttons.

4. **Save row** (bottom): status text on left, Save / Save As buttons on
   right. Save button enabled only when `!HasValidationErrors`.

**Modified `Views/PackageTabView.xaml`**: tree collapses to:
```xml
<TreeView x:Name="Tree" BorderThickness="0" Background="Transparent"
          SelectedItemChanged="Tree_SelectedItemChanged">
  <TreeViewItem Header="package" x:Name="PackageNode" IsExpanded="True"/>
</TreeView>
```
The `Tree_SelectedItemChanged` code-behind calls
`ViewModel.OpenEditor()` which opens a single `MetricEditorTab`
containing `MetricEditorView`.

**Modified `ViewModels/PackageTabViewModel.cs`**: replace `ManifestTab`,
`SqlFileTab`, `Ps1FileTab` with a single `MetricEditorTab` containing
`MetricEditorViewModel`.

**Deleted files**:
- `Views/ManifestFormView.xaml(.cs)`
- `Views/MigrationsListView.xaml(.cs)`
- `Views/SqlEditorView.xaml(.cs)`
- `Views/PowerShellEditorView.xaml(.cs)`
- `ViewModels/ManifestViewModel.cs`
- `ViewModels/MigrationsListViewModel.cs`

## Data Flow

### Flow 1: Toggling a metric

```
[User clicks checkbox in Catalog list]
        |
        v
MetricEditorViewModel.ToggleMetric(MetricCatalogEntry entry)
        |
        +-- is entry in SelectedMetrics?
        |       yes: remove from SelectedMetrics
        |       no:  add MetricSelectionViewModel wrapping entry
        |
        v
SelectedMetrics.CollectionChanged ──> RegeneratePreviews()
        |
        v
MetricGenerator.GenerateManifestJson(...)
MetricGenerator.GenerateMigration001(...)
MetricGenerator.GenerateCollectScript(...)
        |
        v
PreviewManifestJson / PreviewMigrationSql / PreviewCollectScript setters
        |
        v
PropertyChanged ──> WPF TwoWay binding refreshes preview text blocks
```

### Flow 2: Editing a configured metric (thresholds, label)

```
[User edits warn/crit/label in Configured row]
        |
        v
MetricSelectionViewModel.Warn / Crit / Label setter
        |
        v
MetricSelectionViewModel.OnChanged ──> bubbling to parent
        |
        v
MetricEditorViewModel.OnSelectionPropertyChanged ──> RegeneratePreviews()
        |
        v
Same as Flow 1's preview update path
```

### Flow 3: Save

```
[User clicks Save]
        |
        v
MetricEditorViewModel.SaveTo(string filePath)
        |
        +-- Run ValidateBeforeSave()
        |       errs > 0 -> return ValidationResult.Failure(errs)
        |
        +-- Update Project:
        |       Project.Manifest = (manifest built from PackageMeta + selections)
        |       Project.Manifest.Database.Migrations = ["migrations/001_initial.sql", ...custom]
        |       Project.Manifest.Database.MetricSchema = selections map (key -> column def)
        |       Project.Manifest.Metrics = selections (label + warn + crit)
        |       Project.RawFiles = {
        |           "manifest.json"               -> GenerateManifestJson output
        |           "migrations/001_initial.sql"  -> GenerateMigration001 output
        |           "collect.ps1"                 -> GenerateCollectScript output
        |           "migrations/<custom>"         -> preserved from CustomMigrations
        |       }
        |
        +-- ManifestValidator.Validate(Project.Manifest)
        |       fail -> return ValidationResult.Failure(validator errors)
        |
        +-- PersistenceService.Save(Project, filePath)
        |       IO fail -> return ValidationResult.Failure("Save failed: ...")
        |
        v
ValidationResult.Success -> StatusText: "Saved to <path>"
```

## Error Handling

| Failure | Behavior |
|---|---|
| Name empty | Validation blocks save; `StatusText` shows "Name is required." |
| Version empty | Validation blocks save; `StatusText` shows "Version is required." |
| Zero metrics picked | Validation blocks save; `StatusText` shows "Pick at least 1 metric." |
| Duplicate metric keys | Validation blocks save; `StatusText` shows "Duplicate metric key: X, Y." |
| Schema name / metric table empty | Validation blocks save; `StatusText` shows the missing field name. |
| ManifestValidator fails on generated output | Validation blocks save; `StatusText` shows validator error. (Generator is tested to never produce invalid output; this is belt-and-suspenders.) |
| Loaded package has unknown metrics | `IsCustom = true` rows; PS1 preview shows warning header + excludes them from PS1. |
| Save IO failure | `StatusText`: "Save failed: <message>". Atomic write pattern in `PersistenceService` ensures no partial .pkgproj. |
| Open file IO failure | `StatusText`: "Could not open package: <message>". New package dialog remains available. |

Save button is disabled while `HasValidationErrors`. Hovering the
disabled button shows the validation message as a tooltip.

## Testing

Five test classes under `Tests/`. Pure functions + a few VM tests.

### `Tests/Models/MetricCatalogTests.cs`

| Test | Asserts |
|---|---|
| `All_Has_Five_Entries` | count == 5 |
| `All_Keys_Are_Unique` | no two entries share a Key |
| `All_Has_Known_Core_Keys` | contains cpu_pct, memory_pct, disk_free_pct, service_status, ad_repl_lag |
| `All_Entries_Have_NonEmpty_PowerShellSnippet` | every entry's snippet is not null/whitespace |
| `All_Entries_Have_Valid_SqlType` | every SqlType matches the regex from manifest-schema.json's metricSchema.type |
| `TryGet_Returns_Entry_For_Known_Key` | for each known Key, TryGet returns true with the matching entry |
| `TryGet_Returns_False_For_Unknown_Key` | TryGet("nonexistent", out _) == false |

### `Tests/Services/MetricGeneratorTests.cs`

| Test | Asserts |
|---|---|
| `GenerateManifestJson_Roundtrips_Through_Deserialize` | generated JSON deserializes to PackageManifest equal to input |
| `GenerateManifestJson_Includes_Selected_Metrics_With_Thresholds` | for each picked selection, deserialized manifest.metrics has matching key, label, unit, warn, crit |
| `GenerateManifestJson_Includes_Standard_Fields` | name, version, type, agent.script = "collect.ps1", database.metricTable, database.schemaName populated |
| `GenerateManifestJson_Passes_ManifestValidator` | generated JSON validates against the embedded schema |
| `GenerateMigration001_Creates_Table_With_SchemaName_And_MetricTable` | SQL contains `CREATE TABLE <schema>.<table>` |
| `GenerateMigration001_Includes_Agent_Id_And_Ts_Columns` | SQL contains `agent_id VARCHAR(64) NOT NULL` and `ts DATETIME NOT NULL` |
| `GenerateMigration001_One_Column_Per_Picked_Metric` | for each picked selection, SQL has the column with the catalog's SqlType |
| `GenerateMigration001_No_Extra_Columns_For_Unpicked_Metrics` | no column appears in SQL that wasn't picked |
| `GenerateMigration001_Respects_Nullable` | when selection.Column.Nullable == false, SQL has NOT NULL |
| `GenerateCollectScript_Imports_All_Picked_Metrics` | PS1 contains one `<key> = <snippet>` assignment per picked selection |
| `GenerateCollectScript_Outputs_Json_With_Metrics_Object` | PS1 ends with `@{ metrics = ... } | ConvertTo-Json -Compress` pattern |
| `GenerateCollectScript_No_Extra_Assignments_For_Unpicked_Metrics` | no assignment for unpicked keys |
| `GenerateCollectScript_Handles_Snippet_With_Single_Quotes` | snippets with `'` produce valid PS1 |
| `GenerateCollectScript_Handles_Snippet_With_Special_Characters` | snippets with `$` and `[]` produce valid PS1 syntax |
| `GenerateCollectScript_Adds_Default_Agent_Id_And_Timestamp` | PS1 includes agent_id and ts emission |

### `Tests/ViewModel/MetricEditorViewModelTests.cs`

| Test | Asserts |
|---|---|
| `Ctor_From_New_Project_Has_Empty_SelectedMetrics` | new project + VM -> SelectedMetrics.Count == 0 |
| `Ctor_From_Loaded_Package_Restores_SelectedMetrics_From_Manifest` | load package with 2 metrics in manifest -> VM has 2 selected |
| `ToggleMetric_Adds_To_SelectedMetrics_When_Not_Present` | toggling cpu_pct adds it |
| `ToggleMetric_Removes_From_SelectedMetrics_When_Present` | toggling again removes it |
| `ToggleMetric_Raises_Preview_Properties_Changed` | PreviewManifestJson / PreviewMigrationSql / PreviewCollectScript all raise PropertyChanged |
| `Editing_Threshold_Raises_Preview_Properties_Changed` | changing a selected metric's Warn re-fires preview PropertyChanged |
| `Editing_Package_Name_Raises_Preview_Properties_Changed` | changing PackageMeta.Name re-fires preview PropertyChanged |
| `Validate_BeforeSave_Fails_When_Name_Empty` | errs contains "Name is required." |
| `Validate_BeforeSave_Fails_When_No_Metrics_Picked` | errs contains "Pick at least 1 metric." |
| `Validate_BeforeSave_Fails_On_Duplicate_Metric_Keys` | errs contains "Duplicate metric key:" |
| `AddCustomMigration_Appends_To_CustomMigrations_And_Migrations_Path` | new path appears in both VM list and Project.Manifest.Database.Migrations |
| `RemoveCustomMigration_Removes_From_Both_Lists` | symmetric removal |
| `Load_With_Unknown_Metric_Marks_It_Custom` | loaded metric has IsCustom = true and PS1 excludes it |
| `Load_With_Unknown_Metric_Still_Updates_ManifestJson` | preview manifest still includes the unknown metric |

### `Tests/Integration/PackageProjectRoundTripTests.cs`

| Test | Asserts |
|---|---|
| `SaveThenLoad_Preserves_Selected_Metrics_And_Thresholds` | save -> load -> manifest.metrics matches |
| `SaveThenLoad_Preserves_Custom_Migrations` | after adding 002_add_ad.sql, save+load+assert path is in migrations and bytes match |
| `Save_Regenerates_Auto001_Even_If_It_Changed_Since_Load` | load, change selections, save -> loaded 001_initial.sql reflects new state |
| `SaveThenLoad_Produces_Valid_Manifest_Json` | re-loaded manifest still validates against ManifestValidator |

### `Tests/Services/PersistenceServiceTests.cs` (extend existing)

| Test | Asserts |
|---|---|
| `Save_Atomicity_On_IO_Failure` | simulate write failure mid-save -> no partial .pkgproj left |

### Test counts

- MetricCatalog: 7
- MetricGenerator: 15
- MetricEditorViewModel: 13
- Round-trip: 4
- PersistenceService: 1 (extension)

Net new: ~40 tests. Net deletions from removed VMs: ~10 tests
(ManifestFormViewTests, ManifestViewModelTests,
MigrationsListViewModelTests, etc.).

Final test target: same order of magnitude as the v2 Package Designer's
existing 73 tests — **net delta +30**, total **~103 tests**, all green.

## Migration Path

This section describes what gets deleted, what gets modified, and what
stays.

### Deleted
- `Views/ManifestFormView.xaml(.cs)` — replaced by the metadata strip in `MetricEditorView`
- `Views/MigrationsListView.xaml(.cs)` — replaced by `CustomMigrations` panel
- `Views/SqlEditorView.xaml(.cs)` — no longer needed (auto-generated SQL)
- `Views/PowerShellEditorView.xaml(.cs)` — no longer needed (auto-generated PS1)
- `ViewModels/ManifestViewModel.cs` — replaced by `MetricEditorViewModel`
- `ViewModels/MigrationsListViewModel.cs` — replaced by `MetricEditorViewModel.CustomMigrations`
- Corresponding test files for deleted VMs

### Modified
- `Views/PackageTabView.xaml` — tree collapses to single `package` node
- `Views/PackageTabView.xaml.cs` — `Tree_SelectedItemChanged` opens a single `MetricEditorTab`
- `ViewModels/PackageTabViewModel.cs` — replace `ManifestTab` / `SqlFileTab` / `Ps1FileTab` with `MetricEditorTab`
- `Services/PersistenceService.cs` — no API change; ensure atomic save pattern is preserved (already in place)
- `PackageDesigner.csproj` — AvalonEdit no longer needed (delete `PackageReference Include="AvalonEdit"`) if all editor views are deleted

### New
- `Models/MetricCatalogEntry.cs`
- `Models/MetricCatalog.cs`
- `Services/MetricGenerator.cs`
- `ViewModels/MetricEditorViewModel.cs`
- `ViewModels/MetricSelectionViewModel.cs`
- `ViewModels/CustomMigrationViewModel.cs`
- `ViewModels/PackageMetaViewModel.cs`
- `Views/MetricEditorView.xaml(.cs)`
- `Tests/Models/MetricCatalogTests.cs`
- `Tests/Services/MetricGeneratorTests.cs`
- `Tests/ViewModel/MetricEditorViewModelTests.cs`
- `Tests/Integration/PackageProjectRoundTripTests.cs`

### Unchanged
- All existing models (`PackageManifest`, `AgentConfig`, `DatabaseConfig`, `PackageProject`, `PackageFile`, `MetricDef`, `StarterTemplate`)
- `Services/StarterTemplateService.cs` (logic preserved; load path is the same)
- `Services/ManifestValidator.cs` (reused as-is for save-time validation)
- `Services/PublishService.cs`, `RecoveryService.cs`, `AutoSaveService.cs`, `CredentialService.cs`, `SettingsService.cs` — unchanged

## Acceptance Criteria

A change is shippable when ALL of the following hold:

1. `dotnet build PackageDesigner.csproj` — 0 warnings, 0 errors.
2. `dotnet test PackageDesigner.Tests.csproj` — all ~103 tests pass.
3. **Smoke 1 (visual):** Open Package Designer fresh, click "New
   package…", pick template, name it. The metric-centric editor
   appears with 3 panes (catalog / configured / preview). No raw
   manifest form, no raw SQL/PS1 editor visible.
4. **Smoke 2 (interaction):** Check `cpu_pct` and `memory_pct` in
   catalog. Configured metrics table shows 2 rows with default
   thresholds. The 3 preview tabs all re-render to show those 2
   metrics.
5. **Smoke 3 (overrides):** Edit `cpu_pct`'s warn to 75. The preview
   manifest's `metrics[]` reflects the new warn. The preview PS1 does
   not (PS1 doesn't include thresholds — it's just the collection
   script).
6. **Smoke 4 (custom migration):** Add a custom migration
   `002_add_ad_tables.sql` with content "CREATE TABLE foo (x int);".
   Save. Open the saved `.pkgproj` in a text editor (or unzip it):
   `manifest.json`'s `database.migrations` lists both paths; the zip
   contains both files. The auto-generated `001_initial.sql` reflects
   the picked metrics.
7. **Smoke 5 (round-trip):** Save the package, close the app, reopen
   the saved `.pkgproj`. The editor shows the same picked metrics
   with the same thresholds and the same custom migrations.
8. **Smoke 6 (publish compatibility):** Open the saved `.pkgproj` in
   a zip utility and verify the JSON validates against
   `Resources/manifest-schema.json`. Verify `collect.ps1` runs in
   PowerShell 5.1 and emits a JSON object with `agent_id`, `ts`, and
   `metrics` keys.
9. **Smoke 7 (validator integration):** Save with empty name fails
   with the validation message visible in the status bar; the .pkgproj
   is not written.

## Self-Review

1. **Spec coverage:** Every brainstorm section (architecture, components,
   data flow, error handling, testing) is mapped to a section of the
   spec with concrete file paths and class names. The user's three
   pieces of feedback (metric-centric, PS1 template, Migrations UI)
   are all addressed.
2. **Placeholder scan:** No "TBD", "TODO", or vague language. Every
   PowerShell snippet is included. Every test case has a clear name
   and assertion.
3. **Internal consistency:** The architecture diagram matches the
   components section (catalog + generator). The data flow uses the
   generator methods listed in components. The error handling
   references tests that are listed in testing.
4. **Scope check:** One focused spec for the Package Designer
   redesign. Implementation will be one plan with ~10-12 tasks.
5. **Ambiguity check:** "Auto-generate" is concretely defined as
   `MetricGenerator.GenerateManifestJson / GenerateMigration001 /
   GenerateCollectScript`. "Custom migration" is concretely defined as
   "user-added migration beyond 001, preserved verbatim in save".
   "Unknown metric" is concretely defined as "metric in
   manifest.metrics[] but not in MetricCatalog.All, flagged IsCustom".

## Execution Handoff

After spec approval, hand off to `superpowers:writing-plans` for the
implementation plan. Expected plan size: ~10-12 tasks:

1. Add MetricCatalog + MetricCatalogEntry + MetricCatalogTests
2. Add MetricGenerator (manifest JSON) + tests
3. Add MetricGenerator (001 migration SQL) + tests
4. Add MetricGenerator (collect.ps1) + tests
5. Add PackageMetaViewModel + MetricSelectionViewModel + CustomMigrationViewModel
6. Add MetricEditorViewModel + tests
7. Add MetricEditorView (XAML)
8. Modify PackageTabView + PackageTabViewModel for single tab
9. Delete old views/VMs + their tests
10. Build + republish + smoke test
11. Whole-branch review (opus)
12. Merge + push

After plan completion, re-dispatch the whole-branch review and run the
acceptance criteria smokes.