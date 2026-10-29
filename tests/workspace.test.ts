import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceDomain } from "../apps/server/workspace-domain.ts";
import {
  ensureRuntime,
  runtimeRequest,
  connectRuntime,
} from "../apps/server/runtime-client.ts";
import { worker } from "../apps/server/workers.ts";
import { atomicJson } from "../apps/server/util.ts";

async function fixture(root: string) {
  const path = join(root, "input.dwg");
  await worker("cad", { mode: "fixture", output: path });
  return path;
}
async function waitJob(
  domain: WorkspaceDomain,
  workspaceId: string,
  drawingId: string,
  jobId: string,
) {
  for (let i = 0; i < 200; i++) {
    const job = await domain.call("job_get", { workspaceId, drawingId, jobId });
    if (!["queued", "running"].includes(job.status)) {
      assert.notEqual(job.status, "failed", JSON.stringify(job));
      return job;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job timed out");
}
test("workspace multi-drawing revisions, immutable inputs, manifests, policy and headless export", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-workspace-"));
  const domain = new WorkspaceDomain(root, "instance-1");
  const workspaceId = domain.catalog.manifest.workspaceId;
  try {
    await fixture(root);
    const a = await domain.call("drawing_import", {
      workspaceId,
      path: "input.dwg",
      operationId: "a",
    });
    assert.ok(a.drawingId, JSON.stringify(a));
    const ja = await waitJob(domain, workspaceId, a.drawingId, a.id);
    const b = await domain.call("drawing_import", {
      workspaceId,
      path: "input.dwg",
      operationId: "b",
    });
    const jb = await waitJob(domain, workspaceId, b.drawingId, b.id);
    assert.notEqual(a.drawingId, b.drawingId);
    assert.equal(
      domain.catalog.open(a.drawingId).current().id,
      ja.workingRevision,
    );
    assert.equal(
      domain.catalog.open(b.drawingId).current().id,
      jb.workingRevision,
    );
    const members = [
      {
        drawingId: a.drawingId,
        revisionId: ja.workingRevision,
        snapshotId: ja.geometrySnapshotId,
      },
      {
        drawingId: b.drawingId,
        revisionId: jb.workingRevision,
        snapshotId: jb.geometrySnapshotId,
      },
    ];
    const manifest = domain.catalog.freeze(members);
    const next = await domain.call("drawing_import", {
      workspaceId,
      drawingId: a.drawingId,
      path: "input.dwg",
      operationId: "a2",
    });
    await waitJob(domain, workspaceId, a.drawingId, next.id);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          domain.catalog.inputManifest(manifest.id as string).members,
        ),
      ),
      members.sort((a, b) => a.drawingId.localeCompare(b.drawingId)),
    );
    assert.equal(
      domain.catalog.open(b.drawingId).current().id,
      jb.workingRevision,
    );
    assert.throws(() =>
      domain.catalog.freeze([
        { ...members[0], snapshotId: members[1].snapshotId },
      ]),
    );
    const again = await domain.call("drawing_import", {
      workspaceId,
      path: "input.dwg",
      operationId: "a",
    });
    assert.equal(again.id, a.id);
    const store = domain.catalog.open(b.drawingId);
    const occurrence = store
      .occurrences(jb.geometrySnapshotId)
      .find((o) => o.geometry)!;
    let out = await domain.call("dwg_get", {
      workspaceId,
      drawingId: b.drawingId,
      occurrenceId: occurrence.occurrenceId,
    });
    assert.deepEqual(out.geometry, { omittedByDataPolicy: true });
    domain.catalog.setPolicy("geometry", "test_human", [ja.geometrySnapshotId]);
    out = await domain.call("dwg_get", {
      workspaceId,
      drawingId: b.drawingId,
      occurrenceId: occurrence.occurrenceId,
    });
    assert.deepEqual(out.geometry, { omittedByDataPolicy: true });
    domain.catalog.setPolicy("geometry", "test_human", [jb.geometrySnapshotId]);
    out = await domain.call("dwg_get", {
      workspaceId,
      drawingId: b.drawingId,
      occurrenceId: occurrence.occurrenceId,
    });
    assert.equal(out.geometry.kind, occurrence.geometry!.kind);
    assert.equal(
      (await domain.call("data_policy_set", { workspaceId, mode: "geometry" }))
        .error.code,
      "UNKNOWN_TOOL",
    );
    assert.equal(
      (
        await domain.call("dwg_get", {
          workspaceId: "other",
          drawingId: b.drawingId,
          occurrenceId: "x",
        })
      ).error.code,
      "WORKSPACE_MISMATCH",
    );
    domain.catalog.setPolicy("summary", "test_human");
    const exp = await domain.call("result_export", {
      workspaceId,
      drawingId: b.drawingId,
      operationId: "export",
    });
    const exportJob = await waitJob(domain, workspaceId, b.drawingId, exp.id);
    assert.ok(existsSync(join(exportJob.result.outputPath, "report.json")));
    assert.ok(store.all("data_send").length > 0);
    assert.equal(
      domain.catalog.db.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );
    const artifact = store.context().snapshot;
    assert.ok(existsSync(join(root, ".bwc", artifact.artifactPath)));
  } finally {
    domain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace refuses newer schemas and discovers only allowed local DWGs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-discover-"));
  const outside = mkdtempSync(join(tmpdir(), "bwc-outside-"));
  let domain = new WorkspaceDomain(root, "test");
  try {
    writeFileSync(join(root, "drawing.dwg"), "AC1032");
    writeFileSync(join(outside, "other.dwg"), "AC1032");
    symlinkSync(join(outside, "other.dwg"), join(root, "external.dwg"));
    const workspaceId = domain.catalog.manifest.workspaceId;
    assert.equal(domain.discover().count, 1);
    assert.equal(
      (
        await domain.call("drawing_import", {
          workspaceId,
          path: "external.dwg",
          operationId: "external",
        })
      ).error.code,
      "EXTERNAL_IMPORT_REQUIRED",
    );
    const path = join(root, ".bwc/workspace.json"),
      manifest = domain.catalog.manifest;
    domain.close();
    atomicJson(path, { ...manifest, schemaVersion: 99 });
    assert.throws(() => new WorkspaceDomain(root, "test"), /升级/);
    atomicJson(path, manifest);
    const db = new DatabaseSync(join(root, ".bwc/workspace.sqlite"));
    db.exec("PRAGMA user_version=99");
    db.close();
    assert.throws(() => new WorkspaceDomain(root, "test"), /版本/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("competing clients share one OS-locked runtime and reconnect after client exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-runtime-"));
  let connection: Awaited<ReturnType<typeof ensureRuntime>> | undefined;
  try {
    const connections = await Promise.all([
      ensureRuntime(root),
      ensureRuntime(root),
      ensureRuntime(root),
    ]);
    connection = connections[0];
    assert.equal(
      new Set(connections.map((c) => c.descriptor.instanceId)).size,
      1,
    );
    assert.equal(
      statSync(join(root, ".bwc/run/credentials.json")).mode & 0o777,
      0o600,
    );
    assert.equal(
      (
        await runtimeRequest(connection, "/call", {
          tool: "workspace_status",
          input: { workspaceId: connection.descriptor.workspaceId },
        })
      ).instanceId,
      connection.descriptor.instanceId,
    );
    const reconnected = await connectRuntime(root);
    assert.equal(
      reconnected!.descriptor.instanceId,
      connection.descriptor.instanceId,
    );
    assert.equal(
      (
        await runtimeRequest(connection, "/call", {
          tool: "workspace_status",
          input: { workspaceId: "wrong" },
        })
      ).error.code,
      "WORKSPACE_MISMATCH",
    );
    await runtimeRequest(connection, "/stop");
    await new Promise((r) => setTimeout(r, 200));
    const next = await ensureRuntime(root);
    connection = next;
    assert.notEqual(
      next.descriptor.instanceId,
      connections[0].descriptor.instanceId,
    );
    assert.equal(
      next.descriptor.workspaceId,
      connections[0].descriptor.workspaceId,
    );
  } finally {
    if (connection) await runtimeRequest(connection, "/stop").catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart reconciles committed imports and interrupts only old uncommitted work", async () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-reconcile-"));
  let d = new WorkspaceDomain(root, "old-instance");
  try {
    await fixture(root);
    const workspaceId = d.catalog.manifest.workspaceId;
    const imported = await d.call("drawing_import", {
      workspaceId,
      path: "input.dwg",
      operationId: "committed",
    });
    await waitJob(d, workspaceId, imported.drawingId, imported.id);
    const store = d.catalog.open(imported.drawingId),
      job = store.get<any>("job", imported.id);
    store.put("job", { ...job, status: "running", result: undefined });
    store.put("job", {
      id: "job_uncommitted",
      kind: "takeoff",
      operationId: "unfinished",
      requestFingerprint: "fingerprint",
      status: "running",
      stage: "takeoff",
      createdAt: new Date().toISOString(),
      ownerInstanceId: "old-instance",
    });
    d.close();
    d = new WorkspaceDomain(root, "new-instance");
    const reopened = d.catalog.open(imported.drawingId),
      recovered = reopened.get<any>("job", imported.id);
    assert.ok(["succeeded", "partial"].includes(recovered.status));
    assert.equal(recovered.result.recoveredFromCommit, true);
    assert.equal(
      reopened.get<any>("job", "job_uncommitted").status,
      "interrupted",
    );
    assert.equal(reopened.all("revision").length, 1);
  } finally {
    d.close();
    rmSync(root, { recursive: true, force: true });
  }
});
