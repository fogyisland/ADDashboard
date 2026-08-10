using System.Windows;
using System.Windows.Controls;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class ManifestFormView : UserControl
{
    public ManifestViewModel ViewModel { get; private set; }
    public ManifestFormView(ManifestViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void AddMigration_Click(object sender, RoutedEventArgs e) => ViewModel.AddMigration();
    private void RemoveMigration_Click(object sender, RoutedEventArgs e)
    {
        if (ViewModel.Migrations.Count > 0) ViewModel.RemoveMigration(ViewModel.Migrations[^1]);
    }
}