import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Viewer from "../web/src/Viewer";
import CoveragePanel from "./CoveragePanel";
import UnitAdoptionPanel from "./UnitAdoptionPanel";
import type { DrawingComponent } from "../server/components";
import { componentCategories } from "../shared/component-categories";
import "./style.css";
const token =
  location.hash.slice(1) || sessionStorage.getItem("bwc-review-token") || "";
if (token) sessionStorage.setItem("bwc-review-token", token);
history.replaceState(null, "", location.pathname);
async function request(path: string, value?: unknown) {
  const response = await fetch(`/review-api/${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Bwc-Review": token },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const result = await response.json();
  if (!response.ok || result.error)
    throw new Error(result.error?.code ?? "审阅请求失败");
  return result;
}
function App() {
  const [state, setState] = useState<any>(),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [batchIds, setBatchIds] = useState<string[]>([]),
    [editing, setEditing] = useState<DrawingComponent>(),
    [fit, setFit] = useState(0),
    [focus, setFocus] = useState(0),
    [hidden, setHidden] = useState(new Set<string>()),
    [evidence, setEvidence] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    try {
      setState(await request("state"));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, []);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      return await refresh();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!state)
    return (
      <main>
        <h1>图纸审阅</h1>
        <p>{error || "正在读取冻结图纸…"}</p>
      </main>
    );
  const choose = (c: DrawingComponent) => {
    setEditing({ ...c });
    setSelected(c.members);
    setFocus((n) => n + 1);
  };
  const layers = [
    ...new Set<string>(state.preview.occurrences.map((o: any) => o.layer)),
  ];
  return (
    <>
      <header>
        <strong>筑材智算 · 图纸审阅</strong>
        <span>{state.drawing.name}</span>
        <small>{state.batch.workingRevision}</small>
      </header>
      {error && (
        <div role="alert" className="notice">
          {error}
        </div>
      )}
      {state.stale && (
        <div className="notice">
          此批次已经失效，提交已禁用。
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await request("refresh", {});
                setEditing(undefined);
                setBatchIds([]);
                setSelected([]);
              })
            }
          >
            重新载入当前版本
          </button>
        </div>
      )}
      <section className="layout">
        <div className="drawing">
          <div className="toolbar">
            <button onClick={() => setFit((n) => n + 1)}>全图</button>
            <button onClick={() => setFocus((n) => n + 1)}>定位选择</button>
            <span>已选 {selected.length} 个源实例</span>
          </div>
          <Viewer
            occurrences={state.preview.occurrences}
            selected={selected}
            onSelect={(ids, append) =>
              setSelected((old) =>
                append ? [...new Set([...old, ...ids])] : ids,
              )
            }
            hidden={hidden}
            isolated={false}
            tool="select"
            fitToken={fit}
            focusToken={focus}
            scale={state.preview.units.metresPerDrawingUnit}
            components={state.components}
            onComponentSelect={choose}
          />
        </div>
        <aside>
          <h2>候选与核对</h2>
          {state.coverage ? (
            <CoveragePanel
              key={`${state.coverage.record.id}:${state.coverage.record.version}:${state.batch.drawingId}`}
              coverage={state.coverage}
              drawingId={state.batch.drawingId}
              busy={busy}
              onFocus={(ids) => {
                setSelected(ids);
                setFocus((n) => n + 1);
              }}
              onAction={(action, input) =>
                void run(async () => {
                  await request(`coverage/${action}`, input);
                  setEditing(undefined);
                  setBatchIds([]);
                  setSelected([]);
                })
              }
            />
          ) : (
            <p>
              范围覆盖：未知。候选全部确认也只代表这些候选已核对，不能声明整图或整层完成。
            </p>
          )}
          <div className="candidates">
            {state.components.map((c: DrawingComponent) => (
              <div key={c.id} className="candidate-row">
                <input
                  type="checkbox"
                  aria-label={`勾选 ${c.label}`}
                  checked={batchIds.includes(c.id)}
                  onChange={() =>
                    setBatchIds((old) =>
                      old.includes(c.id)
                        ? old.filter((id) => id !== c.id)
                        : [...old, c.id],
                    )
                  }
                />
                <button
                  className={editing?.id === c.id ? "active" : ""}
                  onClick={() => choose(c)}
                >
                  {c.label} · {c.category} · {c.status}
                </button>
              </div>
            ))}
          </div>
          {batchIds.length > 0 && (
            <details open>
              <summary>批量核对 · {batchIds.length} 个候选</summary>
              <p>按下列现有参数确认；修改单个候选请使用下方表单。</p>
              {state.components
                .filter((c: DrawingComponent) => batchIds.includes(c.id))
                .map((c: DrawingComponent) => (
                  <p key={c.id}>
                    {c.label} · {c.category} · 楼层 {c.floor || "未填写"} · 材料{" "}
                    {c.material || "未填写"} · 厚度 {c.thicknessMm ?? "未填写"}{" "}
                    mm
                  </p>
                ))}
              <label>
                批量核对依据
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </label>
              <button
                disabled={busy || state.stale || !evidence.trim()}
                onClick={() =>
                  void run(() =>
                    request("submit", {
                      fingerprint: state.batch.fingerprint,
                      reviews: state.components
                        .filter((c: DrawingComponent) =>
                          batchIds.includes(c.id),
                        )
                        .map((c: DrawingComponent) => ({
                          componentId: c.id,
                          expectedVersion: c.version,
                          status: "confirmed",
                          category: c.category,
                          label: c.label,
                          floor: c.floor,
                          material: c.material,
                          thicknessMm: c.thicknessMm,
                          evidence,
                        })),
                    }),
                  )
                }
              >
                确认勾选的 {batchIds.length} 个候选
              </button>
            </details>
          )}
          {editing && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  request("submit", {
                    fingerprint: state.batch.fingerprint,
                    reviews: [
                      {
                        componentId: editing.id,
                        expectedVersion: editing.version,
                        status: "confirmed",
                        category: editing.category,
                        label: editing.label,
                        floor: editing.floor,
                        material: editing.material,
                        thicknessMm: editing.thicknessMm,
                        evidence,
                      },
                    ],
                  }),
                );
              }}
            >
              <label>
                名称
                <input
                  value={editing.label}
                  onChange={(e) =>
                    setEditing({ ...editing, label: e.target.value })
                  }
                />
              </label>
              <label>
                类型
                <select
                  value={editing.category}
                  onChange={(e) =>
                    setEditing({ ...editing, category: e.target.value as any })
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
                  value={editing.floor}
                  onChange={(e) =>
                    setEditing({ ...editing, floor: e.target.value })
                  }
                />
              </label>
              <label>
                材料
                <input
                  value={editing.material}
                  onChange={(e) =>
                    setEditing({ ...editing, material: e.target.value })
                  }
                />
              </label>
              <label>
                均匀厚度 / mm
                <input
                  type="number"
                  min="0.001"
                  step="any"
                  value={editing.thicknessMm ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      thicknessMm: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                />
              </label>
              <label>
                核对证据与参数来源
                <textarea
                  required
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </label>
              <button disabled={busy || state.stale || !evidence.trim()}>
                确认此构件
              </button>
              <button
                type="button"
                disabled={busy || state.stale || !evidence.trim()}
                onClick={() =>
                  void run(() =>
                    request("submit", {
                      fingerprint: state.batch.fingerprint,
                      reviews: [
                        {
                          componentId: editing.id,
                          expectedVersion: editing.version,
                          status: "rejected",
                          category: editing.category,
                          label: editing.label,
                          floor: editing.floor,
                          material: editing.material,
                          evidence,
                        },
                      ],
                    }),
                  )
                }
              >
                排除此候选
              </button>
            </form>
          )}
          <UnitAdoptionPanel
            key={state.batch.drawingId}
            units={state.preview.units}
            stale={state.stale}
            busy={busy}
            onRefresh={() =>
              void run(async () => {
                await request("refresh", {});
                setEditing(undefined);
                setBatchIds([]);
                setSelected([]);
              })
            }
            onAdopt={(scale, unitEvidence) =>
              run(async () => {
                await request("units", {
                  fingerprint: state.batch.fingerprint,
                  metresPerDrawingUnit: scale,
                  evidence: unitEvidence,
                });
                await request("refresh", {});
                setEditing(undefined);
                setBatchIds([]);
                setSelected([]);
              })
            }
          />
          <details>
            <summary>资料发送设置</summary>
            <p>
              当前策略：{state.policy.mode}
              。详细授权仅适用于此冻结快照，几何将可发送至 Codex
              配置的模型服务方。
            </p>
            <button
              disabled={busy || state.stale}
              onClick={() =>
                void run(() => request("policy", { mode: "summary" }))
              }
            >
              使用摘要
            </button>
            <button
              disabled={busy || state.stale}
              onClick={() =>
                void run(() => request("policy", { mode: "geometry" }))
              }
            >
              授权此快照详细几何
            </button>
          </details>
          <details>
            <summary>图层</summary>
            {layers.map((layer) => (
              <label key={layer}>
                <input
                  type="checkbox"
                  checked={!hidden.has(layer)}
                  onChange={() =>
                    setHidden((old) => {
                      const next = new Set(old);
                      next.has(layer) ? next.delete(layer) : next.add(layer);
                      return next;
                    })
                  }
                />
                {layer}
              </label>
            ))}
          </details>
          <details>
            <summary>解析诊断与计量状态</summary>
            <pre>{JSON.stringify(state.diagnostics, null, 2)}</pre>
          </details>
          <details>
            <summary>计算结果与依据</summary>
            <h3>当前图纸结果</h3>
            <pre>{JSON.stringify(state.results, null, 2)}</pre>
            <h3>多图结果与范围完成状态</h3>
            <pre>{JSON.stringify(state.scopeResults, null, 2)}</pre>
          </details>
        </aside>
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
