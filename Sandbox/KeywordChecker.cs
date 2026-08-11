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