using System.Linq;
using PackageDesigner.Models;
using PackageDesigner.Services;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

/// <summary>
/// Tests for <see cref="MetricSelectionViewModel"/>: per-row edit semantics
/// including write-through of the user override into the underlying
/// <see cref="MetricGenerator.Selection"/> record. These guard against the
/// silent-drop bug caught by opus review finding C-1, where setters raised
/// INPC/Changed but never persisted the value.
/// </summary>
public class MetricSelectionViewModelTests
{
    private static MetricSelectionViewModel NewCpu()
    {
        var cpu = MetricCatalog.All.First(e => e.Key == "cpu_pct");
        return new MetricSelectionViewModel(
            new MetricGenerator.Selection(cpu, new MetricDef { Type = "double" }),
            isCustom: false);
    }

    [Fact]
    public void Overrides_setter_persists_value()
    {
        var vm = NewCpu();
        // Before edit: getter returns the catalog default.
        Assert.Null(vm.Selection.Override);
        Assert.Equal(cpu_default_warn(), vm.Warn);

        // After edit: getter returns the new value AND the Selection record
        // carries an Overrides payload that survives a round trip through
        // the generator.
        vm.Warn = 75;
        Assert.NotNull(vm.Selection.Override);
        Assert.Equal(75, vm.Selection.Override!.Warn);
        Assert.Equal(75, vm.Warn);

        vm.Crit = 92;
        Assert.Equal(92, vm.Selection.Override.Crit);

        vm.Label = "My CPU";
        Assert.Equal("My CPU", vm.Selection.Override.Label);

        vm.Unit = "pct";
        Assert.Equal("pct", vm.Selection.Override.Unit);
    }

    [Fact]
    public void GenerateManifestJson_applies_overrides()
    {
        var vm = NewCpu();
        vm.Warn = 75;
        vm.Crit = 92;
        vm.Label = "My CPU";
        vm.Unit = "pct";

        // Drive the generator directly with the VM's selection — this is
        // what the editor's preview pane does on every change.
        var json = MetricGenerator.GenerateManifestJson(NewBareManifest(), new[] { vm.Selection });

        // Overrides must land in the emitted metrics[] block.
        Assert.Contains("\"warn\":75", json);
        Assert.Contains("\"crit\":92", json);
        Assert.Contains("\"label\":\"My CPU\"", json);
        Assert.Contains("\"unit\":\"pct\"", json);
    }

    [Fact]
    public void GenerateManifestJson_empty_label_falls_back_to_catalog()
    {
        var vm = NewCpu();
        vm.Label = "";  // empty => fall back to catalog Label
        var json = MetricGenerator.GenerateManifestJson(NewBareManifest(), new[] { vm.Selection });
        Assert.Contains("\"label\":\"" + MetricCatalog.All.First(e => e.Key == "cpu_pct").Label + "\"", json);
    }

    private static double? cpu_default_warn() =>
        MetricCatalog.All.First(e => e.Key == "cpu_pct").DefaultWarn;

    private static PackageManifest NewBareManifest() => new()
    {
        Name = "ad-foo", Version = "1.0.0", Type = "gauge",
        Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 },
        Database = new DatabaseConfig
        {
            SchemaName = "pkg_ad_foo",
            Migrations = new() { "migrations/001_initial.sql" },
            MetricTable = "metrics",
            MetricSchema = new(),
        },
    };
}
