using System.Linq;
using System.Text.RegularExpressions;
using PackageDesigner.Models;
using Xunit;

namespace PackageDesigner.Tests.Models;

public class MetricCatalogTests
{
    [Fact]
    public void All_Has_Five_Entries()
    {
        Assert.Equal(5, MetricCatalog.All.Count);
    }

    [Fact]
    public void All_Keys_Are_Unique()
    {
        var keys = MetricCatalog.All.Select(e => e.Key).ToList();
        Assert.Equal(keys.Count, keys.Distinct().Count());
    }

    [Fact]
    public void All_Has_Known_Core_Keys()
    {
        var keys = MetricCatalog.All.Select(e => e.Key).ToHashSet();
        Assert.Contains("cpu_pct", keys);
        Assert.Contains("memory_pct", keys);
        Assert.Contains("disk_free_pct", keys);
        Assert.Contains("service_status", keys);
        Assert.Contains("ad_repl_lag", keys);
    }

    [Fact]
    public void All_Entries_Have_NonEmpty_PowerShellSnippet()
    {
        foreach (var e in MetricCatalog.All)
            Assert.False(string.IsNullOrWhiteSpace(e.PowerShellSnippet), $"{e.Key} snippet empty");
    }

    [Fact]
    public void All_Entries_Have_Valid_SqlType()
    {
        // Mirrors the type vocabulary pinned by Resources/manifest-schema.json
        // (same as center/src/packages/manifest.js). Source of truth lives
        // there; this test pins the catalog to the schema.
        var pattern = new Regex(
            @"^(int|integer|bigint|smallint|tinyint|varchar\(\d+\)|char\(\d+\)|text|nvarchar\(\d+\)|ntext|double|float|decimal\(\d+,\d+\)|numeric\(\d+,\d+\)|datetime|timestamp|datetimeoffset|date|json|boolean|bit)$");
        foreach (var e in MetricCatalog.All)
            Assert.Matches(pattern, e.SqlType);
    }

    [Fact]
    public void TryGet_Returns_Entry_For_Known_Key()
    {
        foreach (var expected in MetricCatalog.All)
        {
            Assert.True(MetricCatalog.TryGet(expected.Key, out var actual));
            Assert.Same(expected, actual);
        }
    }

    [Fact]
    public void TryGet_Returns_False_For_Unknown_Key()
    {
        Assert.False(MetricCatalog.TryGet("nonexistent", out var entry));
        Assert.Null(entry);
    }
}
