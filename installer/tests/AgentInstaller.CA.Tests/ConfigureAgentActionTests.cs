// =============================================================================
//  ConfigureAgentActionTests — Task 8
//
//  Coverage:
//    1. Validate() — happy path + invalid CenterUrl / AgentToken / AgentType.
//       Match the production exception type: ConfigureAgentAction.Validate
//       throws plain System.Exception with a descriptive message. It does
//       NOT throw InstallException (InstallException is not used in this
//       CA). ServiceAccount / SERVICECCOUNT are NOT tested: R1 explicitly
//       removed them; the data class has no such field and Validate() does
//       not check it.
//    2. WriteAppsettingsJson — the four branches of the PRESERVE_APPSETTINGS
//       short-circuit combined with the on-disk presence of appsettings.json.
//    3. ParseCustomActionData — keys actually emitted by CustomActions.wxs
//       (INSTALLDIR / CENTERURL / AGENTTOKEN / AGENTTYPE / PRESERVE_APPSETTINGS).
//       No SERVICECCOUNT key — R1.
//
//  All file I/O is gated to Path.GetTempPath() + Guid so we never touch the
//  project tree or any real install directory. Cleanup happens in finally.
// =============================================================================

using System;
using System.IO;
using ADDashboard.AgentInstaller.CA;
using Xunit;

namespace ADDashboard.AgentInstaller.CA.Tests
{
    public class ConfigureAgentActionTests
    {
        // ---------------------------------------------------------------------
        //  Helpers
        // ---------------------------------------------------------------------

        private static ConfigureAgentData MakeValidData()
        {
            // Use a fresh Guid dir per call so parallel test runs don't collide.
            // Path.GetTempPath() always exists on Windows; we don't create it
            // ourselves — the CA-under-test or the test body does that.
            return new ConfigureAgentData
            {
                InstallDir = Path.Combine(
                    Path.GetTempPath(),
                    "agent-ca-test-" + Guid.NewGuid().ToString("N")),
                CenterUrl = "http://test-center:8081",
                AgentToken = "test-token-1234567890abcdef", // 32 chars > 16 min
                AgentType = "ad",
                PreserveAppsettings = false
            };
        }

