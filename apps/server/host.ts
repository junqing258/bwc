import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcProcess } from "./rpc.ts";
import type { WorkflowService } from "./service.ts";
import type { Intent, Operation } from "./types.ts";
import { assert, canonical, DomainError, id, now } from "./util.ts";
import { ROOT } from "./workers.ts";
export type HostKind = "codex" | "claude";
export interface Session {
  id: string;
  projectId: string;
  host: HostKind;
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
  error?: { code: string; message: string };
  context: any;
  createdAt: string;
}
export interface HostClient {
  startTurn(
    session: Session,
    turn: Turn,
    text: string,
  ): Promise<{ hostTurnId: string | null }>;
  interrupt(session: Session, turn: Turn): Promise<void>;
  readThread(session: Session): Promise<any>;
  stop(): void;
}
class CodexHost implements HostClient {
  constructor(private process: JsonRpcProcess) {}
  startTurn(session: Session, turn: Turn, text: string) {
    return this.process
      .request(
        "turn/start",
        {
          threadId: session.hostSessionId,
          clientUserMessageId: turn.clientMessageId,
          input: [{ type: "text", text }],
        },
        60000,
      )
      .then((r: any) => ({ hostTurnId: r.turn.id }));
  }
  interrupt(session: Session, turn: Turn) {
    return this.process
      .request("turn/interrupt", {
        threadId: session.hostSessionId,
        turnId: turn.hostTurnId,
      })
      .then(() => {});
  }
  readThread(session: Session) {
    return this.process.request("thread/read", {
      threadId: session.hostSessionId,
      includeTurns: true,
    });
  }
  stop() {
    this.process.stop();
  }
}
class ClaudeHost implements HostClient {
  constructor(
    private process: ClaudeProcess,
    private cwd: string,
  ) {}
  async startTurn(_session: Session, _turn: Turn, text: string) {
    this.process.say(text);
    return { hostTurnId: null };
  }
  async interrupt(_session: Session, _turn: Turn) {
    await this.process.interrupt();
  }
  async readThread(session: Session) {
    const dir = process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, "projects")
      : join(homedir(), ".claude", "projects");
    const file = join(
      dir,
      this.cwd.replace(/[^A-Za-z0-9]/g, "-"),
      `${session.hostSessionId}.jsonl`,
    );
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    return claudeThreadFromTranscript(lines);
  }
  stop() {
    this.process.stop();
  }
}
export function claudeThreadFromTranscript(lines: any[]): any {
  const turns: any[] = [];
  let current: any = null;
  for (const line of lines) {
    if (line?.type === "user" && !line.isMeta) {
      const content = line.message?.content;
      if (
        Array.isArray(content) &&
        content.some((b) => b.type === "tool_result")
      )
        continue;
      const text =
        typeof content === "string"
          ? content
          : (content ?? [])
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
      if (!text?.trim()) continue;
      if (current) turns.push(current);
      current = {
        id: line.uuid,
        status: "running",
        items: [{ type: "userMessage", content: [{ text }] }],
      };
    } else if (line?.type === "assistant" && current) {
      for (const b of line.message?.content ?? [])
        if (b.type === "text" && b.text?.trim())
          current.items.push({ type: "agentMessage", text: b.text });
    }
  }
  if (current) turns.push(current);
  for (const t of turns)
    if (
      t.status === "running" &&
      t.items.some((i: any) => i.type === "agentMessage")
    )
      t.status = "completed";
  return { thread: { turns } };
}
export class ClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  stderrTail = "";
  private pending = new Map<
    string,
    { resolve: (v: any) => void; timer: NodeJS.Timeout }
  >();
  private initWaiter: {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private controlSeq = 0;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    handlers: { onEvent: (m: any) => void; onExit: () => void },
  ) {
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === "control_response") {
        const p = this.pending.get(m.response?.request_id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.response.request_id);
          p.resolve(m.response);
        }
        return;
      }
      if (m.type === "system" && m.subtype === "init" && this.initWaiter) {
        clearTimeout(this.initWaiter.timer);
        this.initWaiter.resolve(m);
        this.initWaiter = null;
      }
      handlers.onEvent(m);
    });
    this.child.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    let exitedOnce = false;
    const exited = () => {
      if (exitedOnce) return;
      exitedOnce = true;
      if (this.initWaiter) {
        clearTimeout(this.initWaiter.timer);
        const tail = this.stderrTail.trim().split("\n").at(-1);
        this.initWaiter.reject(
          new DomainError(
            "HOST_UNAVAILABLE",
            `claude CLI 启动失败${tail ? `: ${tail}` : "（进程退出）"}`,
          ),
        );
        this.initWaiter = null;
      }
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.resolve({ subtype: "process_exited" });
      }
      this.pending.clear();
      handlers.onExit();
    };
    this.child.on("error", exited);
    this.child.on("exit", exited);
  }
  waitInit(timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.initWaiter = null;
        reject(new DomainError("HOST_TIMEOUT", "claude CLI 初始化超时"));
      }, timeout);
      this.initWaiter = { resolve, reject, timer };
    });
  }
  say(text: string) {
    if (this.child.stdin.destroyed) return;
    this.child.stdin.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        parent_tool_use_id: null,
      }) + "\n",
    );
  }
  interrupt(timeout = 5000) {
    const rid = `bwc_${++this.controlSeq}`;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve();
      }, timeout);
      this.pending.set(rid, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        timer,
      });
      if (!this.child.stdin.destroyed)
        this.child.stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: rid,
            request: { subtype: "interrupt" },
          }) + "\n",
        );
    });
  }
  stop() {
    this.child.kill("SIGTERM");
  }
}
export class HostBridge {
  closing = false;
  processes = new Set<{ stop(): void }>();
  clients = new Map<string, HostClient>();
  connecting = new Map<string, Promise<HostClient>>();
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
    const s = this.service.catalog.open(input.projectId),
      host: HostKind = input.host === "claude" ? "claude" : "codex";
    const session: Session = {
      id: id("as"),
      projectId: input.projectId,
      host,
      hostVersion:
        host === "claude"
          ? "local CLI (stream-json)"
          : "local CLI (protocol v2)",
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
      turns: s
        .all<Turn>("turn")
        .filter((t) => t.sessionId === session.id)
        .map((t) => {
          if (t.status !== "failed" || t.error) return t;
          const row = s.db
            .prepare(
              "SELECT json FROM events WHERE channel=? AND json_extract(json,'$.type')='error' AND json_extract(json,'$.turnId')=? ORDER BY seq DESC LIMIT 1",
            )
            .get(`session:${session.id}`, t.id) as { json: string } | undefined;
          const event = row ? JSON.parse(row.json) : null;
          return event?.message
            ? {
                ...t,
                error: {
                  code: event.code ?? "HOST_TURN_FAILED",
                  message: event.message,
                },
              }
            : t;
        }),
      events: s.events(`session:${session.id}`, input.after ?? 0),
    };
  }
  async connect(session: Session): Promise<HostClient> {
    if (this.clients.has(session.id)) return this.clients.get(session.id)!;
    if (this.connecting.has(session.id))
      return this.connecting.get(session.id)!;
    const task = (async () => {
      const s = this.service.catalog.open(session.projectId),
        cwd = join(s.path, "agent-workspace");
      mkdirSync(join(cwd, ".agents/skills/dwg-workflow"), { recursive: true });
      mkdirSync(join(cwd, ".claude/skills/dwg-workflow"), { recursive: true });
      for (const dir of [".agents", ".claude"])
        copyFileSync(
          join(ROOT, "skills/dwg-workflow/SKILL.md"),
          join(cwd, `${dir}/skills/dwg-workflow/SKILL.md`),
        );
      const instructions =
        "Use the dwg-workflow skill and only the bwc MCP domain tools. Do not edit project files, run shell commands, use other connectors, or send messages outside this workbench. All domain writes require a persisted intent and exact frozen context.";
      writeFileSync(join(cwd, "AGENTS.md"), instructions + "\n");
      writeFileSync(join(cwd, "CLAUDE.md"), instructions + "\n");
      const mcp = {
        bwc: {
          default_tools_approval_mode: "auto",
          command: process.execPath,
          args: [
            "--import",
            import.meta.resolve("tsx"),
            join(ROOT, "apps/server/mcp.ts"),
          ],
          env: {
            BWC_URL: this.url,
            BWC_SERVICE_TOKEN: this.token,
            BWC_PROJECT_ID: session.projectId,
            BWC_SESSION_ID: session.id,
          },
        },
      };
      writeFileSync(
        join(cwd, "mcp.json"),
        JSON.stringify({ mcpServers: { bwc: mcp.bwc } }, null, 2),
      );
      const onExit = () => {
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
      };
      let client: HostClient;
      if (session.host === "claude")
        client = await this.connectClaude(session, cwd, onExit);
      else client = await this.connectCodex(session, cwd, mcp, onExit);
      this.clients.set(session.id, client);
      return client;
    })();
    this.connecting.set(session.id, task);
    try {
      return await task;
    } finally {
      this.connecting.delete(session.id);
    }
  }
  private async connectCodex(
    session: Session,
    cwd: string,
    mcp: any,
    onExit: () => void,
  ): Promise<HostClient> {
    const s = this.service.catalog.open(session.projectId);
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
          onExit();
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
      return new CodexHost(client);
    } catch (e) {
      client.stop();
      throw e;
    }
  }
  private async connectClaude(
    session: Session,
    cwd: string,
    onExit: () => void,
  ): Promise<HostClient> {
    const s = this.service.catalog.open(session.projectId);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "default",
      "--allowedTools",
      "mcp__bwc",
      "--disallowedTools",
      [
        "Task",
        "Bash",
        "BashOutput",
        "KillShell",
        "Glob",
        "Grep",
        "Read",
        "Edit",
        "Write",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "SlashCommand",
        "TodoWrite",
      ].join(","),
      "--strict-mcp-config",
      "--mcp-config",
      join(cwd, "mcp.json"),
    ];
    if (session.hostSessionId) args.push("--resume", session.hostSessionId);
    const proc = new ClaudeProcess(
      process.env.BWC_CLAUDE_BIN ?? "claude",
      args,
      cwd,
      {
        onEvent: (m) => this.claudeEvent(session, m),
        onExit: () => {
          this.processes.delete(proc);
          onExit();
        },
      },
    );
    this.processes.add(proc);
    try {
      const init = await proc.waitInit(60000);
      if (init.session_id) session.hostSessionId = init.session_id;
      session.model = init.model ?? "host_default_unreported";
      session.hostVersion = `claude CLI ${init.version ?? ""}`.trim();
      const inventory = (init.mcp_servers ?? []).map((x: any) => ({
        name: x.name,
        status: x.status,
      }));
      s.event(`session:${session.id}`, {
        type: "host_setup",
        method: "system/init",
        inventory,
      });
      session.status = "ready";
      s.put("session", session);
      return new ClaudeHost(proc, cwd);
    } catch (e) {
      proc.stop();
      throw e;
    }
  }
  claudeEvent(session: Session, m: any) {
    if (this.closing) return;
    if (
      m.type === "stream_event" &&
      m.event?.type === "content_block_delta" &&
      m.event.delta?.type === "text_delta"
    )
      return this.notification(session, "item/agentMessage/delta", {
        delta: m.event.delta.text,
      });
    if (m.type === "assistant")
      for (const b of m.message?.content ?? [])
        if (b.type === "tool_use") {
          const name = String(b.name ?? ""),
            parts = name.split("__");
          this.notification(session, "item/started", {
            item: {
              type: "mcpToolCall",
              id: b.id,
              tool: parts.length > 2 ? parts.slice(2).join("__") : name,
              server: parts.length > 2 ? parts[1] : name,
            },
          });
        }
    if (m.type === "user")
      for (const b of m.message?.content ?? [])
        if (b.type === "tool_result")
          this.notification(session, "item/completed", {
            item: { type: "mcpToolCall", id: b.tool_use_id },
          });
    if (m.type === "result")
      this.notification(session, "turn/completed", {
        turn:
          m.subtype === "success"
            ? { id: m.session_id ?? null, status: "completed" }
            : {
                id: m.session_id ?? null,
                status: "failed",
                error: {
                  message:
                    m.error ?? m.result ?? m.subtype ?? "claude CLI 轮次失败",
                },
              },
      });
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
      const r = await client.startTurn(session, turn, text);
      const latest = s.get<Turn>("turn", turn.id);
      if (r.hostTurnId) latest.hostTurnId = r.hostTurnId;
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
      latest.error = {
        code: (e as DomainError).code ?? "HOST_UNAVAILABLE",
        message: (e as Error).message,
      };
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
      if (turn.status === "completed") delete turn.error;
      else if (params.turn?.error?.message)
        turn.error = {
          code: "HOST_TURN_FAILED",
          message: params.turn.error.message,
        };
      s.put("turn", turn);
      payload.type = "turn_completed";
      payload.status = turn.status;
      this.active.delete(session.id);
    }
    if (method === "error") {
      payload.type = "error";
      payload.message = params.error?.message;
      turn.error = {
        code: "HOST_TURN_FAILED",
        message: params.error?.message ?? "AI 宿主轮次失败",
      };
      s.put("turn", turn);
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
      client && (session.host === "claude" || t.hostTurnId),
      "HOST_UNAVAILABLE",
      "宿主不可用，先进行对账",
    );
    await client.interrupt(session, t);
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
      history = await client.readThread(session);
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
