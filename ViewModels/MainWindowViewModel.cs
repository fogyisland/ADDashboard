using System.Collections.ObjectModel;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class MainWindowViewModel
{
    public ObservableCollection<PackageTabViewModel> OpenTabs { get; } = new();
    public PackageTabViewModel? ActiveTab { get; set; }
}