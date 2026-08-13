using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace PackageDesigner.ViewModels;

/// <summary>
/// One user-added migration beyond the auto-generated 001. Treated as an
/// opaque (path, content) pair — the editor doesn't try to parse it.
/// </summary>
public sealed class CustomMigrationViewModel : INotifyPropertyChanged
{
    public string Path { get; }
    private string _content;
    public string Content
    {
        get => _content;
        set { _content = value; OnChanged(); }
    }

    public CustomMigrationViewModel(string path, string content)
    {
        Path = path;
        _content = content;
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}