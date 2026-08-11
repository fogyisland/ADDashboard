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