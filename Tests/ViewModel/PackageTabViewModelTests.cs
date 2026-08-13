using System;
using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class PackageTabViewModelTests
{
    private static PackageProject NewProject() => new()
    {
        Manifest = new PackageManifest
        {
            Name = "x", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 },
            Database = new DatabaseConfig
            {
                SchemaName = "pkg_x", Migrations = new() { "migrations/001_initial.sql" },
                MetricTable = "metrics", MetricSchema = new(),
            },
        },
    };

    [Fact]
    public void Ctor_Creates_Metric_Editor()
    {
        var p = NewProject();
        var vm = new PackageTabViewModel(p);
        Assert.NotNull(vm.MetricEditor);
        Assert.Same(p, vm.Project);
    }

    [Fact]
    public void Ctor_Auto_Opens_Metric_Editor_Tab()
    {
        var vm = new PackageTabViewModel(NewProject());
        Assert.Single(vm.OpenFiles);
        Assert.Equal("package", vm.OpenFiles[0].Title);
    }

    [Fact]
    public void OpenEditor_Does_Not_Add_Duplicate_When_Tab_Already_Open()
    {
        var vm = new PackageTabViewModel(NewProject());
        var first = vm.SelectedFile;
        vm.OpenEditor();
        Assert.Single(vm.OpenFiles);
        Assert.Same(first, vm.SelectedFile);
        vm.OpenEditor();
        Assert.Single(vm.OpenFiles);
    }

    [Fact]
    public void PackageTabView_Has_Parameterless_Constructor()
    {
        // WPF XAML instantiates the view declaratively in MainWindow.xaml's
        // TabControl.ContentTemplate; this requires a parameterless ctor.
        // A VM-taking ctor alone causes XamlParseException at first render
        // (Global Constraint #9).
        var ctor = typeof(PackageDesigner.Views.PackageTabView).GetConstructor(Type.EmptyTypes);
        Assert.NotNull(ctor);
    }

    [Fact]
    public void MetricEditorView_Has_Parameterless_Constructor()
    {
        // Same regression guard for the new editor view.
        var ctor = typeof(PackageDesigner.Views.MetricEditorView).GetConstructor(Type.EmptyTypes);
        Assert.NotNull(ctor);
    }

    [Fact]
    public void Ctor_Auto_Selects_Editor_Tab()
    {
        var vm = new PackageTabViewModel(NewProject());
        Assert.Same(vm.OpenFiles[0], vm.SelectedFile);
    }

    [Fact]
    public void SelectedFile_Setter_Raises_PropertyChanged_When_Changing_To_New_Value()
    {
        var vm = new PackageTabViewModel(NewProject());
        var original = vm.SelectedFile;
        Assert.NotNull(original);

        var fired = new System.Collections.Generic.List<string?>();
        vm.PropertyChanged += (_, e) => fired.Add(e.PropertyName);

        vm.SelectedFile = original;
        Assert.Empty(fired);

        vm.OpenFiles.Add(new TestFileTab("test"));
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
