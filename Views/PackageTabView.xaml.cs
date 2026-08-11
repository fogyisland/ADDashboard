using System.Linq;
using System.Windows;
using System.Windows.Controls;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class PackageTabView : UserControl
{
    // VM is set via DataContext by the parent MainWindow.xaml DataTemplate
    // ({Binding} on the TabControl.ContentTemplate). WPF requires a
    // parameterless constructor for declaratively-instantiated views;
    // a VM-taking ctor causes XamlParseException at first render.
    public PackageTabViewModel ViewModel => (PackageTabViewModel)DataContext;
    public PackageTabView()
    {
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