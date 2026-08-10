using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

/// <summary>
/// Reads and writes .pkgproj / .zip package files. The on-disk format is a
/// zip archive containing arbitrary entries (manifest.json + collect.ps1 +
/// migrations/*.sql + anything else the designer does not model directly).
/// Files are preserved verbatim in <see cref="PackageProject.RawFiles"/> so
/// unmodeled content is never lost on round trip.
///
/// The manifest.json deserializer uses <see cref="JsonStringEnumConverter"/>
/// with <see cref="JsonNamingPolicy.KebabCaseLower"/> so the
/// <c>agent.type</c> enum round-trips as <c>"ad"</c> / <c>"non-ad"</c>
/// matching center/src/packages/manifest.js — see
/// <see cref="ManifestValidator.SerializerOptions"/> for the canonical
/// configuration.
public static class PackageService
{
    private static readonly JsonSerializerOptions ReadOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
    };

    public static PackageProject ReadZip(Stream s)
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
                p.Manifest = JsonSerializer.Deserialize<PackageManifest>(content, ReadOptions) ?? new();
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

    public static void WriteZip(PackageProject p, Stream s)
    {
        using var zip = new ZipArchive(s, ZipArchiveMode.Create, leaveOpen: true);
        foreach (var (path, content) in p.RawFiles)
        {
            var entry = zip.CreateEntry(path);
            using var w = new StreamWriter(entry.Open(), Encoding.UTF8);
            w.Write(content);
        }
    }
}