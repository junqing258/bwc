import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { workspaceToolDefinitions } from "./workspace-domain.ts";
import {
  ensureRuntime,
  connectRuntime,
  runtimeRequest,
  type RuntimeConnection,
} from "./runtime-client.ts";
import { assert, id } from "./util.ts";
import { modelError } from "./model-output.ts";
import { SessionReviewInput } from "./session-review.ts";

export function createPluginMcp() {
  const server = new McpServer({ name: "bwc-workspace", version: "0.4.0" });
  const connections = new Map<string, RuntimeConnection>();
  const leaseTimers = new Map<string, NodeJS.Timeout>();
  const clientId = id("client");
  const lease = async (workspaceId: string) => {
    const connection = connections.get(workspaceId);
    if (connection)
      await runtimeRequest(connection, "/lease", { clientId }).catch(() => {});
  };
  server.server.onclose = () => {
    for (const timer of leaseTimers.values()) clearInterval(timer);
    for (const connection of connections.values())
      void runtimeRequest(connection, "/release", { clientId }).catch(() => {});
  };
  const reply = (value: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError: !!value?.error,
  });
  server.registerTool(
    "workspace_open",
    {
      description:
        "以 Codex 当前工作目录的绝对路径显式绑定；不假定 MCP cwd 是工程目录",
      inputSchema: { root: z.string() },
    },
    async ({ root }) => {
      try {
        const connection = await ensureRuntime(root, {
          autoStart: process.env.BWC_RUNTIME_AUTOSTART === "1",
        });
        const existing = connections.get(connection.descriptor.workspaceId);
        assert(
          !existing ||
            existing.descriptor.root === connection.descriptor.root ||
            !(await connectRuntime(existing.descriptor.root)),
          "WORKSPACE_ID_CONFLICT",
          "复制的工程标识与已绑定目录冲突",
        );
        connections.set(connection.descriptor.workspaceId, connection);
        if (!leaseTimers.has(connection.descriptor.workspaceId)) {
          const workspaceId = connection.descriptor.workspaceId;
          leaseTimers.set(
            workspaceId,
            setInterval(() => void lease(workspaceId), 5000),
          );
        }
        await lease(connection.descriptor.workspaceId);
        return reply(
          await runtimeRequest(connection, "/call", {
            tool: "workspace_status",
            input: { workspaceId: connection.descriptor.workspaceId },
          }),
        );
      } catch (error) {
        return reply(modelError(error));
      }
    },
  );
  for (const [name, tool] of Object.entries(workspaceToolDefinitions())) {
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.schema.shape,
        annotations: { destructiveHint: false, openWorldHint: false },
      },
      async (input: any) => {
        try {
          let connection = connections.get(input.workspaceId);
          assert(connection, "WORKSPACE_NOT_OPEN", "请先绑定工作目录");
          connection = await ensureRuntime(connection.descriptor.root, {
            autoStart: process.env.BWC_RUNTIME_AUTOSTART === "1",
          });
          assert(
            connection.descriptor.workspaceId === input.workspaceId,
            "WORKSPACE_MISMATCH",
            "工作目录标识已变化",
          );
          connections.set(input.workspaceId, connection);
          return reply(
            await runtimeRequest(connection, "/call", { tool: name, input }),
          );
        } catch (error) {
          return reply(modelError(error));
        }
      },
    );
  }
  server.registerTool(
    "review_in_session",
    {
      description:
        "在 Codex 原生表单中由用户填写并确认单位、单个候选属性、数据授权或覆盖结论。只指定操作与对象，不接受模型转述的确认或表单答案。用户取消不保存；宿主不支持时返回审阅链接。",
      inputSchema: SessionReviewInput.shape,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (raw, extra) => {
      let connection: RuntimeConnection | undefined;
      let ticketId: string | undefined;
      try {
        const input = SessionReviewInput.parse(raw);
        const existing = connections.get(input.workspaceId);
        assert(existing, "WORKSPACE_NOT_OPEN", "请先绑定工作目录");
        connection = await ensureRuntime(existing.descriptor.root, {
          autoStart: process.env.BWC_RUNTIME_AUTOSTART === "1",
        });
        assert(
          connection.descriptor.workspaceId === input.workspaceId,
          "WORKSPACE_MISMATCH",
          "工作目录标识已变化",
        );
        connections.set(input.workspaceId, connection);
        const fallback = async (reason: string) =>
          reply({
            saved: false,
            confirmationRequired: true,
            reason,
            review: await runtimeRequest(connection!, "/call", {
              tool: "viewer_open",
              input: {
                workspaceId: input.workspaceId,
                drawingId: input.drawingId,
                ...(input.coverageId ? { coverageId: input.coverageId } : {}),
              },
            }),
          });
        const caps = server.server.getClientCapabilities()?.elicitation;
        // The older empty elicitation capability also means form support.
        if (!caps || (!caps.form && Object.keys(caps).length > 0))
          return await fallback("HOST_FORM_UNAVAILABLE");
        const prepared = await runtimeRequest(
          connection,
          "/session-review/prepare",
          { input },
        );
        if (prepared.error) {
          if (
            ["NOT_FOUND", "REVIEW_FORM_TOO_LARGE"].includes(prepared.error.code)
          )
            return await fallback("RUNTIME_FORM_UNAVAILABLE");
          return reply(prepared);
        }
        ticketId = prepared.ticketId;
        let answer;
        try {
          answer = await server.server.elicitInput(prepared.form, {
            relatedRequestId: extra.requestId,
            signal: extra.signal,
            timeout: 10 * 60 * 1000,
          });
        } catch {
          if (extra.signal.aborted)
            return reply({ saved: false, action: "cancel" });
          return await fallback("HOST_FORM_FAILED");
        }
        if (extra.signal.aborted)
          return reply({ saved: false, action: "cancel" });
        return reply(
          await runtimeRequest(connection, "/session-review/resolve", {
            input: {
              ticketId,
              action: answer.action,
              ...(answer.action === "accept"
                ? { content: answer.content }
                : {}),
            },
          }),
        );
      } catch (error) {
        return reply(modelError(error));
      } finally {
        if (connection && ticketId)
          await runtimeRequest(connection, "/session-review/discard", {
            ticketId,
          }).catch(() => {});
      }
    },
  );
  return server;
}
await createPluginMcp().connect(new StdioServerTransport());
