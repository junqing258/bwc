// Runs only emitted code and shipped Workers from an installation outside the checkout.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const installed = resolve(process.argv[2]);
assert.ok(
  !installed.startsWith(resolve(import.meta.dirname, "..") + "/"),
  "Use an installed package outside the checkout",
);
process.env.BWC_PYTHON = process.argv[3];
const load = (relative) =>
  import(pathToFileURL(join(installed, relative)).href);
const { ensureRuntime, runtimeRequest } = await load(
  "apps/server/runtime-client.js",
);
const { worker } = await load("apps/server/workers.js");
const { Client } = await load(
  "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
);
const { StdioClientTransport } = await load(
  "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js",
);
const root = mkdtempSync(join(tmpdir(), "bwc-installed-"));
const client = new Client({
  name: "installed-package-acceptance",
  version: "1",
});
let connection;
const permissions = [];
function readonly(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  permissions.push([path, stat.mode & 0o777]);
  if (stat.isDirectory())
    for (const name of readdirSync(path)) readonly(join(path, name));
  chmodSync(path, stat.mode & ~0o222);
}
const summary = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  python: process.env.BWC_PYTHON,
  installedOutsideCheckout: true,
  readonlyInstallation: true,
};
try {
  readonly(installed);
  const doctor = spawnSync(
    process.execPath,
    [join(installed, "scripts/doctor.mjs")],
    { env: process.env, encoding: "utf8", cwd: root },
  );
  assert.equal(doctor.status, 0, doctor.stdout);
  summary.dependencies = JSON.parse(doctor.stdout).ok;
  await worker("cad", { mode: "fixture", output: join(root, "sample.dwg") });
  connection = await ensureRuntime(root);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(installed, "apps/server/plugin-mcp.js")],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => typeof v === "string"),
      ),
      stderr: "pipe",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse(result.content[0].text);
    assert.ok(!value.error, JSON.stringify(value));
    return value;
  };
  const opened = await call("workspace_open", { root }),
    workspaceId = opened.workspaceId;
  const tool = (name, input = {}) => call(name, { workspaceId, ...input });
  const imported = await tool("drawing_import", {
    path: "sample.dwg",
    operationId: "installed-import",
  });
  const drawingId = imported.drawingId;
  const wait = async (jobId) => {
    for (let i = 0; i < 200; i++) {
      const job = await tool("job_get", { drawingId, jobId });
      if (!["queued", "running"].includes(job.status)) {
        assert.ok(
          ["partial", "succeeded"].includes(job.status),
          JSON.stringify(job),
        );
        return job;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("job timeout");
  };
  const parsed = await wait(imported.id);
  summary.cadParsed = true;
  const select = await tool("selection_create", {
    drawingId,
    workingRevision: parsed.workingRevision,
    geometrySnapshotId: parsed.geometrySnapshotId,
    filter: { layers: ["受控楼板轮廓"], space: "model" },
  });
  assert.ok(select.id);
  const measured = await tool("takeoff_run", {
    drawingId,
    workingRevision: parsed.workingRevision,
    geometrySnapshotId: parsed.geometrySnapshotId,
    selectionSet: { id: select.id, version: 1 },
    quantityKind: "entity_count",
    operationId: "installed-count",
  });
  const count = await wait(measured.id);
  assert.equal(count.result.knownSubtotal, 1);
  summary.geometryCalculated = true;
  const exported = await tool("result_export", {
    drawingId,
    resultVersion: count.result.id,
    operationId: "installed-export",
  });
  const delivered = await wait(exported.id);
  const report = JSON.parse(
    readFileSync(join(delivered.result.outputPath, "report.json"), "utf8"),
  );
  assert.equal(report.result.knownSubtotal, 1);
  summary.exported = true;
  const manifest = await tool("input_manifest_create", {
    members: [
      {
        drawingId,
        revisionId: parsed.workingRevision,
        snapshotId: parsed.geometrySnapshotId,
      },
    ],
  });
  const coverage = await tool("scope_coverage_prepare", {
    manifestId: manifest.id,
    scope: {
      discipline: "建筑",
      categories: ["板"],
      drawings: [{ drawingId, floor: null, viewPurpose: "平面" }],
    },
  });
  const coveragePage = await tool("scope_coverage_status", {
    coverageId: coverage.coverageId,
    limit: 1,
  });
  assert.equal(coveragePage.status, "incomplete");
  assert.equal(coveragePage.sourcePage.items.length, 1);
  assert.ok(coveragePage.drawings[0].counts.unassigned > 0);
  const scopeResult = await tool("scope_takeoff_run", {
    coverageId: coverage.coverageId,
    quantityKind: "business_count",
    operationId: "installed-scope-partial",
  });
  assert.equal(scopeResult.scopeComplete, false);
  assert.equal(scopeResult.completeTotal, null);
  const scopeExport = await tool("scope_result_export", {
    scopeResultId: scopeResult.id,
    operationId: "installed-scope-export",
  });
  const scopeDelivery = await wait(scopeExport.id);
  const scopeReport = JSON.parse(
    readFileSync(join(scopeDelivery.result.path, "scope-report.json"), "utf8"),
  );
  assert.equal(scopeReport.result.completeTotal, null);
  assert.ok(scopeReport.inputManifest.members.length);
  summary.coveragePreservesMissingSources = true;
  summary.scopeReportExported = true;
  const viewer = await tool("viewer_open", {
    drawingId,
    coverageId: coverage.coverageId,
  });
  const url = new URL(viewer.url);
  assert.equal((await fetch(`${url.origin}/review`)).status, 200);
  summary.viewerServed = true;
  summary.toolCount = (await client.listTools()).tools.length;
  await client.close();
  const reconnected = await ensureRuntime(root);
  assert.equal(
    reconnected.descriptor.instanceId,
    connection.descriptor.instanceId,
  );
  summary.mcpDisconnectSurvives = true;
  assert.ok(!readdirSync(join(installed, "apps/server")).includes("host.js"));
  summary.legacyHostExcluded = true;
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close().catch(() => {});
  if (connection) await runtimeRequest(connection, "/stop").catch(() => {});
  for (const [path, mode] of permissions.reverse()) chmodSync(path, mode);
  await new Promise((r) => setTimeout(r, 250));
  rmSync(root, { recursive: true, force: true });
}
