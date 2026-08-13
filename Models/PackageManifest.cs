namespace PackageDesigner.Models;

/// <summary>
/// The subset of a v2 package manifest the designer edits. Fields center accepts
/// but the designer does not edit (author, license, center, metrics, params,
/// widget, dependencies) are intentionally absent here — the embedded schema
/// still accepts them so imported packages validate, and the original JSON is
/// preserved verbatim by the package project's raw file store.
/// </summary>
public class PackageManifest
{
    public string Name { get; set; } = "";
    public string Version { get; set; } = "";
    public string Type { get; set; } = "gauge";
    public string? Description { get; set; }
    public AgentConfig Agent { get; set; } = new();
    public DatabaseConfig? Database { get; set; }

    /// <summary>
    /// Per-metric override values (Label/Unit/Warn/Crit). Editor-side only;
    /// never serialized into the shipped manifest.json (which is regenerated
    /// by <c>MetricGenerator</c> on each save and validated by
    /// <c>ManifestValidator</c>). Nullable so existing .pkgproj files
    /// deserialize cleanly — null/absent means "no overrides".
    /// </summary>
    public Dictionary<string, MetricOverride>? MetricOverrides { get; set; }
}
