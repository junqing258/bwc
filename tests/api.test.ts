import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, compactPayload } from "../apps/server/main.ts";
import { HostBridge, parseMessageOperation } from "../apps/server/host.ts";
import { id, now } from "../apps/server/util.ts";

test("project_open accepts configured local development origins and rejects other origins", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-origin-")),
    app = createApplication({ dataDir: root, port: 0 });
  try {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.server.address() as any).port}`,
      project = app.service.create("Origin regression");
    const request = async (origin?: string) => {
      const response = await fetch(`${url}/api/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin === undefined ? {} : { Origin: origin }),
        },
        body: JSON.stringify({
          tool: "project_open",
          input: { projectId: project.projectId },
        }),
      });
      return { status: response.status, data: await response.json() };
    };
    for (const origin of [
      undefined,
      "http://127.0.0.1:4301",
      "http://localhost:4301",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]) {
      const response = await request(origin);
      assert.equal(response.status, 200, origin);
      assert.equal(response.data.projectId, project.projectId, origin);
    }
    for (const origin of [
      "https://external.invalid",
      "http://127.0.0.1:4302",
      "http://localhost.evil.invalid:4301",
      "null",
    ]) {
      const response = await request(origin);
      assert.equal(response.status, 422, origin);
      assert.equal(response.data.error.code, "INVALID_ORIGIN", origin);
    }
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP schemas, origin checks, MCP project binding and data policy share domain results", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-http-")),
    app = createApplication({ dataDir: root, port: 0 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as any).port,
    url = `http://127.0.0.1:${port}`;
  const request = async (
    path: string,
    input?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(url + "/api/" + path, {
      ...(input === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(input) }),
      headers: { "Content-Type": "application/json", ...headers },
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    assert.equal((await request("health")).data.ok, true);
    assert.equal(
      (
        await request(
          "projects",
          { name: "blocked" },
          { Origin: "https://external.invalid" },
        )
      ).status,
      422,
    );
    const p = (await request("projects", { name: "HTTP reference" })).data,
      pid = p.projectId;
    await app.service.fixture();
    let j = (
      await request("call", {
        tool: "dwg_import",
        input: { projectId: pid, fileRef: "controlled", operationId: id("op") },
      })
    ).data;
    while (["queued", "running"].includes(j.status)) {
      await new Promise((r) => setTimeout(r, 20));
      j = app.service.getJob({ projectId: pid, jobId: j.id });
    }
    const bad = await request("call", {
      tool: "dwg_query",
      input: { projectId: pid, filter: { sql: "select *" } },
    });
    assert.equal(bad.data.error.code, "INVALID_INPUT");
    const s = app.service.catalog.open(pid),
      ctx = s.context(),
      session = app.bridge.create({ projectId: pid });
    s.put("turn", {
      id: "test_turn",
      sessionId: session.id,
      intentId: "none",
      status: "running",
      context: { workingRevision: ctx.revision.id },
      text: "只读查询",
    });
    const input = {
      tool: "dwg_summary",
      input: { projectId: pid },
      projectId: pid,
      sessionId: session.id,
    };
    assert.equal((await request("mcp", input)).status, 403);
    const authorized = await request("mcp", input, {
      Authorization: `Bearer ${app.token}`,
    });
    assert.equal(authorized.data.sourceEntityCount, 5);
    assert.equal(s.all("tool_call").length, 1);
    assert.equal(s.all("data_send").length, 1);
    assert.equal(
      (
        await request(
          "mcp",
          { ...input, input: { projectId: id("p") } },
          { Authorization: `Bearer ${app.token}` },
        )
      ).data.error.code,
      "SESSION_PROJECT_MISMATCH",
    );
    const before = s.all("revision").length;
    assert.equal(
      (
        await request(
          "mcp",
          {
            ...input,
            tool: "change_revert",
            input: { projectId: pid, changeId: "fake", operationId: id("op") },
          },
          { Authorization: `Bearer ${app.token}` },
        )
      ).data.error.code,
      "INTENT_MISMATCH",
    );
    assert.equal(s.all("revision").length, before);
    const preview = app.service.preview({ projectId: pid });
    const redacted = compactPayload(preview, "summary");
    assert.deepEqual(redacted.occurrences, { omittedByDataPolicy: true });
    assert.ok(Array.isArray(compactPayload(preview, "geometry").occurrences));
    const ev = s.events("*");
    assert.ok(ev.length > 0);
    assert.equal(s.events("*", ev.at(-1)!.sequence).length, 0);
  } finally {
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("message intent is exact, negations and hypothetical language cannot authorize edits", () => {
  assert.equal(
    parseMessageOperation("将选中轮廓的计量厚度设为150mm并重算")?.kind,
    "set_measurement_parameter",
  );
  for (const text of [
    "不要将选中轮廓的厚度设为150mm",
    "如果厚度设为150mm会怎么样",
    "检查一下，厚度设为150mm",
    "建议将厚度设为150mm",
    "厚度为150mm",
    "是否将厚度设为150mm",
  ])
    assert.equal(parseMessageOperation(text), null, text);
});
