using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

public record PublishResult(bool Ok, int StatusCode, string? ErrorCode, string? ErrorMessage);

public class PublishService
{
    private readonly HttpClient _http;
    public PublishService(HttpClient http) => _http = http;

    public async Task<PublishResult> PublishAsync(PackageProject p, string centerUrl, string token, IProgress<double>? progress, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        PackageService.WriteZip(p, ms);
        var b64 = Convert.ToBase64String(ms.ToArray());
        var body = new
        {
            source = "buffer",
            packageRef = (string?)null,
            buffer = b64,
            confirmDropSchema = false
        };
        var json = JsonSerializer.Serialize(body);
        var req = new HttpRequestMessage(HttpMethod.Post, centerUrl.TrimEnd('/') + "/api/admin/packages/install")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        progress?.Report(0.5);
        using var resp = await _http.SendAsync(req, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        progress?.Report(1.0);
        if (resp.IsSuccessStatusCode) return new PublishResult(true, (int)resp.StatusCode, null, null);
        try
        {
            var err = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(text);
            var inner = err!["error"];
            return new PublishResult(false, (int)resp.StatusCode, inner.GetProperty("code").GetString(), inner.GetProperty("message").GetString());
        }
        catch
        {
            return new PublishResult(false, (int)resp.StatusCode, "INTERNAL", text);
        }
    }
}