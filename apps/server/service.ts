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
          r.workingRevision === s.meta().currentRevision ? "valid" : "stale",
      })),
      jobs: s.all("job"),
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
      { dir: resolve(ROOT, "../zhu-suan/assets/dwg"), prefix: "original" },
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
    return this.catalog.open(input.projectId).get<Job>("job", input.jobId);
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
    let rows = s
      .occurrences(snapshot.id, filter.rectangle)
      .filter(
        (o) =>
          (!filter.space || o.space === filter.space) &&
          (!filter.entityTypes || filter.entityTypes.includes(o.entityType)) &&
          (!filter.layers || filter.layers.includes(o.layer)) &&
          (!filter.text ||
            (o.geometry?.kind === "text" &&
              o.geometry.text.includes(filter.text))) &&
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
      { revision: ctx.revision.id, selection: sel?.id ?? null },
      async (signal) => {
        const a = s.artifact(ctx.snapshot),
          members =
            sel?.members ??
            a.occurrences
              .filter((o) => o.space === "model")
              .map((o) => o.occurrenceId);
        const measured = await worker<any>(
          "geometry",
          {
            occurrences: a.occurrences,
            members,
            scale: ctx.snapshot.units.metresPerDrawingUnit,
            business: ctx.snapshot.business,
            quantityKind: "net_area",
          },
          signal,
        );
        const issues: any[] = [
          {
            check: "units",
            status: ctx.snapshot.units.confirmed ? "passed" : "failed",
            severity: "blocking",
            reason: ctx.snapshot.units.confirmed
              ? "单位已采用"
              : "UNITS_UNCONFIRMED",
            occurrenceIds: members,
          },
          {
            check: "import",
            status: a.importCompleteness === "complete" ? "passed" : "failed",
            severity: "warning",
            reason:
              a.importCompleteness === "complete"
                ? "当前受支持实体解析完成"
                : "存在未覆盖对象或读取通知",
            occurrenceIds: [],
            evidence: {
              diagnostics: a.diagnostics,
              notifications: a.notifications,
            },
          },
          ...measured.items.map((i: any) => ({
            check: "contour",
            status:
              i.status === "valid"
                ? "passed"
                : i.reason === "UNSUPPORTED_GEOMETRY"
                  ? "unsupported"
                  : "failed",
            severity: "warning",
            reason: i.reason ?? "闭合共面轮廓有效",
            occurrenceIds: [i.id],
            evidence: i,
          })),
          {
            check: "independent_cad_roundtrip",
            status: "not_run",
            severity: "blocking",
            reason: "需要独立 CAD 对照验收",
            occurrenceIds: [],
          },
          {
            check: "duplicate_overlap",
            status: "not_run",
            severity: "warning",
            reason: "重复/重叠检查器尚未实现",
            occurrenceIds: [],
          },
        ].map((i) => ({
          id: id("issue"),
          checkerVersion: "bwc-check-1",
          geometrySnapshotId: ctx.snapshot.id,
          ...i,
        }));
        for (const issue of issues) s.put("issue", issue);
        return {
          workingRevision: ctx.revision.id,
          geometrySnapshotId: ctx.snapshot.id,
          issues,
          completeness: issues.some((i) => i.status !== "passed")
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
        "hatch/dimension rendering",
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
