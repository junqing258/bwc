using System.Reflection;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;
using CSMath;

if (args.Length > 0 && args[0] == "api")
{
    foreach (var t in new[] { typeof(CadDocument), typeof(ACadSharp.Objects.TableStyle), typeof(ACadSharp.Objects.TableStyle.CellStyle), typeof(Insert), typeof(LwPolyline), typeof(Polyline2D), typeof(TextEntity), typeof(BlockRecord), typeof(ACadSharp.Blocks.Block), typeof(CSMath.Transform), typeof(ACadSharp.Header.CadHeader), typeof(ACadSharp.Color) }) {
        Console.WriteLine(t.FullName);
        foreach(var p in t.GetProperties()) Console.WriteLine($"  {p.PropertyType.Name} {p.Name}");
        foreach(var c in t.GetConstructors()) Console.WriteLine($"  {c}");
        foreach(var m in t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)) Console.WriteLine($"  {m}");
    }
    return 0;
}
return await Worker.Run(args);
