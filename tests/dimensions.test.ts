import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worker } from "../apps/server/workers.ts";
import { primitives } from "../apps/server/geometry.ts";
import type { Artifact } from "../apps/server/types.ts";

test("cached dimension clone displacement precedes parent transforms without mutating shared pictures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bwc-dimensions-"));
  const path = join(dir, "dimensions.dwg");
  const near = (actual: number[], expected: number[]) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, i) =>
      assert.ok(
        Math.abs(value - expected[i]) < 1e-8,
        `${actual} != ${expected}`,
      ),
    );
  };
  try {
    await worker("cad", {
      mode: "fixture",
      fixtureMode: "dimensions",
      output: path,
    });
    const a = await worker<Artifact>("cad", { mode: "parse", input: path });
    const dim = (layer: string) =>
      a.occurrences.find((o) => o.layer === layer)!;
    const cases = [
      {
        layer: "DIM_TRANSLATED",
        start: [20, 0, -650],
        end: [26, 0, -650],
        text: [23, 1, -650],
        arrow: [20, -4, -650],
      },
      {
        layer: "DIM_ORIGINAL",
        start: [100020, -2500, 0],
        end: [100026, -2500, 0],
        text: [100023, -2499, 0],
        arrow: [100020, -2504, 0],
      },
      {
        layer: "DIM_NESTED",
        start: [160, 180, -1293],
        end: [160, 168, -1293],
        text: [157, 174, -1293],
        arrow: [172, 180, -1293],
      },
    ];
    for (const c of cases) {
      const o = dim(c.layer);
      assert.equal(o.geometry?.kind, "annotation", c.layer);
      assert.equal((o.geometry as any).quantityRole, "annotation_only");
      const children = primitives(o.geometry);
      const paths = children.filter((g) => g.kind === "path");
      assert.equal(paths.length, 2);
      const line = paths[0].segments[0],
        arrow = paths[1].segments[0];
      assert.equal(line.kind, "line");
      assert.equal(arrow.kind, "line");
      if (line.kind !== "line" || arrow.kind !== "line")
        throw new Error("Expected lines");
      near(line.start, c.start);
      near(line.end, c.end);
      near(arrow.start, c.start);
      near(arrow.end, c.arrow);
      const text = children.find((g) => g.kind === "text")!;
      assert.equal(text.kind, "text");
      if (text.kind !== "text") throw new Error("Expected text");
      assert.equal(text.text, "CACHE 6");
      near(text.position, c.text);
      o.occurrenceId = c.layer;
    }
    assert.equal(
      a.occurrences.filter((o) => o.entityType === "DIMENSION" && !o.geometry)
        .length,
      2,
    );
    for (const layer of ["DIM_TILTED", "DIM_BASEPOINT"]) {
      assert.equal(dim(layer).geometry, null);
      assert.ok(
        a.diagnostics.some(
          (d) =>
            d.handle === dim(layer).sourceHandle &&
            d.reason === "DIMENSION_PICTURE_COORDINATES_UNVERIFIED",
        ),
      );
    }
    for (const quantityKind of ["length", "net_area", "parameter_volume"]) {
      const result = await worker<any>("geometry", {
        occurrences: cases.map((c) => dim(c.layer)),
        scale: 1,
        quantityKind,
      });
      assert.equal(result.items.length, 3);
      for (const item of result.items) {
        assert.equal(item.reason, "ANNOTATION_NOT_MEASURABLE");
        assert.equal(item.value, null);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
