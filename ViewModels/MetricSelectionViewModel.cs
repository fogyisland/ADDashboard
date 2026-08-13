using System;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;
using PackageDesigner.Services;

namespace PackageDesigner.ViewModels;

/// <summary>
/// One row in the metric editor's "Configured" pane. Wraps a
/// <see cref="MetricGenerator.Selection"/> (catalog entry + column def + user
/// overrides) and exposes editable fields. The <see cref="IsCustom"/> flag is
/// true for metrics loaded from a package that are not in the built-in
/// catalog — they are surfaced for visibility but cannot be re-generated
/// (GC #8). Setters mutate <see cref="Selection"/>'s <c>Overrides</c> record so
/// the generator emits the actual user value, not the catalog default (fix for
/// opus review finding C-1).
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
        get => Selection.Override?.Label ?? Selection.Catalog.Label;
        set
        {
            var ov = Selection.Override ?? new MetricGenerator.Overrides();
            Selection = Selection with { Override = ov with { Label = value } };
            OnChanged(); Changed?.Invoke(this, EventArgs.Empty);
        }
    }
    public string Unit
    {
        get => Selection.Override?.Unit ?? Selection.Catalog.Unit;
        set
        {
            var ov = Selection.Override ?? new MetricGenerator.Overrides();
            Selection = Selection with { Override = ov with { Unit = value } };
            OnChanged(); Changed?.Invoke(this, EventArgs.Empty);
        }
    }
    public double? Warn
    {
        get => Selection.Override?.Warn ?? Selection.Catalog.DefaultWarn;
        set
        {
            var ov = Selection.Override ?? new MetricGenerator.Overrides();
            Selection = Selection with { Override = ov with { Warn = value } };
            OnChanged(); Changed?.Invoke(this, EventArgs.Empty);
        }
    }
    public double? Crit
    {
        get => Selection.Override?.Crit ?? Selection.Catalog.DefaultCrit;
        set
        {
            var ov = Selection.Override ?? new MetricGenerator.Overrides();
            Selection = Selection with { Override = ov with { Crit = value } };
            OnChanged(); Changed?.Invoke(this, EventArgs.Empty);
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}