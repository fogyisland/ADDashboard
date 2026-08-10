namespace PackageDesigner.Models;

public class DatabaseConfig
{
    public string SchemaName { get; set; } = "";
    public List<string> Migrations { get; set; } = new();
    public string MetricTable { get; set; } = "";
    public Dictionary<string, MetricDef> MetricSchema { get; set; } = new();
}
