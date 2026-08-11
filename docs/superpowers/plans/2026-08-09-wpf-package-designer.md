# WPF Package Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-only WPF .NET 8 self-contained tool that lets an internal package author create, edit, validate, and publish v2 monitoring packages to a running center instance.

**Architecture:** MVVM-lite (manual `INotifyPropertyChanged`). Single .exe, no installer, no runtime dependency. DDL sandbox is a 1:1 byte-identical .NET port of `center/src/packages/ddl-sandbox.js` enforced by golden file tests. Project state persists in `<workspaceDir>\<packageName>.pkgproj` with atomic writes and crash recovery. Publish uses JSON+base64 body to center's existing `POST /api/admin/packages/install` endpoint.

**Tech Stack:** .NET 8 (`net8.0-windows`, `win-x64` self-contained), WPF, AvalonEdit 6.3.x, NJsonSchema, Meziantou.Framework.Win32.CredentialManager, BCL only otherwise.

**Spec:** `docs/superpowers/specs/2026-08-09-wpf-package-designer-design.md` (commit `17b6db3`).
**Companion spec:** `docs/superpowers/specs/2026-08-09-non-ad-server-management-design.md` (commit `ae8b388`).
**Execution mode:** Subagent-driven (each task gets a fresh implementer subagent + task reviewer).

## Global Constraints

These are non-negotiable requirements binding every task. Implementation MUST satisfy all of them.

1. **Single .NET 8 self-contained Windows .exe**, no installer, no runtime dependency. Target: `win-x64`.
2. **Windows-only** — no Linux/macOS support. WPF is Windows-only by design.
3. **DDL sandbox .NET port MUST produce byte-identical output to `center/src/packages/ddl-sandbox.js`** for all shared test fixtures. Any drift is a bug, not a feature.
4. **All v2 package fields match `center/src/packages/manifest.js`** JSON schema, including `additionalProperties: false`. Schema embedded as `Resources/manifest-schema.json` (EmbeddedResource).
5. **Token storage uses Windows Credential Manager** (Generic Credential type). NEVER store tokens in plain text files. Target format: `PackageDesigner:<sanitized-centerUrl>`.
6. **No local validation may conflict with center validation.** Local NJsonSchema check is a pre-flight; center's ajv check is authoritative.
7. **`.pkgproj` writes are atomic** (temp + rename). Workspace file writes use atomic BCL APIs.
8. **Auto-save must not block the UI thread.** All file I/O on `Task.Run` background threads.
9. **Settings file is `%APPDATA%\PackageDesigner\settings.json`** — never in `Program Files`, never in repo, never in source-controlled paths.
10. **Crash recovery must not silently lose work.** Recovery dialog must always appear on startup if any `.pkgproj` has incomplete auto-save state.
11. **All publish HTTP requests must be cancellable** via `CancellationToken` — no fire-and-forget.
12. **No telemetry, no crash reporting to external services** — internal tool.
13. **No third-party MVVM framework** — manual `INotifyPropertyChanged` only.
14. **AvalonEdit + NJsonSchema + Meziantou.Framework.Win32.CredentialManager are the only third-party NuGet deps** beyond BCL. No other deps without spec amendment.
15. **Test suite MUST include sandbox golden file tests** that fail if the .NET port drifts from Node.js output.
16. **(PATCHED 2026-08-09) `agent.type` enum `["ad", "non-ad"]`** with default `"ad"` is part of the embedded manifest schema. The dropdown is round-tripped through `.pkgproj` save/load and through the published `manifest.json`.
17. **Per-task commit cadence**: each task ends with one git commit. The final task of the WPF plan produces a single .exe via `dotnet publish -c Release -r win-x64 --self-contained`. Smoke test is run on a Windows 11 VM (out-of-band, documented in the manual smoke test report).

---

## File Structure

```
PackageDesigner/                                # .NET 8 WPF self-contained project
├── PackageDesigner.csproj
├── App.xaml / App.xaml.cs                      # composition root + DI lite
├── MainWindow.xaml / .cs                       # top-level TabControl + menu + toolbar
├── Views/
│   ├── PackageTabView.xaml                     # one opened package (tree + editors)
│   ├── ManifestFormView.xaml                   # XAML form, bound to ManifestVM
│   ├── SqlEditorView.xaml                      # AvalonEdit + sandbox status strip
│   ├── PowerShellEditorView.xaml               # AvalonEdit
│   ├── MigrationsListView.xaml                 # ordered list + add/remove
│   ├── NewPackageDialog.xaml                   # name + type + starter template
│   └── SettingsDialog.xaml                     # center URL + token management
├── ViewModels/
│   ├── MainWindowViewModel.cs
│   ├── PackageTabViewModel.cs
│   ├── FileTabViewModel.cs                     # base class
│   ├── ManifestViewModel.cs
│   ├── SqlFileViewModel.cs
│   ├── PowerShellFileViewModel.cs
│   ├── NewPackageViewModel.cs                  # starter-template choice
│   └── SettingsViewModel.cs
├── Models/
│   ├── PackageManifest.cs                      # top-level manifest
│   ├── AgentConfig.cs                          # includes AgentType enum
│   ├── DatabaseConfig.cs
│   ├── MetricDef.cs
│   ├── PackageFile.cs
│   ├── PackageProject.cs                       # .pkgproj deserialization target
│   ├── SandboxResult.cs
│   ├── SandboxError.cs
│   └── StarterTemplate.cs                      # enum { AdMonitoringLite, AdOsBaselineLite }
├── Services/
│   ├── PackageService.cs                       # zip I/O
│   ├── PublishService.cs                       # POST to center
│   ├── SandboxService.cs
│   ├── AutoSaveService.cs
│   ├── CredentialService.cs
│   ├── SettingsService.cs
│   ├── RecoveryService.cs
│   ├── ManifestValidator.cs                    # NJsonSchema wrapper
│   └── StarterTemplateService.cs               # load embedded .zip fixtures
├── Sandbox/                                    # .NET port of ddl-sandbox.js
│   ├── Tokenizer.cs
│   ├── KeywordChecker.cs
│   ├── PatternChecker.cs
│   ├── TokenWalker.cs
│   └── SandboxSelfReference.cs
├── Resources/
│   ├── manifest-schema.json                    # EmbeddedResource
│   ├── templates/
│   │   ├── ad-monitoring-lite.zip              # EmbeddedResource (AD starter)
│   │   └── ad-os-baseline-lite.zip             # EmbeddedResource (Non-AD starter)
│   └── icon.png
└── Tests/
    ├── PackageDesigner.Tests.csproj
    ├── Sandbox/
    │   ├── SandboxGoldenTests.cs               # cross-language drift
    │   └── SandboxUnitTests.cs
    ├── Manifest/
    │   ├── ManifestValidatorTests.cs
    │   ├── ManifestAgentTypeTests.cs           # PATCHED 2026-08-09
    │   └── ManifestRoundTripTests.cs
    ├── PackageServiceTests.cs
    ├── PublishServiceTests.cs
    ├── CredentialServiceTests.cs
    ├── AutoSaveServiceTests.cs
    ├── RecoveryServiceTests.cs
    ├── StarterTemplateTests.cs                  # PATCHED 2026-08-09
    └── ViewModelTests/
        ├── ManifestViewModelTests.cs
        └── NewPackageViewModelTests.cs          # PATCHED 2026-08-09

tests/fixtures/sandbox-cases.json               # shared with center (committed here, mirrored)
scripts/verify-sandbox.ps1                      # cross-language drift check
```

The two cross-language test artifacts (`tests/fixtures/sandbox-cases.json` + `scripts/verify-sandbox.ps1`) are committed in the WPF repo and expected to match a copy in the center repo. Drift is caught by the whole-branch review.

---

## Task 1: Sandbox port + golden file tests

**Files:**
- Create: `Sandbox/Tokenizer.cs`
- Create: `Sandbox/KeywordChecker.cs`
- Create: `Sandbox/PatternChecker.cs`
- Create: `Sandbox/TokenWalker.cs`
- Create: `Sandbox/SandboxSelfReference.cs`
- Create: `tests/fixtures/sandbox-cases.json`
- Create: `Tests/Sandbox/SandboxGoldenTests.cs`
- Create: `Tests/Sandbox/SandboxUnitTests.cs`
- Create: `PackageDesigner.csproj` (minimal: `net8.0-windows`, no deps yet)
- Create: `PackageDesigner.Tests.csproj`

**Interfaces:**
- Produces: `public static class SandboxService { public static SandboxResult Scan(string sql, string? selfPackage = null); }`
- `SandboxResult` has `Ok`, `Blocked` (regex source or token string), `TokenCount`, `ScanDurationMs`. The `.Blocked` value must match the Node.js output exactly for every fixture.

- [ ] **Step 1: Create the .csproj files**

`PackageDesigner.csproj` (excerpt):
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <RuntimeIdentifiers>win-x64</RuntimeIdentifiers>
    <SelfContained>true</SelfContained>
  </PropertyGroup>
</Project>
```

`PackageDesigner.Tests.csproj`:
```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0-windows</TargetFramework>
    <IsPackable>false</IsPackable>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.10.0" />
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="..\PackageDesigner.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Write the failing golden test**

`Tests/Sandbox/SandboxGoldenTests.cs`:
```csharp
using System.Text.Json;
using PackageDesigner.Sandbox;
using Xunit;

namespace PackageDesigner.Tests.Sandbox;

public class SandboxGoldenTests
{
    public static IEnumerable<object[]> Cases()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", "sandbox-cases.json");
        var json = File.ReadAllText(path);
        var cases = JsonSerializer.Deserialize<List<Case>>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? new();
        foreach (var c in cases) yield return new object[] { c };
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Golden_Matches_NodeJs_Output(Case c)
    {
        var result = SandboxService.Scan(c.Sql, c.SelfPackage);
        Assert.Equal(c.ExpectedOk, result.Ok);
        if (!c.ExpectedOk)
        {
            Assert.Equal(c.ExpectedBlocked, result.Blocked);
        }
    }

    public class Case
    {
        public string Name { get; set; } = "";
        public string Sql { get; set; } = "";
        public string? SelfPackage { get; set; }
        public bool ExpectedOk { get; set; }
        public string? ExpectedBlocked { get; set; }
    }
}
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `dotnet test Tests/Sandbox/SandboxGoldenTests.cs --filter Golden_Matches_NodeJs_Output`
Expected: compilation error `SandboxService does not exist`.

- [ ] **Step 4: Add the fixture file**

`tests/fixtures/sandbox-cases.json` is a JSON array of `Case` records. It MUST be a 1:1 copy of the same file in `D:\ToolDevelop\ADDashboard\tests\fixtures\sandbox-cases.json` if it exists; otherwise create a minimal seed with 10 cases: 1 simple CREATE TABLE pass, 1 multi-statement fail, 1 DROP fail, 1 unknown keyword fail, 1 ON UPDATE CASCADE pass, 1 ON DELETE CASCADE pass, 1 self-ref pass, 1 cross-package fail, 1 numeric literal pass, 1 string literal pass.

- [ ] **Step 5: Implement the .NET port of the sandbox**

`Sandbox/Tokenizer.cs`:
```csharp
namespace PackageDesigner.Sandbox;

internal static class Tokenizer
{
    public static List<string> Tokenize(string sql) =>
        sql.Split(new[] { ' ', '\t', '\n', '\r', '(', ')', ',', ';' }, StringSplitOptions.RemoveEmptyEntries).ToList();
}
```

`Sandbox/KeywordChecker.cs`:
```csharp
namespace PackageDesigner.Sandbox;

