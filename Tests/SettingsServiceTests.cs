using System.IO;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class SettingsServiceTests
{
    [Fact]
    public void Default_Settings_Are_Empty()
    {
        var svc = new SettingsService(Path.Combine(Path.GetTempPath(), $"settings-{Guid.NewGuid():N}.json"));
        Assert.Equal("", svc.CenterUrl);
    }

    [Fact]
    public void Roundtrip_Settings()
    {
        var path = Path.Combine(Path.GetTempPath(), $"settings-{Guid.NewGuid():N}.json");
        try
        {
            var svc = new SettingsService(path);
            svc.CenterUrl = "https://c.example.com";
            svc.Save();
            var svc2 = new SettingsService(path);
            Assert.Equal("https://c.example.com", svc2.CenterUrl);
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }
}
