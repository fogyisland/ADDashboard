using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackageDesigner.Models;
using PackageDesigner.Services;

namespace PackageDesigner.ViewModels;

/// <summary>
/// The single VM the new metric editor binds to. Owns the package metadata
/// strip, the catalog mirror, the picked-metrics list, the custom-migrations
/// list, and the three preview strings. All three generators run on every
/// change (GC #11) — they are pure and <5 ms for 5 metrics.
/// </summary>
public sealed class MetricEditorViewModel : INotifyPropertyChanged
{
    public PackageProject Project { get; }
    public PackageMetaViewModel PackageMeta { get; }
    public ObservableCollection<MetricCatalogEntry> Catalog { get; } =
        new(MetricCatalog.All);
    public ObservableCollection<MetricSelectionViewModel> SelectedMetrics { get; } = new();
    public ObservableCollection<CustomMigrationViewModel> CustomMigrations { get; } = new();

    private string _previewManifestJson = "";
    public string PreviewManifestJson
    {
        get => _previewManifestJson;
        private set { _previewManifestJson = value; OnChanged(); }
    }

    private string _previewMigrationSql = "";
    public string PreviewMigrationSql
    {
        get => _previewMigrationSql;
        private set { _previewMigrationSql = value; OnChanged(); }
    }

    private string _previewCollectScript = "";
    public string PreviewCollectScript
    {
        get => _previewCollectScript;
        private set { _previewCollectScript = value; OnChanged(); }
    }

    private readonly List<string> _validationErrors = new();
    public bool HasValidationErrors => _validationErrors.Count > 0;
    public string ValidationMessage => string.Join("; ", _validationErrors);

    private string _statusMessage = "";
    public string StatusMessage
    {
        get => _statusMessage;
        private set { _statusMessage = value; OnChanged(); }
    }

    public MetricEditorViewModel(PackageProject project)
    {
        Project = project;
        Project.Manifest.Database ??= new DatabaseConfig();
        PackageMeta = new PackageMetaViewModel(Project.Manifest);

        // Re-run regeneration on any change to the metadata strip.
        PackageMeta.PropertyChanged += (_, _) => RegeneratePreviews();

        // Re-run on add/remove of picked metrics.
        SelectedMetrics.CollectionChanged += (_, e) =>
        {
            // Wire per-item Changed event so editing thresholds re-runs preview.
            if (e.Action == NotifyCollectionChangedAction.Add)
                foreach (MetricSelectionViewModel item in e.NewItems!)
                    item.Changed += (_, _) => RegeneratePreviews();
            else if (e.Action == NotifyCollectionChangedAction.Remove)
                foreach (MetricSelectionViewModel item in e.OldItems!)
                    item.Changed -= (_, _) => RegeneratePreviews();
            else if (e.Action == NotifyCollectionChangedAction.Reset)
                // Collection was cleared; old-item references are gone with the GC.
                // Nothing to unsubscribe individually.
                ;
            RegeneratePreviews();
        };

        // Re-run on add/remove of custom migrations.
        CustomMigrations.CollectionChanged += (_, _) => RegeneratePreviews();

        // Populate SelectedMetrics from the loaded manifest's metrics[]
        // list. A metric is "custom" if its key is not in MetricCatalog.All.
        if (Project.Manifest.Database.MetricSchema is { } schema
            && schema.Count > 2)
        {
            foreach (var (key, def) in schema)
            {
                if (key == "agent_id" || key == "ts") continue;
                if (MetricCatalog.TryGet(key, out var entry))
                {
                    var item = new MetricSelectionViewModel(
                        new MetricGenerator.Selection(entry, def), isCustom: false);
                    item.Changed += (_, _) => RegeneratePreviews();
                    SelectedMetrics.Add(item);
                }
                else
                {
                    // Build a synthetic catalog entry so the VM still has a
                    // Catalog to render — the label comes from the user
                    // who authored the package, fall back to the key.
                    var item = new MetricSelectionViewModel(
                        new MetricGenerator.Selection(
                            new MetricCatalogEntry
                            {
                                Key = key,
                                Label = key,
                                Unit = "",
                                SqlType = def.Type,
                                Category = "Custom",
                                Description = "Loaded from package; not in built-in catalog.",
                                PowerShellSnippet = "null",
                            },
                            def),
                        isCustom: true);
                    item.Changed += (_, _) => RegeneratePreviews();
                    SelectedMetrics.Add(item);
                }
            }
        }

        // Populate CustomMigrations from anything in Database.Migrations
        // beyond the auto-001.
        foreach (var path in Project.Manifest.Database.Migrations)
        {
            if (path == "migrations/001_initial.sql") continue;
            var content = Project.RawFiles.TryGetValue(path, out var c) ? c : "";
            CustomMigrations.Add(new CustomMigrationViewModel(path, content));
        }

        RegeneratePreviews();
    }

    public void ToggleMetric(MetricCatalogEntry entry)
    {
        var existing = SelectedMetrics.FirstOrDefault(s => s.Key == entry.Key);
        if (existing is not null)
        {
            SelectedMetrics.Remove(existing);
        }
        else
        {
            var item = new MetricSelectionViewModel(
                new MetricGenerator.Selection(entry, new MetricDef { Type = entry.SqlType, Nullable = true }),
                isCustom: false);
            SelectedMetrics.Add(item);
            item.Changed += (_, _) => RegeneratePreviews();
        }
    }

