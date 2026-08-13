using PackageDesigner.Models;
using Xunit;

namespace PackageDesigner.Tests.Models;

public class PackageManifestTests
{
    [Fact]
    public void MetricOverrides_Defaults_To_Null()
    {
        var m = new PackageManifest();
        Assert.Null(m.MetricOverrides);
    }

    [Fact]
    public void MetricOverrides_Can_Be_Set_To_Empty_Dictionary()
    {
        var m = new PackageManifest { MetricOverrides = new() };
        Assert.NotNull(m.MetricOverrides);
        Assert.Empty(m.MetricOverrides);
    }

    [Fact]
    public void MetricOverrides_Can_Store_One_Metric()
    {
        var m = new PackageManifest
        {
            MetricOverrides = new()
            {
                ["cpu_pct"] = new MetricOverride { Warn = 75, Crit = 92 }
            }
        };
        Assert.True(m.MetricOverrides!.ContainsKey("cpu_pct"));
        Assert.Equal(75, m.MetricOverrides["cpu_pct"].Warn);
    }
}
