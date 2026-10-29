import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { componentTakeoff, type DrawingComponent } from "./components.ts";
import type { ScopeCoverage } from "./coverage.ts";
import type { Job, Takeoff } from "./types.ts";
import { assert, atomicJson, canonical, hash, id, now } from "./util.ts";
import type { WorkspaceDomain } from "./workspace-domain.ts";
export type ScopeQuantity =
  | "business_count"
  | "length"
  | "net_area"
  | "parameter_volume";
interface Child {
  drawingId: string;
  revisionId: string;
  snapshotId: string;
  componentVersions: Record<string, number>;
  blockedComponentIds?: string[];
  jobId?: string;
  operationId: string;
  error?: { code: string; message: string };
}
interface ScopeResult {
  id: string;
  operationId: string;
  requestFingerprint: string;
  coverageId: string;
  coverageVersion: number;
  coverageFingerprint: string;
  coverageReviewId: string | null;
  frozenCoverage: ScopeCoverage;
  manifestId: string;
  quantityKind: ScopeQuantity;
  createdAt: string;
  children: Child[];
}
export class ScopeTakeoffService {
  constructor(private domain: WorkspaceDomain) {}
  run(input: {
    coverageId: string;
    quantityKind: ScopeQuantity;
    operationId: string;
  }) {
    const fp = hash(
        canonical({
          coverageId: input.coverageId,
          quantityKind: input.quantityKind,
        }),
      ),
      store = this.domain.auditStore;
    const prior = store
      .all<ScopeResult>("scope_result")
      .find((r) => r.operationId === input.operationId);
    if (prior) {
      assert(
        prior.requestFingerprint === fp,
        "OPERATION_ID_CONFLICT",
        "操作 ID 已用于不同跨图算量请求",
      );
      return this.get(prior.id);
    }
    const coverage = this.domain.coverage.state(input.coverageId);
    assert(
      !coverage.stale,
      "COVERAGE_STALE",
      "图纸或候选已变化，请重新准备覆盖范围",
    );
    const resultId = id("scope_result");
    const children = coverage.drawings.map((d) => ({
      drawingId: d.drawingId,
      revisionId: d.revisionId,
      snapshotId: d.snapshotId,
      componentVersions: Object.fromEntries(
        d.components
          .filter((c) => d.targetComponentIds.includes(c.id))
          .map((c) => [c.id, c.version]),
      ),
      blockedComponentIds: coverage.semanticDuplicates.flatMap((group) =>
        group
          .filter((member) => member.drawingId === d.drawingId)
          .map((member) => member.componentId),
      ),
      operationId: `${resultId}:${d.drawingId}`,
    }));
    const result: ScopeResult = {
      id: resultId,
      operationId: input.operationId,
      requestFingerprint: fp,
      coverageId: input.coverageId,
      coverageVersion: coverage.record.version,
      coverageFingerprint: coverage.record.fingerprint,
      coverageReviewId: coverage.record.reviewId ?? null,
      frozenCoverage: coverage.record,
      manifestId: coverage.record.manifestId,
      quantityKind: input.quantityKind,
      createdAt: now(),
      children,
    };
    store.put("scope_result", result);
    for (const child of result.children) {
      const componentIds = Object.keys(child.componentVersions).filter(
        (id) => !child.blockedComponentIds?.includes(id),
      );
      if (!componentIds.length) continue;
      try {
        const job = componentTakeoff(this.domain.service, {
          projectId: child.drawingId,
          workingRevision: child.revisionId,
          geometrySnapshotId: child.snapshotId,
          componentIds,
          quantityKind: input.quantityKind,
          operationId: child.operationId,
        });
        child.jobId = job.id;
      } catch (error) {
        child.error = {
          code: (error as any).code ?? "SCOPE_CHILD_BLOCKED",
          message: (error as Error).message,
        };
      }
      store.put("scope_result", result);
    }
    return this.get(result.id);
  }
  get(resultId: string) {
    const record = this.domain.auditStore.get<ScopeResult>(
        "scope_result",
        resultId,
      ),
      coverage = this.domain.coverage.state(record.coverageId);
    const children = record.children.map((child) => {
      const store = this.domain.catalog.open(child.drawingId);
      // Reconcile the launch/record gap by committed operation ID, never by replaying work.
      const job = child.jobId
        ? store.get<Job>("job", child.jobId)
        : store
            .all<Job>("job")
            .find((j) => j.operationId === child.operationId);
      const result: Takeoff | undefined =
        job?.result?.id && store.has("takeoff", job.result.id)
          ? store.get<Takeoff>("takeoff", job.result.id)
          : undefined;
      const changed =
        store.current().id !== child.revisionId ||
        Object.entries(child.componentVersions).some(
          ([id, version]) =>
            store.get<DrawingComponent>("component", id).version !== version,
        );
      return {
        ...child,
        blockedComponentIds: child.blockedComponentIds ?? [],
        jobId: job?.id ?? null,
        status:
          job?.status ??
          (child.error || child.blockedComponentIds?.length
            ? "blocked"
            : Object.keys(child.componentVersions).length
              ? "interrupted"
              : "no_measurable_components"),
        changed,
        result: result
          ? { ...result, validity: changed ? "stale" : result.validity }
          : null,
      };
    });
    const running = children.some((c) =>
      ["queued", "running"].includes(c.status),
    );
    const calculationComplete = children.every(
      (c) =>
        !c.blockedComponentIds?.length &&
        c.result?.completeness === "complete" &&
        c.result.validity === "valid",
    );
    const coverageChanged =
      coverage.stale ||
      coverage.record.version !== record.coverageVersion ||
      coverage.record.fingerprint !== record.coverageFingerprint ||
      (coverage.record.reviewId ?? null) !== record.coverageReviewId;
    const validCoverage =
      !coverageChanged &&
      coverage.status === "reviewed_complete" &&
      !!record.coverageReviewId;
    const stale =
      coverageChanged ||
      children.some((c) => c.changed || c.result?.validity === "stale");
    const knownSubtotal = children.reduce(
      (sum, c) => sum + (c.result?.knownSubtotal ?? 0),
      0,
    );
    const measurementBlockers: string[] = [];
    if (children.some((child) => child.blockedComponentIds?.length))
      measurementBlockers.push("DUPLICATE_COMPONENT_GEOMETRY");
    if (
      ["net_area", "parameter_volume"].includes(record.quantityKind) &&
      record.frozenCoverage.scope.categories.some(
        (category) => category === "板" || category === "墙",
      )
    ) {
      const unresolvedOpenings = record.children.some((child) =>
        this.domain.catalog
          .open(child.drawingId)
          .all<DrawingComponent>("component")
          .some(
            (c) =>
              c.geometrySnapshotId === child.snapshotId &&
              c.category === "洞口" &&
              c.status !== "rejected",
          ),
      );
      if (unresolvedOpenings)
        measurementBlockers.push("OPENING_RELATIONS_UNVERIFIED");
    }
    const scopeComplete =
      validCoverage &&
      calculationComplete &&
      !running &&
      !measurementBlockers.length;
    return {
      id: record.id,
      operationId: record.operationId,
      manifestId: record.manifestId,
      coverageId: record.coverageId,
      coverageVersion: record.coverageVersion,
      coverageReviewId: record.coverageReviewId,
      quantityKind: record.quantityKind,
      unit: {
        business_count: "component",
        length: "m",
        net_area: "m2",
        parameter_volume: "m3",
      }[record.quantityKind],
      status: running
        ? "running"
        : stale
          ? "stale"
          : scopeComplete
            ? "succeeded"
            : "partial",
      validity: stale ? "stale" : "valid",
      knownSubtotal,
      completeTotal: scopeComplete ? knownSubtotal : null,
      calculationComplete,
      scopeComplete,
      scopeCoverage: coverageChanged ? "incomplete" : coverage.status,
      ruleCheck:
        calculationComplete && !measurementBlockers.length
          ? "passed_geometry_method"
          : "incomplete",
      measurementBlockers,
      subtotalBasis:
        "non_rejected_component_geometry_without_automatic_opening_deduction",
      measurementBasis: "geometric_only",
      normativeRuleBinding: null,
      scope: "frozen_input_manifest_only",
      children,
      createdAt: record.createdAt,
      limitation:
        "对冻结范围内未被排除的构件计算几何量，待确认候选也可计量；人工覆盖审阅、计算齐备和规范依据为独立条件。未绑定地区规范，不称工程清单量。",
    };
  }
  export(input: { scopeResultId: string; operationId: string }) {
    const frozen = this.domain.auditStore.get<ScopeResult>(
      "scope_result",
      input.scopeResultId,
    );
    const drawingId = frozen.children[0].drawingId,
      store = this.domain.catalog.open(drawingId);
    return {
      drawingId,
      ...this.domain.service.job(
        store,
        "scope_result_export",
        input.operationId,
        { scopeResultId: input.scopeResultId },
        async (signal) => {
          const result = this.get(input.scopeResultId);
          assert(
            result.status !== "running",
            "SCOPE_RESULT_RUNNING",
            "请等待跨图计算完成后导出",
          );
          const exportId = id("scope_export"),
            path = join(this.domain.catalog.root, "exports", exportId);
          mkdirSync(path, { recursive: true });
          const coverageAtStart = {
            record: frozen.frozenCoverage,
            review: frozen.coverageReviewId
              ? this.domain.auditStore.get(
                  "coverage_review",
                  frozen.coverageReviewId,
                )
              : null,
          };
          const sources = frozen.children.map((child) => {
            const s = this.domain.catalog.open(child.drawingId),
              { snapshot } = s.context(child.revisionId, child.snapshotId),
              drawing = s.get("drawing", snapshot.drawingVersion);
            const name = `${child.drawingId}.dwg`;
            copyFileSync(
              s.file(drawing.path, drawing.sha256),
              join(path, name),
            );
            return {
              drawingId: child.drawingId,
              revisionId: child.revisionId,
              snapshotId: child.snapshotId,
              path: name,
              sha256: drawing.sha256,
            };
          });
          atomicJson(join(path, "scope-report.json"), {
            schemaVersion: 1,
            exportId,
            createdAt: now(),
            result,
            inputManifest: this.domain.catalog.inputManifest(frozen.manifestId),
            coverageAtStart,
            coverageNow: this.domain.coverage.state(frozen.coverageId),
            sources,
          });
          const csv = (v: unknown) =>
            `"${String(v ?? "").replaceAll('"', '""')}"`;
          const rows = [
            ["图纸", "构件", "状态", "数值", "单位", "方法", "公式", "缺项"],
            ...result.children.flatMap((child) =>
              (child.result?.items ?? []).map((item) => [
                child.drawingId,
                item.id,
                item.status,
                item.value,
                child.result!.unit,
                item.methodVersion,
                item.formula,
                item.reason,
              ]),
            ),
          ];
          writeFileSync(
            join(path, "quantities.csv"),
            "\ufeff" + rows.map((row) => row.map(csv).join(",")).join("\r\n"),
          );
          assert(!signal.aborted, "CANCELLED", "导出已取消");
          let ancestor = this.domain.service.outputDirectory!;
          while (!existsSync(ancestor)) ancestor = dirname(ancestor);
          const real = realpathSync(ancestor),
            root = this.domain.catalog.workspaceRoot;
          assert(
            real === root || real.startsWith(root + sep),
            "INVALID_PATH",
            "成果目录必须位于工作目录内",
          );
          const outputPath = join(
            this.domain.service.outputDirectory!,
            exportId,
          );
          mkdirSync(outputPath, { recursive: true });
          cpSync(path, outputPath, { recursive: true });
          const exported = {
            id: exportId,
            scopeResultId: result.id,
            path: outputPath,
            manifestId: frozen.manifestId,
            coverageReviewId: frozen.coverageReviewId,
            scopeComplete: result.scopeComplete,
            validity: result.validity,
            measurementBasis: result.measurementBasis,
            completeDelivery: false,
          };
          this.domain.auditStore.put("scope_export", exported);
          return exported;
        },
      ),
    };
  }
}
