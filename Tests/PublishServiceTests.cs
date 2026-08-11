using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class PublishServiceTests
{
    [Fact]
    public async Task Publish_Sends_Json_Not_Multipart()
    {
        string? seenContentType = null;
        string? seenBody = null;
        var handler = new StubHandler((req, ct) =>
        {
            seenContentType = req.Content?.Headers.ContentType?.MediaType;
            seenBody = req.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}") };
        });
        var http = new HttpClient(handler);
        var svc = new PublishService(http);
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } }
        };
        p.RawFiles["manifest.json"] = "{}";
        p.RawFiles["collect.ps1"]   = "# ps1";
        var r = await svc.PublishAsync(p, "https://c.example.com", "tok", null, CancellationToken.None);
        Assert.True(r.Ok);
        Assert.Equal("application/json", seenContentType);
        Assert.NotNull(seenBody);
        Assert.Contains("\"buffer\":", seenBody!);  // base64 buffer present
    }

    private class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> _h;
        public StubHandler(Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> h) => _h = h;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct) => Task.FromResult(_h(req, ct));
    }
}