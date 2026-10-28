import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowService } from "../server/service.ts";
import type { Job, Operation, Selection } from "../server/types.ts";
import { id } from "../server/util.ts";
import { dwgExport, resultExport } from "../server/exports.ts";
import { toolRegistry } from "../server/tools.ts";
async function jobResult(service: WorkflowService, pid: string, job: Job) {
  let j = job;
  const end = Date.now() + 30000;
  while (["queued", "running"].includes(j.status) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 15));
    j = service.getJob({ projectId: pid, jobId: j.id });
  }
  assert.ok(
    ["succeeded", "partial"].includes(j.status),
    JSON.stringify(j.error),
  );
  return j.result;
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "bwc-integration-"));
  const service = new WorkflowService(root);
  await service.fixture();
  const p = service.create("controlled");
  const pid = p.projectId;
  await jobResult(
    service,
    pid,
    service.import({
      projectId: pid,
      fileRef: "controlled",
      operationId: id("op"),
    }),
  );
  return {
    service,
    pid,
    root,
    cleanup: () => {
      service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function ctx(service: WorkflowService, pid: string) {
  const s = service.catalog.open(pid),
    c = s.context();
  return {
    projectId: pid,
    workingRevision: c.revision.id,
    geometrySnapshotId: c.snapshot.id,
  };
}
async function select(service: WorkflowService, pid: string, layer: string) {
  return service.selection({
    ...ctx(service, pid),
    filter: { layers: [layer], space: "model" },
  });
}
async function change(
  service: WorkflowService,
  pid: string,
  operation: Operation,
  selection?: Selection,
  op = id("op"),
) {
  const c = ctx(service, pid);
  const scope = selection
    ? { selectionSet: { id: selection.id, version: 1 } }
    : {};
  const intent = service.recordIntent({ ...c, ...scope, operation });
  const proposed = await service.propose({
    projectId: pid,
    baseRevision: c.workingRevision,
    baseGeometrySnapshotId: c.geometrySnapshotId,
    ...scope,
    operation,
    intentId: intent.id,
    operationId: op,
  });
  return service.apply({
    projectId: pid,
    changeId: proposed.id,
    operationId: op,
    baseRevision: c.workingRevision,
    candidateFingerprint: proposed.candidateFingerprint,
  });
}
async function units(service: WorkflowService, pid: string, scale = 1) {
  return change(service, pid, {
    kind: "set_units",
    metresPerDrawingUnit: scale,
    evidence: "controlled 6m x 4m reference",
  });
}
async function baseline(service: WorkflowService, pid: string) {
  await units(service, pid);
  let slab = await select(service, pid, "受控楼板轮廓");
  await change(
    service,
    pid,
    {
      kind: "set_measurement_parameter",
      field: "uniform_thickness",
      value: 150,
      unit: "mm",
      unitBinding: "physical_quantity",
    },
    slab,
  );
  slab = await select(service, pid, "受控楼板轮廓");
  const holes = await select(service, pid, "受控洞口");
  await change(service, pid, { kind: "set_holes", holes: holes.members }, slab);
  return select(service, pid, "受控楼板轮廓");
}

test("one real DWG: 23m² / 3.45m³, immutable history, thickness and unit revision", async () => {
  const x = await setup();
  try {
    const { service: s, pid } = x;
    let slab = await baseline(s, pid);
    const r = await jobResult(
      s,
      pid,
      s.takeoff({
        ...ctx(s, pid),
        selectionSet: { id: slab.id, version: 1 },
        quantityKind: "parameter_volume",
        operationId: id("op"),
      }),
    );
    assert.ok(Math.abs(r.knownSubtotal - 3.45) < 1e-9);
    assert.ok(Math.abs(r.items[0].netArea - 23) < 1e-9);
    const old = ctx(s, pid);
    await units(s, pid, 0.001);
    assert.equal(s.catalog.open(pid).get("takeoff", r.id).validity, "stale");
    await assert.rejects(() =>
      s.selection({ ...ctx(s, pid), queryId: "missing" }),
    );
    assert.throws(
      () =>
        s.takeoff({
          ...ctx(s, pid),
          selectionSet: { id: slab.id, version: 1 },
          quantityKind: "net_area",
          operationId: id("op"),
        }),
      /过期/,
    );
    slab = await select(s, pid, "受控楼板轮廓");
    const scaled = await jobResult(
      s,
      pid,
      s.takeoff({
        ...ctx(s, pid),
        selectionSet: { id: slab.id, version: 1 },
        quantityKind: "parameter_volume",
        operationId: id("op"),
      }),
    );
    assert.ok(Math.abs(scaled.knownSubtotal - 3.45e-6) < 1e-14);
    assert.equal(s.preview(old).units.metresPerDrawingUnit, 1);
    await units(s, pid, 1);
    slab = await select(s, pid, "受控楼板轮廓");
    await change(
      s,
      pid,
      {
        kind: "set_measurement_parameter",
        field: "uniform_thickness",
        value: 200,
        unit: "mm",
        unitBinding: "physical_quantity",
      },
      slab,
    );
    slab = await select(s, pid, "受控楼板轮廓");
    const updated = await jobResult(
      s,
      pid,
      s.takeoff({
        ...ctx(s, pid),
        selectionSet: { id: slab.id, version: 1 },
        quantityKind: "parameter_volume",
        operationId: id("op"),
      }),
    );
    assert.ok(Math.abs(updated.knownSubtotal - 4.6) < 1e-9);
  } finally {
    x.cleanup();
  }
});

test("native move updates query, preview and measurement from same snapshot; undo preserves identity", async () => {
  const x = await setup();
  try {
    const { service: s, pid } = x;
    await units(s, pid);
    const slab = await select(s, pid, "受控楼板轮廓");
    const before = s.get({ ...ctx(s, pid), occurrenceId: slab.members[0] });
    const applied = await change(
      s,
      pid,
      {
        kind: "move_entities",
        delta: [100, 0, 0],
        coordinateSystem: "drawing_wcs",
        unit: "mm",
        scope: "entity",
      },
      slab,
    );
    const after = s.get({ ...ctx(s, pid), occurrenceId: slab.members[0] });
    assert.equal(after.entityId, before.entityId);
    assert.ok(
      Math.abs(
        (after.geometry as any).segments[0].start[0] -
          (before.geometry as any).segments[0].start[0] -
          0.1,
      ) < 1e-9,
    );
    const outside = await s.query({
      ...ctx(s, pid),
      filter: {
        rectangle: [-0.01, -0.01, 0.01, 4.01],
        layers: ["受控楼板轮廓"],
      },
    });
    assert.equal(outside.total, 0);
    const undo = s.revert({
      projectId: pid,
      changeId: applied.id,
      operationId: id("undo"),
    });
    assert.notEqual(undo.id, applied.workingRevision);
    assert.deepEqual(
      s.get({ ...ctx(s, pid), occurrenceId: slab.members[0] }).geometry,
      before.geometry,
    );
  } finally {
    x.cleanup();
  }
});

test("revision CAS, preview fingerprints, operation idempotency and forged intent rejection", async () => {
  const x = await setup();
  try {
    const { service: s, pid } = x;
    await units(s, pid);
    const slab = await select(s, pid, "受控楼板轮廓"),
      c = ctx(s, pid),
      scope = { selectionSet: { id: slab.id, version: 1 } },
      operation: Operation = {
        kind: "set_measurement_parameter",
        field: "uniform_thickness",
        value: 150,
        unit: "mm",
        unitBinding: "physical_quantity",
      };
    const intent = s.recordIntent({ ...c, ...scope, operation });
    const input = {
      projectId: pid,
      baseRevision: c.workingRevision,
      baseGeometrySnapshotId: c.geometrySnapshotId,
      ...scope,
      operation,
      intentId: intent.id,
      operationId: id("op"),
    };
    const proposal = await s.propose(input);
    assert.deepEqual(await s.propose(input), proposal);
    await assert.rejects(
      () =>
        s.propose({
          ...input,
          operationId: id("op"),
          operation: { ...operation, value: 999 },
        }),
      /不一致/,
    );
    await units(s, pid, 0.001);
    const pointer = ctx(s, pid);
    assert.throws(
      () =>
        s.apply({
          projectId: pid,
          changeId: proposal.id,
          baseRevision: c.workingRevision,
          operationId: input.operationId,
          candidateFingerprint: proposal.candidateFingerprint,
        }),
      /变化/,
    );
    assert.deepEqual(ctx(s, pid), pointer);
    const target = await select(s, pid, "受控楼板轮廓");
    const a = await change(s, pid, operation, target);
    const count = s.catalog.open(pid).all("revision").length;
    const repeated = s.apply({
      projectId: pid,
      changeId: a.id,
      operationId: a.operationId,
      baseRevision: a.baseRevision,
      candidateFingerprint: a.candidateFingerprint,
    });
    assert.equal(repeated.appliedRevision, a.workingRevision);
    assert.equal(s.catalog.open(pid).all("revision").length, count);
  } finally {
    x.cleanup();
  }
});

test("MINSERT row/column identities include base point, rotation, mirror and unscaled spacing", async () => {
  const x = await setup();
  try {
    const a = x.service.preview(ctx(x.service, x.pid));
    const array = a.occurrences.filter((o) =>
      o.instancePath.some((p) => p.arrayCell),
    );
    assert.equal(array.length, 6);
    assert.equal(new Set(array.map((o) => o.occurrenceId)).size, 6);
    for (const o of array) {
      const cell = o.instancePath[0].arrayCell!,
        g = o.geometry as any;
      assert.ok(Math.abs(g.segments[0].start[0] - (10 - cell.row * 2)) < 1e-9);
      assert.ok(Math.abs(g.segments[0].start[1] - cell.column * 3) < 1e-9);
      assert.ok(Math.abs(g.segments[0].end[1] - (cell.column * 3 - 2)) < 1e-9);
      assert.ok(o.instancePath[0].insertEntityId);
    }
    await units(x.service, x.pid);
    const sel = await x.service.selection({
      ...ctx(x.service, x.pid),
      members: [array[0].occurrenceId],
    });
    await assert.rejects(
      () =>
        change(
          x.service,
          x.pid,
          {
            kind: "move_entities",
            delta: [1, 0, 0],
            unit: "m",
            coordinateSystem: "drawing_wcs",
            scope: "entity",
          },
          sel,
        ),
      /阵列成员/,
    );
  } finally {
    x.cleanup();
  }
});

test("frozen pagination, controlled schemas, missing values, project separation and restart persistence", async () => {
  const x = await setup();
  let closed = false;
  try {
    const { service: s, pid } = x;
    const q = await s.query({
      ...ctx(s, pid),
      filter: { space: "model" },
      pageSize: 2,
    });
    const frozen = await s.selection({ ...ctx(s, pid), queryId: q.queryId });
    assert.equal(frozen.members.length, q.total);
    assert.ok(q.total > 2);
    const p2 = s.create("other");
    assert.throws(() => s.catalog.open(p2.projectId).context(), /导入/);
    const registry = toolRegistry(s);
    assert.throws(() =>
      registry.dwg_query.schema.parse({
        projectId: pid,
        filter: { sql: "DROP TABLE" },
      }),
    );
    await units(s, pid);
    const second = await s.query({
      projectId: pid,
      cursor: q.cursor,
      pageSize: 2,
    });
    assert.equal(second.geometrySnapshotId, q.geometrySnapshotId);
    const sel = await select(s, pid, "受控楼板轮廓");
    const r = await jobResult(
      s,
      pid,
      s.takeoff({
        ...ctx(s, pid),
        selectionSet: { id: sel.id, version: 1 },
        quantityKind: "parameter_volume",
        operationId: id("op"),
      }),
    );
    assert.equal(r.completeTotal, null);
    assert.equal(r.items[0].value, null);
    const current = ctx(s, pid);
    s.close();
    closed = true;
    const restored = new WorkflowService(x.root);
    try {
      assert.deepEqual(ctx(restored, pid), current);
      assert.equal(
        restored.catalog.open(pid).get("takeoff", r.id).items[0].value,
        null,
      );
      assert.equal(restored.catalog.open(pid).all("selection").length, 2);
    } finally {
      restored.close();
    }
  } finally {
    if (!closed) x.service.close();
    rmSync(x.root, { recursive: true, force: true });
  }
});

test("candidate DWG roundtrip and source/report export keep delivery gates explicit", async () => {
  const x = await setup();
  try {
    const { service: s, pid } = x;
    await units(s, pid);
    const a = await jobResult(
      s,
      pid,
      dwgExport(s, {
        ...ctx(s, pid),
        mode: "candidate",
        operationId: id("op"),
      }),
    );
    assert.equal(a.completeDelivery, false);
    assert.equal(a.contentRoundtrip.stateEqual, true);
    assert.equal(a.independentCad, "not_run");
    assert.throws(
      () =>
        dwgExport(s, {
          ...ctx(s, pid),
          mode: "complete",
          operationId: id("op"),
        }),
      /独立 CAD/,
    );
    const r = await jobResult(
      s,
      pid,
      resultExport(s, { ...ctx(s, pid), operationId: id("op") }),
    );
    const report = JSON.parse(
      readFileSync(
        join(s.catalog.open(pid).path, r.path, "report.json"),
        "utf8",
      ),
    );
    assert.equal(report.completeDelivery, false);
    assert.equal(r.mainDrawing.edited, false);
  } finally {
    x.cleanup();
  }
});

test("layer changes and adopted DWG unit metadata survive native candidate export; custom scales are refused", async () => {
  const x = await setup();
  try {
    const { service: s, pid } = x;
    await units(s, pid);
    const slab = await select(s, pid, "受控楼板轮廓");
    await change(
      s,
      pid,
      { kind: "set_layer", value: "REVIEWED_SLAB", scope: "entity" },
      slab,
    );
    assert.equal(
      (await s.query({ ...ctx(s, pid), filter: { layers: ["受控楼板轮廓"] } }))
        .total,
      0,
    );
    assert.equal(
      (await s.query({ ...ctx(s, pid), filter: { layers: ["REVIEWED_SLAB"] } }))
        .total,
      1,
    );
    await units(s, pid, 0.001);
    const out = await jobResult(
      s,
      pid,
      dwgExport(s, {
        ...ctx(s, pid),
        mode: "candidate",
        operationId: id("op"),
      }),
    );
    assert.equal(out.mainDrawing.insUnits, 4);
    assert.equal(out.contentRoundtrip.stateEqual, true);
    await units(s, pid, 0.0037);
    assert.throws(
      () =>
        dwgExport(s, {
          ...ctx(s, pid),
          mode: "candidate",
          operationId: id("op"),
        }),
      /不能直接表达/,
    );
  } finally {
    x.cleanup();
  }
});

test("tampered snapshot manifests and immutable source files are detected before native evaluation", async () => {
  const x = await setup();
  try {
    const { service: s, pid } = x;
    await units(s, pid);
    const store = s.catalog.open(pid),
      original = store.context().snapshot;
    store.put("snapshot", {
      ...original,
      business: { invalid: { material: "tampered" } },
    });
    assert.throws(() => s.summary({ projectId: pid }), /清单指纹/);
    store.put("snapshot", original);
    const slab = await select(s, pid, "受控楼板轮廓"),
      drawing = store.get("drawing", original.drawingVersion);
    writeFileSync(join(store.path, drawing.path), "corrupted source");
    await assert.rejects(
      () =>
        change(
          s,
          pid,
          {
            kind: "move_entities",
            delta: [1, 0, 0],
            unit: "m",
            coordinateSystem: "drawing_wcs",
            scope: "entity",
          },
          slab,
        ),
      /指纹不匹配/,
    );
    assert.equal(store.current().geometrySnapshotId, original.id);
  } finally {
    x.cleanup();
  }
});
