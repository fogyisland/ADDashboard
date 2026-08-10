using System.Threading.Tasks;
using PackageDesigner.Models;
namespace PackageDesigner.Services;

public class AutoSaveService
{
    public Task SaveIfDirtyAsync(PackageProject p, string pkgprojPath, bool dirty)
    {
        if (!dirty) return Task.CompletedTask;
        return Task.Run(() => PersistenceService.Save(p, pkgprojPath));
    }
}
