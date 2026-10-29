import { z } from "zod";
import { componentCategories } from "../shared/component-categories.ts";
import type { DrawingComponent } from "./components.ts";
import { primitives } from "./geometry.ts";
import { diagnosticHandles, importReport } from "./diagnostics.ts";
import { SelectionRef } from "./schemas.ts";
import { assert, canonical, hash, id, now } from "./util.ts";
import type { WorkspaceDomain } from "./workspace-domain.ts";

export const CoverageScopeSchema = z
  .object({
    discipline: z.string().trim().min(1).max(100),
    categories: z.array(z.enum(componentCategories)).min(1).max(20),
    drawings: z
      .array(
        z
          .object({
            drawingId: z.string(),
            floor: z.string().trim().min(1).max(100).nullable(),
            viewPurpose: z.string().trim().min(1).max(100).nullable(),
            selectionSet: SelectionRef.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
type Scope = z.infer<typeof CoverageScopeSchema>;
interface FrozenDrawing {
  drawingId: string;
  revisionId: string;
  snapshotId: string;
  artifactHash: string;
  sourceMembers: string[];
  candidateFingerprint: string;
}
interface Exclusion {
  id: string;
  drawingId: string;
  occurrenceIds: string[];
  reason: string;
  evidence: string;
  at: string;
  source: "local_web";
}
export interface ScopeCoverage {
  id: string;
  manifestId: string;
  scope: Scope;
  frozen: FrozenDrawing[];
  fingerprint: string;
  version: number;
  exclusions: Exclusion[];
  createdAt: string;
  reviewId?: string;
}
const candidateContent = (components: DrawingComponent[]) =>
  components
    .map((c) => ({
      id: c.id,
      version: c.version,
      status: c.status,
      category: c.category,
      floor: c.floor,
      members: [...c.members].sort(),
      geometryRole: c.geometryRole,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

export class CoverageService {
  constructor(private domain: WorkspaceDomain) {}
  private candidates(frozen: FrozenDrawing) {
    const selected = new Set(frozen.sourceMembers);
    return this.domain.catalog
      .open(frozen.drawingId)
      .all<DrawingComponent>("component")
      .filter(
        (c) =>
          c.geometrySnapshotId === frozen.snapshotId &&
          c.members.some((m) => selected.has(m)),
      );
  }
  private save(record: ScopeCoverage) {
    const store = this.domain.auditStore;
    store.put("scope_coverage", record);
    store.put("coverage_version", {
      ...record,
      id: `${record.id}:${record.version}`,
    });
  }
  get(coverageId: string) {
    return this.domain.auditStore.get<ScopeCoverage>(
      "scope_coverage",
      coverageId,
    );
  }
  prepare(manifestId: string, input: unknown) {
    const scope = CoverageScopeSchema.parse(input),
      manifest = this.domain.catalog.inputManifest(manifestId);
    const members = manifest.members as unknown as {
      drawingId: string;
      revisionId: string;
      snapshotId: string;
    }[];
    assert(
      new Set(scope.drawings.map((d) => d.drawingId)).size ===
        scope.drawings.length &&
        scope.drawings.length === members.length &&
        scope.drawings.every((d) =>
          members.some((m) => m.drawingId === d.drawingId),
        ),
      "INVALID_COVERAGE_SCOPE",
      "范围必须逐张绑定冻结输入清单，不能省略参与图纸",
    );
    assert(
      scope.categories.every((c) => c !== "未分类"),
      "INVALID_COVERAGE_SCOPE",
      "覆盖目标类别不能为未分类",
    );
    const frozen = members
      .map((m) => {
        const store = this.domain.catalog.open(m.drawingId),
          ctx = store.context(m.revisionId, m.snapshotId);
        assert(
          store.current().id === m.revisionId,
          "COVERAGE_STALE",
          "输入清单已非当前图纸版本，请重新冻结",
        );
        const target = scope.drawings.find((d) => d.drawingId === m.drawingId)!;
        // Freeze source inventory independently of the recognizer's candidate list.
        const sourceMembers = target.selectionSet
          ? [
              ...this.domain.service.selected(
                store,
                ctx.snapshot,
                target.selectionSet,
              ).members,
            ].sort()
          : store
              .occurrences(m.snapshotId)
              .filter((o) => o.space === "model")
              .map((o) => o.occurrenceId)
              .sort();
        assert(
          sourceMembers.length > 0,
          "INVALID_COVERAGE_SCOPE",
          "审阅范围必须包含真实来源",
        );
        const drawing: FrozenDrawing = {
          ...m,
          artifactHash: ctx.snapshot.artifactSha256,
          sourceMembers,
          candidateFingerprint: "",
        };
        drawing.candidateFingerprint = hash(
          canonical(candidateContent(this.candidates(drawing))),
        );
        return drawing;
      })
      .sort((a, b) => a.drawingId.localeCompare(b.drawingId));
    const record: ScopeCoverage = {
      id: id("coverage"),
      manifestId,
      scope,
      frozen,
      fingerprint: hash(
        canonical({ manifestId, scope, frozen, exclusions: [] }),
      ),
      version: 1,
      exclusions: [],
      createdAt: now(),
    };
    this.domain.auditStore.transaction(() => this.save(record));
    return this.status(record.id);
  }
  state(coverageId: string) {
    const record = this.get(coverageId);
    const staleReasons: string[] = [];
    const drawings = record.frozen.map((frozen) => {
      const store = this.domain.catalog.open(frozen.drawingId),
        { snapshot } = store.context(frozen.revisionId, frozen.snapshotId);
      const target = record.scope.drawings.find(
        (d) => d.drawingId === frozen.drawingId,
      )!;
      const components = this.candidates(frozen),
        members = new Set(frozen.sourceMembers);
      if (store.current().id !== frozen.revisionId)
        staleReasons.push(`${frozen.drawingId}:revision_changed`);
      if (
        hash(canonical(candidateContent(components))) !==
        frozen.candidateFingerprint
      )
        staleReasons.push(`${frozen.drawingId}:candidates_changed`);
      const artifact = store.artifact(snapshot),
        report = importReport(artifact);
      const targetComponents = components.filter((c) =>
        record.scope.categories.includes(c.category),
      );
      const measurable = targetComponents.filter(
        (c) => c.status !== "rejected",
      );
      const exclusions = new Map(
        record.exclusions
          .filter((e) => e.drawingId === frozen.drawingId)
          .flatMap((e) => e.occurrenceIds.map((oid) => [oid, e] as const)),
      );
      const bySource = new Map<string, string[]>();
      for (const c of measurable)
        for (const oid of c.members) {
          const owners = bySource.get(oid) ?? [];
          owners.push(c.id);
          bySource.set(oid, owners);
        }
      const rows = store
        .occurrences(snapshot.id)
        .filter((o) => members.has(o.occurrenceId))
        .map((o) => {
          const owners = bySource.get(o.occurrenceId) ?? [],
            exclusion = exclusions.get(o.occurrenceId);
          return {
            occurrenceId: o.occurrenceId,
            entityType: o.entityType,
            sourceHandle: o.sourceHandle,
            instancePath: o.instancePath,
            layer: o.layer,
            hasGeometry: !!o.geometry,
            componentIds: owners,
            status:
              owners.length > 1
                ? "duplicate"
                : owners.length
                  ? "assigned"
                  : exclusion
                    ? "excluded"
                    : "unassigned",
            exclusion: exclusion ?? null,
          };
        });
      const gaps = report.diagnosticGroups.flatMap((group) => {
        const handles = diagnosticHandles(artifact, group.id),
          affected = artifact.occurrences.filter((o) =>
            handles.has(o.sourceHandle),
          );
        // Unlocated records remain unresolved even in a spatial subset.
        if (
          affected.length &&
          group.uninstantiatedSources === 0 &&
          affected.every((o) => !members.has(o.occurrenceId))
        )
          return [];
        return [
          {
            id: group.id,
            code: group.code,
            reason: group.reason,
            unlocated: !affected.length || group.uninstantiatedSources > 0,
            occurrenceIds: affected
              .filter((o) => members.has(o.occurrenceId))
              .map((o) => o.occurrenceId),
          },
        ];
      });
      const blockers: string[] = [];
      if (!target.floor) blockers.push("FLOOR_UNKNOWN");
      if (!target.viewPurpose) blockers.push("VIEW_PURPOSE_UNKNOWN");
      if (rows.some((r) => r.status === "unassigned"))
        blockers.push("UNASSIGNED_SOURCES");
      if (rows.some((r) => r.status === "duplicate"))
        blockers.push("DUPLICATE_SOURCE_OWNERSHIP");
      if (rows.some((r) => !r.hasGeometry))
        blockers.push("SOURCE_GEOMETRY_MISSING");
      if (measurable.some((c) => !c.floor || c.floor !== target.floor))
        blockers.push("COMPONENT_FLOOR_UNCONFIRMED");
      if (measurable.some((c) => c.members.some((m) => !members.has(m))))
        blockers.push("COMPONENT_CROSSES_SCOPE");
      if (rows.some((r) => r.status === "assigned" && r.exclusion))
        blockers.push("EXCLUSION_OWNERSHIP_CONFLICT");
      if (gaps.length) blockers.push("PARSER_GAPS");
      if (artifact.dependencies.length)
        blockers.push("DEPENDENCIES_UNVERIFIED");
      if (artifact.notifications.length)
        blockers.push("PARSER_NOTICES_UNVERIFIED");
      if (
        artifact.importCompleteness === "partial" &&
        !report.diagnosticGroups.length
      )
        blockers.push("PARSER_COVERAGE_PARTIAL");
      return {
        ...frozen,
        floor: target.floor,
        viewPurpose: target.viewPurpose,
        sourceScope: target.selectionSet
          ? "explicit_source_subset"
          : "entire_model_view",
        rows,
        components,
        targetComponentIds: measurable.map((c) => c.id),
        gaps,
        blockers,
      };
    });
    const semanticGroups = new Map<
      string,
      { drawingId: string; componentId: string }[]
    >();
    for (const drawing of drawings)
      for (const component of drawing.components.filter((c) =>
        drawing.targetComponentIds.includes(c.id),
      )) {
        if (!component.geometry || !component.floor) continue;
        const curves = primitives(component.geometry)
          .flatMap((g) =>
            g.kind === "path"
              ? g.segments.map((segment) =>
                  segment.kind === "line"
                    ? canonical(
                        [segment.start, segment.end]
                          .map((p) => canonical(p))
                          .sort(),
                      )
                    : canonical(segment),
                )
              : [],
          )
          .sort();
        if (!curves.length) continue;
        const key = hash(
          canonical({
            floor: component.floor,
            category: component.category,
            curves,
          }),
        );
        const members = semanticGroups.get(key) ?? [];
        members.push({
          drawingId: drawing.drawingId,
          componentId: component.id,
        });
        semanticGroups.set(key, members);
      }
    const semanticDuplicates = [...semanticGroups.values()].filter(
      (members) => members.length > 1,
    );
    for (const group of semanticDuplicates)
      for (const member of group) {
        const drawing = drawings.find((d) => d.drawingId === member.drawingId)!;
        if (!drawing.blockers.includes("DUPLICATE_COMPONENT_GEOMETRY"))
          drawing.blockers.push("DUPLICATE_COMPONENT_GEOMETRY");
      }
    const review = record.reviewId
      ? this.domain.auditStore.get<any>("coverage_review", record.reviewId)
      : null;
    const blocked = drawings.some((d) => d.blockers.length > 0);
    const stale = staleReasons.length > 0;
    const reviewed =
      review &&
      review.version === record.version &&
      review.fingerprint === record.fingerprint;
    const status: "unknown" | "incomplete" | "reviewed_complete" = stale
      ? "incomplete"
      : reviewed && review.conclusion === "reviewed_complete" && !blocked
        ? "reviewed_complete"
        : blocked || reviewed
          ? "incomplete"
          : "unknown";
    return {
      record,
      drawings,
      review,
      semanticDuplicates,
      stale,
      staleReasons,
      status,
      canReviewComplete: !stale && !blocked,
    };
  }
  status(
    coverageId: string,
    page: {
      drawingId?: string;
      status?: string;
      offset?: number;
      limit?: number;
    } = {},
  ) {
    const state = this.state(coverageId),
      drawing = page.drawingId
        ? state.drawings.find((d) => d.drawingId === page.drawingId)
        : undefined;
    assert(
      !page.drawingId || drawing,
      "INVALID_COVERAGE_SCOPE",
      "图纸不在覆盖范围内",
    );
    const rows = (drawing ? [drawing] : state.drawings)
      .flatMap((d) => d.rows.map((r) => ({ ...r, drawingId: d.drawingId })))
      .filter((r) => !page.status || r.status === page.status);
    const offset = page.offset ?? 0,
      limit = page.limit ?? 25;
    return {
      coverageId,
      manifestId: state.record.manifestId,
      version: state.record.version,
      fingerprint: state.record.fingerprint,
      status: state.status,
      stale: state.stale,
      staleReasons: state.staleReasons,
      reviewId: state.record.reviewId ?? null,
      canReviewComplete: state.canReviewComplete,
      scope: state.record.scope,
      semanticDuplicates: state.semanticDuplicates,
      drawings: state.drawings.map((d) => ({
        drawingId: d.drawingId,
        revisionId: d.revisionId,
        geometrySnapshotId: d.snapshotId,
        sourceScope: d.sourceScope,
        counts: {
          sources: d.rows.length,
          unassigned: d.rows.filter((r) => r.status === "unassigned").length,
          excluded: d.rows.filter((r) => r.status === "excluded").length,
          assigned: d.rows.filter((r) => r.status === "assigned").length,
          duplicates: d.rows.filter((r) => r.status === "duplicate").length,
        },
        blockers: d.blockers,
        parserGapCount: d.gaps.length,
      })),
      sourcePage: {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        offset,
        nextOffset: offset + limit < rows.length ? offset + limit : null,
      },
      limitation:
        "源归属仅辅助查漏；完成结论必须由人工对照原图或参考清单独立审阅。",
    };
  }
  private editable(coverageId: string, version: number, fingerprint: string) {
    const state = this.state(coverageId);
    assert(
      !state.stale,
      "COVERAGE_STALE",
      "图纸或候选已变化，请重新准备覆盖审阅",
    );
    assert(
      state.record.version === version &&
        state.record.fingerprint === fingerprint,
      "COVERAGE_VERSION_CONFLICT",
      "覆盖范围或排除依据已变化，请刷新",
    );
    return state;
  }
  exclude(coverageId: string, input: unknown) {
    const parsed = z
      .object({
        expectedVersion: z.number().int().positive(),
        fingerprint: z.string(),
        drawingId: z.string(),
        occurrenceIds: z.array(z.string()).min(1).max(10000),
        reason: z.string().trim().min(1).max(2000),
        evidence: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(input);
    const state = this.editable(
        coverageId,
        parsed.expectedVersion,
        parsed.fingerprint,
      ),
      drawing = state.drawings.find((d) => d.drawingId === parsed.drawingId);
    assert(drawing, "INVALID_COVERAGE_SCOPE", "图纸不属于覆盖范围");
    const ids = [...new Set(parsed.occurrenceIds)].sort();
    assert(
      ids.every((oid) =>
        drawing.rows.some(
          (r) => r.occurrenceId === oid && r.status === "unassigned",
        ),
      ),
      "INVALID_COVERAGE_EXCLUSION",
      "仅可排除冻结范围内未归属来源；不得排除已确认目标构件",
    );
    const exclusion: Exclusion = {
      id: id("exclusion"),
      drawingId: parsed.drawingId,
      occurrenceIds: ids,
      reason: parsed.reason,
      evidence: parsed.evidence,
      at: now(),
      source: "local_web",
    };
    const next = {
      ...state.record,
      version: state.record.version + 1,
      reviewId: undefined,
      exclusions: [...state.record.exclusions, exclusion],
    };
    next.fingerprint = hash(
      canonical({
        manifestId: next.manifestId,
        scope: next.scope,
        frozen: next.frozen,
        exclusions: next.exclusions,
      }),
    );
    this.domain.auditStore.transaction(() => {
      this.save(next);
      this.domain.auditStore.put("coverage_event", {
        id: id("ce"),
        coverageId,
        version: next.version,
        kind: "exclude",
        exclusion,
      });
    });
    return this.status(coverageId);
  }
  restore(coverageId: string, input: unknown) {
    const parsed = z
      .object({
        expectedVersion: z.number().int().positive(),
        fingerprint: z.string(),
        exclusionId: z.string(),
      })
      .strict()
      .parse(input);
    const state = this.editable(
      coverageId,
      parsed.expectedVersion,
      parsed.fingerprint,
    );
    const exclusion = state.record.exclusions.find(
      (e) => e.id === parsed.exclusionId,
    );
    assert(exclusion, "NOT_FOUND", "排除记录不存在");
    const next = {
      ...state.record,
      version: state.record.version + 1,
      reviewId: undefined,
      exclusions: state.record.exclusions.filter(
        (e) => e.id !== parsed.exclusionId,
      ),
    };
    next.fingerprint = hash(
      canonical({
        manifestId: next.manifestId,
        scope: next.scope,
        frozen: next.frozen,
        exclusions: next.exclusions,
      }),
    );
    this.domain.auditStore.transaction(() => {
      this.save(next);
      this.domain.auditStore.put("coverage_event", {
        id: id("ce"),
        coverageId,
        version: next.version,
        kind: "restore",
        exclusion,
        source: "local_web",
        at: now(),
      });
    });
    return this.status(coverageId);
  }
  review(coverageId: string, input: unknown, source = "local_web") {
    const parsed = z
      .object({
        expectedVersion: z.number().int().positive(),
        fingerprint: z.string(),
        conclusion: z.enum(["incomplete", "reviewed_complete"]),
        evidence: z.string().trim().min(1).max(4000),
        reference: z
          .object({
            kind: z.enum(["source_drawing", "reference_inventory"]),
            locator: z.string().trim().min(1).max(2000),
          })
          .strict(),
      })
      .strict()
      .parse(input);
    const state = this.editable(
      coverageId,
      parsed.expectedVersion,
      parsed.fingerprint,
    );
    assert(
      parsed.conclusion !== "reviewed_complete" || state.canReviewComplete,
      "COVERAGE_INCOMPLETE",
      "存在未归属来源、待核对构件、未知归属或解析缺口，不能确认范围完成",
    );
    const review = {
      id: id("coverage_review"),
      coverageId,
      version: state.record.version,
      fingerprint: state.record.fingerprint,
      conclusion: parsed.conclusion,
      evidence: parsed.evidence,
      reference: parsed.reference,
      source,
      at: now(),
    };
    this.domain.auditStore.transaction(() => {
      this.domain.auditStore.put("coverage_review", review);
      this.save({ ...state.record, reviewId: review.id });
    });
    return this.status(coverageId);
  }
  rebase(coverageId: string) {
    const record = this.get(coverageId);
    return this.prepare(record.manifestId, record.scope);
  }
}
