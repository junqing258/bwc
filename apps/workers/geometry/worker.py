"""Deterministic geometry worker. Input geometry is WCS in source drawing units.
All metrics are computed from canonical curves, never display tessellation.
"""

import json
import math
import sys
import numpy as np
from shapely import Polygon, LineString, Point
from shapely.validation import explain_validity
from shapely.ops import unary_union, transform

VERSION = "bwc-planar-2"
TOLERANCE_M = 1e-5


class GeometryError(Exception):
    pass


def vector(x):
    a = np.asarray(x, dtype=float)
    if a.shape != (3,) or not np.isfinite(a).all():
        raise GeometryError("NON_FINITE_GEOMETRY")
    return a


def ends(s):
    if s["kind"] == "line":
        return vector(s["start"]), vector(s["end"])
    c, u, v = (vector(s[k]) for k in ("center", "u", "v"))
    t, w = s["startAngle"], s["sweep"]
    return c + u * math.cos(t) + v * math.sin(t), c + u * math.cos(
        t + w
    ) + v * math.sin(t + w)


def points(g, scale, tolerance=TOLERANCE_M):
    if not g or g["kind"] != "path" or not g["segments"]:
        raise GeometryError("UNSUPPORTED_GEOMETRY")
    pts = []
    last = None
    for s in g["segments"]:
        a, b = ends(s)
        if last is not None and np.linalg.norm(a - last) * scale > tolerance:
            raise GeometryError("DISCONNECTED_PATH")
        if s["kind"] == "line":
            pts.append(a)
        else:
            c, u, v = (vector(s[k]) for k in ("center", "u", "v"))
            r = max(np.linalg.norm(u), np.linalg.norm(v)) * scale
            angle = min(
                math.pi / 16,
                2 * math.acos(max(-1, min(1, 1 - tolerance / max(r, tolerance)))),
            )
            n = max(4, math.ceil(abs(s["sweep"]) / max(angle, 1e-9)))
            if n > 16384:
                raise GeometryError("RESOURCE_LIMIT_CURVE_TOLERANCE")
            for t in np.linspace(
                s["startAngle"], s["startAngle"] + s["sweep"], n, endpoint=False
            ):
                pts.append(c + u * math.cos(t) + v * math.sin(t))
        last = b
    pts.append(last)
    return np.array(pts) * scale


def simpson(f, a, b, eps=1e-10, depth=20):
    def rec(a, b, fa, fm, fb, whole, eps, depth):
        m = (a + b) / 2
        l = (a + m) / 2
        r = (m + b) / 2
        fl, fr = f(l), f(r)
        left = (m - a) * (fa + 4 * fl + fm) / 6
        right = (b - m) * (fm + 4 * fr + fb) / 6
        if depth <= 0 or abs(left + right - whole) <= 15 * eps:
            return left + right + (left + right - whole) / 15
        return rec(a, m, fa, fl, fm, left, eps / 2, depth - 1) + rec(
            m, b, fm, fr, fb, right, eps / 2, depth - 1
        )

    if b < a:
        return simpson(f, b, a, eps, depth)
    fa, fm, fb = f(a), f((a + b) / 2), f(b)
    return rec(a, b, fa, fm, fb, (b - a) * (fa + 4 * fm + fb) / 6, eps, depth)


def length(g, scale):
    if not g or g["kind"] != "path" or not g["segments"]:
        raise GeometryError("UNSUPPORTED_GEOMETRY")
    total = 0
    for s in g["segments"]:
        if s["kind"] == "line":
            total += (
                float(np.linalg.norm(vector(s["end"]) - vector(s["start"]))) * scale
            )
        else:
            u, v = vector(s["u"]) * scale, vector(s["v"]) * scale
            if not math.isfinite(s["sweep"]) or not math.isfinite(s["startAngle"]):
                raise GeometryError("NON_FINITE_GEOMETRY")
            total += simpson(
                lambda t: float(np.linalg.norm(-u * math.sin(t) + v * math.cos(t))),
                s["startAngle"],
                s["startAngle"] + s["sweep"],
            )
    if total <= 1e-12 or not math.isfinite(total):
        raise GeometryError("ZERO_LENGTH")
    return total


