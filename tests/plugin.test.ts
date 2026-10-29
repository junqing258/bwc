import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ensureRuntime,
  runtimeRequest,
  connectRuntime,
} from "../apps/server/runtime-client.ts";
import { WorkspaceDomain } from "../apps/server/workspace-domain.ts";
import { modelOutput } from "../apps/server/model-output.ts";
import { atomicJson } from "../apps/server/util.ts";
import { worker } from "../apps/server/workers.ts";

async function waitRuntimeJob(
  c: Awaited<ReturnType<typeof ensureRuntime>>,
  drawingId: string,
  jobId: string,
) {
  for (let i = 0; i < 200; i++) {
    const job = await runtimeRequest(c, "/call", {
      tool: "job_get",
      input: { workspaceId: c.descriptor.workspaceId, drawingId, jobId },
    });
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("job timeout");
}
async function stop(c: Awaited<ReturnType<typeof ensureRuntime>>) {
  await runtimeRequest(c, "/stop").catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
}
function value(result: any) {
  return JSON.parse(result.content[0].text);
}

test("independent stdio MCP binds two workspaces and jobs survive MCP disconnect", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "bwc-mcp-a-")),
    rootB = mkdtempSync(join(tmpdir(), "bwc-mcp-b-"));
  const a = await ensureRuntime(rootA),
    b = await ensureRuntime(rootB);
  const client = new Client({ name: "bwc-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...process.execArgv, resolve("apps/server/plugin-mcp.ts")],
    cwd: tmpdir(),
    stderr: "pipe",
  });
  try {
    await worker("cad", { mode: "fixture", output: join(rootA, "a.dwg") });
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of [
      "workspace_open",
      "drawing_import",
      "review_prepare",
      "viewer_open",
      "component_takeoff",
    ])
      assert.ok(tools.tools.some((t) => t.name === name));
    for (const name of [
      "project_open",
      "project_list",
      "component_review",
      "data_policy_set",
      "change_apply",
    ])
      assert.ok(!tools.tools.some((t) => t.name === name));
    const openedA = value(
      await client.callTool({
        name: "workspace_open",
        arguments: { root: rootA },
      }),
    );
    const openedB = value(
      await client.callTool({
        name: "workspace_open",
        arguments: { root: rootB },
      }),
    );
    assert.equal(openedA.workspaceId, a.descriptor.workspaceId);
    assert.equal(openedB.workspaceId, b.descriptor.workspaceId);
    const imported = value(
      await client.callTool({
        name: "drawing_import",
        arguments: {
          workspaceId: a.descriptor.workspaceId,
          path: "a.dwg",
          operationId: "mcp-import",
        },
      }),
    );
    assert.ok(imported.id, JSON.stringify(imported));
    const bad = value(
      await client.callTool({
        name: "job_get",
        arguments: {
          workspaceId: b.descriptor.workspaceId,
          drawingId: imported.drawingId,
          jobId: imported.id,
        },
      }),
    );
    assert.equal(bad.error.code, "DRAWING_NOT_FOUND");
    await client.close();
    assert.equal(
      (await connectRuntime(rootA))!.descriptor.instanceId,
      a.descriptor.instanceId,
    );
    const job = await waitRuntimeJob(a, imported.drawingId, imported.id);
    assert.ok(
      ["succeeded", "partial"].includes(job.status),
      JSON.stringify(job),
    );
    const viewer = await runtimeRequest(a, "/call", {
      tool: "viewer_open",
      input: {
        workspaceId: a.descriptor.workspaceId,
        drawingId: imported.drawingId,
      },
    });
    const url = new URL(viewer.url),
      token = url.hash.slice(1);
    const denied = await fetch(`${url.origin}/review-api/state`);
    assert.equal(denied.status, 422);
    const local = await fetch(`${url.origin}/review-api/state`, {
      headers: { "X-Bwc-Review": token },
    });
    assert.equal(local.status, 200);
    const state = await local.json();
    assert.ok(Array.isArray(state.preview.occurrences));
    assert.equal(state.scopeCoverage, "unknown");
    const originDenied = await fetch(`${url.origin}/review-api/state`, {
      headers: { "X-Bwc-Review": token, Origin: "https://example.com" },
    });
    assert.equal(originDenied.status, 422);
  } finally {
    await client.close().catch(() => {});
    await stop(a);
    await stop(b);
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("review batches reject stale versions, roll back partial batches and keep confirmation out of model tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-review-"));
  const d = new WorkspaceDomain(root, "review-test");
  const workspaceId = d.catalog.manifest.workspaceId;
  try {
    await worker("cad", { mode: "fixture", output: join(root, "a.dwg") });
    const imported = await d.call("drawing_import", {
      workspaceId,
      path: "a.dwg",
      operationId: "import",
    });
    let job: any;
    for (let i = 0; i < 100; i++) {
      job = await d.call("job_get", {
        workspaceId,
        drawingId: imported.drawingId,
        jobId: imported.id,
      });
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(["partial", "succeeded"].includes(job.status));
    const drawingId = imported.drawingId,
      s = d.catalog.open(drawingId);
    // Unit adoption uses the same trusted Web path and version comparison as component review.
    const unitReview = d.reviews.open(drawingId);
    await d.reviews.adoptUnits(unitReview.token, {
      fingerprint: unitReview.batch.fingerprint,
      metresPerDrawingUnit: 0.001,
      evidence: "受控样本的毫米单位参考答案",
    });
    assert.equal(s.context().snapshot.units.confirmed, true);
    assert.equal(d.reviews.state(unitReview.token).stale, true);
    await d.call("component_recognize", { workspaceId, drawingId });
    const session = d.reviews.open(drawingId),
      state = d.reviews.state(session.token);
    assert.ok(state.components.length > 0);
    const c = state.components[0];
    const review = {
      componentId: c.id,
      expectedVersion: c.version,
      status: "confirmed",
      category: c.category === "未分类" ? "板" : c.category,
      label: c.label,
      floor: "一层",
      material: "混凝土",
      thicknessMm: 150,
      evidence: "逐项对照受控样本闭合边界",
    };
    await assert.rejects(() =>
      d.reviews.submit(session.token, {
        fingerprint: "wrong",
        reviews: [review],
      }),
    );
    await assert.rejects(() =>
      d.reviews.submit(session.token, {
        fingerprint: session.batch.fingerprint,
        reviews: [review, { ...review, componentId: "unknown" }],
      }),
    );
    assert.equal(s.get("component", c.id).version, c.version);
    const second = state.components[1];
    if (second) {
      await assert.rejects(() =>
        d.reviews.submit(session.token, {
          fingerprint: session.batch.fingerprint,
          reviews: [
            review,
            {
              ...review,
              componentId: second.id,
              expectedVersion: second.version,
              category: "未分类",
            },
          ],
        }),
      );
      assert.equal(
        s.get("component", c.id).version,
        c.version,
        "an invalid later member rolls back earlier review writes",
      );
    }
    await d.reviews.submit(session.token, {
      fingerprint: session.batch.fingerprint,
      reviews: [review],
    });
    assert.equal(s.get("component", c.id).status, "confirmed");
    assert.equal(d.reviews.state(session.token).stale, true);
    await assert.rejects(() =>
      d.reviews.submit(session.token, {
        fingerprint: session.batch.fingerprint,
        reviews: [review],
      }),
    );
    const measure = await d.call("component_takeoff", {
      workspaceId,
      drawingId,
      componentIds: [c.id],
      quantityKind: "business_count",
      operationId: "component-count",
    });
    for (let i = 0; i < 100; i++) {
      job = await d.call("job_get", {
        workspaceId,
        drawingId,
        jobId: measure.id,
      });
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(job.result.knownSubtotal, 1);
    assert.equal(d.reviews.state(session.token).scopeCoverage, "unknown");
    const geometrySession = d.reviews.open(drawingId);
    d.reviews.setPolicy(geometrySession.token, { mode: "geometry" });
    assert.deepEqual(d.catalog.policy().snapshotIds, [s.context().snapshot.id]);
    assert.ok(s.all("review_event").length);
    assert.ok(d.auditStore.all("policy_audit").length);
  } finally {
    d.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model boundary filters nested geometry, pagination and worker errors without copying payloads into audit", () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-boundary-"));
  const d = new WorkspaceDomain(root, "boundary-test");
  try {
    const output = modelOutput(d.auditStore, "job_get", {
      result: {
        geometry: { vertices: [[123.567, 890, 0]] },
        items: Array.from({ length: 70 }, (_, id) => ({
          id,
          matrix: [123.567, 890],
        })),
      },
      error: {
        code: "WORKER_FAILED",
        message: "raw secret geometry 123.567",
        details: { points: [123.567, 890] },
      },
    });
    assert.equal(output.result.geometry.omittedByDataPolicy, true);
    assert.equal(output.result.items.total, 70);
    assert.equal(output.result.items.truncated, true);
    assert.ok(!JSON.stringify(output).includes("123.567"));
    assert.ok(
      !JSON.stringify(d.auditStore.all("data_send")).includes("123.567"),
    );
  } finally {
    d.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale descriptors do not claim locks; held but unresponsive runtime cannot be taken over", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-lock-fault-"));
  let connection = await ensureRuntime(root);
  try {
    const prior = connection.descriptor;
    await stop(connection);
    atomicJson(join(root, ".bwc/run/runtime.json"), {
      ...prior,
      pid: process.pid,
      heartbeat: "2000-01-01T00:00:00.000Z",
    });
    connection = await ensureRuntime(root);
    assert.notEqual(connection.descriptor.instanceId, prior.instanceId);
    process.kill(connection.descriptor.pid, "SIGSTOP");
    try {
      await assert.rejects(
        () => ensureRuntime(root, { timeoutMs: 400 }),
        (e) => (e as any).code === "RUNTIME_UNAVAILABLE",
      );
    } finally {
      process.kill(connection.descriptor.pid, "SIGCONT");
    }
    assert.equal(
      (await connectRuntime(root))!.descriptor.instanceId,
      connection.descriptor.instanceId,
    );
    process.kill(connection.descriptor.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    const after = await ensureRuntime(root);
    assert.notEqual(
      after.descriptor.instanceId,
      connection.descriptor.instanceId,
    );
    connection = after;
  } finally {
    await stop(connection);
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock is released when a launcher crashes before ready handshake", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-before-ready-"));
  mkdirSync(join(root, ".bwc/run"), { recursive: true });
  let connection: Awaited<ReturnType<typeof ensureRuntime>> | undefined;
  try {
    const child = spawn(
      process.env.BWC_LOCK_PYTHON ?? "python3",
      [
        resolve("scripts/runtime-lock.py"),
        join(root, ".bwc/run/runtime.lock"),
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((res, rej) => {
      child.once("error", rej);
      child.once("close", () => res());
    });
    assert.equal(existsSync(join(root, ".bwc/run/runtime.json")), false);
    connection = await ensureRuntime(root);
    assert.equal(connection.descriptor.state, "ready");
  } finally {
    if (connection) await stop(connection);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime crash during a geometry job leaves interrupted work without automatic replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-job-crash-"));
  let connection = await ensureRuntime(root);
  try {
    await worker("cad", { mode: "fixture", output: join(root, "sample.dwg") });
    const workspaceId = connection.descriptor.workspaceId;
    const call = (tool: string, input: object = {}) =>
      runtimeRequest(connection, "/call", {
        tool,
        input: { workspaceId, ...input },
      });
    const imported = await call("drawing_import", {
      path: "sample.dwg",
      operationId: "import-before-crash",
    });
    const parsed = await waitRuntimeJob(
      connection,
      imported.drawingId,
      imported.id,
    );
    assert.ok(["succeeded", "partial"].includes(parsed.status));
    const drawingId = imported.drawingId;
    const selection = await call("selection_create", {
      drawingId,
      filter: { layers: ["受控楼板轮廓"] },
    });
    const input = {
      drawingId,
      selectionSet: { id: selection.id, version: 1 },
      quantityKind: "entity_count",
      operationId: "crash-count",
    };
    const queued = await call("takeoff_run", input);
    assert.ok(queued.id);
    process.kill(connection.descriptor.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    connection = await ensureRuntime(root);
    const recovered = await call("job_get", { drawingId, jobId: queued.id });
    assert.equal(recovered.status, "interrupted");
    const retry = await call("takeoff_run", input);
    assert.equal(retry.id, queued.id);
    assert.equal(retry.status, "interrupted");
  } finally {
    await stop(connection);
    rmSync(root, { recursive: true, force: true });
  }
});
