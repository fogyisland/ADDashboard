using System.Collections.ObjectModel;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class PackageTabViewModel
{
    public PackageProject Project { get; }
    public ManifestViewModel ManifestVM { get; }
    public MigrationsListViewModel MigrationsVM { get; }
    public ObservableCollection<FileTabViewModel> OpenFiles { get; } = new();
    public FileTabViewModel? SelectedFile { get; set; }

    public PackageTabViewModel(PackageProject p)
    {
        Project = p;
        ManifestVM = new ManifestViewModel(p.Manifest);
        MigrationsVM = new MigrationsListViewModel(p);
    }

    public void OpenSql(SqlFileViewModel svm) => OpenFiles.Add(new SqlFileTab(svm));
    public void OpenPs1(PowerShellFileViewModel pvm) => OpenFiles.Add(new Ps1FileTab(pvm));
    public void OpenManifest() => OpenFiles.Add(new ManifestTab(ManifestVM));

    private class ManifestTab : FileTabViewModel
    {
        private readonly ManifestViewModel _vm;
        private Views.ManifestFormView? _view;
        public ManifestTab(ManifestViewModel vm) { _vm = vm; }
        public override string Title => "manifest";
        public override object View => _view ??= new Views.ManifestFormView(_vm);
    }
    private class SqlFileTab : FileTabViewModel
    {
        private readonly SqlFileViewModel _vm;
        private Views.SqlEditorView? _view;
        public SqlFileTab(SqlFileViewModel vm) { _vm = vm; }
        public override string Title => _vm.File.Path;
        public override object View => _view ??= new Views.SqlEditorView(_vm);
    }
    private class Ps1FileTab : FileTabViewModel
    {
        private readonly PowerShellFileViewModel _vm;
        private Views.PowerShellEditorView? _view;
        public Ps1FileTab(PowerShellFileViewModel vm) { _vm = vm; }
        public override string Title => _vm.File.Path;
        public override object View => _view ??= new Views.PowerShellEditorView(_vm);
    }
}