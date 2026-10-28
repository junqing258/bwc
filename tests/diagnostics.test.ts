import test from "node:test";
import assert from "node:assert/strict";
import { importReport, groupIssues } from "../apps/server/diagnostics.ts";
import type { Artifact } from "../apps/server/types.ts";

test("coverage separates block-definition records, unique sources and actual model occurrences", () => {
  const artifact = {
    sources: [
      { handle: "a", type: "HATCH" },
      { handle: "b", type: "HATCH" },
      { handle: "c", type: "LINE" },
    ],
    occurrences: [
      { sourceHandle: "a", space: "model", geometry: null },
      { sourceHandle: "a", space: "model", geometry: null },
      { sourceHandle: "a", space: "*Paper_Space", geometry: null },
      { sourceHandle: "c", space: "model", geometry: { kind: "path" } },
    ],
    diagnostics: [
      { code: "UNSUPPORTED_ENTITY", handle: "a", entityType: "HATCH" },
      { code: "UNSUPPORTED_ENTITY", handle: "a", entityType: "HATCH" },
      { code: "UNSUPPORTED_ENTITY", handle: "b", entityType: "HATCH" },
    ],
    notifications: [
      "Unlisted object with DXF name STYLE_X has been read as an UnknownNonGraphicalObject",
      "Unlisted object with DXF name STYLE_X has been read as an UnknownNonGraphicalObject",
      "TextStyle not found",
    ],
    importCompleteness: "partial",
  } as unknown as Artifact;
  const before = JSON.stringify(artifact),
    report = importReport(artifact);
  assert.equal(report.modelTotal, 3);
  assert.equal(report.modelWithGeometry, 1);
  assert.equal(report.modelWithoutGeometry, 2);
  assert.deepEqual(report.diagnosticGroups[0], {
    code: "UNSUPPORTED_ENTITY",
    entityType: "HATCH",
    reason: "",
    recordCount: 3,
    sourceEntityCount: 2,
    modelOccurrences: 2,
    otherSpaceOccurrences: 1,
    uninstantiatedSources: 1,
    examples: ["a", "b"],
  });
  assert.equal(report.notificationCount, 3);
  assert.equal(report.notificationGroupCount, 2);
  assert.equal(report.notificationGroups[0].count, 2);
  assert.equal(report.notificationGroups[0].category, "unknown_non_graphical");
  assert.equal(report.notificationImpact, "requires_verification");
  assert.equal(report.importCompleteness, "partial");
  assert.equal(JSON.stringify(artifact), before);
});

test("repeated legacy unit failures become one unexecuted contour group; original evidence remains untouched", () => {
  const records = Array.from({ length: 1000 }, (_, n) => ({
    id: "old_" + n,
    check: "contour",
    checkerVersion: "bwc-check-1",
    status: "failed",
    severity: "warning",
    reason: "UNITS_UNCONFIRMED",
    geometrySnapshotId: "snapshot",
    occurrenceIds: ["occ_" + (n % 500)],
  }));
  const issues = groupIssues(records, "old_run");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, "not_run");
  assert.equal(issues[0].occurrenceIds.length, 500);
  assert.equal((issues[0].evidence as any).recordCount, 1000);
  assert.equal(records[0].status, "failed");
  assert.deepEqual(
    groupIssues(issues, "old_run").map((i) => ({
      status: i.status,
      members: i.occurrenceIds,
      count: (i.evidence as any).recordCount,
    })),
    issues.map((i) => ({
      status: i.status,
      members: i.occurrenceIds,
      count: (i.evidence as any).recordCount,
    })),
  );
});

test("notification-only coverage is not silently promoted to complete or called missing geometry", () => {
  const artifact = {
    sources: [],
    occurrences: [
      { sourceHandle: "a", space: "model", geometry: { kind: "text" } },
    ],
    diagnostics: [],
    notifications: ["Unknown metadata warning"],
    importCompleteness: "partial",
  } as unknown as Artifact;
  const report = importReport(artifact);
  assert.equal(report.modelWithoutGeometry, 0);
  assert.equal(report.notificationGroupCount, 1);
  assert.equal(report.importCompleteness, "partial");
  assert.equal(report.notificationGroups[0].category, "unclassified");
});
