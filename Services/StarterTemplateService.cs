using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

/// <summary>
/// Loads a starter-template zip embedded as an <c>EmbeddedResource</c> in
/// the WPF assembly. The two templates ship binary blobs at
/// <c>Resources/templates/*.zip</c> and are referenced via the standard
/// MSBuild resource naming (project root namespace + relative path with
/// <c>/</c> replaced by <c>.</c>).
/// </summary>
public static class StarterTemplateService
{
    public static PackageProject Load(StarterTemplate which)
    {
        var name = which switch
        {
            StarterTemplate.AdMonitoringLite  => "PackageDesigner.Resources.templates.ad-monitoring-lite.zip",
            StarterTemplate.AdOsBaselineLite => "PackageDesigner.Resources.templates.ad-os-baseline-lite.zip",
            _ => throw new ArgumentOutOfRangeException(nameof(which))
        };
        var asm = Assembly.GetExecutingAssembly();
        using var s = asm.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"template {which} missing");
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        ms.Position = 0;
        return ReadEmbeddedZip(ms);
    }

    // Inline zip hydration: Task 4 will own the full PackageService.ReadZip
    // (with WriteZip and .pkgproj persistence); for T3 we only need to
    // materialise the embedded starter template into a PackageProject. The
    // KebabCaseLower enum policy mirrors ManifestValidator.SerializerOptions
    // so the round trip from the embedded manifest.json preserves the
    // `"non-ad"` literal that center's ajv expects.
    private static PackageProject ReadEmbeddedZip(Stream s)
    {
        var p = new PackageProject();
        using var zip = new ZipArchive(s, ZipArchiveMode.Read);
        foreach (var e in zip.Entries)
        {
            using var r = new StreamReader(e.Open());
            var content = r.ReadToEnd();
            p.RawFiles[e.FullName] = content;
            if (e.FullName == "manifest.json")
            {
                p.Manifest = JsonSerializer.Deserialize<PackageManifest>(content, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                    Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
                }) ?? new();
            }
        }
        p.Files = p.RawFiles.Keys.Select(path => new PackageFile
        {
            Path = path,
            Role = path switch
            {
                "manifest.json" => "manifest",
                "collect.ps1"   => "ps1",
                var x when x.StartsWith("migrations/") && x.EndsWith(".sql") => "migration",
                _ => "other"
            }
        }).ToList();
        return p;
    }
}