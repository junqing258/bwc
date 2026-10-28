using ACadSharp.Entities;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

static partial class Worker
{
    // Evidence for navigation only. Never returned as canonical quantity geometry.
    static object? NativeEvidence(Entity entity) => entity switch {
        Wipeout w => new { insertPoint=A(w.InsertPoint),u=A(w.UVector),v=A(w.VVector),size=new[]{w.Size.X,w.Size.Y},clipVertices=w.ClipBoundaryVertices.Select(v=>new[]{v.X,v.Y}),clipType=w.ClipType.ToString(),clippingState=w.ClippingState,clipMode=w.ClipMode.ToString() },
        Ole2Frame o => new { upperLeft=A(o.UpperLeftCorner),lowerRight=A(o.LowerRightCorner),o.SourceApplication,objectType=o.OleObjectType.ToString(),binaryBytes=o.BinaryData?.Length??0,oleBytes=o.OleData?.Length??0,payloadSha256=Convert.ToHexString(SHA256.HashData(o.OleData?.Length>0?o.OleData:o.BinaryData??Array.Empty<byte>())).ToLowerInvariant(),contentDecoded=false },
        _ => null
    };
    static JsonNode? DiagnosticPreview(Entity entity,double[] matrix)
    {
        object? shape=null;string? kind=null;
        if(entity is LwPolyline p && p.Vertices.Count>0) {
            var basis=M.Ocs(A(p.Normal));
            shape=new{kind="annotation",quantityRole="annotation_only",parts=p.Vertices.Select(v=>new{kind="point",position=M.Point(basis,new[]{v.Location.X,v.Location.Y,p.Elevation})})};kind="source_vertices_only";
        } else if(entity is Wipeout w) {
            var a=A(w.InsertPoint);var u=A(w.UVector).Select(v=>v*w.Size.X).ToArray();var v=A(w.VVector).Select(v=>v*w.Size.Y).ToArray();
            var corners=new[]{a,a.Select((x,i)=>x+u[i]).ToArray(),a.Select((x,i)=>x+u[i]+v[i]).ToArray(),a.Select((x,i)=>x+v[i]).ToArray()};
            shape=Poly(corners,new double[4],true,new[]{0.0,0,1});kind="image_extent_only";
        } else if(entity is Ole2Frame o) {
            // Only the two WCS frame corners are known; embedded contents remain unread.
            shape=new{kind="annotation",quantityRole="annotation_only",parts=new[]{new{kind="point",position=A(o.UpperLeftCorner)},new{kind="point",position=A(o.LowerRightCorner)}}};kind="ole_frame_corners_only";
        }
        if(shape==null)return null;
        var geometry=TransformGeometry(Node(shape),matrix);
        JsonSerializer.Serialize(geometry,Json); // Reject non-finite evidence too.
        return Node(new{kind,geometry,quantityEligible=false,limitation="辅助定位，不代表对象已完整解析；不参与工程量或遮罩效果。"});
    }
}
