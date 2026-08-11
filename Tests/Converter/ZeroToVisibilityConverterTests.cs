using System.Globalization;
using System.Windows;
using PackageDesigner.Converters;
using Xunit;

namespace PackageDesigner.Tests.Converter;

public class ZeroToVisibilityConverterTests
{
    [Fact]
    public void Zero_returns_Visible()
    {
        var c = new ZeroToVisibilityConverter();
        Assert.Equal(Visibility.Visible, c.Convert(0, typeof(Visibility), null, CultureInfo.InvariantCulture));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(99)]
    public void NonZero_returns_Collapsed(int n)
    {
        var c = new ZeroToVisibilityConverter();
        Assert.Equal(Visibility.Collapsed, c.Convert(n, typeof(Visibility), null, CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Null_returns_Collapsed()
    {
        var c = new ZeroToVisibilityConverter();
        Assert.Equal(Visibility.Collapsed, c.Convert(null, typeof(Visibility), null, CultureInfo.InvariantCulture));
    }

    [Fact]
    public void ConvertBack_throws()
    {
        var c = new ZeroToVisibilityConverter();
        Assert.Throws<System.NotSupportedException>(() =>
            c.ConvertBack(Visibility.Visible, typeof(int), null, CultureInfo.InvariantCulture));
    }
}
