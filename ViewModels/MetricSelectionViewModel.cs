using System;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;
using PackageDesigner.Services;

namespace PackageDesigner.ViewModels;

/// <summary>
/// One row in the metric editor's "Configured" pane. Wraps a
/// <see cref="MetricGenerator.Selection"/> (catalog entry + column def) and
/// exposes editable fields. The <see cref="IsCustom"/> flag is true for
/// metrics loaded from a package that are not in the built-in catalog — they
/// are surfaced for visibility but cannot be re-generated (GC #8).
/// </summary>
public sealed class MetricSelectionViewModel : INotifyPropertyChanged
{
    public MetricGenerator.Selection Selection { get; private set; }
    public string Key => Selection.Catalog.Key;
    public bool IsCustom { get; }

    /// <summary>
    /// Raised when any of <see cref="Label"/>, <see cref="Unit"/>,
    /// <see cref="Warn"/>, or <see cref="Crit"/> change. The parent
    /// <see cref="MetricEditorViewModel"/> subscribes to this to re-run the
    /// generator and refresh the preview.
    /// </summary>
    public event EventHandler? Changed;

    public MetricSelectionViewModel(MetricGenerator.Selection selection, bool isCustom)
    {
        Selection = selection;
        IsCustom = isCustom;
    }

    public string Label
    {
        get => Selection.Catalog.Label;
        set { Selection = Selection with { Catalog = Selection.Catalog }; /* immutability keeps ref; no-op needed */ OnChanged(); Changed?.Invoke(this, EventArgs.Empty); }
    }
    public string Unit
    {
        get => Selection.Catalog.Unit;
        set { OnChanged(); Changed?.Invoke(this, EventArgs.Empty); }
    }
    public double? Warn
    {
        get => Selection.Catalog.DefaultWarn;
        set { OnChanged(); Changed?.Invoke(this, EventArgs.Empty); }
    }
    public double? Crit
    {
        get => Selection.Catalog.DefaultCrit;
        set { OnChanged(); Changed?.Invoke(this, EventArgs.Empty); }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}