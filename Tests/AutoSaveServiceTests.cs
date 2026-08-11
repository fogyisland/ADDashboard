using System.IO;
using System.Threading.Tasks;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class AutoSaveServiceTests
{
    [Fact]
    public async Task SaveIfDirty_Persists_When_Project_Dirty()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"autosave-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var p = new PackageProject
            {
                Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                    Agent = new AgentConfig { Type = AgentType.Ad, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } }
            };
            var svc = new AutoSaveService();
            await svc.SaveIfDirtyAsync(p, Path.Combine(dir, "x.pkgproj"), dirty: true);
            Assert.True(File.Exists(Path.Combine(dir, "x.pkgproj")));
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task SaveIfDirty_Skips_When_Not_Dirty()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"autosave-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var p = new PackageProject();
            var svc = new AutoSaveService();
            await svc.SaveIfDirtyAsync(p, Path.Combine(dir, "x.pkgproj"), dirty: false);
            Assert.False(File.Exists(Path.Combine(dir, "x.pkgproj")));
        }
        finally { Directory.Delete(dir, true); }
    }
}
