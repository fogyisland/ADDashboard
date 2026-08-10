using System.IO;
using System.Text;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class PackageServiceTests
{
    [Fact]
    public void Roundtrip_Zip_Preserves_All_Files()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } },
            Files = new()
            {
                new() { Path = "manifest.json",        Role = "manifest",  Checksum = "" },
                new() { Path = "collect.ps1",          Role = "ps1",       Checksum = "" },
                new() { Path = "migrations/001_initial.sql", Role = "migration", Checksum = "" }
            }
        };
        p.RawFiles["manifest.json"]              = "{\"name\":\"x\"}";
        p.RawFiles["collect.ps1"]                = "# hello";
        p.RawFiles["migrations/001_initial.sql"] = "CREATE TABLE foo (id INT)";

        using var ms = new MemoryStream();
        PackageService.WriteZip(p, ms);
        ms.Position = 0;
        var p2 = PackageService.ReadZip(ms);
        Assert.Equal(p.RawFiles["manifest.json"], p2.RawFiles["manifest.json"]);
        Assert.Equal(p.RawFiles["collect.ps1"],   p2.RawFiles["collect.ps1"]);
        Assert.Equal(p.RawFiles["migrations/001_initial.sql"], p2.RawFiles["migrations/001_initial.sql"]);
    }
}