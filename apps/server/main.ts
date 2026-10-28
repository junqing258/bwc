import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import { WorkflowService } from "./service.ts";
import { toolRegistry } from "./tools.ts";
import { HostBridge, type Session } from "./host.ts";
import { assert, DomainError, hash, id, now, within } from "./util.ts";
import { ROOT } from "./workers.ts";
import { OperationSchema, SelectionRef } from "./schemas.ts";

export function createApplication(
  options: { dataDir?: string; port?: number; host?: boolean } = {},
) {
  const service = new WorkflowService(options.dataDir),
    registry = toolRegistry(service),
    token = randomBytes(32).toString("hex");
  const port = options.port ?? Number(process.env.PORT ?? 4310);
  const url = `http://127.0.0.1:${port}`;
  const bridge = new HostBridge(service, url, token);
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", url),
        path = u.pathname;
      assert(
        ["127.0.0.1", "localhost"].includes(
          (req.headers.host ?? "").split(":")[0],
        ),
        "INVALID_HOST",
        "只接受本机连接",
      );
      const origin = req.headers.origin;
      assert(
        !origin ||
          [
            url,
            "http://localhost:" + port,
            "http://127.0.0.1:5173",
            "http://localhost:5173",
          ].includes(origin),
        "INVALID_ORIGIN",
        "请求来源无效",
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      if (path === "/api/health")
        return json(res, {
          ok: true,
          schemaVersion: 1,
          host: "codex_app_server",
          offlineDomainTools: true,
        });
      if (path === "/api/projects" && req.method === "GET")
        return json(res, service.projects());
      if (path === "/api/samples" && req.method === "GET")
        return json(
          res,
          service.samples().map(({ path, ...s }) => s),
        );
      if (path === "/api/projects" && req.method === "POST") {
        const b = z
          .object({ name: z.string().min(1).max(199) })
          .strict()
          .parse(await body(req));
        return json(res, service.create(b.name));
      }
      if (path === "/api/fixture" && req.method === "POST")
        return json(res, await service.fixture());
      if (path === "/api/call" && req.method === "POST") {
        const b = z
          .object({ tool: z.string(), input: z.record(z.unknown()) })
          .strict()
          .parse(await body(req));
        const t = registry[b.tool as keyof typeof registry];
        assert(t, "UNKNOWN_TOOL", "领域工具不存在");
        return json(res, await t.run(t.schema.parse(b.input)));
      }
      if (path === "/api/mcp" && req.method === "POST") {
        assert(
          req.headers.authorization === `Bearer ${token}`,
          "UNAUTHORIZED",
          "本地工具凭据无效",
        );
        const b = z
          .object({
            tool: z.string(),
            input: z.record(z.unknown()),
            projectId: z.string(),
            sessionId: z.string(),
          })
          .strict()
          .parse(await body(req));
        const s = service.catalog.open(b.projectId),
          session = s.get<Session>("session", b.sessionId);
        assert(
          session.projectId === b.projectId,
          "SESSION_PROJECT_MISMATCH",
          "项目与会话不匹配",
        );
        assert(
          !b.input.projectId || b.input.projectId === b.projectId,
          "SESSION_PROJECT_MISMATCH",
          "工具不能跨项目调用",
        );
        const t = registry[b.tool as keyof typeof registry];
        assert(t, "UNKNOWN_TOOL", "领域工具不存在");
        assert(
          !["project_list", "dwg_import"].includes(b.tool),
          "UNSUPPORTED_OPERATION",
          "宿主仅操作已打开项目",
        );
        const active = s
          .all<any>("turn")
          .filter(
            (t) =>
              t.sessionId === session.id &&
              ["sending", "running"].includes(t.status),
          )
          .at(-1);
        assert(active, "SESSION_IDLE", "没有正在执行的宿主轮次");
        if (b.tool === "change_propose")
          assert(
            b.input.intentId === active.intentId,
            "INTENT_MISMATCH",
            "用户指令不属于当前轮次",
          );
        if (b.tool === "change_apply")
          assert(
            s.get("change", String(b.input.changeId)).intentId ===
              active.intentId,
            "INTENT_MISMATCH",
            "候选不属于当前用户消息",
          );
        if (b.tool === "change_revert")
          assert(
            /^(请)?撤销(最新|当前)(修改|变更)[。！!]?$/u.test(
              active.text.trim(),
            ),
            "INTENT_MISMATCH",
            "撤销需要明确用户指令，或使用工作台历史面板",
          );
        const input = t.schema.parse({
          ...b.input,
          ...(b.tool === "dwg_capabilities" || b.tool !== "project_list"
            ? { projectId: b.projectId }
            : {}),
        });
        const out = await t.run(input);
        const compact = compactPayload(out, s.meta().dataPolicy.mode);
        const mapping = {
          id: id("tool"),
          sessionId: session.id,
          turnId: active.id,
          tool: b.tool,
          operationId: b.input.operationId ?? null,
          jobId: out?.id?.startsWith("job_") ? out.id : null,
          workingRevision:
            b.input.workingRevision ?? active.context.workingRevision,
          at: now(),
        };
        s.put("tool_call", mapping);
        s.put("data_send", {
          ...mapping,
          id: id("send"),
          policyVersion: s.meta().dataPolicy.id,
          categories: [
            s.meta().dataPolicy.mode === "geometry"
              ? "domain_result_with_geometry"
              : "domain_summary",
          ],
          geometrySnapshotId: out?.geometrySnapshotId ?? null,
        });
        s.event(`session:${session.id}`, { type: "domain_tool", ...mapping });
        return json(res, compact);
      }
      if (path === "/api/intent" && req.method === "POST") {
        const b = z
          .object({
            projectId: z.string(),
            workingRevision: z.string(),
            selectionSet: SelectionRef.optional(),
            operation: OperationSchema,
            text: z.string().max(10000).optional(),
          })
          .strict()
          .parse(await body(req));
        return json(res, service.recordIntent(b));
      }
      if (path === "/api/preview" && req.method === "GET")
        return json(
          res,
          service.preview({
            projectId: u.searchParams.get("projectId"),
            workingRevision: u.searchParams.get("workingRevision") ?? undefined,
          }),
        );
      if (path === "/api/events" && req.method === "GET") {
        const s = service.catalog.open(u.searchParams.get("projectId") ?? "");
        let after = Number(
          req.headers["last-event-id"] ?? u.searchParams.get("after") ?? 0,
        );
        assert(
          Number.isSafeInteger(after) && after >= 0,
          "INVALID_CURSOR",
          "事件游标无效",
        );
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        const flush = () => {
          for (const event of s.events("*", after)) {
            after = event.sequence;
            res.write(`id: ${after}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          res.write(": heartbeat\n\n");
        };
        flush();
        const timer = setInterval(flush, 1000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (path === "/api/upload" && req.method === "POST") {
        const s = service.catalog.open(u.searchParams.get("projectId") ?? ""),
          name = basename(u.searchParams.get("name") ?? "drawing.dwg");
        assert(
          name.toLowerCase().endsWith(".dwg"),
          "INVALID_DWG",
          "请选择 DWG 文件",
        );
        const bytes = await rawBody(req, 100 * 1024 * 1024);
        assert(
          /^AC10\d\d$/.test(bytes.subarray(0, 6).toString()),
          "INVALID_DWG",
          "DWG 文件头无效",
        );
        const uid = id("upload"),
          p = `uploads/${uid}/${name}`;
        mkdirSync(join(s.path, "uploads", uid), { recursive: true });
        writeFileSync(join(s.path, p), bytes);
        s.put("upload", { id: uid, path: p, name, sha256: hash(bytes) });
        return json(res, { fileRef: uid, name });
      }
      if (path === "/api/policy" && req.method === "POST") {
        const b = z
          .object({
            projectId: z.string(),
            mode: z.enum(["summary", "geometry"]),
          })
          .strict()
          .parse(await body(req));
        const s = service.catalog.open(b.projectId);
        return json(
          res,
          s.updateMeta({
            dataPolicy: { ...s.meta().dataPolicy, id: id("dp"), mode: b.mode },
          }).dataPolicy,
        );
      }
      if (path === "/api/conversion" && req.method === "POST") {
        const b = z
          .object({
            projectId: z.string(),
            originalVersion: z.string().nullable(),
            compatibleVersion: z.string(),
            software: z.string().min(1),
            softwareVersion: z.string().min(1),
            targetT3Version: z.string(),
            exportOptions: z.string(),
            evidence: z.string().min(1),
          })
          .strict()
          .parse(await body(req));
        const s = service.catalog.open(b.projectId),
          copy = s.get("drawing", b.compatibleVersion),
          original = b.originalVersion
            ? s.get("drawing", b.originalVersion)
            : null;
        assert(
          !original || original.id !== copy.id,
          "INVALID_CONVERSION",
          "原图与副本必须为不同版本",
        );
        const record = {
          id: id("conversion"),
          ...b,
          originalSha256: original?.sha256 ?? null,
          compatibleSha256: copy.sha256,
          verification: "not_verified",
          verificationScope: null,
          createdAt: now(),
        };
        s.transaction(() => {
          s.put("conversion", record);
          s.put("drawing", {
            ...copy,
            role: "compatible_copy",
            conversionRecordId: record.id,
          });
        });
        return json(res, record);
      }
      if (path === "/api/session/create" && req.method === "POST")
        return json(
          res,
          bridge.create(
            z
              .object({ projectId: z.string() })
              .strict()
              .parse(await body(req)),
          ),
        );
      if (path === "/api/session/read" && req.method === "POST")
        return json(
          res,
          bridge.read(
            z
              .object({
                projectId: z.string(),
                sessionId: z.string(),
                after: z.number().int().nonnegative().optional(),
              })
              .strict()
              .parse(await body(req)),
          ),
        );
      if (path === "/api/session/message" && req.method === "POST") {
        const b = z
          .object({
            projectId: z.string(),
            sessionId: z.string(),
            clientMessageId: z.string().min(1).max(200),
            text: z.string().min(1).max(20000),
            context: z
              .object({
                workingRevision: z.string(),
                geometrySnapshotId: z.string(),
                selectionSet: SelectionRef.optional(),
                dataPolicyVersion: z.string(),
              })
              .strict(),
          })
          .strict()
          .parse(await body(req));
        return json(res, bridge.submit(b));
      }
      if (
        ["/api/session/interrupt", "/api/session/reconcile"].includes(path) &&
        req.method === "POST"
      ) {
        const b = z
          .object({
            projectId: z.string(),
            sessionId: z.string(),
            turnId: z.string().optional(),
          })
          .strict()
          .parse(await body(req));
        return json(
          res,
          await (path.endsWith("interrupt")
            ? bridge.interrupt(b)
            : bridge.reconcile(b)),
        );
      }
      if (path === "/api/file" && req.method === "GET") {
        const s = service.catalog.open(u.searchParams.get("projectId") ?? ""),
          p = u.searchParams.get("path") ?? "";
        assert(p.startsWith("exports/"), "INVALID_PATH", "只提供已导出的文件");
        const file = within(s.path, p);
        assert(
          realpathSync(file).startsWith(realpathSync(s.path) + "/"),
          "INVALID_PATH",
          "文件不在项目目录",
        );
        res.writeHead(200, {
          "Content-Type": mime(file),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
        });
        return res.end(readFileSync(file));
      }
      if (path.startsWith("/api/"))
        throw new DomainError("NOT_FOUND", "接口不存在");
      const dist = join(ROOT, "dist");
      let file = within(dist, path.slice(1) || "index.html");
      if (!existsSync(file) || !statSync(file).isFile())
        file = join(dist, "index.html");
      assert(
        existsSync(file),
        "WEB_NOT_BUILT",
        "请先 npm run build，或开发时打开 http://127.0.0.1:5173",
      );
      res.writeHead(200, { "Content-Type": mime(file) });
      res.end(readFileSync(file));
    } catch (e) {
      const error = e as DomainError;
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "UNAUTHORIZED"
            ? 403
            : error.code === "REVISION_CONFLICT"
              ? 409
              : error instanceof z.ZodError
                ? 400
                : 422;
      json(
        res,
        {
          error: {
            code:
              error.code ??
              (error instanceof z.ZodError
                ? "INVALID_INPUT"
                : "INTERNAL_ERROR"),
            message: error.message,
            details: error.details,
          },
        },
        status,
      );
    }
  });
  const close = () => {
    bridge.close();
    server.closeAllConnections();
    server.close();
    service.close();
  };
  return { server, service, bridge, registry, token, port, close };
}
function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
async function rawBody(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const b of req) {
    size += b.length;
    assert(size <= limit, "RESOURCE_LIMIT", "请求超过大小限制");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
async function body(req: IncomingMessage) {
  return JSON.parse((await rawBody(req, 2 * 1024 * 1024)).toString());
}
function mime(file: string) {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".csv": "text/csv; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      } as Record<string, string>
    )[extname(file)] ?? "application/octet-stream"
  );
}
export function compactPayload(value: any, mode: string): any {
  if (Array.isArray(value)) {
    if (value.length > 50)
      return {
        items: value.slice(0, 50).map((v) => compactPayload(v, mode)),
        total: value.length,
        truncated: true,
      };
    return value.map((v) => compactPayload(v, mode));
  }
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        mode === "summary" &&
        ["geometry", "matrix", "delta", "sources", "occurrences"].includes(k)
      ) {
        out[k] = { omittedByDataPolicy: true };
        continue;
      }
      out[k] = compactPayload(v, mode);
    }
    return out;
  }
  return typeof value === "string" && value.length > 20000
    ? value.slice(0, 20000) + " [truncated]"
    : value;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const app = createApplication();
  app.server.listen(app.port, "127.0.0.1", () =>
    console.log(
      `筑材智算工作台 ${`http://127.0.0.1:${app.port}`} · 数据 ${app.service.catalog.root}`,
    ),
  );
  process.once("SIGINT", () => {
    app.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    app.close();
    process.exit(0);
  });
}
