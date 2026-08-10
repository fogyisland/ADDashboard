using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class ManifestViewModel : INotifyPropertyChanged
{
    private readonly PackageManifest _m;
    public PackageManifest Model => _m;

    public ManifestViewModel() : this(new PackageManifest()) { }

    public ManifestViewModel(PackageManifest m)
    {
        _m = m;
        if (m.Database is not null) foreach (var x in m.Database.Migrations) Migrations.Add(x);
    }

    public string Name { get => _m.Name; set { _m.Name = value; OnChanged(); } }
    public string Version { get => _m.Version; set { _m.Version = value; OnChanged(); } }
    public string Type { get => _m.Type; set { _m.Type = value; OnChanged(); } }
    public string? Description { get => _m.Description; set { _m.Description = value; OnChanged(); } }

    public AgentType AgentType
    {
        get => _m.Agent.Type;
        set { _m.Agent.Type = value; OnChanged(); }
    }

    public string MinVersion { get => _m.Agent.MinVersion; set { _m.Agent.MinVersion = value; OnChanged(); } }
    public string Script { get => _m.Agent.Script; set { _m.Agent.Script = value; OnChanged(); } }
    public int IntervalSec { get => _m.Agent.IntervalSec; set { _m.Agent.IntervalSec = value; OnChanged(); } }
    public int? TimeoutMs { get => _m.Agent.TimeoutMs; set { _m.Agent.TimeoutMs = value; OnChanged(); } }

    public string SchemaName
    {
        get => _m.Database?.SchemaName ?? "";
        set { EnsureDatabase().SchemaName = value; OnChanged(); }
    }
    public string MetricTable
    {
        get => _m.Database?.MetricTable ?? "";
        set { EnsureDatabase().MetricTable = value; OnChanged(); }
    }
    public ObservableCollection<string> Migrations { get; } = new();

    private DatabaseConfig EnsureDatabase() => _m.Database ??= new DatabaseConfig();

    public string NewMigrationPath { get; set; } = "";
    public void AddMigration()
    {
        if (string.IsNullOrWhiteSpace(NewMigrationPath)) return;
        EnsureDatabase().Migrations.Add(NewMigrationPath);
        Migrations.Add(NewMigrationPath);
        NewMigrationPath = "";
        OnChanged();
    }
    public void RemoveMigration(string path)
    {
        EnsureDatabase().Migrations.Remove(path);
        Migrations.Remove(path);
        OnChanged();
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}