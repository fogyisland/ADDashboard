using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class CredentialServiceTests
{
    [Fact]
    public void Roundtrip_Token_Through_Store()
    {
        var store = new InMemoryCredentialStore();
        var svc = new CredentialService(store);
        svc.Set("https://center.example.com", "tok-123");
        Assert.Equal("tok-123", svc.Get("https://center.example.com"));
        svc.Clear("https://center.example.com");
        Assert.Null(svc.Get("https://center.example.com"));
    }

    private class InMemoryCredentialStore : ICredentialStore
    {
        public Dictionary<string, string> Map { get; } = new();
        public string? Read(string key) => Map.TryGetValue(key, out var v) ? v : null;
        public void Write(string key, string value) => Map[key] = value;
        public void Delete(string key) => Map.Remove(key);
    }
}
