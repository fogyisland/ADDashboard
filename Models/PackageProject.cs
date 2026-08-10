namespace PackageDesigner.Models;

/// <summary>
/// In-memory representation of a v2 package project opened in the designer.
/// <see cref="Manifest"/> carries the editable form fields; <see cref="Files"/>
/// is the ordered list surfaced in the WPF tree view; <see cref="RawFiles"/>
/// preserves original bytes for every file inside the .pkgproj / .zip so the
/// designer never loses files it does not model directly (e.g. collect.ps1
/// or migration SQLs).
/// </summary>
public class PackageProject
{
    public PackageManifest Manifest { get; set; } = new();
    public List<PackageFile> Files { get; set; } = new();
    public Dictionary<string, string> RawFiles { get; set; } = new();
    public string? LastPublishedAt { get; set; }
}