import { z } from "zod";
import { bounds } from "./geometry.ts";
import { assert, hash, id, now, canonical } from "./util.ts";
import { ContextSchema } from "./schemas.ts";
import { worker } from "./workers.ts";
import type { WorkflowService } from "./service.ts";
import type { Geometry, Occurrence, Takeoff, Artifact } from "./types.ts";

import {
  componentCategories,
  type ComponentCategory,
} from "../shared/component-categories.ts";
export type { ComponentCategory } from "../shared/component-categories.ts";
export interface DrawingComponent {
  id: string;
  workingRevision: string;
  geometrySnapshotId: string;
  label: string;
  category: ComponentCategory;
  status: "pending" | "confirmed" | "rejected";
  version: number;
  members: string[];
  layers: string[];
  geometry: Geometry | null;
  bounds: [number, number, number, number];
  geometryRole: "closed_boundary" | "curve" | "symbol_group" | "missing";
  origin: "rule" | "ai" | "manual";
  evidence: string[];
  floor: string;
  material: string;
  thicknessMm?: number;
  createdAt: string;
  reviewedAt?: string;
}
const categorySchema = z.enum(componentCategories);
export const ComponentReviewSchema = ContextSchema.extend({
  componentId: z.string(),
  expectedVersion: z.number().int().positive(),
  status: z.enum(["confirmed", "rejected", "pending"]),
  category: categorySchema,
  label: z.string().trim().min(1).max(100),
  floor: z.string().trim().max(100),
  material: z.string().trim().max(100),
  thicknessMm: z.number().positive().finite().max(100000).optional(),
  evidence: z.string().trim().min(1).max(2000),
}).strict();

