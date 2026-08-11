using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class PackageTabViewModel : INotifyPropertyChanged
{
    public PackageProject Project { get; }
    public ManifestViewModel ManifestVM { get; }
    public MigrationsListViewModel MigrationsVM { get; }
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
        ManifestVM = new ManifestViewModel(p.Manifest);
        MigrationsVM = new MigrationsListViewModel(p);

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

        // Auto-open Manifest tab so the three package elements are immediately
        // visible. The user clicks MigrationsNode / Ps1Node in the tree to add
        // the other two as needed; this matches the "三个要素" UX expectation.
        OpenManifest();
    }

    public void OpenSql(SqlFileViewModel svm) => OpenFiles.Add(new SqlFileTab(svm));
    public void OpenPs1(PowerShellFileViewModel pvm) => OpenFiles.Add(new Ps1FileTab(pvm));
    public void OpenManifest() => OpenFiles.Add(new ManifestTab(ManifestVM));

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    private sealed class ManifestTab : FileTabViewModel
    {
        private readonly ManifestViewModel _vm;
        private Views.ManifestFormView? _view;
        public ManifestTab(ManifestViewModel vm) { _vm = vm; }
        public override string Title => "manifest";
        public override object View => GetOrCreateView(ref _view, () => new Views.ManifestFormView(_vm));
    }
    private sealed class SqlFileTab : FileTabViewModel
    {
        private readonly SqlFileViewModel _vm;
        private Views.SqlEditorView? _view;
        public SqlFileTab(SqlFileViewModel vm) { _vm = vm; }
        public override string Title => _vm.File.Path;
        public override object View => GetOrCreateView(ref _view, () => new Views.SqlEditorView(_vm));
    }
    private sealed class Ps1FileTab : FileTabViewModel
    {
        private readonly PowerShellFileViewModel _vm;
        private Views.PowerShellEditorView? _view;
        public Ps1FileTab(PowerShellFileViewModel vm) { _vm = vm; }
        public override string Title => _vm.File.Path;
        public override object View => GetOrCreateView(ref _view, () => new Views.PowerShellEditorView(_vm));
    }
}