internal static class KeywordChecker
{
    public static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    {
        "CREATE","TABLE","SCHEMA","DATABASE","INDEX","UNIQUE","VIEW","IF","NOT","EXISTS",
        "ALTER","ADD","COLUMN","CONSTRAINT","PRIMARY","KEY","FOREIGN","REFERENCES",
        "DEFAULT","NULL","CHECK","ON","UPDATE","DELETE","CASCADE","NO","ACTION","RESTRICT","SET",
        "ENGINE","CHARSET","COLLATE",
        "ASC","DESC","USING","BTREE","HASH",
        "INT","INTEGER","BIGINT","SMALLINT","TINYINT",
        "VARCHAR","CHAR","TEXT","NVARCHAR","NTEXT",
        "DOUBLE","FLOAT","DECIMAL","NUMERIC",
        "DATETIME","TIMESTAMP","DATETIMEOFFSET","DATE",
        "JSON","BOOLEAN","BIT",
        "AUTO_INCREMENT","IDENTITY"
    };
}
```

`Sandbox/PatternChecker.cs`:
```csharp
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
```

`Sandbox/SandboxSelfReference.cs`:
```csharp
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
```

`Sandbox/TokenWalker.cs`:
```csharp
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
```

`Sandbox/SandboxService.cs` (the public entry):
```csharp
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
        var (ok, blocked) = TokenWalker.WalkTokens(scanStripped);
        var tokens = Tokenizer.Tokenize(scanStripped);
        return new SandboxResult(ok, blocked, tokens.Count, sw.ElapsedMilliseconds);
    }
}
```

Note: `Tokenizer.Tokenize` in the .NET port does NOT split on `.` (mirrors the Node.js splitter `[\s(),;]+`).

- [ ] **Step 6: Run the test to confirm it passes**

Run: `dotnet test Tests/Sandbox/SandboxGoldenTests.cs --filter Golden_Matches_NodeJs_Output`
Expected: all fixture cases PASS.

- [ ] **Step 7: Write the focused unit tests**

`Tests/Sandbox/SandboxUnitTests.cs`:
```csharp
using PackageDesigner.Sandbox;
using Xunit;

namespace PackageDesigner.Tests.Sandbox;

public class SandboxUnitTests
{
    [Fact] public void SimpleCreate_Passes() => Assert.True(SandboxService.Scan("CREATE TABLE foo (id INT)").Ok);
    [Fact] public void DropTable_Fails() => Assert.False(SandboxService.Scan("CREATE TABLE foo (id INT); DROP TABLE foo").Ok);
    [Fact] public void OnUpdateCascade_Passes() => Assert.True(SandboxService.Scan("CREATE TABLE foo (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES bar(id) ON UPDATE CASCADE)").Ok);
    [Fact] public void OnDeleteCascade_Passes() => Assert.True(SandboxService.Scan("CREATE TABLE foo (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES bar(id) ON DELETE CASCADE)").Ok);
    [Fact] public void CrossPackage_Fails() => Assert.False(SandboxService.Scan("SELECT * FROM pkg_other.metrics").Ok);
    [Fact] public void SelfReference_Passes() => Assert.True(SandboxService.Scan("CREATE TABLE pkg_foo.metrics (id INT)", "pkg_foo").Ok);
    [Fact] public void UnknownUppercaseIdentifier_Fails() => Assert.False(SandboxService.Scan("CREATE TABLE foo (DROPPED INT)").Ok);
    [Fact] public void NumericLiteral_Passes() => Assert.True(SandboxService.Scan("CREATE TABLE foo (n INT DEFAULT 42)").Ok);
    [Fact] public void StringLiteral_Passes() => Assert.True(SandboxService.Scan("CREATE TABLE foo (s VARCHAR(10) DEFAULT 'abc')").Ok);
    [Fact] public void MultiStatement_Fails() => Assert.False(SandboxService.Scan("CREATE TABLE a (id INT); CREATE TABLE b (id INT)").Ok);
}
```

- [ ] **Step 8: Run all sandbox tests**

Run: `dotnet test --filter "FullyQualifiedName~Sandbox"`
Expected: 19+ tests pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add PackageDesigner.csproj PackageDesigner.Tests.csproj Sandbox/ Tests/ tests/fixtures/sandbox-cases.json
git commit -m "feat(wpf): port ddl-sandbox.js to .NET with golden tests"
```

## Task 2: Manifest model + JSON schema embed

**Files:**
- Create: `Models/PackageManifest.cs`
- Create: `Models/AgentConfig.cs` (with `AgentType` enum)
- Create: `Models/DatabaseConfig.cs`
- Create: `Models/MetricDef.cs`
- Create: `Resources/manifest-schema.json` (EmbeddedResource)
- Create: `Tests/Manifest/ManifestValidatorTests.cs`

**Interfaces:**
- Produces: `ManifestValidator.Validate(PackageManifest m) → { Valid, Errors[] }`
- `AgentType` enum has values `Ad`, `NonAd`. The `agent.type` JSON string is `"ad"` / `"non-ad"`.

- [ ] **Step 1: Write the failing validator test**

`Tests/Manifest/ManifestValidatorTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests.Manifest;

public class ManifestValidatorTests
{
    [Fact]
    public void Minimal_Valid_Manifest_Passes()
    {
        var m = new PackageManifest
        {
            Name = "ad-foo", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { Type = AgentType.Ad, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
        };
        var r = ManifestValidator.Validate(m);
        Assert.True(r.Valid, string.Join("; ", r.Errors));
    }

    [Fact]
    public void Missing_Version_Fails()
    {
        var m = new PackageManifest { Name = "ad-foo", Type = "gauge" };
        var r = ManifestValidator.Validate(m);
        Assert.False(r.Valid);
    }

    [Fact]
    public void Unknown_TopLevel_Field_Fails()
    {
        var json = "{\"name\":\"x\",\"version\":\"1.0.0\",\"type\":\"gauge\",\"junk\":1}";
        var r = ManifestValidator.ValidateJson(json);
        Assert.False(r.Valid);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/Manifest/ManifestValidatorTests.cs --filter Minimal_Valid_Manifest_Passes`
Expected: `ManifestValidator does not exist`.

- [ ] **Step 3: Write the model classes**

`Models/AgentConfig.cs`:
```csharp
namespace PackageDesigner.Models;

public enum AgentType { Ad, NonAd }

public class AgentConfig
{
    public AgentType Type { get; set; } = AgentType.Ad;
    public string MinVersion { get; set; } = "";
    public List<string>? Platforms { get; set; }
    public string? Runtime { get; set; }
    public string Script { get; set; } = "";
    public int? TimeoutMs { get; set; }
    public int IntervalSec { get; set; }
}
```

`Models/DatabaseConfig.cs`:
```csharp
namespace PackageDesigner.Models;

public class DatabaseConfig
{
    public string SchemaName { get; set; } = "";
    public List<string> Migrations { get; set; } = new();
    public string MetricTable { get; set; } = "";
    public Dictionary<string, MetricDef> MetricSchema { get; set; } = new();
}

public class MetricDef
{
    public string Type { get; set; } = "";
    public bool? Nullable { get; set; }
}
```

`Models/PackageManifest.cs`:
```csharp
namespace PackageDesigner.Models;

public class PackageManifest
{
    public string Name { get; set; } = "";
    public string Version { get; set; } = "";
    public string Type { get; set; } = "gauge";
    public string? Description { get; set; }
    public AgentConfig Agent { get; set; } = new();
    public DatabaseConfig? Database { get; set; }
}
```

- [ ] **Step 4: Add the JSON schema**

`Resources/manifest-schema.json` (EmbeddedResource — add `<None Remove=...>` + `<EmbeddedResource Include=...>` in csproj):

```jsonc
{
  "type": "object",
  "required": ["name", "version", "type", "agent"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string", "pattern": "^[a-z0-9-]+(\\.[a-z0-9-]+)*$" },
    "version": { "type": "string" },
    "type": { "enum": ["gauge", "counter", "timeseries", "status"] },
    "description": { "type": "string" },
    "agent": {
      "type": "object",
      "required": ["minVersion", "script", "intervalSec"],
      "additionalProperties": false,
      "properties": {
        "type":        { "enum": ["ad", "non-ad"], "default": "ad" },
        "minVersion":  { "type": "string" },
        "platforms":   { "type": "array", "items": { "enum": ["windows"] } },
        "runtime":     { "enum": ["powershell"] },
        "script":      { "type": "string" },
        "timeoutMs":   { "type": "integer", "minimum": 1000, "maximum": 600000 },
        "intervalSec": { "type": "integer", "minimum": 5, "maximum": 86400 }
      }
    },
    "database": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schemaName", "migrations", "metricTable", "metricSchema"],
      "properties": {
        "schemaName":  { "type": "string", "pattern": "^pkg_[a-z0-9_]+$" },
        "migrations":  { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
        "metricTable": { "type": "string", "pattern": "^[a-z0-9_]+$" },
        "metricSchema": {
          "type": "object",
          "minProperties": 3,
          "additionalProperties": {
            "type": "object",
            "additionalProperties": false,
            "required": ["type"],
            "properties": {
              "type":     { "type": "string" },
              "nullable": { "type": "boolean" }
            }
          }
        }
      }
    }
  }
}
```

In `PackageDesigner.csproj`:
```xml
<ItemGroup>
  <EmbeddedResource Include="Resources\manifest-schema.json" />
</ItemGroup>
```

- [ ] **Step 5: Implement the validator**

`Services/ManifestValidator.cs`:
```csharp
using System.Reflection;
using System.Text.Json;
using NJsonSchema;
using NJsonSchema.Validation;

namespace PackageDesigner.Services;

public record ValidationResult(bool Valid, IReadOnlyList<string> Errors);

public static class ManifestValidator
{
    private static readonly JsonSchema Schema = Load();

    private static JsonSchema Load()
    {
        var asm = Assembly.GetExecutingAssembly();
        using var s = asm.GetManifestResourceStream("PackageDesigner.Resources.manifest-schema.json")
            ?? throw new InvalidOperationException("manifest-schema.json missing");
        using var r = new StreamReader(s);
        return JsonSchema.FromJsonAsync(r.ReadToEndAsync()).GetAwaiter().GetResult();
    }

    public static ValidationResult Validate(PackageManifest m) =>
        ValidateJson(JsonSerializer.Serialize(m, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        }));

    public static ValidationResult ValidateJson(string json)
    {
        var errors = Schema.Validate(json);
        return new ValidationResult(errors.Count == 0, errors.Select(e => $"{e.Path}: {e.Kind}").ToList());
    }
}
```

- [ ] **Step 6: Add NJsonSchema package**

Run: `dotnet add PackageDesigner.csproj package NJsonSchema --version 11.0.0`
Expected: package reference added to csproj.

- [ ] **Step 7: Run, expect pass**

Run: `dotnet test Tests/Manifest/ManifestValidatorTests.cs`
Expected: 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add PackageDesigner.csproj Resources/manifest-schema.json Models/ Services/ Tests/Manifest/
git commit -m "feat(wpf): manifest model + embedded json schema + validator"
```

## Task 3: `agent.type` enum + Non-AD starter template scaffolding (PATCHED 2026-08-09)

**Files:**
- Modify: `Models/AgentConfig.cs` (already includes `AgentType` from Task 2; this task adds the round-trip JSON conversion test)
- Create: `Models/StarterTemplate.cs`
- Create: `Services/StarterTemplateService.cs`
- Create: `Resources/templates/ad-monitoring-lite.zip` (EmbeddedResource)
- Create: `Resources/templates/ad-os-baseline-lite.zip` (EmbeddedResource)
- Create: `Tests/Manifest/ManifestAgentTypeTests.cs`
- Create: `Tests/StarterTemplateTests.cs`

**Interfaces:**
- Produces: `StarterTemplateService.Load(StarterTemplate which) → PackageProject`
- `StarterTemplate` enum: `AdMonitoringLite`, `AdOsBaselineLite`.
- The Non-AD template's embedded `manifest.json` has `"agent": { "type": "non-ad" }` and includes the `database` block with `schemaName: "pkg_ad_os_baseline_lite"`.

- [ ] **Step 1: Write the failing test for `agent.type` enum round-trip**

`Tests/Manifest/ManifestAgentTypeTests.cs`:
```csharp
using System.Text.Json;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests.Manifest;

