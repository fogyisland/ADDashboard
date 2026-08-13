using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

/// <summary>
/// Pure-function generator that emits the three editable artifacts of a
/// v2 monitoring package from a manifest + metric selections: regenerated
/// <c>manifest.json</c>, regenerated <c>migrations/001_initial.sql</c>, and
/// regenerated <c>collect.ps1</c>. No IO, no state — caller writes via
/// <see cref="PersistenceService"/>.
/// </summary>
public static class MetricGenerator
{
    /// <summary>One picked metric: a catalog entry + the column def to emit.</summary>
    public sealed record Selection(MetricCatalogEntry Catalog, MetricDef Column, Overrides? Override = null);

    /// <summary>
    /// Per-metric user overrides for label/unit/thresholds. Null members mean
    /// "fall back to the catalog default". The VM mutates these on every edit
    /// so the generator emits the actual user value, not the catalog default.
    /// </summary>
    public sealed record Overrides(string? Label = null, string? Unit = null, double? Warn = null, double? Crit = null);

    /// <summary>
    /// Build the auto-generated <c>manifest.json</c>. Uses
    /// <see cref="ManifestValidator.SerializerOptions"/> so the output
    /// validates against the embedded schema and center's ajv (GC #15).
    /// </summary>
    public static string GenerateManifestJson(
        PackageManifest m,
        IReadOnlyList<Selection> selections)
    {
        // Clone so we never mutate the caller's manifest (the VM owns the
        // pre-mutation state and re-runs generation on every change).
        var draft = new PackageManifest
        {
            Name = m.Name,
            Version = m.Version,
            Type = m.Type,
            Description = m.Description,
            Agent = new AgentConfig
            {
                Type = m.Agent.Type,
                MinVersion = m.Agent.MinVersion,
                Platforms = m.Agent.Platforms?.ToList(),
                Runtime = "powershell",
                Script = "collect.ps1",
                TimeoutMs = m.Agent.TimeoutMs,
                IntervalSec = m.Agent.IntervalSec,
            },
        };

        // Build metrics[] — one entry per selection, with thresholds.
        var metricsDto = selections.Select(s =>
        {
            // Apply per-metric overrides if set. Empty Label = use catalog;
            // null Warn/Crit = use catalog default.
            var ov = s.Override;
            var label = (ov?.Label is { Length: > 0 } ol) ? ol : s.Catalog.Label;
            var unit = (ov?.Unit is { Length: > 0 } ou) ? ou : s.Catalog.Unit;
            var warn = ov?.Warn ?? s.Catalog.DefaultWarn;
            var crit = ov?.Crit ?? s.Catalog.DefaultCrit;
            return new MetricsDto
            {
                Key = s.Catalog.Key,
                Label = label,
                Unit = unit,
                Thresholds = new ThresholdsDto { Warn = warn, Crit = crit },
            };
        }).ToList();

        // Compose database block.
        var db = m.Database ?? new DatabaseConfig();
        var schemaDto = new Dictionary<string, MetricDefDto>();
        // agent_id + ts always present, plus one entry per picked metric.
        schemaDto["agent_id"] = new MetricDefDto { Type = "varchar(64)", Nullable = false };
        schemaDto["ts"] = new MetricDefDto { Type = "datetime", Nullable = false };
        foreach (var s in selections)
            schemaDto[s.Catalog.Key] = new MetricDefDto { Type = s.Catalog.SqlType, Nullable = s.Column.Nullable ?? true };

        var migrationsDto = new List<string> { "migrations/001_initial.sql" };
        // Custom migrations beyond 001 are preserved verbatim on save (handled
        // by the VM, not the generator). The generator only owns the auto-001.

        var full = new ManifestDto
        {
            Name = draft.Name,
            Version = draft.Version,
            Type = draft.Type,
            Description = draft.Description,
            Agent = new AgentDto
            {
                Type = draft.Agent.Type,
                MinVersion = draft.Agent.MinVersion,
                Platforms = draft.Agent.Platforms,
                Runtime = "powershell",
                Script = draft.Agent.Script,
                TimeoutMs = draft.Agent.TimeoutMs,
                IntervalSec = draft.Agent.IntervalSec,
            },
            Database = new DatabaseDto
            {
                SchemaName = db.SchemaName,
                Migrations = migrationsDto,
                MetricTable = db.MetricTable,
                MetricSchema = schemaDto,
            },
            Metrics = metricsDto,
        };
        return JsonSerializer.Serialize(full, ManifestValidator.SerializerOptions);
    }

