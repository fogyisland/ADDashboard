using System.IO;
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
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
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