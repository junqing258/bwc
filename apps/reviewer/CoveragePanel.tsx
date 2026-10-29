import { useState } from "react";
import type { CoverageService } from "../server/coverage";

type CoverageState = ReturnType<CoverageService["state"]>;
const blockerLabels: Record<string, string> = {
  FLOOR_UNKNOWN: "楼层归属未核实",
  VIEW_PURPOSE_UNKNOWN: "视图用途未核实",
  UNASSIGNED_SOURCES: "存在未归属来源",
  DUPLICATE_SOURCE_OWNERSHIP: "来源归属于多个构件",
  SOURCE_GEOMETRY_MISSING: "存在未解析几何",
  PENDING_COMPONENTS: "目标构件尚待核对",
  COMPONENT_FLOOR_UNCONFIRMED: "构件楼层未确认或不符",
  COMPONENT_CROSSES_SCOPE: "构件跨出冻结来源范围",
  EXCLUSION_OWNERSHIP_CONFLICT: "排除来源与确认构件冲突",
  PARSER_GAPS: "解析缺口待解决",
  DEPENDENCIES_UNVERIFIED: "外部依赖未核验",
  PARSER_NOTICES_UNVERIFIED: "解析通知未核验",
  PARSER_COVERAGE_PARTIAL: "解析覆盖不完整",
  DUPLICATE_COMPONENT_GEOMETRY: "相同楼层与类别存在相同边界，需核对重复",
};
const sourceStatusLabels: Record<string, string> = {
  assigned: "已归属",
  unassigned: "未归属",
  excluded: "已排除",
  duplicate: "重复归属",
};
const statusLabels: Record<string, string> = {
  unknown: "未审阅",
  incomplete: "未完成",
  reviewed_complete: "人工覆盖审阅完成",
};
export default function CoveragePanel({
  coverage,
  drawingId,
  busy,
  onAction,
  onFocus,
}: {
  coverage: CoverageState;
  drawingId: string;
  busy: boolean;
  onAction: (action: string, input: unknown) => void;
  onFocus: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState("unassigned"),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string[]>([]),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [reference, setReference] = useState(""),
    [referenceKind, setReferenceKind] = useState("source_drawing"),
    [checked, setChecked] = useState(false);
  const drawing = coverage.drawings.find((d) => d.drawingId === drawingId)!;
  const rows = drawing.rows.filter((r) => !filter || r.status === filter),
    page = rows.slice(offset, offset + 25),
    record = coverage.record;
  const frozen = {
    expectedVersion: record.version,
    fingerprint: record.fingerprint,
  };
  return (
    <section className="coverage-panel">
      <h2>独立范围覆盖审阅</h2>
      <p>
        <strong>{statusLabels[coverage.status]}</strong> ·{" "}
        {record.scope.discipline} · {record.scope.categories.join("、")}
      </p>
      <p className="muted">
        候选确认与范围覆盖是两个审阅步骤。请对照原图或独立参考清单检查漏项；来源都有归属也不能代替这一步。
      </p>
      <details>
        <summary>冻结范围与版本</summary>
        <p>清单：{record.manifestId}</p>
        {coverage.drawings.map((d) => (
          <p key={d.drawingId}>
            {d.drawingId} · {d.floor ?? "楼层未知"} ·{" "}
            {d.viewPurpose ?? "视图未知"} ·{" "}
            {d.sourceScope === "explicit_source_subset"
              ? "指定来源子集"
              : "整个模型视图"}{" "}
            · {d.sourceMembers.length} 个来源
            <br />
            {d.revisionId}
          </p>
        ))}
        <p>
          覆盖版本 {record.version} · {record.fingerprint}
        </p>
      </details>
      <label>
        参与图纸
        <select
          value={drawingId}
          disabled={busy}
          onChange={(e) => onAction("drawing", { drawingId: e.target.value })}
        >
          {coverage.drawings.map((d) => (
            <option key={d.drawingId} value={d.drawingId}>
              {d.floor ?? "楼层未知"} · {d.viewPurpose ?? "视图未知"} ·{" "}
              {d.drawingId.slice(-8)}
            </option>
          ))}
        </select>
      </label>
      {coverage.stale && (
        <div className="coverage-warning">
          图纸或候选已变化，本覆盖结论已失效。
          <button disabled={busy} onClick={() => onAction("refresh", {})}>
            重新冻结候选并核对覆盖
          </button>
          <p>若图纸修订已变化，请在 Codex 中重新冻结输入清单。</p>
        </div>
      )}
      <ul>
        {drawing.blockers.map((blocker) => (
          <li key={blocker}>{blockerLabels[blocker] ?? blocker}</li>
        ))}
      </ul>
      <p>
        来源 {drawing.rows.length} · 未归属{" "}
        {drawing.rows.filter((r) => r.status === "unassigned").length} · 已排除{" "}
        {drawing.rows.filter((r) => r.status === "excluded").length}
      </p>
      <label>
        来源筛选
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setOffset(0);
            setSelected([]);
          }}
        >
          <option value="unassigned">未归属</option>
          <option value="assigned">已归属</option>
          <option value="excluded">已排除</option>
          <option value="duplicate">重复归属</option>
          <option value="">全部来源</option>
        </select>
      </label>
      <div className="coverage-sources">
        {page.map((row) => (
          <div key={row.occurrenceId} className="coverage-source">
            <input
              type="checkbox"
              aria-label={`排除来源 ${row.sourceHandle} ${row.occurrenceId.slice(-8)}`}
              disabled={row.status !== "unassigned" || coverage.stale || busy}
              checked={selected.includes(row.occurrenceId)}
              onChange={() =>
                setSelected((old) =>
                  old.includes(row.occurrenceId)
                    ? old.filter((id) => id !== row.occurrenceId)
                    : [...old, row.occurrenceId],
                )
              }
            />
            <button onClick={() => onFocus([row.occurrenceId])}>
              {row.entityType} · {row.layer} · {row.sourceHandle}
            </button>
            <small>
              {sourceStatusLabels[row.status]} · {row.occurrenceId.slice(-12)}
              {!row.hasGeometry ? " · 几何缺失" : ""}
            </small>
          </div>
        ))}
      </div>
      <div>
        <button
          disabled={!offset}
          onClick={() => setOffset((n) => Math.max(0, n - 25))}
        >
          上一页
        </button>
        <span>
          {rows.length ? offset + 1 : 0}–{Math.min(offset + 25, rows.length)} /{" "}
          {rows.length}
        </span>
        <button
          disabled={offset + 25 >= rows.length}
          onClick={() => setOffset((n) => n + 25)}
        >
          下一页
        </button>
      </div>
      {selected.length > 0 && (
        <div>
          <p>
            待排除 {selected.length}{" "}
            个来源；成员会逐项保存，解析缺口不会随排除消失。
          </p>
          <label>
            排除理由
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            排除依据
            <textarea
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy || coverage.stale || !reason.trim() || !evidence.trim()
            }
            onClick={() =>
              onAction("exclude", {
                ...frozen,
                drawingId,
                occurrenceIds: selected,
                reason,
                evidence,
              })
            }
          >
            保存所勾选来源的排除依据
          </button>
        </div>
      )}
      <details>
        <summary>已排除的来源与依据</summary>
        {record.exclusions.map((exclusion) => (
          <details key={exclusion.id}>
            <summary>
              {exclusion.reason} · {exclusion.occurrenceIds.length} 个来源
            </summary>
            <p>{exclusion.evidence}</p>
            <p>{exclusion.at}</p>
            <button
              disabled={busy || coverage.stale}
              onClick={() =>
                onAction("restore", { ...frozen, exclusionId: exclusion.id })
              }
            >
              撤回本组排除并重新核对
            </button>
            <pre>{exclusion.occurrenceIds.join("\n")}</pre>
          </details>
        ))}
      </details>
      <details open={drawing.gaps.length > 0}>
        <summary>解析缺口 · {drawing.gaps.length}</summary>
        {drawing.gaps.map((gap) => (
          <div key={gap.id}>
            <p>
              {gap.code} · {gap.reason}
            </p>
            {gap.unlocated && (
              <strong>包含无法定位的来源，不能静默排除。</strong>
            )}
            {gap.occurrenceIds.length > 0 && (
              <button onClick={() => onFocus(gap.occurrenceIds)}>
                定位受影响来源
              </button>
            )}
          </div>
        ))}
      </details>
      {coverage.semanticDuplicates.length > 0 && (
        <details open>
          <summary>疑似重复构件</summary>
          <pre>{JSON.stringify(coverage.semanticDuplicates, null, 2)}</pre>
          <p>
            请核对相同边界是否代表同一构件；需更正候选后重新冻结覆盖，系统不会静默合并。
          </p>
        </details>
      )}
      <details open>
        <summary>独立人工覆盖结论</summary>
        <label>
          核对资料
          <select
            value={referenceKind}
            onChange={(e) => setReferenceKind(e.target.value)}
          >
            <option value="source_drawing">原图</option>
            <option value="reference_inventory">独立参考清单</option>
          </select>
        </label>
        <label>
          原图定位或参考清单版本
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label>
          审阅证据与未决事项
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          我已独立对照上述资料检查此冻结范围，包括未纳入候选的构件。
        </label>
        <button
          disabled={
            busy || coverage.stale || !reference.trim() || !evidence.trim()
          }
          onClick={() =>
            onAction("review", {
              ...frozen,
              conclusion: "incomplete",
              evidence,
              reference: { kind: referenceKind, locator: reference },
            })
          }
        >
          记录范围未完成
        </button>
        <button
          disabled={
            busy ||
            !coverage.canReviewComplete ||
            !checked ||
            !reference.trim() ||
            !evidence.trim()
          }
          onClick={() =>
            onAction("review", {
              ...frozen,
              conclusion: "reviewed_complete",
              evidence,
              reference: { kind: referenceKind, locator: reference },
            })
          }
        >
          确认冻结范围覆盖完成
        </button>
        {coverage.review && (
          <p>
            上次结论：{statusLabels[coverage.review.conclusion]} ·{" "}
            {coverage.review.at}
            <br />
            {coverage.review.evidence}
          </p>
        )}
      </details>
    </section>
  );
}
