import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, atomicJson, hash, id, now, within } from "./util.ts";
import { worker } from "./workers.ts";
import type { Artifact, Drawing, Takeoff } from "./types.ts";
import type { WorkflowService } from "./service.ts";
import { importReport } from "./diagnostics.ts";
const csvValue = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
export function resultExport(service: WorkflowService, input: any) {
  const s = service.catalog.open(input.projectId),
    ctx = s.context(input.workingRevision, input.geometrySnapshotId);
  const result = input.resultVersion
    ? s.get<Takeoff>("takeoff", input.resultVersion)
    : null;
  if (result)
    assert(
      result.geometrySnapshotId === ctx.snapshot.id &&
        result.workingRevision === ctx.revision.id,
      "SNAPSHOT_MISMATCH",
      "报告与结果快照不匹配",
    );
  return service.job(
    s,
    "result_export",
    input.operationId,
    { revision: ctx.revision.id, result: result?.id ?? null },
    async (signal) => {
      const eid = id("export"),
        dir = `exports/${eid}`;
      mkdirSync(join(s.path, dir), { recursive: true });
      const drawing = s.get<Drawing>("drawing", ctx.snapshot.drawingVersion);
      copyFileSync(
        s.file(drawing.path, drawing.sha256),
        join(s.path, dir, "source.dwg"),
      );
      const a = s.artifact(ctx.snapshot);
      const check = service.issues({
        projectId: input.projectId,
        workingRevision: ctx.revision.id,
        geometrySnapshotId: ctx.snapshot.id,
      });
      const issues = check.issues;
      const report = {
        schemaVersion: 1,
        exportId: eid,
        createdAt: now(),
        workingRevision: ctx.revision.id,
        geometrySnapshotId: ctx.snapshot.id,
        parseArtifactVersion: ctx.snapshot.parseArtifactVersion,
        adapter: {
          parser: a.parser,
          parserVersion: a.parserVersion,
          adapterVersion: a.adapterVersion ?? "bwc-cad-1",
          coordinateContractVersion: a.coordinateContractVersion,
        },
        drawing,
        unitProfile: ctx.snapshot.units,
        patches: ctx.snapshot.patches,
        business: ctx.snapshot.business,
        result: result
          ? {
              ...result,
              validity:
                result.workingRevision === s.current().id ? "valid" : "stale",
            }
          : null,
        issues,
        checkRunId: check.checkRunId,
        importCompleteness: ctx.snapshot.importCompleteness,
        importReport: importReport(a),
        diagnostics: a.diagnostics,
        notifications: a.notifications,
        conversions: s.all("conversion"),
        scope: "frozen_selection_only",
        completeDelivery: false,
      };
      atomicJson(join(s.path, dir, "report.json"), report);
      if (result) {
        const rows = [
          ["对象实例", "状态", "数量", "单位", "方法", "公式", "缺项"],
          ...result.items.map((i) => [
            i.id,
            i.status,
            i.value,
            result.unit,
            i.methodVersion,
            i.formula,
            i.reason,
          ]),
        ];
        writeFileSync(
          join(s.path, dir, "quantities.csv"),
          "\ufeff" + rows.map((r) => r.map(csvValue).join(",")).join("\r\n"),
        );
      }
      const manifest = {
        id: eid,
        schemaVersion: 1,
        workingRevision: ctx.revision.id,
        geometrySnapshotId: ctx.snapshot.id,
        deliveryKind:
          drawing.role === "compatible_copy"
            ? "compatible_copy_project_patch"
            : "source_and_project_patch",
        mainDrawing: {
          path: "source.dwg",
          sha256: hash(readFileSync(join(s.path, dir, "source.dwg"))),
          edited: false,
        },
        dependencies: a.dependencies.map((d) => ({
          ...d,
          status: "not_packaged",
        })),
        roundtrip: "not_applicable_source_copy",
        dependencyMigration: a.dependencies.length
          ? "not_run"
          : "not_applicable",
        requiredResources: a.resources ?? [],
        displayResources: "not_verified",
        completeDelivery: false,
        limitation:
          "source.dwg is the immutable input. Native edits and business parameters are in report.json; this is not an edited DWG delivery.",
        files: [
          "source.dwg",
          "report.json",
          ...(result ? ["quantities.csv"] : []),
        ],
      };
      atomicJson(join(s.path, dir, "export-manifest.json"), manifest);
      if (signal.aborted) assert(false, "CANCELLED", "任务已取消");
      s.put("export", { ...manifest, path: dir });
      return {
        ...manifest,
        path: dir,
        files: [...manifest.files, "export-manifest.json"].map((name) => ({
          name,
          path: `${dir}/${name}`,
        })),
      };
    },
    ctx,
  );
}
export function dwgExport(service: WorkflowService, input: any) {
  const s = service.catalog.open(input.projectId),
    ctx = s.context(input.workingRevision, input.geometrySnapshotId),
    a = s.artifact(ctx.snapshot),
    drawing = s.get<Drawing>("drawing", ctx.snapshot.drawingVersion);
  assert(
    input.mode === "candidate",
    "ROUNDTRIP_UNVERIFIED",
    "完整交付尚未通过独立 CAD 验收；可以明确导出待核验候选图",
  );
  assert(ctx.snapshot.units.confirmed, "UNITS_UNCONFIRMED", "请先确认采用单位");
  assert(
    a.importCompleteness === "complete" &&
      a.diagnostics.length === 0 &&
      a.notifications.length === 0,
    "ROUNDTRIP_UNVERIFIED",
    "存在未支持对象或读取通知，不能重写完整文档",
  );
  assert(
    a.dependencies.length === 0,
    "DEPENDENCY_PACKAGE_UNVERIFIED",
    "依赖路径重写与迁移尚未验收",
  );
  assert(
    a.dwgVersion !== "AC1021",
    "UNSUPPORTED_ENTITY",
    "当前后端不支持 AC1021 写入",
  );
  const unitMap = new Map([
    [0.001, 4],
    [0.01, 5],
    [1, 6],
    [0.0254, 1],
    [0.3048, 2],
    [1000, 7],
  ]);
  const insUnits = unitMap.get(ctx.snapshot.units.metresPerDrawingUnit!);
  assert(
    insUnits,
    "UNITS_UNSUPPORTED_EXPORT",
    "采用单位不能直接表达为目标 DWG 单位元数据，需要独立坐标换算变更",
  );
  return service.job(
    s,
    "dwg_export",
    input.operationId,
    { revision: ctx.revision.id, mode: input.mode },
    async (signal) => {
      const eid = id("export"),
        dir = `exports/${eid}`;
      const output = join(s.path, dir, "candidate.dwg");
      const parsed = await worker<Artifact>(
        "cad",
        {
          mode: "export",
          input: s.file(drawing.path, drawing.sha256),
          output,
          patches: ctx.snapshot.patches,
          insUnits,
        },
        signal,
      );
      service.assignIds(parsed, ctx.snapshot.drawingVersion);
      // DWG header may change to reflect adopted units; native coordinates must remain those of this snapshot.
      assert(
        hash(JSON.stringify(parsed.occurrences)) ===
          hash(JSON.stringify(a.occurrences)),
        "SNAPSHOT_MISMATCH",
        "导出重建几何与冻结快照不一致",
      );
      assert(
        parsed.roundtrip?.stateEqual,
        "ROUNDTRIP_UNVERIFIED",
        "程序往返比较未通过",
      );
      const mapping = parsed.occurrences.map((o) => ({
        entityId: o.entityId,
        occurrenceId: o.occurrenceId,
        outputHandle: o.sourceHandle,
        instancePath: o.instancePath,
      }));
      atomicJson(join(s.path, dir, "object-map.json"), mapping);
      const manifest = {
        id: eid,
        schemaVersion: 1,
        workingRevision: ctx.revision.id,
        geometrySnapshotId: ctx.snapshot.id,
        mainDrawing: {
          path: "candidate.dwg",
          sha256: hash(readFileSync(output)),
          sourceSha256: drawing.sha256,
          insUnits,
        },
        deliveryKind:
          drawing.role === "compatible_copy"
            ? "compatible_copy_candidate"
            : "candidate_dwg",
        contentRoundtrip: parsed.roundtrip,
        dependencyMigration: "not_applicable",
        requiredResources: a.resources ?? [],
        displayResources: "not_verified",
        independentCad: "not_run",
        completeDelivery: false,
        requiredAction:
          "Open in independent CAD, verify layers/layouts/fonts/known geometry and record evidence before complete delivery.",
      };
      atomicJson(join(s.path, dir, "export-manifest.json"), manifest);
      s.put("export", { ...manifest, path: dir });
      return {
        ...manifest,
        path: dir,
        files: ["candidate.dwg", "object-map.json", "export-manifest.json"].map(
          (name) => ({ name, path: `${dir}/${name}` }),
        ),
      };
    },
    ctx,
  );
}
