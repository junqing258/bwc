// Real Codex protocol probe, controlled fixture only. No model turn or real user answer.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonRpcProcess } from "../apps/server/rpc.ts";
import {
  ensureRuntime,
  runtimeRequest,
} from "../apps/server/runtime-client.ts";
import { worker } from "../apps/server/workers.ts";
import { atomicJson } from "../apps/server/util.ts";

const root = mkdtempSync(join(tmpdir(), "bwc-codex-form-"));
const runtime = await ensureRuntime(root),
  workspaceId = runtime.descriptor.workspaceId;
let observed: any = null;
const client = new JsonRpcProcess(
  "codex",
  [
    "-c",
    `mcp_servers.bwc_session_probe.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.bwc_session_probe.args=${JSON.stringify([...process.execArgv, resolve("apps/server/plugin-mcp.ts")])}`,
    "app-server",
  ],
  {
    cwd: root,
    onNotification: () => {},
    onExit: () => {},
    onRequest: async (method, params) => {
      assert.equal(method, "mcpServer/elicitation/request");
      assert.equal(params.mode, "form");
      observed = {
        method,
        mode: params.mode,
        fields: Object.keys(params.requestedSchema.properties),
        server: params.serverName,
      };
      return { action: "cancel", content: null, _meta: null };
    },
  },
);
try {
  const init = await client.request("initialize", {
    clientInfo: { name: "bwc_form_probe", version: "0.4.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
  await worker("cad", { mode: "fixture", output: join(root, "sample.dwg") });
  const call = (tool: string, input = {}) =>
    runtimeRequest(runtime, "/call", {
      tool,
      input: { workspaceId, ...input },
    });
  const imported = await call("drawing_import", {
    path: "sample.dwg",
    operationId: "probe",
  });
  let importedOk = false;
  for (let i = 0; i < 200; i++) {
    const job = await call("job_get", {
      drawingId: imported.drawingId,
      jobId: imported.id,
    });
    if (!["queued", "running"].includes(job.status)) {
      assert.ok(["succeeded", "partial"].includes(job.status));
      importedOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(importedOk);
  const started = await client.request("thread/start", {
    cwd: root,
    ephemeral: true,
  });
  const threadId = started.thread.id;
  const inventory = await client.request("mcpServerStatus/list", {
    threadId,
    limit: 100,
  });
  assert.ok(inventory.data.some((s: any) => s.name === "bwc_session_probe"));
  const tool = async (name: string, args: object) => {
    const result = await client.request("mcpServer/tool/call", {
      threadId,
      server: "bwc_session_probe",
      tool: name,
      arguments: args,
    });
    const value = JSON.parse(result.content[0].text);
    assert.ok(!result.isError, JSON.stringify(value));
    return value;
  };
  await tool("workspace_open", { root });
  const result = await tool("review_in_session", {
    workspaceId,
    drawingId: imported.drawingId,
    action: "units",
  });
  assert.ok(observed, JSON.stringify(result));
  assert.equal(result.saved, false);
  assert.equal(result.action, "cancel");
  const report = {
    at: new Date().toISOString(),
    codex: init.userAgent,
    observed,
    result,
    fixtureOnly: true,
    modelTaskSent: false,
    simulatedAppClientResponse: "cancel",
    visualUiValidated: false,
  };
  atomicJson(resolve("docs/evidence/session-review-host-probe.json"), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.stop();
  await runtimeRequest(runtime, "/stop").catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  rmSync(root, { recursive: true, force: true });
}
