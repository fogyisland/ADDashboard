using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests.Manifest;

public class ManifestValidatorTests
{
    [Fact]
    public void Minimal_Valid_Manifest_Passes()
    {
        var m = new PackageManifest
        {
            Name = "ad-foo", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { Type = AgentType.Ad, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
        };
        var r = ManifestValidator.Validate(m);
        Assert.True(r.Valid, string.Join("; ", r.Errors));
    }

    [Fact]
    public void Missing_Version_Fails()
    {
        var m = new PackageManifest { Name = "ad-foo", Type = "gauge" };
        var r = ManifestValidator.Validate(m);
        Assert.False(r.Valid);
    }

    [Fact]
    public void Unknown_TopLevel_Field_Fails()
    {
        var json = "{\"name\":\"x\",\"version\":\"1.0.0\",\"type\":\"gauge\",\"junk\":1}";
        var r = ManifestValidator.ValidateJson(json);
        Assert.False(r.Valid);
    }

    // The three tests above come from the plan. The tests below guard schema
    // decisions this task had to make, which the plan's three do not reach.

    [Fact]
    public void Omitted_Version_Property_Fails()
    {
        // Missing_Version_Fails goes through the model, where Version defaults to
        // "" and is always emitted -- so it actually trips agent.intervalSec=0.
        // This exercises a genuinely absent "version" key.
        var json = "{\"name\":\"x\",\"type\":\"gauge\"}";
        var r = ManifestValidator.ValidateJson(json);
        Assert.False(r.Valid);
    }

    [Fact]
    public void Center_Only_Fields_Pass()
    {
        // Global Constraint #6: the local pre-flight must never reject a manifest
        // that center's ajv accepts. The WPF form does not edit author/license/
        // metrics/params/widget/center/dependencies, but imported packages carry
        // them, so the embedded schema must still accept them.
        var json = """
        {
          "name": "ad-foo",
          "version": "1.0.0",
          "type": "gauge",
          "description": "d",
          "author": "a",
          "license": "MIT",
          "agent": { "minVersion": "0.1.0", "script": "collect.ps1", "intervalSec": 60 },
          "center": { "minVersion": "1.0.0", "maxVersion": "2.0.0" },
          "metrics": [ { "key": "cpu_pct", "label": "CPU", "unit": "%", "thresholds": { "warn": 80, "crit": 95 } } ],
          "params": { "schema": { "type": "object" }, "required": ["host"] },
          "widget": { "type": "builtin", "component": "GaugeTile" },
          "dependencies": []
        }
        """;
        var r = ManifestValidator.ValidateJson(json);
        Assert.True(r.Valid, string.Join("; ", r.Errors));
    }

    [Fact]
    public void Database_Block_Round_Trips_Through_Model()
    {
        var m = NewValidManifest();
        m.Database = new DatabaseConfig
        {
            SchemaName = "pkg_ad_foo",
            Migrations = { "migrations/001_initial.sql" },
            MetricTable = "metrics",
            MetricSchema =
            {
                ["agent_id"] = new MetricDef { Type = "varchar(64)", Nullable = false },
                ["ts"] = new MetricDef { Type = "datetime", Nullable = false },
                ["cpu_pct"] = new MetricDef { Type = "double" }
            }
        };
        var r = ManifestValidator.Validate(m);
        Assert.True(r.Valid, string.Join("; ", r.Errors));
    }

    [Fact]
    public void Metric_Column_Of_Unknown_Type_Fails()
    {
        // The type vocabulary must stay pinned to ddl-sandbox normalizeType()
        // output, same as center/src/packages/manifest.js.
        var m = NewValidManifest();
        m.Database = new DatabaseConfig
        {
            SchemaName = "pkg_ad_foo",
            Migrations = { "migrations/001_initial.sql" },
            MetricTable = "metrics",
            MetricSchema =
            {
                ["agent_id"] = new MetricDef { Type = "varchar(64)", Nullable = false },
                ["ts"] = new MetricDef { Type = "datetime", Nullable = false },
                ["cpu_pct"] = new MetricDef { Type = "geometry" }
            }
        };
        var r = ManifestValidator.Validate(m);
        Assert.False(r.Valid);
    }

    private static PackageManifest NewValidManifest() => new()
    {
        Name = "ad-foo", Version = "1.0.0", Type = "gauge",
        Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
    };
}
