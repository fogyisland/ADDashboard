using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class MainWindowViewModelTests
{
    // NextUntitledName uses a session-static counter. Tests must NOT depend
    // on its initial value because xUnit may run tests in parallel and other
    // tests may have already incremented it. We only assert the contract:
    // monotonic, sequential, Chinese label, suffix increments.
    private static int ExtractSuffix(string name) =>
        int.Parse(System.Text.RegularExpressions.Regex.Match(name, @"\d+$").Value);

    [Fact]
    public void NextUntitledName_Returns_Chinese_Label_With_Suffix()
    {
        var vm = new MainWindowViewModel();
        var name = vm.NextUntitledName();
        Assert.StartsWith("未命名文档", name);
        Assert.True(ExtractSuffix(name) >= 1);
    }

    [Fact]
    public void NextUntitledName_Increments_Monotonically()
    {
        var vm = new MainWindowViewModel();
        var a = ExtractSuffix(vm.NextUntitledName());
        var b = ExtractSuffix(vm.NextUntitledName());
        var c = ExtractSuffix(vm.NextUntitledName());
        Assert.Equal(a + 1, b);
        Assert.Equal(b + 1, c);
    }

    [Fact]
    public void NextUntitledName_Across_VMs_Continues_Sequence()
    {
        // Counter is static → separate VM instances share the same sequence
        // (matches Office's app-wide Untitled1, Untitled2, ... behavior).
        var vm1 = new MainWindowViewModel();
        var n1 = ExtractSuffix(vm1.NextUntitledName());
        var vm2 = new MainWindowViewModel();
        var n2 = ExtractSuffix(vm2.NextUntitledName());
        Assert.Equal(n1 + 1, n2);
    }

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
