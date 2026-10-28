import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worker } from "../apps/server/workers.ts";
import { bounds, primitives } from "../apps/server/geometry.ts";
import type { Artifact } from "../apps/server/types.ts";

test("native hatch loops, OCS, CW arcs, ellipse, bulges, solid order and cached dimensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bwc-coverage-")),
    path = join(dir, "coverage.dwg");
  try {
    await worker("cad", {
      mode: "fixture",
      fixtureMode: "coverage",
      output: path,
    });
    const a = await worker<Artifact>("cad", { mode: "parse", input: path });
    a.occurrences.forEach((o, i) => (o.occurrenceId = String(i)));
    const objects = a.occurrences.filter((o) => o.layer === "COVERAGE");
    const hatches = objects.filter((o) => o.entityType === "HATCH");
    assert.equal(hatches.length, 5);
    const result = await worker<any>("geometry", {
      occurrences: a.occurrences,
      members: hatches.map((o) => o.occurrenceId),
      scale: 1,
      quantityKind: "net_area",
    });
    assert.ok(result.complete, JSON.stringify(result.items));
    const expected = [23, 23, Math.PI - 2, 4.5 * Math.PI, Math.PI];
    result.items.forEach((r: any, i: number) =>
      assert.ok(Math.abs(r.value - expected[i]) < 1e-8, JSON.stringify(r)),
    );
    assert.equal(result.items[0].nativeHoleDeductionArea, 1);
    assert.deepEqual(
      bounds(hatches[1].geometry),
      [-6, -0.20000000000000018, 0, 3],
    );
    const solid = objects.find((o) => o.entityType === "SOLID")!;
    const face = objects.find((o) => o.entityType === "3DFACE")!;
    const regions = await worker<any>("geometry", {
      occurrences: [solid, face],
      scale: 1,
      quantityKind: "net_area",
    });
    assert.ok(regions.complete, JSON.stringify(regions));
    regions.items.forEach((r: any, i: number) =>
      assert.ok(Math.abs(r.value - [24, 4][i]) < 1e-9),
    );
    const dim = objects.find((o) => o.entityType === "DIMENSION")!;
    assert.equal(dim.geometry?.kind, "annotation");
    const children = primitives(dim.geometry);
    assert.ok(
      children.some((g) => g.kind === "text" && g.text === "OVERRIDE 999"),
    );
    assert.equal(
      children.filter((g) => g.kind === "path").length,
      2,
      "nested arrow is displayed under the dimension parent",
    );
    const dimLength = await worker<any>("geometry", {
      occurrences: [dim],
      scale: 1,
      quantityKind: "length",
    });
    assert.equal(dimLength.items[0].reason, "ANNOTATION_NOT_MEASURABLE");
    assert.equal(dimLength.items[0].value, null);
    const point = objects.find((o) => o.entityType === "POINT")!;
    assert.deepEqual(bounds(point.geometry), [30, 40, 30, 40]);
    const missing = objects.filter((o) => !o.geometry);
    assert.equal(missing.length, 1);
    assert.ok(
      a.diagnostics.some(
        (d) =>
          d.handle === missing[0].sourceHandle &&
          d.reason?.startsWith("DEGENERATE_BULGE"),
      ),
    );
    const raw = a.sources.find(
      (s) => s.handle === missing[0].sourceHandle,
    ) as any;
    assert.deepEqual(
      raw.nativePolyline.vertices.map((v: any) => v.bulge),
      [1, 1],
    );
    const hits = await worker<any>("geometry", {
      mode: "spatial",
      occurrences: objects,
      rectangle: [22.9, 0.9, 23.1, 1.1],
    });
    assert.ok(
      hits.members.includes(dim.occurrenceId),
      "cached text picks the dimension identity",
    );
    const inHole = await worker<any>("geometry", {
      mode: "spatial",
      occurrences: [hatches[0]],
      rectangle: [1.2, 1.2, 1.8, 1.8],
    });
    assert.deepEqual(
      inHole.members,
      [],
      "hatch holes remain empty for region selection",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
