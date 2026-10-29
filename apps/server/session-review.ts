import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceDomain } from "./workspace-domain.ts";
import { componentCategories } from "../shared/component-categories.ts";
import { ComponentReviewSchema } from "./components.ts";
import { assert, id, now } from "./util.ts";
import { modelOutput } from "./model-output.ts";

// Only the MCP adapter may resolve these tickets using the host's elicitation result.
// Neither tickets nor acceptance/content fields are exposed as model tool arguments.
export const SessionReviewInput = z
  .object({
    workspaceId: z.string(),
    drawingId: z.string(),
    action: z.enum(["units", "component", "policy", "coverage"]),
    componentId: z.string().optional(),
    coverageId: z.string().optional(),
  })
  .strict();

const text = (title: string, maxLength = 2000, value?: string) => ({
  type: "string" as const,
  title,
  maxLength,
  ...(value === undefined ? {} : { default: value }),
});
const choice = (title: string, values: readonly string[], value?: string) => ({
  ...text(title),
  enum: [...values],
  ...(value ? { default: value } : {}),
});
type Ticket = {
  token: string;
  input: z.infer<typeof SessionReviewInput>;
  expiresAt: number;
  policyId: string;
  componentVersion?: number;
  coverageVersion?: number;
  coverageFingerprint?: string;
};

