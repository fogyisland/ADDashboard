using WixToolset.Dtf.WindowsInstaller;

namespace ADDashboard.AgentInstaller.CA
{
    public static class RollbackAgentAction
    {
        [CustomAction]
        public static ActionResult RollbackAgent(Session session)
        {
            // Full implementation in Task 5 — for now, a no-op so the build succeeds.
            return ActionResult.Success;
        }
    }
}
