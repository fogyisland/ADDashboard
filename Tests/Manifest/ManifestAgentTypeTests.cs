using System.Text.Json;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests.Manifest;

public class ManifestAgentTypeTests
{
    [Fact]
    public void AgentType_NonAd_Serializes_As_SnakeCase_String()
    {
        var m = new PackageManifest
        {
            Name = "ad-os-baseline-lite", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
        };
        // Use the production SerializerOptions (camelCase + KebabCaseLower enums)
        // so the assertion `non-ad` actually matches what center's ajv expects.
        var json = JsonSerializer.Serialize(m, ManifestValidator.SerializerOptions);
        Assert.Contains("\"type\":\"non-ad\"", json);
    }

    [Fact]
    public void AgentType_Ad_Round_Trips_Through_Json()
    {
        var json = "{\"name\":\"x\",\"version\":\"1.0.0\",\"type\":\"gauge\",\"agent\":{\"type\":\"ad\",\"minVersion\":\"0.1.0\",\"script\":\"collect.ps1\",\"intervalSec\":60}}";
        var m = JsonSerializer.Deserialize<PackageManifest>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        });
        Assert.NotNull(m);
        Assert.Equal(AgentType.Ad, m!.Agent.Type);
    }

    [Fact]
    public void AgentType_Invalid_Value_Fails_Validation()
    {
        var json = "{\"name\":\"x\",\"version\":\"1.0.0\",\"type\":\"gauge\",\"agent\":{\"type\":\"weird\",\"minVersion\":\"0.1.0\",\"script\":\"collect.ps1\",\"intervalSec\":60}}";
        var r = ManifestValidator.ValidateJson(json);
        Assert.False(r.Valid);
    }
}