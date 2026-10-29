import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import { WorkspaceCatalog } from "./workspace.ts";
import { WorkflowService } from "./service.ts";
import { toolRegistry } from "./tools.ts";
import { ProjectStore } from "./store.ts";
import { assert, canonical, hash, id, within } from "./util.ts";
import { modelError, modelOutput } from "./model-output.ts";
import { ReviewService } from "./reviews.ts";
import { CoverageService, CoverageScopeSchema } from "./coverage.ts";
import { ScopeTakeoffService } from "./scope-takeoff.ts";
import { FilterSchema } from "./schemas.ts";

export interface WorkspaceTool {
  description: string;
  schema: z.AnyZodObject;
  run: (input: any) => any;
}
export class WorkspaceDomain {
  catalog: WorkspaceCatalog;
  service: WorkflowService;
  tools: Record<string, WorkspaceTool> = {};
  auditStore: ProjectStore;
  reviews: ReviewService;
  coverage: CoverageService;
  scopeTakeoff: ScopeTakeoffService;
  constructor(
    root: string,
    public instanceId: string,
  ) {
    this.catalog = new WorkspaceCatalog(root);
    this.service = new WorkflowService(this.catalog, instanceId);
    this.service.outputDirectory = within(
      this.catalog.workspaceRoot,
      this.catalog.manifest.config.outputDirectory,
    );
    this.auditStore = new ProjectStore(this.catalog.root, {
      db: this.catalog.db,
      namespace: "workspace:",
    });
    // The workspace audit store has policy metadata but never a current revision.
    this.auditStore.put(
      "project",
      { id: "meta", dataPolicy: this.catalog.policy() },
      "meta",
    );
    this.coverage = new CoverageService(this);
    this.scopeTakeoff = new ScopeTakeoffService(this);
    this.reviews = new ReviewService(this);
    this.tools = workspaceToolDefinitions(this);
  }
  status() {
    return {
      ...this.catalog.manifest,
      root: this.catalog.workspaceRoot,
      instanceId: this.instanceId,
      drawings: this.tools.drawing_list.run({}),
      pendingJobs: this.catalog.list().flatMap((d) =>
        this.catalog
          .open(d.projectId)
          .all<any>("job")
          .filter((j) => ["queued", "running"].includes(j.status))
          .map((j) => ({
            drawingId: d.projectId,
            jobId: j.id,
            status: j.status,
          })),
      ),
    };
  }
  discover() {
    const root = this.catalog.workspaceRoot,
      files: any[] = [];
    const excluded = new Set([
      ".bwc",
      ".git",
      "node_modules",
      ".venv",
      ".cache",
      "dist",
      "bin",
      "obj",
    ]);
    const output = resolve(root, this.catalog.manifest.config.outputDirectory);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (excluded.has(entry.name) || file === output) continue;
        if (entry.isDirectory()) walk(file);
        else if (
          (entry.isFile() || entry.isSymbolicLink()) &&
          extname(file).toLowerCase() === ".dwg"
        ) {
          const real = realpathSync(file);
          if (!real.startsWith(root + sep) || !statSync(real).isFile())
            continue;
          files.push({
            path: relative(root, file),
            bytes: statSync(real).size,
            sha256: hash(readFileSync(real)),
          });
        }
      }
    };
    walk(root);
    return { files, count: files.length };
  }
  import(input: any) {
    const root = this.catalog.workspaceRoot;
    const source = realpathSync(
      isAbsolute(input.path) ? input.path : resolve(root, input.path),
    );
    assert(
      source.startsWith(root + sep) || input.externalImport,
      "EXTERNAL_IMPORT_REQUIRED",
      "工程外文件须显式导入复制",
    );
    assert(
      statSync(source).isFile() &&
        statSync(source).size <= 100 * 1024 * 1024 &&
        extname(source).toLowerCase() === ".dwg",
      "INVALID_DWG",
      "请选择不超过100MB的 DWG 文件",
    );
    const bytes = readFileSync(source),
      sha256 = hash(bytes);
    assert(
      /^AC10\d\d$/.test(bytes.subarray(0, 6).toString()),
      "INVALID_DWG",
      "DWG 文件头无效",
    );
    const fingerprint = hash(
      canonical({
        path: source.startsWith(root + sep) ? relative(root, source) : source,
        sha256,
        drawingId: input.drawingId ?? null,
        role: input.role,
      }),
    );
    let operation: any;
    if (this.auditStore.has("import_operation", input.operationId)) {
      operation = this.auditStore.get("import_operation", input.operationId);
      assert(
        operation.fingerprint === fingerprint,
        "OPERATION_ID_CONFLICT",
        "操作 ID 已用于不同请求",
      );
      const prior = this.catalog
        .open(operation.drawingId)
        .all<any>("job")
        .find((j) => j.operationId === input.operationId);
      if (prior)
        return {
          drawingId: operation.drawingId,
          ...this.service.publicJob(prior),
        };
    } else {
      const drawingId =
        input.drawingId ?? this.catalog.create(basename(source)).projectId;
      this.catalog.open(drawingId);
      operation = { id: input.operationId, drawingId, fingerprint };
      this.auditStore.put("import_operation", operation);
    }
    const store = this.catalog.open(operation.drawingId);
    const fileRef = `upload_${sha256}`;
    const local = `sources/${sha256}/${basename(source)}`;
    mkdirSync(join(store.path, "sources", sha256), { recursive: true });
    const dest = within(store.path, local);
    if (!existsSync(dest)) copyFileSync(source, dest);
    assert(
      hash(readFileSync(dest)) === sha256,
      "ARTIFACT_CORRUPT",
      "已保存输入的指纹不匹配",
    );
    store.put("upload", {
      id: fileRef,
      name: basename(source),
      path: local,
      sha256,
      sourcePath: source.startsWith(root + sep) ? relative(root, source) : null,
    });
    return {
      drawingId: operation.drawingId,
      ...this.service.import({
        projectId: operation.drawingId,
        fileRef,
        operationId: input.operationId,
        role: input.role,
      }),
    };
  }
  async call(name: string, input: unknown) {
    this.auditStore.put(
      "project",
      { id: "meta", dataPolicy: this.catalog.policy() },
      "meta",
    );
    let store = this.auditStore;
    try {
      const tool = this.tools[name];
      assert(tool, "UNKNOWN_TOOL", "工作目录工具不存在");
      const parsed = tool.schema.parse(input);
      assert(
        parsed.workspaceId === this.catalog.manifest.workspaceId,
        "WORKSPACE_MISMATCH",
        "工作目录标识不匹配",
      );
      if (parsed.drawingId) store = this.catalog.open(parsed.drawingId);
      const out = await tool.run(parsed);
      return modelOutput(store, name, out, {
        instanceId: this.instanceId,
        workspaceId: parsed.workspaceId,
        drawingId: parsed.drawingId,
        geometrySnapshotId: parsed.geometrySnapshotId,
      });
    } catch (error) {
      console.error("domain", name, error);
      return modelOutput(store, name, modelError(error), {
        instanceId: this.instanceId,
      });
    }
  }
  close() {
    this.service.close();
  }
}

