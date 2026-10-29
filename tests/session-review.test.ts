import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WorkspaceDomain } from "../apps/server/workspace-domain.ts";
import { SessionReviewService } from "../apps/server/session-review.ts";
import { worker } from "../apps/server/workers.ts";
import {
  ensureRuntime,
  runtimeRequest,
} from "../apps/server/runtime-client.ts";

async function importFixture(
  root: string,
  call: (name: string, input?: any) => Promise<any>,
) {
  await worker("cad", { mode: "fixture", output: join(root, "sample.dwg") });
  const imported = await call("drawing_import", {
    path: "sample.dwg",
    operationId: "sample",
  });
  for (let i = 0; i < 200; i++) {
    const job = await call("job_get", {
      drawingId: imported.drawingId,
      jobId: imported.id,
    });
    if (!["queued", "running"].includes(job.status)) {
      assert.ok(["succeeded", "partial"].includes(job.status));
      return imported.drawingId as string;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("fixture import timeout");
}

test("session confirmations are single-use, version-bound, validated and audited across all actions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bwc-session-"));
  const d = new WorkspaceDomain(root, "session-test"),
    service = new SessionReviewService(d);
  const workspaceId = d.catalog.manifest.workspaceId;
  const call = (name: string, input = {}) =>
    d.call(name, { workspaceId, ...input });
  try {
    const drawingId = await importFixture(root, call),
      s = d.catalog.open(drawingId);
    const prepare = (action: string, extra = {}) =>
      service.prepare({ workspaceId, drawingId, action, ...extra });
    const accept = (p: { ticketId: string }, content: object) =>
      service.resolve({ ticketId: p.ticketId, action: "accept", content });
    const initial = s.current().id;
    const expired = prepare("units"),
      future = Date.now() + 11 * 60 * 1000;
    const clock = t.mock.method(Date, "now", () => future);
    try {
      await assert.rejects(
        () => accept(expired, { unit: "米 m", evidence: "expired" }),
        (e: any) => e.code === "REVIEW_EXPIRED",
      );
    } finally {
      clock.mock.restore();
    }
    assert.equal(d.reviews.sessions.size, 0);
    for (const action of ["cancel", "decline"]) {
      const p = prepare("units");
      assert.equal(
        (await service.resolve({ ticketId: p.ticketId, action })).saved,
        false,
      );
      await assert.rejects(() => accept(p, { unit: "米 m", evidence: "test" }));
      assert.equal(s.current().id, initial);
    }
    await assert.rejects(() =>
      accept(prepare("units"), { unit: "米 m", evidence: " " }),
    );
    await assert.rejects(() =>
      accept(prepare("units"), { unit: "自定义", evidence: "test" }),
    );
    await assert.rejects(() =>
      accept(prepare("units"), {
        unit: "米 m",
        evidence: "test",
        userConfirmed: true,
      }),
    );
    const old = prepare("units"),
      fresh = prepare("units");
    assert.equal(
      fresh.form.requestedSchema.properties.unit.default,
      undefined,
      "units have no guessed default",
    );
    assert.equal(
      (await accept(fresh, { unit: "毫米 mm", evidence: "受控样本尺寸" }))
        .saved,
      true,
    );
    assert.equal(s.context().snapshot.units.metresPerDrawingUnit, 0.001);
    await assert.rejects(
      () => accept(old, { unit: "米 m", evidence: "old form" }),
      (e: any) => e.code === "REVIEW_STALE",
    );
    const policy = prepare("policy");
    d.catalog.setPolicy("summary", "test-race");
    await assert.rejects(
      () => accept(policy, { mode: "geometry" }),
      (e: any) => e.code === "REVIEW_STALE",
    );
    await accept(prepare("policy"), { mode: "geometry" });
    assert.deepEqual(d.catalog.policy().snapshotIds, [s.context().snapshot.id]);
    assert.equal(
      d.auditStore.all<any>("policy_audit").at(-1).source,
      "mcp_elicitation",
    );
    await call("component_recognize", { drawingId });
    const c = s
      .all<any>("component")
      .find((c) => c.geometrySnapshotId === s.context().snapshot.id);
    const component = prepare("component", { componentId: c.id });
    const secondComponent = prepare("component", { componentId: c.id });
    assert.ok(!JSON.stringify(component.form).includes('"vertices"'));
    const fields = {
      status: "confirmed",
      category: "板",
      label: c.label,
      floor: "一层",
      material: "混凝土",
      thicknessMm: 150,
      evidence: "受控样本边界",
    };
    await accept(component, fields);
    assert.equal(s.get("component", c.id).status, "confirmed");
    await assert.rejects(
      () => accept(secondComponent, fields),
      (e: any) => e.code === "REVIEW_STALE",
    );
    const ctx = s.context();
    const manifest = await call("input_manifest_create", {
      members: [
        { drawingId, revisionId: ctx.revision.id, snapshotId: ctx.snapshot.id },
      ],
    });
    const coverage = await call("scope_coverage_prepare", {
      manifestId: manifest.id,
      scope: {
        discipline: "建筑",
        categories: ["板"],
        drawings: [{ drawingId, floor: "一层", viewPurpose: "平面" }],
      },
    });
    assert.ok(!coverage.error, JSON.stringify(coverage));
    const coverageForm = prepare("coverage", {
      coverageId: coverage.coverageId,
    });
    const conclusionField =
      coverageForm.form.requestedSchema.properties.conclusion;
    assert.ok("enum" in conclusionField);
    assert.deepEqual(conclusionField.enum, ["incomplete"]);
    await assert.rejects(() =>
      accept(coverageForm, {
        conclusion: "reviewed_complete",
        evidence: "test",
        referenceKind: "source_drawing",
        locator: "1",
      }),
    );
    await accept(prepare("coverage", { coverageId: coverage.coverageId }), {
      conclusion: "incomplete",
      evidence: "原图仍有未归属来源",
      referenceKind: "source_drawing",
      locator: "受控样本第1张",
    });
    assert.equal(
      d.auditStore.all<any>("coverage_review").at(-1).source,
      "mcp_elicitation",
    );
    assert.ok(
      s
        .all<any>("session_review_event")
        .every((e) => e.source === "mcp_elicitation"),
    );
    assert.equal(d.reviews.sessions.size, 0);
    const denied = await call("review_in_session", {
      drawingId,
      action: "units",
      content: { unit: "米 m" },
    });
    assert.equal(
      denied.error.code,
      "UNKNOWN_TOOL",
      "ordinary runtime tools cannot submit native answers",
    );
  } finally {
    d.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stdio MCP elicits directly from host; cancellation, malformed answers and unsupported clients never adopt units", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-session-mcp-"));
  const runtime = await ensureRuntime(root),
    workspaceId = runtime.descriptor.workspaceId;
  const call = (tool: string, input = {}) =>
    runtimeRequest(runtime, "/call", {
      tool,
      input: { workspaceId, ...input },
    });
  const clients: Client[] = [];
  async function connect(capabilities: any) {
    const client = new Client(
      { name: "controlled-fixture-host", version: "1" },
      { capabilities },
    );
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...process.execArgv, resolve("apps/server/plugin-mcp.ts")],
        stderr: "pipe",
      }),
    );
    await client.callTool({ name: "workspace_open", arguments: { root } });
    return client;
  }
  const unwrap = (result: any) => JSON.parse(result.content[0].text);
  try {
    const drawingId = await importFixture(root, call);
    const unsupported = await connect({});
    const fallback = unwrap(
      await unsupported.callTool({
        name: "review_in_session",
        arguments: { workspaceId, drawingId, action: "units" },
      }),
    );
    assert.equal(fallback.reason, "HOST_FORM_UNAVAILABLE");
    assert.ok(fallback.review.url.includes("/review#"));
    const urlOnly = await connect({ elicitation: { url: {} } });
    const urlFallback = unwrap(
      await urlOnly.callTool({
        name: "review_in_session",
        arguments: { workspaceId, drawingId, action: "units" },
      }),
    );
    assert.equal(urlFallback.reason, "HOST_FORM_UNAVAILABLE");
    const client = await connect({ elicitation: { form: {} } });
    let action: "accept" | "cancel" | "decline" = "cancel",
      content: any;
    let seen = 0;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      seen++;
      assert.equal(request.params.mode, "form");
      assert.ok(request.params.message.includes(root));
      return { action, ...(action === "accept" ? { content } : {}) };
    });
    const review = () =>
      client
        .callTool({
          name: "review_in_session",
          arguments: { workspaceId, drawingId, action: "units" },
        })
        .then(unwrap);
    assert.equal((await review()).saved, false);
    action = "decline";
    assert.equal((await review()).saved, false);
    action = "accept";
    content = { unit: "米 m", evidence: "" };
    const malformed = await review();
    assert.equal(malformed.saved, false);
    assert.equal(malformed.reason, "HOST_FORM_FAILED");
    content = { unit: "毫米 mm", evidence: "测试宿主返回的受控样本尺寸依据" };
    const saved = await review();
    assert.equal(saved.saved, true, JSON.stringify(saved));
    assert.equal(saved.result.metresPerDrawingUnit, 0.001);
    assert.equal(seen, 4);
    const tools = await client.listTools();
    const schema = tools.tools.find(
      (t) => t.name === "review_in_session",
    )!.inputSchema;
    assert.ok(
      !("content" in schema.properties!) &&
        !("userConfirmed" in schema.properties!),
    );
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await runtimeRequest(runtime, "/stop").catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    rmSync(root, { recursive: true, force: true });
  }
});
