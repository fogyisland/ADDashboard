using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace PackageDesigner.ViewModels;

public abstract class FileTabViewModel : INotifyPropertyChanged
{
    public abstract string Title { get; }
    public abstract object View { get; }   // UserControl

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}