using System.Windows;

namespace PackageDesigner.Views;

public partial class SettingsDialog : Window
{
    public SettingsDialog()
    {
        DataContext = App.Settings;
        InitializeComponent();
    }
    private void Save_Click(object s, RoutedEventArgs e)
    {
        App.Settings.CenterUrl = UrlBox.Text;
        App.Settings.Save();
        if (!string.IsNullOrEmpty(TokenBox.Password))
            App.Credentials.Set(UrlBox.Text, TokenBox.Password);
        DialogResult = true;
    }
    private void Cancel_Click(object s, RoutedEventArgs e) => DialogResult = false;
}