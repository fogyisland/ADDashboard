using System;
using System.IO;
using System.Text;
using WixToolset.Dtf.WindowsInstaller;

// ============================================================================
//  Task 7 — appsettings.json ownership and upgrade preservation contract.
//
//  appsettings.json is GENERATED at install time by WriteAppsettingsJson
//  below. It is NOT staged from the MSI File table (see Files.wxs header for
//  why adding it as a <File> would conflict with Agent.AppsettingsTemplate's
//  same-source staging). The agent process reads the CA-written file at
//  startup; if the file is missing, the agent logs and exits.
//
//  REINSTALL / MAJOR UPGRADE PRESERVATION:
//
//  WriteAppsettingsJson short-circuits when:
//    - data.PreserveAppsettings is true (PRESERVE_APPSETTINGS=1 on the
//      msiexec command line, expanded into the deferred CA's
//      CustomActionData via CustomActions.wxs ScheduleConfigureAgent), AND
//    - appsettings.json already exists on disk.
//
//  Default PRESERVE_APPSETTINGS=0 means a reinstall or major upgrade
//  rewrites appsettings.json with the new CENTERURL / AGENTTOKEN from the
//  install command line — same as a fresh install. To preserve the file
//  across a reinstall or upgrade, pass PRESERVE_APPSETTINGS=1.
//
//  UNINSTALL BEHAVIOR (R2, kept):
//
//  The ConfigureAgent CA only runs under NOT Installed OR REINSTALL — it
//  does NOT fire on uninstall. RemoveAgentService (see RollbackAgentAction.cs)
//  only runs `nssm remove ADReplicationAgent confirm`; it does not touch
//  appsettings.json. appsettings.json therefore persists on disk after
//  uninstall unless the user manually clears C:\addashboard\Agent. R2
//  accepts this; reintroducing an appsettings.json as a File table entry
//  would change the uninstall semantics (RemoveFiles would delete it)
//  and must come with a deliberate R2 override.
// ============================================================================

namespace ADDashboard.AgentInstaller.CA
{
    public class ConfigureAgentData
    {
        public string InstallDir;
        public string CenterUrl;
        public string AgentToken;
        public string AgentType;
        public bool PreserveAppsettings;
        public string LogDir = @"C:\addashboard\Logs";
    }

    public static class ConfigureAgentAction
    {
        [CustomAction]
        public static ActionResult ConfigureAgent(Session session)
        {
            try
            {
                // WiX 5 DTF: CustomActionData is a typed dictionary. Its ToString()
                // serializes to the same `key=value\n` form the immediate CA produces.
                var data = ParseCustomActionData(session.CustomActionData);
                Validate(data);

                WriteAppsettingsJson(data);

                RegisterNssmService(data);
                SetNssmParameters(data);
                SetServiceRecovery(data);
                StartServiceBestEffort(data);

                return ActionResult.Success;
            }
            catch (Exception ex)
            {
                session.Log("ConfigureAgent failed: {0}\n{1}", ex.Message, ex.StackTrace);
                return ActionResult.Failure;
            }
        }

        internal static ConfigureAgentData ParseCustomActionData(CustomActionData cad)
        {
            var data = new ConfigureAgentData();
            if (cad == null) return data;

            if (cad.ContainsKey("INSTALLDIR"))    data.InstallDir    = cad["INSTALLDIR"];
            if (cad.ContainsKey("CENTERURL"))      data.CenterUrl     = cad["CENTERURL"];
            if (cad.ContainsKey("AGENTTOKEN"))     data.AgentToken    = cad["AGENTTOKEN"];
            if (cad.ContainsKey("AGENTTYPE"))      data.AgentType     = cad["AGENTTYPE"];
            if (cad.ContainsKey("PRESERVE_APPSETTINGS"))
            {
                var v = cad["PRESERVE_APPSETTINGS"];
                data.PreserveAppsettings = (v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase));
            }
            return data;
        }

