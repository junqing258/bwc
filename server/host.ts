import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { JsonRpcProcess } from "./rpc.ts";
import type { WorkflowService } from "./service.ts";
import type { Intent, Operation } from "./types.ts";
import { assert, canonical, DomainError, id, now } from "./util.ts";
import { ROOT } from "./workers.ts";
export interface Session {
  id: string;
  projectId: string;
  host: "codex";
  hostVersion: string;
  model?: string;
  hostSessionId: string | null;
  status: string;
  createdAt: string;
}
export interface Turn {
  id: string;
  sessionId: string;
  clientMessageId: string;
  messageId: string;
  intentId: string;
  hostTurnId: string | null;
  status: string;
  text: string;
  response: string;
  context: any;
  createdAt: string;
}
export class HostBridge {
  closing = false;
  processes = new Set<JsonRpcProcess>();
  clients = new Map<string, JsonRpcProcess>();
  connecting = new Map<string, Promise<JsonRpcProcess>>();
  active = new Map<string, string>();
  constructor(
    public service: WorkflowService,
    public url: string,
    public token: string,
  ) {
    for (const p of service.projects()) {
      const s = service.catalog.open(p.projectId);
      for (const turn of s.all<Turn>("turn"))
        if (["accepted", "sending", "running"].includes(turn.status)) {
          turn.status = "delivery_uncertain";
          s.put("turn", turn);
          s.event(`session:${turn.sessionId}`, {
            type: "recovery_required",
            turnId: turn.id,
            code: "MESSAGE_DELIVERY_UNCERTAIN",
          });
        }
    }
  }
  create(input: any) {
    const s = this.service.catalog.open(input.projectId);
    const session: Session = {
      id: id("as"),
      projectId: input.projectId,
      host: "codex",
      hostVersion: "local CLI (protocol v2)",
      hostSessionId: null,
      status: "created",
      createdAt: now(),
    };
    s.put("session", session);
    return session;
  }
  read(input: any) {
    const s = this.service.catalog.open(input.projectId),
      session = s.get<Session>("session", input.sessionId);
    assert(
      session.projectId === input.projectId,
      "SESSION_PROJECT_MISMATCH",
      "会话属于其他项目",
    );
    return {
      ...session,
      turns: s.all<Turn>("turn").filter((t) => t.sessionId === session.id),
      events: s.events(`session:${session.id}`, input.after ?? 0),
    };
  }
  async connect(session: Session): Promise<JsonRpcProcess> {
    if (this.clients.has(session.id)) return this.clients.get(session.id)!;
    if (this.connecting.has(session.id))
      return this.connecting.get(session.id)!;
    const task = (async () => {
      const s = this.service.catalog.open(session.projectId),
        cwd = join(s.path, "agent-workspace");
      mkdirSync(join(cwd, ".agents/skills/dwg-workflow"), { recursive: true });
      copyFileSync(
        join(ROOT, "skills/dwg-workflow/SKILL.md"),
        join(cwd, ".agents/skills/dwg-workflow/SKILL.md"),
      );
      writeFileSync(
        join(cwd, "AGENTS.md"),
        "Use the dwg-workflow skill and only the bwc MCP domain tools. Do not edit project files, run shell commands, use other connectors, or send messages outside this workbench. All domain writes require a persisted intent and exact frozen context.\n",
      );
      const mcp = {
        bwc: {
          default_tools_approval_mode: "auto",
          command: process.execPath,
          args: [
            "--import",
            import.meta.resolve("tsx"),
            join(ROOT, "server/mcp.ts"),
          ],
          env: {
            BWC_URL: this.url,
            BWC_SERVICE_TOKEN: this.token,
            BWC_PROJECT_ID: session.projectId,
            BWC_SESSION_ID: session.id,
          },
        },
      };
      const client = new JsonRpcProcess(
        process.env.BWC_CODEX_BIN ?? "codex",
        ["app-server", "-c", `mcp_servers=${toToml(mcp)}`],
        {
          cwd,
          onNotification: (m, p) => this.notification(session, m, p),
          onRequest: async (m, p) => {
            s.event(`session:${session.id}`, {
              type: "host_interaction",
              method: m,
              request: p,
            });
            throw new Error("Host interaction requires supported UI");
          },
          onExit: () => {
            this.processes.delete(client);
            if (this.closing) return;
            this.clients.delete(session.id);
            const tid = this.active.get(session.id);
            if (tid && s.has("turn", tid)) {
              const t = s.get<Turn>("turn", tid);
              if (["sending", "running"].includes(t.status)) {
                t.status = "delivery_uncertain";
                s.put("turn", t);
                s.event(`session:${session.id}`, {
                  type: "recovery_required",
                  turnId: t.id,
                  code: "HOST_UNAVAILABLE",
                });
              }
            }
            session.status = "unavailable";
            s.put("session", session);
            this.active.delete(session.id);
          },
        },
      );
      this.processes.add(client);
      try {
        const init = await client.request("initialize", {
          clientInfo: {
            name: "bwc_dwg_workbench",
            title: "筑材智算",
            version: "0.1.0",
          },
        });
        client.notify("initialized");
        session.hostVersion =
          init.userAgent ?? init.serverInfo?.version ?? "codex local";
        const params = {
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          config: { mcp_servers: mcp },
          developerInstructions: readFileSync(
            join(ROOT, "skills/dwg-workflow/SKILL.md"),
            "utf8",
          ),
        };
        let r: any;
        if (session.hostSessionId)
          r = await client.request(
            "thread/resume",
            { ...params, threadId: session.hostSessionId, excludeTurns: true },
            60000,
          );
        else r = await client.request("thread/start", params, 60000);
        session.hostSessionId = r.thread.id;
        session.model = r.model ?? r.thread.model ?? "host_default_unreported";
        const inventory = await client.request(
          "mcpServerStatus/list",
          { threadId: session.hostSessionId, serverName: "bwc" },
          60000,
        );
        s.event(`session:${session.id}`, {
          type: "host_setup",
          method: "mcpServerStatus/list",
          inventory,
        });
        session.status = "ready";
        s.put("session", session);
        this.clients.set(session.id, client);
        return client;
      } catch (e) {
        client.stop();
        throw e;
      }
    })();
    this.connecting.set(session.id, task);
    try {
      return await task;
    } finally {
      this.connecting.delete(session.id);
    }
  }
  submit(input: any) {
    const s = this.service.catalog.open(input.projectId),
      session = s.get<Session>("session", input.sessionId);
    assert(
      session.projectId === input.projectId,
      "SESSION_PROJECT_MISMATCH",
      "会话属于其他项目",
    );
    const previous = s
      .all<Turn>("turn")
      .find(
        (t) =>
          t.sessionId === session.id &&
          t.clientMessageId === input.clientMessageId,
      );
    if (previous) {
      assert(
        previous.text === input.text &&
          canonical(previous.context) === canonical(input.context),
        "MESSAGE_ID_CONFLICT",
        "消息 ID 已用于其他内容",
      );
      return previous;
    }
    assert(
      !s
        .all<Turn>("turn")
        .some(
          (t) =>
            t.sessionId === session.id &&
            ["accepted", "sending", "running", "delivery_uncertain"].includes(
              t.status,
            ),
        ),
      "SESSION_BUSY",
      "会话有执行中或待对账的轮次",
    );
    const { revision, snapshot } = s.context(
      input.context.workingRevision,
      input.context.geometrySnapshotId,
    );
    assert(
      revision.id === s.current().id,
      "REVISION_CONFLICT",
      "会话上下文过期",
    );
    assert(
      input.context.dataPolicyVersion === s.meta().dataPolicy.id,
      "DATA_POLICY_CHANGED",
      "资料发送配置已变化，请刷新",
    );
    if (input.context.selectionSet)
      this.service.selected(s, snapshot, input.context.selectionSet);
    const tid = id("turn"),
      mid = id("msg"),
      intentId = id("intent");
    const operation = parseMessageOperation(input.text);
    const intent: Intent = {
      id: intentId,
      origin: "message",
      text: input.text,
      workingRevision: revision.id,
      selectionSet: input.context.selectionSet,
      operation: operation ?? undefined,
      messageId: mid,
      createdAt: now(),
    };
    const turn: Turn = {
      id: tid,
      sessionId: session.id,
      clientMessageId: input.clientMessageId,
      messageId: mid,
      intentId,
      hostTurnId: null,
      status: "accepted",
      text: input.text,
      response: "",
      context: input.context,
      createdAt: now(),
    };
    s.transaction(() => {
      s.put("intent", intent);
      s.put("turn", turn);
      s.event(`session:${session.id}`, {
        type: "message_accepted",
        turnId: tid,
        messageId: mid,
        context: turn.context,
      });
    });
    void this.dispatch(session, turn);
    return turn;
  }
  async dispatch(session: Session, turn: Turn) {
    const s = this.service.catalog.open(session.projectId);
    try {
      const client = await this.connect(session);
      this.active.set(session.id, turn.id);
      turn = s.get("turn", turn.id);
      if (turn.status !== "accepted") return;
      turn.status = "sending";
      s.put("turn", turn);
      const policy = s.meta().dataPolicy;
      const text = `用户原始消息：${turn.text}\n冻结上下文（不得替换为当前选择）：${JSON.stringify({ projectId: session.projectId, ...turn.context, messageId: turn.messageId, intentId: turn.intentId, operationIdPrefix: turn.id })}\n资料发送配置：${policy.mode}；仅用 bwc MCP。调用 dwg_capabilities、dwg_summary 和任务需要的实际工具。不要读取文件或使用终端/其他工具。修改仅可使用服务器保存的 intentId；不支持的指令先说明缺项。任务状态和真实输出以领域工具为准。`;
      s.put("data_send", {
        id: id("send"),
        sessionId: session.id,
        turnId: turn.id,
        policyVersion: policy.id,
        categories: ["user_message", "frozen_context"],
        workingRevision: turn.context.workingRevision,
        geometrySnapshotId: turn.context.geometrySnapshotId,
        at: now(),
      });
      const r = await client.request(
        "turn/start",
        {
          threadId: session.hostSessionId,
          clientUserMessageId: turn.clientMessageId,
          input: [{ type: "text", text }],
        },
        60000,
      );
      const latest = s.get<Turn>("turn", turn.id);
      latest.hostTurnId = r.turn.id;
      if (latest.status === "sending") latest.status = "running";
      s.put("turn", latest);
      s.event(`session:${session.id}`, {
        type: "turn_started",
        turnId: turn.id,
        hostTurnId: latest.hostTurnId,
      });
    } catch (e) {
      if (this.closing) return;
      const latest = s.get<Turn>("turn", turn.id);
      latest.status =
        latest.status === "sending" ? "delivery_uncertain" : "failed";
      s.put("turn", latest);
      s.event(`session:${session.id}`, {
        type: "error",
        turnId: turn.id,
        code:
          latest.status === "delivery_uncertain"
            ? "MESSAGE_DELIVERY_UNCERTAIN"
            : ((e as DomainError).code ?? "HOST_UNAVAILABLE"),
        message: (e as Error).message,
      });
      this.active.delete(session.id);
    }
  }
  notification(session: Session, method: string, params: any) {
    if (this.closing) return;
    const s = this.service.catalog.open(session.projectId),
      tid = this.active.get(session.id);
    if (method === "mcpServer/startupStatus/updated")
      s.event(`session:${session.id}`, {
        type: "host_setup",
        method,
        serverName: params.serverName ?? params.server,
        status: params.status,
        error: params.error,
      });
    if (!tid || !s.has("turn", tid)) return;
    if (params.threadId && params.threadId !== session.hostSessionId) return;
    const turn = s.get<Turn>("turn", tid);
    const payload: any = {
      type: "host_event",
      method,
      turnId: tid,
      hostTurnId: params.turnId ?? params.turn?.id ?? turn.hostTurnId,
    };
    if (method === "item/agentMessage/delta") {
      turn.response += params.delta ?? "";
      payload.type = "assistant_delta";
      payload.delta = params.delta ?? "";
      s.put("turn", turn);
    }
    if (method === "item/started" || method === "item/completed") {
      payload.type = "item";
      payload.itemType = params.item?.type;
      payload.itemId = params.item?.id;
      if (params.item?.type === "mcpToolCall") {
        payload.tool = params.item.tool;
        payload.server = params.item.server;
      }
    }
    if (method === "turn/completed") {
      turn.status = params.turn?.status ?? "completed";
      turn.hostTurnId = params.turn?.id ?? turn.hostTurnId;
      s.put("turn", turn);
      payload.type = "turn_completed";
      payload.status = turn.status;
      this.active.delete(session.id);
    }
    if (method === "error") {
      payload.type = "error";
      payload.message = params.error?.message;
    }
    s.event(`session:${session.id}`, payload);
  }
  async interrupt(input: any) {
    const s = this.service.catalog.open(input.projectId),
      session = s.get<Session>("session", input.sessionId);
    assert(
      session.projectId === input.projectId,
      "SESSION_PROJECT_MISMATCH",
      "会话属于其他项目",
    );
    const t = s.get<Turn>("turn", input.turnId);
    assert(
      t.sessionId === session.id,
      "SESSION_PROJECT_MISMATCH",
      "轮次属于其他会话",
    );
    const client = this.clients.get(session.id);
    assert(
      client && t.hostTurnId,
      "HOST_UNAVAILABLE",
      "宿主不可用，先进行对账",
    );
    await client.request("turn/interrupt", {
      threadId: session.hostSessionId,
      turnId: t.hostTurnId,
    });
    return { status: "interrupt_requested", domainJobsCancelled: false };
  }
  async reconcile(input: any) {
    const s = this.service.catalog.open(input.projectId),
      session = s.get<Session>("session", input.sessionId);
    assert(
      session.projectId === input.projectId,
      "SESSION_PROJECT_MISMATCH",
      "会话属于其他项目",
    );
    const client = await this.connect(session);
    let history: any;
    try {
      history = await client.request("thread/read", {
        threadId: session.hostSessionId,
        includeTurns: true,
      });
    } catch (e) {
      return {
        status: "recovery_required",
        error: (e as Error).message,
        resent: false,
      };
    }
    const turns = s
      .all<Turn>("turn")
      .filter(
        (t) => t.sessionId === session.id && t.status === "delivery_uncertain",
      );
    const reconciled: string[] = [];
    for (const turn of turns) {
      const hostTurns = history.thread.turns ?? [];
      const match = hostTurns.find(
        (t: any) =>
          t.id === turn.hostTurnId ||
          (t.items ?? []).some(
            (i: any) =>
              i.type === "userMessage" &&
              (i.content ?? []).some((c: any) =>
                c.text?.includes(turn.messageId),
              ),
          ),
      );
      if (
        match &&
        ["completed", "interrupted", "failed"].includes(match.status)
      ) {
        turn.hostTurnId = match.id;
        turn.status = match.status;
        const text = (match.items ?? [])
          .filter((i: any) => i.type === "agentMessage")
          .map((i: any) => i.text)
          .join("\n");
        if (text) turn.response = text;
        s.put("turn", turn);
        s.event(`session:${session.id}`, {
          type: "reconciled",
          turnId: turn.id,
          status: turn.status,
        });
        reconciled.push(turn.id);
      }
    }
    return {
      status: turns.every((t) => reconciled.includes(t.id))
        ? "reconciled"
        : "recovery_required",
      reconciled,
      resent: false,
      operations: s.all("change"),
      jobs: s.all("job"),
    };
  }
  close() {
    this.closing = true;
    for (const c of this.processes) c.stop();
    this.processes.clear();
    this.clients.clear();
  }
}
function toToml(x: any): string {
  if (x && typeof x === "object" && !Array.isArray(x))
    return `{ ${Object.entries(x)
      .map(([k, v]) => `${JSON.stringify(k)} = ${toToml(v)}`)
      .join(", ")} }`;
  if (Array.isArray(x)) return `[${x.map(toToml).join(", ")}]`;
  return JSON.stringify(x);
}
export function parseMessageOperation(text: string): Operation | null {
  if (
    /不要|别|禁止|如果|假如|是否|能否|建议|预览|怎么|如何|不修改|检查一下/.test(
      text,
    )
  )
    return null;
  const t = text
    .trim()
    .match(
      /^(?:请)?(?:将|把)?(?:当前)?(?:选中(?:的)?(?:轮廓|对象)?(?:的)?)?(?:计量厚度|厚度)\s*(?:设置为|设为|改为|改成|设置成)\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米)(?:并(?:重新计算|重算))?[。.!！]?$/i,
    );
  if (t) {
    const unit =
      ({ 毫米: "mm", 厘米: "cm", 米: "m" } as any)[t[2]] ?? t[2].toLowerCase();
    return {
      kind: "set_measurement_parameter",
      field: "uniform_thickness",
      value: Number(t[1]),
      unit,
      unitBinding: "physical_quantity",
    };
  }
  return null;
}