    public void AddCustomMigration(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        if (CustomMigrations.Any(m => m.Path == path)) return;
        Project.RawFiles.TryGetValue(path, out var content);
        CustomMigrations.Add(new CustomMigrationViewModel(path, content ?? ""));
        Project.Manifest.Database.Migrations.Add(path);
    }

    public void RemoveCustomMigration(CustomMigrationViewModel item)
    {
        CustomMigrations.Remove(item);
        Project.Manifest.Database.Migrations.Remove(item.Path);
    }

    public void RegeneratePreviews()
    {
        var selections = SelectedMetrics
            .Select(vm => vm.Selection)
            .ToList();

        var cloned = CloneManifest(Project.Manifest);
        PreviewManifestJson = MetricGenerator.GenerateManifestJson(cloned, selections);
        PreviewMigrationSql = MetricGenerator.GenerateMigration001(
            PackageMeta.SchemaName, PackageMeta.MetricTable, selections);
        PreviewCollectScript = MetricGenerator.GenerateCollectScript(selections);
    }

    public IReadOnlyList<string> ValidateBeforeSave()
    {
        _validationErrors.Clear();
        if (string.IsNullOrWhiteSpace(PackageMeta.Name))
            _validationErrors.Add("Name is required.");
        if (string.IsNullOrWhiteSpace(PackageMeta.Version))
            _validationErrors.Add("Version is required.");
        if (SelectedMetrics.Count == 0)
            _validationErrors.Add("Pick at least 1 metric.");
        var dupKeys = SelectedMetrics.GroupBy(s => s.Key).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        if (dupKeys.Count > 0)
            _validationErrors.Add($"Duplicate metric key: {string.Join(", ", dupKeys)}.");
        if (string.IsNullOrWhiteSpace(PackageMeta.SchemaName))
            _validationErrors.Add("Schema name is required.");
        if (string.IsNullOrWhiteSpace(PackageMeta.MetricTable))
            _validationErrors.Add("Metric table is required.");
        OnChanged(nameof(HasValidationErrors));
        OnChanged(nameof(ValidationMessage));
        return _validationErrors;
    }

    public ValidationResult SaveTo(string filePath)
    {
        var errs = ValidateBeforeSave();
        if (errs.Count > 0)
        {
            StatusMessage = errs[0];
            return new ValidationResult(false, errs);
        }
        // Build the project's Manifest from the current VM state.
        var selections = SelectedMetrics.Select(s => s.Selection).ToList();
        var json = MetricGenerator.GenerateManifestJson(Project.Manifest, selections);
        var draft = JsonSerializer.Deserialize<PackageManifest>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
        }) ?? new PackageManifest();
        // Inject the auto-001 at the head of Migrations, custom migrations after.
        var migrations = new List<string> { "migrations/001_initial.sql" };
        migrations.AddRange(CustomMigrations.Select(m => m.Path));
        draft.Database ??= new DatabaseConfig();
        draft.Database.Migrations = migrations;
        // Refresh RawFiles: auto-001 + auto-collect.ps1 + custom migrations.
        var rawFiles = new Dictionary<string, string>(Project.RawFiles);
        rawFiles["manifest.json"] = json;
        rawFiles["migrations/001_initial.sql"] = MetricGenerator.GenerateMigration001(
            PackageMeta.SchemaName, PackageMeta.MetricTable, selections);
        // Custom (unknown) metrics are excluded from the auto-PS1 (GC #8).
        var ps1Selections = selections
            .Where(s => MetricCatalog.TryGet(s.Catalog.Key, out _))
            .ToList();
        rawFiles["collect.ps1"] = MetricGenerator.GenerateCollectScript(ps1Selections);
        foreach (var cm in CustomMigrations)
            rawFiles[cm.Path] = cm.Content;
        var updated = new PackageProject
        {
            Manifest = draft,
            Files = Project.Files,
            RawFiles = rawFiles,
            LastPublishedAt = Project.LastPublishedAt,
        };
        var validatorResult = ManifestValidator.Validate(updated.Manifest);
        if (!validatorResult.Valid)
        {
            StatusMessage = $"Save failed: {string.Join("; ", validatorResult.Errors)}";
            return new ValidationResult(false, validatorResult.Errors);
        }
        try
        {
            PersistenceService.Save(updated, filePath);
        }
        catch (Exception ex)
        {
            StatusMessage = $"Save failed: {ex.Message}";
            return new ValidationResult(false, new[] { ex.Message });
        }
        StatusMessage = $"Saved to {filePath}";
        return new ValidationResult(true, Array.Empty<string>());
    }

    private static PackageManifest CloneManifest(PackageManifest m) => new()
    {
        Name = m.Name, Version = m.Version, Type = m.Type, Description = m.Description,
        Agent = new AgentConfig
        {
            Type = m.Agent.Type, MinVersion = m.Agent.MinVersion,
            Platforms = m.Agent.Platforms?.ToList(),
            Runtime = m.Agent.Runtime, Script = m.Agent.Script,
            TimeoutMs = m.Agent.TimeoutMs, IntervalSec = m.Agent.IntervalSec,
        },
        Database = m.Database is null ? null : new DatabaseConfig
        {
            SchemaName = m.Database.SchemaName,
            Migrations = m.Database.Migrations.ToList(),
            MetricTable = m.Database.MetricTable,
            MetricSchema = m.Database.MetricSchema.ToDictionary(kv => kv.Key, kv => kv.Value),
        },
    };

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
