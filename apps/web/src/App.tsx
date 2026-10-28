import { useEffect, useMemo, useRef, useState } from "react";
import Viewer from "./Viewer";
import ImportDiagnostics from "./ImportDiagnostics";
import QuickQuestions, { type QuickQuestion } from "./QuickQuestions";
import Markdown from "./Markdown";
import { api, call, operationId, waitJob } from "./api";
import type {
  Occurrence,
  Operation,
  Selection,
  Snapshot,
} from "../../server/types";
const num = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 9 }).format(v);
const stateLabel: Record<string, string> = {
  queued: "排队",
  running: "执行中",
  succeeded: "完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  valid: "有效",
  stale: "已失效",
  passed: "通过",
  not_run: "未运行",
  unsupported: "未覆盖",
  not_applicable: "不适用",
  not_computable: "无法计算",
  completed: "完成",
  delivery_uncertain: "待对账",
  accepted: "已受理",
  sending: "发送中",
};
export default function App() {
  const [projects, setProjects] = useState<any[]>([]),
    [pid, setPid] = useState(""),
    [project, setProject] = useState<any>(null),
    [summary, setSummary] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [samples, setSamples] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [selection, setSelection] = useState<Selection | null>(null),
    [hidden, setHidden] = useState(new Set<string>()),
    [isolated, setIsolated] = useState(false),
    [tool, setTool] = useState("select"),
    [fit, setFit] = useState(0),
    [focus, setFocus] = useState(0);
  const [tab, setTab] = useState("objects"),
    [query, setQuery] = useState<any>(null),
    [layerFilter, setLayerFilter] = useState(""),
    [typeFilter, setTypeFilter] = useState(""),
    [textFilter, setTextFilter] = useState("");
  const [diagnosticFilter, setDiagnosticFilter] = useState<string | null>(null);
  const [issuePage, setIssuePage] = useState(0);
  const [issues, setIssues] = useState<any[]>([]),
    [modal, setModal] = useState(""),
    [projectName, setProjectName] = useState(""),
    [fileRef, setFileRef] = useState(""),
    [compatible, setCompatible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [candidate, setCandidate] = useState<any>(null),
    [exported, setExported] = useState<any>(null),
    [job, setJob] = useState<any>(null);
  const [thickness, setThickness] = useState("150"),
    [classification, setClassification] = useState("楼板"),
    [material, setMaterial] = useState("C30"),
    [moveX, setMoveX] = useState("100"),
    [newLayer, setNewLayer] = useState(""),
    [newText, setNewText] = useState(""),
    [holes, setHoles] = useState<{ ids: string[]; snapshot: string } | null>(
      null,
    ),
    [unitScale, setUnitScale] = useState("0.001");
  const [session, setSession] = useState<any>(null),
    [turns, setTurns] = useState<any[]>([]),
    [message, setMessage] = useState(""),
    [hostEvents, setHostEvents] = useState<any[]>([]),
    [policy, setPolicy] = useState("summary");
  const [questionScope, setQuestionScope] = useState<
    QuickQuestion["scope"] | null
  >(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const aiPending = turns.some((t) =>
    ["accepted", "sending", "running", "delivery_uncertain"].includes(t.status),
  );
  const pidRef = useRef(pid),
    revisionRef = useRef<string | null>(null),
    selectionSeq = useRef(0),
    sessionRef = useRef<string | null>(null);
  pidRef.current = pid;
  sessionRef.current = session?.id ?? null;
  const ctx = () => ({
    projectId: pid,
    workingRevision: project?.revision?.id,
    geometrySnapshotId: project?.revision?.geometrySnapshotId,
  });
  const viewSynchronized =
    preview?.geometrySnapshotId === project?.revision?.geometrySnapshotId;
  const activeResult = project?.results
    ?.filter((r: any) => r.workingRevision === project?.revision?.id)
    .at(-1);
  const anyResult = activeResult ?? project?.results?.at(-1);
  const displayable = useMemo(
    () =>
      new Set<string>(
        (preview?.occurrences ?? [])
          .filter((o: Occurrence) => o.geometry || o.diagnosticPreview)
          .map((o: Occurrence) => o.occurrenceId),
      ),
    [preview],
  );
  useEffect(() => setIssuePage(0), [issues]);

  const currentObject: Occurrence | undefined = preview?.occurrences.find(
    (o: Occurrence) => o.occurrenceId === selected[0],
  );
  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        `${(e as any).code ? `[${(e as any).code}] ` : ""}${(e as Error).message}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh(projectId = pid, geometry = true) {
    const p = await call("project_open", { projectId });
    if (pidRef.current !== projectId) return null;
    if (revisionRef.current && revisionRef.current !== p.revision?.id) {
      selectionSeq.current++;
      setSelection(null);
      setSelected([]);
      setDiagnosticFilter(null);
      setHoles(null);
    }
    revisionRef.current = p.revision?.id ?? null;
    setProject(p);
    setPolicy(p.dataPolicy.mode);
    if (p.revision) {
      const [s, v, rows, checks] = await Promise.all([
        call("dwg_summary", { projectId }),
        geometry
          ? api(`preview?projectId=${projectId}`)
          : Promise.resolve(null),
        call("dwg_query", {
          projectId,
          filter: { space: "model" },
          pageSize: 50,
        }),
        call("issue_list", { projectId }),
      ]);
      if (pidRef.current !== projectId) return null;
      setSummary(s);
      if (v) setPreview(v);
      setQuery(rows);
      setIssues(checks.issues);
    }
    setProjects(await api("projects"));
    return p;
  }
  async function chooseProject(projectId: string) {
    pidRef.current = projectId;
    revisionRef.current = null;
    setPid(projectId);
    selectionSeq.current++;
    setProject(null);
    setSummary(null);
    setPreview(null);
    setQuery(null);
    setSelected([]);
    setSelection(null);
    setHidden(new Set());
    setHoles(null);
    setCandidate(null);
    setIssues([]);
    setSession(null);
    setTurns([]);
    setMessage("");
    setQuestionScope(null);
    setHostEvents([]);
    setError("");
    setExported(null);
    setNotice("");
    setJob(null);
    setIsolated(false);
    setLayerFilter("");
    setTypeFilter("");
    setDiagnosticFilter(null);
    setTextFilter("");
    localStorage.setItem("bwc-project", projectId);
    await refresh(projectId);
    const sid = localStorage.getItem(`bwc-session:${projectId}`);
    if (sid) {
      try {
        const s = await api("session/read", { projectId, sessionId: sid });
        if (pidRef.current === projectId) {
          setSession(s);
          setTurns(s.turns);
        }
      } catch {
        localStorage.removeItem(`bwc-session:${projectId}`);
      }
    }
  }
  useEffect(() => {
    void guarded(async () => {
      const list = await api("projects");
      setProjects(list);
      setSamples(await api("samples"));
      const saved =
        new URLSearchParams(location.search).get("project") ??
        localStorage.getItem("bwc-project");
      if (list.some((p: any) => p.projectId === saved))
        await chooseProject(saved!);
    });
  }, []);
  useEffect(() => {
    if (!pid) return;
    const stream = new EventSource(`/api/events?projectId=${pid}`);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    stream.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "revision_published") {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (pidRef.current === pid) void refresh(pid);
        }, 200);
      }
      if (event.jobId) {
        void call("project_open", { projectId: pid }).then((p) => {
          if (pidRef.current === pid) setProject(p);
        });
      }
      if (event.type === "focus" && event.selectionSet) {
        void call("selection_get", {
          projectId: pid,
          selectionSet: event.selectionSet,
        })
          .then((sel) => {
            if (pidRef.current === pid) {
              setSelected(sel.members);
              setSelection(sel);
              setFocus((n) => n + 1);
            }
          })
          .catch(() => {});
      }
      if (event.type === "visibility")
        setHidden((old) => {
          const n = new Set(old);
          for (const l of event.layers) event.visible ? n.delete(l) : n.add(l);
          return n;
        });
      if (event.turnId && event.sessionId === sessionRef.current) {
        setHostEvents((old) => [...old.slice(-19), event]);
        void api("session/read", {
          projectId: pid,
          sessionId: sessionRef.current,
        })
          .then((s) => {
            if (pidRef.current === pid) setTurns(s.turns);
          })
          .catch(() => {});
      }
    };
    stream.onerror = () => {};
    return () => {
      stream.close();
      clearTimeout(debounce);
    };
  }, [pid]);
  async function freeze(ids: string[], append = false) {
    if (!viewSynchronized)
      throw new Error("正在更新图纸修订，请等待当前画面就绪");
    const ticket = ++selectionSeq.current;
    const merged = append ? [...new Set([...selected, ...ids])] : ids;
    setSelected(merged);
    setSelection(null);
    if (!merged.length) return;
    const result = await call("selection_create", {
      ...ctx(),
      members: merged,
      evidence: "workbench_graphic_or_table_selection",
    });
    if (ticket === selectionSeq.current && pidRef.current === pid)
      setSelection(result);
  }
  const select = (ids: string[], append = false) => {
    void freeze(ids, append).catch((e) => setError(e.message));
  };
  async function createProject() {
    const p = await api("projects", { name: projectName || "未命名 DWG 项目" });
    await chooseProject(p.projectId);
    setModal("import");
    setSamples(await api("samples"));
  }
  async function importFile(ref = fileRef) {
    const result = await waitJob(
      pid,
      await call("dwg_import", {
        projectId: pid,
        fileRef: ref,
        role: compatible ? "compatible_copy" : "original",
        operationId: operationId(),
      }),
      setJob,
    );
    setModal("");
    setSelected([]);
    setSelection(null);
    await refresh();
    setNotice(
      `已导入 ${result.occurrenceCount} 个实例，${result.completeness === "partial" ? "存在未覆盖范围" : "已生成初始快照"}`,
    );
  }
  async function upload(file: File) {
    let projectId = pid;
    if (!projectId) {
      const p = await api("projects", {
        name: file.name.replace(/\.dwg$/i, ""),
      });
      projectId = p.projectId;
      await chooseProject(projectId);
    }
    const r = await fetch(
      `/api/upload?projectId=${projectId}&name=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file },
    );
    const data = await r.json();
    if (!r.ok) throw new Error(data.error.message);
    await waitJob(
      projectId,
      await call("dwg_import", {
        projectId,
        fileRef: data.fileRef,
        role: compatible ? "compatible_copy" : "original",
        operationId: operationId(),
      }),
      setJob,
    );
    setModal("");
    await refresh(projectId);
  }
  async function runQuery(cursor?: string) {
    const filter = {
      space: "model",
      ...(diagnosticFilter ? { diagnosticGroupId: diagnosticFilter } : {}),
      ...(layerFilter ? { layers: [layerFilter] } : {}),
      ...(typeFilter ? { entityTypes: [typeFilter] } : {}),
      ...(textFilter ? { text: textFilter } : {}),
    };
    const q = await call("dwg_query", {
      ...ctx(),
      filter,
      pageSize: 50,
      ...(cursor ? { cursor } : {}),
    });
    setQuery(q);
  }
  async function selectQuery() {
    const sel = await call("selection_create", {
      ...ctx(),
      queryId: query.queryId,
      evidence: "explicit_all_query_results",
    });
    setSelected(sel.members);
    setSelection(sel);
    setFocus((n) => n + 1);
  }
  async function propose(operation: Operation) {
    if (operation.kind !== "set_units" && !selection)
      throw new Error("请先选择并冻结对象范围");
    const scope =
      operation.kind === "set_units"
        ? {}
        : { selectionSet: { id: selection!.id, version: 1 } };
    const intent = await api("intent", {
      ...ctx(),
      geometrySnapshotId: undefined,
      ...scope,
      operation,
      text: `工作台明确操作：${JSON.stringify(operation)}`,
    });
    const c = await call("change_propose", {
      projectId: pid,
      baseRevision: project.revision.id,
      baseGeometrySnapshotId: project.revision.geometrySnapshotId,
      ...scope,
      operation,
      operationId: operationId(),
      intentId: intent.id,
    });
    setCandidate(c);
    setModal("change");
  }
  async function applyChange() {
    const c = candidate;
    await call("change_apply", {
      projectId: pid,
      changeId: c.id,
      operationId: c.operationId,
      baseRevision: c.baseRevision,
      candidateFingerprint: c.candidateFingerprint,
    });
    setModal("");
    const p = await refresh();
    if (p && selected.length) {
      const sel = await call("selection_create", {
        projectId: pid,
        workingRevision: p.revision.id,
        geometrySnapshotId: p.revision.geometrySnapshotId,
        members: selected,
        evidence: "identity_preserved_after_change",
      });
      setSelected(selected);
      setSelection(sel);
    }
    setNotice("新修订已发布，旧结果已失效；请重新计量。");
  }
  async function measure(kind: string) {
    if (!selection) throw new Error("请选择明确计量范围");
    await waitJob(
      pid,
      await call("takeoff_run", {
        ...ctx(),
        selectionSet: { id: selection.id, version: 1 },
        quantityKind: kind,
        operationId: operationId(),
      }),
      setJob,
    );
    await refresh(pid, false);
    setTab("results");
  }
  async function check() {
    await waitJob(
      pid,
      await call("dwg_check", {
        ...ctx(),
        ...(selection
          ? { selectionSet: { id: selection.id, version: 1 } }
          : {}),
        operationId: operationId(),
      }),
      setJob,
    );
    await refresh(pid, false);
    setTab("issues");
  }
  async function reparse() {
    const result = await waitJob(
      pid,
      await call("dwg_reparse", { ...ctx(), operationId: operationId() }),
      setJob,
    );
    await refresh(pid);
    setNotice(
      `已生成新解析版本：尚无规范几何 ${result.report.before.modelWithoutGeometry} → ${result.report.after.modelWithoutGeometry}；旧快照保留。`,
    );
  }
  async function exportReport() {
    const out = await waitJob(
      pid,
      await call("result_export", {
        ...ctx(),
        ...(activeResult ? { resultVersion: activeResult.id } : {}),
        operationId: operationId(),
      }),
      setJob,
    );
    setExported(out);
    setModal("exports");
  }
  async function exportDwg() {
    const out = await waitJob(
      pid,
      await call("dwg_export", {
        ...ctx(),
        mode: "candidate",
        operationId: operationId(),
      }),
      setJob,
    );
    setExported(out);
    setModal("exports");
  }
  async function sendMessage(prompt?: string, wholeDrawing = false) {
    if (!project?.revision) throw new Error("请先导入 DWG");
    const fromComposer = prompt === undefined;
    if (fromComposer && questionScope === "selection" && !selection)
      throw new Error("请先选择并冻结对象");
    const drawingScope =
      wholeDrawing || (fromComposer && questionScope === "drawing");
    let s = session;
    if (!s) {
      s = await api("session/create", { projectId: pid });
      setSession(s);
      localStorage.setItem(`bwc-session:${pid}`, s.id);
    }
    const text = prompt ?? message;
    const t = await api("session/message", {
      projectId: pid,
      sessionId: s.id,
      clientMessageId: operationId(),
      text,
      context: {
        workingRevision: project.revision.id,
        geometrySnapshotId: project.revision.geometrySnapshotId,
        ...(selection && !drawingScope
          ? { selectionSet: { id: selection.id, version: 1 } }
          : {}),
        dataPolicyVersion: project.dataPolicy.id,
      },
    });
    setTurns((old) => [...old, t]);
    setMessage("");
    setQuestionScope(null);
  }
  function pickQuestion(question: QuickQuestion) {
    setMessage(question.prompt);
    setQuestionScope(question.scope);
    composerInput.current?.focus();
  }
  async function diagnose(groupId?: string) {
    setModal("");
    await sendMessage(
      `请使用 dwg_diagnostics 排查${groupId ? `当前诊断组 ${groupId}` : "整张图纸的解析不完整问题"}，区分规范几何缺失、显示限制和文档保持待核验。给出实际实例数和下一步；对有模型实例的诊断组，用 diagnosticGroupId 冻结准确范围并定位。辅助定位不是已解析几何，缺项不按零计量。只做诊断，不修改图纸或重新解析。`,
      true,
    );
  }
  const switchTab = (t: string) => setTab(t);
  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <span className="brand-icon">筑</span>
          <div>
            筑材智算<small>DWG WORKFLOW</small>
          </div>
        </div>
        <div className="rail-label">
          本地项目{" "}
          <button aria-label="新建项目" onClick={() => setModal("new")}>
            ＋
          </button>
        </div>
        <div className="project-list">
          {projects.map((p) => (
            <button
              className={
                pid === p.projectId ? "project-link active" : "project-link"
              }
              key={p.projectId}
              onClick={() => void guarded(() => chooseProject(p.projectId))}
            >
              <span className="file-icon">▧</span>
              <span>
                {p.name}
                <small>
                  {p.currentRevision ? "已保存到本机" : "待导入图纸"}
                </small>
              </span>
            </button>
          ))}
        </div>
        <button className="outline rail-new" onClick={() => setModal("new")}>
          ＋ 新建项目
        </button>
        <div className="rail-footer">
          <span className="live-dot" /> 本地引擎
          <small>图纸与任务自动保存</small>
          <button
            className="text-button"
            disabled={!pid}
            onClick={() => setModal("settings")}
          >
            项目设置
          </button>
          <a
            href="https://domcr.github.io/ACadSharp/index.html"
            target="_blank"
            rel="noreferrer"
          >
            ACadSharp 3.8.30 ↗
          </a>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumbs">
            项目工作台 <span>/</span> <b>{project?.name ?? "最近项目"}</b>
            {project?.revision && (
              <code>{project.revision.id.slice(0, 10)}</code>
            )}
          </div>
          <div className="header-actions">
            <span className="saved">
              <span className="live-dot" /> 本地持久化
            </span>
            <button
              className="outline"
              onClick={() => {
                setModal(pid ? "import" : "new");
              }}
            >
              打开 DWG
            </button>
            <button
              className="primary"
              disabled={!project?.revision || busy}
              onClick={() => void guarded(exportReport)}
            >
              导出成果 ↗
            </button>
          </div>
        </header>
        {error && (
          <div className="alert error" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="alert success">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {!project?.revision ? (
          <div className="welcome">
            <div className="eyebrow">从工程文件，到可追溯的数量</div>
            <h1>打开图纸，推进一项真实任务。</h1>
            <p>加载、查询、检查、修改与计量，共用同一份版本依据。</p>
            <div className="welcome-actions">
              <button
                className="primary"
                onClick={() => setModal(pid ? "import" : "new")}
              >
                打开 DWG 文件
              </button>
              <button
                className="outline"
                disabled={busy}
                onClick={() =>
                  void guarded(async () => {
                    await api("fixture", {});
                    setSamples(await api("samples"));
                    if (!pid) {
                      const p = await api("projects", {
                        name: "受控基准验收项目",
                      });
                      await chooseProject(p.projectId);
                    }
                    setFileRef("controlled");
                    setModal("import");
                  })
                }
              >
                体验受控基准
              </button>
            </div>
            <div className="welcome-grid">
              <div>
                <b>01</b>
                <h3>查看真实解析范围</h3>
                <p>基础曲线、文字与块实例。未知对象和读取通知持续可见。</p>
              </div>
              <div>
                <b>02</b>
                <h3>明确范围与依据</h3>
                <p>采用单位、冻结选择，确认轮廓、洞口和均匀厚度。</p>
              </div>
              <div>
                <b>03</b>
                <h3>发布修订与成果</h3>
                <p>计算由几何引擎执行，历史结果保留原始依据。</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="context-bar">
              <span
                className={
                  summary?.unitProfile.confirmed ? "status good" : "status warn"
                }
              >
                {summary?.unitProfile.confirmed
                  ? `采用单位 ${summary.unitProfile.metresPerDrawingUnit} m / 源单位`
                  : `单位待确认 · INSUNITS ${summary?.unitProfile.sourceInsUnits}`}
              </span>
              <button className="text-button" onClick={() => setModal("units")}>
                校准单位
              </button>
              <span className="divider" />
              <span>
                {summary?.sourceEntityCount?.toLocaleString()} 条模型源实体
              </span>
              <span>
                {summary?.occurrenceCount?.toLocaleString()} 个展开实例
              </span>
              <button
                className="gap-button"
                onClick={() => setModal("diagnostics")}
              >
                {summary?.importCompleteness === "partial"
                  ? `${summary.diagnosticCount} 条诊断 · ${summary.notificationCount} 条通知`
                  : "当前解析无已知缺口"}{" "}
                ↗
              </button>
            </div>
            <section className="workbench">
              <div className="drawing-pane">
                <div className="drawing-toolbar">
                  <div className="view-tabs">
                    <button className="active">二维图纸</button>
                    <span title="当前只开放二维受支持图元">三维暂未开放</span>
                  </div>
                  <div className="view-controls">
                    <button onClick={() => setFit((n) => n + 1)}>
                      适配全图
                    </button>
                    <button
                      disabled={!selected.length}
                      onClick={() => setFocus((n) => n + 1)}
                    >
                      定位选中
                    </button>
                    <button
                      className={isolated ? "selected" : ""}
                      disabled={!selected.length}
                      onClick={() => setIsolated((v) => !v)}
                    >
                      隔离
                    </button>
                  </div>
                </div>
                {preview && (
                  <Viewer
                    occurrences={preview.occurrences}
                    selected={selected}
                    onSelect={select}
                    hidden={hidden}
                    isolated={isolated}
                    tool={tool}
                    fitToken={fit}
                    focusToken={focus}
                    scale={preview.units.metresPerDrawingUnit}
                  />
                )}
                <div className="floating-tools">
                  <button
                    className={tool === "select" ? "active" : ""}
                    onClick={() => setTool("select")}
                    title="选择"
                  >
                    ↖ 选择
                  </button>
                  <button
                    className={tool === "pan" ? "active" : ""}
                    onClick={() => setTool("pan")}
                  >
                    ✥ 平移
                  </button>
                  <button
                    className={tool === "measure" ? "active" : ""}
                    onClick={() => setTool("measure")}
                  >
                    ⌁ 测距
                  </button>
                  <button onClick={() => setModal("layers")}>☷ 图层</button>
                </div>
                <div className="selection-strip">
                  <span>
                    {selected.length
                      ? `已选 ${selected.length} 个实例`
                      : "点击或框选对象，建立任务范围"}
                  </span>
                  {selection ? (
                    <code>已冻结 {selection.id.slice(0, 12)}</code>
                  ) : selected.length ? (
                    <span>正在冻结…</span>
                  ) : null}
                  <button
                    className="text-button"
                    disabled={!selected.length}
                    onClick={() => {
                      setSelected([]);
                      setSelection(null);
                      setIsolated(false);
                    }}
                  >
                    清空
                  </button>
                </div>
              </div>
              <aside className="task-pane">
                <div className="task-title">
                  <span className="spark">✦</span>
                  <div>
                    <h2>图纸任务助手</h2>
                    <small>Codex CLI · 真实领域工具</small>
                  </div>
                  <button
                    className="icon-button"
                    title="数据发送设置"
                    onClick={() => setModal("settings")}
                  >
                    ⚙
                  </button>
                </div>
                <div className="task-scroll">
                  <div className="assistant-intro">
                    <b>先把范围和依据说清楚。</b>
                    <p>
                      我可以查询当前图纸、定位问题，并对受支持对象进行修改和计量。图层名称只作为候选依据。
                    </p>
                  </div>
                  <div className="scope-card">
                    <span>当前任务范围</span>
                    <b>
                      {selection
                        ? `${selection.members.length} 个冻结实例`
                        : "尚未选择对象"}
                    </b>
                    <small>
                      {project.revision.geometrySnapshotId.slice(0, 18)}…
                    </small>
                  </div>
                  {summary?.importCompleteness === "partial" && (
                    <div className="issue-card">
                      <span className="status warn">解析不完整</span>
                      <p>
                        {summary.importReport
                          ? `模型空间有 ${summary.importReport.modelWithoutGeometry.toLocaleString()} 个实例尚无规范几何，${summary.importReport.notificationGroupCount} 类读取通知待核验。已有几何仍可查询；计量需确认单位、轮廓和参数。`
                          : "部分对象尚未覆盖，已有几何仍可查询；读取通知的实际影响需要核验。"}
                      </p>
                      <button
                        className="text-button"
                        onClick={() => setModal("diagnostics")}
                      >
                        查看解析明细 →
                      </button>
                      <button
                        className="text-button"
                        onClick={() => setModal("compatibility")}
                      >
                        登记兼容副本 →
                      </button>
                      <button
                        className="outline"
                        disabled={busy}
                        onClick={() => void guarded(() => diagnose())}
                      >
                        让 AI 排查解析问题
                      </button>
                    </div>
                  )}
                  {turns.map((t) => (
                    <div className="conversation" key={t.id}>
                      <div className="user-message">{t.text}</div>
                      <div className="assistant-message">
                        {t.response ? (
                          <Markdown text={t.response} />
                        ) : (
                          "消息已受理，等待宿主…"
                        )}
                        {t.error?.message && (
                          <p className="conversation-error">
                            AI 服务：{t.error.message}
                          </p>
                        )}
                        <small>{stateLabel[t.status] ?? t.status}</small>
                      </div>
                      {t.status === "delivery_uncertain" && (
                        <button
                          className="outline"
                          onClick={() =>
                            void guarded(async () => {
                              const r = await api("session/reconcile", {
                                projectId: pid,
                                sessionId: session.id,
                              });
                              setNotice(
                                r.status === "reconciled"
                                  ? "宿主与本地状态已对账"
                                  : "仍需恢复核对；未自动重发消息",
                              );
                              setTurns(
                                (
                                  await api("session/read", {
                                    projectId: pid,
                                    sessionId: session.id,
                                  })
                                ).turns,
                              );
                            })
                          }
                        >
                          恢复并对账
                        </button>
                      )}
                    </div>
                  ))}
                  {hostEvents.slice(-3).map((e, i) => (
                    <div className="host-event" key={i}>
                      {e.type === "error"
                        ? e.message
                        : e.type === "domain_tool"
                          ? `工具 ${e.tool}`
                          : (e.method ?? e.type)}
                    </div>
                  ))}
                  {job && (
                    <div className="job-card">
                      <span className="live-dot" />
                      <b>{job.kind}</b>
                      <span>
                        {stateLabel[job.status] ?? job.status} · {job.stage}
                      </span>
                      {["queued", "running"].includes(job.status) && (
                        <button
                          className="text-button"
                          onClick={() =>
                            void guarded(async () => {
                              await call("job_cancel", {
                                projectId: pid,
                                jobId: job.id,
                              });
                            })
                          }
                        >
                          取消任务
                        </button>
                      )}
                    </div>
                  )}
                  <details className="manual" open>
                    <summary>
                      人工工具 <small>无需 AI 账号</small>
                    </summary>
                    <div className="manual-buttons">
                      <button
                        className="outline"
                        disabled={busy}
                        onClick={() => void guarded(check)}
                      >
                        检查当前范围
                      </button>
                      <button
                        className="outline"
                        disabled={!selection || busy}
                        onClick={() => void guarded(() => measure("length"))}
                      >
                        曲线长度
                      </button>
                      <button
                        className="outline"
                        disabled={!selection || busy}
                        onClick={() => void guarded(() => measure("net_area"))}
                      >
                        净面积
                      </button>
                      <button
                        className="primary"
                        disabled={!selection || busy}
                        onClick={() =>
                          void guarded(() => measure("parameter_volume"))
                        }
                      >
                        参数体积
                      </button>
                    </div>
                  </details>
                </div>
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void guarded(sendMessage);
                  }}
                >
                  <QuickQuestions
                    hasSelection={!!selection && viewSynchronized}
                    unitsConfirmed={!!summary?.unitProfile.confirmed}
                    hasGaps={summary?.importCompleteness === "partial"}
                    disabled={busy || aiPending || !viewSynchronized}
                    onPick={pickQuestion}
                  />
                  <label htmlFor="task-input">任务目标 / 补充依据</label>
                  <textarea
                    ref={composerInput}
                    id="task-input"
                    placeholder="检查选中轮廓；或将计量厚度设为150mm并重算"
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value);
                      if (!e.target.value.trim()) setQuestionScope(null);
                    }}
                  />
                  <div>
                    <small>
                      {policy === "summary"
                        ? "发送摘要及明确参数"
                        : "允许发送详细几何"}{" "}
                      ·{" "}
                      {questionScope === "drawing"
                        ? "整张图纸"
                        : selection
                          ? `选中 ${selection.members.length} 个对象`
                          : "未选范围"}
                    </small>
                    <button
                      type="button"
                      className="text-button"
                      disabled={
                        !turns.some((t) =>
                          ["running", "sending"].includes(t.status),
                        )
                      }
                      onClick={() =>
                        void guarded(async () => {
                          const t = turns.findLast((t) =>
                            ["running", "sending"].includes(t.status),
                          );
                          await api("session/interrupt", {
                            projectId: pid,
                            sessionId: session.id,
                            turnId: t.id,
                          });
                        })
                      }
                    >
                      停止 AI
                    </button>
                    <button
                      className="primary"
                      disabled={
                        !message.trim() ||
                        busy ||
                        aiPending ||
                        (questionScope === "selection" && !selection)
                      }
                    >
                      发送 ↑
                    </button>
                  </div>
                </form>
              </aside>
            </section>
            <section className="details-pane">
              <div className="details-tabs">
                {[
                  ["objects", "对象与范围"],
                  ["properties", "属性与修改"],
                  ["results", "计量结果"],
                  ["issues", "问题清单"],
                  ["history", "修订历史"],
                ].map(([key, label]) => (
                  <button
                    className={tab === key ? "active" : ""}
                    key={key}
                    onClick={() => switchTab(key)}
                  >
                    {label}
                    {key === "issues" && issues.length > 0 && (
                      <span>
                        {
                          issues.filter((i) =>
                            ["failed", "unsupported"].includes(i.status),
                          ).length
                        }{" "}
                        组
                      </span>
                    )}
                  </button>
                ))}
                <small>
                  {busy
                    ? "正在执行…"
                    : viewSynchronized
                      ? "版本一致 · 依据可追溯"
                      : "正在更新图纸修订…"}
                </small>
              </div>
              {tab === "objects" && (
                <>
                  <div className="filter-bar">
                    <select
                      aria-label="图层筛选"
                      value={layerFilter}
                      onChange={(e) => setLayerFilter(e.target.value)}
                    >
                      <option value="">全部图层</option>
                      {preview?.occurrences &&
                        [
                          ...new Set<string>(
                            preview.occurrences.map((o: Occurrence) => o.layer),
                          ),
                        ]
                          .sort()
                          .map((l) => <option key={l}>{l}</option>)}
                    </select>
                    <select
                      aria-label="实体类型筛选"
                      value={typeFilter}
                      onChange={(e) => {
                        setTypeFilter(e.target.value);
                        setDiagnosticFilter(null);
                      }}
                    >
                      <option value="">全部类型</option>
                      {Object.keys(summary?.entityTypes ?? {})
                        .sort()
                        .map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                    </select>
                    <input
                      aria-label="文字查询"
                      placeholder="文字内容"
                      value={textFilter}
                      onChange={(e) => setTextFilter(e.target.value)}
                    />
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() => void guarded(() => runQuery())}
                    >
                      查询
                    </button>
                    {diagnosticFilter && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setDiagnosticFilter(null);
                          setNotice("已移除诊断组筛选，请重新查询。");
                        }}
                      >
                        诊断组筛选中 ×
                      </button>
                    )}
                    <button
                      className="text-button"
                      disabled={!query?.total || busy}
                      onClick={() => void guarded(selectQuery)}
                    >
                      冻结全部 {query?.total ?? 0} 条结果
                    </button>
                    <span className="muted">
                      当前页 {query?.items.length ?? 0} / 全部{" "}
                      {query?.total ?? 0}
                    </span>
                    {query?.cursor && (
                      <button
                        className="outline"
                        onClick={() =>
                          void guarded(() => runQuery(query.cursor))
                        }
                      >
                        下一页 →
                      </button>
                    )}
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>选择</th>
                          <th>实例 / 源 handle</th>
                          <th>图元类型</th>
                          <th>有效图层</th>
                          <th>实例路径</th>
                          <th>业务分类</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {query?.items.map(
                          (o: Occurrence & { business: any }) => (
                            <tr
                              key={o.occurrenceId}
                              className={
                                selected.includes(o.occurrenceId)
                                  ? "highlight-row"
                                  : ""
                              }
                            >
                              <td>
                                <input
                                  aria-label={`选择 ${o.sourceHandle}`}
                                  type="checkbox"
                                  checked={selected.includes(o.occurrenceId)}
                                  onChange={(e) =>
                                    select(
                                      e.target.checked
                                        ? [...selected, o.occurrenceId]
                                        : selected.filter(
                                            (x) => x !== o.occurrenceId,
                                          ),
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <code>{o.occurrenceId.slice(0, 16)}</code>
                                <small>{o.sourceHandle}</small>
                              </td>
                              <td>{o.entityType}</td>
                              <td>{o.layer}</td>
                              <td>
                                {o.instancePath.length
                                  ? o.instancePath
                                      .map(
                                        (p) =>
                                          p.insertHandle +
                                          (p.arrayCell
                                            ? `[${p.arrayCell.row},${p.arrayCell.column}]`
                                            : ""),
                                      )
                                      .join(" / ")
                                  : "模型直接对象"}
                              </td>
                              <td>{o.business?.classification ?? "待确认"}</td>
                              <td>
                                <button
                                  className="text-button"
                                  onClick={() => {
                                    select([o.occurrenceId]);
                                    setFocus((n) => n + 1);
                                    setTab("properties");
                                  }}
                                >
                                  定位 / 属性
                                </button>
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {tab === "properties" && (
                <div className="properties-grid">
                  <div>
                    <h3>
                      {selected.length
                        ? `已选 ${selected.length} 个实例`
                        : "先在图中或对象表选择范围"}
                    </h3>
                    {currentObject && (
                      <>
                        <p>
                          {currentObject.entityType} · {currentObject.layer} ·
                          handle {currentObject.sourceHandle}
                        </p>
                        <code>{currentObject.occurrenceId}</code>
                        {!currentObject.geometry &&
                          currentObject.diagnosticPreview && (
                            <p className="muted">
                              当前显示为辅助定位：
                              {currentObject.diagnosticPreview.limitation}
                            </p>
                          )}
                        {currentObject.geometry?.kind === "annotation" && (
                          <p className="muted">
                            尺寸标注仅供阅读，不作为长度、面积或体积计量对象；标注文字可能含人工覆盖值。
                          </p>
                        )}
                        <p className="muted">
                          {currentObject.instancePath.length
                            ? "块内部和阵列成员可定位、查询；受支持的规范几何可计量。局部图元编辑尚未开放。"
                            : "模型空间直接对象"}
                        </p>
                      </>
                    )}
                    <button
                      className="outline"
                      disabled={!selection}
                      onClick={() => {
                        setHoles({
                          ids: selected,
                          snapshot: project.revision.geometrySnapshotId,
                        });
                        setNotice(
                          `已暂记 ${selected.length} 个洞口。请再选外轮廓并应用洞口关联。`,
                        );
                      }}
                    >
                      将选中范围暂记为洞口
                    </button>
                    {holes && (
                      <button
                        className="outline"
                        disabled={
                          !selection ||
                          busy ||
                          holes.snapshot !== project.revision.geometrySnapshotId
                        }
                        onClick={() =>
                          void guarded(() =>
                            propose({ kind: "set_holes", holes: holes.ids }),
                          )
                        }
                      >
                        为当前外轮廓关联 {holes.ids.length} 个洞口
                      </button>
                    )}
                  </div>
                  <div className="form-column">
                    <h3>计量解释</h3>
                    <label>
                      均匀厚度（mm）
                      <input
                        aria-label="均匀厚度"
                        type="number"
                        min="0.001"
                        value={thickness}
                        onChange={(e) => setThickness(e.target.value)}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={!selection || busy}
                      onClick={() =>
                        void guarded(() =>
                          propose({
                            kind: "set_measurement_parameter",
                            field: "uniform_thickness",
                            value: Number(thickness),
                            unit: "mm",
                            unitBinding: "physical_quantity",
                          }),
                        )
                      }
                    >
                      预览计量厚度修改
                    </button>
                    <div className="input-row">
                      <label>
                        确认分类
                        <input
                          value={classification}
                          onChange={(e) => setClassification(e.target.value)}
                        />
                      </label>
                      <label>
                        材料
                        <input
                          value={material}
                          onChange={(e) => setMaterial(e.target.value)}
                        />
                      </label>
                    </div>
                    <button
                      className="outline"
                      disabled={!selection || busy}
                      onClick={() =>
                        void guarded(() =>
                          propose({
                            kind: "set_business",
                            classification,
                            material,
                          }),
                        )
                      }
                    >
                      预览分类 / 材料修改
                    </button>
                  </div>
                  <div className="form-column">
                    <h3>真实 CAD 图元修改</h3>
                    <label>
                      X 方向移动（mm / WCS）
                      <input
                        value={moveX}
                        onChange={(e) => setMoveX(e.target.value)}
                      />
                    </label>
                    <button
                      className="outline"
                      disabled={!selection || busy}
                      onClick={() =>
                        void guarded(() =>
                          propose({
                            kind: "move_entities",
                            delta: [Number(moveX), 0, 0],
                            coordinateSystem: "drawing_wcs",
                            unit: "mm",
                            scope: "entity",
                          }),
                        )
                      }
                    >
                      预览移动
                    </button>
                    <label>
                      目标图层
                      <input
                        value={newLayer}
                        onChange={(e) => setNewLayer(e.target.value)}
                      />
                    </label>
                    <button
                      className="outline"
                      disabled={!selection || busy || !newLayer}
                      onClick={() =>
                        void guarded(() =>
                          propose({
                            kind: "set_layer",
                            value: newLayer,
                            scope: "entity",
                          }),
                        )
                      }
                    >
                      预览图层修改
                    </button>
                    <label>
                      新文字
                      <input
                        value={newText}
                        onChange={(e) => setNewText(e.target.value)}
                      />
                    </label>
                    <button
                      className="outline"
                      disabled={!selection || busy}
                      onClick={() =>
                        void guarded(() =>
                          propose({
                            kind: "set_text",
                            value: newText,
                            scope: "entity",
                          }),
                        )
                      }
                    >
                      预览文字修改
                    </button>
                  </div>
                </div>
              )}
              {tab === "results" && (
                <div>
                  {anyResult ? (
                    <>
                      <div className="result-summary">
                        <div>
                          <small>
                            {anyResult.quantityKind} · 冻结选择集范围
                          </small>
                          <h2>
                            {num(anyResult.knownSubtotal)}{" "}
                            <span>{anyResult.unit}</span>
                          </h2>
                          <span
                            className={`status ${anyResult.validity === "stale" ? "warn" : "good"}`}
                          >
                            {anyResult.validity === "stale"
                              ? "历史结果已失效"
                              : anyResult.completeness === "partial"
                                ? "已计算小计 · 范围有缺项"
                                : "所选范围计算完整"}
                          </span>
                        </div>
                        <div>
                          <p>完整范围总量：{num(anyResult.completeTotal)}</p>
                          <p>
                            输入解析：{anyResult.importCompleteness} ·
                            转换核验：{anyResult.conversionVerification}
                          </p>
                          <code>
                            {anyResult.geometrySnapshotId.slice(0, 28)}
                          </code>
                          <p className="muted">
                            所选范围的计算完整性与全图解析完整性分别记录。
                          </p>
                        </div>
                      </div>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>对象实例</th>
                              <th>状态</th>
                              <th>数量</th>
                              <th>公式 / 缺项</th>
                              <th>依据</th>
                            </tr>
                          </thead>
                          <tbody>
                            {anyResult.items.map((i: any) => (
                              <tr key={i.id}>
                                <td>
                                  <button
                                    className="text-button"
                                    onClick={() => {
                                      select([i.id]);
                                      setFocus((n) => n + 1);
                                    }}
                                  >
                                    {i.id.slice(0, 20)}
                                  </button>
                                </td>
                                <td>{stateLabel[i.status] ?? i.status}</td>
                                <td>
                                  {num(i.value)} {anyResult.unit}
                                </td>
                                <td>{i.reason ?? i.formula}</td>
                                <td>
                                  {i.netArea != null
                                    ? `净面积 ${num(i.netArea)} m²${i.thicknessMetres ? ` × ${num(i.thicknessMetres)} m` : ""}`
                                    : i.methodVersion}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="empty">
                      选择明确轮廓，采用单位、关联洞口和厚度后运行计量。未知数量保持为空。
                    </div>
                  )}
                </div>
              )}
              {tab === "issues" && (
                <div>
                  <div className="diagnosis-summary">
                    <b>真实导入诊断</b>
                    <span>按问题分组 · 显示最近一次已完成检查</span>
                    <button
                      className="text-button"
                      onClick={() => setModal("diagnostics")}
                    >
                      展开解析缺口
                    </button>
                    <button
                      className="outline"
                      disabled={busy}
                      onClick={() => void guarded(check)}
                    >
                      运行检查
                    </button>
                  </div>
                  {issues.length > 50 && (
                    <div className="issue-pagination">
                      <span>
                        第 {issuePage + 1} / {Math.ceil(issues.length / 50)} 页
                        · 共 {issues.length} 组
                      </span>
                      <button
                        className="outline"
                        disabled={issuePage === 0}
                        onClick={() => setIssuePage((n) => n - 1)}
                      >
                        上一页
                      </button>
                      <button
                        className="outline"
                        disabled={(issuePage + 1) * 50 >= issues.length}
                        onClick={() => setIssuePage((n) => n + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  )}
                  {issues.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>检查器</th>
                            <th>状态</th>
                            <th>原因 / 证据</th>
                            <th>范围</th>
                          </tr>
                        </thead>
                        <tbody>
                          {issues
                            .slice(issuePage * 50, (issuePage + 1) * 50)
                            .map((i) => (
                              <tr key={i.id}>
                                <td>
                                  {(
                                    {
                                      units: "单位",
                                      import: "导入覆盖",
                                      basic_geometry: "基础曲线",
                                      contour: "面积轮廓",
                                      independent_cad_roundtrip:
                                        "独立 CAD 往返",
                                      duplicate_overlap: "重复与重叠",
                                    } as Record<string, string>
                                  )[i.check] ?? i.check}
                                </td>
                                <td>
                                  <span
                                    className={`status ${i.status === "passed" ? "good" : "warn"}`}
                                  >
                                    {stateLabel[i.status] ?? i.status}
                                  </span>
                                </td>
                                <td>
                                  {i.reason === "UNITS_UNCONFIRMED"
                                    ? i.status === "not_run"
                                      ? "单位未确认，此项尚未执行"
                                      : "请先采用或校准图纸单位"
                                    : i.reason === "UNSUPPORTED_GEOMETRY"
                                      ? "当前适配器尚无此类对象的规范几何"
                                      : i.reason}
                                </td>
                                <td>
                                  <small>
                                    {i.occurrenceIds.length
                                      ? `影响 ${i.occurrenceIds.length.toLocaleString()} 个已索引实例`
                                      : "文件级 / 范围待核验"}
                                  </small>
                                  {i.check === "units" ? (
                                    <button
                                      className="text-button"
                                      onClick={() => setModal("units")}
                                    >
                                      校准单位
                                    </button>
                                  ) : i.occurrenceIds.some((oid: string) =>
                                      displayable.has(oid),
                                    ) ? (
                                    <button
                                      className="text-button"
                                      onClick={() => {
                                        select(
                                          i.occurrenceIds.filter(
                                            (oid: string) =>
                                              displayable.has(oid),
                                          ),
                                        );
                                        setFocus((n) => n + 1);
                                      }}
                                    >
                                      定位可显示对象
                                    </button>
                                  ) : i.occurrenceIds.length > 0 ? (
                                    <small>尚无可定位的显示几何</small>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty">
                      尚未运行检查。未执行的检查不会显示为通过。
                    </div>
                  )}
                </div>
              )}
              {tab === "history" && (
                <div className="history-list">
                  {project.changes.length ? (
                    project.changes.toReversed().map((c: any) => (
                      <div className="history-row" key={c.id}>
                        <span className="history-dot" />
                        <div>
                          <b>{c.operation.kind}</b>
                          <p>
                            {c.diff.length} 项差异 ·{" "}
                            {c.status === "applied"
                              ? "已发布新修订"
                              : "候选未应用"}
                          </p>
                          <code>{c.operationId}</code>
                        </div>
                        <button
                          className="outline"
                          disabled={
                            busy ||
                            project.revision.operationId !== c.operationId
                          }
                          onClick={() =>
                            void guarded(async () => {
                              await call("change_revert", {
                                projectId: pid,
                                changeId: c.id,
                                operationId: operationId(),
                              });
                              setSelection(null);
                              setSelected([]);
                              setHoles(null);
                              await refresh();
                            })
                          }
                        >
                          撤销并发布修订
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="empty">
                      暂无变更。原始文件保持不可变，每次应用或撤销都会发布新修订。
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
        <footer>
          <span>筑材智算 / 本地 DWG 工作流</span>
          <span>计算依据与显示几何分离 · 首期受支持子集</span>
        </footer>
      </main>
      {modal && (
        <div className="modal-backdrop" onClick={() => !busy && setModal("")}>
          <section
            className={`modal ${["diagnostics", "change"].includes(modal) ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="关闭对话框"
              disabled={busy}
              onClick={() => setModal("")}
            >
              ×
            </button>
            {modal === "new" && (
              <>
                <div className="eyebrow">PROJECT</div>
                <h2>新建本地项目</h2>
                <label>
                  项目名称
                  <input
                    autoFocus
                    value={projectName}
                    placeholder="例如：综合楼附房 · 建筑"
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                </label>
                <p className="muted">项目文件、修订、任务和会话保存在本机。</p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void guarded(createProject)}
                >
                  创建并打开图纸
                </button>
              </>
            )}
            {modal === "import" && (
              <>
                <div className="eyebrow">IMPORT DWG</div>
                <h2>打开工程图纸</h2>
                <p>每次导入生成独立文件版本；保留源文件指纹与解析缺口。</p>
                <label>
                  已登记样本
                  <select
                    aria-label="选择图纸样本"
                    value={fileRef}
                    onChange={(e) => setFileRef(e.target.value)}
                  >
                    <option value="">选择真实来件或受控基准</option>
                    {samples.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={compatible}
                    onChange={(e) => setCompatible(e.target.checked)}
                  />
                  作为兼容副本导入（转换来源与完整性仍待核验）
                </label>
                <div className="modal-actions">
                  <button
                    className="primary"
                    disabled={!fileRef || busy}
                    onClick={() => void guarded(() => importFile())}
                  >
                    {busy ? "正在解析…" : "导入所选图纸"}
                  </button>
                  <label className="button outline upload-button">
                    选择本机 DWG
                    <input
                      type="file"
                      accept=".dwg"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void guarded(() => upload(f));
                      }}
                    />
                  </label>
                </div>
                <small>
                  单文件最多 100MB。DWG
                  源解析完成后生成规范几何；未实现分段读取源 DWG。
                </small>
              </>
            )}
            {modal === "units" && (
              <>
                <div className="eyebrow">UNIT PROFILE</div>
                <h2>采用图纸源单位</h2>
                <p>
                  文件声明 INSUNITS={summary?.unitProfile.sourceInsUnits}
                  。采用比例会发布新修订，重新解释源几何；固定物理厚度保持不变。
                </p>
                <label>
                  1 源单位等于多少米
                  <select
                    value={unitScale}
                    onChange={(e) => setUnitScale(e.target.value)}
                  >
                    <option value="0.001">毫米 · 0.001m</option>
                    <option value="0.01">厘米 · 0.01m</option>
                    <option value="1">米 · 1m</option>
                    <option value="0.0254">英寸 · 0.0254m</option>
                    <option value="0.3048">英尺 · 0.3048m</option>
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void guarded(() =>
                      propose({
                        kind: "set_units",
                        metresPerDrawingUnit: Number(unitScale),
                        evidence: "用户在工作台明确采用源单位比例",
                      }),
                    )
                  }
                >
                  预览单位修订
                </button>
              </>
            )}
            {modal === "change" && candidate && (
              <>
                <div className="eyebrow">CHANGE PREVIEW</div>
                <h2>核对修改与试算</h2>
                <p>
                  <b>{candidate.operation.kind}</b> · {candidate.diff.length}{" "}
                  项差异
                </p>
                <p className="muted">
                  候选绑定基础修订 {candidate.baseRevision.slice(0, 16)}
                  ；应用时再次校验版本和内容指纹。
                </p>
                <pre>{JSON.stringify(candidate.operation, null, 2)}</pre>
                {candidate.trial && (
                  <div className="trial">
                    <b>
                      候选快照参数体积试算：{num(candidate.trial.knownSubtotal)}{" "}
                      m³
                    </b>
                    <span>
                      {candidate.trial.complete
                        ? "所选范围计算完整"
                        : "存在不可计算项，需继续补充依据"}
                    </span>
                    {candidate.trial.items
                      .filter((i: any) => i.reason)
                      .slice(0, 5)
                      .map((i: any) => (
                        <small key={i.id}>{i.reason}</small>
                      ))}
                  </div>
                )}
                <details>
                  <summary>查看前后差异</summary>
                  <pre>
                    {JSON.stringify(candidate.diff.slice(0, 3), null, 2)}
                  </pre>
                </details>
                <div className="modal-actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void guarded(applyChange)}
                  >
                    应用并发布新修订
                  </button>
                  <button
                    className="outline"
                    disabled={busy}
                    onClick={() => setModal("")}
                  >
                    保留候选，返回查看
                  </button>
                </div>
              </>
            )}
            {modal === "layers" && (
              <>
                <div className="eyebrow">LAYERS</div>
                <h2>图层可见性</h2>
                <p>
                  视图隐藏不会排除计量范围。文件原本关闭或冻结的图层仍保留其状态。
                </p>
                <div className="layer-list">
                  {[
                    ...new Set<string>(
                      preview?.occurrences.map((o: Occurrence) => o.layer) ??
                        [],
                    ),
                  ]
                    .sort()
                    .map((l) => (
                      <label key={l}>
                        <input
                          type="checkbox"
                          checked={!hidden.has(l)}
                          onChange={(e) =>
                            setHidden((old) => {
                              const n = new Set(old);
                              e.target.checked ? n.delete(l) : n.add(l);
                              return n;
                            })
                          }
                        />
                        {l}
                      </label>
                    ))}
                </div>
              </>
            )}
            {modal === "diagnostics" && (
              <ImportDiagnostics
                summary={summary}
                busy={busy}
                onReparse={() => void guarded(reparse)}
                onDiagnose={(groupId) => void guarded(() => diagnose(groupId))}
                onInspect={(group) => {
                  void guarded(async () => {
                    setTypeFilter(group.entityType);
                    setDiagnosticFilter(group.id);
                    setLayerFilter("");
                    setTextFilter("");
                    setQuery(
                      await call("dwg_query", {
                        ...ctx(),
                        filter: { space: "model", diagnosticGroupId: group.id },
                        pageSize: 50,
                      }),
                    );
                    setTab("objects");
                    setModal("");
                  });
                }}
              />
            )}
            {modal === "settings" && (
              <>
                <div className="eyebrow">PROJECT SETTINGS</div>
                <h2>资料发送配置</h2>
                <p>
                  AI 使用本机 Codex CLI 的登录与模型配置。账号凭据由宿主管理。
                </p>
                <label>
                  任务资料发送范围
                  <select
                    value={policy}
                    onChange={(e) => setPolicy(e.target.value)}
                  >
                    <option value="summary">摘要、明确参数及冻结上下文</option>
                    <option value="geometry">
                      允许工具发送详细属性与规范几何
                    </option>
                  </select>
                </label>
                <p className="muted">
                  当前宿主附件上传尚未实现；原始 DWG
                  文件发送不在此版本能力范围。实际工具响应与发送类别会持久记录。
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void guarded(async () => {
                      await api("policy", { projectId: pid, mode: policy });
                      await refresh(pid, false);
                      setModal("");
                    })
                  }
                >
                  保存项目配置
                </button>
                <hr />
                <h3>候选 DWG 与完整交付</h3>
                <p>
                  仅没有已知解析缺口或依赖的图纸开放候选另存。程序往返通过后仍需独立
                  CAD 核验。
                </p>
                <button
                  className="outline"
                  disabled={!project?.revision || busy}
                  onClick={() => void guarded(exportDwg)}
                >
                  导出待核验候选 DWG
                </button>
              </>
            )}
            {modal === "exports" && exported && (
              <>
                <div className="eyebrow">EXPORT ARTIFACTS</div>
                <h2>成果已生成</h2>
                <span className="status warn">完整交付尚未验收</span>
                <p>
                  {exported.mainDrawing?.edited === false
                    ? "source.dwg 为导入原件；修改与业务依据保存在报告中。"
                    : "candidate.dwg 为待核验候选图纸。"}
                  完整性、依赖与独立核验状态见清单。
                </p>
                <div className="download-list">
                  {exported.files.map((f: any) => (
                    <a
                      key={f.path}
                      href={`/api/file?projectId=${pid}&path=${encodeURIComponent(f.path)}`}
                      download
                    >
                      ↓ {f.name}
                    </a>
                  ))}
                </div>
                <pre>
                  {JSON.stringify(
                    {
                      contentRoundtrip: exported.contentRoundtrip,
                      independentCad: exported.independentCad,
                      dependencyMigration: exported.dependencyMigration,
                      displayResources: exported.displayResources,
                      completeDelivery: exported.completeDelivery,
                    },
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
            {modal === "compatibility" && (
              <Compatibility
                project={project}
                pid={pid}
                busy={busy}
                run={guarded}
                onDone={async () => {
                  await refresh(pid, false);
                  setModal("");
                }}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Compatibility({ project, pid, busy, run, onDone }: any) {
  const [original, setOriginal] = useState(""),
    [software, setSoftware] = useState(""),
    [version, setVersion] = useState(""),
    [target, setTarget] = useState("T3"),
    [evidence, setEvidence] = useState("");
  const current = project.drawings.at(-1);
  return (
    <>
      <div className="eyebrow">COMPATIBILITY COPY</div>
      <h2>登记转换来源</h2>
      <p>
        请提供能正确打开原图的软件所导出的兼容
        DWG，以及原图、外参和显示依赖。名称包含 _t3 不能证明完整转换。
      </p>
      <label>
        当前兼容版本
        <select value={current?.id} disabled>
          <option>{current?.name}</option>
        </select>
      </label>
      <label>
        同修订原始版本
        <select value={original} onChange={(e) => setOriginal(e.target.value)}>
          <option value="">缺少配对原图 · 保留未核验</option>
          {project.drawings
            .filter((d: any) => d.id !== current.id)
            .map((d: any) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </label>
      <div className="input-row">
        <label>
          转换软件
          <input
            value={software}
            onChange={(e) => setSoftware(e.target.value)}
          />
        </label>
        <label>
          软件版本
          <input value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
      </div>
      <label>
        目标兼容版本
        <input value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label>
        转换来源 / 选项 / 提供方依据
        <textarea
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={busy || !software || !version || !evidence}
        onClick={() =>
          void run(async () => {
            await api("conversion", {
              projectId: pid,
              originalVersion: original || null,
              compatibleVersion: current.id,
              software,
              softwareVersion: version,
              targetT3Version: target,
              exportOptions: evidence,
              evidence,
            });
            await onDone();
          })
        }
      >
        保存转换记录（保持未核验）
      </button>
    </>
  );
}