def contour(g, scale, basis=None):
    if not g or not g.get("closed"):
        raise GeometryError("OPEN_CONTOUR")
    pts = points(g, scale)
    if np.linalg.norm(pts[-1] - pts[0]) > TOLERANCE_M:
        raise GeometryError("OPEN_CONTOUR")
    origin = pts[0]
    if basis is None:
        _, singular, vt = np.linalg.svd(pts - origin, full_matrices=False)
        if len(singular) < 2 or singular[1] < 1e-12:
            raise GeometryError("DEGENERATE_CONTOUR")
        ex, ey, n = vt[0], vt[1], vt[2]
        basis = (origin, ex, ey, n)
    origin, ex, ey, n = basis
    local = pts - origin
    if np.max(np.abs(local @ n)) > TOLERANCE_M:
        raise GeometryError("NON_COPLANAR")
    poly = Polygon(np.column_stack((local @ ex, local @ ey)))
    if not poly.is_valid or poly.area <= 1e-16:
        raise GeometryError("GEOMETRY_INVALID: " + explain_validity(poly))
    # Exact Green integral of each source line / transformed parametric arc.
    area = 0.0
    cross = lambda a, b: float(a[0] * b[1] - a[1] * b[0])
    project = lambda p: np.array([np.dot(p, ex), np.dot(p, ey)])
    for s in g["segments"]:
        if s["kind"] == "line":
            a = project(vector(s["start"]) * scale - origin)
            b = project(vector(s["end"]) * scale - origin)
            area += cross(a, b) / 2
        else:
            c = project(vector(s["center"]) * scale - origin)
            u = project(vector(s["u"]) * scale)
            v = project(vector(s["v"]) * scale)
            a = s["startAngle"]
            b = a + s["sweep"]
            area += (
                cross(c, u) * (math.cos(b) - math.cos(a))
                + cross(c, v) * (math.sin(b) - math.sin(a))
                + cross(u, v) * (b - a)
            ) / 2
    return poly, abs(area), basis


def surface(g, scale, basis=None):
    """Exact loop areas; tessellated loops only decide topology/containment."""
    if not g or g.get("kind") != "region":
        poly, area, basis = contour(g, scale, basis)
        return poly, area, basis, area
    loops = g.get("loops", [])
    if not loops:
        raise GeometryError("EMPTY_REGION")
    polys, areas = [], []
    for loop in loops:
        poly, area, basis = contour(loop, scale, basis)
        polys.append(poly)
        areas.append(area)
    depths = [0] * len(polys)
    for i, a in enumerate(polys):
        for j, b in enumerate(polys):
            if i == j:
                continue
            if a.boundary.intersects(b.boundary):
                raise GeometryError("REGION_BOUNDARIES_TOUCH_OR_CROSS")
            if b.contains(a):
                depths[i] += 1
            elif a.intersects(b) and not a.contains(b):
                raise GeometryError("REGION_LOOPS_OVERLAP")
    style = g.get("islandStyle")
    if style not in ("Normal", "Outer", "Ignore"):
        raise GeometryError("HATCH_STYLE_UNSUPPORTED")
    filled = unary_union([p for p, d in zip(polys, depths) if d == 0])
    gross = math.fsum(a for a, d in zip(areas, depths) if d == 0)
    area = gross
    max_depth = max(depths)
    if style == "Ignore":
        max_depth = 0
    elif style == "Outer":
        max_depth = min(1, max_depth)
    for depth in range(1, max_depth + 1):
        layer = unary_union([p for p, d in zip(polys, depths) if d == depth])
        if depth % 2:
            filled = filled.difference(layer)
        else:
            filled = filled.union(layer)
        area += (-1 if depth % 2 else 1) * math.fsum(a for a, d in zip(areas, depths) if d == depth)
    if not filled.is_valid or area <= 1e-16:
        raise GeometryError("REGION_INVALID")
    return filled, area, basis, gross


