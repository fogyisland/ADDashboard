using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class ManifestViewModelTests
{
    [Fact]
    public void AgentType_Roundtrips_Through_Property()
    {
        var m = new PackageManifest
        {
            Name = "x", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
        };
        var vm = new ManifestViewModel(m);
        Assert.Equal(AgentType.Ad, vm.AgentType);
        vm.AgentType = AgentType.NonAd;
        Assert.Equal(AgentType.NonAd, m.Agent.Type);
    }

    [Fact]
    public void AddMigration_Appends_To_List()
    {
        var m = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge" };
        var vm = new ManifestViewModel(m);
        vm.NewMigrationPath = "migrations/002_add_index.sql";
        vm.AddMigration();
        Assert.Contains("migrations/002_add_index.sql", m.Database!.Migrations);
    }

    [Fact]
    public void RemoveMigration_Removes_From_List()
    {
        var m = new PackageManifest
        {
            Name = "x", Version = "1.0.0", Type = "gauge",
            Database = new DatabaseConfig { SchemaName = "pkg_x", Migrations = new() { "migrations/001.sql", "migrations/002.sql" }, MetricTable = "metrics", MetricSchema = new() }
        };
        var vm = new ManifestViewModel(m);
        vm.RemoveMigration("migrations/001.sql");
        Assert.DoesNotContain("migrations/001.sql", m.Database.Migrations);
        Assert.Single(m.Database.Migrations);
    }
}