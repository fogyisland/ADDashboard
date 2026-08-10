namespace PackageDesigner.Services;

public interface ICredentialStore
{
    string? Read(string key);
    void Write(string key, string value);
    void Delete(string key);
}

public class CredentialService
{
    private readonly ICredentialStore _store;
    public CredentialService(ICredentialStore store) => _store = store;

    private static string Key(string centerUrl) => "PackageDesigner:" + centerUrl.TrimEnd('/');

    public void Set(string centerUrl, string token) => _store.Write(Key(centerUrl), token);
    public string? Get(string centerUrl) => _store.Read(Key(centerUrl));
    public void Clear(string centerUrl) => _store.Delete(Key(centerUrl));
}
