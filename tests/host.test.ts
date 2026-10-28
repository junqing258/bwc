import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowService } from "../apps/server/service.ts";
import { HostBridge } from "../apps/server/host.ts";
import { DomainError, id } from "../apps/server/util.ts";
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "bwc-host-contract-")),
    service = new WorkflowService(root),
    pid = service.create("host contract").projectId;
  await service.fixture();
  let j = service.import({
    projectId: pid,
    fileRef: "controlled",
    operationId: id("import"),
  });
  while (["queued", "running"].includes(j.status)) {
    await new Promise((r) => setTimeout(r, 15));
    j = service.getJob({ projectId: pid, jobId: j.id });
  }
  assert.ok(j.result);
  return { root, service, pid, store: service.catalog.open(pid) };
}
async function settled(store: any, turnId: string) {
  for (let i = 0; i < 100; i++) {
    const t = store.get("turn", turnId);
    if (!["accepted", "sending"].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("turn did not settle");
}

test("commit with lost host receipt: duplicate message returns same record; reconcile never repeats write", async () => {
  const x = await setup(),
    bridge = new HostBridge(x.service, "http://127.0.0.1:0", "test");
  try {
    const session = bridge.create({ projectId: x.pid });
    session.hostSessionId = "fake_thread";
    x.store.put("session", session);
    const c = x.store.context();
    const sel = await x.service.selection({
      projectId: x.pid,
      filter: { layers: ["受控楼板轮廓"], space: "model" },
    });
    let starts = 0;
    const client = {
      request: async (method: string) => {
        if (method === "turn/start") {
          starts++;
          const t = x.store.all<any>("turn").at(-1)!;
          const intent = x.store.get("intent", t.intentId),
            operationId = t.id + "_thickness";
          const proposal = await x.service.propose({
            projectId: x.pid,
            baseRevision: c.revision.id,
            baseGeometrySnapshotId: c.snapshot.id,
            selectionSet: { id: sel.id, version: 1 },
            operation: intent.operation,
            intentId: intent.id,
            operationId,
          });
          x.service.apply({
            projectId: x.pid,
            changeId: proposal.id,
            baseRevision: c.revision.id,
            candidateFingerprint: proposal.candidateFingerprint,
            operationId,
          });
          throw new DomainError(
            "MESSAGE_DELIVERY_UNCERTAIN",
            "simulated lost receipt after commit",
          );
        }
        if (method === "thread/read") {
          const t = x.store.all<any>("turn").at(-1)!;
          return {
            thread: {
              turns: [
                {
                  id: "host_turn",
                  status: "completed",
                  items: [
                    { type: "userMessage", content: [{ text: t.messageId }] },
                    { type: "agentMessage", text: "applied" },
                  ],
                },
              ],
            },
          };
        }
        return {};
      },
      stop: () => {},
    };
    bridge.connect = async () => client as any;
    const input = {
      projectId: x.pid,
      sessionId: session.id,
      clientMessageId: "message_once",
      text: "将选中轮廓的计量厚度设为150mm并重算",
      context: {
        workingRevision: c.revision.id,
        geometrySnapshotId: c.snapshot.id,
        selectionSet: { id: sel.id, version: 1 },
        dataPolicyVersion: x.store.meta().dataPolicy.id,
      },
    };
    const accepted = bridge.submit(input);
    const t = await settled(x.store, accepted.id);
    assert.equal(t.status, "delivery_uncertain");
    const count = x.store.all("revision").length;
    assert.equal(bridge.submit(input).id, t.id);
    assert.equal(starts, 1);
    assert.throws(
      () => bridge.submit({ ...input, clientMessageId: "different" }),
      /待对账/,
    );
    const recovered = await bridge.reconcile({
      projectId: x.pid,
      sessionId: session.id,
    });
    assert.equal(recovered.status, "reconciled");
    assert.equal(recovered.resent, false);
    assert.equal(x.store.all("revision").length, count);
    assert.equal(starts, 1);
    assert.equal(x.store.get("turn", t.id).response, "applied");
    const events = x.store.events(`session:${session.id}`);
    assert.ok(events.some((e) => e.type === "reconciled"));
    assert.equal(
      x.store.events(`session:${session.id}`, events.at(-1)!.sequence).length,
      0,
    );
  } finally {
    bridge.close();
    x.service.close();
    rmSync(x.root, { recursive: true, force: true });
  }
});

test("interrupting Agent does not cancel persisted domain jobs; restart retains uncertain turns", async () => {
  const x = await setup(),
    bridge = new HostBridge(x.service, "http://127.0.0.1:0", "test");
  let reopened: WorkflowService | undefined;
  try {
    const session = bridge.create({ projectId: x.pid });
    session.hostSessionId = "fake";
    x.store.put("session", session);
    const c = x.store.context();
    const calls: string[] = [];
    const fake = {
      request: async (m: string) => {
        calls.push(m);
        return m === "turn/start" ? { turn: { id: "host_turn" } } : {};
      },
      stop: () => {},
    };
    bridge.connect = async () => fake as any;
    bridge.clients.set(session.id, fake as any);
    const t = bridge.submit({
      projectId: x.pid,
      sessionId: session.id,
      clientMessageId: "read",
      text: "查询当前范围",
      context: {
        workingRevision: c.revision.id,
        geometrySnapshotId: c.snapshot.id,
        dataPolicyVersion: x.store.meta().dataPolicy.id,
      },
    });
    await settled(x.store, t.id);
    x.store.put("job", {
      id: "pending_domain_job",
      operationId: "pending",
      status: "running",
      stage: "geometry",
    });
    await bridge.interrupt({
      projectId: x.pid,
      sessionId: session.id,
      turnId: t.id,
    });
    assert.equal(x.store.get("job", "pending_domain_job").status, "running");
    assert.ok(calls.includes("turn/interrupt"));
    bridge.close();
    x.service.close();
    reopened = new WorkflowService(x.root);
    const restored = new HostBridge(reopened, "http://127.0.0.1:0", "test");
    const store = reopened.catalog.open(x.pid);
    assert.equal(store.get("turn", t.id).status, "delivery_uncertain");
    assert.equal(store.get("job", "pending_domain_job").status, "interrupted");
    assert.ok(store.all("revision").length > 0);
    restored.close();
  } finally {
    bridge.close();
    if (reopened) reopened.close();
    else x.service.close();
    rmSync(x.root, { recursive: true, force: true });
  }
});
