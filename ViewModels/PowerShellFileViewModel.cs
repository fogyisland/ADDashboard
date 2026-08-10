using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class PowerShellFileViewModel : INotifyPropertyChanged
{
    private readonly PackageFile _f;
    public PackageFile File => _f;

    public PowerShellFileViewModel(PackageFile f) { _f = f; }

    private string _body = "";
    public string Body
    {
        get => _body;
        set { _body = value ?? ""; OnChanged(); }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
