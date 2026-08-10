using System;
using System.IO;
using System.Threading;
using System.Windows;
using PackageDesigner.Services;
using PackageDesigner.ViewModels;
using PackageDesigner.Views;

namespace PackageDesigner;

public partial class MainWindow : Window
{
    public MainWindowViewModel VM { get; } = new();

    public MainWindow()
    {
        DataContext = VM;
        InitializeComponent();
        // Recovery scan
        var ws = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PackageDesigner", "workspace");
        var entries = RecoveryService.Scan(ws);
        if (entries.Count > 0) MessageBox.Show($"Recovery: {entries.Count} package(s) need restore.");
    }

    private void New_Click(object s, RoutedEventArgs e)
    {
        var dlg = new Views.NewPackageDialog(new NewPackageViewModel()) { Owner = this };
        if (dlg.ShowDialog() == true)
        {
            var p = dlg.ViewModel.Create();
            VM.OpenTabs.Add(new PackageTabViewModel(p));
        }
    }

    private void Open_Click(object s, RoutedEventArgs e)
    {
        var ofd = new Microsoft.Win32.OpenFileDialog { Filter = "Package project (*.pkgproj)|*.pkgproj" };
        if (ofd.ShowDialog() == true)
        {
            var p = PersistenceService.Load(ofd.FileName);
            VM.OpenTabs.Add(new PackageTabViewModel(p));
        }
    }

    private void Save_Click(object s, RoutedEventArgs e)
    {
        if (VM.ActiveTab is null) return;
        var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "Package project (*.pkgproj)|*.pkgproj", FileName = VM.ActiveTab.Project.Manifest.Name + ".pkgproj" };
        if (dlg.ShowDialog() == true) PersistenceService.Save(VM.ActiveTab.Project, dlg.FileName);
    }

    private async void Publish_Click(object s, RoutedEventArgs e)
    {
        if (VM.ActiveTab is null) return;
        var url = App.Settings.CenterUrl;
        var token = App.Credentials.Get(url);
        if (string.IsNullOrEmpty(url) || string.IsNullOrEmpty(token))
        {
            MessageBox.Show("Configure center URL and token in Settings first."); return;
        }
        var r = await App.Publisher.PublishAsync(VM.ActiveTab.Project, url, token, null, CancellationToken.None);
        StatusText.Text = r.Ok ? "Published OK" : $"Failed: {r.ErrorMessage}";
    }

    private void Settings_Click(object s, RoutedEventArgs e)
    {
        var dlg = new Views.SettingsDialog { Owner = this };
        dlg.ShowDialog();
    }

    private void Exit_Click(object s, RoutedEventArgs e) => Close();
}