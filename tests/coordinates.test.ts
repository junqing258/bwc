import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worker } from "../server/workers.ts";
import type { Artifact } from "../server/types.ts";

test("native OCS elevation, circle centre, nested nonzero base points and signed transforms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bwc-coordinates-")),
    path = join(dir, "transforms.dwg");
  try {
    await worker("cad", {
      mode: "fixture",
      fixtureMode: "transforms",
      output: path,
    });
    const a = await worker<Artifact>("cad", { mode: "parse", input: path });
    const array = a.occurrences.filter(
      (o) => o.instancePath.length === 1 && o.instancePath[0].arrayCell,
    );
    assert.equal(array.length, 12);
    assert.equal(new Set(array.map((o) => o.occurrenceKey)).size, 12);
    for (const o of array) {
      const cell = o.instancePath[0].arrayCell!,
        g = o.geometry as any;
      assert.ok(Math.abs(g.segments[0].start[0] - (10 - cell.row * 2)) < 1e-8);
      assert.ok(Math.abs(g.segments[0].start[1] - cell.column * 3) < 1e-8);
    }
    const poly = a.occurrences.find(
      (o) => o.layer === "OCS_REFERENCE" && o.entityType === "LWPOLYLINE",
    )!;
    const g = poly.geometry as any;
    const expected = [
      [0, 3, 4],
      [-6, 3, 4],
      [-6, -0.2, 6.4],
      [0, -0.2, 6.4],
    ];
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 3; j++)
        assert.ok(Math.abs(g.segments[i].start[j] - expected[i][j]) < 1e-8);
    const circle = a.occurrences.find(
      (o) => o.layer === "OCS_REFERENCE" && o.entityType === "CIRCLE",
    )!.geometry as any;
    for (const [j, n] of [-2, 0.6, 5.8].entries())
      assert.ok(Math.abs(circle.segments[0].center[j] - n) < 1e-8);
    const nested = a.occurrences.find((o) => o.instancePath.length === 2)!
      .geometry as any;
    // Inner base (1,2) -> insert (5,7); parent base (3,4), mirror X and scale Y=2 -> (18,36).
    assert.ok(Math.abs(nested.segments[0].start[0] - 18) < 1e-8);
    assert.ok(Math.abs(nested.segments[0].start[1] - 36) < 1e-8);
    assert.ok(Math.abs(nested.segments[0].end[0] - 18) < 1e-8);
    assert.ok(Math.abs(nested.segments[0].end[1] - 40) < 1e-8);
    const metric = await worker<any>("geometry", {
      occurrences: [{ ...poly, occurrenceId: "ocs" }],
      members: ["ocs"],
      quantityKind: "net_area",
      business: {},
      scale: 1,
    });
    assert.ok(Math.abs(metric.knownSubtotal - 24) < 1e-8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
