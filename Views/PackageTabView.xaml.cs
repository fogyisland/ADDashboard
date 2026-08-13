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
        if (e.NewValue == PackageNode) ViewModel.OpenEditor();
    }
}
