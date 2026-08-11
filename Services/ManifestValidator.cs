using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using NJsonSchema;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

public record ValidationResult(bool Valid, IReadOnlyList<string> Errors);

/// <summary>
/// Local pre-flight validation of a package manifest against the embedded copy
/// of center's manifest schema. This is advisory only: center's ajv check on
/// install is authoritative (Global Constraint #6). The embedded schema mirrors
/// center/src/packages/manifest.js so the pre-flight never rejects a manifest
/// center would accept.
/// </summary>
public static class ManifestValidator
{
    private const string SchemaResourceName = "PackageDesigner.Resources.manifest-schema.json";

    private static readonly Lazy<JsonSchema> LazySchema = new(Load, isThreadSafe: true);

    /// <summary>
    /// Serializer options producing center-compatible JSON: camelCase property
    /// names, nulls omitted, and enums as kebab-case strings so
    /// <see cref="AgentType.NonAd"/> becomes <c>"non-ad"</c>.
    /// </summary>
    public static JsonSerializerOptions SerializerOptions { get; } = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
    };

    private static JsonSchema Load()
    {
        var asm = Assembly.GetExecutingAssembly();
        using var stream = asm.GetManifestResourceStream(SchemaResourceName)
            ?? throw new InvalidOperationException($"embedded resource {SchemaResourceName} missing");
        using var reader = new StreamReader(stream);
        return JsonSchema.FromJsonAsync(reader.ReadToEnd()).GetAwaiter().GetResult();
    }

    public static ValidationResult Validate(PackageManifest manifest) =>
        ValidateJson(JsonSerializer.Serialize(manifest, SerializerOptions));

    public static ValidationResult ValidateJson(string json)
    {
        var errors = LazySchema.Value.Validate(json);
        return new ValidationResult(
            errors.Count == 0,
            errors.Select(e => $"{e.Path}: {e.Kind}").ToList());
    }
}