public class ManifestAgentTypeTests
{
    [Fact]
    public void AgentType_NonAd_Serializes_As_SnakeCase_String()
    {
        var m = new PackageManifest
        {
            Name = "ad-os-baseline-lite", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
        };
        var json = JsonSerializer.Serialize(m, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        });
        Assert.Contains("\"type\":\"non-ad\"", json);
    }

    [Fact]
    public void AgentType_Ad_Round_Trips_Through_Json()
    {
        var json = "{\"name\":\"x\",\"version\":\"1.0.0\",\"type\":\"gauge\",\"agent\":{\"type\":\"ad\",\"minVersion\":\"0.1.0\",\"script\":\"collect.ps1\",\"intervalSec\":60}}";
        var m = JsonSerializer.Deserialize<PackageManifest>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        });
        Assert.NotNull(m);
        Assert.Equal(AgentType.Ad, m!.Agent.Type);
    }

    [Fact]
    public void AgentType_Invalid_Value_Fails_Validation()
    {
        var json = "{\"name\":\"x\",\"version\":\"1.0.0\",\"type\":\"gauge\",\"agent\":{\"type\":\"weird\",\"minVersion\":\"0.1.0\",\"script\":\"collect.ps1\",\"intervalSec\":60}}";
        var r = ManifestValidator.ValidateJson(json);
        Assert.False(r.Valid);
    }
}
```

- [ ] **Step 2: Run, expect fail**

Run: `dotnet test Tests/Manifest/ManifestAgentTypeTests.cs --filter AgentType_NonAd_Serializes_As_SnakeCase_String`
Expected: FAIL — the snake-case string conversion is not present (current `JsonStringEnumConverter` emits `"NonAd"` by default; need naming policy override).

- [ ] **Step 3: Update the validator's serialization to use snake-case enum names**

In `Services/ManifestValidator.cs`, the JSON serialization options already include a `JsonStringEnumConverter`. Replace with one that uses snake-case naming:

```csharp
Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) }
```

`JsonNamingPolicy.SnakeCaseLower` is built-in in .NET 8. Apply this in BOTH `Validate` and any new `RoundTrip` helper used by `ManifestAgentTypeTests`. For deserialize, the same converter with `PropertyNameCaseInsensitive = true` handles `"ad"`, `"non-ad"`, `"Ad"`, `"NonAd"`.

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/Manifest/ManifestAgentTypeTests.cs`
Expected: 3 tests pass.

- [ ] **Step 5: Write the failing starter-template test**

`Tests/StarterTemplateTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class StarterTemplateTests
{
    [Fact]
    public void Ad_Template_Has_AgentType_Ad()
    {
        var p = StarterTemplateService.Load(StarterTemplate.AdMonitoringLite);
        Assert.Equal(AgentType.Ad, p.Manifest.Agent.Type);
    }

    [Fact]
    public void NonAd_Template_Has_AgentType_NonAd_And_Database_Block()
    {
        var p = StarterTemplateService.Load(StarterTemplate.AdOsBaselineLite);
        Assert.Equal(AgentType.NonAd, p.Manifest.Agent.Type);
        Assert.NotNull(p.Manifest.Database);
        Assert.StartsWith("pkg_", p.Manifest.Database!.SchemaName);
        Assert.Contains("001_initial.sql", p.Manifest.Database.Migrations);
        Assert.Contains("cpu_pct", p.Manifest.Database.MetricSchema.Keys);
    }

    [Fact]
    public void Both_Templates_Have_Collect_Ps1()
    {
        foreach (var t in new[] { StarterTemplate.AdMonitoringLite, StarterTemplate.AdOsBaselineLite })
        {
            var p = StarterTemplateService.Load(t);
            Assert.Contains(p.Files, f => f.Path == "collect.ps1");
        }
    }
}
```

- [ ] **Step 6: Run, expect compile error**

Run: `dotnet test Tests/StarterTemplateTests.cs`
Expected: `StarterTemplateService does not exist`.

- [ ] **Step 7: Implement the model and service**

`Models/StarterTemplate.cs`:
```csharp
namespace PackageDesigner.Models;

public enum StarterTemplate { AdMonitoringLite, AdOsBaselineLite }
```

`Services/StarterTemplateService.cs`:
```csharp
using System.IO.Compression;
using System.Reflection;
using System.Text;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

public static class StarterTemplateService
{
    public static PackageProject Load(StarterTemplate which)
    {
        var name = which switch
        {
            StarterTemplate.AdMonitoringLite  => "PackageDesigner.Resources.templates.ad-monitoring-lite.zip",
            StarterTemplate.AdOsBaselineLite => "PackageDesigner.Resources.templates.ad-os-baseline-lite.zip",
            _ => throw new ArgumentOutOfRangeException(nameof(which))
        };
        var asm = Assembly.GetExecutingAssembly();
        using var s = asm.GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"template {which} missing");
        using var ms = new MemoryStream();
        s.CopyTo(ms);
        ms.Position = 0;
        return PackageService.ReadZip(ms);   // provided by Task 4
    }
}
```

- [ ] **Step 8: Build the template zips**

The two zips are committed binary blobs. To produce them:

1. Create a temp dir, write `manifest.json` + `collect.ps1` + `migrations/001_initial.sql` per spec.
2. Zip the contents (top-level files at zip root).
3. Compute `content.sha256`.
4. Add to `PackageDesigner/Resources/templates/<name>.zip`.
5. Add to csproj as `<EmbeddedResource Include="Resources\templates\*.zip" />`.

**`ad-monitoring-lite` contents:**
```json
// manifest.json
{
  "name": "ad-monitoring-lite",
  "version": "1.0.0",
  "type": "gauge",
  "description": "AD starter package — CPU + memory",
  "agent": {
    "type": "ad",
    "minVersion": "0.1.0",
    "platforms": ["windows"],
    "runtime": "powershell",
    "script": "collect.ps1",
    "timeoutMs": 20000,
    "intervalSec": 60
  },
  "database": {
    "schemaName": "pkg_ad_monitoring_lite",
    "migrations": ["migrations/001_initial.sql"],
    "metricTable": "metrics",
    "metricSchema": {
      "agent_id":   { "type": "varchar(64)", "nullable": false },
      "ts":         { "type": "datetime",    "nullable": false },
      "cpu_pct":    { "type": "double" },
      "memory_pct": { "type": "double" }
    }
  }
}
```
```sql
-- migrations/001_initial.sql
CREATE TABLE metrics (
  agent_id   VARCHAR(64) NOT NULL,
  ts         DATETIME    NOT NULL,
  cpu_pct    DOUBLE NULL,
  memory_pct DOUBLE NULL
);
```
```powershell
# collect.ps1
$cpu = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue
$mem = (Get-CimInstance Win32_OperatingSystem)
$pct = [math]::Round(($mem.TotalVisibleMemorySize - $mem.FreePhysicalMemory) / $mem.TotalVisibleMemorySize * 100, 2)
@{ metrics = @{ cpu_pct = $cpu; memory_pct = $pct } } | ConvertTo-Json -Compress
```

**`ad-os-baseline-lite` contents:** identical except:
- `name: "ad-os-baseline-lite"`, `description: "Non-AD starter package — CPU + memory"`.
- `agent.type: "non-ad"`.
- `schemaName: "pkg_ad_os_baseline_lite"`.
- `collect.ps1` returns the same shape (Non-AD agent also runs PowerShell).

- [ ] **Step 9: Run starter-template tests, expect pass**

Run: `dotnet test Tests/StarterTemplateTests.cs`
Expected: 3 tests pass.

- [ ] **Step 10: Commit**

```bash
git add Models/StarterTemplate.cs Services/StarterTemplateService.cs Resources/templates/ PackageDesigner.csproj Tests/Manifest/ Tests/StarterTemplateTests.cs
git commit -m "feat(wpf): agent.type enum + non-AD starter template"
```

## Task 4: PackageService (zip / .pkgproj I/O)

**Files:**
- Create: `Models/PackageFile.cs`
- Create: `Models/PackageProject.cs`
- Create: `Services/PackageService.cs`
- Create: `Tests/PackageServiceTests.cs`

**Interfaces:**
- `PackageService.ReadZip(Stream s) → PackageProject`
- `PackageService.WriteZip(PackageProject p, Stream s) → void`
- `PackageProject.Files: List<PackageFile>` where `PackageFile { string Path, string Role, string Checksum }`. Role is one of `"manifest"`, `"migration"`, `"ps1"`, `"other"`.

- [ ] **Step 1: Write the failing test**

`Tests/PackageServiceTests.cs`:
```csharp
using System.IO;
using System.Text;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class PackageServiceTests
{
    [Fact]
    public void Roundtrip_Zip_Preserves_All_Files()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } },
            Files = new()
            {
                new() { Path = "manifest.json",        Role = "manifest",  Checksum = "" },
                new() { Path = "collect.ps1",          Role = "ps1",       Checksum = "" },
                new() { Path = "migrations/001_initial.sql", Role = "migration", Checksum = "" }
            }
        };
        p.RawFiles["manifest.json"]              = "{\"name\":\"x\"}";
        p.RawFiles["collect.ps1"]                = "# hello";
        p.RawFiles["migrations/001_initial.sql"] = "CREATE TABLE foo (id INT)";

        using var ms = new MemoryStream();
        PackageService.WriteZip(p, ms);
        ms.Position = 0;
        var p2 = PackageService.ReadZip(ms);
        Assert.Equal(p.RawFiles["manifest.json"], p2.RawFiles["manifest.json"]);
        Assert.Equal(p.RawFiles["collect.ps1"],   p2.RawFiles["collect.ps1"]);
        Assert.Equal(p.RawFiles["migrations/001_initial.sql"], p2.RawFiles["migrations/001_initial.sql"]);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/PackageServiceTests.cs`
Expected: `PackageService does not exist`.

- [ ] **Step 3: Implement the model and service**

`Models/PackageFile.cs`:
```csharp
namespace PackageDesigner.Models;
public class PackageFile { public string Path { get; set; } = ""; public string Role { get; set; } = "other"; public string Checksum { get; set; } = ""; }
```

`Models/PackageProject.cs`:
```csharp
namespace PackageDesigner.Models;
public class PackageProject
{
    public PackageManifest Manifest { get; set; } = new();
    public List<PackageFile> Files { get; set; } = new();
    public Dictionary<string, string> RawFiles { get; set; } = new();
    public string? LastPublishedAt { get; set; }
}
```

`Services/PackageService.cs`:
```csharp
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

public static class PackageService
{
    public static PackageProject ReadZip(Stream s)
    {
        var p = new PackageProject();
        using var zip = new ZipArchive(s, ZipArchiveMode.Read);
        foreach (var e in zip.Entries)
        {
            using var r = new StreamReader(e.Open());
            var content = r.ReadToEnd();
            p.RawFiles[e.FullName] = content;
            if (e.FullName == "manifest.json")
            {
                p.Manifest = JsonSerializer.Deserialize<PackageManifest>(content, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                    Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
                }) ?? new();
            }
        }
        p.Files = p.RawFiles.Keys.Select(path => new PackageFile
        {
            Path = path,
            Role = path switch
            {
                "manifest.json" => "manifest",
                "collect.ps1"   => "ps1",
                var x when x.StartsWith("migrations/") && x.EndsWith(".sql") => "migration",
                _ => "other"
            }
        }).ToList();
        return p;
    }

    public static void WriteZip(PackageProject p, Stream s)
    {
        using var zip = new ZipArchive(s, ZipArchiveMode.Create);
        foreach (var (path, content) in p.RawFiles)
        {
            var entry = zip.CreateEntry(path);
            using var w = new StreamWriter(entry.Open(), Encoding.UTF8);
            w.Write(content);
        }
    }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/PackageServiceTests.cs`
