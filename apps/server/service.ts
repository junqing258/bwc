import {
  importReport,
  groupIssues,
  diagnosticHandles,
  diagnosticAdvice,
} from "./diagnostics.ts";
import { isReparseInstruction } from "./maintenance.ts";
import { primitives } from "./geometry.ts";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { basename, join, resolve, relative } from "node:path";
import { Catalog, ProjectStore } from "./store.ts";
import {
  assert,
  atomicJson,
  canonical,
  DomainError,
  fail,
  hash,
  id,
  now,
  within,
} from "./util.ts";
import { ROOT, worker } from "./workers.ts";
import { FilterSchema, OperationSchema } from "./schemas.ts";
import type {
  Artifact,
  Business,
  Change,
  Drawing,
  Filter,
  Intent,
  Job,
  NativePatch,
  Occurrence,
  Operation,
  Project,
  Revision,
  Selection,
  Snapshot,
  Takeoff,
  UnitProfile,
} from "./types.ts";

export class WorkflowService {
  closing = false;
  catalog: Catalog;
  controllers = new Map<string, AbortController>();
  constructor(root = process.env.BWC_DATA_DIR ?? join(ROOT, ".data/projects")) {
    this.catalog = new Catalog(resolve(root));
    for (const p of this.catalog.list()) {
      const s = this.catalog.open(p.projectId);
      for (const job of s.all<Job>("job"))
        if (["queued", "running"].includes(job.status)) {
          job.status = "interrupted";
          job.stage = "recovery_required";
          s.put("job", job);
          s.event("jobs", {
            jobId: job.id,
            status: job.status,
            stage: job.stage,
          });
        }
    }
  }
  projects() {
    return this.catalog.list();
  }
  create(name: string) {
    assert(
      name.trim().length > 0 && name.length < 200,
      "INVALID_INPUT",
      "项目名称无效",
    );
    return this.catalog.create(name.trim());
  }
  renameProject(pid: string, name: string) {
    const trimmed = name.trim();
    assert(
      trimmed.length > 0 && trimmed.length < 200,
      "INVALID_INPUT",
      "项目名称需为 1–199 个字符",
    );
    return this.catalog.open(pid).updateMeta({ name: trimmed });
  }
  removeProject(pid: string) {
    this.catalog.open(pid).updateMeta({ removedAt: now() });
    return { projectId: pid, removed: true };
  }
  open(pid: string) {
    const s = this.catalog.open(pid);
    return {
      ...s.meta(),
      projectId: pid,
      revision: s.meta().currentRevision ? s.current() : null,
      drawings: s.all("drawing"),
      results: s.all<Takeoff>("takeoff").map((r) => ({
        ...r,
        validity:
          r.validity === "valid" &&
          r.workingRevision === s.meta().currentRevision
            ? "valid"
            : "stale",
      })),
      jobs: s.all<Job>("job").map((job) => this.publicJob(job)),
      changes: s.all("change"),
      conversions: s.all("conversion"),
    };
  }
  context(input: any) {
    return this.catalog
      .open(input.projectId)
      .context(input.workingRevision, input.geometrySnapshotId);
  }
  samples() {
    const roots = [
      {
        dir: existsSync(join(ROOT, "docs/2026-10"))
          ? join(ROOT, "docs/2026-10")
          : join(ROOT, "2026-10"),
        prefix: "incoming",
      },
    ];
    const list: any[] = [];
    for (const r of roots)
      if (existsSync(r.dir))
        for (const name of readdirSync(r.dir).filter((x) =>
          x.toLowerCase().endsWith(".dwg"),
        ))
          list.push({
            id: hash(`${r.prefix}/${name}`).slice(0, 24),
            name,
            path: join(r.dir, name),
            source: r.prefix,
          });
    if (existsSync(join(ROOT, ".cache/controlled.dwg")))
      list.unshift({
        id: "controlled",
        name: "受控基准 6×4m（含 1m² 洞口与阵列）",
        path: join(ROOT, ".cache/controlled.dwg"),
        source: "controlled_fixture",
      });
    return list;
  }
  job(
    s: ProjectStore,
    kind: string,
    operationId: string,
    request: any,
    fn: (signal: AbortSignal, job: Job) => Promise<any>,
    ctx?: { revision: Revision; snapshot: Snapshot },
  ) {
    const fp = hash(canonical(request));
    const previous = s
      .all<Job>("job")
      .find((j) => j.operationId === operationId);
    if (previous) {
      assert(
        previous.requestFingerprint === fp && previous.kind === kind,
        "OPERATION_ID_CONFLICT",
        "操作 ID 已用于不同请求",
      );
      return previous;
    }
    const job: Job = {
      id: id("job"),
      kind,
      operationId,
      requestFingerprint: fp,
      status: "queued",
      stage: "queued",
      createdAt: now(),
      workingRevision: ctx?.revision.id,
      geometrySnapshotId: ctx?.snapshot.id,
    };
    s.put("job", job);
    s.event("jobs", { jobId: job.id, ...job });
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    setImmediate(async () => {
      if (this.closing) return;
      try {
        if (controller.signal.aborted)
          throw new DomainError("CANCELLED", "任务已取消");
        job.status = "running";
        job.stage = kind;
        s.put("job", job);
        s.event("jobs", {
          jobId: job.id,
          status: job.status,
          stage: job.stage,
        });
        const result = await fn(controller.signal, job);
        if (controller.signal.aborted)
          throw new DomainError("CANCELLED", "任务已取消");
        job.result = result;
        job.status =
          result.completeness === "partial" || result.completeDelivery === false
            ? "partial"
            : "succeeded";
        job.stage = "done";
      } catch (e) {
        const error = e as DomainError;
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.stage = job.status;
        job.error = {
          code: error.code ?? "INTERNAL_ERROR",
          message: error.message,
        };
      } finally {
        this.controllers.delete(job.id);
        if (this.closing) return;
        s.put("job", job);
        s.event("jobs", {
          jobId: job.id,
          status: job.status,
          stage: job.stage,
          result: job.result,
          error: job.error,
          workingRevision: job.workingRevision,
          geometrySnapshotId: job.geometrySnapshotId,
        });
      }
    });
    return job;
  }
  getJob(input: any) {
    return this.publicJob(
      this.catalog.open(input.projectId).get<Job>("job", input.jobId),
    );
  }
  cancelJob(input: any) {
    const s = this.catalog.open(input.projectId),
      j = s.get<Job>("job", input.jobId);
    if (["queued", "running"].includes(j.status)) {
      this.controllers.get(j.id)?.abort();
    }
    return j;
  }
  async fixture() {
    const output = join(ROOT, ".cache/controlled.dwg");
    if (!existsSync(output)) await worker("cad", { mode: "fixture", output });
    return { fileRef: "controlled" };
  }
  import(input: any) {
    const s = this.catalog.open(input.projectId);
    const sample = this.samples().find((x) => x.id === input.fileRef);
    const upload =
      !sample && s.has("upload", input.fileRef)
        ? s.get("upload", input.fileRef)
        : null;
    assert(
      sample || upload,
      "FILE_NOT_REGISTERED",
      "请从样本列表选择或先上传 DWG",
    );
    const source = sample?.path ?? within(s.path, upload.path);
    const bytes = readFileSync(source);
    assert(
      bytes.length <= 100 * 1024 * 1024 &&
        /^AC10\d\d$/.test(bytes.subarray(0, 6).toString()),
      "INVALID_DWG",
      "DWG 文件头无效或超过 100MB",
    );
    const base = s.meta().currentRevision;
    const role =
      input.role === "compatible_copy" ? "compatible_copy" : "original";
    return this.job(
      s,
      "import",
      input.operationId,
      { fileHash: hash(bytes), base, role },
      async (signal, job) => {
        const dv = id("dv"),
          pa = id("pa");
        const sourcePath = `sources/${dv}/${basename(upload?.name ?? source)}`;
        mkdirSync(join(s.path, "sources", dv), { recursive: true });
        writeFileSync(join(s.path, sourcePath), bytes, { flag: "wx" });
        const drawing: Drawing = {
          id: dv,
          name: upload?.name ?? basename(source),
          sha256: hash(bytes),
          path: sourcePath,
          format: bytes.subarray(0, 6).toString(),
          role,
          sourcePath: sample?.path,
        };
        const artifact = await worker<Artifact>(
          "cad",
          { mode: "parse", input: join(s.path, sourcePath) },
          signal,
        );
        this.assignIds(artifact, dv);
        if (role === "compatible_copy")
          artifact.diagnostics.push({
            code: "CONVERSION_UNVERIFIED",
            reason: "兼容副本需登记原图、转换来源和独立核验范围",
          });
        const artifactPath = `artifacts/${pa}/geometry.json`;
        atomicJson(join(s.path, artifactPath), artifact);
        const units: UnitProfile = {
          id: id("up"),
          confirmed: false,
          metresPerDrawingUnit: null,
          sourceInsUnits: artifact.insUnits,
          evidence: `INSUNITS=${artifact.insUnits}（声明待采用）`,
        };
        const snapshot = s.saveSnapshot(
          {
            drawingVersion: dv,
            parseArtifactVersion: pa,
            coordinateContractVersion: artifact.coordinateContractVersion,
            artifactPath,
            artifactSha256: hash(readFileSync(join(s.path, artifactPath))),
            patches: [],
            units,
            business: {},
            importCompleteness: artifact.importCompleteness,
          },
          artifact,
        );
        if (signal.aborted) fail("CANCELLED", "任务已取消");
        const revision = this.publish(s, base, snapshot, job.operationId, () =>
          s.put("drawing", drawing),
        );
        job.workingRevision = revision.id;
        job.geometrySnapshotId = snapshot.id;
        s.put("parse", {
          id: pa,
          drawingVersion: dv,
          artifactPath,
          completeness: artifact.importCompleteness,
        });
        return {
          workingRevision: revision.id,
          geometrySnapshotId: snapshot.id,
          drawingVersion: dv,
          parseArtifactVersion: pa,
          completeness: artifact.importCompleteness,
          sourceEntityCount: artifact.sourceEntityCount,
          occurrenceCount: artifact.occurrences.length,
          diagnostics: artifact.diagnostics.slice(0, 30),
          notificationCount: artifact.notifications.length,
        };
      },
    );
  }
  assignIds(a: Artifact, dv: string) {
    for (const o of a.occurrences) {
      o.entityId = `ent_${hash(dv + "/" + o.sourceHandle).slice(0, 24)}`;
      o.occurrenceId = `occ_${hash(dv + "/" + o.occurrenceKey).slice(0, 24)}`;
      o.instancePath = o.instancePath.map((p) => ({
        ...p,
        insertEntityId: `ent_${hash(dv + "/" + p.insertHandle).slice(0, 24)}`,
      }));
    }
  }
  reparse(input: any) {
    const s = this.catalog.open(input.projectId),
      ctx = s.context(input.workingRevision, input.geometrySnapshotId);
    const drawing = s.get<Drawing>("drawing", ctx.snapshot.drawingVersion);
    if (input.intentId) {
      const intent = s.get<Intent>("intent", input.intentId);
      assert(
        intent.origin === "message" &&
          intent.workingRevision === ctx.revision.id &&
          isReparseInstruction(intent.text),
        "INTENT_MISMATCH",
        "重新解析需要该轮次明确的当前图纸重解析指令",
      );
    }
    const source = s.file(drawing.path, drawing.sha256);
    return this.job(
      s,
      "reparse",
      input.operationId,
      {
        revision: ctx.revision.id,
        sourceSha256: drawing.sha256,
        adapterVersion: "bwc-cad-4",
      },
      async (signal, job) => {
        assert(
          s.meta().currentRevision === ctx.revision.id,
          "REVISION_CONFLICT",
          "只能基于当前修订重新解析",
        );
        const before = s.artifact(ctx.snapshot);
        const artifact = await worker<Artifact>(
          "cad",
          { mode: "parse", input: source, patches: ctx.snapshot.patches },
          signal,
        );
        this.assignIds(artifact, drawing.id);
        const inventory = (a: Artifact) =>
          canonical({
            sources: a.sources.map((x) => [x.handle, x.type, x.owner]).sort(),
            occurrences: a.occurrences
              .map((x) => [x.occurrenceId, x.entityType, x.space])
              .sort(),
          });
        assert(
          inventory(before) === inventory(artifact),
          "REPARSE_IDENTITY_CHANGED",
          "源实体或实例身份变化，不能自动沿用业务参数；请另行导入核验",
        );
        assert(
          before.insUnits === artifact.insUnits,
          "REPARSE_UNITS_CHANGED",
          "源单位声明变化，需要单独核验",
        );
        if (drawing.role === "compatible_copy") {
          artifact.diagnostics.push({
            code: "CONVERSION_UNVERIFIED",
            reason: "兼容副本需登记原图、转换来源和独立核验范围",
          });
          artifact.importCompleteness = "partial";
        }
        const pa = id("pa"),
          artifactPath = `artifacts/${pa}/geometry.json`;
        atomicJson(join(s.path, artifactPath), artifact);
        const snapshot = s.saveSnapshot(
          {
            drawingVersion: drawing.id,
            parseArtifactVersion: pa,
            coordinateContractVersion: artifact.coordinateContractVersion,
            artifactPath,
            artifactSha256: hash(readFileSync(join(s.path, artifactPath))),
            patches: ctx.snapshot.patches,
            units: ctx.snapshot.units,
            business: ctx.snapshot.business,
            importCompleteness: artifact.importCompleteness,
          },
          artifact,
        );
        if (signal.aborted) fail("CANCELLED", "任务已取消");
        const report = {
          before: importReport(before),
          after: importReport(artifact),
        };
        const revision = this.publish(
          s,
          ctx.revision.id,
          snapshot,
          job.operationId,
          () =>
            s.put("parse", {
              id: pa,
              drawingVersion: drawing.id,
              artifactPath,
              previousParseArtifactVersion: ctx.snapshot.parseArtifactVersion,
              adapterVersion: artifact.adapterVersion,
              sourceSha256: drawing.sha256,
              completeness: artifact.importCompleteness,
              report,
            }),
        );
        job.workingRevision = revision.id;
        job.geometrySnapshotId = snapshot.id;
        return {
          workingRevision: revision.id,
          geometrySnapshotId: snapshot.id,
          parseArtifactVersion: pa,
          completeness: artifact.importCompleteness,
          report,
        };
      },
      ctx,
    );
  }
  publish(
    s: ProjectStore,
    base: string | null,
    snapshot: Snapshot,
    operationId: string,
    extra?: (revision: Revision) => void,
  ) {
    const revision: Revision = {
      id: id("r"),
      parent: base,
      geometrySnapshotId: snapshot.id,
      operationId,
      createdAt: now(),
    };
    s.transaction(() => {
      assert(
        s.meta().currentRevision === base,
        "REVISION_CONFLICT",
        "基础修订已变化",
      );
      extra?.(revision);
      s.put("revision", revision);
      s.put("project", { ...s.meta(), currentRevision: revision.id }, "meta");
      for (const result of s.all<Takeoff>("takeoff"))
        if (result.validity === "valid")
          s.put("takeoff", { ...result, validity: "stale" });
      s.event("project", {
        type: "revision_published",
        workingRevision: revision.id,
        geometrySnapshotId: snapshot.id,
        operationId,
      });
    });
    s.writeManifest();
    return revision;
  }
  summary(input: any) {
    const s = this.catalog.open(input.projectId),
      { revision, snapshot } = s.context(
        input.workingRevision,
        input.geometrySnapshotId,
      ),
      a = s.artifact(snapshot);
    const count = (key: "entityType" | "space") =>
      Object.fromEntries(
        [...new Set(a.occurrences.map((o) => o[key]))].map((k) => [
          k,
          a.occurrences.filter((o) => o[key] === k).length,
        ]),
      );
    return {
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
      drawing: s.get("drawing", snapshot.drawingVersion),
      adapterVersion: a.adapterVersion ?? "bwc-cad-1",
      unitProfile: snapshot.units,
      sourceEntityCount: a.sourceEntityCount,
      sourceRecordCount: a.sourceRecordCount,
      occurrenceCount: a.occurrences.length,
      entityTypes: count("entityType"),
      spaces: count("space"),
      importCompleteness: snapshot.importCompleteness,
      diagnostics: a.diagnostics.slice(0, 100),
      diagnosticCount: a.diagnostics.length,
      notifications: a.notifications.slice(0, 30),
      notificationCount: a.notifications.length,
      dependencies: a.dependencies,
      resources: a.resources ?? [],
      registeredClasses: a.classes ?? [],
      displayLimitations: a.displayLimitations,
      importReport: importReport(a),
      readSeconds: a.readSeconds,
      peakWorkingSetBytes: a.peakWorkingSetBytes,
    };
  }
  layers(input: any) {
    const s = this.catalog.open(input.projectId),
      ctx = s.context(input.workingRevision, input.geometrySnapshotId);
    return {
      workingRevision: ctx.revision.id,
      geometrySnapshotId: ctx.snapshot.id,
      layers: s.artifact(ctx.snapshot).layers,
    };
  }
  async matching(s: ProjectStore, snapshot: Snapshot, filter: Filter) {
    const a = filter.diagnosticGroupId ? s.artifact(snapshot) : null;
    if (a)
      assert(
        importReport(a).diagnosticGroups.some(
          (g) => g.id === filter.diagnosticGroupId,
        ),
        "DIAGNOSTIC_NOT_FOUND",
        "诊断组不属于该快照",
      );
    const handles = a ? diagnosticHandles(a, filter.diagnosticGroupId!) : null;
    let rows = s
      .occurrences(snapshot.id, filter.rectangle)
      .filter(
        (o) =>
          (!handles || handles.has(o.sourceHandle)) &&
          (!filter.geometryKinds ||
            (!!o.geometry && filter.geometryKinds.includes(o.geometry.kind))) &&
          (!filter.space || o.space === filter.space) &&
          (!filter.entityTypes || filter.entityTypes.includes(o.entityType)) &&
          (!filter.layers || filter.layers.includes(o.layer)) &&
          (!filter.text ||
            primitives(o.geometry).some(
              (g) => g.kind === "text" && g.text.includes(filter.text!),
            )) &&
          (!filter.classification ||
            snapshot.business[o.occurrenceId]?.classification ===
              filter.classification),
      );
    if (filter.rectangle) {
      const exact = await worker<{ members: string[] }>("geometry", {
        mode: "spatial",
        occurrences: rows,
        rectangle: filter.rectangle,
      });
      const hits = new Set(exact.members);
      rows = rows.filter((o) => hits.has(o.occurrenceId));
    }
    return rows;
  }
  async query(input: any) {
    const s = this.catalog.open(input.projectId);
    let q: any;
    let offset = 0;
    const pageSize = Math.min(Math.max(input.pageSize ?? 100, 1), 500);
    if (input.cursor) {
      const [qid, off] = input.cursor.split(":");
      q = s.get("query", qid);
      offset = Number(off);
      assert(
        Number.isSafeInteger(offset) && offset >= 0,
        "INVALID_CURSOR",
        "分页游标无效",
      );
      if (input.workingRevision)
        assert(
          input.workingRevision === q.workingRevision,
          "SNAPSHOT_MISMATCH",
          "游标固定于历史修订",
        );
      if (input.geometrySnapshotId)
        assert(
          input.geometrySnapshotId === q.geometrySnapshotId,
          "SNAPSHOT_MISMATCH",
          "游标固定于历史快照",
        );
    } else {
      const { revision, snapshot } = s.context(
        input.workingRevision,
        input.geometrySnapshotId,
      );
      const filter = FilterSchema.parse(input.filter ?? { space: "model" });
      const rows = await this.matching(s, snapshot, filter);
      q = s.put("query", {
        id: id("q"),
        workingRevision: revision.id,
        geometrySnapshotId: snapshot.id,
        filter,
        members: rows.map((o) => o.occurrenceId),
      });
    }
    const snap = s.get<Snapshot>("snapshot", q.geometrySnapshotId);
    const members = new Set(q.members.slice(offset, offset + pageSize));
    const items = s
      .occurrences(snap.id)
      .filter((o) => members.has(o.occurrenceId))
      .map((o) => ({
        ...o,
        geometry: undefined,
        diagnosticPreview: undefined,
        business: snap.business[o.occurrenceId],
      }));
    return {
      queryId: q.id,
      workingRevision: q.workingRevision,
      geometrySnapshotId: q.geometrySnapshotId,
      total: q.members.length,
      items,
      cursor:
        offset + pageSize < q.members.length
          ? `${q.id}:${offset + pageSize}`
          : null,
      importCompleteness: snap.importCompleteness,
    };
  }
  diagnostics(input: any) {
    const s = this.catalog.open(input.projectId),
      { revision, snapshot } = s.context(
        input.workingRevision,
        input.geometrySnapshotId,
      ),
      a = s.artifact(snapshot),
      report = importReport(a);
    const groups = report.diagnosticGroups.map((g) => ({
      ...g,
      ...diagnosticAdvice(g.entityType, g.code),
    }));
    const group = input.groupId
      ? groups.find((g) => g.id === input.groupId)
      : null;
    if (input.groupId)
      assert(group, "DIAGNOSTIC_NOT_FOUND", "诊断组不属于该快照");
    const handles = group
      ? diagnosticHandles(a, group.id)
      : new Set(a.diagnostics.flatMap((d) => (d.handle ? [d.handle] : [])));
    const objects = a.occurrences.filter((o) => handles.has(o.sourceHandle));
    const sources = a.sources.filter((s) => handles.has(s.handle));
    const offset = input.offset ?? 0,
      limit = input.limit ?? 25;
    return {
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
      parseArtifactVersion: snapshot.parseArtifactVersion,
      adapterVersion: a.adapterVersion ?? "bwc-cad-1",
      coverage: {
        modelGeometry: report.modelWithoutGeometry ? "partial" : "covered",
        displayFidelity: "approximate",
        documentPreservation:
          a.importCompleteness === "complete"
            ? "no_known_import_gaps"
            : "requires_verification",
        quantityReadiness: snapshot.units.confirmed
          ? "requires_shape_and_scope_validation"
          : "units_unconfirmed",
        independentCad: "not_run",
      },
      report,
      groups: group ? [group] : groups,
      affectedTotal: objects.length,
      offset,
      nextOffset: offset + limit < objects.length ? offset + limit : null,
      items: objects.slice(offset, offset + limit).map((o) => ({
        occurrenceId: o.occurrenceId,
        sourceHandle: o.sourceHandle,
        entityType: o.entityType,
        space: o.space,
        layer: o.layer,
        instancePath: o.instancePath,
        hasCanonicalGeometry: !!o.geometry,
        hasDiagnosticPreview: !!o.diagnosticPreview,
        quantityEligible:
          !!o.geometry && ["path", "region"].includes(o.geometry.kind),
      })),
      sourceSamples: sources.slice(0, 3).map((source) => ({
        handle: source.handle,
        type: source.type,
        owner: source.owner,
        vertexSummary: source.nativePolyline
          ? {
              vertexCount: source.nativePolyline.vertices.length,
              distinctPositionCount: new Set(
                source.nativePolyline.vertices.map((v) =>
                  JSON.stringify(v.point),
                ),
              ).size,
              nonzeroBulgeCount: source.nativePolyline.vertices.filter(
                (v) => v.bulge !== 0,
              ).length,
            }
          : null,
        geometry: {
          nativePolyline: source.nativePolyline,
          nativeEvidence: source.nativeEvidence,
        },
      })),
      sourceSampleCount: Math.min(3, sources.length),
      sourceTotal: sources.length,
      suggestedFilter: group ? { diagnosticGroupId: group.id } : null,
      computableCandidateFilter: {
        space: "model",
        geometryKinds: ["path", "region"],
      },
      limitations: [
        "辅助定位不消除解析缺口，不进入工程量。",
        "读取通知待核验，不能通过 AI 解释自动放行完整 DWG 交付。",
        "可计算候选仍需采用单位并通过轮廓和业务参数检查，不能当成全图工程量。",
      ],
    };
  }
  async selection(input: any) {
    const s = this.catalog.open(input.projectId);
    const { revision, snapshot } = s.context(
      input.workingRevision,
      input.geometrySnapshotId,
    );
    let members: string[];
    if (input.queryId) {
      const q = s.get("query", input.queryId);
      assert(
        q.geometrySnapshotId === snapshot.id,
        "SNAPSHOT_MISMATCH",
        "查询结果属于其他快照",
      );
      members = q.members;
    } else if (input.filter)
      members = (
        await this.matching(s, snapshot, FilterSchema.parse(input.filter))
      ).map((o) => o.occurrenceId);
    else {
      members = [...new Set<string>(input.members ?? [])];
      const valid = new Set(
        s.occurrences(snapshot.id).map((o) => o.occurrenceId),
      );
      assert(
        members.every((m) => valid.has(m)),
        "INVALID_SELECTION",
        "选择包含其他快照的对象",
      );
    }
    assert(members.length > 0, "SCOPE_AMBIGUOUS", "选择范围为空");
    const selection: Selection = {
      id: id("sel"),
      version: 1,
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
      members,
      filter: input.filter,
      evidence: input.evidence ?? "explicit_selection",
    };
    s.put("selection", selection);
    return { ...selection, count: members.length };
  }
  selected(s: ProjectStore, snapshot: Snapshot, ref: any) {
    assert(ref?.version === 1, "INVALID_SELECTION", "选择集版本无效");
    const sel = s.get<Selection>("selection", ref.id);
    assert(
      sel.geometrySnapshotId === snapshot.id,
      "SNAPSHOT_MISMATCH",
      "选择集已过期，请重新选择",
    );
    return sel;
  }
  get(input: any) {
    const s = this.catalog.open(input.projectId),
      { revision, snapshot } = s.context(
        input.workingRevision,
        input.geometrySnapshotId,
      );
    const o = s
      .occurrences(snapshot.id)
      .find((o) => o.occurrenceId === input.occurrenceId);
    assert(o, "NOT_FOUND", "当前快照中不存在此对象");
    return {
      ...o,
      business: snapshot.business[o.occurrenceId],
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
    };
  }
  preview(input: any) {
    const s = this.catalog.open(input.projectId),
      { revision, snapshot } = s.context(
        input.workingRevision,
        input.geometrySnapshotId,
      );
    return {
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
      units: snapshot.units,
      displayTransform: {
        origin: [0, 0, 0],
        axes: "x,y,z",
        coordinates: "drawing_wcs",
        scaleApplied: false,
      },
      occurrences: s.occurrences(snapshot.id),
      business: snapshot.business,
    };
  }
  recordIntent(input: any) {
    const s = this.catalog.open(input.projectId);
    const { revision, snapshot } = s.context(input.workingRevision);
    assert(
      s.current().id === revision.id,
      "REVISION_CONFLICT",
      "请刷新工作修订",
    );
    const operation = OperationSchema.parse(input.operation);
    if (operation.kind !== "set_units")
      this.selected(s, snapshot, input.selectionSet);
    return s.put("intent", {
      id: id("intent"),
      origin: "ui",
      text: input.text ?? JSON.stringify(operation),
      workingRevision: revision.id,
      selectionSet: input.selectionSet,
      operation,
      createdAt: now(),
    } satisfies Intent);
  }
  async propose(input: any) {
    const s = this.catalog.open(input.projectId),
      operation = OperationSchema.parse(input.operation),
      { revision, snapshot } = s.context(
        input.baseRevision,
        input.baseGeometrySnapshotId,
      );
    const requestFp = hash(
      canonical({
        baseRevision: revision.id,
        selectionSet: input.selectionSet,
        operation,
        intentId: input.intentId,
      }),
    );
    const prev = s
      .all<Change>("change")
      .find((c) => c.operationId === input.operationId);
    if (prev) {
      assert(
        prev.requestFingerprint === requestFp,
        "OPERATION_ID_CONFLICT",
        "操作 ID 已用于不同请求",
      );
      return prev;
    }
    assert(
      s.current().id === revision.id,
      "REVISION_CONFLICT",
      "基础修订已变化",
    );
    const intent = s.get<Intent>("intent", input.intentId);
    assert(
      intent.workingRevision === revision.id,
      "INTENT_MISMATCH",
      "用户指令属于其他修订",
    );
    assert(
      intent.operation && canonical(intent.operation) === canonical(operation),
      "INTENT_MISMATCH",
      "操作与已记录用户指令不一致",
    );
    assert(
      canonical(intent.selectionSet ?? null) ===
        canonical(input.selectionSet ?? null),
      "INTENT_MISMATCH",
      "目标与用户指令不一致",
    );
    const sel =
      operation.kind === "set_units"
        ? null
        : this.selected(s, snapshot, input.selectionSet);
    const business = structuredClone(snapshot.business);
    let units = structuredClone(snapshot.units);
    let patches = structuredClone(snapshot.patches);
    const a = s.artifact(snapshot);
    let artifact = a;
    const diff: any[] = [];
    const targets = sel
      ? a.occurrences.filter((o) => sel.members.includes(o.occurrenceId))
      : [];
    if (operation.kind === "set_units") {
      units = {
        id: id("up"),
        confirmed: true,
        metresPerDrawingUnit: operation.metresPerDrawingUnit,
        sourceInsUnits: snapshot.units.sourceInsUnits,
        evidence: operation.evidence,
      };
      diff.push({
        field: "metresPerDrawingUnit",
        before: snapshot.units,
        after: units,
      });
    } else if (
      ["set_measurement_parameter", "set_business", "set_holes"].includes(
        operation.kind,
      )
    ) {
      for (const o of targets) {
        const before = business[o.occurrenceId] ?? {};
        const after: Business = { ...before, evidence: intent.id };
        if (operation.kind === "set_measurement_parameter") {
          if (operation.unitBinding === "source_geometry")
            assert(
              operation.sourceOccurrenceId &&
                a.occurrences.some(
                  (o) =>
                    o.occurrenceId === operation.sourceOccurrenceId &&
                    o.geometry?.kind === "path",
                ),
              "INVALID_PARAMETER",
              "源几何厚度需明确可提取长度的对象",
            );
          after.uniform_thickness = {
            ...operation,
            evidence: intent.id,
            normalizedMetres:
              operation.unitBinding === "physical_quantity"
                ? operation.value *
                  { mm: 0.001, cm: 0.01, m: 1 }[operation.unit]
                : undefined,
          };
        } else if (operation.kind === "set_business")
          Object.assign(after, { ...operation, kind: undefined });
        else if (operation.kind === "set_holes") {
          assert(
            operation.holes.every((h) =>
              a.occurrences.some(
                (o) => o.occurrenceId === h && o.space === "model",
              ),
            ),
            "INVALID_HOLE_REFERENCE",
            "洞口引用无效",
          );
          assert(
            !operation.holes.some((h) => sel!.members.includes(h)),
            "INVALID_HOLE_REFERENCE",
            "洞口与外轮廓不能相同",
          );
          after.holes = [...new Set(operation.holes)];
        }
        business[o.occurrenceId] = after;
        diff.push({ occurrenceId: o.occurrenceId, before, after });
      }
    } else {
      assert(snapshot.units.confirmed, "UNITS_UNCONFIRMED", "请先确认单位");
      assert(
        targets.every(
          (o) =>
            o.space === "model" && o.instancePath.length === 0 && o.geometry,
        ),
        "UNSUPPORTED_ENTITY",
        "首期图元编辑仅支持模型空间直接对象，块内部及阵列成员暂不开放",
      );
      if (operation.kind === "move_entities")
        assert(
          targets.every((o) => ["LINE", "LWPOLYLINE"].includes(o.entityType)),
          "UNSUPPORTED_ENTITY",
          "移动仅支持 LINE 和默认法向的 LWPOLYLINE",
        );
      if (operation.kind === "set_text")
        assert(
          targets.every((o) => ["TEXT", "MTEXT"].includes(o.entityType)),
          "UNSUPPORTED_ENTITY",
          "文字修改仅支持 TEXT/MTEXT",
        );
      const op = operation as Extract<
        Operation,
        { kind: "move_entities" | "set_layer" | "set_text" }
      >;
      const patch: NativePatch = {
        kind: op.kind,
        handles: [...new Set(targets.map((o) => o.sourceHandle))],
      };
      if (op.kind === "move_entities") {
        const factor =
          op.unit === "drawing_unit"
            ? 1
            : (op.unit === "mm" ? 0.001 : 1) /
              snapshot.units.metresPerDrawingUnit!;
        patch.delta = op.delta.map((v) => v * factor) as any;
      } else patch.value = op.value;
      patches.push(patch);
      const drawing = s.get<Drawing>("drawing", snapshot.drawingVersion);
      artifact = await worker<Artifact>("cad", {
        mode: "parse",
        input: s.file(drawing.path, drawing.sha256),
        patches,
      });
      this.assignIds(artifact, snapshot.drawingVersion);
      for (const o of targets)
        diff.push({
          occurrenceId: o.occurrenceId,
          before: o,
          after: artifact.occurrences.find(
            (n) => n.occurrenceId === o.occurrenceId,
          ),
        });
    }
    let artifactPath = snapshot.artifactPath,
      artifactSha256 = snapshot.artifactSha256;
    if (artifact !== a) {
      artifactPath = `revisions/native_${id("state")}/geometry.json`;
      atomicJson(join(s.path, artifactPath), artifact);
      artifactSha256 = hash(readFileSync(join(s.path, artifactPath)));
    }
    const candidate = s.saveSnapshot(
      {
        drawingVersion: snapshot.drawingVersion,
        parseArtifactVersion: snapshot.parseArtifactVersion,
        coordinateContractVersion: snapshot.coordinateContractVersion,
        artifactPath,
        artifactSha256,
        patches,
        units,
        business,
        importCompleteness: artifact.importCompleteness,
      },
      artifact,
    );
    let trial: unknown;
    if (sel)
      trial = await worker("geometry", {
        occurrences: artifact.occurrences,
        members: sel.members,
        scale: units.metresPerDrawingUnit,
        business,
        quantityKind: "parameter_volume",
      });
    const change: Change = {
      id: id("change"),
      operationId: input.operationId,
      requestFingerprint: requestFp,
      baseRevision: revision.id,
      baseGeometrySnapshotId: snapshot.id,
      selectionSet: input.selectionSet,
      operation,
      intentId: intent.id,
      candidateSnapshotId: candidate.id,
      candidateFingerprint: candidate.fingerprint,
      diff,
      status: "proposed",
      trial,
    };
    s.put("change", change);
    return change;
  }
  apply(input: any) {
    const s = this.catalog.open(input.projectId),
      c = s.get<Change>("change", input.changeId);
    assert(
      c.operationId === input.operationId &&
        c.candidateFingerprint === input.candidateFingerprint &&
        c.baseRevision === input.baseRevision,
      "CANDIDATE_MISMATCH",
      "应用请求与预览候选不一致",
    );
    if (c.status === "applied")
      return {
        ...c,
        workingRevision: c.appliedRevision!,
        geometrySnapshotId: c.candidateSnapshotId,
        derivedResults: "invalidated",
        referenceMigration: "identity_preserved",
      };
    const snapshot = s.get<Snapshot>("snapshot", c.candidateSnapshotId);
    s.artifact(snapshot);
    assert(
      hash(
        canonical(
          Object.fromEntries(
            Object.entries(snapshot).filter(
              ([k]) => !["id", "fingerprint", "createdAt"].includes(k),
            ),
          ),
        ),
      ) === c.candidateFingerprint,
      "ARTIFACT_CORRUPT",
      "候选快照已变化",
    );
    const revision = this.publish(
      s,
      c.baseRevision,
      snapshot,
      c.operationId,
      (revision) => {
        c.status = "applied";
        c.appliedRevision = revision.id;
        s.put("change", c);
      },
    );
    c.appliedRevision = revision.id;
    s.put("change", c);
    return {
      ...c,
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
      derivedResults: "invalidated",
      referenceMigration: "identity_preserved",
    };
  }
  revert(input: any) {
    const s = this.catalog.open(input.projectId),
      current = s.current();
    const c = s.get<Change>("change", input.changeId);
    const previous = s
      .all<Revision>("revision")
      .find((r) => r.operationId === input.operationId);
    if (previous) return previous;
    assert(
      c.status === "applied" && current.operationId === c.operationId,
      "REVISION_CONFLICT",
      "快捷撤销只适用于最新变更",
    );
    assert(
      !s.all<any>("export").some((e) => e.workingRevision === current.id),
      "REVISION_CONFLICT",
      "已有冻结交付依赖，请创建反向变更",
    );
    const before = s.get<Snapshot>("snapshot", c.baseGeometrySnapshotId);
    return this.publish(s, current.id, before, input.operationId);
  }
  takeoff(input: any) {
    const s = this.catalog.open(input.projectId),
      ctx = s.context(input.workingRevision, input.geometrySnapshotId),
      sel = this.selected(s, ctx.snapshot, input.selectionSet);
    const kind = input.quantityKind ?? "parameter_volume";
    assert(
      [
        "length",
        "net_area",
        "parameter_volume",
        "entity_count",
        "business_count",
      ].includes(kind),
      "UNSUPPORTED_METHOD",
      "未实现此计量方法",
    );
    return this.job(
      s,
      "takeoff",
      input.operationId,
      { revision: ctx.revision.id, selection: sel.id, kind },
      async (signal) => {
        const a = s.artifact(ctx.snapshot),
          r = await worker<any>(
            "geometry",
            {
              occurrences: a.occurrences,
              members: sel.members,
              scale: ctx.snapshot.units.confirmed
                ? ctx.snapshot.units.metresPerDrawingUnit
                : null,
              business: ctx.snapshot.business,
              quantityKind: kind,
            },
            signal,
          );
        const drawing = s.get<Drawing>("drawing", ctx.snapshot.drawingVersion);
        const conv = drawing.conversionRecordId
          ? s.get("conversion", drawing.conversionRecordId)
          : null;
        const complete = r.complete;
        const result: Takeoff = {
          id: id("tr"),
          workingRevision: ctx.revision.id,
          geometrySnapshotId: ctx.snapshot.id,
          selectionSet: { id: sel.id, version: 1 },
          quantityKind: kind,
          unit: (
            {
              length: "m",
              net_area: "m2",
              parameter_volume: "m3",
              entity_count: "entity_occurrence",
              business_count: "component",
            } as any
          )[kind],
          knownSubtotal: r.knownSubtotal,
          completeTotal: complete ? r.knownSubtotal : null,
          completeness: complete ? "complete" : "partial",
          importCompleteness: ctx.snapshot.importCompleteness,
          conversionVerification:
            drawing.role === "compatible_copy"
              ? (conv?.verification ?? "not_verified")
              : "not_applicable",
          conversionRecordId: conv?.id ?? null,
          items: r.items,
          validity:
            s.meta().currentRevision === ctx.revision.id ? "valid" : "stale",
          methodVersion: r.methodVersion,
          unitProfileVersion: ctx.snapshot.units.id,
          exclusions: [],
          ...{ scope: "frozen_selection_only", projectCompleteTotal: null },
        };
        if (signal.aborted) fail("CANCELLED", "任务已取消");
        s.put("takeoff", result);
        return result;
      },
      ctx,
    );
  }
  publicJob(job: Job): Job {
    return job.kind === "check" && job.result?.issues
      ? {
          ...job,
          result: {
            ...job.result,
            issues: groupIssues(job.result.issues, job.id),
          },
        }
      : job;
  }
  issues(input: any) {
    const s = this.catalog.open(input.projectId),
      ctx = s.context(input.workingRevision, input.geometrySnapshotId);
    const jobs = s
      .all<Job>("job")
      .filter(
        (j) =>
          j.kind === "check" &&
          j.geometrySnapshotId === ctx.snapshot.id &&
          ["partial", "succeeded"].includes(j.status) &&
          j.result?.issues,
      );
    const latest = jobs.at(-1);
    const items =
      latest?.result.issues ??
      s
        .all<any>("issue")
        .filter((i) => i.geometrySnapshotId === ctx.snapshot.id);
    return {
      workingRevision: ctx.revision.id,
      geometrySnapshotId: ctx.snapshot.id,
      checkRunId: latest?.id ?? null,
      historyRunCount: jobs.length,
      issues: groupIssues(items, latest?.id ?? "legacy"),
    };
  }
  check(input: any) {
    const s = this.catalog.open(input.projectId),
      ctx = s.context(input.workingRevision, input.geometrySnapshotId);
    const sel = input.selectionSet
      ? this.selected(s, ctx.snapshot, input.selectionSet)
      : null;
    return this.job(
      s,
      "check",
      input.operationId,
      {
        revision: ctx.revision.id,
        selection: sel?.id ?? null,
        checkerVersion: "bwc-check-2",
      },
      async (signal, job) => {
        const a = s.artifact(ctx.snapshot);
        const selected = new Set(
          sel?.members ??
            a.occurrences
              .filter((o) => o.space === "model")
              .map((o) => o.occurrenceId),
        );
        const objects = a.occurrences.filter((o) =>
            selected.has(o.occurrenceId),
          ),
          members = objects.map((o) => o.occurrenceId);
        const paths = objects.filter((o) => o.geometry?.kind === "path");
        const contours = objects.filter(
          (o) =>
            o.geometry?.kind === "region" ||
            (o.geometry?.kind === "path" &&
              (o.geometry.closed ||
                ctx.snapshot.business[o.occurrenceId]?.uniform_thickness ||
                ctx.snapshot.business[o.occurrenceId]?.holes)),
        );
        const raw: any[] = [];
        const add = (
          check: string,
          status: string,
          reason: string,
          ids: string[],
          evidence?: any,
          severity = "warning",
        ) =>
          raw.push({
            check,
            status,
            reason,
            occurrenceIds: ids,
            evidence,
            severity,
            geometrySnapshotId: ctx.snapshot.id,
            checkerVersion: "bwc-check-2",
            checkRunId: job.id,
          });
        add(
          "units",
          ctx.snapshot.units.confirmed ? "passed" : "failed",
          ctx.snapshot.units.confirmed ? "单位已采用" : "UNITS_UNCONFIRMED",
          members,
          undefined,
          "blocking",
        );
        add(
          "import",
          a.importCompleteness === "complete" ? "passed" : "failed",
          a.importCompleteness === "complete"
            ? "当前受支持实体解析完成"
            : "存在未覆盖对象或读取通知",
          [],
          { importReport: importReport(a) },
        );
        const unsupported = objects
          .filter((o) => !o.geometry)
          .map((o) => o.occurrenceId);
        if (unsupported.length)
          add(
            "basic_geometry",
            "unsupported",
            "UNSUPPORTED_GEOMETRY",
            unsupported,
          );
        const texts = objects
          .filter(
            (o) =>
              o.geometry &&
              ["text", "annotation", "point"].includes(o.geometry.kind),
          )
          .map((o) => o.occurrenceId);
        if (texts.length)
          add(
            "basic_geometry",
            "not_applicable",
            "文字、标注和点不参与曲线几何检查",
            texts,
          );
        if (!ctx.snapshot.units.confirmed) {
          if (paths.length)
            add(
              "basic_geometry",
              "not_run",
              "UNITS_UNCONFIRMED",
              paths.map((o) => o.occurrenceId),
            );
          if (contours.length)
            add(
              "contour",
              "not_run",
              "UNITS_UNCONFIRMED",
              contours.map((o) => o.occurrenceId),
            );
        } else {
          if (paths.length) {
            const length = await worker<any>(
              "geometry",
              {
                occurrences: paths,
                members: paths.map((o) => o.occurrenceId),
                scale: ctx.snapshot.units.metresPerDrawingUnit,
                business: ctx.snapshot.business,
                quantityKind: "length",
              },
              signal,
            );
            for (const i of length.items)
              add(
                "basic_geometry",
                i.status === "valid" ? "passed" : "failed",
                i.reason ?? "曲线有限且长度非零",
                [i.id],
                i,
              );
          }
          if (contours.length) {
            const area = await worker<any>(
              "geometry",
              {
                occurrences: a.occurrences,
                members: contours.map((o) => o.occurrenceId),
                scale: ctx.snapshot.units.metresPerDrawingUnit,
                business: ctx.snapshot.business,
                quantityKind: "net_area",
              },
              signal,
            );
            for (const i of area.items)
              add(
                "contour",
                i.status === "valid" ? "passed" : "failed",
                i.reason ?? "闭合共面轮廓有效",
                [i.id],
                i,
              );
          }
        }
        const contourIds = new Set(contours.map((o) => o.occurrenceId));
        const otherPaths = paths
          .filter((o) => !contourIds.has(o.occurrenceId))
          .map((o) => o.occurrenceId);
        if (otherPaths.length)
          add(
            "contour",
            "not_applicable",
            "开放曲线未声明为面积轮廓",
            otherPaths,
          );
        if (!contours.length)
          add(
            "contour",
            "not_applicable",
            "当前范围没有已闭合或已声明的面积轮廓",
            [],
          );
        add(
          "independent_cad_roundtrip",
          "not_run",
          "需要独立 CAD 对照验收",
          [],
          undefined,
          "blocking",
        );
        add("duplicate_overlap", "not_run", "重复/重叠检查器尚未实现", []);
        if (signal.aborted) fail("CANCELLED", "任务已取消");
        const issues = groupIssues(raw, job.id);
        s.transaction(() => {
          for (const issue of issues) s.put("issue", issue);
        });
        return {
          workingRevision: ctx.revision.id,
          geometrySnapshotId: ctx.snapshot.id,
          checkRunId: job.id,
          scopeCount: members.length,
          issues,
          completeness: issues.some(
            (i) => !["passed", "not_applicable"].includes(i.status),
          )
            ? "partial"
            : "complete",
        };
      },
      ctx,
    );
  }
  capabilities(input: any) {
    const ctx = input.projectId ? this.summary(input) : null;
    return {
      schemaVersion: 1,
      adapter: "ACadSharp 3.8.30",
      coordinateContractVersion: "bwc-wcs-1",
      supported: {
        read: [
          "LINE",
          "ARC",
          "CIRCLE",
          "ELLIPSE",
          "LWPOLYLINE",
          "POLYLINE(2D)",
          "TEXT",
          "MTEXT",
          "INSERT",
          "HATCH (line/arc/ellipse/polyline boundaries)",
          "DIMENSION (default-coordinate cached picture; independent CAD not_run)",
          "SOLID (2D boundary)",
          "3DFACE (boundary; area requires coplanarity)",
          "POINT",
        ],
        instances: {
          ordinary: "implemented",
          nested: "implemented",
          minsert: "implemented_pending_independent_cad",
          singleCellEdit: "unsupported",
          definitionEdit: "unsupported",
        },
        edit: {
          move_entities: "model-space LINE/default-normal LWPOLYLINE",
          set_layer: "supported direct model-space entities",
          set_text: "direct TEXT/MTEXT",
          set_measurement_parameter:
            "physical_quantity or explicit source length",
          set_units: "reinterprets source geometry",
        },
        measurement: [
          "length",
          "net_area",
          "parameter_volume",
          "entity_count",
          "business_count",
        ],
        componentRecognition: {
          method:
            "closed source boundaries, exact endpoint line cycles, door/window insert instances",
          aiAssistance: "source-referenced pending suggestions only",
          confirmation: "human review in workbench; versioned audit records",
          quantities:
            "confirmed components only; symbol groups count only; topology and physical parameters still required",
          limitations:
            "no automatic floor assignment, wall height, inferred gap filling or plan/elevation deduplication",
        },
        delivery: {
          candidateDwg: "supported only without import gaps or dependencies",
          independentCad: "not_run",
          dependencyRewrite: "unsupported",
          completeDelivery: false,
        },
      },
      unsupported: [
        "native TCH business semantics",
        "proxy graphics",
        "XREF expansion",
        "3D solids",
        "hatch pattern/fill and dimension regeneration",
        "DWG dependency migration",
        "SHX fidelity",
      ],
      document: ctx
        ? {
            importCompleteness: ctx.importCompleteness,
            diagnosticCount: ctx.diagnosticCount,
            unitProfile: ctx.unitProfile,
          }
        : null,
    };
  }
  close() {
    this.closing = true;
    for (const c of this.controllers.values()) c.abort();
    this.catalog.close();
  }
}
