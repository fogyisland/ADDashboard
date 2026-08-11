using System;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace PackageDesigner.ViewModels;

public abstract class FileTabViewModel : INotifyPropertyChanged
{
    public abstract string Title { get; }
    public abstract object View { get; }   // UserControl

    // Lazily materialize the View via factory, cache it, and raise PropertyChanged
    // the first time it materialises so OneWay bindings to {Binding View} re-read
    // and render the freshly-built UserControl instead of staying on the null
    // snapshot WPF captured at binding-attach time.
    protected T GetOrCreateView<T>(ref T? field, Func<T> factory) where T : class
    {
        if (field is null)
        {
            field = factory();
            OnChanged(nameof(View));
        }
        return field;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}