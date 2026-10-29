import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  ComponentReviewSchema,
  reviewComponent,
  type DrawingComponent,
} from "./components.ts";
import type { WorkspaceDomain } from "./workspace-domain.ts";
import { assert, canonical, hash, id, now } from "./util.ts";

export class ReviewService {
  sessions = new Map<
    string,
    {
      drawingId: string;
      batchId: string;
      expiresAt: number;
      coverageId?: string;
    }
  >();
  constructor(private domain: WorkspaceDomain) {}
  prepare(drawingId: string, revisionId?: string) {
    const s = this.domain.catalog.open(drawingId),
      { revision, snapshot } = s.context(revisionId);
    const componentVersions = Object.fromEntries(
      s
        .all<DrawingComponent>("component")
        .filter((c) => c.geometrySnapshotId === snapshot.id)
        .map((c) => [c.id, c.version]),
    );
    const content = {
      drawingId,
      workingRevision: revision.id,
      geometrySnapshotId: snapshot.id,
      componentVersions,
    };
    const batch = {
      id: id("review"),
      ...content,
      fingerprint: hash(canonical(content)),
      createdAt: now(),
    };
    s.put("review_batch", batch);
    return batch;
  }
  open(drawingId: string, batchId?: string, coverageId?: string) {
    const frozen = coverageId
      ? this.domain.coverage
          .get(coverageId)
          .frozen.find((d) => d.drawingId === drawingId)
      : undefined;
    assert(
      !coverageId || frozen,
      "INVALID_COVERAGE_SCOPE",
      "图纸不属于指定覆盖范围",
    );
    const s = this.domain.catalog.open(drawingId);
    const batch = batchId
      ? s.get("review_batch", batchId)
      : this.prepare(drawingId, frozen?.revisionId);
    const token = randomBytes(24).toString("hex"),
      expiresAt = Date.now() + 30 * 60 * 1000;
    assert(
      !frozen || frozen.revisionId === batch.workingRevision,
      "COVERAGE_STALE",
      "审阅批次与覆盖范围版本不符",
    );
    this.sessions.set(token, {
      drawingId,
      batchId: batch.id,
      expiresAt,
      coverageId,
    });
    return { token, batch, expiresAt };
  }
  refresh(token: string) {
    const session = this.session(token);
    session.batchId = this.prepare(session.drawingId).id;
    return this.state(token);
  }
  session(token: string) {
    const session = this.sessions.get(token);
    assert(
      session && session.expiresAt > Date.now(),
      "REVIEW_EXPIRED",
      "审阅链接已过期，请重新打开",
    );
    return session;
  }
  state(token: string) {
    const session = this.session(token),
      s = this.domain.catalog.open(session.drawingId),
      batch = s.get("review_batch", session.batchId);
    const { snapshot } = s.context(
      batch.workingRevision,
      batch.geometrySnapshotId,
    );
    const components = s
      .all<DrawingComponent>("component")
      .filter((c) => c.geometrySnapshotId === snapshot.id);
    const stale =
      s.current().id !== batch.workingRevision ||
      canonical(
        Object.fromEntries(components.map((c) => [c.id, c.version])),
      ) !== canonical(batch.componentVersions);
    return {
      batch,
      stale,
      drawing: s.meta(),
      preview: this.domain.service.preview({
        projectId: session.drawingId,
        workingRevision: batch.workingRevision,
      }),
      components,
      policy: this.domain.catalog.policy(),
      results: s.all("takeoff"),
      diagnostics: this.domain.service.diagnostics({
        projectId: session.drawingId,
        workingRevision: batch.workingRevision,
      }),
      scopeResults: this.domain.auditStore
        .all<any>("scope_result")
        .filter((r) =>
          r.children.some(
            (child: any) => child.drawingId === session.drawingId,
          ),
        )
        .map((r) => this.domain.scopeTakeoff.get(r.id)),
      scopeCoverage: session.coverageId
        ? this.domain.coverage.status(session.coverageId).status
        : "unknown",
      coverage: session.coverageId
        ? this.domain.coverage.state(session.coverageId)
        : null,
    };
  }
  coverageAction(token: string, action: string, input: any) {
    const session = this.session(token);
    assert(session.coverageId, "INVALID_COVERAGE_SCOPE", "链接未绑定覆盖审阅");
    if (action === "exclude")
      return this.domain.coverage.exclude(session.coverageId, input);
    if (action === "restore")
      return this.domain.coverage.restore(session.coverageId, input);
    if (action === "review")
      return this.domain.coverage.review(session.coverageId, input);
    if (action === "refresh") {
      const updated = this.domain.coverage.rebase(session.coverageId);
      session.coverageId = updated.coverageId;
      session.batchId = this.prepare(session.drawingId).id;
      return this.state(token);
    }
    if (action === "drawing") {
      const parsed = z.object({ drawingId: z.string() }).strict().parse(input);
      const frozen = this.domain.coverage
        .get(session.coverageId)
        .frozen.find((d) => d.drawingId === parsed.drawingId);
      assert(frozen, "INVALID_COVERAGE_SCOPE", "图纸不属于覆盖范围");
      session.drawingId = parsed.drawingId;
      session.batchId = this.prepare(parsed.drawingId, frozen.revisionId).id;
      return this.state(token);
    }
    assert(false, "NOT_FOUND", "覆盖审阅操作不存在");
  }
  async submit(token: string, input: unknown, source = "local_web") {
    const session = this.session(token),
      state = this.state(token);
    assert(!state.stale, "REVIEW_STALE", "版本已变化，请重新打开审阅批次");
    const request = z
      .object({
        fingerprint: z.string(),
        reviews: z
          .array(
            ComponentReviewSchema.omit({
              projectId: true,
              workingRevision: true,
              geometrySnapshotId: true,
            }),
          )
          .min(1)
          .max(1000),
      })
      .strict()
      .parse(input);
    assert(
      request.fingerprint === state.batch.fingerprint,
      "REVIEW_MISMATCH",
      "核对内容指纹不一致",
    );
    const ids = new Set<string>();
    for (const review of request.reviews) {
      assert(
        !ids.has(review.componentId) &&
          state.batch.componentVersions[review.componentId] ===
            review.expectedVersion,
        "REVIEW_MISMATCH",
        "核对对象或版本不属于冻结批次",
      );
      ids.add(review.componentId);
    }
    const s = this.domain.catalog.open(session.drawingId);
    return s.transaction(() => {
      const reviewed = request.reviews.map((r) =>
        reviewComponent(this.domain.service, {
          ...r,
          projectId: session.drawingId,
          workingRevision: state.batch.workingRevision,
          geometrySnapshotId: state.batch.geometrySnapshotId,
        }),
      );
      s.put("review_event", {
        id: id("rev"),
        batchId: state.batch.id,
        fingerprint: request.fingerprint,
        source,
        at: now(),
        componentVersions: Object.fromEntries(
          reviewed.map((c) => [c.id, c.version]),
        ),
      });
      return { reviewed: reviewed.length, requiresRefresh: true };
    });
  }
  async adoptUnits(token: string, input: unknown, source = "local_web") {
    const session = this.session(token),
      state = this.state(token);
    assert(!state.stale, "REVIEW_STALE", "版本已变化，请刷新核对");
    const parsed = z
      .object({
        fingerprint: z.string(),
        metresPerDrawingUnit: z.number().finite().positive().max(1e9),
        evidence: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(input);
    assert(
      parsed.fingerprint === state.batch.fingerprint,
      "REVIEW_MISMATCH",
      "核对指纹不一致",
    );
    const projectId = session.drawingId,
      operation = {
        kind: "set_units" as const,
        metresPerDrawingUnit: parsed.metresPerDrawingUnit,
        evidence: parsed.evidence,
      };
    const intent = this.domain.service.recordIntent({
      projectId,
      workingRevision: state.batch.workingRevision,
      operation,
    });
    const candidate = await this.domain.service.propose({
      projectId,
      baseRevision: state.batch.workingRevision,
      baseGeometrySnapshotId: state.batch.geometrySnapshotId,
      intentId: intent.id,
      operation,
      operationId: `${state.batch.id}:units`,
    });
    assert(
      !this.state(token).stale,
      "REVIEW_STALE",
      "版本已变化，请重新核对单位",
    );
    const result = await this.domain.service.apply({
      projectId,
      changeId: candidate.id,
      baseRevision: candidate.baseRevision,
      candidateFingerprint: candidate.candidateFingerprint,
      operationId: candidate.operationId,
    });
    this.domain.catalog.open(projectId).put("review_event", {
      id: id("rev"),
      batchId: state.batch.id,
      fingerprint: state.batch.fingerprint,
      source,
      at: now(),
      action: "units",
      metresPerDrawingUnit: parsed.metresPerDrawingUnit,
      evidence: parsed.evidence,
    });
    return result;
  }
  setPolicy(token: string, input: unknown, source = "local_web") {
    const state = this.state(token);
    assert(!state.stale, "REVIEW_STALE", "版本已变化，请刷新");
    const parsed = z
      .object({ mode: z.enum(["summary", "geometry"]) })
      .strict()
      .parse(input);
    return this.domain.catalog.setPolicy(
      parsed.mode,
      source,
      parsed.mode === "geometry" ? [state.batch.geometrySnapshotId] : [],
    );
  }
  status(drawingId: string, batchId: string) {
    const s = this.domain.catalog.open(drawingId),
      batch = s.get("review_batch", batchId);
    return {
      ...batch,
      stale:
        s.current().id !== batch.workingRevision ||
        canonical(
          Object.fromEntries(
            s
              .all<DrawingComponent>("component")
              .filter((c) => c.geometrySnapshotId === batch.geometrySnapshotId)
              .map((c) => [c.id, c.version]),
          ),
        ) !== canonical(batch.componentVersions),
    };
  }
}