def measure(occurrence, kind, scale, business, by_id):
    g = occurrence.get("geometry")
    oid = occurrence["occurrenceId"]
    attrs = business.get(oid, {})
    if kind == "entity_count":
        return {
            "value": 1,
            "formula": "one frozen entity occurrence (not a business component)",
        }
    if kind == "business_count":
        if not attrs.get("classification"):
            raise GeometryError("CLASSIFICATION_UNCONFIRMED")
        return {
            "value": 1,
            "formula": "one explicitly classified occurrence",
            "classification": attrs["classification"],
        }
    if scale is None or not math.isfinite(scale) or scale <= 0:
        raise GeometryError("UNITS_UNCONFIRMED")
    if g and g.get("kind") == "annotation":
        raise GeometryError("ANNOTATION_NOT_MEASURABLE")
    if g and g.get("kind") == "point":
        raise GeometryError("POINT_NOT_MEASURABLE")
    if kind == "length":
        return {
            "value": length(g, scale),
            "formula": "source curve integral",
            "lengthToleranceMetres": 1e-10,
        }
    if kind not in ("net_area", "parameter_volume"):
        raise GeometryError("UNSUPPORTED_METHOD")
    poly, base_area, basis, gross = surface(g, scale)
    holes = attrs.get("holes", [])
    if oid in holes or len(holes) != len(set(holes)):
        raise GeometryError("INVALID_HOLE_REFERENCE")
    hole_polys = []
    deduction = 0
    for hid in holes:
        if hid not in by_id:
            raise GeometryError("HOLE_REFERENCE_INVALID")
        hp, ha, _, _ = surface(by_id[hid].get("geometry"), scale, basis)
        if not poly.contains(hp) or poly.boundary.intersects(hp.boundary):
            raise GeometryError("HOLE_OUTSIDE_OR_TOUCHING")
        if any(hp.intersects(other) for other in hole_polys):
            raise GeometryError("HOLES_OVERLAP")
        hole_polys.append(hp)
        deduction += ha
    net = base_area - deduction
    result = {
        "grossArea": gross,
        "nativeHoleDeductionArea": gross - base_area,
        "deductionArea": deduction,
        "netArea": net,
        "holes": holes,
        "areaMethod": "analytic_green_integral",
        "topologyToleranceMetres": TOLERANCE_M,
        "value": net,
        "formula": "gross area - native island deduction - confirmed disjoint business holes",
    }
    if kind == "parameter_volume":
        t = attrs.get("uniform_thickness")
        if not t:
            raise GeometryError("MISSING_THICKNESS")
        if t["unitBinding"] == "physical_quantity":
            thickness = t["normalizedMetres"]
        else:
            source = by_id.get(t.get("sourceOccurrenceId"))
            if source is None:
                raise GeometryError("THICKNESS_REFERENCE_INVALID")
            thickness = length(source.get("geometry"), scale)
        if not math.isfinite(thickness) or thickness <= 0:
            raise GeometryError("INVALID_THICKNESS")
        result.update(
            {
                "value": net * thickness,
                "thicknessMetres": thickness,
                "parameter": t,
                "formula": "net area * uniform thickness (parameter volume)",
            }
        )
    return result


def spatial_shapes(g):
    if not g:
        return []
    kind = g.get("kind")
    if kind in ("point", "text"):
        return [Point(vector(g["position"])[:2])]
    if kind == "annotation":
        return [shape for part in g["parts"] for shape in spatial_shapes(part)]
    if kind == "region":
        try:
            poly, _, basis, _ = surface(g, 1)
            origin, ex, ey, _ = basis
            return [transform(lambda x,y: (origin[0] + np.asarray(x)*ex[0] + np.asarray(y)*ey[0], origin[1] + np.asarray(x)*ex[1] + np.asarray(y)*ey[1]), poly)]
        except (GeometryError, ValueError, np.linalg.LinAlgError):
            # Invalid area is still selectable via its displayed source boundaries.
            return [shape for loop in g["loops"] for shape in spatial_shapes({**loop,"closed":False})]
    xy = points(g, 1)[:, :2]
    shape = Polygon(xy) if g["closed"] else LineString(xy)
    return [shape] if shape.is_valid else [LineString(xy)]


def run(request):
    occurrences = request["occurrences"]
    by_id = {o["occurrenceId"]: o for o in occurrences}
    business = request.get("business", {})
    scale = request.get("scale")
    selected = request.get("members", list(by_id))
    kind = request.get("quantityKind", "parameter_volume")
    items = []
    for oid in selected:
        try:
            if oid not in by_id:
                raise GeometryError("ENTITY_REFERENCE_INVALID")
            item = measure(by_id[oid], kind, scale, business, by_id)
            items.append(
                {
                    "id": oid,
                    "status": "valid",
                    "methodVersion": VERSION,
                    "evidenceRefs": [oid, business.get(oid, {}).get("evidence")],
                    **item,
                }
            )
        except (GeometryError, ValueError, KeyError, np.linalg.LinAlgError) as e:
            items.append(
                {
                    "id": oid,
                    "status": "not_computable",
                    "value": None,
                    "reason": str(e),
                    "methodVersion": VERSION,
                }
            )
    if request.get("mode") == "spatial":
        rect = Polygon.from_bounds(*request["rectangle"])
        hits = []
        for o in occurrences:
            g = o.get("geometry")
            try:
                if any(shape.intersects(rect) for shape in spatial_shapes(g)):
                    hits.append(o["occurrenceId"])
            except (GeometryError, ValueError):
                pass
        return {
            "members": hits,
            "toleranceDrawingUnits": TOLERANCE_M,
            "mode": "curve_tessellation_intersection",
        }
    return {
        "items": items,
        "knownSubtotal": math.fsum(i["value"] for i in items if i["status"] == "valid"),
        "complete": all(i["status"] == "valid" for i in items),
        "methodVersion": VERSION,
    }


if __name__ == "__main__":
    try:
        with open(sys.argv[1]) as f:
            request = json.load(f)
        result = run(request)
        with open(sys.argv[2], "w") as f:
            json.dump(result, f, ensure_ascii=False, allow_nan=False)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
