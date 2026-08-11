using System;
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
    public void Ctor_Auto_Opens_Manifest_Tab()
    {
        var vm = new PackageTabViewModel(new PackageProject());
        Assert.Single(vm.OpenFiles);
        Assert.Equal("manifest", vm.OpenFiles[0].Title);
    }

    [Fact]
    public void OpenManifest_Does_Not_Add_Duplicate_When_Tab_Already_Open()
    {
        // Regression: clicking the "manifest" tree node repeatedly used to stack
        // duplicate manifest tabs. After dedupe, re-opening focuses the same tab.
        var vm = new PackageTabViewModel(new PackageProject());
        Assert.Single(vm.OpenFiles);
        var first = vm.SelectedFile;
        vm.OpenManifest();
        Assert.Single(vm.OpenFiles);
        Assert.Same(first, vm.SelectedFile);
        vm.OpenManifest();
        Assert.Single(vm.OpenFiles);
    }

    [Fact]
    public void OpenSql_Dedupes_By_Same_File_Reference()
    {
        var vm = new PackageTabViewModel(new PackageProject());
        var f = new PackageFile { Path = "001_init.sql", Role = "migration" };
        var svm = new SqlFileViewModel(f);
        vm.OpenSql(svm);
        Assert.Equal(2, vm.OpenFiles.Count);  // manifest (auto) + sql
        var first = vm.SelectedFile;
        vm.OpenSql(svm);
        Assert.Equal(2, vm.OpenFiles.Count);
        Assert.Same(first, vm.SelectedFile);
    }

    [Fact]
    public void OpenPs1_Dedupes_By_Same_File_Reference()
    {
        var vm = new PackageTabViewModel(new PackageProject());
        var f = new PackageFile { Path = "collect.ps1", Role = "ps1" };
        var pvm = new PowerShellFileViewModel(f);
        vm.OpenPs1(pvm);
        Assert.Equal(2, vm.OpenFiles.Count);
        var first = vm.SelectedFile;
        vm.OpenPs1(pvm);
        Assert.Equal(2, vm.OpenFiles.Count);
        Assert.Same(first, vm.SelectedFile);
    }

    [Fact]
    public void PackageTabView_Has_Parameterless_Constructor()
    {
        // WPF XAML instantiates the view declaratively in MainWindow.xaml's
        // TabControl.ContentTemplate; this requires a parameterless ctor.
        // A VM-taking ctor alone causes XamlParseException at first render.
        var ctor = typeof(PackageDesigner.Views.PackageTabView).GetConstructor(Type.EmptyTypes);
        Assert.NotNull(ctor);
    }

    [Fact]
    public void Ctor_Auto_Selects_Manifest_Tab()
    {
        var vm = new PackageTabViewModel(new PackageProject());
        Assert.Same(vm.OpenFiles[0], vm.SelectedFile);
    }

    [Fact]
    public void SelectedFile_Setter_Raises_PropertyChanged_When_Changing_To_New_Value()
    {
        // WPF TwoWay binding to SelectedItem requires INPC; otherwise VM→UI
        // push never happens and TabControl.SelectedItem stays null → blank.
        var vm = new PackageTabViewModel(new PackageProject());
        // Ctor auto-opens Manifest tab → SelectedFile = ManifestTab.
        var original = vm.SelectedFile;
        Assert.NotNull(original);

        var fired = new System.Collections.Generic.List<string?>();
        vm.PropertyChanged += (_, e) => fired.Add(e.PropertyName);

        // Re-assign to same instance: no change → no event (reference equality guard).
        vm.SelectedFile = original;
        Assert.Empty(fired);

        // Build a non-null replacement by adding another tab — CollectionChanged handler
        // will set SelectedFile to the new tab, which must raise PropertyChanged.
        vm.OpenFiles.Add(new TestFileTab("manifest-2"));
        Assert.Contains(nameof(vm.SelectedFile), fired);
        Assert.NotSame(original, vm.SelectedFile);
    }

    private sealed class TestFileTab : FileTabViewModel
    {
        private readonly string _title;
        public TestFileTab(string title) { _title = title; }
        public override string Title => _title;
        public override object View => _title;
    }
}