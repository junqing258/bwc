import math
import unittest
from worker import run, contour, length, GeometryError


def path(points, closed=True):
    pairs=list(zip(points,points[1:]+([points[0]] if closed else [])))
    return {'kind':'path','closed':closed,'segments':[{'kind':'line','start':a,'end':b} for a,b in pairs]}


def occurrence(oid,g):
    return {'occurrenceId':oid,'geometry':g}


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.outer=occurrence('outer',path([[0,0,0],[6,0,0],[6,4,0],[0,4,0]]))
        self.hole=occurrence('hole',path([[1,1,0],[2,1,0],[2,2,0],[1,2,0]]))
        self.source=occurrence('thickness',path([[0,0,0],[.15,0,0]],False))
        self.business={'outer':{'holes':['hole'],'uniform_thickness':{'unitBinding':'physical_quantity','normalizedMetres':.15,'evidence':'explicit_user_statement'}}}

    def measure(self,scale=1,business=None,members=None):
        return run({'occurrences':[self.outer,self.hole,self.source],'members':members or ['outer'],'quantityKind':'parameter_volume','business':business or self.business,'scale':scale})

    def test_known_reference_and_physical_unit_reinterpretation(self):
        r=self.measure();self.assertAlmostEqual(r['knownSubtotal'],3.45,10)
        self.assertAlmostEqual(r['items'][0]['netArea'],23,10)
        self.assertAlmostEqual(self.measure(.001)['knownSubtotal'],.00000345,14)
        self.assertAlmostEqual(self.measure()['knownSubtotal'],3.45,10)

    def test_source_geometry_thickness_scales_cubically(self):
        business={'outer':{'holes':['hole'],'uniform_thickness':{'unitBinding':'source_geometry','sourceOccurrenceId':'thickness'}}}
        self.assertAlmostEqual(self.measure(business=business)['knownSubtotal'],3.45,10)
        self.assertAlmostEqual(self.measure(.001,business)['knownSubtotal'],3.45e-9,18)

    def test_unknown_is_null_and_preserves_known_subtotal(self):
        r=self.measure(members=['outer','hole']);self.assertFalse(r['complete'])
        self.assertAlmostEqual(r['knownSubtotal'],3.45);self.assertIsNone(r['items'][1]['value']);self.assertEqual(r['items'][1]['reason'],'MISSING_THICKNESS')

    def test_hole_outside_overlap_and_double_deduction_rejected(self):
        self.hole['geometry']=path([[5,3,0],[7,3,0],[7,4,0],[5,4,0]])
        self.assertEqual(self.measure()['items'][0]['reason'],'HOLE_OUTSIDE_OR_TOUCHING')
        self.setUp();self.business['outer']['holes']=['hole','hole']
        self.assertEqual(self.measure()['items'][0]['reason'],'INVALID_HOLE_REFERENCE')

    def test_self_intersection_open_nonplanar_rejected(self):
        for g in [path([[0,0,0],[2,2,0],[0,2,0],[2,0,0]]),path([[0,0,0],[2,0,0],[2,2,1],[0,2,0]]),path([[0,0,0],[2,0,0],[2,2,0]],False)]:
            with self.assertRaises(GeometryError):contour(g,1)

    def test_tilted_planar_area_not_horizontal_projection(self):
        g=path([[0,0,0],[6,0,0],[6,2.4,3.2],[0,2.4,3.2]])
        _,area,_=contour(g,1);self.assertAlmostEqual(area,24,9)

    def test_transformed_elliptic_circle_analytic_area(self):
        g={'kind':'path','closed':True,'segments':[{'kind':'arc','center':[1e7,-2e7,3],'u':[-6,0,0],'v':[0,2.4,3.2],'startAngle':0,'sweep':2*math.pi}]}
        _,area,_=contour(g,1);self.assertAlmostEqual(area,24*math.pi,7)
        self.assertAlmostEqual(length(g,1),31.7308791786,7)

    def test_units_are_required_for_dimensional_results(self):
        r=self.measure(None);self.assertIsNone(r['items'][0]['value']);self.assertEqual(r['items'][0]['reason'],'UNITS_UNCONFIRMED')

    def test_display_geometry_never_enters_metrics(self):
        a=self.measure();self.outer['displayPoints']=[[0,0,0],[1,1,0]]
        self.assertEqual(a,self.measure())


if __name__=='__main__':unittest.main()
