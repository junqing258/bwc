import type { Geometry, Segment, Vec3 } from "./types.ts";
export function evaluate(s: Segment, t: number): Vec3 {
  return s.kind === "line"
    ? (s.start.map((v, i) => v + (s.end[i] - v) * t) as Vec3)
    : (s.center.map(
        (v, i) =>
          v +
          s.u[i] * Math.cos(s.startAngle + s.sweep * t) +
          s.v[i] * Math.sin(s.startAngle + s.sweep * t),
      ) as Vec3);
}
// Conservative analytic bounds, including extrema on transformed elliptical arcs.
export function bounds(
  g: Geometry | null,
): [number, number, number, number] | null {
  if (!g) return null;
  const points: Vec3[] =
    g.kind === "text"
      ? [
          g.position,
          [
            g.position[0] + g.height * Math.max(g.text.length, 1),
            g.position[1] + g.height,
            g.position[2],
          ],
        ]
      : g.segments.flatMap((s) => {
          if (s.kind === "line") return [s.start, s.end];
          const ts = [0, 1];
          for (let axis = 0; axis < 2; axis++) {
            const a = Math.atan2(s.v[axis], s.u[axis]);
            for (let k = -4; k <= 4; k++) {
              const t = (a + k * Math.PI - s.startAngle) / s.sweep;
              if (t > 0 && t < 1) ts.push(t);
            }
          }
          return ts.map((t) => evaluate(s, t));
        });
  if (!points.length || points.some((p) => p.some((v) => !Number.isFinite(v))))
    return null;
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}
export function sample(g: Geometry, steps = 96): Vec3[] {
  if (g.kind === "text") return [g.position];
  const result: Vec3[] = [];
  for (const s of g.segments) {
    const n =
      s.kind === "line"
        ? 1
        : Math.max(4, Math.ceil((Math.abs(s.sweep) / (2 * Math.PI)) * steps));
    for (let i = 0; i < n; i++) result.push(evaluate(s, i / n));
  }
  if (g.segments.length) result.push(evaluate(g.segments.at(-1)!, 1));
  return result;
}
