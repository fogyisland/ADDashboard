using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class NewPackageViewModelTests
{
    [Fact]
    public void Create_With_NonAd_Template_Overwrites_Name()
    {
        var vm = new NewPackageViewModel
        {
            Template = StarterTemplate.AdOsBaselineLite,
            PackageName = "my-custom-name"
        };
        var p = vm.Create();
        Assert.Equal("my-custom-name", p.Manifest.Name);
        Assert.Equal(AgentType.NonAd, p.Manifest.Agent.Type);
        Assert.NotNull(p.Manifest.Database);
    }

    [Fact]
    public void Create_With_Ad_Template_Has_Ad_Type()
    {
        var vm = new NewPackageViewModel
        {
            Template = StarterTemplate.AdMonitoringLite,
            PackageName = "x"
        };
        var p = vm.Create();
        Assert.Equal(AgentType.Ad, p.Manifest.Agent.Type);
    }
}
