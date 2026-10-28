import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, compactPayload } from "../apps/server/main.ts";
import { WorkflowService } from "../apps/server/service.ts";
import {
  componentGeometry,
  recognizeComponents,
  suggestComponent,
  reviewComponent,
  listComponents,
  componentTakeoff,
  type DrawingComponent,
} from "../apps/server/components.ts";
import { toolRegistry } from "../apps/server/tools.ts";
import { id } from "../apps/server/util.ts";
import type { Occurrence } from "../apps/server/types.ts";

const line = (key: string, a: number[], b: number[]): Occurrence => ({
  occurrenceId: key,
  entityId: key,
  sourceHandle: key,
  entityType: "LINE",
  layer: "WALL",
  space: "model",
  instancePath: [],
  occurrenceKey: key,
  geometry: {
    kind: "path",
    closed: false,
    segments: [{ kind: "line", start: a as any, end: b as any }],
  },
  matrix: [],
  visible: true,
  color: "#000000",
});
async function wait(service: WorkflowService, pid: string, job: any) {
  const end = Date.now() + 30000;
  while (["queued", "running"].includes(job.status) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 15));
    job = service.getJob({ projectId: pid, jobId: job.id });
  }
  assert.ok(["succeeded", "partial"].includes(job.status), JSON.stringify(job));
  return job.result;
}
function seed(service: WorkflowService) {
  const pid = service.create("component test").projectId;
  const s = service.catalog.open(pid);
  const rows = [
    line("a", [0, 0, 0], [6, 0, 0]),
    line("b", [6, 4, 0], [6, 0, 0]),
    line("c", [6, 4, 0], [0, 4, 0]),
    line("d", [0, 0, 0], [0, 4, 0]),
    line("axis", [10, 0, 0], [20, 0, 0]),
  ];
  rows[4].layer = "AXIS";
  const square: Occurrence = {
    ...line("column", [20, 0, 0], [21, 0, 0]),
    layer: "COLUMN",
    entityType: "LWPOLYLINE",
    geometry: {
      kind: "path",
      closed: true,
      segments: [
        { kind: "line", start: [20, 0, 0], end: [21, 0, 0] },
        { kind: "line", start: [21, 0, 0], end: [21, 1, 0] },
        { kind: "line", start: [21, 1, 0], end: [20, 1, 0] },
        { kind: "line", start: [20, 1, 0], end: [20, 0, 0] },
      ],
    },
  };
  rows.push(square);
  const artifact: any = {
    schemaVersion: 1,
    coordinateContractVersion: "test",
    parser: "fixture",
    parserVersion: "1",
    dwgVersion: "AC1032",
    insUnits: 6,
    sourceEntityCount: rows.length,
    sourceRecordCount: rows.length,
    sources: rows.map((o) => ({
      handle: o.sourceHandle,
      type: o.entityType,
      owner: "*Model_Space",
      layer: o.layer,
      geometry: o.geometry,
    })),
    occurrences: rows,
    layers: [],
    blocks: [],
    dependencies: [],
    diagnostics: [],
    notifications: [],
    stateFingerprint: "test",
    importCompleteness: "complete",
    displayLimitations: [],
    readSeconds: 0,
    peakWorkingSetBytes: 0,
  };
  return { pid, s, rows, artifact };
}
// Fixtures write immutable geometry artifacts through the same manifest path as imports.
import { atomicJson, hash } from "../apps/server/util.ts";
import { readFileSync } from "node:fs";
function publishFixture(service: WorkflowService, extra: Occurrence[] = []) {
  const x = seed(service);
  x.rows.push(...extra);
  x.artifact.sources.push(
    ...extra.map((o) => ({
      handle: o.sourceHandle,
      type: o.entityType,
      owner: "WINDOW_BLOCK",
      layer: o.layer,
      geometry: o.geometry,
    })),
  );
  const path = join(x.s.path, "artifacts/test/geometry.json");
  atomicJson(path, x.artifact);
  const snapshot = x.s.saveSnapshot(
    {
      drawingVersion: "dv_test",
      parseArtifactVersion: "pa_test",
      coordinateContractVersion: "test",
      artifactPath: "artifacts/test/geometry.json",
      artifactSha256: hash(readFileSync(path)),
      patches: [],
      units: {
        id: "up_test",
        confirmed: true,
        metresPerDrawingUnit: 1,
        sourceInsUnits: 6,
        evidence: "known fixture metres",
      },
      business: {},
      importCompleteness: "complete",
    },
    x.artifact,
  );
  service.publish(x.s, null, snapshot, "test_seed", () =>
    x.s.put("drawing", { id: "dv_test", role: "original" }),
  );
  const ctx = () => ({
    projectId: x.pid,
    workingRevision: x.s.current().id,
    geometrySnapshotId: x.s.current().geometrySnapshotId,
  });
  return { ...x, ctx };
}
const review = (ctx: any, c: DrawingComponent, patch: any = {}) => ({
  ...ctx,
  componentId: c.id,
  expectedVersion: c.version,
  status: "confirmed",
  category: c.category === "未分类" ? "其他" : c.category,
  label: c.label,
  floor: "二层",
  material: "C30",
  thicknessMm: 150,
  evidence: "人工核对实际来源",
  ...patch,
});

