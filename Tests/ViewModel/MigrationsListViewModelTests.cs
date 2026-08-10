using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class MigrationsListViewModelTests
{
    [Fact]
    public void Add_Creates_File_In_Project()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Database = new DatabaseConfig { SchemaName = "pkg_x", Migrations = new(), MetricTable = "m", MetricSchema = new() } }
        };
        var vm = new MigrationsListViewModel(p);
        vm.Add("migrations/001.sql");
        Assert.Single(vm.Items);
        Assert.Single(p.Manifest.Database!.Migrations);
    }

    [Fact]
    public void Remove_Drops_File()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Database = new DatabaseConfig { SchemaName = "pkg_x", Migrations = new() { "migrations/001.sql" }, MetricTable = "m", MetricSchema = new() } }
        };
        var vm = new MigrationsListViewModel(p);
        vm.Add("migrations/002.sql");
        vm.Remove(vm.Items[0]);
        Assert.Single(vm.Items);
        Assert.DoesNotContain("migrations/001.sql", p.Manifest.Database.Migrations);
    }
}