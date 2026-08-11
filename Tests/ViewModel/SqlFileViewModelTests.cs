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

    [Fact]
    public void StatusMessage_Formats_Pass_And_Blocked()
    {
        var file = new PackageFile { Path = "migrations/001.sql", Role = "migration" };
        var vm = new SqlFileViewModel(file);
        vm.Body = "CREATE TABLE foo (id INT)";
        Assert.Contains("Pass", vm.StatusMessage);
        Assert.Contains("tokens", vm.StatusMessage);
        vm.Body = "DROP TABLE foo";
        Assert.Contains("Blocked", vm.StatusMessage);
    }
}