test("recognition joins exact cycles, excludes axis data and leaves evidence as unconfirmed candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-component-rule-"));
  const service = new WorkflowService(root);
  try {
    const { ctx } = publishFixture(service);
    const r = recognizeComponents(service, ctx());
    assert.equal(r.generated, 2);
    assert.equal(r.counts.confirmed, 0);
    const wall = r.items.find((c) => c.category === "墙")!;
    assert.deepEqual(wall.members, ["a", "b", "c", "d"]);
    assert.equal(wall.geometryRole, "closed_boundary");
    assert.equal(wall.status, "pending");
    const again = recognizeComponents(service, ctx());
    assert.equal(again.items.length, 2);
    assert.deepEqual(
      again.items.map((c) => c.id),
      r.items.map((c) => c.id),
    );
    assert.throws(
      () =>
        componentTakeoff(service, {
          ...ctx(),
          componentIds: [wall.id],
          quantityKind: "net_area",
          operationId: id("op"),
        }),
      /已确认构件/,
    );
    assert.throws(
      () =>
        suggestComponent(service, {
          ...ctx(),
          members: ["axis", "bogus"],
          category: "墙",
          label: "虚构",
          reason: "AI",
        }),
      /实际|有效曲线/,
    );
    assert.throws(() =>
      toolRegistry(service).component_suggest.schema.parse({
        ...ctx(),
        members: ["a"],
        category: "墙",
        label: "x",
        reason: "AI",
        geometry: { kind: "point" },
      }),
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed components measure once, audit edits, invalidate results and persist across restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-component-flow-"));
  let service = new WorkflowService(root);
  try {
    const { ctx, pid, s } = publishFixture(service);
    const frozen = ctx();
    const wall = recognizeComponents(service, frozen).items.find(
      (c) => c.category === "墙",
    )!;
    const c = reviewComponent(service, review(frozen, wall));
    assert.equal(c.status, "confirmed");
    assert.equal(s.all("component_review").length, 1);
    const duplicate = suggestComponent(service, {
      ...frozen,
      members: ["a"],
      category: "梁",
      label: "梁",
      reason: "AI 建议",
    });
    assert.throws(
      () => reviewComponent(service, review(frozen, duplicate)),
      /重复计量/,
    );
    assert.throws(
      () => reviewComponent(service, review(frozen, wall)),
      /候选已被更新/,
    );
    const result = await wait(
      service,
      pid,
      componentTakeoff(service, {
        ...frozen,
        componentIds: [c.id],
        quantityKind: "net_area",
        operationId: id("op"),
      }),
    );
    assert.equal(result.completeTotal, 24);
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].sourceOccurrenceIds, ["a", "b", "c", "d"]);
    const volume = await wait(
      service,
      pid,
      componentTakeoff(service, {
        ...frozen,
        componentIds: [c.id],
        quantityKind: "parameter_volume",
        operationId: id("op"),
      }),
    );
    assert.ok(Math.abs(volume.completeTotal - 3.6) < 1e-9);
    const revised = reviewComponent(
      service,
      review(frozen, c, { thicknessMm: 200 }),
    );
    assert.equal(s.get("takeoff", result.id).validity, "stale");
    assert.equal(
      service.open(pid).results.find((r) => r.id === result.id)!.validity,
      "stale",
    );
    assert.equal(s.all("component_review").length, 2);
    const reply = suggestComponent(service, {
      ...frozen,
      members: c.members,
      category: "板",
      label: "AI改名",
      reason: "猜测",
    });
    assert.equal(reply.version, revised.version);
    assert.equal(
      reply.label,
      revised.label,
      "AI must never change confirmed records",
    );
    service.close();
    service = new WorkflowService(root);
    assert.equal(
      listComponents(service, frozen).items.find((x) => x.id === c.id)!.version,
      revised.version,
    );
    const store = service.catalog.open(pid);
    const old = store.context().snapshot;
    service.publish(
      store,
      store.current().id,
      { ...old, id: old.id },
      id("op"),
    );
    assert.throws(
      () => reviewComponent(service, review(frozen, revised)),
      /版本已变化/,
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("separate boundaries, gapped paths and annotation sources never acquire invented component areas", async () => {
  const g = componentGeometry([
    line("a", [0, 0, 0], [1, 0, 0]),
    line("b", [1.01, 0, 0], [1, 1, 0]),
    line("c", [1, 1, 0], [0, 0, 0]),
  ]);
  assert.equal(g.geometryRole, "symbol_group");
  assert.equal(g.geometry?.kind, "annotation");
  const root = mkdtempSync(join(tmpdir(), "bwc-component-symbol-"));
  const service = new WorkflowService(root);
  try {
    const { ctx, pid } = publishFixture(service);
    const ai = suggestComponent(service, {
      ...ctx(),
      members: ["a", "c"],
      category: "窗",
      label: "窗-建议",
      reason: "实际来源组成的窗符号",
    });
    assert.equal(ai.geometryRole, "symbol_group");
    assert.equal(ai.origin, "ai");
    assert.equal(ai.status, "pending");
    const checked = reviewComponent(service, review(ctx(), ai));
    const area = await wait(
      service,
      pid,
      componentTakeoff(service, {
        ...ctx(),
        componentIds: [checked.id],
        quantityKind: "net_area",
        operationId: id("op"),
      }),
    );
    assert.equal(area.completeTotal, null);
    assert.equal(area.items[0].reason, "ANNOTATION_NOT_MEASURABLE");
    const count = await wait(
      service,
      pid,
      componentTakeoff(service, {
        ...ctx(),
        componentIds: [checked.id],
        quantityKind: "business_count",
        operationId: id("op"),
      }),
    );
    assert.equal(count.completeTotal, 1);
    const compact = compactPayload(ai, "summary");
    assert.deepEqual(compact.geometry, { omittedByDataPolicy: true });
    assert.deepEqual(compact.bounds, { omittedByDataPolicy: true });
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AI can submit frozen-context suggestions but has no tool for human confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-component-api-"));
  const app = createApplication({ dataDir: root, port: 0 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  app.bridge.dispatch = async () => {};
  try {
    const { ctx, pid, s } = publishFixture(app.service);
    const session = app.bridge.create({ projectId: pid });
    const sel = await app.service.selection({
      ...ctx(),
      members: ["a"],
      evidence: "user selection",
    });
    const turn = app.bridge.submit({
      projectId: pid,
      sessionId: session.id,
      clientMessageId: id("msg"),
      text: "请辅助识别选中构件，标识后由我确认",
      context: {
        ...ctx(),
        selectionSet: { id: sel.id, version: 1 },
        dataPolicyVersion: s.meta().dataPolicy.id,
      },
    });
    s.put("turn", { ...turn, status: "running" });
    const url = `http://127.0.0.1:${(app.server.address() as any).port}/api/mcp`;
    const request = async (tool: string, input: any) => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${app.token}`,
        },
        body: JSON.stringify({
          tool,
          input,
          projectId: pid,
          sessionId: session.id,
        }),
      });
      return { status: r.status, data: await r.json() };
    };
    const suggestion = {
      ...ctx(),
      members: ["a"],
      category: "墙",
      label: "墙-AI建议",
      reason: "用户选中的真实墙线",
    };
    const yes = await request("component_suggest", suggestion);
    assert.equal(yes.status, 200);
    assert.equal(yes.data.status, "pending");
    const beyond = await request("component_suggest", {
      ...suggestion,
      members: ["b"],
    });
    assert.equal(beyond.data.error.code, "INVALID_COMPONENT_SCOPE");
    const forged = await request("component_suggest", {
      ...suggestion,
      geometrySnapshotId: "gs_forged",
    });
    assert.equal(forged.data.error.code, "SNAPSHOT_MISMATCH");
    const confirm = await request("component_review", {
      ...ctx(),
      componentId: yes.data.id,
      status: "confirmed",
    });
    assert.equal(confirm.data.error.code, "UNKNOWN_TOOL");
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("window groups retain layer-zero members and separate instances of the same source handles", () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-component-instances-"));
  const service = new WorkflowService(root);
  try {
    const extra: Occurrence[] = [];
    for (let cell = 0; cell < 2; cell++) {
      const path = [
        { insertHandle: "same_insert", arrayCell: { row: cell, column: 0 } },
      ];
      extra.push({
        ...line(`win_${cell}_a`, [40, cell * 5, 0], [42, cell * 5, 0]),
        sourceHandle: "shared_a",
        layer: "WINDOW",
        instancePath: path,
      });
      extra.push({
        ...line(`win_${cell}_b`, [40, cell * 5 + 1, 0], [42, cell * 5 + 1, 0]),
        sourceHandle: "shared_b",
        layer: "0",
        instancePath: path,
      });
    }
    const { ctx } = publishFixture(service, extra);
    const windows = recognizeComponents(service, ctx()).items.filter(
      (c) => c.category === "窗",
    );
    assert.equal(windows.length, 2);
    assert.deepEqual(windows[0].members, ["win_0_a", "win_0_b"]);
    assert.deepEqual(windows[1].members, ["win_1_a", "win_1_b"]);
    assert.notEqual(windows[0].id, windows[1].id);
    assert.equal(windows[0].geometryRole, "symbol_group");
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