Expected: 1 test pass.

- [ ] **Step 5: Commit**

```bash
git add Models/PackageFile.cs Models/PackageProject.cs Services/PackageService.cs Tests/PackageServiceTests.cs
git commit -m "feat(wpf): PackageService zip read/write"
```

## Task 5: .pkgproj persistence + atomic writes

**Files:**
- Create: `Services/PersistenceService.cs` (atomic save)
- Create: `Tests/PersistenceServiceTests.cs`

**Interfaces:**
- `PersistenceService.Save(PackageProject p, string path) → void` (atomic: temp + rename)
- `PersistenceService.Load(string path) → PackageProject`

- [ ] **Step 1: Write the failing test**

`Tests/PersistenceServiceTests.cs`:
```csharp
using System.IO;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class PersistenceServiceTests
{
    [Fact]
    public void Roundtrip_Pkgproj_Preserves_Manifest_And_Files()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            var p = new PackageProject
            {
                Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                    Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } }
            };
            p.RawFiles["manifest.json"] = "{\"name\":\"x\"}";
            PersistenceService.Save(p, tmp);
            var p2 = PersistenceService.Load(tmp);
            Assert.Equal(AgentType.NonAd, p2.Manifest.Agent.Type);
            Assert.Equal("x", p2.Manifest.Name);
            Assert.True(File.Exists(tmp));
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }

    [Fact]
    public void Save_Is_Atomic_No_Temp_File_Left()
    {
        var tmp = Path.Combine(Path.GetTempPath(), $"pkgproj-{Guid.NewGuid():N}.json");
        try
        {
            PersistenceService.Save(new PackageProject(), tmp);
            var temp = tmp + ".tmp";
            Assert.False(File.Exists(temp));
        }
        finally
        {
            if (File.Exists(tmp)) File.Delete(tmp);
        }
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/PersistenceServiceTests.cs`
Expected: `PersistenceService does not exist`.

- [ ] **Step 3: Implement**

`Services/PersistenceService.cs`:
```csharp
using System.Text.Json;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

public static class PersistenceService
{
    public static void Save(PackageProject p, string path)
    {
        var dir = Path.GetDirectoryName(path) ?? ".";
        Directory.CreateDirectory(dir);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(p, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(temp, path, overwrite: true);
    }

    public static PackageProject Load(string path) =>
        JsonSerializer.Deserialize<PackageProject>(File.ReadAllText(path), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
        }) ?? new();
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/PersistenceServiceTests.cs`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add Services/PersistenceService.cs Tests/PersistenceServiceTests.cs
git commit -m "feat(wpf): atomic .pkgproj persistence"
```

## Task 6: CredentialService + SettingsService

**Files:**
- Create: `Services/CredentialService.cs`
- Create: `Services/SettingsService.cs`
- Create: `Tests/CredentialServiceTests.cs` (uses a fake ICredentialStore seam)
- Create: `Tests/SettingsServiceTests.cs`

**Interfaces:**
- `CredentialService.Set(string centerUrl, string token)`, `Get(string centerUrl) → string?`, `Clear(string centerUrl)`. Internally delegates to a `ICredentialStore` for testability. Production wires up `Meziantou.Framework.Win32.CredentialManager`.
- `SettingsService { centerUrl, lastTemplate }` persisted to `%APPDATA%\PackageDesigner\settings.json`.

- [ ] **Step 1: Write the failing test**

`Tests/CredentialServiceTests.cs`:
```csharp
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class CredentialServiceTests
{
    [Fact]
    public void Roundtrip_Token_Through_Store()
    {
        var store = new InMemoryCredentialStore();
        var svc = new CredentialService(store);
        svc.Set("https://center.example.com", "tok-123");
        Assert.Equal("tok-123", svc.Get("https://center.example.com"));
        svc.Clear("https://center.example.com");
        Assert.Null(svc.Get("https://center.example.com"));
    }

    private class InMemoryCredentialStore : ICredentialStore
    {
        public Dictionary<string, string> Map { get; } = new();
        public string? Read(string key) => Map.TryGetValue(key, out var v) ? v : null;
        public void Write(string key, string value) => Map[key] = value;
        public void Delete(string key) => Map.Remove(key);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/CredentialServiceTests.cs`
Expected: `CredentialService does not exist`.

- [ ] **Step 3: Implement**

`Services/CredentialService.cs`:
```csharp
namespace PackageDesigner.Services;

public interface ICredentialStore
{
    string? Read(string key);
    void Write(string key, string value);
    void Delete(string key);
}

public class CredentialService
{
    private readonly ICredentialStore _store;
    public CredentialService(ICredentialStore store) => _store = store;

    private static string Key(string centerUrl) => "PackageDesigner:" + centerUrl.TrimEnd('/');

    public void Set(string centerUrl, string token) => _store.Write(Key(centerUrl), token);
    public string? Get(string centerUrl) => _store.Read(Key(centerUrl));
    public void Clear(string centerUrl) => _store.Delete(Key(centerUrl));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/CredentialServiceTests.cs`
Expected: 1 test pass.

- [ ] **Step 5: Settings test**

`Tests/SettingsServiceTests.cs`:
```csharp
using System.IO;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class SettingsServiceTests
{
    [Fact]
    public void Default_Settings_Are_Empty()
    {
        var svc = new SettingsService(Path.Combine(Path.GetTempPath(), $"settings-{Guid.NewGuid():N}.json"));
        Assert.Equal("", svc.CenterUrl);
    }

    [Fact]
    public void Roundtrip_Settings()
    {
        var path = Path.Combine(Path.GetTempPath(), $"settings-{Guid.NewGuid():N}.json");
        try
        {
            var svc = new SettingsService(path);
            svc.CenterUrl = "https://c.example.com";
            svc.Save();
            var svc2 = new SettingsService(path);
            Assert.Equal("https://c.example.com", svc2.CenterUrl);
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }
}
```

- [ ] **Step 6: Implement SettingsService**

`Services/SettingsService.cs`:
```csharp
using System.Text.Json;
namespace PackageDesigner.Services;

public class SettingsService
{
    private readonly string _path;
    public string CenterUrl { get; set; } = "";
    public string LastTemplate { get; set; } = "ad-monitoring-lite";

    public SettingsService(string path) { _path = path; Load(); }

    private record Persisted(string CenterUrl, string LastTemplate);

    public void Load()
    {
        if (!File.Exists(_path)) return;
        var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_path));
        if (p is null) return;
        CenterUrl = p.CenterUrl;
        LastTemplate = p.LastTemplate;
    }

    public void Save() => File.WriteAllText(_path,
        JsonSerializer.Serialize(new Persisted(CenterUrl, LastTemplate)));
}
```

In `App.xaml.cs` (the composition root), instantiate `SettingsService` with `%APPDATA%\PackageDesigner\settings.json`. This file is created at first launch.

- [ ] **Step 7: Run, expect pass**

Run: `dotnet test Tests/SettingsServiceTests.cs`
Expected: 2 tests pass.

- [ ] **Step 8: Add Meziantou dependency**

Run: `dotnet add PackageDesigner.csproj package Meziantou.Framework.Win32.CredentialManager --version 1.1.5`
Expected: package added.

- [ ] **Step 9: Wire production credential store**

Add `MeziantouCredentialStore : ICredentialStore` in `Services/MeziantouCredentialStore.cs`:
```csharp
using Meziantou.Framework.Win32;
namespace PackageDesigner.Services;
public class MeziantouCredentialStore : ICredentialStore
{
    public string? Read(string key) => CredentialManager.ReadCredential(key)?.Password;
    public void Write(string key, string value) => CredentialManager.WriteCredential(key, value, CredentialPersistence.LocalMachine);
    public void Delete(string key) => CredentialManager.DeleteCredential(key);
}
```

- [ ] **Step 10: Commit**

```bash
git add Services/CredentialService.cs Services/SettingsService.cs Services/MeziantouCredentialStore.cs PackageDesigner.csproj Tests/
git commit -m "feat(wpf): credential + settings services"
```

## Task 7: PublishService

**Files:**
- Create: `Services/PublishService.cs`
- Create: `Tests/PublishServiceTests.cs`

**Interfaces:**
- `PublishService.PublishAsync(PackageProject p, string centerUrl, string token, IProgress<double>? progress, CancellationToken ct) → PublishResult`
- `PublishResult { bool Ok, string? ErrorCode, string? ErrorMessage, int StatusCode }`
- The HTTP body is JSON with `buffer` base64-encoded (per spec — NOT multipart).

- [ ] **Step 1: Write the failing test using a fake HttpMessageHandler**

`Tests/PublishServiceTests.cs`:
```csharp
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class PublishServiceTests
{
    [Fact]
    public async Task Publish_Sends_Json_Not_Multipart()
    {
        string? seenContentType = null;
        string? seenBody = null;
        var handler = new StubHandler((req, ct) =>
        {
            seenContentType = req.Content?.Headers.ContentType?.MediaType;
            seenBody = req.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true}") };
        });
        var http = new HttpClient(handler);
        var svc = new PublishService(http);
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Agent = new AgentConfig { Type = AgentType.NonAd, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } }
        };
        p.RawFiles["manifest.json"] = "{}";
        p.RawFiles["collect.ps1"]   = "# ps1";
        var r = await svc.PublishAsync(p, "https://c.example.com", "tok", null, CancellationToken.None);
        Assert.True(r.Ok);
        Assert.Equal("application/json", seenContentType);
        Assert.NotNull(seenBody);
        Assert.Contains("\"buffer\":", seenBody!);  // base64 buffer present
    }

    private class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> _h;
        public StubHandler(Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> h) => _h = h;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct) => Task.FromResult(_h(req, ct));
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/PublishServiceTests.cs`
Expected: `PublishService does not exist`.

- [ ] **Step 3: Implement**

`Services/PublishService.cs`:
```csharp
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PackageDesigner.Models;

namespace PackageDesigner.Services;

public record PublishResult(bool Ok, int StatusCode, string? ErrorCode, string? ErrorMessage);

public class PublishService
{
    private readonly HttpClient _http;
    public PublishService(HttpClient http) => _http = http;

