using System.IO;
namespace PackageDesigner.Services;

public record RecoveryEntry(string ProjectName, string LogPath, DateTime LastEvent);

public static class RecoveryService
{
    public static IReadOnlyList<RecoveryEntry> Scan(string workspaceDir)
    {
        if (!Directory.Exists(workspaceDir)) return Array.Empty<RecoveryEntry>();
        var entries = new List<RecoveryEntry>();
        foreach (var log in Directory.GetFiles(workspaceDir, "*.auto-save.log"))
        {
            var baseName = Path.GetFileNameWithoutExtension(log).Replace(".auto-save", "");
            entries.Add(new RecoveryEntry(baseName + ".pkgproj", log, File.GetLastWriteTime(log)));
        }
        return entries;
    }
}
