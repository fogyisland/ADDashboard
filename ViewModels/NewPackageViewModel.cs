using PackageDesigner.Models;
using PackageDesigner.Services;

namespace PackageDesigner.ViewModels;

public class NewPackageViewModel
{
    public StarterTemplate Template { get; set; } = StarterTemplate.AdMonitoringLite;
    public string PackageName { get; set; } = "";

    public PackageProject Create()
    {
        var p = StarterTemplateService.Load(Template);
        p.Manifest.Name = PackageName.Trim();
        return p;
    }
}