function categoryOf(text: string): ComponentCategory {
  if (/窗|WINDOW/i.test(text)) return "窗";
  if (/门|(?:^|[_\s-])DOOR(?:$|[_\s-])/i.test(text)) return "门";
  if (/柱|COLUMN|(?:^|[_\s-])COL(?:$|[_\s-])/i.test(text)) return "柱";
  if (/墙|WALL/i.test(text)) return "墙";
  if (/梁|BEAM/i.test(text)) return "梁";
  if (/楼板|SLAB|S_FLOOR/i.test(text)) return "板";
  if (/洞口|OPENING/i.test(text)) return "洞口";
  return "未分类";
}
const excluded = /AXIS|DIM|TEXT|TITLE|图框|轴线|标注|尺寸/i;
function combinedBounds(rows: Occurrence[]) {
  const boxes = rows
    .map((o) => bounds(o.geometry))
    .filter(Boolean) as number[][];
  assert(
    boxes.length,
    "NO_COMPONENT_GEOMETRY",
    "选择中没有可用源几何，不能创建构件",
  );
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ] as [number, number, number, number];
}
// A single closed source is authoritative. Multiple open paths may form one exact
// endpoint cycle; never bridge gaps or invent coordinates supplied by a model.
export function componentGeometry(rows: Occurrence[]): {
  geometry: Geometry | null;
  geometryRole: DrawingComponent["geometryRole"];
} {
  const shapes = rows.filter(
    (o) => o.geometry && ["path", "region"].includes(o.geometry.kind),
  );
  if (shapes.length === 1) {
    const g = structuredClone(shapes[0].geometry)!;
    return {
      geometry: g,
      geometryRole:
        g.kind === "region" || (g.kind === "path" && g.closed)
          ? "closed_boundary"
          : "curve",
    };
  }
  if (
    shapes.length > 1 &&
    shapes.every(
      (o) =>
        o.geometry?.kind === "path" &&
        !o.geometry.closed &&
        o.geometry.segments.every((s) => s.kind === "line"),
    )
  ) {
    const segments = shapes.flatMap(
      (o) => (o.geometry as Extract<Geometry, { kind: "path" }>).segments,
    );
    const endpoints = (p: number[]) =>
      p.map((v) => (Object.is(v, -0) ? 0 : v)).join(",");
    const adjacency = new Map<string, number[]>();
    segments.forEach((s, i) => {
      if (s.kind !== "line") return;
      for (const p of [s.start, s.end]) {
        const key = endpoints(p);
        adjacency.set(key, [...(adjacency.get(key) ?? []), i]);
      }
    });
    if (
      [...adjacency.values()].every((v) => v.length === 2) &&
      segments.length >= 3
    ) {
      const ordered: typeof segments = [];
      const used = new Set<number>();
      const first = segments[0];
      if (first.kind === "line") {
        let cursor = first.start;
        while (used.size < segments.length) {
          const next = adjacency
            .get(endpoints(cursor))
            ?.find((i) => !used.has(i));
          if (next === undefined) break;
          const s = segments[next];
          if (s.kind !== "line") break;
          const edge =
            endpoints(s.start) === endpoints(cursor)
              ? s
              : { ...s, start: s.end, end: s.start };
          ordered.push(structuredClone(edge));
          used.add(next);
          cursor = edge.end;
        }
        if (
          used.size === segments.length &&
          endpoints(cursor) === endpoints(first.start)
        )
          return {
            geometry: { kind: "path", closed: true, segments: ordered },
            geometryRole: "closed_boundary",
          };
      }
    }
  }
  const parts = rows.flatMap((o) =>
    o.geometry ? [structuredClone(o.geometry)] : [],
  );
  return {
    geometry: parts.length
      ? { kind: "annotation", parts, quantityRole: "annotation_only" }
      : null,
    geometryRole: parts.length ? "symbol_group" : "missing",
  };
}
function context(service: WorkflowService, input: any) {
  const s = service.catalog.open(input.projectId);
  const ctx = s.context(input.workingRevision, input.geometrySnapshotId);
  assert(
    s.current().id === ctx.revision.id,
    "REVISION_CONFLICT",
    "图纸版本已变化，请在当前版本重新识别和确认",
  );
  return { s, ...ctx };
}
function saveCandidate(
  service: WorkflowService,
  input: any,
  members: string[],
  origin: DrawingComponent["origin"],
  category: ComponentCategory,
  evidence: string[],
  label?: string,
  loaded?: ReturnType<typeof context> & { a: Artifact },
) {
  const { s, snapshot, revision } = loaded ?? context(service, input);
  const a = loaded?.a ?? s.artifact(snapshot);
  const unique = [...new Set(members)].sort();
  assert(
    unique.length > 0 && unique.length <= 2000,
    "INVALID_COMPONENT_SCOPE",
    "每个构件需引用 1–2000 个实际源图元",
  );
  const byId = new Map(a.occurrences.map((o) => [o.occurrenceId, o]));
  const rows = unique.map((k) => byId.get(k));
  assert(
    rows.every(
      (o) =>
        o &&
        o.space === "model" &&
        o.geometry &&
        !["annotation", "text", "point"].includes(o.geometry.kind),
    ),
    "INVALID_COMPONENT_SOURCE",
    "构件来源必须是当前模型空间的有效曲线或边界，不能使用标注、文字或辅助点位",
  );
  const typed = rows as Occurrence[];
  const cid = "cmp_" + hash(snapshot.id + canonical(unique)).slice(0, 24);
  if (s.has("component", cid)) {
    const old = s.get<DrawingComponent>("component", cid);
    if (old.status !== "pending" || origin === "rule") return old;
    const updated = {
      ...old,
      category,
      label: label ?? old.label,
      origin,
      evidence: [...old.evidence, ...evidence].slice(-15),
      version: old.version + 1,
    };
    s.put("component", updated);
    return updated;
  }
  const c: DrawingComponent = {
    id: cid,
    workingRevision: revision.id,
    geometrySnapshotId: snapshot.id,
    label:
      label ?? `${category === "未分类" ? "轮廓" : category}-${cid.slice(-5)}`,
    category,
    status: "pending",
    version: 1,
    members: unique,
    layers: [...new Set(typed.map((o) => o.layer))],
    ...componentGeometry(typed),
    bounds: combinedBounds(typed),
    origin,
    evidence,
    floor: "",
    material: "",
    createdAt: now(),
  };
  s.put("component", c);
  return c;
}
export function listComponents(service: WorkflowService, input: any) {
  const { s, snapshot, revision } = context(service, input);
  const all = s.all<DrawingComponent>("component");
  const items = all.filter((c) => c.geometrySnapshotId === snapshot.id);
  const offset = input.offset ?? 0,
    limit = input.limit ?? 5000;
  return {
    workingRevision: revision.id,
    geometrySnapshotId: snapshot.id,
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    staleCount: all.length - items.length,
    counts: {
      pending: items.filter((c) => c.status === "pending").length,
      confirmed: items.filter((c) => c.status === "confirmed").length,
      rejected: items.filter((c) => c.status === "rejected").length,
    },
  };
}
export function recognizeComponents(service: WorkflowService, input: any) {
  const { s, snapshot, revision } = context(service, input);
  const a = s.artifact(snapshot);
  const scope = input.selectionSet
    ? new Set(service.selected(s, snapshot, input.selectionSet).members)
    : null;
  const rows = a.occurrences.filter(
    (o) =>
      o.space === "model" &&
      o.visible &&
      o.geometry &&
      ["path", "region"].includes(o.geometry.kind) &&
      (!scope || scope.has(o.occurrenceId)),
  );
  const assigned = new Set<string>();
  const proposals: {
    members: string[];
    category: ComponentCategory;
    evidence: string[];
  }[] = [];
  // Door/window symbols are grouped by their exact insert-instance path, including
  // array cells. A bare handle never merges instances on different floors/views.
  const symbols = new Map<string, Occurrence[]>();
  for (const o of rows) {
    if (excluded.test(o.layer) || !o.instancePath.length) continue;
    const key = canonical(o.instancePath);
    symbols.set(key, [...(symbols.get(key) ?? []), o]);
  }
  for (const group of symbols.values()) {
    const known = [
      ...new Set(
        group.map((o) => categoryOf(o.layer)).filter((c) => c !== "未分类"),
      ),
    ];
    // A building block containing walls and windows is not a single window.
    if (known.length !== 1 || !["门", "窗"].includes(known[0])) continue;
    if (group.length > 2000) continue;
    group.forEach((o) => assigned.add(o.occurrenceId));
    proposals.push({
      members: group.map((o) => o.occurrenceId),
      category: known[0],
      evidence: [
        `块实例中的 ${group.length} 个源图元`,
        `图层线索：${[...new Set(group.map((o) => o.layer))].join("、")}；类型待人工确认`,
        `符号组只支持构件计数，不直接形成面积`,
      ],
    });
  }
  for (const o of rows) {
    if (assigned.has(o.occurrenceId) || excluded.test(o.layer)) continue;
    const g = o.geometry!;
    const cat = categoryOf(o.layer);
    if (
      g.kind === "region" ||
      (g.kind === "path" &&
        g.closed &&
        ((o.entityType !== "CIRCLE" && o.entityType !== "ELLIPSE") ||
          cat === "柱"))
    ) {
      const b = bounds(g);
      if (!b || b[0] === b[2] || b[1] === b[3]) continue;
      proposals.push({
        members: [o.occurrenceId],
        category: cat,
        evidence: [
          `源${g.kind === "region" ? "区域边界" : "闭合轮廓"}，未替换原几何`,
          `图层线索：${o.layer}；闭合不代表拓扑有效或构件已确认`,
        ],
      });
      assigned.add(o.occurrenceId);
    }
  }
  // Stitch exact line endpoint cycles within the same layer and insert path.
  const groups = new Map<string, Occurrence[]>();
  for (const o of rows)
    if (
      !assigned.has(o.occurrenceId) &&
      !excluded.test(o.layer) &&
      o.geometry?.kind === "path" &&
      !o.geometry.closed &&
      o.geometry.segments.length === 1 &&
      o.geometry.segments[0].kind === "line"
    ) {
      const key = o.layer + canonical(o.instancePath);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
  for (const group of groups.values()) {
    const at = new Map<string, Occurrence[]>();
    for (const o of group) {
      const seg = (o.geometry as Extract<Geometry, { kind: "path" }>)
        .segments[0];
      if (seg.kind !== "line") continue;
      for (const p of [seg.start, seg.end]) {
        const k = p.join(",");
        at.set(k, [...(at.get(k) ?? []), o]);
      }
    }
    const seen = new Set<string>();
    for (const o of group) {
      if (seen.has(o.occurrenceId)) continue;
      const part: Occurrence[] = [];
      const stack = [o];
      while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n.occurrenceId)) continue;
        seen.add(n.occurrenceId);
        part.push(n);
        const seg = (n.geometry as Extract<Geometry, { kind: "path" }>)
          .segments[0];
        if (seg.kind !== "line") continue;
        for (const p of [seg.start, seg.end])
          for (const neighbor of at.get(p.join(",")) ?? [])
            if (!seen.has(neighbor.occurrenceId)) stack.push(neighbor);
      }
      if (part.length < 3 || part.length > 2000) continue;
      if (componentGeometry(part).geometryRole !== "closed_boundary") continue;
      proposals.push({
        members: part.map((o) => o.occurrenceId),
        category: categoryOf(part[0].layer),
        evidence: [
          `${part.length} 条源直线端点精确相连成环；未跨缺口补线`,
          `图层线索：${part[0].layer}；构件类型、楼层及拓扑需确认`,
        ],
      });
      part.forEach((o) => assigned.add(o.occurrenceId));
    }
  }
  assert(
    proposals.length <= 5000,
    "COMPONENT_RESOURCE_LIMIT",
    "候选过多，请先框选局部范围再识别",
  );
  // Preserve the frozen snapshot throughout the complete synchronous proposal pass.
  assert(
    s.current().id === revision.id,
    "REVISION_CONFLICT",
    "识别期间版本变化",
  );
  const candidates = proposals.map((p) =>
    saveCandidate(
      service,
      input,
      p.members,
      "rule",
      p.category,
      p.evidence,
      undefined,
      { s, snapshot, revision, a },
    ),
  );
  s.event("project", {
    type: "components_updated",
    geometrySnapshotId: snapshot.id,
  });
  return {
    ...listComponents(service, input),
    generated: candidates.length,
    unassignedSourceCount: rows.filter((o) => !assigned.has(o.occurrenceId))
      .length,
    scope: scope ? "selected_sources" : "model_space",
    methodVersion: "bwc-components-1",
  };
}
export function suggestComponent(service: WorkflowService, input: any) {
  const c = saveCandidate(
    service,
    input,
    input.members,
    input.origin ?? "ai",
    input.category,
    [input.reason, "该建议尚未人工确认"],
    input.label,
  );
  service.catalog.open(input.projectId).event("project", {
    type: "components_updated",
    geometrySnapshotId: c.geometrySnapshotId,
  });
  return c;
}
export function reviewComponent(service: WorkflowService, input: any) {
  const { s, snapshot } = context(service, input);
  const c = s.get<DrawingComponent>("component", input.componentId);
  assert(
    c.geometrySnapshotId === snapshot.id,
    "SNAPSHOT_MISMATCH",
    "构件候选来自旧图纸，请重新识别",
  );
  assert(
    c.version === input.expectedVersion,
    "COMPONENT_VERSION_CONFLICT",
    "候选已被更新，请刷新后重新核对",
  );
  assert(
    input.status !== "confirmed" || input.category !== "未分类",
    "COMPONENT_CATEGORY_REQUIRED",
    "确认前请选择构件类型",
  );
  if (input.status === "confirmed") {
    const duplicates = s
      .all<DrawingComponent>("component")
      .filter(
        (n) =>
          n.id !== c.id &&
          n.geometrySnapshotId === snapshot.id &&
          n.status === "confirmed" &&
          n.members.some((m) => c.members.includes(m)),
      );
    assert(
      !duplicates.length,
      "COMPONENT_SOURCE_OVERLAP",
      "来源已属于其他确认构件，请先取消其确认，避免重复计量",
    );
  }
  const updated: DrawingComponent = {
    ...c,
    status: input.status,
    category: input.category,
    label: input.label,
    floor: input.floor,
    material: input.material,
    thicknessMm: input.thicknessMm,
    version: c.version + 1,
    reviewedAt: now(),
    evidence: [...c.evidence, `人工核对：${input.evidence}`].slice(-15),
  };
  s.transaction(() => {
    s.put("component_review", {
      id: id("cr"),
      before: c,
      after: updated,
      at: now(),
    });
    s.put("component", updated);
    for (const result of s.all<
      Takeoff & { componentVersions?: Record<string, number> }
    >("takeoff"))
      if (result.componentVersions?.[c.id])
        s.put("takeoff", { ...result, validity: "stale" });
    s.event("project", {
      type: "components_updated",
      geometrySnapshotId: snapshot.id,
    });
  });
  return updated;
}
export function componentTakeoff(service: WorkflowService, input: any) {
  const { s, snapshot, revision } = context(service, input);
  const components = [...new Set<string>(input.componentIds)].map((k) =>
    s.get<DrawingComponent>("component", k),
  );
  assert(components.length > 0, "INVALID_COMPONENT_SCOPE", "请选择已确认构件");
  assert(
    components.every(
      (c) => c.geometrySnapshotId === snapshot.id && c.status === "confirmed",
    ),
    "COMPONENT_NOT_CONFIRMED",
    "只有当前快照的已确认构件可进入构件算量",
  );
  const members = new Set<string>();
  for (const c of components)
    for (const m of c.members) {
      assert(
        !members.has(m),
        "COMPONENT_SOURCE_OVERLAP",
        "构件来源重叠，不能重复计量",
      );
      members.add(m);
    }
  const versions = Object.fromEntries(components.map((c) => [c.id, c.version]));
  return service.job(
    s,
    "component_takeoff",
    input.operationId,
    { revision: revision.id, versions, kind: input.quantityKind },
    async (signal) => {
      const occurrences = components.map((c) => ({
        occurrenceId: c.id,
        geometry: c.geometry,
      }));
      const business = Object.fromEntries(
        components.map((c) => [
          c.id,
          {
            classification: c.category,
            evidence: c.evidence.join("；"),
            ...(c.thicknessMm
              ? {
                  uniform_thickness: {
                    value: c.thicknessMm,
                    unit: "mm",
                    unitBinding: "physical_quantity",
                    normalizedMetres: c.thicknessMm * 0.001,
                    evidence: "用户确认的构件厚度",
                  },
                }
              : {}),
          },
        ]),
      );
      const measured = await worker<any>(
        "geometry",
        {
          occurrences,
          business,
          scale: snapshot.units.confirmed
            ? snapshot.units.metresPerDrawingUnit
            : null,
          quantityKind: input.quantityKind,
        },
        signal,
      );
      const drawing = s.get<any>("drawing", snapshot.drawingVersion);
      const selection = await service.selection({
        ...input,
        members: [...members],
      });
      const stale =
        s.current().id !== revision.id ||
        components.some(
          (c) =>
            s.get<DrawingComponent>("component", c.id).version !== c.version,
        );
      const result = {
        id: id("tr"),
        workingRevision: revision.id,
        geometrySnapshotId: snapshot.id,
        selectionSet: { id: selection.id, version: 1 },
        quantityKind: input.quantityKind,
        unit: (
          {
            length: "m",
            net_area: "m2",
            parameter_volume: "m3",
            business_count: "component",
          } as any
        )[input.quantityKind],
        knownSubtotal: measured.knownSubtotal,
        completeTotal: measured.complete ? measured.knownSubtotal : null,
        completeness: measured.complete ? "complete" : "partial",
        importCompleteness: snapshot.importCompleteness,
        conversionVerification:
          drawing.role === "compatible_copy"
            ? "requires_verification"
            : "not_applicable",
        conversionRecordId: drawing.conversionRecordId ?? null,
        items: measured.items.map((v: any) => ({
          ...v,
          componentLabel: components.find((c) => c.id === v.id)!.label,
          sourceOccurrenceIds: components.find((c) => c.id === v.id)!.members,
        })),
        validity: stale ? "stale" : "valid",
        methodVersion: measured.methodVersion,
        unitProfileVersion: snapshot.units.id,
        exclusions: [],
        scope: "confirmed_components_only",
        componentVersions: versions,
        projectCompleteTotal: null,
      };
      s.put("takeoff", result);
      return result;
    },
    { snapshot, revision },
  );
}
export function componentTools(service: WorkflowService) {
  const base = ContextSchema.shape;
  return {
    component_list: {
      description:
        "读取当前二维构件候选、来源、判断理由和人工确认状态。AI 建议不是已确认构件。",
      schema: ContextSchema.extend({
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      }).strict(),
      run: (i: any) => listComponents(service, i),
    },
    component_recognize: {
      description:
        "按闭合边界、块实例和图层线索生成待人工核对的二维构件候选，不确认、不发布原图修订。可绑定冻结选择集。",
      schema: z
        .object({
          ...base,
          selectionSet: z
            .object({ id: z.string(), version: z.literal(1) })
            .optional(),
        })
        .strict(),
      run: (i: any) => recognizeComponents(service, i),
    },
    component_suggest: {
      description:
        "AI 辅助提交一个待人工确认的二维构件建议。必须引用实际源实例 ID，提供类型、名称和理由；几何由服务端从源数据确定，禁止臆造边界。无法闭合的符号组只支持确认后计数。",
      schema: z
        .object({
          ...base,
          members: z.array(z.string()).min(1).max(2000),
          category: categorySchema,
          label: z.string().trim().min(1).max(100),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      run: (i: any) => suggestComponent(service, { ...i, origin: "ai" }),
    },
    component_takeoff: {
      description:
        "仅计算当前快照人工确认的二维构件；未确认候选拒绝计量。符号组不具有面积，高度/厚度不能从 AI 推测。",
      schema: z
        .object({
          ...base,
          componentIds: z.array(z.string()).min(1).max(1000),
          quantityKind: z.enum([
            "length",
            "net_area",
            "parameter_volume",
            "business_count",
          ]),
          operationId: z.string().min(1).max(200),
        })
        .strict(),
      run: (i: any) => componentTakeoff(service, i),
    },
  };
}
