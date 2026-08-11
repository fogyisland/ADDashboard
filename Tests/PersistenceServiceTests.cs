using System.IO;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class PersistenceServiceTests
{
    [Fact]
    public void Roundtrip_Pkgproj_Preserves_Manifest_And_Files()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var p = new PackageProject
            {
                Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                    Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } }
            };
            p.RawFiles["manifest.json"] = "{\"name\":\"x\"}";
            PersistenceService.Save(p, tmp);
            var p2 = PersistenceService.Load(tmp);
            Assert.Equal(AgentType.NonAd, p2.Manifest.Agent.Type);
            Assert.Equal("x", p2.Manifest.Name);
            Assert.True(File.Exists(tmp));
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    [Fact]
    public void Save_Is_Atomic_No_Temp_File_Left()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            PersistenceService.Save(new PackageProject(), tmp);
            var temp = tmp + ".tmp";
            Assert.False(File.Exists(temp));
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }
}