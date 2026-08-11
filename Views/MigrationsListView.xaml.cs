using System.Windows;
using System.Windows.Controls;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class MigrationsListView : UserControl
{
    public MigrationsListViewModel ViewModel { get; }
    public MigrationsListView(MigrationsListViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void Add_Click(object s, RoutedEventArgs e) { if (!string.IsNullOrWhiteSpace(PathBox.Text)) ViewModel.Add(PathBox.Text); PathBox.Text = ""; }
    private void Remove_Click(object s, RoutedEventArgs e) { if (List.SelectedItem is SqlFileViewModel sel) ViewModel.Remove(sel); }
}