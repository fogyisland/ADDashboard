using System.Text.RegularExpressions;
namespace PackageDesigner.Sandbox;

internal static class PatternChecker
{
    public static readonly Regex[] Blocked = new[]
    {
        new Regex(@";\s*\S", RegexOptions.Compiled),
        new Regex(@"\bDROP\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\b(TRUNCATE|RENAME|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\bINSERT\s+INTO\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\bUPDATE\s+(?!CASCADE\b)[a-z_]", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\bDELETE\s+FROM\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\b(MERGE|SELECT)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\bpkg_[a-z0-9_]+\.[a-z0-9_]+", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        new Regex(@"\b(main|installed_packages|metric_gauge|metric_counter|metric_timeseries|metric_status|package_runs|orphan_schemas|system_config|audit_logs|schema_migrations)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase),
    };
}