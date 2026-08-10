using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class PowerShellFileViewModelTests
{
    [Fact]
    public void Body_Roundtrips()
    {
        var f = new PackageFile { Path = "collect.ps1", Role = "ps1" };
        var vm = new PowerShellFileViewModel(f);
        vm.Body = "Get-Process";
        Assert.Equal("Get-Process", vm.Body);
    }
}
