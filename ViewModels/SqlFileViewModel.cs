using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;
using PackageDesigner.Sandbox;

namespace PackageDesigner.ViewModels;

public class SqlFileViewModel : INotifyPropertyChanged
{
    private readonly PackageFile _f;
    private string _body;
    public PackageFile File => _f;

    public SqlFileViewModel(PackageFile f)
    {
        _f = f;
        _body = "";
    }

    public string Body
    {
        get => _body;
        set { _body = value ?? ""; _f.Checksum = "";  // sentinel: dirty
            Status = SandboxService.Scan(_body);
            OnChanged();
        }
    }

    private SandboxResult _status = new(true, null, 0, 0);
    public SandboxResult Status { get => _status; private set { _status = value; OnChanged(); } }

    public string StatusMessage => Status.Ok
        ? $"✅ Pass — {Status.TokenCount} tokens, {Status.ScanDurationMs}ms"
        : $"❌ Blocked: {Status.Blocked}";

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}