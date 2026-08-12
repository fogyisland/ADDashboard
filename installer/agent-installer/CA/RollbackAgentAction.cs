using System;
using System.IO;
using System.Text;
using WixToolset.Dtf.WindowsInstaller;

namespace ADDashboard.AgentInstaller.CA
{
    /// <summary>
    /// Custom-action entry points for service teardown. Two MSI actions reach
    /// the shared implementation, both via [CustomAction] in the same DLL:
    ///
    ///  - <c>RollbackAgent</c> (Type=3393 in-script rollback DLL)
    ///    Scheduled BEFORE ConfigureAgent with the install/reinstall condition.
    ///    If a later deferred CA in the install chain throws, MSI rolls back;
    ///    this companion then un-registers the half-registered NSSM service so
    ///    the next install does not collide.
    ///
    ///  - <c>RemoveAgentService</c> (in-script deferred DLL,
    ///    Impersonate=no, runs in SYSTEM context — emitted as Type=3137
    ///    by WiX 5 for `Execute="deferred" Impersonate="no"`)
    ///    Scheduled AFTER StopServices and BEFORE RemoveFiles on uninstall.
    ///    The MSI's built-in StopServices already issued sc stop; this CA then
    ///    issues `nssm remove ADReplicationAgent confirm` while nssm.exe is
    ///    still present in INSTALLDIR. RemoveFiles then runs and deletes the
    ///    on-disk tree.
    ///
    /// Both are idempotent + non-fatal: missing INSTALLDIR, missing nssm.exe,
    /// nonzero nssm exit, or any other exception logs and returns Success.
    /// A failed rollback must never re-fail the install (MSI would otherwise
    /// leave the system in a broken state). A failed uninstall teardown
    /// likewise cannot roll back the uninstall — it logs the warning and
    /// lets the file deletion continue.
    ///
    /// R1: LocalSystem default. Do not introduce SERVICECCOUNT/ServiceAccount.
    /// R2: current branch accepts uninstall deleting config. No
    /// NeverOverwrite / appsettings preservation logic in this task
    /// (Task 7 owns preservation).
    /// </summary>
    public static class RollbackAgentAction
    {
        // Existing entry-point for the install-time rollback companion.
        // Data flow: <CustomAction Type=51 Property="RollbackAgent"
        //                            Value="INSTALLDIR=[INSTALLDIR]" />
        // scheduled immediately before ConfigureAgent (see CustomActions.wxs).
        [CustomAction]
        public static ActionResult RollbackAgent(Session session)
        {
            return RunServiceRemove(session, "RollbackAgent");
        }

        // Deferred CA for the normal uninstall flow. Data flow: a separate
        // <CustomAction Type=51 Property="RemoveAgentService"
        //                              Value="INSTALLDIR=[INSTALLDIR]" />
        // scheduled immediately before the deferred remove itself.
        [CustomAction]
        public static ActionResult RemoveAgentService(Session session)
        {
            return RunServiceRemove(session, "RemoveAgentService");
        }

        // Shared body. Identical semantics for both entry points — only the
        // CustomActionData key naming/contents differ at the call site, but
        // both schedulers emit the same INSTALLDIR-only payload so we parse
        // identically.
        internal static ActionResult RunServiceRemove(Session session, string entryName)
        {
            try
            {
                var installDir = ParseInstallDir(session.CustomActionData);
                if (string.IsNullOrEmpty(installDir))
                {
                    session.Log("{0}: INSTALLDIR missing or empty — skipping service removal.", entryName);
                    return ActionResult.Success;
                }

                var nssm = Path.Combine(installDir, "nssm", "nssm.exe");
                if (!File.Exists(nssm))
                {
                    session.Log("{0}: nssm.exe not found at {1} — service may already be cleaned up; skipping.", entryName, nssm);
                    return ActionResult.Success;
                }

                // nssm remove returns non-zero if the service does not exist,
                // so a successful remove on a previous-run cleanup looks
                // identical to "nothing to do". Run, log, ignore the exit code.
                var rc = RunNssmRemove(nssm, session, entryName);
                session.Log("{0}: nssm remove returned exit code {1} (treated as success).", entryName, rc);
                return ActionResult.Success;
            }
            catch (Exception ex)
            {
                // Per design: rollback / uninstall cleanup must never fail the
                // install transaction or block the uninstall. Log + Success.
                session.Log("{0}: non-fatal error: {1}\n{2}", entryName, ex.Message, ex.StackTrace);
                return ActionResult.Success;
            }
        }

        internal static string ParseInstallDir(CustomActionData cad)
        {
            if (cad == null) return null;
            if (!cad.ContainsKey("INSTALLDIR")) return null;
            return cad["INSTALLDIR"];
        }

        // Bounded nssm remove. Mirrors ConfigureAgentAction.RunProcess, but
        // cannot be reused directly because that one throws on timeout — this
        // path must swallow all failures and return the exit code (or -1 on
        // timeout) to the caller. We also expose stderr in the log because
        // nssm errors are diagnostic only.
        internal static int RunNssmRemove(string nssm, Session session, string entryName)
        {
            using (var p = new System.Diagnostics.Process())
            {
                p.StartInfo.FileName = nssm;
                p.StartInfo.Arguments = "remove ADReplicationAgent confirm";
                p.StartInfo.UseShellExecute = false;
                p.StartInfo.CreateNoWindow = true;
                p.StartInfo.RedirectStandardOutput = true;
                p.StartInfo.RedirectStandardError = true;

                var stdout = new StringBuilder();
                var stderr = new StringBuilder();
                p.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
                p.ErrorDataReceived  += (_, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                if (!p.WaitForExit(ProcessTimeoutMs))
                {
                    try { p.Kill(); } catch { /* already exited */ }
                    // Bounded reaping wait. Same net472-compatible pattern as
                    // ConfigureAgentAction.RunProcessCapture — no async/await.
                    try { p.WaitForExit(5 * 1000); } catch { /* swallow */ }
                    session.Log("{0}: nssm remove did not exit within {1} ms; killed. stdout={2} stderr={3}",
                        entryName, ProcessTimeoutMs, stdout, stderr);
                    return -1;
                }

                // Flush remaining async events before returning.
                try { p.WaitForExit(); } catch { /* already exited */ }

                if (stdout.Length > 0) session.Log("{0}: nssm remove stdout: {1}", entryName, stdout);
                if (stderr.Length > 0) session.Log("{0}: nssm remove stderr: {1}", entryName, stderr);
                return p.ExitCode;
            }
        }

        // Match ConfigureAgentAction's 30s budget. Why: a hung nssm.exe must
        // not block the deferred CA indefinitely (a single deferred CA hang
        // wedges the entire MSI transaction).
        private const int ProcessTimeoutMs = 30 * 1000;
    }
}
