using System.Collections.ObjectModel;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class MigrationsListViewModel
{
    private readonly PackageProject _p;
    public ObservableCollection<SqlFileViewModel> Items { get; } = new();

    public MigrationsListViewModel(PackageProject p)
    {
        _p = p;
        foreach (var path in _p.Manifest.Database?.Migrations ?? new())
            Items.Add(new SqlFileViewModel(new PackageFile { Path = path, Role = "migration" }));
    }

    public void Add(string path)
    {
        var f = new PackageFile { Path = path, Role = "migration" };
        Items.Add(new SqlFileViewModel(f));
        _p.Files.Add(f);
        _p.Manifest.Database ??= new DatabaseConfig();
        _p.Manifest.Database.Migrations.Add(path);
    }

    public void Remove(SqlFileViewModel item)
    {
        Items.Remove(item);
        _p.Files.Remove(item.File);
        _p.Manifest.Database?.Migrations.Remove(item.File.Path);
    }
}