export class SessionReviewService {
  private tickets = new Map<string, Ticket>();
  constructor(private domain: WorkspaceDomain) {}
  prepare(input: unknown) {
    const parsed = SessionReviewInput.parse(input);
    assert(
      parsed.workspaceId === this.domain.catalog.manifest.workspaceId,
      "WORKSPACE_MISMATCH",
      "工作目录标识不匹配",
    );
    assert(
      (parsed.action === "component") === !!parsed.componentId &&
        (parsed.action === "coverage") === !!parsed.coverageId,
      "INVALID_REQUEST",
      "请只提供当前操作所需的对象标识",
    );
    for (const [key, value] of this.tickets)
      if (value.expiresAt <= Date.now()) this.discard(key);
    assert(this.tickets.size < 100, "REVIEW_BUSY", "待填写表单过多");
    const opened = this.domain.reviews.open(
      parsed.drawingId,
      undefined,
      parsed.coverageId,
    );
    try {
      const s = this.domain.catalog.open(parsed.drawingId);
      const ticket: Ticket = {
        token: opened.token,
        input: parsed,
        expiresAt: Date.now() + 10 * 60 * 1000,
        policyId: this.domain.catalog.policy().id,
      };
      const properties: NonNullable<
        ElicitRequestFormParams["requestedSchema"]
      >["properties"] = {};
      let required: string[] = [],
        description = "";
      if (parsed.action === "units") {
        description =
          "采用图纸单位。这将创建新修订，并使依赖旧单位的计算失效。请按图签或已知尺寸判断，文件声明单位仅供参考。";
        properties.unit = choice("图纸单位", [
          "毫米 mm",
          "厘米 cm",
          "米 m",
          "自定义",
        ]);
        properties.customScale = {
          type: "number",
          title: "自定义时填写：每图纸单位对应的米数",
          minimum: Number.MIN_VALUE,
          maximum: 1e9,
        };
        properties.evidence = {
          ...text("采用依据（图签、标注尺寸等）"),
          minLength: 1,
        };
        required = ["unit", "evidence"];
      } else if (parsed.action === "component") {
        const c = s.get("component", parsed.componentId!);
        assert(
          opened.batch.componentVersions[c.id] === c.version,
          "REVIEW_MISMATCH",
          "候选不属于当前快照",
        );
        ticket.componentVersion = c.version;
        description = `核对候选 ${c.id}（${c.label}），版本 ${c.version}，来源实例 ${c.members.length} 个。接受后保存以下属性和核对状态；未看清几何时请选择 pending，或取消后打开审阅页。`;
        properties.status = choice(
          "核对结论：confirmed 已确认；rejected 已拒绝；pending 待核对",
          ["confirmed", "rejected", "pending"],
          "pending",
        );
        properties.category = choice(
          "构件类别",
          componentCategories,
          c.category,
        );
        properties.label = { ...text("名称", 100, c.label), minLength: 1 };
        properties.floor = text("楼层（未知可留空）", 100, c.floor ?? "");
        properties.material = text("材料（未知可留空）", 100, c.material ?? "");
        properties.thicknessMm = {
          type: "number",
          title: "厚度（毫米，选填）",
          minimum: Number.MIN_VALUE,
          maximum: 100000,
          ...(c.thicknessMm ? { default: c.thicknessMm } : {}),
        };
        properties.evidence = { ...text("核对依据"), minLength: 1 };
        required = [
          "status",
          "category",
          "label",
          "floor",
          "material",
          "evidence",
        ];
      } else if (parsed.action === "policy") {
        description =
          "选择发送给 Codex 配置的模型服务方的数据范围。summary 仅发送摘要；geometry 允许发送当前图纸快照的详细几何资料。授权记录会保存在本地。";
        properties.mode = choice("数据发送范围", ["summary", "geometry"]);
        required = ["mode"];
      } else {
        const coverage = this.domain.coverage.state(parsed.coverageId!);
        ticket.coverageVersion = coverage.record.version;
        ticket.coverageFingerprint = coverage.record.fingerprint;
        assert(
          JSON.stringify(coverage.record.scope).length <= 6000,
          "REVIEW_FORM_TOO_LARGE",
          "覆盖范围过大，请使用本地审阅页核对",
        );
        description = `独立覆盖审阅 ${parsed.coverageId}，版本 ${ticket.coverageVersion}。范围：${JSON.stringify(coverage.record.scope)}。当前${coverage.canReviewComplete ? "允许提交完整结论" : "存在未决项，仅允许记录 incomplete"}。应对照原图或参考清单判断，不能用已识别候选代替覆盖核对。`;
        properties.conclusion = choice(
          "范围结论",
          coverage.canReviewComplete
            ? ["incomplete", "reviewed_complete"]
            : ["incomplete"],
        );
        properties.evidence = { ...text("独立核对依据", 4000), minLength: 1 };
        properties.referenceKind = choice("参考资料类型", [
          "source_drawing",
          "reference_inventory",
        ]);
        properties.locator = {
          ...text("原图页码／区域或参考清单位置"),
          minLength: 1,
        };
        required = ["conclusion", "evidence", "referenceKind", "locator"];
      }
      const ticketId = randomBytes(24).toString("hex");
      this.tickets.set(ticketId, ticket);
      // Flat primitive fields are compatible with Codex's form elicitation schema.
      return {
        ticketId,
        form: modelOutput(
          s,
          "review_in_session_form",
          {
            mode: "form" as const,
            message: `筑材智算 · ${s.meta().name ?? parsed.drawingId}\n${description}\n工作目录：${this.domain.catalog.workspaceRoot}\n修订：${opened.batch.workingRevision}\n快照：${opened.batch.geometrySnapshotId}\n核对指纹：${opened.batch.fingerprint}\n接受才会保存；拒绝或取消不会修改业务数据。`,
            requestedSchema: { type: "object" as const, properties, required },
          },
          {
            drawingId: parsed.drawingId,
            geometrySnapshotId: opened.batch.geometrySnapshotId,
            instanceId: this.domain.instanceId,
          },
        ) as ElicitRequestFormParams,
      };
    } catch (error) {
      this.domain.reviews.sessions.delete(opened.token);
      throw error;
    }
  }
  discard(ticketId: string) {
    const ticket = this.tickets.get(ticketId);
    if (ticket) this.domain.reviews.sessions.delete(ticket.token);
    this.tickets.delete(ticketId);
  }
  async resolve(input: unknown) {
    const parsed = z
      .object({
        ticketId: z.string(),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.record(z.unknown()).optional(),
      })
      .strict()
      .parse(input);
    const ticket = this.tickets.get(parsed.ticketId);
    if (ticket && ticket.expiresAt <= Date.now()) this.discard(parsed.ticketId);
    assert(
      ticket && ticket.expiresAt > Date.now(),
      "REVIEW_EXPIRED",
      "表单已过期，请重新发起",
    );
    this.tickets.delete(parsed.ticketId); // one attempt, including failed validation
    const { drawingId, action, componentId, coverageId } = ticket.input;
    const s = this.domain.catalog.open(drawingId);
    try {
      if (parsed.action !== "accept")
        return { saved: false, action: parsed.action };
      const batch = this.domain.reviews.session(ticket.token).batchId;
      const state = this.domain.reviews.status(drawingId, batch);
      assert(!state.stale, "REVIEW_STALE", "表单版本已变化，请重新发起");
      const content = parsed.content;
      let result: unknown;
      if (action === "units") {
        const fields = z
          .object({
            unit: z.enum(["毫米 mm", "厘米 cm", "米 m", "自定义"]),
            customScale: z.number().finite().positive().max(1e9).optional(),
            evidence: z.string().trim().min(1).max(2000),
          })
          .strict()
          .parse(content);
        const scale = { "毫米 mm": 0.001, "厘米 cm": 0.01, "米 m": 1 };
        const value =
          fields.unit === "自定义" ? fields.customScale : scale[fields.unit];
        assert(value, "INVALID_REQUEST", "自定义单位必须填写比例");
        await this.domain.reviews.adoptUnits(
          ticket.token,
          {
            fingerprint: state.fingerprint,
            metresPerDrawingUnit: value,
            evidence: fields.evidence,
          },
          "mcp_elicitation",
        );
        result = {
          unitsConfirmed: true,
          metresPerDrawingUnit: value,
          workingRevision: s.current().id,
        };
      } else if (action === "component") {
        const fields = ComponentReviewSchema.omit({
          projectId: true,
          workingRevision: true,
          geometrySnapshotId: true,
          componentId: true,
          expectedVersion: true,
        }).parse(content);
        result = await this.domain.reviews.submit(
          ticket.token,
          {
            fingerprint: state.fingerprint,
            reviews: [
              {
                ...fields,
                componentId,
                expectedVersion: ticket.componentVersion,
              },
            ],
          },
          "mcp_elicitation",
        );
      } else if (action === "policy") {
        assert(
          this.domain.catalog.policy().id === ticket.policyId,
          "REVIEW_STALE",
          "数据授权已变化，请重新发起",
        );
        result = this.domain.reviews.setPolicy(
          ticket.token,
          content,
          "mcp_elicitation",
        );
      } else {
        const fields = z
          .object({
            conclusion: z.enum(["incomplete", "reviewed_complete"]),
            evidence: z.string().trim().min(1).max(4000),
            referenceKind: z.enum(["source_drawing", "reference_inventory"]),
            locator: z.string().trim().min(1).max(2000),
          })
          .strict()
          .parse(content);
        result = this.domain.coverage.review(
          coverageId!,
          {
            expectedVersion: ticket.coverageVersion,
            fingerprint: ticket.coverageFingerprint,
            conclusion: fields.conclusion,
            evidence: fields.evidence,
            reference: { kind: fields.referenceKind, locator: fields.locator },
          },
          "mcp_elicitation",
        );
      }
      s.put("session_review_event", {
        id: id("sr"),
        source: "mcp_elicitation",
        action,
        componentId,
        coverageId,
        batchId: batch,
        fingerprint: state.fingerprint,
        at: now(),
      });
      return modelOutput(
        s,
        "review_in_session",
        { saved: true, action, result },
        {
          drawingId,
          geometrySnapshotId: state.geometrySnapshotId,
          instanceId: this.domain.instanceId,
        },
      );
    } finally {
      this.domain.reviews.sessions.delete(ticket.token);
    }
  }
}
