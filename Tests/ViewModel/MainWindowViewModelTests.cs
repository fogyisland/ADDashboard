using PackageDesigner.Models;
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
        Assert.Null(vm.ActiveTab);
    }

    [Fact]
    public void Add_Tab_Sets_ActiveTab_To_Newest()
    {
        var vm = new MainWindowViewModel();
        var t1 = new PackageTabViewModel(new PackageProject());
        vm.OpenTabs.Add(t1);
        Assert.Same(t1, vm.ActiveTab);

        var t2 = new PackageTabViewModel(new PackageProject());
        vm.OpenTabs.Add(t2);
        Assert.Same(t2, vm.ActiveTab);
    }

    [Fact]
    public void Remove_Tab_Falls_Back_To_Last_Remaining()
    {
        var vm = new MainWindowViewModel();
        var t1 = new PackageTabViewModel(new PackageProject());
        var t2 = new PackageTabViewModel(new PackageProject());
        vm.OpenTabs.Add(t1);
        vm.OpenTabs.Add(t2);
        Assert.Same(t2, vm.ActiveTab);

        vm.OpenTabs.Remove(t2);
        Assert.Same(t1, vm.ActiveTab);
    }

    [Fact]
    public void ActiveTab_Setter_Raises_PropertyChanged()
    {
        // WPF TwoWay binding to SelectedItem requires INPC; otherwise VM→UI
        // push never happens and TabControl.SelectedItem stays null → blank.
        var vm = new MainWindowViewModel();
        var t1 = new PackageTabViewModel(new PackageProject());
        var fired = new System.Collections.Generic.List<string?>();
        vm.PropertyChanged += (_, e) => fired.Add(e.PropertyName);

        vm.ActiveTab = t1;
        Assert.Contains(nameof(vm.ActiveTab), fired);
    }
}