        internal static void Validate(ConfigureAgentData data)
        {
            if (string.IsNullOrWhiteSpace(data.CenterUrl) ||
                !Uri.TryCreate(data.CenterUrl, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new Exception($"CENTERURL property missing or invalid: '{data.CenterUrl}' (must be absolute http/https URI)");

            if (string.IsNullOrWhiteSpace(data.AgentToken) || data.AgentToken.Length < 16)
                throw new Exception($"AGENTTOKEN property missing or too short ({data.AgentToken?.Length ?? 0} chars; minimum 16)");

            if (data.AgentType != "ad" && data.AgentType != "non-ad")
                throw new Exception($"AGENTTYPE must be 'ad' or 'non-ad' (got '{data.AgentType}')");
        }

        internal static void WriteAppsettingsJson(ConfigureAgentData data)
        {
            var path = Path.Combine(data.InstallDir, "appsettings.json");
            var hostname = Environment.MachineName;

            if (data.PreserveAppsettings && File.Exists(path))
                return;

            var sb = new StringBuilder();
            sb.AppendLine("{");
            sb.AppendLine($"  \"centerUrl\": \"{EscapeJson(data.CenterUrl)}\",");
            sb.AppendLine($"  \"agentId\": \"{EscapeJson(hostname)}\",");
            sb.AppendLine($"  \"agentToken\": \"{EscapeJson(data.AgentToken)}\",");
            sb.AppendLine("  \"logLevel\": \"info\",");
            sb.AppendLine("  \"pollingIntervalMinutes\": 15,");
            sb.AppendLine("  \"heartbeatIntervalSeconds\": 5,");
            sb.AppendLine("  \"discoveryIntervalHours\": 4,");
            sb.AppendLine($"  \"queueDbPath\": \"{EscapeJson(Path.Combine(data.InstallDir, "queue.db"))}\",");
            sb.AppendLine($"  \"psScriptPath\": \"{EscapeJson(Path.Combine(data.InstallDir, "scripts", "collect-replication.ps1"))}\",");
            sb.AppendLine($"  \"psDiscoveryScriptPath\": \"{EscapeJson(Path.Combine(data.InstallDir, "scripts", "collect-discovery.ps1"))}\",");
            sb.AppendLine("  \"healthCheckIntervalMs\": 600000,");
            sb.AppendLine($"  \"agentType\": \"{EscapeJson(data.AgentType)}\"");
            sb.AppendLine("}");

            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        internal static void RegisterNssmService(ConfigureAgentData data)
        {
            var nssm = Path.Combine(data.InstallDir, "nssm", "nssm.exe");
            if (!File.Exists(nssm))
                throw new Exception($"nssm.exe not found at {nssm}");

            var node = Path.Combine(data.InstallDir, "node", "node.exe");
            if (!File.Exists(node))
                throw new Exception($"node.exe not found at {node}");

            // nssm install is idempotent: if service exists, it returns non-zero.
            // We check first to avoid spurious failure on reinstall.
            var svcExists = RunProcessCapture("sc.exe", "query ADReplicationAgent");
            if (svcExists.IndexOf("does not exist", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                var rc = RunProcess(nssm, $"install ADReplicationAgent \"{node}\" agent.js");
                if (rc != 0)
                    throw new Exception($"nssm install failed with exit {rc}");
            }
        }

        internal static void SetNssmParameters(ConfigureAgentData data)
        {
            var nssm = Path.Combine(data.InstallDir, "nssm", "nssm.exe");
            var hostname = Environment.MachineName;
            var displayName = data.AgentType == "non-ad"
                ? "AD Dashboard Agent (Member)"
                : $"AD Replication Agent (on {hostname})";
            var description = data.AgentType == "non-ad"
                ? "AD Dashboard member-server monitor (self-register + heartbeat + package fetch)"
                : "AD Replication collection agent";

            RunNssmSet(nssm, "AppDirectory",         data.InstallDir);
            RunNssmSet(nssm, "AppParameters",        "agent.js");
            RunNssmSet(nssm, "DisplayName",          displayName);
            RunNssmSet(nssm, "Description",          description);
            RunNssmSet(nssm, "Start",                "SERVICE_AUTO_START");
            RunNssmSet(nssm, "DependOnService",      "DNS Client,Netlogon");
            RunNssmSet(nssm, "AppStdout",            Path.Combine(data.LogDir, "ADReplicationAgent-stdout.log"));
            RunNssmSet(nssm, "AppStderr",            Path.Combine(data.LogDir, "ADReplicationAgent-stderr.log"));
            RunNssmSet(nssm, "AppRotateFiles",       "1");
            RunNssmSet(nssm, "AppRotateOnline",      "1");
            RunNssmSet(nssm, "AppRotateBytes",       "10485760");
            RunNssmSet(nssm, "AppEnvironmentExtra",  "NODE_ENV=production");
            // LocalSystem default — no ObjectName set, matches install-agent.ps1.
        }

        internal static void SetServiceRecovery(ConfigureAgentData data)
        {
            var nssm = Path.Combine(data.InstallDir, "nssm", "nssm.exe");

            // NSSM-level: restart cleanly on process.exit(0). Matches Service.psm1:41-44.
            // AppExit requires the sub-parameter form `<exit_code|Default> <action>` — NSSM
            // 2.24 rejects the bare `AppExit Restart` form with "requires a subparameter!".
            RunNssmSetMulti(nssm, "AppExit", "Default", "Restart");
            RunNssmSetMulti(nssm, "AppRestartDelay", "2000");

            // Windows-level: restart on crash (OOM, segfault, kill -9). Matches Service.psm1:46.
            var scArgs = "failure ADReplicationAgent reset= 60 actions= restart/5000/restart/10000/restart/30000";
            var rc = RunProcess("sc.exe", scArgs);
            if (rc != 0)
                throw new Exception($"sc.exe failure setup failed with exit {rc}");
        }

        internal static void StartServiceBestEffort(ConfigureAgentData data)
        {
            var rc = RunProcess("sc.exe", "start ADReplicationAgent");
            if (rc != 0)
            {
                // Not fatal — network may be unreachable, center may not yet accept this agent.
                // The center marks an agent as stale if no heartbeat within stale_seconds.
                System.Diagnostics.Debug.WriteLine($"sc.exe start returned {rc}; service may not be reachable to center yet");
            }
        }

        internal static int RunProcess(string exe, string args)
        {
            using (var p = new System.Diagnostics.Process())
            {
                p.StartInfo.FileName = exe;
                p.StartInfo.Arguments = args;
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.CreateNoWindow = true;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.RedirectStandardError = true;
                p.Start();
                // I-3: bounded wait to avoid hanging the deferred CA forever.
                // On timeout, kill the child and throw — MSI will roll back.
                if (!p.WaitForExit(ProcessTimeoutMs))
                {
                    try { p.Kill(); } catch { /* already exited */ }
                    throw new Exception($"Process '{exe} {args}' did not exit within {ProcessTimeoutMs} ms; killed.");
                }
                return p.ExitCode;
            }
        }

        internal static string RunProcessCapture(string exe, string args)
        {
            using (var p = new System.Diagnostics.Process())
            {
                p.StartInfo.FileName = exe;
                p.StartInfo.Arguments = args;
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.CreateNoWindow = true;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.RedirectStandardError = true;
                // I-A: use async output capture so the read does not block on a
                // child holding stdout open past ProcessTimeoutMs. A blocking
                // ReadToEnd() before WaitForExit() would let a misbehaving child
                // (e.g. sc.exe query against a slow RPC endpoint) hang forever,
                // freezing the deferred CA. Drain stdout into a StringBuilder via
                // OutputDataReceived; if we hit the deadline, kill the child and
                // complete the buffer with whatever was captured so far.
                var output = new StringBuilder();
                p.OutputDataReceived += (_, e) => { if (e.Data != null) output.AppendLine(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                if (!p.WaitForExit(ProcessTimeoutMs))
                {
                    try { p.Kill(); } catch { /* already exited */ }
                    // Wait briefly/boundedly for the OS to reap the killed process
                    // and for the async output pump to drain. Net472-compatible;
                    // no async/await here on purpose.
                    try { p.WaitForExit(5 * 1000); } catch { /* swallow */ }
                    throw new Exception($"Process '{exe} {args}' did not exit within {ProcessTimeoutMs} ms; killed. Captured so far: {output}");
                }
                // Ensure all async output events are flushed before reading.
                p.WaitForExit();
                return output.ToString();
            }
        }

        // I-3: hard cap on how long any single child-process invocation may run.
        // MSI deferred CAs run synchronously inside the install transaction; an
        // unbounded WaitForExit() turns a misbehaving child into a stuck install.
        private const int ProcessTimeoutMs = 30 * 1000;

        internal static void RunNssmSet(string nssm, string key, string value)
        {
            var rc = RunProcess(nssm, $"set ADReplicationAgent {key} \"{value}\"");
            if (rc != 0)
                throw new Exception($"nssm set {key} failed with exit {rc}");
        }

        // For NSSM parameters that take multiple positional sub-args (e.g. AppExit
        // Default Restart). Sub-args are NOT quoted — NSSM 2.24 rejects the quoted
        // form with "requires a subparameter!".
        internal static void RunNssmSetMulti(string nssm, string key, params string[] subArgs)
        {
            var quoted = new System.Collections.Generic.List<string> { "set", "ADReplicationAgent", key };
            foreach (var a in subArgs) quoted.Add(a);  // unquoted on purpose
            var argline = string.Join(" ", quoted);
            var rc = RunProcess(nssm, argline);
            if (rc != 0) throw new Exception($"nssm {argline} failed with exit {rc}");
        }

        internal static string EscapeJson(string s)
        {
            return s == null ? "" : s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