export function workspaceToolDefinitions(
  domain?: WorkspaceDomain,
): Record<string, WorkspaceTool> {
  const ws = { workspaceId: z.string() };
  const tool = (
    description: string,
    schema: z.AnyZodObject,
    run: (input: any) => any,
  ) => ({ description, schema, run });
  const tools: Record<string, WorkspaceTool> = {
    workspace_status: tool(
      "读取工作目录、多图版本和运行时状态",
      z.object(ws).strict(),
      () => domain!.status(),
    ),
    drawing_discover: tool(
      "扫描工作目录内 DWG；跳过状态、成果和依赖目录",
      z.object(ws).strict(),
      () => domain!.discover(),
    ),
    drawing_list: tool(
      "列出逻辑图纸及各自独立的当前修订",
      z.object(ws).strict(),
      () =>
        domain!.catalog.list().map((p) => ({
          drawingId: p.projectId,
          name: p.name,
          currentRevisionId: p.currentRevision,
        })),
    ),
    drawing_import: tool(
      "复制本地 DWG 为不可变来源并启动解析；工程外路径须显式 externalImport。相同 operationId 不重复执行",
      z
        .object({
          ...ws,
          path: z.string(),
          drawingId: z.string().optional(),
          operationId: z.string().min(1).max(200),
          externalImport: z.boolean().default(false),
          role: z.enum(["original", "compatible_copy"]).default("original"),
        })
        .strict(),
      (i) => domain!.import(i),
    ),
    input_manifest_create: tool(
      "冻结每张参与图纸的修订与快照；不随当前指针变化",
      z
        .object({
          ...ws,
          members: z
            .array(
              z
                .object({
                  drawingId: z.string(),
                  revisionId: z.string(),
                  snapshotId: z.string(),
                })
                .strict(),
            )
            .min(1)
            .max(1000),
        })
        .strict(),
      (i) => domain!.catalog.freeze(i.members),
    ),
    input_manifest_get: tool(
      "读取冻结的跨图输入清单",
      z.object({ ...ws, manifestId: z.string() }).strict(),
      (i) => domain!.catalog.inputManifest(i.manifestId),
    ),
    viewer_open: tool(
      "生成当前图纸或审阅批次的30分钟本地审阅链接",
      z
        .object({
          ...ws,
          drawingId: z.string(),
          batchId: z.string().optional(),
          coverageId: z.string().optional(),
        })
        .strict(),
      () => {
        throw new Error("viewer requires runtime");
      },
    ),
    scope_takeoff_run: tool(
      "在独立冻结覆盖范围中逐图计算已确认目标构件，保留未计算项；覆盖未知时仅提供小计",
      z
        .object({
          ...ws,
          coverageId: z.string(),
          quantityKind: z.enum([
            "business_count",
            "length",
            "net_area",
            "parameter_volume",
          ]),
          operationId: z.string().min(1).max(200),
        })
        .strict(),
      (i) => domain!.scopeTakeoff.run(i),
    ),
    scope_takeoff_get: tool(
      "读取跨图小计、计算齐备性和独立的范围完成状态；绑定覆盖审阅版本",
      z.object({ ...ws, scopeResultId: z.string() }).strict(),
      (i) => domain!.scopeTakeoff.get(i.scopeResultId),
    ),
    scope_result_export: tool(
      "生成冻结多图工程量 CSV、覆盖审阅证据和来源报告；返回可用 job_get 轮询的持久任务",
      z
        .object({
          ...ws,
          scopeResultId: z.string(),
          operationId: z.string().min(1).max(200),
        })
        .strict(),
      (i) => domain!.scopeTakeoff.export(i),
    ),
    scope_coverage_prepare: tool(
      "基于冻结输入清单独立冻结专业、类别、楼层/视图与来源范围；不由候选列表反推覆盖",
      z
        .object({ ...ws, manifestId: z.string(), scope: CoverageScopeSchema })
        .strict(),
      (i) => domain!.coverage.prepare(i.manifestId, i.scope),
    ),
    scope_coverage_status: tool(
      "分页查询独立覆盖审阅、未归属来源、排除与解析缺口；候选确认不等于覆盖完成",
      z
        .object({
          ...ws,
          coverageId: z.string(),
          drawingId: z.string().optional(),
          status: z
            .enum(["assigned", "unassigned", "excluded", "duplicate"])
            .optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .strict(),
      (i) => domain!.coverage.status(i.coverageId, i),
    ),
    review_prepare: tool(
      "冻结当前图纸、候选版本与内容指纹；确认通过本地 Web 提交",
      z.object({ ...ws, drawingId: z.string() }).strict(),
      (i) => domain!.reviews.prepare(i.drawingId),
    ),
    review_status: tool(
      "查询审阅批次及是否失效",
      z.object({ ...ws, drawingId: z.string(), batchId: z.string() }).strict(),
      (i) => domain!.reviews.status(i.drawingId, i.batchId),
    ),
    data_policy_get: tool(
      "读取版本化资料策略及快照授权；扩大授权须在本地人工入口设置",
      z.object(ws).strict(),
      () => domain!.catalog.policy(),
    ),
  };
  const allowed = new Set([
    "dwg_capabilities",
    "dwg_summary",
    "dwg_diagnostics",
    "dwg_layers",
    "dwg_query",
    "dwg_get",
    "selection_create",
    "selection_get",
    "dwg_check",
    "issue_list",
    "takeoff_run",
    "takeoff_get",
    "job_get",
    "job_cancel",
    "result_export",
    "export_verify",
    "component_recognize",
    "component_suggest",
    "component_list",
    "component_takeoff",
  ]);
  for (const [name, legacy] of Object.entries(
    toolRegistry(domain?.service ?? ({} as WorkflowService)),
  )) {
    if (!allowed.has(name)) continue;
    let schema = (legacy.schema as z.AnyZodObject)
      .omit({ projectId: true })
      .extend({ ...ws, drawingId: z.string() })
      .strict();
    if (["dwg_query", "selection_create"].includes(name))
      schema = schema.extend({
        filter: FilterSchema.extend({
          rectangle: z.array(z.number().finite()).length(4).optional(),
        }).optional(),
      });
    tools[name] = tool(legacy.description, schema, (i) => {
      const { workspaceId, drawingId, ...rest } = i;
      domain!.catalog.open(drawingId);
      // Domain schemas still enforce coordinate ordering and original constraints.
      return legacy.run(legacy.schema.parse({ ...rest, projectId: drawingId }));
    });
  }

  return tools;
}