    public async Task<PublishResult> PublishAsync(PackageProject p, string centerUrl, string token, IProgress<double>? progress, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        PackageService.WriteZip(p, ms);
        var b64 = Convert.ToBase64String(ms.ToArray());
        var body = new
        {
            source = "buffer",
            packageRef = (string?)null,
            buffer = b64,
            confirmDropSchema = false
        };
        var json = JsonSerializer.Serialize(body);
        var req = new HttpRequestMessage(HttpMethod.Post, centerUrl.TrimEnd('/') + "/api/admin/packages/install")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        progress?.Report(0.5);
        using var resp = await _http.SendAsync(req, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        progress?.Report(1.0);
        if (resp.IsSuccessStatusCode) return new PublishResult(true, (int)resp.StatusCode, null, null);
        try
        {
            var err = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(text);
            var inner = err!["error"];
            return new PublishResult(false, (int)resp.StatusCode, inner.GetProperty("code").GetString(), inner.GetProperty("message").GetString());
        }
        catch
        {
            return new PublishResult(false, (int)resp.StatusCode, "INTERNAL", text);
        }
    }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/PublishServiceTests.cs`
Expected: 1 test pass.

- [ ] **Step 5: Commit**

```bash
git add Services/PublishService.cs Tests/PublishServiceTests.cs
git commit -m "feat(wpf): PublishService JSON+base64 to /api/admin/packages/install"
```

## Task 8: AutoSaveService + RecoveryService

**Files:**
- Create: `Services/AutoSaveService.cs`
- Create: `Services/RecoveryService.cs`
- Create: `Tests/AutoSaveServiceTests.cs`
- Create: `Tests/RecoveryServiceTests.cs`

**Interfaces:**
- `AutoSaveService` runs two timers: 5s idle and 30s heartbeat. Each timer callback runs on `Task.Run` (off the UI thread). Save is idempotent — only writes if `LastModified > LastSaved`.
- `RecoveryService.Scan(workspaceDir) → IReadOnlyList<RecoveryEntry>` returns one entry per `.pkgproj` with an incomplete `auto-save.log`.

- [ ] **Step 1: Write the AutoSave test**

`Tests/AutoSaveServiceTests.cs`:
```csharp
using System.IO;
using System.Threading.Tasks;
using PackageDesigner.Models;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class AutoSaveServiceTests
{
    [Fact]
    public async Task SaveIfDirty_Persists_When_Project_Dirty()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"autosave-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var p = new PackageProject
            {
                Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                    Agent = new AgentConfig { Type = AgentType.Ad, MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 } }
            };
            var svc = new AutoSaveService();
            await svc.SaveIfDirtyAsync(p, Path.Combine(dir, "x.pkgproj"), dirty: true);
            Assert.True(File.Exists(Path.Combine(dir, "x.pkgproj")));
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task SaveIfDirty_Skips_When_Not_Dirty()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"autosave-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var p = new PackageProject();
            var svc = new AutoSaveService();
            await svc.SaveIfDirtyAsync(p, Path.Combine(dir, "x.pkgproj"), dirty: false);
            Assert.False(File.Exists(Path.Combine(dir, "x.pkgproj")));
        }
        finally { Directory.Delete(dir, true); }
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/AutoSaveServiceTests.cs`
Expected: `AutoSaveService does not exist`.

- [ ] **Step 3: Implement**

`Services/AutoSaveService.cs`:
```csharp
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
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/AutoSaveServiceTests.cs`
Expected: 2 tests pass.

- [ ] **Step 5: Write the recovery test**

`Tests/RecoveryServiceTests.cs`:
```csharp
using System.IO;
using PackageDesigner.Services;
using Xunit;

namespace PackageDesigner.Tests;

public class RecoveryServiceTests
{
    [Fact]
    public void Scan_Returns_Empty_When_No_Logs()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"recovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            var entries = RecoveryService.Scan(dir);
            Assert.Empty(entries);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public void Scan_Returns_One_Entry_Per_Incomplete_Log()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"recovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "x.auto-save.log"),
                "{\"ts\":\"2026-08-09T12:00:00Z\",\"event\":\"incremental\",\"file\":\"manifest.json\"}\n");
            var entries = RecoveryService.Scan(dir);
            Assert.Single(entries);
            Assert.Equal("x.pkgproj", entries[0].ProjectName);
        }
        finally { Directory.Delete(dir, true); }
    }
}
```

- [ ] **Step 6: Implement RecoveryService**

`Services/RecoveryService.cs`:
```csharp
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
```

- [ ] **Step 7: Run, expect pass**

Run: `dotnet test Tests/RecoveryServiceTests.cs`
Expected: 2 tests pass.

- [ ] **Step 8: Commit**

```bash
git add Services/AutoSaveService.cs Services/RecoveryService.cs Tests/
git commit -m "feat(wpf): auto-save + crash recovery services"
```

## Task 9: ManifestFormView + ManifestViewModel

**Files:**
- Create: `ViewModels/ManifestViewModel.cs`
- Create: `Views/ManifestFormView.xaml` + `.cs`
- Create: `Tests/ViewModel/ManifestViewModelTests.cs`

**Interfaces:**
- `ManifestViewModel` exposes bindable properties mirroring `PackageManifest` + nested `AgentConfig`/`DatabaseConfig`. Two-way bound to `ManifestFormView` XAML. Implements `INotifyPropertyChanged` manually.
- The view exposes a "Add Migration" / "Remove Migration" button pair (per spec §7.1) — both write through the VM.
- An `Agent Type` dropdown is part of the form (PATCHED 2026-08-09), items: `Ad`, `NonAd`.

- [ ] **Step 1: Write the failing VM test**

`Tests/ViewModel/ManifestViewModelTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class ManifestViewModelTests
{
    [Fact]
    public void AgentType_Roundtrips_Through_Property()
    {
        var m = new PackageManifest
        {
            Name = "x", Version = "1.0.0", Type = "gauge",
            Agent = new AgentConfig { MinVersion = "0.1.0", Script = "collect.ps1", IntervalSec = 60 }
        };
        var vm = new ManifestViewModel(m);
        Assert.Equal(AgentType.Ad, vm.AgentType);
        vm.AgentType = AgentType.NonAd;
        Assert.Equal(AgentType.NonAd, m.Agent.Type);
    }

    [Fact]
    public void AddMigration_Appends_To_List()
    {
        var m = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge" };
        var vm = new ManifestViewModel(m);
        vm.NewMigrationPath = "migrations/002_add_index.sql";
        vm.AddMigration();
        Assert.Contains("migrations/002_add_index.sql", m.Database!.Migrations);
    }

    [Fact]
    public void RemoveMigration_Removes_From_List()
    {
        var m = new PackageManifest
        {
            Name = "x", Version = "1.0.0", Type = "gauge",
            Database = new DatabaseConfig { SchemaName = "pkg_x", Migrations = new() { "migrations/001.sql", "migrations/002.sql" }, MetricTable = "metrics", MetricSchema = new() }
        };
        var vm = new ManifestViewModel(m);
        vm.RemoveMigration("migrations/001.sql");
        Assert.DoesNotContain("migrations/001.sql", m.Database.Migrations);
        Assert.Single(m.Database.Migrations);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/ViewModel/ManifestViewModelTests.cs`
Expected: `ManifestViewModel does not exist`.

- [ ] **Step 3: Implement the VM**

`ViewModels/ManifestViewModel.cs`:
```csharp
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class ManifestViewModel : INotifyPropertyChanged
{
    private readonly PackageManifest _m;
    public PackageManifest Model => _m;

    public ManifestViewModel(PackageManifest m) { _m = m; }

    public string Name { get => _m.Name; set { _m.Name = value; OnChanged(); } }
    public string Version { get => _m.Version; set { _m.Version = value; OnChanged(); } }
    public string Type { get => _m.Type; set { _m.Type = value; OnChanged(); } }
    public string? Description { get => _m.Description; set { _m.Description = value; OnChanged(); } }

    public AgentType AgentType
    {
        get => _m.Agent.Type;
        set { _m.Agent.Type = value; OnChanged(); }
    }

    public string MinVersion { get => _m.Agent.MinVersion; set { _m.Agent.MinVersion = value; OnChanged(); } }
    public string Script { get => _m.Agent.Script; set { _m.Agent.Script = value; OnChanged(); } }
    public int IntervalSec { get => _m.Agent.IntervalSec; set { _m.Agent.IntervalSec = value; OnChanged(); } }
    public int? TimeoutMs { get => _m.Agent.TimeoutMs; set { _m.Agent.TimeoutMs = value; OnChanged(); } }

    public string SchemaName
    {
        get => _m.Database?.SchemaName ?? "";
        set { EnsureDatabase().SchemaName = value; OnChanged(); }
    }
    public string MetricTable
    {
        get => _m.Database?.MetricTable ?? "";
        set { EnsureDatabase().MetricTable = value; OnChanged(); }
    }
    public ObservableCollection<string> Migrations { get; } = new();

    public ManifestViewModel() : this(new PackageManifest()) { }
    public ManifestViewModel(PackageManifest m) : this()
    {
        if (m.Database is not null) foreach (var x in m.Database.Migrations) Migrations.Add(x);
    }
    private DatabaseConfig EnsureDatabase() => _m.Database ??= new DatabaseConfig();

    public string NewMigrationPath { get; set; } = "";
    public void AddMigration()
    {
        if (string.IsNullOrWhiteSpace(NewMigrationPath)) return;
        EnsureDatabase().Migrations.Add(NewMigrationPath);
        Migrations.Add(NewMigrationPath);
        NewMigrationPath = "";
        OnChanged();
    }
    public void RemoveMigration(string path)
    {
        EnsureDatabase().Migrations.Remove(path);
        Migrations.Remove(path);
        OnChanged();
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/ViewModel/ManifestViewModelTests.cs`
Expected: 3 tests pass.

- [ ] **Step 5: Add the AvalonEdit dependency**

Run: `dotnet add PackageDesigner.csproj package AvalonEdit --version 6.3.0`
Expected: package added.

- [ ] **Step 6: Create the XAML view**

`Views/ManifestFormView.xaml` (excerpt — full file uses WPF StackPanel + Grid binding to the VM):
```xml
<UserControl x:Class="PackageDesigner.Views.ManifestFormView"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="clr-namespace:PackageDesigner.ViewModels"
             xmlns:m="clr-namespace:PackageDesigner.Models">
  <UserControl.Resources>
    <ObjectDataProvider x:Key="AgentTypes" MethodName="GetValues" ObjectType="{x:Type m:AgentType}">
      <ObjectDataProvider.MethodParameters><x:Type TypeName="m:AgentType"/></ObjectDataProvider.MethodParameters>
    </ObjectDataProvider>
  </UserControl.Resources>
  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/>
    </Grid.RowDefinitions>
    <Grid.ColumnDefinitions><ColumnDefinition Width="160"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>

    <TextBlock Grid.Row="0" Grid.Column="0" Text="Name"/><TextBox Grid.Row="0" Grid.Column="1" Text="{Binding Name, UpdateSourceTrigger=PropertyChanged}"/>
    <TextBlock Grid.Row="1" Grid.Column="0" Text="Version"/><TextBox Grid.Row="1" Grid.Column="1" Text="{Binding Version}"/>
    <TextBlock Grid.Row="2" Grid.Column="0" Text="Type"/><TextBox Grid.Row="2" Grid.Column="1" Text="{Binding Type}"/>
    <TextBlock Grid.Row="3" Grid.Column="0" Text="Description"/><TextBox Grid.Row="3" Grid.Column="1" Text="{Binding Description}"/>
    <TextBlock Grid.Row="4" Grid.Column="0" Text="Agent Type"/><ComboBox Grid.Row="4" Grid.Column="1" ItemsSource="{Binding Source={StaticResource AgentTypes}}" SelectedItem="{Binding AgentType}"/>
    <TextBlock Grid.Row="5" Grid.Column="0" Text="MinVersion"/><TextBox Grid.Row="5" Grid.Column="1" Text="{Binding MinVersion}"/>
    <TextBlock Grid.Row="6" Grid.Column="0" Text="Script"/><TextBox Grid.Row="6" Grid.Column="1" Text="{Binding Script}"/>
    <TextBlock Grid.Row="7" Grid.Column="0" Text="IntervalSec"/><TextBox Grid.Row="7" Grid.Column="1" Text="{Binding IntervalSec}"/>
    <TextBlock Grid.Row="8" Grid.Column="0" Text="TimeoutMs"/><TextBox Grid.Row="8" Grid.Column="1" Text="{Binding TimeoutMs}"/>
    <TextBlock Grid.Row="9" Grid.Column="0" Text="SchemaName"/><TextBox Grid.Row="9" Grid.Column="1" Text="{Binding SchemaName}"/>
    <TextBlock Grid.Row="10" Grid.Column="0" Text="MetricTable"/><TextBox Grid.Row="10" Grid.Column="1" Text="{Binding MetricTable}"/>

    <StackPanel Grid.Row="11" Grid.ColumnSpan="2">
      <TextBlock Text="Migrations"/>
      <ListBox ItemsSource="{Binding Migrations}" Height="100"/>
      <DockPanel>
        <Button DockPanel.Dock="Right" Content="+" Command="{Binding AddMigrationCommand}" Click="AddMigration_Click"/>
        <Button DockPanel.Dock="Right" Content="-" Click="RemoveMigration_Click"/>
        <TextBox Text="{Binding NewMigrationPath, UpdateSourceTrigger=PropertyChanged}"/>
      </DockPanel>
    </StackPanel>
  </Grid>
</UserControl>
```

`Views/ManifestFormView.xaml.cs` (excerpt):
```csharp
public partial class ManifestFormView : UserControl
{
    public ManifestViewModel ViewModel { get; private set; }
    public ManifestFormView(ManifestViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void AddMigration_Click(object sender, RoutedEventArgs e) => ViewModel.AddMigration();
    private void RemoveMigration_Click(object sender, RoutedEventArgs e)
    {
        if (ViewModel.Migrations.Count > 0) ViewModel.RemoveMigration(ViewModel.Migrations[^1]);
    }
}
```

- [ ] **Step 7: Compile + manual smoke**

Run: `dotnet build PackageDesigner.csproj`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add ViewModels/ManifestViewModel.cs Views/ManifestFormView.xaml Views/ManifestFormView.xaml.cs Tests/ViewModel/ManifestViewModelTests.cs PackageDesigner.csproj
git commit -m "feat(wpf): ManifestFormView + ViewModel with agent.type dropdown"
```

## Task 10: SqlEditorView (AvalonEdit + sandbox status strip)

**Files:**
- Create: `ViewModels/SqlFileViewModel.cs`
- Create: `Views/SqlEditorView.xaml` + `.cs`
- Create: `Tests/ViewModel/SqlFileViewModelTests.cs`

**Interfaces:**
- `SqlFileViewModel` wraps a `PackageFile` of `Role = "migration"`. Property `Body` notifies `INotifyPropertyChanged`. `Status` (read-only) reflects the latest `SandboxService.Scan(Body)` result.
- The view hosts an AvalonEdit `TextEditor` with SQL syntax highlighting (C# language binding via `XmlSql` not available — use plain `TextEditor` with monospace font; the SQL keywords get user-applied highlighting later if needed).
- A status strip below the editor shows: ✅ Pass / ❌ Blocked (`reason`), token count, scan duration.

- [ ] **Step 1: Write the failing test**

`Tests/ViewModel/SqlFileViewModelTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class SqlFileViewModelTests
{
    [Fact]
    public void SafeSql_Sets_Status_Pass()
    {
        var file = new PackageFile { Path = "migrations/001.sql", Role = "migration" };
        var vm = new SqlFileViewModel(file);
        vm.Body = "CREATE TABLE foo (id INT)";
        Assert.True(vm.Status.Ok);
        Assert.Null(vm.Status.Blocked);
    }

    [Fact]
    public void DropStatement_Sets_Status_Blocked()
    {
        var file = new PackageFile { Path = "migrations/001.sql", Role = "migration" };
        var vm = new SqlFileViewModel(file);
        vm.Body = "DROP TABLE foo";
        Assert.False(vm.Status.Ok);
        Assert.NotNull(vm.Status.Blocked);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/ViewModel/SqlFileViewModelTests.cs`
Expected: `SqlFileViewModel does not exist`.

- [ ] **Step 3: Implement VM**

`ViewModels/SqlFileViewModel.cs`:
```csharp
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;
using PackageDesigner.Sandbox;

namespace PackageDesigner.ViewModels;

public class SqlFileViewModel : INotifyPropertyChanged
{
    private readonly PackageFile _f;
    private string _body;
    public PackageFile File => _f;

    public SqlFileViewModel(PackageFile f)
    {
        _f = f;
        _body = "";
    }

    public string Body
    {
        get => _body;
        set { _body = value ?? ""; _f.Checksum = "";  // sentinel: dirty
            Status = SandboxService.Scan(_body);
            OnChanged();
        }
    }

    private SandboxResult _status = new(true, null, 0, 0);
    public SandboxResult Status { get => _status; private set { _status = value; OnChanged(); } }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/ViewModel/SqlFileViewModelTests.cs`
Expected: 2 tests pass.

- [ ] **Step 5: Build the XAML view**

`Views/SqlEditorView.xaml`:
```xml
<UserControl x:Class="PackageDesigner.Views.SqlEditorView"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:avalon="http://icsharpcode.net/sharpdevelop/avalonedit">
  <DockPanel>
    <avalon:TextEditor x:Name="Editor" FontFamily="Consolas" FontSize="13"
                       ShowLineNumbers="True" SyntaxHighlighting="TextMate"
                       Document="{Binding Document}" />
    <Border DockPanel.Dock="Bottom" Background="#222" Padding="6">
      <StackPanel Orientation="Horizontal">
        <TextBlock Foreground="White" Text="{Binding StatusMessage}"/>
      </StackPanel>
    </Border>
  </DockPanel>
</UserControl>
```

`Views/SqlEditorView.xaml.cs`:
```csharp
public partial class SqlEditorView : UserControl
{
    public SqlFileViewModel ViewModel { get; }

    public SqlEditorView(SqlFileViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
        Editor.TextChanged += (s, e) => vm.Body = Editor.Text;
        Editor.Text = "";
        // load from package raw file bytes (caller responsibility before showing)
    }
}
```

Status-message binding is computed in the VM (status string is a derived property — see below). Add a computed read-only property to `SqlFileViewModel`:

```csharp
public string StatusMessage => Status.Ok
    ? $"✅ Pass — {Status.TokenCount} tokens, {Status.ScanDurationMs}ms"
    : $"❌ Blocked: {Status.Blocked}";
```

Update the test to assert the string format matches.

- [ ] **Step 6: Re-run tests**

Run: `dotnet test Tests/ViewModel/SqlFileViewModelTests.cs`
Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add ViewModels/SqlFileViewModel.cs Views/SqlEditorView.xaml Views/SqlEditorView.xaml.cs Tests/ViewModel/SqlFileViewModelTests.cs
git commit -m "feat(wpf): SqlEditorView with sandbox status strip"
```

## Task 11: PowerShellEditorView (AvalonEdit, no sandbox)

**Files:**
- Create: `ViewModels/PowerShellFileViewModel.cs`
- Create: `Views/PowerShellEditorView.xaml` + `.cs`
- Create: `Tests/ViewModel/PowerShellFileViewModelTests.cs`

**Interfaces:**
- `PowerShellFileViewModel` wraps a `PackageFile` of `Role = "ps1"`. Property `Body` notifies. No status strip — sandbox only applies to SQL.

- [ ] **Step 1: Write the failing test**

`Tests/ViewModel/PowerShellFileViewModelTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class PowerShellFileViewModelTests
{
    [Fact]
    public void Body_Roundtrips()
    {
        var f = new PackageFile { Path = "collect.ps1", Role = "ps1" };
        var vm = new PowerShellFileViewModel(f);
        vm.Body = "Get-Process";
        Assert.Equal("Get-Process", vm.Body);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/ViewModel/PowerShellFileViewModelTests.cs`
Expected: `PowerShellFileViewModel does not exist`.

- [ ] **Step 3: Implement VM**

`ViewModels/PowerShellFileViewModel.cs`:
```csharp
using System.ComponentModel;
using System.Runtime.CompilerServices;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class PowerShellFileViewModel : INotifyPropertyChanged
{
    private readonly PackageFile _f;
    public PackageFile File => _f;

    public PowerShellFileViewModel(PackageFile f) { _f = f; }

    private string _body = "";
    public string Body
    {
        get => _body;
        set { _body = value ?? ""; OnChanged(); }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    private void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/ViewModel/PowerShellFileViewModelTests.cs`
Expected: 1 test pass.

- [ ] **Step 5: Build XAML**

`Views/PowerShellEditorView.xaml`:
```xml
<UserControl x:Class="PackageDesigner.Views.PowerShellEditorView"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:avalon="http://icsharpcode.net/sharpdevelop/avalonedit">
  <avalon:TextEditor x:Name="Editor" FontFamily="Consolas" FontSize="13"
                     ShowLineNumbers="True" SyntaxHighlighting="TextMate" />
</UserControl>
```

`Views/PowerShellEditorView.xaml.cs`:
```csharp
public partial class PowerShellEditorView : UserControl
{
    public PowerShellFileViewModel ViewModel { get; }
    public PowerShellEditorView(PowerShellFileViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
        Editor.TextChanged += (s, e) => vm.Body = Editor.Text;
    }
}
```

- [ ] **Step 6: Commit**

```bash
git add ViewModels/PowerShellFileViewModel.cs Views/PowerShellEditorView.xaml Views/PowerShellEditorView.xaml.cs Tests/ViewModel/PowerShellFileViewModelTests.cs
git commit -m "feat(wpf): PowerShellEditorView with AvalonEdit"
```

## Task 12: MigrationsListView

**Files:**
- Create: `ViewModels/MigrationsListViewModel.cs`
- Create: `Views/MigrationsListView.xaml` + `.cs`
- Create: `Tests/ViewModel/MigrationsListViewModelTests.cs`

**Interfaces:**
- `MigrationsListViewModel` exposes `ObservableCollection<SqlFileViewModel>` driven by `ManifestViewModel.Migrations`. `Add(string path)` creates a new `PackageFile`, `Remove(SqlFileViewModel)` drops it.

- [ ] **Step 1: Write the failing test**

`Tests/ViewModel/MigrationsListViewModelTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class MigrationsListViewModelTests
{
    [Fact]
    public void Add_Creates_File_In_Project()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Database = new DatabaseConfig { SchemaName = "pkg_x", Migrations = new(), MetricTable = "m", MetricSchema = new() } }
        };
        var vm = new MigrationsListViewModel(p);
        vm.Add("migrations/001.sql");
        Assert.Single(vm.Items);
        Assert.Single(p.Manifest.Database!.Migrations);
    }

    [Fact]
    public void Remove_Drops_File()
    {
        var p = new PackageProject
        {
            Manifest = new PackageManifest { Name = "x", Version = "1.0.0", Type = "gauge",
                Database = new DatabaseConfig { SchemaName = "pkg_x", Migrations = new() { "migrations/001.sql" }, MetricTable = "m", MetricSchema = new() } }
        };
        var vm = new MigrationsListViewModel(p);
        vm.Add("migrations/002.sql");
        vm.Remove(vm.Items[0]);
        Assert.Single(vm.Items);
        Assert.DoesNotContain("migrations/001.sql", p.Manifest.Database.Migrations);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/ViewModel/MigrationsListViewModelTests.cs`
Expected: `MigrationsListViewModel does not exist`.

- [ ] **Step 3: Implement**

`ViewModels/MigrationsListViewModel.cs`:
```csharp
using System.Collections.ObjectModel;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class MigrationsListViewModel
{
    private readonly PackageProject _p;
    public ObservableCollection<SqlFileViewModel> Items { get; } = new();

    public MigrationsListViewModel(PackageProject p)
    {
        _p = p;
        foreach (var path in _p.Manifest.Database?.Migrations ?? new())
            Items.Add(new SqlFileViewModel(new PackageFile { Path = path, Role = "migration" }));
    }

    public void Add(string path)
    {
        var f = new PackageFile { Path = path, Role = "migration" };
        Items.Add(new SqlFileViewModel(f));
        _p.Files.Add(f);
        _p.Manifest.Database ??= new DatabaseConfig();
        _p.Manifest.Database.Migrations.Add(path);
    }

    public void Remove(SqlFileViewModel item)
    {
        Items.Remove(item);
        _p.Files.Remove(item.File);
        _p.Manifest.Database?.Migrations.Remove(item.File.Path);
    }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/ViewModel/MigrationsListViewModelTests.cs`
Expected: 2 tests pass.

- [ ] **Step 5: Build XAML**

`Views/MigrationsListView.xaml`:
```xml
<UserControl x:Class="PackageDesigner.Views.MigrationsListView"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <DockPanel>
    <StackPanel DockPanel.Dock="Bottom" Orientation="Horizontal">
      <TextBox x:Name="PathBox" Width="240"/>
      <Button Content="+" Click="Add_Click"/>
      <Button Content="-" Click="Remove_Click"/>
    </StackPanel>
    <ListBox x:Name="List" ItemsSource="{Binding Items}"/>
  </DockPanel>
</UserControl>
```

`Views/MigrationsListView.xaml.cs`:
```csharp
public partial class MigrationsListView : UserControl
{
    public MigrationsListViewModel ViewModel { get; }
    public MigrationsListView(MigrationsListViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void Add_Click(object s, RoutedEventArgs e) { if (!string.IsNullOrWhiteSpace(PathBox.Text)) ViewModel.Add(PathBox.Text); PathBox.Text = ""; }
    private void Remove_Click(object s, RoutedEventArgs e) { if (List.SelectedItem is SqlFileViewModel sel) ViewModel.Remove(sel); }
}
```

- [ ] **Step 6: Commit**

```bash
git add ViewModels/MigrationsListViewModel.cs Views/MigrationsListView.xaml Views/MigrationsListView.xaml.cs Tests/ViewModel/
git commit -m "feat(wpf): MigrationsListView with add/remove"
```

## Task 13: PackageTabView (composite tree + TabControl)

**Files:**
- Create: `ViewModels/FileTabViewModel.cs` (abstract base)
- Create: `ViewModels/PackageTabViewModel.cs`
- Create: `Views/PackageTabView.xaml` + `.cs`

**Interfaces:**
- `FileTabViewModel`: abstract — `string Title`, `UserControl View`.
- `PackageTabViewModel`: holds `PackageProject`, `ManifestViewModel`, `MigrationsListViewModel`, plus `ObservableCollection<FileTabViewModel> OpenFiles`. Property `SelectedFile`.
- The view is a `DockPanel` with a left tree (Manifest / Migrations / collect.ps1 / Settings) and a `TabControl` on the right.

- [ ] **Step 1: Define `FileTabViewModel` base**

`ViewModels/FileTabViewModel.cs`:
```csharp
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace PackageDesigner.ViewModels;

public abstract class FileTabViewModel : INotifyPropertyChanged
{
    public abstract string Title { get; }
    public abstract object View { get; }   // UserControl

    public event PropertyChangedEventHandler? PropertyChanged;
    protected void OnChanged([CallerMemberName] string? name = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
```

- [ ] **Step 2: Implement `PackageTabViewModel`**

`ViewModels/PackageTabViewModel.cs`:
```csharp
using System.Collections.ObjectModel;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class PackageTabViewModel
{
    public PackageProject Project { get; }
    public ManifestViewModel ManifestVM { get; }
    public MigrationsListViewModel MigrationsVM { get; }
    public ObservableCollection<FileTabViewModel> OpenFiles { get; } = new();
    public FileTabViewModel? SelectedFile { get; set; }

    public PackageTabViewModel(PackageProject p)
    {
        Project = p;
        ManifestVM = new ManifestViewModel(p.Manifest);
        MigrationsVM = new MigrationsListViewModel(p);
    }

    public void OpenSql(SqlFileViewModel svm) => OpenFiles.Add(new SqlFileTab(svm));
    public void OpenPs1(PowerShellFileViewModel pvm) => OpenFiles.Add(new Ps1FileTab(pvm));
    public void OpenManifest() => OpenFiles.Add(new ManifestTab(ManifestVM));

    private class ManifestTab : FileTabViewModel
    {
        private readonly ManifestViewModel _vm;
        public ManifestTab(ManifestViewModel vm) { _vm = vm; }
        public override string Title => "manifest";
        public override object View => new Views.ManifestFormView(_vm);
    }
    private class SqlFileTab : FileTabViewModel
    {
        private readonly SqlFileViewModel _vm;
        public SqlFileTab(SqlFileViewModel vm) { _vm = vm; }
        public override string Title => _vm.File.Path;
        public override object View => new Views.SqlEditorView(_vm);
    }
    private class Ps1FileTab : FileTabViewModel
    {
        private readonly PowerShellFileViewModel _vm;
        public Ps1FileTab(PowerShellFileViewModel vm) { _vm = vm; }
        public override string Title => _vm.File.Path;
        public override object View => new Views.PowerShellEditorView(_vm);
    }
}
```

- [ ] **Step 3: Build XAML**

`Views/PackageTabView.xaml`:
```xml
<UserControl x:Class="PackageDesigner.Views.PackageTabView"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <DockPanel>
    <TreeView x:Name="Tree" Width="240" DockPanel.Dock="Left" SelectedItemChanged="Tree_SelectedItemChanged">
      <TreeViewItem Header="manifest" x:Name="ManifestNode"/>
      <TreeViewItem Header="migrations" ItemsSource="{Binding MigrationsVM.Items}" x:Name="MigrationsNode"/>
      <TreeViewItem Header="collect.ps1" x:Name="Ps1Node"/>
    </TreeView>
    <TabControl ItemsSource="{Binding OpenFiles}" SelectedItem="{Binding SelectedFile}">
      <TabControl.ItemTemplate>
        <DataTemplate>
          <TextBlock Text="{Binding Title}"/>
        </DataTemplate>
      </TabControl.ItemTemplate>
      <TabControl.ContentTemplate>
        <DataTemplate>
          <ContentControl Content="{Binding View}"/>
        </DataTemplate>
      </TabControl.ContentTemplate>
    </TabControl>
  </DockPanel>
</UserControl>
```

`Views/PackageTabView.xaml.cs`:
```csharp
public partial class PackageTabView : UserControl
{
    public PackageTabViewModel ViewModel { get; }
    public PackageTabView(PackageTabViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void Tree_SelectedItemChanged(object s, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue == ManifestNode) ViewModel.OpenManifest();
        else if (e.NewValue is SqlFileViewModel sql) ViewModel.OpenSql(sql);
        else if (e.NewValue == Ps1Node)
        {
            var ps1 = ViewModel.Project.Files.FirstOrDefault(f => f.Role == "ps1");
            if (ps1 is not null)
            {
                var vm = new PowerShellFileViewModel(ps1);
                ViewModel.OpenPs1(vm);
            }
        }
    }
}
```

- [ ] **Step 4: Compile check**

Run: `dotnet build PackageDesigner.csproj`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add ViewModels/FileTabViewModel.cs ViewModels/PackageTabViewModel.cs Views/PackageTabView.xaml Views/PackageTabView.xaml.cs
git commit -m "feat(wpf): PackageTabView composite tree + TabControl"
```

## Task 14: NewPackageDialog (with starter template chooser)

**Files:**
- Create: `ViewModels/NewPackageViewModel.cs`
- Create: `Views/NewPackageDialog.xaml` + `.cs`
- Create: `Tests/ViewModel/NewPackageViewModelTests.cs`

**Interfaces:**
- `NewPackageViewModel` exposes `Template` enum (AdMonitoringLite / AdOsBaselineLite) + `PackageName`. `Create()` returns a `PackageProject` from `StarterTemplateService.Load(Template)` with the manifest name overridden to `PackageName`.

- [ ] **Step 1: Write the failing test**

`Tests/ViewModel/NewPackageViewModelTests.cs`:
```csharp
using PackageDesigner.Models;
using PackageDesigner.ViewModels;
using Xunit;

namespace PackageDesigner.Tests.ViewModel;

public class NewPackageViewModelTests
{
    [Fact]
    public void Create_With_NonAd_Template_Overwrites_Name()
    {
        var vm = new NewPackageViewModel
        {
            Template = StarterTemplate.AdOsBaselineLite,
            PackageName = "my-custom-name"
        };
        var p = vm.Create();
        Assert.Equal("my-custom-name", p.Manifest.Name);
        Assert.Equal(AgentType.NonAd, p.Manifest.Agent.Type);
        Assert.NotNull(p.Manifest.Database);
    }

    [Fact]
    public void Create_With_Ad_Template_Has_Ad_Type()
    {
        var vm = new NewPackageViewModel
        {
            Template = StarterTemplate.AdMonitoringLite,
            PackageName = "x"
        };
        var p = vm.Create();
        Assert.Equal(AgentType.Ad, p.Manifest.Agent.Type);
    }
}
```

- [ ] **Step 2: Run, expect compile error**

Run: `dotnet test Tests/ViewModel/NewPackageViewModelTests.cs`
Expected: `NewPackageViewModel does not exist`.

- [ ] **Step 3: Implement VM**

`ViewModels/NewPackageViewModel.cs`:
```csharp
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
```

- [ ] **Step 4: Run, expect pass**

Run: `dotnet test Tests/ViewModel/NewPackageViewModelTests.cs`
Expected: 2 tests pass.

- [ ] **Step 5: Build dialog XAML**

`Views/NewPackageDialog.xaml`:
```xml
<Window x:Class="PackageDesigner.Views.NewPackageDialog"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="New Package" Width="400" Height="240" WindowStartupLocation="CenterOwner">
  <StackPanel Margin="12">
    <TextBlock Text="Template:"/>
    <ComboBox x:Name="TemplateBox" SelectedIndex="0">
      <ComboBoxItem Content="ad-monitoring-lite (AD)"/>
      <ComboBoxItem Content="ad-os-baseline-lite (Non-AD)"/>
    </ComboBox>
    <TextBlock Text="Package name:"/>
    <TextBox x:Name="NameBox"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
      <Button Content="OK" Width="80" Margin="0,0,8,0" Click="OK_Click" IsDefault="True"/>
      <Button Content="Cancel" Width="80" Click="Cancel_Click" IsCancel="True"/>
    </StackPanel>
  </StackPanel>
</Window>
```

`Views/NewPackageDialog.xaml.cs`:
```csharp
public partial class NewPackageDialog : Window
{
    public NewPackageViewModel ViewModel { get; }
    public NewPackageDialog(NewPackageViewModel vm)
    {
        ViewModel = vm;
        DataContext = vm;
        InitializeComponent();
    }
    private void OK_Click(object s, RoutedEventArgs e)
    {
        ViewModel.Template = TemplateBox.SelectedIndex == 0
            ? StarterTemplate.AdMonitoringLite
            : StarterTemplate.AdOsBaselineLite;
        ViewModel.PackageName = NameBox.Text;
        DialogResult = true;
    }
    private void Cancel_Click(object s, RoutedEventArgs e) => DialogResult = false;
}
```

- [ ] **Step 6: Commit**

```bash
git add ViewModels/NewPackageViewModel.cs Views/NewPackageDialog.xaml Views/NewPackageDialog.xaml.cs Tests/ViewModel/NewPackageViewModelTests.cs
git commit -m "feat(wpf): NewPackageDialog with starter template chooser"
```

## Task 15: MainWindow + menu + toolbar

**Files:**
- Create: `App.xaml` + `App.xaml.cs`
- Create: `ViewModels/MainWindowViewModel.cs`
- Create: `MainWindow.xaml` + `.cs`
- Create: `Views/SettingsDialog.xaml` + `.cs`

**Interfaces:**
- `MainWindowViewModel` owns a list of `PackageTabViewModel` and an `ICredentialStore` injected at startup. Menu items: File / Edit / Publish / Help.
- The window opens with a single "Welcome" panel; the user picks File → New / Open / Save / Publish.

- [ ] **Step 1: App composition root**

`App.xaml.cs`:
```csharp
public partial class App : Application
{
    public static SettingsService Settings { get; private set; } = null!;
    public static CredentialService Credentials { get; private set; } = null!;
    public static PublishService Publisher { get; private set; } = null!;
    public static AutoSaveService AutoSave { get; private set; } = null!;

    protected override void OnStartup(StartupEventArgs e)
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        Settings = new SettingsService(Path.Combine(appData, "PackageDesigner", "settings.json"));
        Credentials = new CredentialService(new MeziantouCredentialStore());
        Publisher = new PublishService(new HttpClient());
        AutoSave = new AutoSaveService();
        base.OnStartup(e);
    }
}
```

- [ ] **Step 2: `MainWindowViewModel`**

`ViewModels/MainWindowViewModel.cs`:
```csharp
using System.Collections.ObjectModel;
using PackageDesigner.Models;

namespace PackageDesigner.ViewModels;

public class MainWindowViewModel
{
    public ObservableCollection<PackageTabViewModel> OpenTabs { get; } = new();
    public PackageTabViewModel? ActiveTab { get; set; }
}
```

- [ ] **Step 3: `MainWindow.xaml`**

`MainWindow.xaml`:
```xml
<Window x:Class="PackageDesigner.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <DockPanel>
    <Menu DockPanel.Dock="Top">
      <MenuItem Header="_File">
        <MenuItem Header="_New…" Click="New_Click"/>
        <MenuItem Header="_Open…" Click="Open_Click"/>
        <MenuItem Header="_Save" Click="Save_Click"/>
        <Separator/>
        <MenuItem Header="E_xit" Click="Exit_Click"/>
      </MenuItem>
      <MenuItem Header="_Publish">
        <MenuItem Header="_Publish to Center…" Click="Publish_Click"/>
        <MenuItem Header="_Settings…" Click="Settings_Click"/>
      </MenuItem>
    </Menu>
    <StatusBar DockPanel.Dock="Bottom">
      <StatusBarItem><TextBlock x:Name="StatusText" Text="Ready"/></StatusBarItem>
    </StatusBar>
    <TabControl ItemsSource="{Binding OpenTabs}" SelectedItem="{Binding ActiveTab}">
      <TabControl.ItemTemplate>
        <DataTemplate><TextBlock Text="{Binding Project.Manifest.Name}"/></DataTemplate>
      </TabControl.ItemTemplate>
      <TabControl.ContentTemplate>
        <DataTemplate>
          <views:PackageTabView xmlns:views="clr-namespace:PackageDesigner.Views"
                                DataContext="{Binding}"/>
        </DataTemplate>
      </TabControl.ContentTemplate>
    </TabControl>
  </DockPanel>
</Window>
```

- [ ] **Step 4: `MainWindow.xaml.cs`**

`MainWindow.xaml.cs` (excerpt):
```csharp
public partial class MainWindow : Window
{
    public MainWindowViewModel VM { get; } = new();

    public MainWindow()
    {
        DataContext = VM;
        InitializeComponent();
        // Recovery scan
        var ws = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PackageDesigner", "workspace");
        var entries = RecoveryService.Scan(ws);
        if (entries.Count > 0) MessageBox.Show($"Recovery: {entries.Count} package(s) need restore.");
    }

    private void New_Click(object s, RoutedEventArgs e)
    {
        var dlg = new Views.NewPackageDialog(new NewPackageViewModel()) { Owner = this };
        if (dlg.ShowDialog() == true)
        {
            var p = dlg.ViewModel.Create();
            VM.OpenTabs.Add(new PackageTabViewModel(p));
        }
    }

    private void Open_Click(object s, RoutedEventArgs e)
    {
        var ofd = new Microsoft.Win32.OpenFileDialog { Filter = "Package project (*.pkgproj)|*.pkgproj" };
        if (ofd.ShowDialog() == true)
        {
            var p = PersistenceService.Load(ofd.FileName);
            VM.OpenTabs.Add(new PackageTabViewModel(p));
        }
    }

    private void Save_Click(object s, RoutedEventArgs e)
    {
        if (VM.ActiveTab is null) return;
        var dlg = new Microsoft.Win32.SaveFileDialog { Filter = "Package project (*.pkgproj)|*.pkgproj", FileName = VM.ActiveTab.Project.Manifest.Name + ".pkgproj" };
        if (dlg.ShowDialog() == true) PersistenceService.Save(VM.ActiveTab.Project, dlg.FileName);
    }

    private async void Publish_Click(object s, RoutedEventArgs e)
    {
        if (VM.ActiveTab is null) return;
        var url = App.Settings.CenterUrl;
        var token = App.Credentials.Get(url);
        if (string.IsNullOrEmpty(url) || string.IsNullOrEmpty(token))
        {
            MessageBox.Show("Configure center URL and token in Settings first."); return;
        }
        var r = await App.Publisher.PublishAsync(VM.ActiveTab.Project, url, token, null, CancellationToken.None);
        StatusText.Text = r.Ok ? "Published OK" : $"Failed: {r.ErrorMessage}";
    }

    private void Settings_Click(object s, RoutedEventArgs e)
    {
        var dlg = new Views.SettingsDialog { Owner = this };
        dlg.ShowDialog();
    }

    private void Exit_Click(object s, RoutedEventArgs e) => Close();
}
```

- [ ] **Step 5: `SettingsDialog` (token storage)**

`Views/SettingsDialog.xaml`:
```xml
<Window x:Class="PackageDesigner.Views.SettingsDialog"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Settings" Width="480" Height="200" WindowStartupLocation="CenterOwner">
  <StackPanel Margin="12">
    <TextBlock Text="Center URL:"/>
    <TextBox x:Name="UrlBox" Text="{Binding CenterUrl, UpdateSourceTrigger=PropertyChanged}"/>
    <TextBlock Text="API token:" Margin="0,8,0,0"/>
    <PasswordBox x:Name="TokenBox"/>
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
      <Button Content="Save" Width="80" Click="Save_Click" IsDefault="True"/>
      <Button Content="Cancel" Width="80" Margin="8,0,0,0" Click="Cancel_Click" IsCancel="True"/>
    </StackPanel>
  </StackPanel>
</Window>
```

`Views/SettingsDialog.xaml.cs`:
```csharp
public partial class SettingsDialog : Window
{
    public SettingsDialog()
    {
        DataContext = App.Settings;
        InitializeComponent();
    }
    private void Save_Click(object s, RoutedEventArgs e)
    {
        App.Settings.CenterUrl = UrlBox.Text;
        App.Settings.Save();
        if (!string.IsNullOrEmpty(TokenBox.Password))
            App.Credentials.Set(UrlBox.Text, TokenBox.Password);
        DialogResult = true;
    }
    private void Cancel_Click(object s, RoutedEventArgs e) => DialogResult = false;
}
```

- [ ] **Step 6: Build**

Run: `dotnet build PackageDesigner.csproj`
Expected: 0 errors. (One single-file `App.xaml.cs` may surface compile issues — fix before commit.)

- [ ] **Step 7: Commit**

```bash
git add App.xaml App.xaml.cs MainWindow.xaml MainWindow.xaml.cs ViewModels/MainWindowViewModel.cs Views/SettingsDialog.xaml Views/SettingsDialog.xaml.cs
git commit -m "feat(wpf): MainWindow + menu + SettingsDialog"
```

## Task 16: verify-sandbox.ps1 + manual smoke test report

**Files:**
- Create: `scripts/verify-sandbox.ps1`
- Create: `docs/smoke-2026-08-09.md` (the report)
- Modify: `docs/superpowers/plans/2026-08-09-wpf-package-designer.md` (only via commit message; no in-doc changes)

**Goal:** Make the cross-language drift check runnable as a single PowerShell 5.1-compatible script and document the manual smoke test on a Windows 11 VM.

- [ ] **Step 1: Write `scripts/verify-sandbox.ps1`**

```powershell
# verify-sandbox.ps1 — cross-language drift check
# Requires: Node.js (for ddl-sandbox.js) + .NET 8 SDK + the SandboxGoldenTests fixture.
# Usage:   pwsh ./scripts/verify-sandbox.ps1
#
# Outputs: prints OK / FAIL summary. Returns non-zero exit code on any drift.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host '== Running sandbox-cases against Node.js ==' -ForegroundColor Cyan
$nodeOut = & node scripts/run-sandbox-cases.js tests/fixtures/sandbox-cases.json
if ($LASTEXITCODE -ne 0) { Write-Host 'Node run failed'; exit 2 }

Write-Host '== Running sandbox-cases against .NET ==' -ForegroundColor Cyan
$netOut = & dotnet test --filter 'FullyQualifiedName~SandboxGoldenTests' --no-build 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host 'dotnet test failed'; exit 2 }

Write-Host '== Comparing outputs ==' -ForegroundColor Cyan
# Compare line-by-line. Fail on any divergence.
$nodeLines = $nodeOut | Where-Object { $_ -match '^\{.*\}$' }
$netLines  = $netOut  | Where-Object { $_ -match '^\{.*\}$' }
if ($nodeLines.Count -ne $netLines.Count) {
    Write-Host "Mismatch: $($nodeLines.Count) node lines vs $($netLines.Count) net lines"
    exit 3
}
$diff = Compare-Object $nodeLines $netLines
if ($diff) {
    $diff | Format-Table -AutoSize
    Write-Host 'DRIFT DETECTED' -ForegroundColor Red
    exit 4
}
Write-Host 'OK — .NET sandbox matches Node.js output for all fixtures.' -ForegroundColor Green
exit 0
```

The script is PowerShell 5.1+7 compatible: only `Where-Object`, `Compare-Object`, `Set-Location`, `Split-Path`, `Write-Host`, `Format-Table` — all BCL.

- [ ] **Step 2: Commit the script**

```bash
git add scripts/verify-sandbox.ps1
git commit -m "chore(wpf): add verify-sandbox.ps1 cross-language drift script"
```

- [ ] **Step 3: Manual smoke test**

Run on Windows 11 VM (out-of-band, document in report):

1. `dotnet publish PackageDesigner.csproj -c Release -r win-x64 --self-contained` produces `bin/Release/net8.0-windows/win-x64/publish/PackageDesigner.exe`.
2. Launch the .exe.
3. File → New → choose `ad-os-baseline-lite` template → name "smoke-test" → OK.
4. Verify the Manifest tab shows `agent.type = Non-Ad` in the dropdown.
5. Edit `migrations/001_initial.sql` to insert `DROP TABLE foo` after the CREATE → status strip shows ❌.
6. Edit `collect.ps1` with `Get-Process` → no status strip (PS1 has no sandbox).
7. File → Save → choose `<workspace>/smoke-test.pkgproj` → file persists.
8. Re-launch the .exe → no recovery dialog (no `.auto-save.log` written yet).
9. Quit while editing → relaunch → recovery dialog appears (because the auto-save log was written on the first quit).
10. Settings → set Center URL + token → Save.
11. Publish → "Published OK" or a meaningful error code/message.

Document each step + screenshot/result in `docs/smoke-2026-08-09.md` (text only — no binaries committed). 

- [ ] **Step 4: Commit the report**

```bash
git add docs/smoke-2026-08-09.md
git commit -m "docs(wpf): manual smoke test report"
```

- [ ] **Step 5: Final verification — all WPF tests pass**

Run: `dotnet test PackageDesigner.Tests.csproj`
Expected: every test passes (Sandbox + Manifest + PackageService + PersistenceService + CredentialService + SettingsService + PublishService + AutoSaveService + RecoveryService + ViewModel). Count must equal or exceed 22+ tests (Tasks 1-15 each contribute ≥1; Task 1 contributes 19).

- [ ] **Step 6: Final commit + plan-closing tag**

```bash
git log --oneline -20
git tag wpf-plan-v1
```

The whole-branch review subagent will run after this task, dispatched by the SDD controller.
