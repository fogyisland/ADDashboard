using System.Windows.Controls;
using PackageDesigner.ViewModels;

namespace PackageDesigner.Views;

public partial class SqlEditorView : UserControl
{
    public SqlFileViewModel ViewModel { get; }

    public SqlEditorView(SqlFileViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
        Editor.TextChanged += (s, e) => vm.Body = Editor.Text;
        Editor.Text = "";
        // load from package raw file bytes (caller responsibility before showing)
    }
}