using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;
using CSMath;

static class Worker
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static Task<int> Run(string[] args)
    {
        try {
            if (args.Length != 2) throw new ArgumentException("Usage: CadWorker <request.json> <response.json>");
            var request = JsonNode.Parse(File.ReadAllText(args[0]))!;
            string mode = request["mode"]?.GetValue<string>() ?? "parse";
            if (mode == "fixture") { Fixture(request["output"]!.GetValue<string>(), request["fixtureMode"]?.GetValue<string>() == "transforms"); File.WriteAllText(args[1], "{\"status\":\"created\"}"); return Task.FromResult(0); }
            var notifications = new List<string>(); var watch = Stopwatch.StartNew();
            string input = request["input"]!.GetValue<string>();
            var doc = DwgReader.Read(input, new DwgReaderConfiguration { Failsafe = false, KeepUnknownEntities = true, KeepUnknownNonGraphicalObjects = true }, (_, e) => notifications.Add(e.Message));
            Apply(doc, request["patches"]?.AsArray() ?? new JsonArray());
            if (request["insUnits"] != null) doc.Header.InsUnits = (ACadSharp.Types.Units.UnitsType)request["insUnits"]!.GetValue<int>();
            var artifact = Extract(doc, notifications);
            if (mode == "export") {
                string output = request["output"]!.GetValue<string>();
                if (Path.GetFullPath(input) == Path.GetFullPath(output)) throw new InvalidOperationException("SOURCE_IMMUTABLE");
                Directory.CreateDirectory(Path.GetDirectoryName(output)!);
                DwgWriter.Write(output, doc, null, (_, e) => notifications.Add(e.Message));
                var reopened = DwgReader.Read(output, new DwgReaderConfiguration { Failsafe = false, KeepUnknownEntities = true, KeepUnknownNonGraphicalObjects = true });
                var after = Extract(reopened, new());
                artifact["roundtrip"] = new JsonObject { ["stateEqual"] = artifact["stateFingerprint"]!.GetValue<string>() == after["stateFingerprint"]!.GetValue<string>(), ["expected"] = artifact["stateFingerprint"]!.DeepClone(), ["actual"] = after["stateFingerprint"]!.DeepClone(), ["independentCad"] = "not_run", ["scope"] = "supported_geometry_layers_blocks_units_only" };
            }
            artifact["readSeconds"] = watch.Elapsed.TotalSeconds; artifact["peakWorkingSetBytes"] = Process.GetCurrentProcess().PeakWorkingSet64;
            File.WriteAllText(args[1], artifact.ToJsonString(Json)); return Task.FromResult(0);
        } catch(Exception e) {
            Console.Error.WriteLine(e.ToString());
            if(args.Length == 2) File.WriteAllText(args[1], JsonSerializer.Serialize(new { error = e.Message, errorType = e.GetType().Name }, Json));
            return Task.FromResult(1);
        }
    }
    static void Apply(CadDocument doc, JsonArray patches)
    {
        var entities = doc.BlockRecords.SelectMany(b => b.Entities).ToDictionary(e => e.Handle.ToString("X"));
        foreach(var patch in patches) {
            var op = patch!;
            foreach(var h in op["handles"]!.AsArray()) {
                if(!entities.TryGetValue(h!.GetValue<string>(), out var e)) throw new InvalidOperationException("ENTITY_NOT_FOUND");
                if(!doc.Entities.Contains(e)) throw new InvalidOperationException("UNSUPPORTED_INSTANCE_SCOPE");
                string kind = op["kind"]!.GetValue<string>();
                if (kind == "set_layer") {
                    string name = op["value"]!.GetValue<string>();
                    if(!doc.Layers.TryGetValue(name, out var layer)) { layer = new Layer(name); doc.Layers.Add(layer); } e.Layer = layer;
                } else if(kind == "set_text" && e is TextEntity t) t.Value = op["value"]!.GetValue<string>();
                else if(kind == "set_text" && e is MText mt) mt.Value = op["value"]!.GetValue<string>();
                else if(kind == "move_entities" && e is Line line) { var d = V(op["delta"]!); line.StartPoint += X(d); line.EndPoint += X(d); }
                else if(kind == "move_entities" && e is LwPolyline p && p.Normal == XYZ.AxisZ) {
                    var d = V(op["delta"]!); foreach(var v in p.Vertices) v.Location = new XY(v.Location.X + d[0], v.Location.Y + d[1]); p.Elevation += d[2];
                } else throw new InvalidOperationException("UNSUPPORTED_ENTITY_OPERATION");
            }
        }
    }
    static JsonObject Extract(CadDocument doc, List<string> notifications)
    {
        var diagnostics = new List<object>(); var occurrences = new List<object>(); var sources = new List<object>(); var dependencies = new List<object>();
        foreach(var image in doc.ImageDefinitions) dependencies.Add(new { kind = "image", path = image.FileName });
        var resources = doc.TextStyles.Select(t => new { kind = "font", style = t.Name, path = t.Filename, bigFont = t.BigFontFilename, verification = "not_verified" }).ToArray();
        var classes = doc.Classes.Select(c => new { c.DxfName, c.CppClassName, c.ApplicationName, c.InstanceCount, c.IsAnEntity, proxyFlags = c.ProxyFlags.ToString(), c.WasZombie }).ToArray();
        var layers = doc.Layers.OrderBy(l => l.Name).Select(l => new { name = l.Name, isOn = l.IsOn, isFrozen = l.Flags.HasFlag(LayerFlags.Frozen), color = Hex(l.Color) }).ToArray();
        foreach(var b in doc.BlockRecords.OrderBy(b => b.Name)) {
            if(!string.IsNullOrEmpty(b.BlockEntity.XRefPath)) dependencies.Add(new { kind = "xref", path = b.BlockEntity.XRefPath, blockName = b.Name });
            foreach(var e in b.Entities.OrderBy(e => e.Handle)) {
                object? geometry = null;
                try { geometry = Geometry(e); JsonSerializer.Serialize(geometry, Json); } catch(Exception ex) { diagnostics.Add(new { code = "GEOMETRY_INVALID", handle = H(e), reason = ex.Message }); geometry = null; }
                var ins = e as Insert;
                sources.Add(new { handle = H(e), type = e.ObjectName, runtimeType = e.GetType().Name, owner = b.Name, layer = e.Layer.Name, color = e.Color.Index, trueColor = e.Color.TrueColor, invisible = e.IsInvisible, geometry,
                    paperViewport = e is Viewport vp ? new { representsPaper = vp.RepresentsPaper, center = A(vp.Center), width = vp.Width, height = vp.Height, viewCenter = new[]{vp.ViewCenter.X,vp.ViewCenter.Y}, viewDirection = A(vp.ViewDirection), viewTarget = A(vp.ViewTarget), viewHeight = vp.ViewHeight, twistAngle = vp.TwistAngle, status = vp.Status.ToString() } : null,
                    insert = ins == null ? null : new { block = ins.Block.Name, point = A(ins.InsertPoint), normal = A(ins.Normal), rotation = ins.Rotation, scale = new[]{ins.XScale, ins.YScale, ins.ZScale}, basePoint = A(ins.Block.BlockEntity.BasePoint), rowCount = ins.RowCount, columnCount = ins.ColumnCount, rowSpacing = ins.RowSpacing, columnSpacing = ins.ColumnSpacing, attributes = ins.Attributes.Select(a => new { a.Tag, a.Value }).ToArray() } });
                if(geometry == null && ins == null && !(e is Viewport paper && paper.RepresentsPaper)) diagnostics.Add(new { code = e.ObjectName.StartsWith("TCH_") ? "COMPATIBILITY_EXPORT_REQUIRED" : "UNSUPPORTED_ENTITY", handle = H(e), entityType = e.ObjectName, owner = b.Name });
            }
        }
        void Expand(IEnumerable<Entity> entities, double[] matrix, JsonArray path, string space, string? inheritedLayer, Color? inheritedColor, HashSet<string> visiting, bool parentVisible)
        {
            foreach(var e in entities) {
                if(occurrences.Count >= 250000) throw new InvalidOperationException("RESOURCE_LIMIT: occurrence count");
                string layerName = e.Layer.Name == "0" && inheritedLayer != null ? inheritedLayer : e.Layer.Name;
                var layer = doc.Layers[layerName]; Color color = e.Color.IsByLayer ? layer.Color : e.Color.IsByBlock ? inheritedColor ?? layer.Color : e.Color;
                bool visible = parentVisible && !e.IsInvisible && layer.IsOn && !layer.Flags.HasFlag(LayerFlags.Frozen);
                if(e is Insert ins) {
                    if(path.Count >= 24 || !visiting.Add(ins.Block.Name)) { diagnostics.Add(new { code = "INSTANCE_CYCLE_OR_DEPTH", handle = H(e) }); continue; }
                    if(ins.SpatialFilter != null || ins.Block.IsDynamic || !string.IsNullOrEmpty(ins.Block.BlockEntity.XRefPath)) {
                        diagnostics.Add(new { code = "UNSUPPORTED_INSERT_FEATURE", handle = H(e), blockName = ins.Block.Name });
                        occurrences.Add(new { sourceHandle = H(e), entityType = "INSERT", layer = layerName, space, instancePath = path.DeepClone(), occurrenceKey = H(e) + "/" + path.ToJsonString(), geometry = (object?)null, visible, color = Hex(color), matrix, blockName = ins.Block.Name }); visiting.Remove(ins.Block.Name); continue;
                    }
                    for(int row = 0; row < Math.Max(1, (int)ins.RowCount); row++) for(int col = 0; col < Math.Max(1, (int)ins.ColumnCount); col++) {
                        var segment = new JsonObject { ["insertHandle"] = H(ins) }; if(ins.IsMultiple) segment["arrayCell"] = new JsonObject { ["row"] = row, ["column"] = col };
                        var next = (JsonArray)path.DeepClone(); next.Add(segment); var ocs = M.Ocs(A(ins.Normal));
                        // Array spacing is rotated but not scaled; base point is subtracted before scaling.
                        var blockMatrix = M.Mul(ocs, M.Mul(M.T(A(ins.InsertPoint)), M.Mul(M.R(ins.Rotation), M.Mul(M.T(new[]{col * ins.ColumnSpacing, row * ins.RowSpacing, 0.0}), M.Mul(M.S(ins.XScale, ins.YScale, ins.ZScale), M.T(A(ins.Block.BlockEntity.BasePoint).Select(v => -v).ToArray()))))));
                        Expand(ins.Block.Entities.Where(x => x is not AttributeDefinition), M.Mul(matrix, blockMatrix), next, space, layerName, color, visiting, visible);
                        // ATTRIB points are in the parent's coordinates. Only array-cell displacement is added.
                        var offset = M.Vector(M.Mul(ocs,M.R(ins.Rotation)),new[]{col*ins.ColumnSpacing,row*ins.RowSpacing,0.0});
                        Expand(ins.Attributes, M.Mul(matrix,M.T(offset)), next, space, layerName, color, visiting, visible);
                    }
                    visiting.Remove(ins.Block.Name); continue;
                }
                JsonNode? geometry = null;
                try { var raw = Geometry(e); if(raw != null) geometry = TransformGeometry(JsonSerializer.SerializeToNode(raw, Json)!, matrix); }
                catch(Exception ex) { diagnostics.Add(new { code = "GEOMETRY_INVALID", handle = H(e), reason = ex.Message }); }
                occurrences.Add(new { sourceHandle = H(e), entityType = e.ObjectName, layer = layerName, space, instancePath = path.DeepClone(), occurrenceKey = H(e) + "/" + path.ToJsonString(), geometry, visible, color = Hex(color), matrix });
            }
        }
        foreach(var b in doc.BlockRecords.Where(b => b.Name.StartsWith("*Model_Space", StringComparison.OrdinalIgnoreCase) || b.Name.StartsWith("*Paper_Space", StringComparison.OrdinalIgnoreCase)))
            Expand(b.Entities, M.Identity(), new JsonArray(), b.Name.StartsWith("*Model", StringComparison.OrdinalIgnoreCase) ? "model" : b.Name, null, null, new(), true);
        var blockStates = doc.BlockRecords.OrderBy(b => b.Name).Select(b => new { b.Name, basePoint = A(b.BlockEntity.BasePoint), flags = b.Flags.ToString(), units = (int)b.Units, xrefPath = b.BlockEntity.XRefPath }).ToArray();
        var fingerprint = Hash(JsonSerializer.Serialize(new { insUnits = (int)doc.Header.InsUnits, layers, blocks = blockStates, entities = sources }, Json));
        return JsonSerializer.SerializeToNode(new {
            schemaVersion = 1, coordinateContractVersion = "bwc-wcs-1", parser = "ACadSharp", parserVersion = "3.8.30", dwgVersion = doc.Header.Version.ToString(), insUnits = (int)doc.Header.InsUnits,
            sourceEntityCount = doc.Entities.Count, sourceRecordCount = sources.Count, sources, occurrences, layers, blocks = blockStates, classes, dependencies, resources, diagnostics, notifications, stateFingerprint = fingerprint,
            importCompleteness = diagnostics.Count > 0 || notifications.Count > 0 ? "partial" : "complete",
            displayLimitations = new[]{"Browser fonts; SHX/MTEXT formatting, line patterns and weights are approximate.","XREF, clipped/dynamic inserts, hatches, dimensions and solids are not rendered or measured."}
        }, Json)!.AsObject();
    }
    static object? Geometry(Entity e)
    {
        if(e is Line l) return new { kind = "path", closed = false, segments = new object[]{new { kind = "line", start = A(l.StartPoint), end = A(l.EndPoint) }} };
        if(e is Circle c) {
            var basis = M.Ocs(A(c.Normal)); double start = e is Arc a ? a.StartAngle : 0;
            double sweep = e is Arc arc ? (arc.EndAngle - arc.StartAngle + 2 * Math.PI) % (2 * Math.PI) : 2 * Math.PI;
            return new { kind = "path", closed = e is not Arc, segments = new object[]{new { kind = "arc", center = M.Point(basis, A(c.Center)), u = M.Vector(basis, new[]{c.Radius,0.0,0.0}), v = M.Vector(basis,new[]{0.0,c.Radius,0.0}), startAngle = start, sweep }} };
        }
        if(e is LwPolyline lw) return Poly(lw.Vertices.Select(v => new[]{v.Location.X, v.Location.Y, lw.Elevation}).ToArray(), lw.Vertices.Select(v => v.Bulge).ToArray(), lw.IsClosed, A(lw.Normal));
        if(e is Polyline2D pl) return Poly(pl.Vertices.Select(v => new[]{v.Location.X, v.Location.Y, pl.Elevation}).ToArray(), pl.Vertices.Select(v => v.Bulge).ToArray(), pl.IsClosed, A(pl.Normal));
        if(e is Ellipse el) {
            var u = A(el.MajorAxisEndPoint); var v = M.Cross(M.Normalize(A(el.Normal)), u).Select(x => x * el.RadiusRatio).ToArray();
            return new { kind = "path", closed = el.IsFullEllipse, segments = new object[]{new { kind = "arc", center = A(el.Center), u, v, startAngle = el.StartParameter, sweep = el.IsFullEllipse ? 2*Math.PI : (el.EndParameter-el.StartParameter+2*Math.PI)%(2*Math.PI) }} };
        }
        if(e is TextEntity t) return new { kind = "text", text = t.Value, position = M.Point(M.Ocs(A(t.Normal)), A(t.InsertPoint)), height = t.Height, rotation = t.Rotation, formatting = "plain_approximation" };
        if(e is MText mt) return new { kind = "text", text = mt.PlainText, position = A(mt.InsertPoint), height = mt.Height, rotation = mt.Rotation, formatting = "plain_approximation" };
        return null;
    }
    static object Poly(double[][] pts, double[] bulges, bool closed, double[] normal)
    {
        var matrix = M.Ocs(normal); var segments = new List<object>();
        for(int i = 0; i < pts.Length - (closed ? 0 : 1); i++) {
            var p = pts[i]; var q = pts[(i + 1) % pts.Length]; double b = bulges[i];
            if(Math.Abs(b) < 1e-14) segments.Add(new { kind = "line", start = M.Point(matrix,p), end = M.Point(matrix,q) });
            else { double dx=q[0]-p[0],dy=q[1]-p[1],chord=Math.Sqrt(dx*dx+dy*dy); if(chord==0)throw new InvalidOperationException("Degenerate bulge");
                double factor=(1-b*b)/(4*b); var center=new[]{(p[0]+q[0])/2-dy*factor,(p[1]+q[1])/2+dx*factor,p[2]}; double radius=chord*(1+b*b)/(4*Math.Abs(b));
                segments.Add(new { kind = "arc", center = M.Point(matrix,center), u = M.Vector(matrix,new[]{radius,0.0,0.0}), v = M.Vector(matrix,new[]{0.0,radius,0.0}), startAngle = Math.Atan2(p[1]-center[1],p[0]-center[0]), sweep = 4*Math.Atan(b) }); }
        }
        return new { kind = "path", closed, segments };
    }
    static JsonNode TransformGeometry(JsonNode g, double[] matrix)
    {
        if(g["kind"]!.GetValue<string>() == "text") { g["position"] = JsonSerializer.SerializeToNode(M.Point(matrix,V(g["position"]!))); g["height"] = g["height"]!.GetValue<double>() * M.Length(M.Vector(matrix,new[]{0.0,1.0,0.0})); return g; }
        foreach(var s in g["segments"]!.AsArray()) foreach(var name in new[]{"start","end","center","u","v"}) if(s![name]!=null) s[name]=JsonSerializer.SerializeToNode(name=="u"||name=="v"?M.Vector(matrix,V(s[name]!)):M.Point(matrix,V(s[name]!)));
        return g;
    }
    static void Fixture(string output, bool transforms = false)
    {
        var doc = new CadDocument(); doc.Header.Version = ACadVersion.AC1032; doc.Header.InsUnits = (ACadSharp.Types.Units.UnitsType)6;
        foreach(var b in doc.BlockRecords) foreach(var e in b.Entities.ToArray()) if(e is Viewport) b.Entities.Remove(e);
        foreach(var style in doc.TableStyles) foreach(var cell in new[]{style.DataCellStyle,style.HeaderCellStyle,style.TitleCellStyle,style.TableCellStyle}.Concat(style.CellStyles)) if(cell != null) cell.TextStyle = doc.TextStyles.First();
        var slab = new Layer("受控楼板轮廓"); var holes = new Layer("受控洞口"); doc.Layers.Add(slab); doc.Layers.Add(holes);
        LwPolyline Rect(double x,double y,double w,double h,Layer l) => new LwPolyline(new IVector[]{new XY(x,y),new XY(x+w,y),new XY(x+w,y+h),new XY(x,y+h)}) { IsClosed=true,Layer=l };
        doc.Entities.Add(Rect(0,0,6,4,slab));doc.Entities.Add(Rect(1,1,1,1,holes));doc.Entities.Add(new Line(new XYZ(0,-1,0),new XYZ(6,-1,0)));
        doc.Entities.Add(new TextEntity("6m x 4m / 1m2 opening - controlled fixture") { InsertPoint=new XYZ(0,4.5,0),Height=0.25 });
        var block=new BlockRecord("ARRAY_FIXTURE");block.BlockEntity.BasePoint=new XYZ(1,2,0);doc.BlockRecords.Add(block);block.Entities.Add(new Line(new XYZ(1,2,0),new XYZ(2,2,0)));
        doc.Entities.Add(new Insert(block) { InsertPoint=new XYZ(10,0,0),RowCount=(ushort)(transforms?3:2),ColumnCount=(ushort)(transforms?4:3),RowSpacing=2,ColumnSpacing=3,Rotation=Math.PI/2,XScale=-2,YScale=1 });
        if(transforms) {
            var tilted = new Layer("OCS_REFERENCE"); doc.Layers.Add(tilted);
            var p = Rect(0,0,6,4,tilted); p.Normal = new XYZ(0,.6,.8); p.Elevation = 5; doc.Entities.Add(p);
            doc.Entities.Add(new Circle(new XYZ(2,3,5),2) { Normal = new XYZ(0,.6,.8), Layer = tilted });
            var parent = new BlockRecord("NESTED_REFERENCE"); parent.BlockEntity.BasePoint = new XYZ(3,4,0);doc.BlockRecords.Add(parent);
            parent.Entities.Add(new Insert(block) { InsertPoint = new XYZ(5,7,0), Rotation = Math.PI/2, XScale = 2, YScale = -3 });
            doc.Entities.Add(new Insert(parent) { InsertPoint = new XYZ(20,30,0), XScale = -1, YScale = 2 });
        }
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);DwgWriter.Write(output,doc);
    }
    static string H(Entity e)=>e.Handle.ToString("X");static double[] A(XYZ p)=>new[]{p.X,p.Y,p.Z};static XYZ X(double[] p)=>new(p[0],p[1],p[2]);
    static double[] V(JsonNode n)=>n.AsArray().Select(x=>x!.GetValue<double>()).ToArray();
    static string Hash(string s)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();static string Hex(Color c)=>$"#{c.R:x2}{c.G:x2}{c.B:x2}";
}
static class M
{
    public static double[] Identity()=>new[]{1.0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    public static double[] Mul(double[] a,double[] b){var r=new double[16];for(int i=0;i<4;i++)for(int j=0;j<4;j++)for(int k=0;k<4;k++)r[i*4+j]+=a[i*4+k]*b[k*4+j];return r;}
    public static double[] Point(double[] m,double[] p)=>new[]{m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[3],m[4]*p[0]+m[5]*p[1]+m[6]*p[2]+m[7],m[8]*p[0]+m[9]*p[1]+m[10]*p[2]+m[11]};
    public static double[] Vector(double[] m,double[] p)=>new[]{m[0]*p[0]+m[1]*p[1]+m[2]*p[2],m[4]*p[0]+m[5]*p[1]+m[6]*p[2],m[8]*p[0]+m[9]*p[1]+m[10]*p[2]};
    public static double Length(double[] p)=>Math.Sqrt(p.Sum(v=>v*v));
    public static double[] Normalize(double[] p){double l=Length(p);if(!double.IsFinite(l)||l<1e-15)throw new InvalidOperationException("Invalid normal");return p.Select(x=>x/l).ToArray();}
    public static double[] Cross(double[] a,double[] b)=>new[]{a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]};
    public static double[] Ocs(double[] normal){var n=Normalize(normal);var ax=Normalize(Cross(Math.Abs(n[0])<1.0/64&&Math.Abs(n[1])<1.0/64?new[]{0.0,1,0}:new[]{0.0,0,1},n));var ay=Cross(n,ax);return new[]{ax[0],ay[0],n[0],0,ax[1],ay[1],n[1],0,ax[2],ay[2],n[2],0,0,0,0,1};}
    public static double[] T(double[] p){var r=Identity();r[3]=p[0];r[7]=p[1];r[11]=p[2];return r;}
    public static double[] S(double x,double y,double z)=>new[]{x,0,0,0,0,y,0,0,0,0,z,0,0,0,0,1};
    public static double[] R(double t)=>new[]{Math.Cos(t),-Math.Sin(t),0,0,Math.Sin(t),Math.Cos(t),0,0,0,0,1,0,0,0,0,1};
}
