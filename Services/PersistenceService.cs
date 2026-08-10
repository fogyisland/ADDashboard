using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

/// <summary>
/// Persists <see cref="PackageProject"/> as a .pkgproj JSON file. The on-disk
/// format is the single-file JSON representation of the project state used by
/// the WPF designer for save/load between sessions (T8's auto-save builds on
/// this). Writes are atomic per Global Constraint #7 (temp + rename) so a
/// crash mid-write can never leave a corrupt .pkgproj.
///
/// Serialization uses <see cref="JsonStringEnumConverter"/> with
/// <see cref="JsonNamingPolicy.KebabCaseLower"/> so the
/// <c>agent.type</c> enum round-trips as <c>"ad"</c> / <c>"non-ad"</c>
/// matching center/src/packages/manifest.js — see
/// <see cref="ManifestValidator.SerializerOptions"/> for the canonical
/// configuration.
/// </summary>
public static class PersistenceService
{
    private static readonly JsonSerializerOptions SaveOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
    };

    private static readonly JsonSerializerOptions LoadOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
    };

    public static void Save(PackageProject p, string path)
    {
        var dir = Path.GetDirectoryName(path) ?? ".";
        Directory.CreateDirectory(dir);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(p, SaveOptions));
        File.Move(temp, path, overwrite: true);
    }

    public static PackageProject Load(string path) =>
        JsonSerializer.Deserialize<PackageProject>(File.ReadAllText(path), LoadOptions) ?? new();
}