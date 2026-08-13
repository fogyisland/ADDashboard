using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackageDesigner.Models;
using PackageDesigner.Services;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.Integration;

public class PackageProjectRoundTripTests
{
    private static PackageProject NewProject() => new()
    {
        Manifest = new PackageManifest
        {
            Name = "ad-foo", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 },
            Database = new DatabaseConfig
            {
                SchemaName = "pkg_ad_foo",
                Migrations = new() { "migrations/001_initial.sql" },
                MetricTable = "metrics",
                MetricSchema = new(),
            },
        },
        RawFiles = new(),
        Files = new(),
    };

    [Fact]
    public void SaveThenLoad_Preserves_Selected_Metrics_And_Thresholds()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var vm = new MetricEditorViewModel(NewProject());
            vm.ToggleMetric(MetricCatalog.All.First(e => e.Key == "cpu_pct"));
            vm.ToggleMetric(MetricCatalog.All.First(e => e.Key == "memory_pct"));
            vm.SelectedMetrics[0].Warn = 75;
            vm.SelectedMetrics[0].Crit = 92;
            vm.SaveTo(tmp);

            var loaded = PersistenceService.Load(tmp);
            // After round-trip, the loaded .pkgproj's manifest has the
            // auto-generated metricSchema with the two picked metrics.
            Assert.Contains("cpu_pct", loaded.Manifest.Database!.MetricSchema.Keys);
            Assert.Contains("memory_pct", loaded.Manifest.Database.MetricSchema.Keys);

            // The regenerated manifest.json on disk must carry the user-edited
            // thresholds for cpu_pct (and the untouched catalog defaults for
            // memory_pct). C-1 regression: previously the editor dropped these
            // values and only the catalog defaults were written.
            var raw = loaded.RawFiles["manifest.json"];
            var metricsArr = ParseMetricsBlock(raw);
            var cpuMetric = metricsArr.First(m => m.Key == "cpu_pct");
            var memMetric = metricsArr.First(m => m.Key == "memory_pct");
            Assert.Equal(75, cpuMetric.Thresholds?.Warn);
            Assert.Equal(92, cpuMetric.Thresholds?.Crit);
            // memory_pct was never edited => catalog default.
            Assert.Equal(MetricCatalog.All.First(e => e.Key == "memory_pct").DefaultWarn,
                memMetric.Thresholds?.Warn);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    [Fact]
    public void SaveThenLoad_Preserves_Edited_Label_And_Unit()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var vm = new MetricEditorViewModel(NewProject());
            vm.ToggleMetric(MetricCatalog.All.First(e => e.Key == "cpu_pct"));
            vm.SelectedMetrics[0].Label = "My CPU";
            vm.SelectedMetrics[0].Unit = "pct";
            vm.SaveTo(tmp);

            var loaded = PersistenceService.Load(tmp);
            var raw = loaded.RawFiles["manifest.json"];
            var metricsArr = ParseMetricsBlock(raw);
            var cpu = metricsArr.First(m => m.Key == "cpu_pct");
            Assert.Equal("My CPU", cpu.Label);
            Assert.Equal("pct", cpu.Unit);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    // Local DTO used only to introspect the regenerated manifest.json's
    // metrics[] block during a round-trip. Avoids a round-trip through the
    // full PackageManifest type (which strips Overrides via the column def).
    private sealed class MetricsBlockDto
    {
        public string Key { get; set; } = "";
        public string Label { get; set; } = "";
        public string? Unit { get; set; }
        public ThresholdsDto? Thresholds { get; set; }
    }
    private sealed class ThresholdsDto
    {
        public double? Warn { get; set; }
        public double? Crit { get; set; }
    }

    private static System.Collections.Generic.IEnumerable<MetricsBlockDto> ParseMetricsBlock(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var metrics = doc.RootElement.GetProperty("metrics");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(metrics);
        var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        return JsonSerializer.Deserialize<MetricsBlockDto[]>(bytes, opts)!;
    }

    [Fact]
    public void SaveThenLoad_Preserves_Custom_Migrations()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var vm = new MetricEditorViewModel(NewProject());
            vm.ToggleMetric(MetricCatalog.All.First(e => e.Key == "cpu_pct"));
            vm.AddCustomMigration("migrations/002_add_ad.sql");
            // Direct content injection because the editor doesn't open files.
            vm.CustomMigrations[0].Content = "CREATE TABLE foo (x int);";
            vm.SaveTo(tmp);

            var loaded = PersistenceService.Load(tmp);
            Assert.Contains("migrations/002_add_ad.sql", loaded.Manifest.Database!.Migrations);
            Assert.Contains("CREATE TABLE foo", loaded.RawFiles["migrations/002_add_ad.sql"]);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    [Fact]
    public void Save_Regenerates_Auto001_Even_If_It_Changed_Since_Load()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var vm = new MetricEditorViewModel(NewProject());
            vm.ToggleMetric(MetricCatalog.All.First(e => e.Key == "cpu_pct"));
            vm.SaveTo(tmp);
            var loaded = PersistenceService.Load(tmp);

            // Add a new metric to the loaded project, save again.
            var vm2 = new MetricEditorViewModel(loaded);
            vm2.ToggleMetric(MetricCatalog.All.First(e => e.Key == "memory_pct"));
            vm2.SaveTo(tmp);

            var reloaded = PersistenceService.Load(tmp);
            var sql = reloaded.RawFiles["migrations/001_initial.sql"];
            Assert.Contains("cpu_pct", sql);
            Assert.Contains("memory_pct", sql);
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    [Fact]
    public void SaveThenLoad_Produces_Valid_Manifest_Json()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var vm = new MetricEditorViewModel(NewProject());
            vm.ToggleMetric(MetricCatalog.All.First(e => e.Key == "cpu_pct"));
            vm.SaveTo(tmp);
            var loaded = PersistenceService.Load(tmp);
            var r = ManifestValidator.Validate(loaded.Manifest);
            Assert.True(r.Valid, string.Join("; ", r.Errors));
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }
}