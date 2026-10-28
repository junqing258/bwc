import { createApplication } from "../server/main.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../server/workers.ts";
import { id } from "../server/util.ts";
import type { Operation } from "../server/types.ts";

const root = mkdtempSync(join(tmpdir(), "bwc-host-smoke-"));
const app = createApplication({ dataDir: root, port: 4311 });
await new Promise<void>((r) => app.server.listen(4311, "127.0.0.1", r));
const service = app.service,
  pid = service.create("真实宿主桥接验收").projectId,
  store = service.catalog.open(pid);
const context = () => {
  const c = store.context();
  return {
    workingRevision: c.revision.id,
    geometrySnapshotId: c.snapshot.id,
    dataPolicyVersion: store.meta().dataPolicy.id,
  };
};
async function awaitTurn(turnId: string) {
  const end = Date.now() + 180000;
  let turn: any;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1000));
    turn = store.get("turn", turnId);
    if (!["accepted", "sending", "running"].includes(turn.status)) return turn;
    process.stdout.write(".");
  }
  return turn;
}
async function manual(operation: Operation, selectionSet?: any) {
  const c = context(),
    operationId = id("setup");
  const intent = service.recordIntent({
    projectId: pid,
    workingRevision: c.workingRevision,
    selectionSet,
    operation,
  });
  const proposal = await service.propose({
    projectId: pid,
    operationId,
    baseRevision: c.workingRevision,
    baseGeometrySnapshotId: c.geometrySnapshotId,
    selectionSet,
    operation,
    intentId: intent.id,
  });
  service.apply({
    projectId: pid,
    changeId: proposal.id,
    operationId,
    baseRevision: c.workingRevision,
    candidateFingerprint: proposal.candidateFingerprint,
  });
}
await service.fixture();
let job = service.import({
  projectId: pid,
  fileRef: "controlled",
  operationId: id("probe"),
});
while (["queued", "running"].includes(job.status)) {
  await new Promise((r) => setTimeout(r, 50));
  job = service.getJob({ projectId: pid, jobId: job.id });
}
if (!job.result) throw new Error(JSON.stringify(job.error));
const session = app.bridge.create({ projectId: pid });
const read = app.bridge.submit({
  projectId: pid,
  sessionId: session.id,
  clientMessageId: id("message"),
  text: "请通过 bwc MCP 调用 dwg_summary，并汇报当前源实体数量和单位状态。只读查询，不修改数据。",
  context: context(),
});
await awaitTurn(read.id);
await manual({
  kind: "set_units",
  metresPerDrawingUnit: 1,
  evidence: "受控基准 6m x 4m",
});
let slab = await service.selection({
  projectId: pid,
  filter: { layers: ["受控楼板轮廓"], space: "model" },
});
const hole = await service.selection({
  projectId: pid,
  filter: { layers: ["受控洞口"], space: "model" },
});
await manual(
  { kind: "set_holes", holes: hole.members },
  { id: slab.id, version: 1 },
);
slab = await service.selection({
  projectId: pid,
  filter: { layers: ["受控楼板轮廓"], space: "model" },
});
const write = app.bridge.submit({
  projectId: pid,
  sessionId: session.id,
  clientMessageId: id("message"),
  text: "将选中轮廓的计量厚度设为150mm并重算",
  context: { ...context(), selectionSet: { id: slab.id, version: 1 } },
});
const writeTurn = await awaitTurn(write.id);
const results = store.all<any>("takeoff"),
  toolCalls = store.all<any>("tool_call");
const report = {
  at: new Date().toISOString(),
  projectId: pid,
  session: store.get("session", session.id),
  readTurn: store.get("turn", read.id),
  writeTurn,
  toolCalls,
  dataSends: store.all("data_send"),
  events: store.events(`session:${session.id}`, 0, 5000),
  results,
  changes: store.all("change"),
  realModelTasks: true,
  assertions: {
    readToolCalled: toolCalls.some(
      (t) => t.turnId === read.id && t.tool === "dwg_summary",
    ),
    nativeIntentApplied: store
      .all<any>("change")
      .some((c) => c.intentId === write.intentId && c.status === "applied"),
    computedReference: results.some(
      (r) =>
        Math.abs(r.knownSubtotal - 3.45) < 1e-9 && r.completeTotal !== null,
    ),
    completed: writeTurn.status === "completed",
  },
};
mkdirSync(join(ROOT, "docs/evidence"), { recursive: true });
writeFileSync(
  join(ROOT, "docs/evidence/host-bridge-smoke.json"),
  JSON.stringify(report, null, 2),
);
console.log("\n", report.assertions, "response", writeTurn.response);
app.bridge.close();
app.server.closeAllConnections();
app.server.close();
setTimeout(() => {
  store.close();
  process.exit(Object.values(report.assertions).every(Boolean) ? 0 : 1);
}, 300);
