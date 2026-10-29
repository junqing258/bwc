import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDomain } from "../apps/server/workspace-domain.ts";
import { atomicJson, hash, id } from "../apps/server/util.ts";
import type { Artifact, Occurrence } from "../apps/server/types.ts";
import type { ScopeCoverage } from "../apps/server/coverage.ts";

function seed(
  domain: WorkspaceDomain,
  name = "一层",
  gap = false,
  duplicate = false,
) {
  const drawingId = domain.catalog.create(name).projectId,
    store = domain.catalog.open(drawingId),
    dv = id("dv");
  const square = (oid: string, x: number): Occurrence => ({
    occurrenceId: oid,
    entityId: oid,
    sourceHandle: oid,
    entityType: "LWPOLYLINE",
    layer: "SLAB",
    space: "model",
    instancePath: [],
    occurrenceKey: oid,
    matrix: [],
    visible: true,
    color: "#000",
    geometry: {
      kind: "path",
      closed: true,
      segments: [
        { kind: "line", start: [x, 0, 0], end: [x + 1, 0, 0] },
        { kind: "line", start: [x + 1, 0, 0], end: [x + 1, 1, 0] },
        { kind: "line", start: [x + 1, 1, 0], end: [x, 1, 0] },
        { kind: "line", start: [x, 1, 0], end: [x, 0, 0] },
      ],
    },
  });
  const a = square(`${drawingId}_a`, 0),
    b = square(`${drawingId}_b`, duplicate ? 0 : 2),
    note: Occurrence = {
      ...square(`${drawingId}_note`, 4),
      entityType: "TEXT",
      layer: "TEXT",
      geometry: {
        kind: "text",
        text: "test",
        position: [4, 0, 0],
        height: 1,
        rotation: 0,
        formatting: "plain",
      },
    };
  const artifact: Artifact = {
    schemaVersion: 1,
    coordinateContractVersion: "test",
    parser: "fixture",
    parserVersion: "1",
    dwgVersion: "AC1032",
    insUnits: 6,
    sourceEntityCount: 3,
    sourceRecordCount: 3,
    sources: [a, b, note].map((o) => ({
      handle: o.sourceHandle,
      type: o.entityType,
      owner: "model",
      layer: o.layer,
      geometry: o.geometry,
    })),
    occurrences: [a, b, note],
    layers: [],
    blocks: [],
    dependencies: [],
    diagnostics: gap
      ? [
          {
            code: "UNSUPPORTED",
            handle: "unlocated_source",
            reason: "No source position",
          },
        ]
      : [],
    notifications: [],
    stateFingerprint: "fixture",
    importCompleteness: gap ? "partial" : "complete",
    displayLimitations: [],
    readSeconds: 0,
    peakWorkingSetBytes: 0,
  };
  const artifactPath = `artifacts/${dv}/geometry.json`;
  atomicJson(join(store.path, artifactPath), artifact);
  const sourcePath = `sources/${dv}/source.dwg`;
  mkdirSync(join(store.path, "sources", dv), { recursive: true });
  writeFileSync(join(store.path, sourcePath), "AC1032controlled-test-source");
  const snapshot = store.saveSnapshot(
    {
      drawingVersion: dv,
      parseArtifactVersion: dv,
      coordinateContractVersion: "test",
      artifactPath,
      artifactSha256: hash(JSON.stringify(artifact)),
      patches: [],
      units: {
        id: id("units"),
        confirmed: true,
        metresPerDrawingUnit: 1,
        sourceInsUnits: 6,
        evidence: "Known metres fixture",
      },
      business: {},
      importCompleteness: artifact.importCompleteness,
    },
    artifact,
  );
  const revision = domain.service.publish(store, null, snapshot, "seed", () =>
    store.put("drawing", {
      id: dv,
      name,
      path: sourcePath,
      sha256: hash("AC1032controlled-test-source"),
      role: "original",
      format: "AC1032",
    }),
  );
  return { drawingId, store, a, b, note, snapshot, revision, floor: name };
}
async function candidate(
  domain: WorkspaceDomain,
  drawing: ReturnType<typeof seed>,
  member: string,
) {
  const c = await domain.call("component_suggest", {
    workspaceId: domain.catalog.manifest.workspaceId,
    drawingId: drawing.drawingId,
    members: [member],
    category: "板",
    label: member,
    reason: "controlled fixture reference",
  });
  assert.ok(!c.error, JSON.stringify(c));
  return c;
}
async function confirm(
  domain: WorkspaceDomain,
  drawing: ReturnType<typeof seed>,
  component: any,
) {
  const session = domain.reviews.open(drawing.drawingId);
  await domain.reviews.submit(session.token, {
    fingerprint: session.batch.fingerprint,
    reviews: [
      {
        componentId: component.id,
        expectedVersion: component.version,
        status: "confirmed",
        category: "板",
        label: component.label,
        floor: drawing.floor,
        material: "混凝土",
        thicknessMm: 150,
        evidence: "人工逐项对照受控参考清单",
      },
    ],
  });
}
function prepare(
  domain: WorkspaceDomain,
  drawings: ReturnType<typeof seed>[],
  floors = true,
) {
  const manifest = domain.catalog.freeze(
    drawings.map((d) => ({
      drawingId: d.drawingId,
      revisionId: d.revision.id,
      snapshotId: d.snapshot.id,
    })),
  );
  return domain.coverage.prepare(manifest.id, {
    discipline: "建筑",
    categories: ["板"],
    drawings: drawings.map((d) => ({
      drawingId: d.drawingId,
      floor: floors ? d.floor : null,
      viewPurpose: "平面",
    })),
  });
}
function exclude(
  domain: WorkspaceDomain,
  coverageId: string,
  drawing: ReturnType<typeof seed>,
) {
  const c = domain.coverage.status(coverageId);
  return domain.coverage.exclude(coverageId, {
    expectedVersion: c.version,
    fingerprint: c.fingerprint,
    drawingId: drawing.drawingId,
    occurrenceIds: [drawing.note.occurrenceId],
    reason: "标注文字不是板构件",
    evidence: "对照原图文字及参考清单",
  });
}
function review(
  domain: WorkspaceDomain,
  coverageId: string,
  conclusion = "reviewed_complete",
) {
  const c = domain.coverage.status(coverageId);
  return domain.coverage.review(coverageId, {
    expectedVersion: c.version,
    fingerprint: c.fingerprint,
    conclusion,
    evidence:
      "人工对照冻结原图与独立参考清单逐项检查，已检查未归属来源和重复项",
    reference: {
      kind: "reference_inventory",
      locator: "controlled-reference-v1",
    },
  });
}
async function result(domain: WorkspaceDomain, resultId: string) {
  for (let i = 0; i < 200; i++) {
    const r = domain.scopeTakeoff.get(resultId);
    if (r.status !== "running") return r;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("scope takeoff timeout");
}

test("confirming all candidates cannot conceal a missed source; additions and exclusions require a new coverage review", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-missing-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain),
      c = await candidate(domain, d, d.a.occurrenceId);
    await confirm(domain, d, c);
    const coverage = prepare(domain, [d]);
    assert.equal(coverage.status, "incomplete");
    assert.equal(coverage.drawings[0].counts.unassigned, 2);
    exclude(domain, coverage.coverageId, d);
    assert.throws(() => review(domain, coverage.coverageId), /存在未归属/);
    const partial = domain.scopeTakeoff.run({
      coverageId: coverage.coverageId,
      quantityKind: "business_count",
      operationId: "partial",
    });
    const subtotal = await result(domain, partial.id);
    assert.equal(subtotal.status, "partial");
    assert.equal(subtotal.validity, "valid");
    assert.equal(subtotal.knownSubtotal, 1);
    assert.equal(subtotal.calculationComplete, true);
    assert.equal(subtotal.scopeComplete, false);
    assert.equal(subtotal.completeTotal, null);
    const added = await candidate(domain, d, d.b.occurrenceId);
    assert.equal(domain.coverage.status(coverage.coverageId).stale, true);
    await confirm(domain, d, added);
    assert.throws(
      () => review(domain, coverage.coverageId),
      /图纸或候选已变化/,
    );
    const replacement = domain.coverage.rebase(coverage.coverageId);
    exclude(domain, replacement.coverageId, d);
    const before = domain.coverage.status(replacement.coverageId);
    assert.equal(before.status, "unknown");
    assert.equal(before.canReviewComplete, true);
    assert.equal(
      review(domain, replacement.coverageId).status,
      "reviewed_complete",
    );
    const complete = await result(
      domain,
      domain.scopeTakeoff.run({
        coverageId: replacement.coverageId,
        quantityKind: "business_count",
        operationId: "complete",
      }).id,
    );
    assert.equal(complete.knownSubtotal, 2);
    assert.equal(complete.scopeComplete, true);
    assert.equal(complete.completeTotal, 2);
    assert.equal(complete.measurementBasis, "geometric_only");
    assert.equal(complete.normativeRuleBinding, null);
    assert.equal(
      (
        await domain.call("scope_coverage_review", {
          workspaceId: domain.catalog.manifest.workspaceId,
          coverageId: replacement.coverageId,
          userConfirmed: true,
        })
      ).error.code,
      "UNKNOWN_TOOL",
    );
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown view/floor, unlocated parser gaps and unsupported exclusions block completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-gap-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain, "一层", true);
    for (const o of [d.a, d.b])
      await confirm(domain, d, await candidate(domain, d, o.occurrenceId));
    const coverage = prepare(domain, [d], false);
    exclude(domain, coverage.coverageId, d);
    const status = domain.coverage.status(coverage.coverageId);
    assert.ok(status.drawings[0].blockers.includes("FLOOR_UNKNOWN"));
    assert.ok(status.drawings[0].blockers.includes("PARSER_GAPS"));
    assert.equal(
      domain.coverage.state(coverage.coverageId).drawings[0].gaps[0].unlocated,
      true,
    );
    assert.throws(() => review(domain, coverage.coverageId));
    assert.throws(() =>
      domain.coverage.exclude(coverage.coverageId, {
        expectedVersion: status.version,
        fingerprint: status.fingerprint,
        drawingId: d.drawingId,
        occurrenceIds: [d.a.occurrenceId],
        reason: "",
        evidence: "",
      }),
    );
    assert.throws(() =>
      domain.coverage.exclude(coverage.coverageId, {
        expectedVersion: status.version,
        fingerprint: status.fingerprint,
        drawingId: d.drawingId,
        occurrenceIds: ["made-up-source"],
        reason: "not in scope",
        evidence: "test",
      }),
    );
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-drawing quantities freeze coverage versions; later review or diagram changes invalidate completion and exports retain evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-multi-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const a = seed(domain, "一层"),
      b = seed(domain, "二层");
    for (const d of [a, b])
      for (const o of [d.a, d.b])
        await confirm(domain, d, await candidate(domain, d, o.occurrenceId));
    const coverage = prepare(domain, [a, b]);
    for (const d of [a, b]) exclude(domain, coverage.coverageId, d);
    review(domain, coverage.coverageId);
    const request = {
      coverageId: coverage.coverageId,
      quantityKind: "net_area" as const,
      operationId: "multi-area",
    };
    const first = domain.scopeTakeoff.run(request),
      total = await result(domain, first.id);
    assert.ok(Math.abs(total.knownSubtotal - 4) < 1e-9);
    assert.equal(total.scopeComplete, true);
    assert.equal(total.children.length, 2);
    assert.equal(domain.scopeTakeoff.run(request).id, first.id);
    const exported = domain.scopeTakeoff.export({
      scopeResultId: total.id,
      operationId: "export",
    });
    let job: any;
    for (let i = 0; i < 100; i++) {
      job = domain.service.getJob({
        projectId: exported.drawingId,
        jobId: exported.id,
      });
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(
      ["succeeded", "partial"].includes(job.status),
      JSON.stringify(job),
    );
    const { readFileSync } = await import("node:fs");
    const report = JSON.parse(
      readFileSync(join(job.result.path, "scope-report.json"), "utf8"),
    );
    assert.equal(report.result.scopeComplete, true);
    assert.equal(
      report.coverageAtStart.review.reference.locator,
      "controlled-reference-v1",
    );
    assert.equal(report.sources.length, 2);
    const session = domain.reviews.open(
      a.drawingId,
      undefined,
      coverage.coverageId,
    );
    assert.equal(
      domain.reviews.state(session.token).coverage?.status,
      "reviewed_complete",
    );
    const original = a.store.all<any>("component")[0];
    await confirm(domain, a, original);
    const stale = domain.scopeTakeoff.get(first.id);
    assert.equal(stale.validity, "stale");
    assert.equal(stale.scopeComplete, false);
    assert.equal(stale.completeTotal, null);
    assert.equal(domain.coverage.status(coverage.coverageId).stale, true);
    assert.throws(() => review(domain, coverage.coverageId));
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-floor identical boundaries are flagged as duplicate components without silently merging sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-duplicate-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain, "一层", false, true);
    for (const o of [d.a, d.b])
      await confirm(domain, d, await candidate(domain, d, o.occurrenceId));
    const coverage = prepare(domain, [d]);
    exclude(domain, coverage.coverageId, d);
    const state = domain.coverage.state(coverage.coverageId);
    assert.equal(state.semanticDuplicates.length, 1);
    assert.ok(
      state.drawings[0].blockers.includes("DUPLICATE_COMPONENT_GEOMETRY"),
    );
    assert.equal(
      state.drawings[0].rows.filter((r) => r.status === "assigned").length,
      2,
    );
    assert.throws(() => review(domain, coverage.coverageId));
    const duplicateResult = await result(
      domain,
      domain.scopeTakeoff.run({
        coverageId: coverage.coverageId,
        quantityKind: "business_count",
        operationId: "duplicate-count",
      }).id,
    );
    assert.equal(duplicateResult.knownSubtotal, 0);
    assert.equal(duplicateResult.calculationComplete, false);
    assert.equal(duplicateResult.children[0].blockedComponentIds.length, 2);
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit source subsets stay labeled as subsets and review decisions survive restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-restart-"));
  let domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain);
    await confirm(domain, d, await candidate(domain, d, d.a.occurrenceId));
    const selection = await domain.service.selection({
      projectId: d.drawingId,
      workingRevision: d.revision.id,
      geometrySnapshotId: d.snapshot.id,
      members: [d.a.occurrenceId],
    });
    const manifest = domain.catalog.freeze([
      {
        drawingId: d.drawingId,
        revisionId: d.revision.id,
        snapshotId: d.snapshot.id,
      },
    ]);
    const prepared = domain.coverage.prepare(manifest.id, {
      discipline: "建筑",
      categories: ["板"],
      drawings: [
        {
          drawingId: d.drawingId,
          floor: d.floor,
          viewPurpose: "局部平面",
          selectionSet: { id: selection.id, version: 1 },
        },
      ],
    });
    assert.equal(prepared.drawings[0].sourceScope, "explicit_source_subset");
    assert.equal(prepared.drawings[0].counts.sources, 1);
    review(domain, prepared.coverageId);
    const measured = await result(
      domain,
      domain.scopeTakeoff.run({
        coverageId: prepared.coverageId,
        quantityKind: "business_count",
        operationId: "subset-count",
      }).id,
    );
    assert.equal(measured.completeTotal, 1);
    domain.close();
    domain = new WorkspaceDomain(root, "next-instance");
    assert.equal(
      domain.coverage.status(prepared.coverageId).status,
      "reviewed_complete",
    );
    assert.equal(domain.scopeTakeoff.get(measured.id).scopeComplete, true);
    const page = await domain.call("scope_coverage_status", {
      workspaceId: domain.catalog.manifest.workspaceId,
      coverageId: prepared.coverageId,
      limit: 1,
    });
    assert.equal(page.sourcePage.items.length, 1);
    assert.equal(page.sourcePage.nextOffset, null);
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage review does not replace missing measurement parameters", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-parameters-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain);
    for (const o of [d.a, d.b]) {
      const c = await candidate(domain, d, o.occurrenceId),
        session = domain.reviews.open(d.drawingId);
      await domain.reviews.submit(session.token, {
        fingerprint: session.batch.fingerprint,
        reviews: [
          {
            componentId: c.id,
            expectedVersion: c.version,
            status: "confirmed",
            category: "板",
            label: c.label,
            floor: d.floor,
            material: "混凝土",
            evidence: "仅核对分类与位置，厚度尚缺",
          },
        ],
      });
    }
    const coverage = prepare(domain, [d]);
    exclude(domain, coverage.coverageId, d);
    review(domain, coverage.coverageId);
    const measured = await result(
      domain,
      domain.scopeTakeoff.run({
        coverageId: coverage.coverageId,
        quantityKind: "parameter_volume",
        operationId: "volume-without-thickness",
      }).id,
    );
    assert.equal(measured.scopeCoverage, "reviewed_complete");
    assert.equal(measured.calculationComplete, false);
    assert.equal(measured.scopeComplete, false);
    assert.equal(measured.completeTotal, null);
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unassociated opening candidates prevent a complete net-area claim even after coverage review", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-opening-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain);
    await confirm(domain, d, await candidate(domain, d, d.a.occurrenceId));
    const hole = await domain.call("component_suggest", {
      workspaceId: domain.catalog.manifest.workspaceId,
      drawingId: d.drawingId,
      members: [d.b.occurrenceId],
      category: "洞口",
      label: "未关联洞口",
      reason: "受控洞口候选，不假定扣减关系",
    });
    assert.ok(hole.id);
    const coverage = prepare(domain, [d]);
    const current = domain.coverage.status(coverage.coverageId);
    domain.coverage.exclude(coverage.coverageId, {
      expectedVersion: current.version,
      fingerprint: current.fingerprint,
      drawingId: d.drawingId,
      occurrenceIds: [d.b.occurrenceId, d.note.occurrenceId],
      reason: "板边界范围内的非板来源",
      evidence: "洞口候选独立保留，尚未采用其扣减关系",
    });
    review(domain, coverage.coverageId);
    const measured = await result(
      domain,
      domain.scopeTakeoff.run({
        coverageId: coverage.coverageId,
        quantityKind: "net_area",
        operationId: "opening-pending",
      }).id,
    );
    assert.equal(measured.calculationComplete, true);
    assert.equal(measured.scopeComplete, false);
    assert.equal(measured.completeTotal, null);
    assert.deepEqual(measured.measurementBlockers, [
      "OPENING_RELATIONS_UNVERIFIED",
    ]);
    assert.equal(measured.ruleCheck, "incomplete");
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring an exclusion increments the coverage version and invalidates the bound completion claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-coverage-restore-")),
    domain = new WorkspaceDomain(root, "coverage-test");
  try {
    const d = seed(domain);
    for (const o of [d.a, d.b])
      await confirm(domain, d, await candidate(domain, d, o.occurrenceId));
    const prepared = prepare(domain, [d]);
    exclude(domain, prepared.coverageId, d);
    review(domain, prepared.coverageId);
    const measured = await result(
      domain,
      domain.scopeTakeoff.run({
        coverageId: prepared.coverageId,
        quantityKind: "business_count",
        operationId: "before-restore",
      }).id,
    );
    assert.equal(measured.scopeComplete, true);
    const before = domain.coverage.get(prepared.coverageId),
      exclusion = before.exclusions[0];
    domain.coverage.restore(before.id, {
      expectedVersion: before.version,
      fingerprint: before.fingerprint,
      exclusionId: exclusion.id,
    });
    const after = domain.coverage.status(before.id);
    assert.equal(after.version, before.version + 1);
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.equal(after.status, "incomplete");
    assert.equal(after.drawings[0].counts.unassigned, 1);
    const stale = domain.scopeTakeoff.get(measured.id);
    assert.equal(stale.validity, "stale");
    assert.equal(stale.completeTotal, null);
    assert.equal(stale.scopeComplete, false);
    assert.throws(
      () =>
        domain.coverage.restore(before.id, {
          expectedVersion: before.version,
          fingerprint: before.fingerprint,
          exclusionId: exclusion.id,
        }),
      /版本|刷新/,
    );
    assert.ok(
      domain.auditStore
        .all<any>("coverage_event")
        .some((e) => e.kind === "restore" && e.exclusion.id === exclusion.id),
    );
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});
