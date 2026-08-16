// =============================================================================
//  RollbackAgentActionTests — Task 8
//
//  Coverage:
//    The two [CustomAction] entry points on RollbackAgentAction must be
//    discoverable by Windows Installer at install time. That contract is:
//      - method is `public static`
//      - method carries [CustomAction] (WixToolset.Dtf.WindowsInstaller)
//
//    Beyond the attribute check we deliberately do NOT call
//    RunServiceRemove / RunNssmRemove / ParseInstallDir — they all touch
//    nssm.exe or expect a live MSI Session, which we don't have in a unit
//    test host. The behavior they exercise (idempotent / non-fatal) is
//    covered by Task 9's Pester E2E suite on a real Windows VM.
//
//    We use reflection for the [CustomAction] attribute lookup because the
//    attribute type lives in WixToolset.Dtf.WindowsInstaller, and asserting
//    by full type name keeps the test resilient to attribute-instance
//    equality quirks.
// =============================================================================

using System;
using System.Linq;
using System.Reflection;
using ADDashboard.AgentInstaller.CA;
using WixToolset.Dtf.WindowsInstaller;
using Xunit;

namespace ADDashboard.AgentInstaller.CA.Tests
{
    public class RollbackAgentActionTests
    {
        [Fact]
        public void Type_IsStaticClass()
        {
            // RollbackAgentAction must be `public static class` per the
            // implementation. If anyone re-introduces an instance ctor the
            // MSI contract breaks (CAs are invoked as static methods).
            var t = typeof(RollbackAgentAction);
            Assert.True(t.IsAbstract && t.IsSealed,
                "RollbackAgentAction must be a static class (abstract + sealed).");
            Assert.True(t.IsPublic, "RollbackAgentAction must be public.");
        }

        [Fact]
        public void RollbackAgent_IsPublicStatic_ReturnsActionResult()
        {
            // The install-time rollback companion entry point.
            var method = typeof(RollbackAgentAction).GetMethod(
                "RollbackAgent",
                BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(method);
            Assert.True(method.IsPublic);
            Assert.True(method.IsStatic);

            var parameters = method.GetParameters();
            Assert.Single(parameters);
            Assert.Equal(typeof(Session), parameters[0].ParameterType);

            Assert.Equal(typeof(ActionResult), method.ReturnType);
        }

        [Fact]
        public void RollbackAgent_CarriesCustomActionAttribute()
        {
            // Windows Installer locates CAs by enumerating [CustomAction]
            // methods on the exported type. If this attribute is missing,
            // the installer will not invoke the rollback at install time.
            var method = typeof(RollbackAgentAction).GetMethod(
                "RollbackAgent",
                BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(method);

            var attrs = method.GetCustomAttributes(typeof(CustomActionAttribute), inherit: false);
            Assert.NotEmpty(attrs);

            // The attribute must be the one from WixToolset.Dtf.WindowsInstaller,
            // not a custom shim. Full-name match is sufficient.
            var attrType = attrs.Single().GetType();
            Assert.Equal("WixToolset.Dtf.WindowsInstaller.CustomActionAttribute",
                attrType.FullName);
        }

        [Fact]
        public void RemoveAgentService_IsPublicStatic_ReturnsActionResult()
        {
            // The uninstall-path deferred CA entry point. Same surface
            // contract as RollbackAgent.
            var method = typeof(RollbackAgentAction).GetMethod(
                "RemoveAgentService",
                BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(method);
            Assert.True(method.IsPublic);
            Assert.True(method.IsStatic);
            Assert.Equal(typeof(ActionResult), method.ReturnType);
            Assert.Single(method.GetParameters());
        }

        [Fact]
        public void RemoveAgentService_CarriesCustomActionAttribute()
        {
            var method = typeof(RollbackAgentAction).GetMethod(
                "RemoveAgentService",
                BindingFlags.Public | BindingFlags.Static);
            Assert.NotNull(method);
            Assert.NotEmpty(method.GetCustomAttributes(typeof(CustomActionAttribute), inherit: false));
        }
    }
}