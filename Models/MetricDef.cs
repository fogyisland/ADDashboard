namespace PackageDesigner.Models;

/// <summary>
/// One column of <c>database.metricSchema</c>. <see cref="Type"/> must be one of
/// the canonical types emitted by ddl-sandbox normalizeType(); the embedded
/// schema pins the same vocabulary as center/src/packages/manifest.js.
/// </summary>
public class MetricDef
{
    public string Type { get; set; } = "";
    public bool? Nullable { get; set; }
}