        /// <summary>
        /// Recursively delete the per-test temp directory. Best-effort: if a
        /// file is locked by another process we swallow and move on. The
        /// directories are temp-scoped so leakage is harmless.
        /// </summary>
        private static void TryDelete(string dir)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); }
            catch { /* best effort */ }
        }

        // ---------------------------------------------------------------------
        //  Validate()
        // ---------------------------------------------------------------------

        [Fact]
        public void Validate_ValidData_DoesNotThrow()
        {
            // Sanity: a fully-populated ConfigureAgentData must round-trip
            // through Validate() without throwing.
            ConfigureAgentAction.Validate(MakeValidData());
        }

        [Theory]
        [InlineData("")]
        [InlineData("not-a-url")]
        [InlineData("ftp://center")]            // wrong scheme (ftp not http/https)
        [InlineData("javascript:alert(1)")]     // wrong scheme
        public void Validate_InvalidCenterUrl_Throws(string url)
        {
            var d = MakeValidData();
            d.CenterUrl = url;

            // Production throws System.Exception (NOT InstallException — see
            // CA/ConfigureAgentAction.cs:Validate). We assert on Exception
            // and verify the message mentions CENTERURL for diagnostic value.
            var ex = Assert.Throws<Exception>(() => ConfigureAgentAction.Validate(d));
            Assert.Contains("CENTERURL", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Theory]
        [InlineData("")]
        [InlineData("short")]                   // 5 chars < 16 min
        [InlineData("123456789012345")]         // exactly 15 chars — under minimum
        public void Validate_TooShortAgentToken_Throws(string token)
        {
            var d = MakeValidData();
            d.AgentToken = token;

            var ex = Assert.Throws<Exception>(() => ConfigureAgentAction.Validate(d));
            Assert.Contains("AGENTTOKEN", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        [Theory]
        [InlineData("foo")]                     // unknown type
        [InlineData("AD")]                      // case-sensitive: must be lowercase
        [InlineData("Non-Ad")]
        [InlineData("")]
        [InlineData("ad ")]                     // trailing whitespace
        public void Validate_InvalidAgentType_Throws(string type)
        {
            var d = MakeValidData();
            d.AgentType = type;

            var ex = Assert.Throws<Exception>(() => ConfigureAgentAction.Validate(d));
            Assert.Contains("AGENTTYPE", ex.Message, StringComparison.OrdinalIgnoreCase);
        }

        // ---------------------------------------------------------------------
        //  WriteAppsettingsJson — four PRESERVE / file-exists branches
        // ---------------------------------------------------------------------

        [Fact]
        public void WriteAppsettingsJson_PreserveFalse_NoExistingFile_WritesNew()
        {
            // Default path: PRESERVE=0, no pre-existing file → write a fresh
            // appsettings.json. Verifies key contents end-to-end (escape,
            // nested paths, hostname insertion).
            var d = MakeValidData();
            d.PreserveAppsettings = false;
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);

                var path = Path.Combine(d.InstallDir, "appsettings.json");
                Assert.True(File.Exists(path));

                var text = File.ReadAllText(path);
                Assert.Contains("\"centerUrl\":", text);
                Assert.Contains("\"agentToken\":", text);
                Assert.Contains("\"agentToken\": \"" + d.AgentToken + "\"", text);
                Assert.Contains("\"agentType\": \"ad\"", text);
                Assert.Contains("\"pollingIntervalMinutes\": 15", text);
                Assert.Contains("\"heartbeatIntervalSeconds\": 5", text);
                Assert.Contains("\"discoveryIntervalHours\": 4", text);
                Assert.Contains("collect-replication.ps1", text);
                Assert.Contains("collect-discovery.ps1", text);
                // agentId is the local machine name — not asserting a specific
                // value (host-dependent), only that the key is present.
                Assert.Contains("\"agentId\":", text);
            }
            finally { TryDelete(d.InstallDir); }
        }

        [Fact]
        public void WriteAppsettingsJson_PreserveFalse_ExistingFile_Overwrites()
        {
            // PRESERVE=0 + file present → overwrite (same as fresh install
            // over a pre-existing config). This is the reinstall/major-upgrade
            // behavior when the operator does not opt into preservation.
            var d = MakeValidData();
            d.PreserveAppsettings = false;
            Directory.CreateDirectory(d.InstallDir);
            var path = Path.Combine(d.InstallDir, "appsettings.json");
            File.WriteAllText(path, "{\"existing\":\"sentinel-must-be-overwritten\"}");
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                var text = File.ReadAllText(path);
                Assert.DoesNotContain("sentinel-must-be-overwritten", text);
                Assert.Contains("\"centerUrl\":", text);
                Assert.Contains(d.AgentToken, text);
            }
            finally { TryDelete(d.InstallDir); }
        }

        [Fact]
        public void WriteAppsettingsJson_PreserveTrue_NoExistingFile_WritesNew()
        {
            // PRESERVE=1 + file missing → write anyway (nothing to preserve).
            // This covers a first install where the operator pre-set
            // PRESERVE_APPSETTINGS=1 defensively.
            var d = MakeValidData();
            d.PreserveAppsettings = true;
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                var path = Path.Combine(d.InstallDir, "appsettings.json");
                Assert.True(File.Exists(path));
                var text = File.ReadAllText(path);
                Assert.Contains(d.CenterUrl, text);
            }
            finally { TryDelete(d.InstallDir); }
        }

        [Fact]
        public void WriteAppsettingsJson_PreserveTrue_ExistingFile_Untouched()
        {
            // PRESERVE=1 + file present → leave the existing file alone.
            // Sentinel value must survive byte-for-byte.
            var d = MakeValidData();
            d.PreserveAppsettings = true;
            Directory.CreateDirectory(d.InstallDir);
            var path = Path.Combine(d.InstallDir, "appsettings.json");
            var sentinel = "{\"centerUrl\":\"http://previous-center:1234\",\"agentToken\":\"previous-token-keep-me\"}";
            File.WriteAllText(path, sentinel);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                Assert.Equal(sentinel, File.ReadAllText(path));
            }
            finally { TryDelete(d.InstallDir); }
        }

        [Fact]
        public void WriteAppsettingsJson_NonAdAgentType_WritesNonAdConfig()
        {
            // agentType must propagate to the JSON. non-ad gets a different
            // NSSM display name + description in production; the appsettings
            // file carries the same enum value.
            var d = MakeValidData();
            d.AgentType = "non-ad";
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                var text = File.ReadAllText(Path.Combine(d.InstallDir, "appsettings.json"));
                Assert.Contains("\"agentType\": \"non-ad\"", text);
            }
            finally { TryDelete(d.InstallDir); }
        }

        [Fact]
        public void WriteAppsettingsJson_CenterUrlWithQuotesAndBackslashes_EscapedCorrectly()
        {
            // EscapeJson() must double backslashes and escape quotes. If a
            // user passes a CENTERURL with a quote in it (legal as far as the
            // URI parser is concerned — http://x/"oops"), we must not break
            // the JSON.
            var d = MakeValidData();
            d.CenterUrl = "http://test-center:8081/path?q=\"x\"\\y";
            Directory.CreateDirectory(d.InstallDir);
            try
            {
                ConfigureAgentAction.WriteAppsettingsJson(d);
                var text = File.ReadAllText(Path.Combine(d.InstallDir, "appsettings.json"));
                Assert.Contains("\\\"x\\\"", text);   // inner quotes are \"
                Assert.Contains("\\\\y", text);       // inner backslash is \\
            }
            finally { TryDelete(d.InstallDir); }
        }

        // ---------------------------------------------------------------------
        //  ParseCustomActionData
        //
        //  Note on construction: WixToolset.Dtf.WindowsInstaller.CustomActionData
        //  has TWO constructors — parameterless (which yields a real
        //  IDictionary<string,string> that you populate via .Add) and
        //  string-ctor (which is meant to parse "key=value\n" payloads but
        //  has a bug where subsequent indexer calls return the wrong slice).
        //  In a real MSI install, Session.CustomActionData returns a properly
        //  populated instance backed by a real dictionary, so the production
        //  ParseCustomActionData works correctly. We replicate that here by
        //  using the parameterless ctor + .Add() instead of the buggy string
        //  ctor. This matches the production data shape without depending on
        //  the buggy parser path.
        // ---------------------------------------------------------------------

        private static WixToolset.Dtf.WindowsInstaller.CustomActionData MakeCad(
            string installDir = "C:\\addashboard\\Agent",
            string centerUrl = "http://c:8081",
            string agentToken = "test-token-1234567890abcdef",
            string agentType = "ad",
            string preserveAppsettings = "1")
        {
            var cad = new WixToolset.Dtf.WindowsInstaller.CustomActionData();
            if (installDir != null) cad.Add("INSTALLDIR", installDir);
            if (centerUrl != null) cad.Add("CENTERURL", centerUrl);
            if (agentToken != null) cad.Add("AGENTTOKEN", agentToken);
            if (agentType != null) cad.Add("AGENTTYPE", agentType);
            if (preserveAppsettings != null) cad.Add("PRESERVE_APPSETTINGS", preserveAppsettings);
            return cad;
        }

        [Fact]
        public void ParseCustomActionData_AllKeys_PopulatesFields()
        {
            var cad = MakeCad();
            var d = ConfigureAgentAction.ParseCustomActionData(cad);

            Assert.Equal("C:\\addashboard\\Agent", d.InstallDir);
            Assert.Equal("http://c:8081", d.CenterUrl);
            Assert.Equal("test-token-1234567890abcdef", d.AgentToken);
            Assert.Equal("ad", d.AgentType);
            Assert.True(d.PreserveAppsettings);
            // Confirm R1: no ServiceAccount field ever appeared. Compile-time
            // guarantee — accessing d.ServiceAccount would not compile.
        }

        [Fact]
        public void ParseCustomActionData_PreserveVariantsAccepted()
        {
            // Both "1" and "true" (case-insensitive) are accepted by the
            // production parser. Anything else → false.
            Assert.True(ParseWithPreserve("1").PreserveAppsettings);
            Assert.True(ParseWithPreserve("true").PreserveAppsettings);
            Assert.True(ParseWithPreserve("TRUE").PreserveAppsettings);
            Assert.True(ParseWithPreserve("True").PreserveAppsettings);
            Assert.False(ParseWithPreserve("0").PreserveAppsettings);
            Assert.False(ParseWithPreserve("yes").PreserveAppsettings);
            Assert.False(ParseWithPreserve("").PreserveAppsettings);

            static ConfigureAgentData ParseWithPreserve(string v)
            {
                var cad = new WixToolset.Dtf.WindowsInstaller.CustomActionData();
                cad.Add("CENTERURL", "http://c:8081");
                cad.Add("AGENTTOKEN", "test-token-1234567890abcdef");
                cad.Add("AGENTTYPE", "ad");
                cad.Add("PRESERVE_APPSETTINGS", v);
                return ConfigureAgentAction.ParseCustomActionData(cad);
            }
        }

        [Fact]
        public void ParseCustomActionData_Null_ReturnsDefaults()
        {
            // Production guards `if (cad == null) return data;` — every field
            // stays at its C# default. Confirm no NRE.
            var d = ConfigureAgentAction.ParseCustomActionData(null);
            Assert.Null(d.InstallDir);
            Assert.Null(d.CenterUrl);
            Assert.Null(d.AgentToken);
            Assert.Null(d.AgentType);
            Assert.False(d.PreserveAppsettings);
        }

        [Fact]
        public void ParseCustomActionData_EmptyDictionary_ReturnsDefaults()
        {
            // A non-null but empty CustomActionData must round-trip safely —
            // every field defaults to null / false.
            var cad = new WixToolset.Dtf.WindowsInstaller.CustomActionData();
            var d = ConfigureAgentAction.ParseCustomActionData(cad);
            Assert.Null(d.CenterUrl);
            Assert.False(d.PreserveAppsettings);
            Assert.Null(d.AgentType);
        }

        [Fact]
        public void ParseCustomActionData_PartialKeys_OnlyPopulatesPresent()
        {
            // Only CENTERURL is present — production should populate just
            // CenterUrl and leave the rest at defaults. This protects against
            // regressions where missing keys are silently overwritten with
            // empty strings.
            var cad = new WixToolset.Dtf.WindowsInstaller.CustomActionData();
            cad.Add("CENTERURL", "http://only:1234");
            var d = ConfigureAgentAction.ParseCustomActionData(cad);

            Assert.Equal("http://only:1234", d.CenterUrl);
            Assert.Null(d.InstallDir);
            Assert.Null(d.AgentToken);
            Assert.Null(d.AgentType);
            Assert.False(d.PreserveAppsettings);
        }

        // ---------------------------------------------------------------------
        //  DeriveLogDir — LogDir follows InstallDir
        //
        //  Production rule (per 2026-08-16 design): LogDir is derived from
        //  InstallDir at install time, not stored as a hardcoded field. The
        //  derived value is `<InstallDir>\..\Logs` resolved to an absolute path
        //  via Path.GetFullPath. When InstallDir = C:\addashboard\Agent (the
        //  un-overridden default), LogDir = C:\addashboard\Logs (byte-identical
        //  to the v1.0.0 hardcoded value). When InstallDir = D:\Dashboard\Agent,
        //  LogDir = D:\Dashboard\Logs.
        // ---------------------------------------------------------------------

        [Theory]
        [InlineData(@"C:\addashboard\Agent", @"C:\addashboard\Logs")]
        [InlineData(@"D:\Dashboard\Agent", @"D:\Dashboard\Logs")]
        [InlineData(@"C:\Program Files\ADDashboard\Agent", @"C:\Program Files\ADDashboard\Logs")]
        [InlineData(@"C:\Agent", @"C:\Logs")]
        public void DeriveLogDir_FollowsInstallDir(string installDir, string expected)
        {
            Assert.Equal(expected, ConfigureAgentAction.DeriveLogDir(installDir));
        }

        [Fact]
        public void DeriveLogDir_NormalisesRelativeSegment()
        {
            // Path.GetFullPath must collapse the ".." segment. Equivalent
            // inputs (trailing slash, no slash, redundant dots) all resolve
            // to the same absolute path.
            Assert.Equal(
                ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent"),
                ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent\"));
            Assert.Equal(
                ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent"),
                ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent\.\"));
        }
    }
}