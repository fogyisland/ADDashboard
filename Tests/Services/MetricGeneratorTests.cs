using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests.Services;

public class MetricGeneratorTests
{
    private static MetricGenerator.Selection Sel(string key, string label, string unit,
        string sqlType, double? warn, double? crit, bool? nullable = null) =>
        new(MetricCatalog.All.First(e => e.Key == key),
            new MetricDef { Type = sqlType, Nullable = nullable ?? true });

    private static PackageManifest NewManifest() => new()
    {
        Name = "ad-foo", Version = "1.0.0", Type = "gauge",
        Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60, Runtime = "powershell" },
        Database = new DatabaseConfig { SchemaName = "pkg_ad_foo", MetricTable = "metrics", Migrations = new() }
    };

    // ---------- GenerateManifestJson ----------

    [Fact]
    public void GenerateManifestJson_Roundtrips_Through_Deserialize()
    {
        var m = NewManifest();
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var json = MetricGenerator.GenerateManifestJson(m, sels);
        var back = JsonSerializer.Deserialize<PackageManifest>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower) }
        });
        Assert.NotNull(back);
        Assert.Equal("ad-foo", back!.Name);
        Assert.Equal("1.0.0", back.Version);
    }

    [Fact]
    public void GenerateManifestJson_Includes_Selected_Metrics_With_Thresholds()
    {
        var m = NewManifest();
        var sels = new List<MetricGenerator.Selection>
        {
            Sel("cpu_pct", "CPU", "%", "double", 80, 95),
            Sel("memory_pct", "Mem", "%", "double", 80, 95),
        };
        var json = MetricGenerator.GenerateManifestJson(m, sels);
        using var doc = JsonDocument.Parse(json);
        var metrics = doc.RootElement.GetProperty("metrics").EnumerateArray()
            .Select(e => (key: e.GetProperty("key").GetString()!,
                          label: e.GetProperty("label").GetString()!,
                          unit: e.GetProperty("unit").GetString()!,
                          warn: e.GetProperty("thresholds").GetProperty("warn").GetDouble(),
                          crit: e.GetProperty("thresholds").GetProperty("crit").GetDouble()))
            .ToList();
        Assert.Equal(2, metrics.Count);
        Assert.Contains(metrics, x => x.key == "cpu_pct" && x.label == "CPU usage" && x.unit == "%" && x.warn == 80 && x.crit == 95);
        Assert.Contains(metrics, x => x.key == "memory_pct" && x.label == "Memory used" && x.unit == "%" && x.warn == 80 && x.crit == 95);
    }

    [Fact]
    public void GenerateManifestJson_Includes_Standard_Fields()
    {
        var m = NewManifest();
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var json = MetricGenerator.GenerateManifestJson(m, sels);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("collect.ps1", doc.RootElement.GetProperty("agent").GetProperty("script").GetString());
        Assert.Equal("metrics", doc.RootElement.GetProperty("database").GetProperty("metricTable").GetString());
        Assert.Equal("pkg_ad_foo", doc.RootElement.GetProperty("database").GetProperty("schemaName").GetString());
    }

    [Fact]
    public void GenerateManifestJson_Passes_ManifestValidator()
    {
        var m = NewManifest();
        var sels = new List<MetricGenerator.Selection>
        {
            Sel("cpu_pct", "CPU", "%", "double", 80, 95),
            Sel("memory_pct", "Mem", "%", "double", 80, 95),
        };
        var json = MetricGenerator.GenerateManifestJson(m, sels);
        var r = ManifestValidator.ValidateJson(json);
        Assert.True(r.Valid, string.Join("; ", r.Errors));
    }

    // ---------- GenerateMigration001 ----------

    [Fact]
    public void GenerateMigration001_Creates_Table_With_SchemaName_And_MetricTable()
    {
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var sql = MetricGenerator.GenerateMigration001("pkg_ad_foo", "metrics", sels);
        Assert.Contains("CREATE TABLE pkg_ad_foo.metrics", sql);
    }

    [Fact]
    public void GenerateMigration001_Includes_Agent_Id_And_Ts_Columns()
    {
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var sql = MetricGenerator.GenerateMigration001("pkg_ad_foo", "metrics", sels);
        Assert.Contains("agent_id VARCHAR(64) NOT NULL", sql);
        Assert.Contains("ts DATETIME NOT NULL", sql);
    }

    [Fact]
    public void GenerateMigration001_One_Column_Per_Picked_Metric()
    {
        var sels = new List<MetricGenerator.Selection>
        {
            Sel("cpu_pct", "CPU", "%", "double", 80, 95),
            Sel("memory_pct", "Mem", "%", "double", 70, 90),
        };
        var sql = MetricGenerator.GenerateMigration001("pkg_ad_foo", "metrics", sels);
        Assert.Contains("cpu_pct double", sql);
        Assert.Contains("memory_pct double", sql);
    }

    [Fact]
    public void GenerateMigration001_No_Extra_Columns_For_Unpicked_Metrics()
    {
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var sql = MetricGenerator.GenerateMigration001("pkg_ad_foo", "metrics", sels);
        Assert.DoesNotContain("memory_pct", sql);
        Assert.DoesNotContain("disk_free_pct", sql);
    }

    [Fact]
    public void GenerateMigration001_Respects_Nullable()
    {
        var sels = new List<MetricGenerator.Selection>
        {
            new(MetricCatalog.All.First(e => e.Key == "cpu_pct"),
                new MetricDef { Type = "double", Nullable = false }),
        };
        var sql = MetricGenerator.GenerateMigration001("pkg_ad_foo", "metrics", sels);
        Assert.Contains("cpu_pct double NOT NULL", sql);
    }

    // ---------- GenerateCollectScript ----------

    [Fact]
    public void GenerateCollectScript_Imports_All_Picked_Metrics()
    {
        var sels = new List<MetricGenerator.Selection>
        {
            Sel("cpu_pct", "CPU", "%", "double", 80, 95),
            Sel("memory_pct", "Mem", "%", "double", 70, 90),
        };
        var ps1 = MetricGenerator.GenerateCollectScript(sels);
        Assert.Contains("cpu_pct = ", ps1);
        Assert.Contains("memory_pct = ", ps1);
    }

    [Fact]
    public void GenerateCollectScript_Outputs_Json_With_Metrics_Object()
    {
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var ps1 = MetricGenerator.GenerateCollectScript(sels);
        Assert.Contains("metrics = $metrics", ps1);
        Assert.Contains("ConvertTo-Json -Compress", ps1);
    }

    [Fact]
    public void GenerateCollectScript_No_Extra_Assignments_For_Unpicked_Metrics()
    {
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var ps1 = MetricGenerator.GenerateCollectScript(sels);
        Assert.DoesNotContain("memory_pct = ", ps1);
        Assert.DoesNotContain("disk_free_pct = ", ps1);
    }

    [Fact]
    public void GenerateCollectScript_Handles_Snippet_With_Single_Quotes()
    {
        // The four built-in catalog snippets include single quotes (e.g.,
        // Get-Counter '\\Processor...'). The generator must emit them as-is.
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var ps1 = MetricGenerator.GenerateCollectScript(sels);
        Assert.Contains("'\\Processor(_Total)\\% Processor Time'", ps1);
    }

    [Fact]
    public void GenerateCollectScript_Handles_Snippet_With_Special_Characters()
    {
        // memory_pct's snippet uses $(...) and $_ — the generator must emit
        // it verbatim so PowerShell can parse the result.
        var sels = new List<MetricGenerator.Selection> { Sel("memory_pct", "Mem", "%", "double", 70, 90) };
        var ps1 = MetricGenerator.GenerateCollectScript(sels);
        Assert.Contains("$(Get-CimInstance Win32_OperatingSystem)", ps1);
        Assert.Contains("$_", ps1);
    }

    [Fact]
    public void GenerateCollectScript_Adds_Default_Agent_Id_And_Timestamp()
    {
        var sels = new List<MetricGenerator.Selection> { Sel("cpu_pct", "CPU", "%", "double", 80, 95) };
        var ps1 = MetricGenerator.GenerateCollectScript(sels);
        Assert.Contains("$agent_id = $env:COMPUTERNAME", ps1);
        Assert.Contains("$ts = (Get-Date).ToUniversalTime().ToString('o')", ps1);
    }

    [Fact]
    public void GenerateManifestJson_Always_Emits_Runtime_Powershell_Even_When_Input_Is_Node()
    {
        var manifest = new PackageManifest
        {
            Name = "runtime-test", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60, Runtime = "node" },
            Database = new DatabaseConfig { SchemaName = "pkg_runtime_test", MetricTable = "metrics", MetricSchema = new() },
        };
        var json = MetricGenerator.GenerateManifestJson(manifest, System.Array.Empty<MetricGenerator.Selection>());
        Assert.Contains("\"runtime\":\"powershell\"", json);
        Assert.DoesNotContain("\"runtime\":\"node\"", json);
    }
}