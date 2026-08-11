using System.Text.RegularExpressions;
namespace PackageDesigner.Sandbox;

internal static class SandboxSelfReference
{
    public static string? Strip(string sql, string? selfPackage)
    {
        if (selfPackage is null) return null;
        var re = new Regex($@"\b{Regex.Escape(selfPackage)}\.[a-z0-9_]+", RegexOptions.IgnoreCase);
        return re.Replace(sql, "__SELF_REF__");
    }
}