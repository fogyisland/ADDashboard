using System.Windows;
using PackageDesigner.Models;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class NewPackageDialog : Window
{
    public NewPackageViewModel ViewModel { get; }
    public NewPackageDialog(NewPackageViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void OK_Click(object s, RoutedEventArgs e)
    {
        ViewModel.Template = TemplateBox.SelectedIndex == 0
            ? StarterTemplate.AdMonitoringLite
            : StarterTemplate.AdOsBaselineLite;
        ViewModel.PackageName = NameBox.Text;
        DialogResult = true;
    }
    private void Cancel_Click(object s, RoutedEventArgs e) => DialogResult = false;
}
