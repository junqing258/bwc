import type { Artifact, Issue } from "./types.ts";
import { hash } from "./util.ts";

/** These are coverage counts, not quantities or confirmed building components. */
export function importReport(artifact: Artifact) {
  const byHandle = new Map(artifact.sources.map((s) => [s.handle, s]));
  const occurrencesByHandle = new Map<
    string,
    { model: number; other: number }
  >();
  let modelTotal = 0,
    modelWithGeometry = 0,
    modelWithDiagnosticPreview = 0;
  for (const o of artifact.occurrences) {
    const count = occurrencesByHandle.get(o.sourceHandle) ?? {
      model: 0,
      other: 0,
    };
    if (o.space === "model") {
      count.model++;
      modelTotal++;
      if (o.geometry) modelWithGeometry++;
      else if (o.diagnosticPreview) modelWithDiagnosticPreview++;
    } else count.other++;
    occurrencesByHandle.set(o.sourceHandle, count);
  }
  const diagnostics = new Map<
    string,
    {
      code: string;
      entityType: string;
      reason: string;
      recordCount: number;
      handles: Set<string>;
      examples: string[];
    }
  >();
  for (const d of artifact.diagnostics) {
    const type =
      d.entityType ??
      (d.handle ? byHandle.get(d.handle)?.type : undefined) ??
      "UNKNOWN";
    const reason = d.reason ?? "";
    const key = JSON.stringify([d.code, type, reason]);
    const group = diagnostics.get(key) ?? {
      code: d.code,
      entityType: type,
      reason,
      recordCount: 0,
      handles: new Set<string>(),
      examples: [],
    };
    group.recordCount++;
    if (d.handle) {
      group.handles.add(d.handle);
      if (group.examples.length < 3 && !group.examples.includes(d.handle))
        group.examples.push(d.handle);
    }
    diagnostics.set(key, group);
  }
  const diagnosticGroups = [...diagnostics.values()]
    .map((g) => {
      let modelOccurrences = 0,
        otherSpaceOccurrences = 0,
        uninstantiatedSources = 0;
      for (const handle of g.handles) {
        const c = occurrencesByHandle.get(handle);
        modelOccurrences += c?.model ?? 0;
        otherSpaceOccurrences += c?.other ?? 0;
        if (!c) uninstantiatedSources++;
      }
      return {
        id: diagnosticId(g.code, g.entityType, g.reason),
        code: g.code,
        entityType: g.entityType,
        reason: g.reason,
        recordCount: g.recordCount,
        sourceEntityCount: g.handles.size,
        modelOccurrences,
        otherSpaceOccurrences,
        uninstantiatedSources,
        examples: g.examples,
      };
    })
    .sort(
      (a, b) =>
        b.modelOccurrences - a.modelOccurrences ||
        b.recordCount - a.recordCount ||
        a.entityType.localeCompare(b.entityType),
    );
  const notices = new Map<
    string,
    { category: string; name: string; count: number; example: string }
  >();
  for (const message of artifact.notifications) {
    const unknown = message.match(
      /DXF name\s+(\S+).*UnknownNonGraphicalObject/,
    );
    const category = unknown
      ? "unknown_non_graphical"
      : /not found|missing|unresolved/i.test(message)
        ? "missing_reference"
        : "unclassified";
    const name = unknown?.[1] ?? message;
    const key = category + "|" + name;
    const g = notices.get(key) ?? {
      category,
      name,
      count: 0,
      example: message,
    };
    g.count++;
    notices.set(key, g);
  }
  const noticeGroups = [...notices.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  return {
    modelTotal,
    modelWithGeometry,
    modelWithoutGeometry: modelTotal - modelWithGeometry,
    modelWithDiagnosticPreview,
    diagnosticCount: artifact.diagnostics.length,
    diagnosticGroups,
    notificationCount: artifact.notifications.length,
    notificationGroupCount: noticeGroups.length,
    notificationGroups: noticeGroups.slice(0, 50),
    notificationGroupsTruncated: noticeGroups.length > 50,
    diagnosticCounting:
      "records_including_block_definitions_and_repeated_occurrences",
    notificationImpact: "requires_verification",
    importCompleteness: artifact.importCompleteness,
  };
}

export const diagnosticId = (code: string, type: string, reason = "") =>
  "dg_" + hash(JSON.stringify([code, type, reason])).slice(0, 24);
export function diagnosticHandles(a: Artifact, groupId: string) {
  const types = new Map(a.sources.map((s) => [s.handle, s.type]));
  return new Set(
    a.diagnostics
      .filter(
        (d) =>
          diagnosticId(
            d.code,
            d.entityType ?? types.get(d.handle ?? "") ?? "UNKNOWN",
            d.reason ?? "",
          ) === groupId,
      )
      .flatMap((d) => (d.handle ? [d.handle] : [])),
  );
}
export function diagnosticAdvice(type: string, code: string) {
  if (code === "GEOMETRY_INVALID")
    return {
      category: "geometry_extraction",
      action: "inspect_source_in_independent_cad",
      explanation:
        "核对读取后的原始数据及原 CAD。辅助点位只用于定位；无法确定的曲线保持不可计量。",
    };
  if (type === "WIPEOUT")
    return {
      category: "display_semantics",
      action: "verify_mask_and_draw_order",
      explanation:
        "可辅助定位图像范围；遮罩边界、遮挡和绘制顺序需核验，不把范围当作构件面积。",
    };
  if (type === "OLE2FRAME")
    return {
      category: "embedded_content",
      action: "inspect_or_convert_embedded_content",
      explanation:
        "可辅助定位 OLE 框角；嵌入内容仍需在原应用检查或导出为可核验资料。",
    };
  return {
    category: "unsupported_source",
    action: "adapter_or_compatible_copy_required",
    explanation:
      "先判断是否影响当前选择范围；源记录未实例化也不代表文档保持已验证。",
  };
}

/** Coalesce repeated evidence without treating not-run checks as geometry failures. */
export function groupIssues(items: any[], runId = "legacy"): Issue[] {
  const groups = new Map<string, any>();
  for (const original of items) {
    const item = { ...original };
    if (item.check !== "units" && item.reason === "UNITS_UNCONFIRMED")
      item.status = "not_run";
    const key = JSON.stringify([
      item.geometrySnapshotId,
      item.check,
      item.status,
      item.reason,
      item.checkerVersion,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        ...item,
        id: "issue_" + hash(runId + key).slice(0, 24),
        occurrenceIds: new Set<string>(),
        evidence: { recordCount: 0, samples: [] },
        memberCount: 0,
      };
      groups.set(key, group);
    }
    for (const oid of item.occurrenceIds ?? []) group.occurrenceIds.add(oid);
    group.evidence.recordCount += item.evidence?.recordCount ?? 1;
    if (group.evidence.samples.length < 3) {
      const e = item.evidence;
      group.evidence.samples.push({
        reason: item.reason,
        occurrenceId: item.occurrenceIds?.[0] ?? null,
        ...(e?.methodVersion ? { methodVersion: e.methodVersion } : {}),
        ...(e?.value !== undefined ? { value: e.value } : {}),
      });
    }
    if (item.evidence?.importReport)
      group.evidence.importReport = item.evidence.importReport;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    occurrenceIds: [...g.occurrenceIds],
    memberCount: g.occurrenceIds.size,
  }));
}
