using System.Text.RegularExpressions;
namespace PackageDesigner.Sandbox;

internal static class TokenWalker
{
    public static (bool ok, string? blocked) WalkTokens(string sql)
    {
        var tokens = Tokenizer.Tokenize(sql);
        var reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "main","installed_packages","metric_gauge","metric_counter","metric_timeseries",
            "metric_status","package_runs","orphan_schemas","system_config","audit_logs","schema_migrations"
        };
        foreach (var t in tokens)
        {
            if (Regex.IsMatch(t, @"^-?\d+(\.\d+)?$")) continue;
            if (Regex.IsMatch(t, @"^'[^']*'$")) continue;
            if (Regex.IsMatch(t, @"^[a-z_][a-z0-9_]*$", RegexOptions.IgnoreCase))
            {
                if (reserved.Contains(t)) return (false, $"reserved center resource: {t}");
                if (Regex.IsMatch(t, @"^[A-Z_]+$") && !KeywordChecker.Allowed.Contains(t))
                    return (false, $"unknown identifier: {t}");
                continue;
            }
            return (false, $"unparseable token: {t}");
        }
        return (true, null);
    }
}