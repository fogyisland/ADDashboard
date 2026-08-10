using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class MainWindowViewModelTests
{
    [Fact]
    public void Ctor_Initializes_Empty_Tab_List()
    {
        var vm = new MainWindowViewModel();
        Assert.Empty(vm.OpenTabs);
    }
}