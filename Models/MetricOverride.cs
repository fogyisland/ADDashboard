namespace PackageDesigner.Models;

/// <summary>
/// Per-metric user overrides persisted on the editor side only (never
/// serialized to the shipped manifest.json). Null members mean "fall back
/// to the catalog default". Empty string for Label/Unit means "user cleared
/// it" — the generator still falls back to the catalog default in that case
/// (see Services/MetricGenerator.cs GenerateManifestJson override rule).
/// </summary>
public class MetricOverride
{
    public string? Label { get; set; }
    public string? Unit { get; set; }
    public double? Warn { get; set; }
    public double? Crit { get; set; }
}