using System.Collections.Generic;

namespace PackageDesigner.Models;

/// <summary>
/// Built-in catalog of 5 metrics the WPF designer can pick from. Static
/// (Global Constraint #2: embedded only — no remote fetch, no disk overlay).
/// To add a metric, append a new entry here and ship a new build.
/// </summary>
public static class MetricCatalog
{
    public static IReadOnlyList<MetricCatalogEntry> All { get; } = new[]
    {
        new MetricCatalogEntry
        {
            Key = "cpu_pct",
            Label = "CPU usage",
            Unit = "%",
            SqlType = "double",
            Category = "Host / Performance",
            Description = "Total processor utilization across all cores.",
            PowerShellSnippet = "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
            DefaultWarn = 80,
            DefaultCrit = 95,
        },
        new MetricCatalogEntry
        {
            Key = "memory_pct",
            Label = "Memory used",
            Unit = "%",
            SqlType = "double",
            Category = "Host / Performance",
            Description = "Percentage of visible memory in use.",
            PowerShellSnippet = "[math]::Round(($(Get-CimInstance Win32_OperatingSystem) | ForEach-Object { ($_.TotalVisibleMemorySize - $_.FreePhysicalMemory) / $_.TotalVisibleMemorySize * 100 })[0], 2)",
            DefaultWarn = 80,
            DefaultCrit = 95,
        },
        new MetricCatalogEntry
        {
            Key = "disk_free_pct",
            Label = "Disk free",
            Unit = "%",
            SqlType = "double",
            Category = "Host / Performance",
            Description = "Free space percentage on the system drive.",
            PowerShellSnippet = "[math]::Round((Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { ($_.Free / ($_.Used + $_.Free)) * 100 } | Measure-Object -Average).Average, 2)",
            DefaultWarn = 20,
            DefaultCrit = 10,
        },
        new MetricCatalogEntry
        {
            Key = "service_status",
            Label = "Critical services status",
            Unit = "",
            SqlType = "int",
            Category = "Host / Services",
            Description = "Count of running critical services (NTDS, DNS, KDC).",
            PowerShellSnippet = "(@('NTDS','DNS','KDC') | ForEach-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue } | Where-Object { $_.Status -eq 'Running' }).Count",
            DefaultWarn = 2,
            DefaultCrit = 1,
        },
        new MetricCatalogEntry
        {
            Key = "ad_repl_lag",
            Label = "AD replication lag",
            Unit = "s",
            SqlType = "int",
            Category = "AD / Replication",
            Description = "Maximum replication lag in seconds across all partners.",
            PowerShellSnippet = "(Get-ADReplicationPartnerMetadata -Target * -ErrorAction SilentlyContinue | Measure-Object -Property LastReplicationResult -Maximum).Maximum / 1",
            DefaultWarn = 300,
            DefaultCrit = 900,
        },
    };

    public static bool TryGet(string key, out MetricCatalogEntry entry)
    {
        foreach (var e in All)
            if (e.Key == key) { entry = e; return true; }
        entry = null!;
        return false;
    }
}
