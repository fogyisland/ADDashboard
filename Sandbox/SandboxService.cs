using System.Text.RegularExpressions;
namespace PackageDesigner.Sandbox;

public sealed record SandboxResult(bool Ok, string? Blocked, int TokenCount, long ScanDurationMs);

public static class SandboxService
{
    public static SandboxResult Scan(string sql, string? selfPackage = null)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var stripped = Regex.Replace(Regex.Replace(sql, @"/\*[\s\S]*?\*/", ""), @"--[^\n]*", "");
        var scanStripped = SandboxSelfReference.Strip(stripped, selfPackage) ?? stripped;
        foreach (var re in PatternChecker.Blocked)
        {
            if (re.IsMatch(scanStripped)) return new SandboxResult(false, re.ToString(), 0, sw.ElapsedMilliseconds);
        }
        var (ok, blocked) = TokenWalker.WalkTokens(stripped);
        var tokens = Tokenizer.Tokenize(stripped);
        return new SandboxResult(ok, blocked, tokens.Count, sw.ElapsedMilliseconds);
    }
}