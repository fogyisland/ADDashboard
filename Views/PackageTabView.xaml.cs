using System.Linq;
using System.Windows;
using System.Windows.Controls;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class PackageTabView : UserControl
{
    public PackageTabViewModel ViewModel { get; }
    public PackageTabView(PackageTabViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void Tree_SelectedItemChanged(object s, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue == ManifestNode) ViewModel.OpenManifest();
        else if (e.NewValue is SqlFileViewModel sql) ViewModel.OpenSql(sql);
        else if (e.NewValue == Ps1Node)
        {
            var ps1 = ViewModel.Project.Files.FirstOrDefault(f => f.Role == "ps1");
            if (ps1 is not null)
            {
                var vm = new PowerShellFileViewModel(ps1);
                ViewModel.OpenPs1(vm);
            }
        }
    }
}