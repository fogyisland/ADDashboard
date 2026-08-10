namespace PackageDesigner.Models;

/// <summary>
/// Agent runtime type. Serializes to the <c>agent.type</c> JSON strings
/// <c>"ad"</c> / <c>"non-ad"</c> (see <see cref="Services.ManifestValidator"/>
/// for the naming policy). Defaults to <see cref="Ad"/>, matching the
/// <c>default: 'ad'</c> in center/src/packages/manifest.js.
/// </summary>
public enum AgentType { Ad, NonAd }

public class AgentConfig
{
    public AgentType Type { get; set; } = AgentType.Ad;
    public string MinVersion { get; set; } = "";
    public List<string>? Platforms { get; set; }
    public string? Runtime { get; set; }
    public string Script { get; set; } = "";
    public int? TimeoutMs { get; set; }
    public int IntervalSec { get; set; }
}
