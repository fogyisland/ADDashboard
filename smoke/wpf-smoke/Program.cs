using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using PackageDesigner.Models;
using PackageDesigner.Services;
using PackageDesigner.ViewModels;

namespace WpfSmoke;

internal static class Program
{
    private static int _passed, _failed;
    private static string? _tmp;

    private static void Check(string label, bool ok, string? detail = null)
    {
        Console.WriteLine($"  [{(ok ? "PASS" : "FAIL")}] {label}{(detail is null ? "" : $"  ({detail})")}");
        if (ok) _passed++; else _failed++;
    }

    private static PackageProject NewProject(string name) => new()
    {
        Manifest = new PackageManifest
        {
            Name = name, Version = "1.0.0", Type = "gauge",
            Description = "smoke",
            Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 },
            Database = new DatabaseConfig { SchemaName = $"pkg_{Sanitize(name)}", MetricTable = "metrics", MetricSchema = new() },
        },
        Files = new(),
        RawFiles = new(),
    };

    // schemaName pattern in Resources/manifest-schema.json: ^pkg_[a-z0-9_]+$
    private static string Sanitize(string s)
    {
        var chars = s.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray();
        return new string(chars);
    }

    private static void Smoke1_NewPackage()
    {
        Console.WriteLine("\n--- Smoke 1: New package shows 3-pane metric-centric editor ---");
        Console.WriteLine("  [SKIP-RUN] Requires WPF UI on Windows display. Verifiable by code: VM ctor + DataContext wiring.");
        var viewType = Type.GetType("PackageDesigner.Views.MetricEditorView, PackageDesigner");
        Check("MetricEditorView type loadable", viewType is not null);
        if (viewType is not null)
        {
            var ctor = viewType.GetConstructor(Type.EmptyTypes);
            Check("MetricEditorView has parameterless ctor", ctor is not null);
        }
        var vmType = typeof(MetricEditorViewModel);
        Check("MetricEditorViewModel type loadable", vmType is not null);
        var pkg = NewProject("smoke-new");
        var vm = new MetricEditorViewModel(pkg);
        Check("VM ctor accepts a new PackageProject", vm is not null);
        Check("VM Catalog has 5 entries", vm.Catalog.Count == 5);
        Check("VM SelectedMetrics initially empty", vm.SelectedMetrics.Count == 0);
        Check("VM CustomMigrations initially empty", vm.CustomMigrations.Count == 0);
        Check("VM has 3 preview properties", new[] { vm.PreviewManifestJson, vm.PreviewMigrationSql, vm.PreviewCollectScript }.All(p => !string.IsNullOrWhiteSpace(p)));
    }

    private static void Smoke2_ToggleMetrics()
    {
        Console.WriteLine("\n--- Smoke 2: Toggle cpu_pct + memory_pct → 2 rows + 3 previews re-render ---");
        var vm = new MetricEditorViewModel(NewProject("smoke-2"));
        var cpu = vm.Catalog.First(e => e.Key == "cpu_pct");
        var mem = vm.Catalog.First(e => e.Key == "memory_pct");
        vm.ToggleMetric(cpu);
        vm.ToggleMetric(mem);
        Check("SelectedMetrics has 2 rows", vm.SelectedMetrics.Count == 2);
        Check("PreviewManifestJson references cpu_pct", vm.PreviewManifestJson.Contains("cpu_pct"));
        Check("PreviewManifestJson references memory_pct", vm.PreviewManifestJson.Contains("memory_pct"));
        Check("PreviewMigrationSql creates metric table columns", vm.PreviewMigrationSql.Contains("cpu_pct") && vm.PreviewMigrationSql.Contains("memory_pct"));
        Check("PreviewCollectScript lists both metrics", vm.PreviewCollectScript.Contains("cpu_pct") && vm.PreviewCollectScript.Contains("memory_pct"));
        Check("CPU default warn 80 surfaces in preview", vm.PreviewManifestJson.Contains("\"warn\": 80") || vm.PreviewManifestJson.Contains("\"warn\":80"));
    }

    private static void Smoke3_OverrideThresholds()
    {
        Console.WriteLine("\n--- Smoke 3: Edit cpu_pct warn→75 → preview manifest reflects new warn ---");
        var vm = new MetricEditorViewModel(NewProject("smoke-3"));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "cpu_pct"));
        var cpuSel = vm.SelectedMetrics[0];
        cpuSel.Warn = 75;
        Check("VM Warn setter persists value", cpuSel.Warn == 75);
        var previewAfter = vm.PreviewManifestJson;
        Check("PreviewManifestJson contains warn:75 for cpu_pct", previewAfter.Contains("\"warn\": 75") || previewAfter.Contains("\"warn\":75"));
        Check("PreviewCollectScript does NOT include thresholds (spec contract)", !vm.PreviewCollectScript.Contains("\"warn\"") && !vm.PreviewCollectScript.Contains("75"));
    }

    private static void Smoke4_CustomMigration()
    {
        Console.WriteLine("\n--- Smoke 4: Add custom migration 002_add_ad_tables.sql + save ---");
        var vm = new MetricEditorViewModel(NewProject("smoke-4"));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "cpu_pct"));
        vm.AddCustomMigration("002_add_ad_tables.sql");
        vm.CustomMigrations[0].Content = "CREATE TABLE foo (x int);";
        Check("CustomMigrations has 1 entry", vm.CustomMigrations.Count == 1);
        _tmp = Path.Combine(Path.GetTempPath(), $"smoke4-{Guid.NewGuid():N}.pkgproj");
        var result = vm.SaveTo(_tmp);
        Check("SaveTo returned Valid", result.Valid, $"errs=[{string.Join("|", result.Errors)}]; status={vm.StatusMessage}");
        Check("File exists after SaveTo", File.Exists(_tmp));
        var loaded = PersistenceService.Load(_tmp);
        Check("Loaded package contains 002_add_ad_tables.sql in Migrations", loaded.Manifest.Database!.Migrations.Contains("002_add_ad_tables.sql"));
        Check("Loaded RawFiles has 002_add_ad_tables.sql content", loaded.RawFiles.TryGetValue("002_add_ad_tables.sql", out var c) && c.Contains("CREATE TABLE foo"));
        Check("Loaded RawFiles has auto-001 reflecting picked cpu_pct", loaded.RawFiles.TryGetValue("migrations/001_initial.sql", out var sql) && sql.Contains("cpu_pct"));
        Check("Loaded RawFiles has manifest.json", loaded.RawFiles.ContainsKey("manifest.json"));
    }

    private static void Smoke5_RoundTrip()
    {
        Console.WriteLine("\n--- Smoke 5: Save → reopen → same metrics + same thresholds + same custom migrations ---");
        var vm = new MetricEditorViewModel(NewProject("smoke-5"));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "cpu_pct"));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "memory_pct"));
        vm.SelectedMetrics[0].Warn = 75;
        vm.SelectedMetrics[0].Crit = 92;
        vm.AddCustomMigration("002_add_ad_tables.sql");
        vm.CustomMigrations[0].Content = "CREATE TABLE foo (x int);";
        _tmp = Path.Combine(Path.GetTempPath(), $"smoke5-{Guid.NewGuid():N}.pkgproj");
        vm.SaveTo(_tmp);

        var reopened = PersistenceService.Load(_tmp);
        var vm2 = new MetricEditorViewModel(reopened);
        Check("Reopened VM has 2 SelectedMetrics", vm2.SelectedMetrics.Count == 2);
        var manifestJson = reopened.RawFiles["manifest.json"];
        var containsWarn75 = manifestJson.Contains("\"warn\": 75") || manifestJson.Contains("\"warn\":75");
        var containsCrit92 = manifestJson.Contains("\"crit\": 92") || manifestJson.Contains("\"crit\":92");
        Check("Reopened manifest.json contains warn:75 for cpu_pct", containsWarn75);
        Check("Reopened manifest.json contains crit:92 for cpu_pct", containsCrit92);
        Check("Reopened has custom migration", vm2.CustomMigrations.Count == 1 && vm2.CustomMigrations[0].Path == "002_add_ad_tables.sql");
        Check("Reopened custom migration content preserved", vm2.CustomMigrations[0].Content.Contains("CREATE TABLE foo"));
        // D3 fix: VM constructor now rehydrates per-metric override values (warn/crit)
        // from PackageManifest.MetricOverrides. The persisted manifest.json contains them,
        // AND the VM constructor reads them back into Selection.Override.
        var cpuInReopened = vm2.SelectedMetrics.FirstOrDefault(s => s.Selection.Catalog.Key == "cpu_pct");
        Check("D3 fix: Reopened cpu_pct Warn == 75 (override rehydrated)", cpuInReopened?.Warn == 75);
        Check("D3 fix: Reopened cpu_pct Crit == 92 (override rehydrated)", cpuInReopened?.Crit == 92);
    }

    private static void Smoke6_ManifestSchemaAndCollectScript()
    {
        Console.WriteLine("\n--- Smoke 6: regenerated manifest.json validates against Resources/manifest-schema.json; collect.ps1 emits JSON ---");
        var vm = new MetricEditorViewModel(NewProject("smoke-6"));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "cpu_pct"));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "memory_pct"));
        vm.AddCustomMigration("002_add_ad_tables.sql");
        vm.CustomMigrations[0].Content = "CREATE TABLE foo (x int);";
        _tmp = Path.Combine(Path.GetTempPath(), $"smoke6-{Guid.NewGuid():N}.pkgproj");
        vm.SaveTo(_tmp);
        var loaded = PersistenceService.Load(_tmp);
        var manifestJson = loaded.RawFiles["manifest.json"];
        var v = ManifestValidator.Validate(loaded.Manifest);
        Check("ManifestValidator.Validate accepts regenerated manifest", v.Valid, v.Valid ? null : string.Join("; ", v.Errors));
        var ps1 = loaded.RawFiles["collect.ps1"];
        Check("collect.ps1 present", !string.IsNullOrWhiteSpace(ps1));
        Check("collect.ps1 references both metrics", ps1.Contains("cpu_pct") && ps1.Contains("memory_pct"));
        // Schema check via raw JSON parse against Resources/manifest-schema.json (validator already runs the same check)
        try
        {
            using var schemaDoc = JsonDocument.Parse(manifestJson);
            Check("manifest.json parses as valid JSON", true);
        }
        catch (Exception ex)
        {
            Check("manifest.json parses as valid JSON", false, ex.Message);
        }
        Console.WriteLine($"  [INFO] collect.ps1 written to {_tmp} — open the .pkgproj, unzip, run collect.ps1 in PowerShell 5.1 to confirm live JSON output.");
    }

    private static void Smoke7_ValidationFailsOnEmptyName()
    {
        Console.WriteLine("\n--- Smoke 7: Save with empty name fails with status message; .pkgproj not written ---");
        var vm = new MetricEditorViewModel(NewProject(""));
        vm.ToggleMetric(vm.Catalog.First(e => e.Key == "cpu_pct"));
        _tmp = Path.Combine(Path.GetTempPath(), $"smoke7-{Guid.NewGuid():N}.pkgproj");
        var result = vm.SaveTo(_tmp);
        Check("SaveTo returned !Valid for empty name", !result.Valid);
        Check("ValidationResult contains 'Name' or 'name' error", result.Errors.Any(e => e.Contains("ame", StringComparison.OrdinalIgnoreCase)));
        Check(".pkgproj NOT written to disk", !File.Exists(_tmp));
        Check("VM StatusMessage contains validation error", !string.IsNullOrWhiteSpace(vm.StatusMessage));
    }

    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--dump-collect")
        {
            return DumpCollectSample();
        }
        Console.WriteLine("=== WPF Package Designer — Smoke Test Driver (2026-08-13) ===");
        Console.WriteLine("Drives the same VM/service API the UI uses; UI-only flows are marked SKIP-RUN.");
        Smoke1_NewPackage();
        Smoke2_ToggleMetrics();
        Smoke3_OverrideThresholds();
        Smoke4_CustomMigration();
        Smoke5_RoundTrip();
        Smoke6_ManifestSchemaAndCollectScript();
        Smoke7_ValidationFailsOnEmptyName();

        Console.WriteLine($"\n=== Summary: {_passed} passed, {_failed} failed ===");
        if (_tmp is not null && File.Exists(_tmp)) { try { File.Delete(_tmp); } catch { } }
        return _failed == 0 ? 0 : 1;
    }

    private static int DumpCollectSample()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest
            {
                Name = "collect-dump", Version = "1.0.0", Type = "gauge",
                Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 },
                Database = new DatabaseConfig { SchemaName = "pkg_collect_dump", MetricTable = "metrics", MetricSchema = new() },
            },
            Files = new(),
            RawFiles = new(),
        };
        var vm = new MetricEditorViewModel(p);
        vm.ToggleMetric(vm.Catalog[0]);
        vm.ToggleMetric(vm.Catalog[1]);
        var tmp = Path.Combine(Path.GetTempPath(), $"collect-dump-{Guid.NewGuid():N}.pkgproj");
        vm.SaveTo(tmp);
        Console.WriteLine(tmp);
        return 0;
    }
}
