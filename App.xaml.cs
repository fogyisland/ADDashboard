using System;
using System.IO;
using System.Net.Http;
using System.Windows;
using PackageDesigner.Services;

namespace PackageDesigner;

public partial class App : Application
{
    public static SettingsService Settings { get; private set; } = null!;
    public static CredentialService Credentials { get; private set; } = null!;
    public static PublishService Publisher { get; private set; } = null!;
    public static AutoSaveService AutoSave { get; private set; } = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        Settings = new SettingsService(Path.Combine(appData, "PackageDesigner", "settings.json"));
        Credentials = new CredentialService(new MeziantouCredentialStore());
        Publisher = new PublishService(new HttpClient());
        AutoSave = new AutoSaveService();
        base.OnStartup(e);
    }
}