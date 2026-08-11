namespace PackageDesigner.Sandbox;

internal static class Tokenizer
{
    public static List<string> Tokenize(string sql) =>
        sql.Split(new[] { ' ', '\t', '\n', '\r', '(', ')', ',', ';', '.' }, StringSplitOptions.RemoveEmptyEntries).ToList();
}