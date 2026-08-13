namespace PackageDesigner.Models;

/// <summary>
/// One entry in the built-in metric catalog. Every entry is a single source
/// of truth for: the metric key (column name + JSON key), label, unit, the
/// SQL column type to emit in migrations, the PowerShell snippet that
/// collects the metric, and default warn/crit thresholds. See
/// <see cref="MetricCatalog"/> for the 5 built-in entries.
/// </summary>
public sealed class MetricCatalogEntry
{
    public required string Key { get; init; }                 // "cpu_pct"
    public required string Label { get; init; }               // "CPU usage"
    public required string Unit { get; init; }                // "%"
    public required string SqlType { get; init; }             // "double"
    public required string Category { get; init; }            // "Host / Performance"
    public required string Description { get; init; }
    public required string PowerShellSnippet { get; init; }   // expression string
    public double? DefaultWarn { get; init; }
    public double? DefaultCrit { get; init; }
}
