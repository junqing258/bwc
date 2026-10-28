import { useEffect, useMemo, useState } from "react";
import type {
  DrawingComponent,
  ComponentCategory,
} from "../../server/components";
import { componentCategories } from "../../shared/component-categories";
import { api, call, operationId, waitJob } from "./api";

interface Props {
  context: {
    projectId: string;
    workingRevision: string;
    geometrySnapshotId: string;
  };
  components: DrawingComponent[];
  selected: string[];
  activeId: string | null;
  busy: boolean;
  aiPending: boolean;
  onSelect: (component: DrawingComponent, append?: boolean) => void;
  onAction: (action: () => Promise<void>) => void;
  onRefresh: () => Promise<unknown>;
  onAI: (prompt: string) => Promise<void>;
  onResults: () => void;
}
export default function ComponentPanel(p: Props) {
  const [status, setStatus] = useState("pending"),
    [filter, setFilter] = useState(""),
    [page, setPage] = useState(0);
  const [category, setCategory] = useState<ComponentCategory>("未分类"),
    [label, setLabel] = useState(""),
    [floor, setFloor] = useState(""),
    [material, setMaterial] = useState(""),
    [thickness, setThickness] = useState(""),
    [reason, setReason] = useState("");
  const active = p.components.find((c) => c.id === p.activeId);
  useEffect(() => {
    if (active) {
      setCategory(active.category);
      setLabel(active.label);
      setFloor(active.floor);
      setMaterial(active.material);
      setThickness(active.thicknessMm ? String(active.thicknessMm) : "");
      setReason("");
    }
  }, [active?.id, active?.version]);
  useEffect(() => setPage(0), [status, filter, p.context.geometrySnapshotId]);
  const filtered = useMemo(
    () =>
      p.components.filter(
        (c) =>
          (!status || c.status === status) &&
          (!filter ||
            `${c.label} ${c.category} ${c.floor} ${c.layers.join(" ")}`
              .toLowerCase()
              .includes(filter.toLowerCase())),
      ),
    [p.components, status, filter],
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 20) - 1),
  );
  const selectedComponents = p.components.filter(
    (c) =>
      c.status === "confirmed" &&
      c.members.every((m) => p.selected.includes(m)),
  );
  const run = (fn: () => Promise<void>) => p.onAction(fn);
  async function recognize(local: boolean) {
    const result = await call("component_recognize", {
      ...p.context,
      ...(local ? { selectionSet: await selectionRef() } : {}),
    });
    await p.onRefresh();
    if (!result.generated)
      setReason(
        "该范围未发现规则可识别的闭合边界或门窗块。可框选一组源图元，使用手工标识或 AI 辅助。",
      );
    setStatus("pending");
  }
  async function selectionRef() {
    const sel = await call("selection_create", {
      ...p.context,
      members: p.selected,
      evidence: "component_recognition_user_scope",
    });
    return { id: sel.id, version: 1 };
  }
  async function review(next: "confirmed" | "rejected" | "pending") {
    if (!active) return;
    await api("components/review", {
      ...p.context,
      componentId: active.id,
      expectedVersion: active.version,
      status: next,
      category,
      label,
      floor,
      material,
      ...(thickness.trim() ? { thicknessMm: Number(thickness) } : {}),
      evidence: reason.trim() || "用户在构件核对面板检查图中来源并提交",
    });
    await p.onRefresh();
  }
  async function calculate(quantityKind: string) {
    await waitJob(
      p.context.projectId,
      await call("component_takeoff", {
        ...p.context,
        componentIds: selectedComponents.map((c) => c.id),
        quantityKind,
        operationId: operationId(),
      }),
    );
    await p.onRefresh();
    p.onResults();
  }
  return (
    <div className="component-panel">
      <div className="component-toolbar">
        <div>
          <strong>二维构件识别</strong>
          <p>
            候选需人工核对。图层和 AI
            建议不直接认定构件；尺寸标注、轴线与文字不参与识别。
          </p>
        </div>
        <button
          className="outline"
          disabled={p.busy}
          onClick={() => run(() => recognize(false))}
        >
          识别全图
        </button>
        <button
          className="outline"
          disabled={p.busy || !p.selected.length}
          onClick={() => run(() => recognize(true))}
        >
          识别选中范围
        </button>
        <button
          className="outline"
          disabled={p.busy || !p.selected.length}
          onClick={() =>
            run(async () => {
              const c = await api("components/manual", {
                ...p.context,
                members: p.selected,
              });
              await p.onRefresh();
              p.onSelect(c);
              setStatus("pending");
            })
          }
        >
          标识选中图元
        </button>
        <button
          className="outline"
          disabled={p.busy || p.aiPending}
          onClick={() =>
            run(() =>
              p.onAI(
                "请辅助进行二维构件识别。先读取 component_list；在本轮冻结选择范围（未选择则为整图）使用 component_recognize 生成候选，查询真实源图元和图层、块实例、文字线索。必要时使用 component_suggest 引用真实 occurrenceId 提交候选分类与理由，不能伪造边界、高度、厚度或置信度。不能把整层所有墙线当成一面墙。所有建议保留待人工确认；请汇报未覆盖部分。",
              ),
            )
          }
        >
          AI 辅助识别
        </button>
      </div>
      <div className="component-stats" aria-live="polite">
        <span className="pending">
          待确认 {p.components.filter((c) => c.status === "pending").length}
        </span>
        <span className="confirmed">
          已确认 {p.components.filter((c) => c.status === "confirmed").length}
        </span>
        <span>
          已排除 {p.components.filter((c) => c.status === "rejected").length}
        </span>
        <span>已选确认构件 {selectedComponents.length} 个</span>
      </div>
      <div className="component-workspace">
        <div className="component-browser">
          <div className="component-filters">
            <select
              aria-label="构件确认状态"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="pending">待确认</option>
              <option value="confirmed">已确认</option>
              <option value="rejected">已排除</option>
              <option value="">全部状态</option>
            </select>
            <input
              aria-label="搜索二维构件"
              placeholder="名称、类型、楼层、图层"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="component-list">
            {!filtered.length && (
              <p className="component-empty">
                {p.components.length
                  ? "当前筛选下暂无构件。"
                  : "点击“识别全图”生成候选，或框选源图元后标识。图中编号与来源图元联动。"}
              </p>
            )}
            {filtered
              .slice(currentPage * 20, (currentPage + 1) * 20)
              .map((c) => (
                <button
                  key={c.id}
                  className={`component-card ${c.id === active?.id ? "active" : ""}`}
                  onClick={(e) => p.onSelect(c, e.shiftKey)}
                  aria-label={`定位构件 ${c.label}`}
                >
                  <span className={`component-dot ${c.status}`} />
                  <div>
                    <b>{c.label}</b>
                    <small>
                      {c.category} · {c.floor || "楼层待确认"} ·{" "}
                      {c.members.length} 个源图元
                    </small>
                    <small>
                      {c.origin === "ai"
                        ? "AI 建议"
                        : c.origin === "manual"
                          ? "手工标识"
                          : "规则候选"}{" "}
                      ·{" "}
                      {c.geometryRole === "closed_boundary"
                        ? "闭合边界 · 拓扑待检查"
                        : c.geometryRole === "curve"
                          ? "开放曲线 · 无面积"
                          : "符号组合 · 仅支持计数"}
                    </small>
                  </div>
                  <span>
                    {c.status === "confirmed"
                      ? "已确认"
                      : c.status === "rejected"
                        ? "已排除"
                        : "待确认"}
                  </span>
                </button>
              ))}
          </div>
          {!!filtered.length && (
            <div className="component-pagination">
              <button
                disabled={!currentPage}
                onClick={() => setPage(currentPage - 1)}
              >
                上一页
              </button>
              <span>
                {currentPage + 1} / {Math.ceil(filtered.length / 20)} 页 ·{" "}
                {filtered.length} 项
              </span>
              <button
                disabled={(currentPage + 1) * 20 >= filtered.length}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
        <div className="component-review">
          {active ? (
            <>
              <h3>核对图中标识 · {active.label}</h3>
              <p className="muted">
                来源：{active.layers.join("、")} · {active.members.length}{" "}
                个图元。修改和确认均保留记录。
              </p>
              <div className="component-fields">
                <label>
                  构件名称
                  <input
                    aria-label="构件名称"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <label>
                  构件类型
                  <select
                    aria-label="构件类型"
                    value={category}
                    onChange={(e) =>
                      setCategory(e.target.value as ComponentCategory)
                    }
                  >
                    {componentCategories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  楼层
                  <input
                    aria-label="构件楼层"
                    placeholder="例如：二层（需核对）"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                  />
                </label>
                <label>
                  材料
                  <input
                    aria-label="构件材料"
                    placeholder="选填"
                    value={material}
                    onChange={(e) => setMaterial(e.target.value)}
                  />
                </label>
                <label>
                  厚度 / 拉伸高度（mm，须有依据）
                  <input
                    aria-label="构件均匀厚度"
                    type="number"
                    min="0.001"
                    placeholder="未提供则不计算参数体积"
                    value={thickness}
                    onChange={(e) => setThickness(e.target.value)}
                  />
                </label>
              </div>
              <details open className="component-evidence">
                <summary>识别依据与局限</summary>
                <ul>
                  {active.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
              <label>
                核对说明
                <input
                  aria-label="构件核对说明"
                  placeholder="可补充类型、楼层及边界依据"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="component-actions">
                <button
                  className="primary"
                  disabled={p.busy || category === "未分类" || !label.trim()}
                  onClick={() => run(() => review("confirmed"))}
                >
                  {active.status === "confirmed" ? "保存核对修改" : "确认构件"}
                </button>
                <button
                  className="outline"
                  disabled={p.busy}
                  onClick={() => run(() => review("rejected"))}
                >
                  排除此候选
                </button>
                {active.status !== "pending" && (
                  <button
                    className="outline"
                    disabled={p.busy}
                    onClick={() => run(() => review("pending"))}
                  >
                    退回待确认
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="component-empty">
              点击图中编号或左侧构件，整组来源会高亮。核对类型与位置后确认；不确定的候选可保留待确认或排除。
            </div>
          )}
          <div className="component-quantities">
            <b>计算已选的确认构件</b>
            <p>
              仅汇总所选构件；闭合边界仍需通过几何校验。符号组只计数，墙高等参数不自动推测。
            </p>
            {[
              ["business_count", "构件计数"],
              ["length", "曲线长度"],
              ["net_area", "净面积"],
              ["parameter_volume", "参数体积"],
            ].map(([kind, text]) => (
              <button
                key={kind}
                className="outline"
                disabled={p.busy || !selectedComponents.length}
                onClick={() => run(() => calculate(kind))}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
