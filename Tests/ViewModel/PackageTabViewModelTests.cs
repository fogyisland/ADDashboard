using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class PackageTabViewModelTests
{
    [Fact]
    public void Ctor_Creates_Manifest_And_Migrations_VMs()
    {
        var p = new PackageProject();
        var vm = new PackageTabViewModel(p);
        Assert.NotNull(vm.ManifestVM);
        Assert.NotNull(vm.MigrationsVM);
        Assert.Same(p, vm.Project);
    }

    [Fact]
    public void OpenManifest_Adds_Tab_To_OpenFiles()
    {
        var vm = new PackageTabViewModel(new PackageProject());
        vm.OpenManifest();
        Assert.Single(vm.OpenFiles);
        Assert.Equal("manifest", vm.OpenFiles[0].Title);
    }
}