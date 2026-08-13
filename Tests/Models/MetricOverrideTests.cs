using PackageDesigner.Models;
using Xunit;

namespace PackageDesigner.Tests.Models;

public class MetricOverrideTests
{
    [Fact]
    public void Defaults_All_Null()
    {
        var o = new MetricOverride();
        Assert.Null(o.Label);
        Assert.Null(o.Unit);
        Assert.Null(o.Warn);
        Assert.Null(o.Crit);
    }

    [Fact]
    public void Can_Set_All_Fields()
    {
        var o = new MetricOverride { Label = "My CPU", Unit = "%", Warn = 75, Crit = 92 };
        Assert.Equal("My CPU", o.Label);
        Assert.Equal("%", o.Unit);
        Assert.Equal(75, o.Warn);
        Assert.Equal(92, o.Crit);
    }

    [Fact]
    public void Empty_Label_Distinct_From_Null()
    {
        var withEmpty = new MetricOverride { Label = "" };
        var withNull = new MetricOverride { Label = null };
        Assert.NotEqual(withEmpty.Label, withNull.Label);
        Assert.Equal("", withEmpty.Label);
        Assert.Null(withNull.Label);
    }
}