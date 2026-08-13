using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

/// <summary>
/// VM exposing the 8 editable fields of the package metadata strip in the
/// metric editor's top row. All mutations write through to the underlying
/// <see cref="PackageManifest"/> so the generator can re-derive the
/// <c>manifest.json</c> preview from the live state. INPC for every bound
/// property (Global Constraint #10).
/// </summary>
public sealed class PackageMetaViewModel : INotifyPropertyChanged
{
    private readonly PackageManifest _m;
    public PackageMetaViewModel(PackageManifest m)
    {
        _m = m;
        _m.Database ??= new DatabaseConfig();
    }

    public string Name { get => _m.Name; set { _m.Name = value; OnChanged(); } }
    public string Version { get => _m.Version; set { _m.Version = value; OnChanged(); } }
    public string? Description { get => _m.Description; set { _m.Description = value; OnChanged(); } }
    public AgentType AgentType
    {
        get => _m.Agent.Type;
        set { _m.Agent.Type = value; OnChanged(); }
    }
    public int IntervalSec
    {
        get => _m.Agent.IntervalSec;
        set { _m.Agent.IntervalSec = value; OnChanged(); }
    }
    public int? TimeoutMs
    {
        get => _m.Agent.TimeoutMs;
        set { _m.Agent.TimeoutMs = value; OnChanged(); }
    }
    public string SchemaName
    {
        get => _m.Database!.SchemaName;
        set { _m.Database!.SchemaName = value; OnChanged(); }
    }
    public string MetricTable
    {
        get => _m.Database!.MetricTable;
        set { _m.Database!.MetricTable = value; OnChanged(); }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}