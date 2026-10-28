using System.Text.Json;
using System.Text.Json.Nodes;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.Tables;
using ACadSharp.IO;
using CSMath;

static partial class Worker
{
    static JsonNode Node(object value)=>JsonSerializer.SerializeToNode(value,Json)!;
    static object? NativeGeometry(Entity e)
    {
        if(e is Hatch h) return HatchGeometry(h);
        if(e is Dimension d) return DimensionGeometry(d);
        if(e is ACadSharp.Entities.Point p) return new {kind="point",position=A(p.Location),native=new{normal=A(p.Normal),p.Thickness,p.Rotation}};
        if(e is Solid s) {
            // DXF SOLID stores the last two quad corners in zigzag order, in OCS.
            var corners=s.ThirdCorner==s.FourthCorner?new[]{s.FirstCorner,s.SecondCorner,s.ThirdCorner}:new[]{s.FirstCorner,s.SecondCorner,s.FourthCorner,s.ThirdCorner};
            return new {kind="region",islandStyle="Normal",loops=new[]{Poly(corners.Select(A).ToArray(),new double[corners.Length],true,A(s.Normal))},native=new{type="SOLID",s.Thickness,normal=A(s.Normal),corners=new[]{A(s.FirstCorner),A(s.SecondCorner),A(s.ThirdCorner),A(s.FourthCorner)}}};
        }
        if(e is Face3D f) {
            var pts=f.ThirdCorner==f.FourthCorner?new[]{f.FirstCorner,f.SecondCorner,f.ThirdCorner}:new[]{f.FirstCorner,f.SecondCorner,f.ThirdCorner,f.FourthCorner};
            return new {kind="region",islandStyle="Normal",loops=new[]{Poly(pts.Select(A).ToArray(),new double[pts.Length],true,new[]{0.0,0,1})},native=new{type="3DFACE",flags=f.Flags.ToString()}};
        }
        return null;
    }
    static object HatchGeometry(Hatch h)
    {
        if(h.Paths.Count==0) throw new InvalidOperationException("HATCH_BOUNDARY_MISSING");
        var loops=new List<JsonNode>(); var ocs=M.Ocs(A(h.Normal));
        foreach(var path in h.Paths) {
            var segments=new JsonArray();
            foreach(var edge in path.Edges) {
                if(edge is Hatch.BoundaryPath.Polyline pl) {
                    if(!pl.IsClosed) throw new InvalidOperationException("HATCH_OPEN_POLYLINE_BOUNDARY");
                    var poly=Node(Poly(pl.Vertices.Select(v=>new[]{v.X,v.Y,h.Elevation}).ToArray(),pl.Vertices.Select(v=>v.Z).ToArray(),true,A(h.Normal)));
                    foreach(var seg in poly["segments"]!.AsArray()) segments.Add(seg!.DeepClone());
                } else if(edge is Hatch.BoundaryPath.Line line) {
                    segments.Add(Node(new{kind="line",start=M.Point(ocs,new[]{line.Start.X,line.Start.Y,h.Elevation}),end=M.Point(ocs,new[]{line.End.X,line.End.Y,h.Elevation})}));
                } else if(edge is Hatch.BoundaryPath.Arc arc) {
                    segments.Add(Node(new{kind="arc",center=M.Point(ocs,new[]{arc.Center.X,arc.Center.Y,h.Elevation}),u=M.Vector(ocs,new[]{arc.Radius,0.0,0}),v=M.Vector(ocs,new[]{0.0,arc.Radius,0}),startAngle=arc.CounterClockWise?arc.StartAngle:-arc.StartAngle,sweep=BoundarySweep(arc.StartAngle,arc.EndAngle,arc.CounterClockWise)}));
                } else if(edge is Hatch.BoundaryPath.Ellipse el) {
                    var u=new[]{el.MajorAxisEndPoint.X,el.MajorAxisEndPoint.Y,0.0};
                    var v=new[]{-u[1]*el.RadiusRatio,u[0]*el.RadiusRatio,0.0};
                    segments.Add(Node(new{kind="arc",center=M.Point(ocs,new[]{el.Center.X,el.Center.Y,h.Elevation}),u=M.Vector(ocs,u),v=M.Vector(ocs,v),startAngle=el.CounterClockWise?el.StartAngle:-el.StartAngle,sweep=BoundarySweep(el.StartAngle,el.EndAngle,el.CounterClockWise)}));
                } else throw new InvalidOperationException("HATCH_BOUNDARY_UNSUPPORTED: "+edge.GetType().Name);
            }
            if(segments.Count==0) throw new InvalidOperationException("HATCH_EMPTY_BOUNDARY");
            loops.Add(new JsonObject{["kind"]="path",["closed"]=true,["segments"]=segments,["boundaryFlags"]=(int)path.Flags});
        }
        return new{kind="region",islandStyle=h.Style.ToString(),loops,native=new{type="HATCH",h.Elevation,normal=A(h.Normal),h.IsSolid,h.IsAssociative,pattern=h.Pattern?.Name,h.PatternAngle,h.PatternScale,rendering="boundary_only"}};
    }
    static double BoundarySweep(double start,double end,bool ccw)
    {
        // ACadSharp 3.8.30 BoundaryPath.Arc/Ellipse.ToEntity reflects angles for CW.
        // Retain traversal from -start to -end instead of taking the complementary arc.
        if(Math.Abs(end-start)<1e-14)throw new InvalidOperationException("HATCH_ZERO_ANGLE_SPAN");
        double delta=end-start;
        delta=((delta%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
        if(delta<1e-14) delta=2*Math.PI;
        return ccw?delta:-delta;
    }
    static object DimensionGeometry(Dimension d)
    {
        if(d.Block==null||d.Block.Entities.Count==0) throw new InvalidOperationException("DIMENSION_PICTURE_MISSING");
        if(d.Normal!=XYZ.AxisZ||d.InsertionPoint!=XYZ.Zero||d.Block.BlockEntity.BasePoint!=XYZ.Zero)
            throw new InvalidOperationException("DIMENSION_PICTURE_COORDINATES_UNVERIFIED");
        var parts=new List<JsonNode>(); var refs=new List<object>(); var visiting=new HashSet<string>();
        void ExpandPicture(IEnumerable<Entity> entities,double[] matrix,int depth) {
            if(depth>16) throw new InvalidOperationException("DIMENSION_PICTURE_DEPTH");
            foreach(var child in entities) {
                if(parts.Count>10000) throw new InvalidOperationException("DIMENSION_PICTURE_RESOURCE_LIMIT");
                refs.Add(new{handle=H(child),type=child.ObjectName,child.IsInvisible});
                // Definition points are retained as evidence, never painted or counted as parts.
                if(child is ACadSharp.Entities.Point||child is AttributeDefinition||child.IsInvisible||!child.Layer.IsOn||child.Layer.Flags.HasFlag(LayerFlags.Frozen)) continue;
                if(child is Insert ins) {
                    if(ins.SpatialFilter!=null||ins.Block.IsDynamic||!string.IsNullOrEmpty(ins.Block.BlockEntity.XRefPath)||!visiting.Add(ins.Block.Name)) throw new InvalidOperationException("DIMENSION_PICTURE_INSERT_UNSUPPORTED");
                    for(int row=0;row<Math.Max(1,(int)ins.RowCount);row++) for(int col=0;col<Math.Max(1,(int)ins.ColumnCount);col++) {
                        var bm=M.Mul(M.Ocs(A(ins.Normal)),M.Mul(M.T(A(ins.InsertPoint)),M.Mul(M.R(ins.Rotation),M.Mul(M.T(new[]{col*ins.ColumnSpacing,row*ins.RowSpacing,0.0}),M.Mul(M.S(ins.XScale,ins.YScale,ins.ZScale),M.T(A(ins.Block.BlockEntity.BasePoint).Select(x=>-x).ToArray()))))));
                        ExpandPicture(ins.Block.Entities,M.Mul(matrix,bm),depth+1);
                    }
                    visiting.Remove(ins.Block.Name);
                } else {
                    if(child is Dimension) throw new InvalidOperationException("DIMENSION_PICTURE_RECURSIVE_DIMENSION");
                    var g=Geometry(child)??throw new InvalidOperationException("DIMENSION_PICTURE_UNSUPPORTED: "+child.ObjectName);
                    parts.Add(TransformGeometry(Node(g),matrix));
                }
            }
        }
        visiting.Add(d.Block.Name); ExpandPicture(d.Block.Entities,M.Identity(),0);
        if(parts.Count==0) throw new InvalidOperationException("DIMENSION_PICTURE_EMPTY");
        return new{kind="annotation",parts,native=new{type=d.GetType().Name,block=d.Block.Name,measurement=d.Measurement,textOverride=d.Text,normal=A(d.Normal),insertion=A(d.InsertionPoint),definition=A(d.DefinitionPoint),pictureSourceRefs=refs},quantityRole="annotation_only"};
    }
    static void CoverageFixture(string output)
    {
        Fixture(output);
        var doc=DwgReader.Read(output);var layer=new Layer("COVERAGE");doc.Layers.Add(layer);
        Hatch HatchAt(string name,XYZ normal,double elevation) {
            var h=new Hatch{Layer=layer,Normal=normal,Elevation=elevation};
            h.Paths.Add(new Hatch.BoundaryPath(new Hatch.BoundaryPath.Edge[]{new Hatch.BoundaryPath.Polyline(new[]{new XYZ(0,0,0),new XYZ(6,0,0),new XYZ(6,4,0),new XYZ(0,4,0)},true)}));
            h.Paths.Add(new Hatch.BoundaryPath(new Hatch.BoundaryPath.Edge[]{new Hatch.BoundaryPath.Polyline(new[]{new XYZ(1,1,0),new XYZ(2,1,0),new XYZ(2,2,0),new XYZ(1,2,0)},true)}));
            doc.Entities.Add(h);return h;
        }
        HatchAt("flat",XYZ.AxisZ,0);HatchAt("tilted",new XYZ(0,.6,.8),5);
        var curved=new Hatch{Layer=layer};
        curved.Paths.Add(new Hatch.BoundaryPath(new Hatch.BoundaryPath.Edge[]{new Hatch.BoundaryPath.Arc{Center=new XY(50,0),Radius=2,StartAngle=Math.PI/2,EndAngle=Math.PI,CounterClockWise=false},new Hatch.BoundaryPath.Line{Start=new XY(48,0),End=new XY(50,-2)}}));doc.Entities.Add(curved);
        var elliptic=new Hatch{Layer=layer};elliptic.Paths.Add(new Hatch.BoundaryPath(new Hatch.BoundaryPath.Edge[]{new Hatch.BoundaryPath.Ellipse{Center=new XY(60,0),MajorAxisEndPoint=new XY(3,0),RadiusRatio=.5,StartAngle=0,EndAngle=2*Math.PI,CounterClockWise=true}}));doc.Entities.Add(elliptic);
        var bulged=new Hatch{Layer=layer};bulged.Paths.Add(new Hatch.BoundaryPath(new Hatch.BoundaryPath.Edge[]{new Hatch.BoundaryPath.Polyline(new[]{new XYZ(69,0,1),new XYZ(71,0,1)},true)}));doc.Entities.Add(bulged);
        doc.Entities.Add(new Solid(new XYZ(10,0,0),new XYZ(16,0,0),new XYZ(10,4,0),new XYZ(16,4,0)){Layer=layer});
        doc.Entities.Add(new ACadSharp.Entities.Point(new XYZ(30,40,0)){Layer=layer});
        var picture=new BlockRecord("DIM_PICTURE");doc.BlockRecords.Add(picture);
        picture.Entities.Add(new Line(new XYZ(20,0,0),new XYZ(26,0,0)));
        picture.Entities.Add(new MText{Value="OVERRIDE 999",InsertPoint=new XYZ(23,1,0),Height=.2});
        var dim=new DimensionAligned{Block=picture,Layer=layer,Text="999",DefinitionPoint=new XYZ(20,0,0)};
        doc.Entities.Add(dim);
        var arrow=new BlockRecord("DIM_ARROW");doc.BlockRecords.Add(arrow);arrow.Entities.Add(new Solid(new XYZ(0,0,0),new XYZ(-.3,.1,0),new XYZ(-.3,-.1,0)));
        picture.Entities.Add(new Insert(arrow){InsertPoint=new XYZ(20,0,0),Rotation=Math.PI/2,XScale=-2});
        doc.Entities.Add(new Face3D{FirstCorner=new XYZ(80,0,0),SecondCorner=new XYZ(82,0,0),ThirdCorner=new XYZ(82,2,0),FourthCorner=new XYZ(80,2,0),Layer=layer});
        var broken=new LwPolyline(new IVector[]{new XY(40,40),new XY(40,40)}){IsClosed=true,Layer=layer};foreach(var v in broken.Vertices)v.Bulge=1;doc.Entities.Add(broken);
        DwgWriter.Write(output,doc);
    }
}
