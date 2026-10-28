using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Tables;
using CSMath;

static partial class Worker
{
    static void DimensionFixture(string output)
    {
        var doc=new CadDocument();
        Layer LayerFor(string name) { var layer=new Layer(name);doc.Layers.Add(layer);return layer; }
        var picture=new BlockRecord("CLONED_DIMENSION_PICTURE");doc.BlockRecords.Add(picture);
        picture.Entities.Add(new Line(new XYZ(100020,-2500,0),new XYZ(100026,-2500,0)));
        picture.Entities.Add(new MText{Value="CACHE 6",InsertPoint=new XYZ(100023,-2499,0),Height=.2});
        var arrow=new BlockRecord("DIMENSION_ARROW");doc.BlockRecords.Add(arrow);
        arrow.BlockEntity.BasePoint=new XYZ(1,2,0);
        arrow.Entities.Add(new Line(new XYZ(1,2,0),new XYZ(3,2,0)));
        picture.Entities.Add(new Insert(arrow){InsertPoint=new XYZ(100020,-2500,0),Rotation=Math.PI/2,XScale=-2,YScale=3});
        DimensionAligned Dim(string layer,XYZ insertion) => new() {
            Block=picture,Layer=LayerFor(layer),InsertionPoint=insertion,
            FirstPoint=new XYZ(20,0,-650),SecondPoint=new XYZ(26,0,-650),
            DefinitionPoint=new XYZ(26,0,-650),TextMiddlePoint=new XYZ(23,1,-650)
        };
        var displacement=new XYZ(-100000,2500,-650);
        doc.Entities.Add(Dim("DIM_TRANSLATED",displacement));
        // Sharing a picture must never mutate its child coordinates for the next clone.
        doc.Entities.Add(Dim("DIM_ORIGINAL",XYZ.Zero));
        var owner=new BlockRecord("DIMENSION_OWNER");doc.BlockRecords.Add(owner);
        owner.BlockEntity.BasePoint=new XYZ(10,20,0);
        owner.Entities.Add(Dim("DIM_NESTED",displacement));
        doc.Entities.Add(new Insert(owner){InsertPoint=new XYZ(100,200,7),Rotation=Math.PI/2,XScale=-2,YScale=3,ZScale=2});
        var tilted=Dim("DIM_TILTED",displacement);tilted.Normal=new XYZ(0,.6,.8);doc.Entities.Add(tilted);
        var nonzeroBase=new BlockRecord("UNVERIFIED_DIMENSION_BASE");doc.BlockRecords.Add(nonzeroBase);
        nonzeroBase.BlockEntity.BasePoint=new XYZ(1,0,0);
        nonzeroBase.Entities.Add(new Line(new XYZ(1,0,0),new XYZ(7,0,0)));
        var based=Dim("DIM_BASEPOINT",XYZ.Zero);based.Block=nonzeroBase;doc.Entities.Add(based);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        DwgWriter.Write(output,doc);
    }
}
