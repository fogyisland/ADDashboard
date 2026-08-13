using System.Windows;
using System.Windows.Controls;
using PackageDesigner.Models;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class MetricEditorView : UserControl
{
    // VM is set via DataContext by the parent PackageTabView's content
    // template. WPF requires a parameterless ctor for declaratively
    // instantiated views; a VM-taking ctor alone causes XamlParseException
    // at first render (Global Constraint #9).
    public MetricEditorViewModel ViewModel => (MetricEditorViewModel)DataContext;
    public MetricEditorView()
    {
        InitializeComponent();
    }

    private void CatalogCheck_Click(object sender, RoutedEventArgs e)
    {
        if (sender is CheckBox cb && cb.Tag is MetricCatalogEntry entry)
            ViewModel.ToggleMetric(entry);
    }

    private void AddCustom_Click(object sender, RoutedEventArgs e)
    {
        if (!string.IsNullOrWhiteSpace(NewCustomPath.Text))
            ViewModel.AddCustomMigration(NewCustomPath.Text);
        NewCustomPath.Text = "";
    }

    private void RemoveCustom_Click(object sender, RoutedEventArgs e)
    {
        // C-3 fix: read the custom-migrations ListBox (its named element),
        // not CatalogList (which holds MetricCatalogEntry rows). Both share a
        // ListBox type, so the wrong target silently no-oped on removal.
        if (CustomMigrationsList.SelectedItem is CustomMigrationViewModel sel)
            ViewModel.RemoveCustomMigration(sel);
    }
}