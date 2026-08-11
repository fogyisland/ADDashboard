using System.Text.Json;
using PackageDesigner.Sandbox;
using Xunit;

namespace PackageDesigner.Tests.Sandbox;

public class SandboxGoldenTests
{
    public static IEnumerable<object[]> Cases()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", "sandbox-cases.json");
        var json = File.ReadAllText(path);
        var cases = JsonSerializer.Deserialize<List<Case>>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? new();
        foreach (var c in cases) yield return new object[] { c };
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Golden_Matches_NodeJs_Output(Case c)
    {
        var result = SandboxService.Scan(c.Sql, c.SelfPackage);
        Assert.Equal(c.ExpectedOk, result.Ok);
        if (!c.ExpectedOk)
        {
            Assert.Equal(c.ExpectedBlocked, result.Blocked);
        }
    }

    public class Case
    {
        public string Name { get; set; } = "";
        public string Sql { get; set; } = "";
        public string? SelfPackage { get; set; }
        public bool ExpectedOk { get; set; }
        public string? ExpectedBlocked { get; set; }
    }
}