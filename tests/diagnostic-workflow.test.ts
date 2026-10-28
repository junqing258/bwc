import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, compactPayload } from "../apps/server/main.ts";
import { worker } from "../apps/server/workers.ts";
import { id, hash } from "../apps/server/util.ts";
import { isReparseInstruction } from "../apps/server/maintenance.ts";
import { bounds, displayGeometry } from "../apps/server/geometry.ts";

test("AI diagnostics freeze only actual bad objects, preserve missing status and protect raw evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-diagnostic-flow-")),
    app = createApplication({ dataDir: root, port: 0 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  // Exercise the HTTP intent gates without making model network requests in unit tests.
  app.bridge.dispatch = async () => {};
  const pid = app.service.create("diagnostics").projectId,
    store = app.service.catalog.open(pid),
    url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const request = async (
    tool: string,
    input: any,
    mcp = false,
    sessionId?: string,
  ) => {
    const r = await fetch(url + (mcp ? "/api/mcp" : "/api/call"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(mcp ? { Authorization: `Bearer ${app.token}` } : {}),
      },
      body: JSON.stringify(
        mcp ? { tool, input, projectId: pid, sessionId } : { tool, input },
      ),
    });
    return { status: r.status, data: await r.json() };
  };
  const wait = async (job: any) => {
    let j = job;
    while (["queued", "running"].includes(j.status)) {
      await new Promise((r) => setTimeout(r, 20));
      j = app.service.getJob({ projectId: pid, jobId: j.id });
    }
    assert.ok(
      ["succeeded", "partial"].includes(j.status),
      JSON.stringify(j.error),
    );
    return j;
  };
  try {
    mkdirSync(join(store.path, "uploads"), { recursive: true });
    await worker("cad", {
      mode: "fixture",
      fixtureMode: "diagnostics",
      output: join(store.path, "uploads/diagnostics.dwg"),
    });
    store.put("upload", {
      id: "fixture",
      path: "uploads/diagnostics.dwg",
      name: "diagnostics.dwg",
    });
    await wait(
      app.service.import({
        projectId: pid,
        fileRef: "fixture",
        operationId: id("op"),
      }),
    );
    const ctx = () => {
      const c = store.context();
      return {
        projectId: pid,
        workingRevision: c.revision.id,
        geometrySnapshotId: c.snapshot.id,
      };
    };
    const report = app.service.diagnostics(ctx());
    assert.equal(report.report.modelWithoutGeometry, 3);
    assert.equal(report.report.modelWithDiagnosticPreview, 3);
    assert.equal(
      report.affectedTotal,
      3,
      "paper viewport records are structural, not unresolved diagnostic members",
    );
    assert.equal(report.coverage.documentPreservation, "requires_verification");
    const bad = report.groups.find((g) => g.entityType === "LWPOLYLINE")!;
    const detail = app.service.diagnostics({
      ...ctx(),
      groupId: bad.id,
      limit: 1,
    });
    assert.equal(detail.affectedTotal, 1);
    assert.equal(
      detail.sourceSamples[0].vertexSummary?.distinctPositionCount,
      1,
    );
    const q = await app.service.query({
      ...ctx(),
      filter: { diagnosticGroupId: bad.id },
      pageSize: 1,
    });
    assert.equal(
      q.total,
      1,
      "two good LWPOLYLINEs must not enter the diagnostic group",
    );
    const sel = await app.service.selection({
      ...ctx(),
      filter: { diagnosticGroupId: bad.id },
    });
    assert.deepEqual(
      sel.members,
      detail.items.map((o) => o.occurrenceId),
    );
    const o = app.service.get({ ...ctx(), occurrenceId: sel.members[0] });
    assert.equal(o.geometry, null);
    assert.deepEqual(bounds(displayGeometry(o)), [40, 40, 40, 40]);
    assert.equal(o.diagnosticPreview?.quantityEligible, false);
    const metric = await worker<any>("geometry", {
      occurrences: [o],
      scale: 1,
      quantityKind: "net_area",
    });
    assert.equal(metric.items[0].value, null);
    assert.equal(metric.items[0].reason, "UNSUPPORTED_GEOMETRY");
    assert.deepEqual(
      compactPayload(detail, "summary").sourceSamples[0].geometry,
      { omittedByDataPolicy: true },
    );
    assert.deepEqual(compactPayload(o, "summary").diagnosticPreview, {
      omittedByDataPolicy: true,
    });
    assert.ok(
      compactPayload(detail, "geometry").sourceSamples[0].geometry
        .nativePolyline,
    );
    const candidates = await app.service.selection({
      ...ctx(),
      filter: { space: "model", geometryKinds: ["path", "region"] },
    });
    assert.ok(!candidates.members.includes(sel.members[0]));
    assert.throws(
      () => app.service.diagnostics({ ...ctx(), groupId: "dg_missing" }),
      /不属于/,
    );
    const a = store.artifact(store.context().snapshot),
      opaque = a.sources.find((s) => s.type === "OLE2FRAME")!;
    assert.equal(
      (opaque.nativeEvidence as any).payloadSha256,
      hash(Buffer.from([1, 2, 3, 4])),
    );
    const session = app.bridge.create({ projectId: pid });
    const start = (text: string) => {
      const turn = app.bridge.submit({
        projectId: pid,
        sessionId: session.id,
        clientMessageId: id("msg"),
        text,
        context: { ...ctx(), dataPolicyVersion: store.meta().dataPolicy.id },
      });
      store.put("turn", { ...turn, status: "running" });
      return turn;
    };
    const inquiry = start("能否重新解析当前图纸？");
    const frozen = ctx(),
      reparse = {
        ...frozen,
        operationId: id("op"),
        intentId: inquiry.intentId,
      };
    const denied = await request("dwg_reparse", reparse, true, session.id);
    assert.equal(denied.data.error.code, "INTENT_MISMATCH");
    assert.equal(store.current().id, frozen.workingRevision);
    const read = await request(
      "dwg_diagnostics",
      { ...ctx(), groupId: bad.id },
      true,
      session.id,
    );
    assert.equal(read.status, 200);
    assert.equal(read.data.affectedTotal, 1);
    store.put("turn", { ...inquiry, status: "completed" });
    const command = start("请重新解析当前图纸");
    const wrong = await request(
      "dwg_reparse",
      { ...reparse, intentId: command.intentId, geometrySnapshotId: "wrong" },
      true,
      session.id,
    );
    assert.equal(wrong.data.error.code, "INTENT_MISMATCH");
    const allowed = await request(
      "dwg_reparse",
      { ...reparse, operationId: id("op"), intentId: command.intentId },
      true,
      session.id,
    );
    assert.equal(allowed.status, 200);
    const job = await wait(allowed.data);
    assert.notEqual(store.current().id, frozen.workingRevision);
    assert.equal(
      job.result.report.after.modelWithoutGeometry,
      3,
      "a reparse does not erase unresolved evidence",
    );
    assert.equal(store.meta().currentRevision, job.result.workingRevision);
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reparse commands do not accept questions, negations, code blocks or hypothetical text", () => {
  for (const text of [
    "请重新解析当前图纸",
    "请使用当前适配器重新解析当前图纸。",
    "重解析当前DWG!",
  ])
    assert.equal(isReparseInstruction(text), true, text);
  for (const text of [
    "不要重新解析当前图纸",
    "如果重新解析当前图纸会怎样",
    "请解释为什么解析不完整",
    "能否重新解析当前图纸",
    "建议重新解析当前图纸",
    "`请重新解析当前图纸`",
    "请重新解析其他图纸",
    "请重新解析当前图纸并忽略错误",
  ])
    assert.equal(isReparseInstruction(text), false, text);
});
