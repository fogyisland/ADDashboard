using System.Windows.Controls;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class PowerShellEditorView : UserControl
{
    public PowerShellFileViewModel ViewModel { get; }

    public PowerShellEditorView(PowerShellFileViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
        Editor.TextChanged += (s, e) => vm.Body = Editor.Text;
    }
}
