using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class PackageTabViewModel : INotifyPropertyChanged
{
    public PackageProject Project { get; }
    public MetricEditorViewModel MetricEditor { get; }
    public ObservableCollection<FileTabViewModel> OpenFiles { get; } = new();

    private FileTabViewModel? _selectedFile;
    public FileTabViewModel? SelectedFile
    {
        get => _selectedFile;
        set { if (_selectedFile != value) { _selectedFile = value; OnChanged(); } }
    }

    public PackageTabViewModel(PackageProject p)
    {
        Project = p;
        MetricEditor = new MetricEditorViewModel(p);

        // Keep SelectedFile in sync so PackageTabView's inner TabControl
        // SelectedItem always points to an item whose content area renders.
        // Without this, auto-opened tabs show a tab header but blank content.
        OpenFiles.CollectionChanged += (_, e) =>
        {
            if (e.Action == NotifyCollectionChangedAction.Add && e.NewItems is { Count: > 0 })
                SelectedFile = (FileTabViewModel)e.NewItems[^1]!;
            else if (e.Action == NotifyCollectionChangedAction.Remove && OpenFiles.Count > 0)
                SelectedFile = OpenFiles[^1];
            else if (e.Action == NotifyCollectionChangedAction.Reset)
                SelectedFile = null;
        };

        // Auto-open the single metric editor tab.
        OpenEditor();
    }

    public void OpenEditor()
    {
        foreach (var f in OpenFiles)
            if (f is MetricEditorTab) { SelectedFile = f; return; }
        OpenFiles.Add(new MetricEditorTab(MetricEditor));
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    private sealed class MetricEditorTab : FileTabViewModel
    {
        internal readonly MetricEditorViewModel _vm;
        private Views.MetricEditorView? _view;
        public MetricEditorTab(MetricEditorViewModel vm) { _vm = vm; }
        public override string Title => "package";
        public override object View => GetOrCreateView(ref _view, () => new Views.MetricEditorView { DataContext = _vm });
    }
}
