using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class StarterTemplateTests
{
    [Fact]
    public void Ad_Template_Has_AgentType_Ad()
    {
        var p = StarterTemplateService.Load(StarterTemplate.AdMonitoringLite);
        Assert.Equal(AgentType.Ad, p.Manifest.Agent.Type);
    }

    [Fact]
    public void NonAd_Template_Has_AgentType_NonAd_And_Database_Block()
    {
        var p = StarterTemplateService.Load(StarterTemplate.AdOsBaselineLite);
        Assert.Equal(AgentType.NonAd, p.Manifest.Agent.Type);
        Assert.NotNull(p.Manifest.Database);
        Assert.StartsWith("pkg_", p.Manifest.Database!.SchemaName);
        // Migrations are stored with their relative path prefix (`migrations/...`);
        // match by suffix so the assertion stays robust if the path convention changes.
        Assert.Contains(p.Manifest.Database.Migrations, m => m.EndsWith("001_initial.sql"));
        Assert.Contains("cpu_pct", p.Manifest.Database.MetricSchema.Keys);
    }

    [Fact]
    public void Both_Templates_Have_Collect_Ps1()
    {
        foreach (var t in new[] { StarterTemplate.AdMonitoringLite, StarterTemplate.AdOsBaselineLite })
        {
            var p = StarterTemplateService.Load(t);
            Assert.Contains(p.Files, f => f.Path == "collect.ps1");
        }
    }
}