    /// <summary>
    /// Build the auto-generated <c>migrations/001_initial.sql</c>. The output
    /// pins the v2 metric table shape: agent_id + ts + one column per picked
    /// metric. Columns are NULLable by default (the agent writes nullable
    /// JSON values when a metric collection fails); the optional
    /// <see cref="MetricDef.Nullable"/> override can force NOT NULL.
    /// </summary>
    public static string GenerateMigration001(
        string schemaName,
        string tableName,
        IReadOnlyList<Selection> selections)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append("CREATE TABLE ").Append(schemaName).Append('.').Append(tableName).Append(" (\n");
        sb.Append("  agent_id VARCHAR(64) NOT NULL,\n");
        sb.Append("  ts DATETIME NOT NULL");
        foreach (var s in selections)
        {
            sb.Append(",\n  ").Append(s.Catalog.Key).Append(' ').Append(s.Catalog.SqlType);
            if (s.Column.Nullable == false)
                sb.Append(" NOT NULL");
        }
        sb.Append("\n);\n");
        return sb.ToString();
    }

    /// <summary>
    /// Build the auto-generated <c>collect.ps1</c>. Emits one assignment per
    /// picked metric into an ordered hashtable, then JSON-serializes the
    /// result with <c>ConvertTo-Json -Compress</c>. Snippets are emitted
    /// verbatim — the catalog is the source of truth and is validated by
    /// <c>MetricCatalogTests</c>.
    /// </summary>
    public static string GenerateCollectScript(IReadOnlyList<Selection> selections)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("$ErrorActionPreference = 'Stop'");
        sb.AppendLine("$agent_id = $env:COMPUTERNAME");
        sb.AppendLine("$ts = (Get-Date).ToUniversalTime().ToString('o')");
        sb.AppendLine("$metrics = [ordered]@{");
        for (int i = 0; i < selections.Count; i++)
        {
            var s = selections[i];
            sb.Append("  ").Append(s.Catalog.Key).Append(" = ").Append(s.Catalog.PowerShellSnippet);
            sb.AppendLine(i == selections.Count - 1 ? "" : "");
        }
        sb.AppendLine("}");
        sb.AppendLine("@{ agent_id = $agent_id; ts = $ts; metrics = $metrics } | ConvertTo-Json -Compress");
        return sb.ToString();
    }

    // ------- DTOs (control JSON property order so the output matches the
    // embedded schema's expected shape and reads top-to-bottom the way a
    // human-authored manifest would). -------
    private sealed class ManifestDto
    {
        public string Name { get; set; } = "";
        public string Version { get; set; } = "";
        public string Type { get; set; } = "";
        public string? Description { get; set; }
        public AgentDto? Agent { get; set; }
        public DatabaseDto? Database { get; set; }
        public List<MetricsDto>? Metrics { get; set; }
    }
    private sealed class AgentDto
    {
        public AgentType Type { get; set; }
        public string MinVersion { get; set; } = "";
        public List<string>? Platforms { get; set; }
        public string? Runtime { get; set; }
        public string Script { get; set; } = "";
        public int? TimeoutMs { get; set; }
        public int IntervalSec { get; set; }
    }
    private sealed class DatabaseDto
    {
        public string SchemaName { get; set; } = "";
        public List<string> Migrations { get; set; } = new();
        public string MetricTable { get; set; } = "";
        public Dictionary<string, MetricDefDto> MetricSchema { get; set; } = new();
    }
    private sealed class MetricDefDto
    {
        public string Type { get; set; } = "";
        public bool? Nullable { get; set; }
    }
    private sealed class MetricsDto
    {
        public string Key { get; set; } = "";
        public string Label { get; set; } = "";
        public string? Unit { get; set; }
        public ThresholdsDto? Thresholds { get; set; }
    }
    private sealed class ThresholdsDto
    {
        public double? Warn { get; set; }
        public double? Crit { get; set; }
    }
}