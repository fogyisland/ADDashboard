using System.IO;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class RecoveryServiceTests
{
    [Fact]
    public void Scan_Returns_Empty_When_No_Logs()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"recovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var entries = RecoveryService.Scan(dir);
            Assert.Empty(entries);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Scan_Returns_One_Entry_Per_Incomplete_Log()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"recovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "x.auto-save.log"),
                "{\"ts\":\"2026-08-09T12:00:00Z\",\"event\":\"incremental\",\"file\":\"manifest.json\"}\n");
            var entries = RecoveryService.Scan(dir);
            Assert.Single(entries);
            Assert.Equal("x.pkgproj", entries[0].ProjectName);
        }
        finally { Directory.Delete(dir, true); }
    }
}
