import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { worker } from "../apps/server/workers.ts";
import {
  ensureRuntime,
  runtimeRequest,
} from "../apps/server/runtime-client.ts";
import { atomicJson } from "../apps/server/util.ts";
mkdirSync(resolve(".cache"), { recursive: true });
const root = mkdtempSync(resolve(".cache/reviewer-smoke-"));
await worker("cad", { mode: "fixture", output: join(root, "受控样本.dwg") });
const connection = await ensureRuntime(root),
  workspaceId = connection.descriptor.workspaceId;
const call = (tool: string, input: object = {}) =>
  runtimeRequest(connection, "/call", {
    tool,
    input: { ...input, workspaceId },
  });
const imported = await call("drawing_import", {
  path: "受控样本.dwg",
  operationId: "qa-import",
});
for (let i = 0; i < 100; i++) {
  const job = await call("job_get", {
    drawingId: imported.drawingId,
    jobId: imported.id,
  });
  if (!["running", "queued"].includes(job.status)) {
    if (job.status === "failed") throw new Error(JSON.stringify(job));
    break;
  }
  await new Promise((r) => setTimeout(r, 30));
}
await call("component_recognize", { drawingId: imported.drawingId });
let coverageId: string | undefined;
if (process.argv.includes("--coverage")) {
  const drawings = await call("drawing_list");
  const current = drawings.find((d: any) => d.drawingId === imported.drawingId);
  const summary = await call("dwg_summary", { drawingId: imported.drawingId });
  const manifest = await call("input_manifest_create", {
    members: [
      {
        drawingId: imported.drawingId,
        revisionId: current.currentRevisionId,
        snapshotId: summary.geometrySnapshotId,
      },
    ],
  });
  const coverage = await call("scope_coverage_prepare", {
    manifestId: manifest.id,
    scope: {
      discipline: "建筑",
      categories: ["板"],
      drawings: [
        { drawingId: imported.drawingId, floor: "一层", viewPurpose: "平面" },
      ],
    },
  });
  if (coverage.error) throw new Error(JSON.stringify(coverage));
  coverageId = coverage.coverageId;
}
const viewer = await call("viewer_open", {
  drawingId: imported.drawingId,
  coverageId,
});
atomicJson(resolve(".cache/reviewer-smoke.json"), { root, viewer });
console.log(JSON.stringify({ root, url: viewer.url }));
