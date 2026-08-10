using System.IO;
using System.Text.Json;
namespace PackageDesigner.Services;

public class SettingsService
{
    private readonly string _path;
    public string CenterUrl { get; set; } = "";
    public string LastTemplate { get; set; } = "ad-monitoring-lite";

    public SettingsService(string path) { _path = path; Load(); }

    private record Persisted(string CenterUrl, string LastTemplate);

    public void Load()
    {
        if (!File.Exists(_path)) return;
        var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_path));
        if (p is null) return;
        CenterUrl = p.CenterUrl;
        LastTemplate = p.LastTemplate;
    }

    public void Save() => File.WriteAllText(_path,
        JsonSerializer.Serialize(new Persisted(CenterUrl, LastTemplate)));
}
