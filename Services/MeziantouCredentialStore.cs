using Meziantou.Framework.Win32;
namespace PackageDesigner.Services;
public class MeziantouCredentialStore : ICredentialStore
{
    public string? Read(string key) => CredentialManager.ReadCredential(key)?.Password;
    public void Write(string key, string value) => CredentialManager.WriteCredential(key, key, value, CredentialPersistence.LocalMachine);
    public void Delete(string key) => CredentialManager.DeleteCredential(key);
}
