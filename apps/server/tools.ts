import { z } from "zod";
import type { WorkflowService } from "./service.ts";
import {
  ContextSchema,
  FilterSchema,
  OperationSchema,
  SelectionRef,
} from "./schemas.ts";
import { dwgExport, resultExport } from "./exports.ts";
import { assert, id, now } from "./util.ts";
const context = ContextSchema.shape;
export function toolRegistry(service: WorkflowService) {
  const tool = (
    description: string,
    schema: z.AnyZodObject,
    run: (input: any) => any,
  ) => ({ description, schema, run });
  const op = z.string().min(1).max(200);
  return {
    project_list: tool("列出本地项目", z.object({}).strict(), () =>
      service.projects(),
    ),
    project_open: tool(
      "打开项目并恢复真实修订和任务",
      z.object({ projectId: z.string() }).strict(),
      (i) => service.open(i.projectId),
    ),
    dwg_capabilities: tool(
      "读取适配器和当前文件的逐项能力及未验证边界",
      ContextSchema.partial().strict(),
      (i) => service.capabilities(i),
    ),
    dwg_import: tool(
      "导入已登记样本或上传文件；返回持久任务，不等于解析完成",
      z
        .object({
          projectId: z.string(),
          fileRef: z.string(),
          operationId: op,
          role: z.enum(["original", "compatible_copy"]).default("original"),
        })
        .strict(),
      (i) => service.import(i),
    ),
    job_get: tool(
      "读取持久领域任务状态和冻结版本",
      z.object({ projectId: z.string(), jobId: z.string() }).strict(),
      (i) => service.getJob(i),
    ),
    dwg_reparse: tool(
      "用当前适配器重新解析同一不可变源文件及已应用补丁，保留身份和业务参数，发布新快照；旧结果失效",
      z.object({ ...context, operationId: op }).strict(),
      (i) => service.reparse(i),
    ),
    job_cancel: tool(
      "取消领域任务；不会撤销已发布修订",
      z.object({ projectId: z.string(), jobId: z.string() }).strict(),
      (i) => service.cancelJob(i),
    ),
    dwg_summary: tool(
      "实际实体统计、单位和导入缺口，源记录与实例数分开",
      ContextSchema.strict(),
      (i) => service.summary(i),
    ),
    dwg_layers: tool("读取快照的有效图层", ContextSchema.strict(), (i) =>
      service.layers(i),
    ),
    dwg_query: tool(
      "受控筛选和快照固定分页。rectangle 为源 WCS 坐标，曲线按声明容差精确复筛",
      z
        .object({
          ...context,
          filter: FilterSchema.optional(),
          pageSize: z.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
        })
        .strict(),
      (i) => service.query(i),
    ),
    dwg_get: tool(
      "读取一个实例的真实几何、属性与版本",
      z.object({ ...context, occurrenceId: z.string() }).strict(),
      (i) => service.get(i),
    ),
    selection_create: tool(
      "冻结全部查询结果或明确成员；不能把第一页当全部",
      z
        .object({
          ...context,
          queryId: z.string().optional(),
          filter: FilterSchema.optional(),
          members: z.array(z.string()).max(250000).optional(),
          evidence: z.string().optional(),
        })
        .strict(),
      (i) => service.selection(i),
    ),
    selection_get: tool(
      "读取并验证固定快照选择集",
      z.object({ ...context, selectionSet: SelectionRef }).strict(),
      (i) => {
        const s = service.catalog.open(i.projectId),
          c = s.context(i.workingRevision, i.geometrySnapshotId);
        return service.selected(s, c.snapshot, i.selectionSet);
      },
    ),
    dwg_check: tool(
      "执行单位、导入和闭合共面轮廓检查；未实现检查明确 not_run",
      z
        .object({
          ...context,
          selectionSet: SelectionRef.optional(),
          operationId: op,
        })
        .strict(),
      (i) => service.check(i),
    ),
    issue_list: tool(
      "读取固定快照的问题状态；未运行不是通过",
      ContextSchema.strict(),
      (i) => service.issues(i),
    ),
    change_propose: tool(
      "从已持久化用户指令生成不可变候选、差异与试算。intentId 必须来自工作台消息或界面事件",
      z
        .object({
          projectId: z.string(),
          operationId: op,
          baseRevision: z.string(),
          baseGeometrySnapshotId: z.string(),
          selectionSet: SelectionRef.optional(),
          operation: OperationSchema,
          intentId: z.string(),
        })
        .strict(),
      (i) => service.propose(i),
    ),
    change_preview: tool(
      "读取同一已生成候选差异",
      z.object({ projectId: z.string(), changeId: z.string() }).strict(),
      (i) => service.catalog.open(i.projectId).get("change", i.changeId),
    ),
    change_apply: tool(
      "以候选指纹、基础修订和 operationId 原子发布；重复调用不重复应用",
      z
        .object({
          projectId: z.string(),
          changeId: z.string(),
          operationId: op,
          baseRevision: z.string(),
          candidateFingerprint: z.string(),
        })
        .strict(),
      (i) => service.apply(i),
    ),
    change_revert: tool(
      "对最新且无冻结交付依赖的变更发布撤销修订",
      z
        .object({
          projectId: z.string(),
          changeId: z.string(),
          operationId: op,
        })
        .strict(),
      (i) => service.revert(i),
    ),
    takeoff_run: tool(
      "确定性计量；未知项保持 null，所有结果只覆盖冻结选择集",
      z
        .object({
          ...context,
          selectionSet: SelectionRef,
          quantityKind: z.enum([
            "length",
            "net_area",
            "parameter_volume",
            "entity_count",
            "business_count",
          ]),
          operationId: op,
        })
        .strict(),
      (i) => service.takeoff(i),
    ),
    takeoff_get: tool(
      "读取结果及当前有效性",
      z.object({ projectId: z.string(), resultVersion: z.string() }).strict(),
      (i) => {
        const s = service.catalog.open(i.projectId),
          r = s.get("takeoff", i.resultVersion);
        return {
          ...r,
          validity: r.workingRevision === s.current().id ? "valid" : "stale",
        };
      },
    ),
    result_export: tool(
      "交付原图、工程量 CSV、问题、项目补丁和依据；清楚标识未完整交付",
      z
        .object({
          ...context,
          resultVersion: z.string().optional(),
          operationId: op,
        })
        .strict(),
      (i) => resultExport(service, i),
    ),
    dwg_export: tool(
      "导出待独立 CAD 核验的候选 DWG；有未支持内容或依赖时拒绝完整重写",
      z
        .object({
          ...context,
          operationId: op,
          mode: z.enum(["candidate", "complete"]).default("complete"),
        })
        .strict(),
      (i) => dwgExport(service, i),
    ),
    export_verify: tool(
      "读取导出分项状态及指纹，不能由 Agent 自报通过独立 CAD 验收",
      z.object({ projectId: z.string(), exportId: z.string() }).strict(),
      (i) => service.catalog.open(i.projectId).get("export", i.exportId),
    ),
    viewer_open: tool("打开项目对应的交互视图", ContextSchema.strict(), (i) => {
      const c = service.context(i);
      return {
        url: `http://127.0.0.1:4310/?project=${i.projectId}`,
        workingRevision: c.revision.id,
        geometrySnapshotId: c.snapshot.id,
      };
    }),
    viewer_focus: tool(
      "持久发送固定快照选择集定位事件",
      z.object({ ...context, selectionSet: SelectionRef }).strict(),
      (i) => {
        const s = service.catalog.open(i.projectId),
          c = s.context(i.workingRevision, i.geometrySnapshotId);
        service.selected(s, c.snapshot, i.selectionSet);
        return s.event("viewer", {
          type: "focus",
          selectionSet: i.selectionSet,
          workingRevision: c.revision.id,
          geometrySnapshotId: c.snapshot.id,
        });
      },
    ),
    viewer_set_visibility: tool(
      "只改变视图可见性，不改变计量范围",
      z
        .object({
          ...context,
          layers: z.array(z.string()),
          visible: z.boolean(),
        })
        .strict(),
      (i) => {
        const s = service.catalog.open(i.projectId),
          c = s.context(i.workingRevision, i.geometrySnapshotId);
        return s.event("viewer", {
          type: "visibility",
          layers: i.layers,
          visible: i.visible,
          workingRevision: c.revision.id,
          geometrySnapshotId: c.snapshot.id,
        });
      },
    ),
  };
}
