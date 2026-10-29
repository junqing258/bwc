import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { WorkspaceDomain } from "./workspace-domain.ts";
import { RUNTIME_PROTOCOL } from "./runtime-client.ts";
import { assert, atomicJson, id, now, readJson } from "./util.ts";
import { z } from "zod";
import { ROOT } from "./workers.ts";
import { within } from "./util.ts";
import { modelError } from "./model-output.ts";
import { SessionReviewService } from "./session-review.ts";

export async function startRuntime(root: string) {
  const lockFd = Number(process.env.BWC_LOCK_FD);
  assert(
    Number.isInteger(lockFd) && lockFd >= 3,
    "LOCK_REQUIRED",
    "请使用 runtime-lock.py 启动器取得系统锁",
  );
  const lock = fstatSync(lockFd);
  const canonicalRoot = realpathSync(root),
    run = join(canonicalRoot, ".bwc/run");
  assert(lock.isFile(), "LOCK_REQUIRED", "系统锁描述符无效");
  const instanceId = id("rt"),
    startedAt = now(),
    token = randomBytes(32).toString("hex");
  const domain = new WorkspaceDomain(canonicalRoot, instanceId);
  const sessionReviews = new SessionReviewService(domain);
  const descriptor = {
    workspaceId: domain.catalog.manifest.workspaceId,
    root: canonicalRoot,
    pid: process.pid,
    startedAt,
    instanceId,
    protocolVersion: RUNTIME_PROTOCOL,
    state: "ready" as "ready" | "stopping",
    heartbeat: now(),
    endpoint: "",
  };
  const leases = new Map<string, number>();
  let lastActivity = Date.now(),
    stopping = false,
    activeRequests = 0;
  const server = createServer(async (req, res) => {
    activeRequests++;
    const send = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      assert(
        (req.headers.host ?? "") === new URL(descriptor.endpoint).host,
        "UNAUTHORIZED",
        "仅接受本地客户端",
      );
      const path = new URL(req.url ?? "/", descriptor.endpoint).pathname;
      assert(!stopping, "RUNTIME_STOPPING", "运行时正在停止接单");
      if (
        req.method === "GET" &&
        (path === "/review" || path.startsWith("/assets/"))
      ) {
        const staticRoot = existsSync(join(ROOT, "reviewer"))
          ? join(ROOT, "reviewer")
          : join(ROOT, ".cache/reviewer");
        const file = within(
          staticRoot,
          path === "/review" ? "review.html" : path.slice(1),
        );
        assert(
          existsSync(file),
          "VIEWER_NOT_BUILT",
          "请先运行 npm run build:reviewer",
        );
        res.writeHead(200, {
          "Content-Type":
            (
              {
                ".html": "text/html; charset=utf-8",
                ".js": "text/javascript",
                ".css": "text/css",
              } as Record<string, string>
            )[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(readFileSync(file));
        return;
      }
      if (path.startsWith("/review-api/")) {
        assert(
          !req.headers.origin || req.headers.origin === descriptor.endpoint,
          "UNAUTHORIZED",
          "审阅来源无效",
        );
        const reviewToken = String(req.headers["x-bwc-review"] ?? "");
        domain.reviews.session(reviewToken);
        lastActivity = Date.now();
        if (path === "/review-api/state" && req.method === "GET")
          return send(domain.reviews.state(reviewToken));
        assert(req.method === "POST", "INVALID_REQUEST", "审阅提交须使用POST");
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          assert(bytes <= 2_000_000, "INPUT_TOO_LARGE", "请求过大");
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString());
        if (path.startsWith("/review-api/coverage/"))
          return send(
            domain.reviews.coverageAction(
              reviewToken,
              path.slice("/review-api/coverage/".length),
              value,
            ),
          );
        if (path === "/review-api/refresh")
          return send(domain.reviews.refresh(reviewToken));
        if (path === "/review-api/submit")
          return send(await domain.reviews.submit(reviewToken, value));
        if (path === "/review-api/units")
          return send(await domain.reviews.adoptUnits(reviewToken, value));
        if (path === "/review-api/policy")
          return send(domain.reviews.setPolicy(reviewToken, value));
        assert(false, "NOT_FOUND", "审阅接口不存在");
      }
      assert(
        !req.headers.origin,
        "UNAUTHORIZED",
        "运行时客户端不接受浏览器来源",
      );
      assert(
        req.method === "POST" &&
          req.headers.authorization === `Bearer ${token}` &&
          req.headers["x-bwc-instance"] === instanceId,
        "UNAUTHORIZED",
        "运行时凭据无效",
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size <= 2_000_000, "INPUT_TOO_LARGE", "请求过大");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert(
        input.workspaceId === descriptor.workspaceId &&
          input.instanceId === instanceId &&
          input.protocolVersion === RUNTIME_PROTOCOL,
        "RUNTIME_MISMATCH",
        "运行时握手归属不匹配",
      );
      lastActivity = Date.now();
      if (req.url === "/lease" || req.url === "/release") {
        const clientId = z.string().min(1).max(100).parse(input.clientId);
        if (req.url === "/lease") leases.set(clientId, Date.now() + 15000);
        else leases.delete(clientId);
        return send({ ok: true });
      }
      if (req.url === "/handshake")
        return send({
          workspaceId: descriptor.workspaceId,
          instanceId,
          protocolVersion: RUNTIME_PROTOCOL,
        });
      if (req.url === "/stop") {
        send({ stopping: true, instanceId });
        void stop();
        return;
      }
      assert(!stopping, "RUNTIME_STOPPING", "运行时正在停止接单");
      if (req.url === "/call")
        return send(await domain.call(input.tool, input.input));
      // Private adapter routes. There is no model-callable accept/resolve tool.
      if (req.url === "/session-review/prepare")
        return send(sessionReviews.prepare(input.input));
      if (req.url === "/session-review/resolve")
        return send(await sessionReviews.resolve(input.input));
      if (req.url === "/session-review/discard") {
        sessionReviews.discard(z.string().parse(input.ticketId));
        return send({ discarded: true });
      }
      // No model-facing tool exposes this route. Only a user-invoked local CLI may update policy.
      if (req.url === "/local/policy") {
        const policy = z
          .object({
            mode: z.enum(["summary", "geometry"]),
            snapshotIds: z.array(z.string()).max(1000),
          })
          .parse(input);
        return send(
          domain.catalog.setPolicy(
            policy.mode,
            "local_cli",
            policy.snapshotIds,
          ),
        );
      }
      assert(false, "NOT_FOUND", "接口不存在");
    } catch (error) {
      console.error(
        "runtime request",
        (error as any)?.code ?? "INVALID_REQUEST",
      );
      send(modelError(error), 422);
    } finally {
      activeRequests--;
    }
  });
  const writeDescriptor = () => {
    descriptor.heartbeat = now();
    atomicJson(join(run, "runtime.json"), descriptor);
    chmodSync(join(run, "runtime.json"), 0o600);
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    descriptor.state = "stopping";
    writeDescriptor();
    // Finish already-running jobs; a bounded shutdown leaves recovery to the next lock owner.
    const deadline = Date.now() + 10000;
    while (
      (domain.service.controllers.size || activeRequests) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    clearInterval(heartbeat);
    await new Promise<void>((r) => server.close(() => r()));
    domain.close();
    try {
      if (readJson<any>(join(run, "runtime.json")).instanceId === instanceId) {
        unlinkSync(join(run, "runtime.json"));
        unlinkSync(join(run, "credentials.json"));
      }
    } catch {}
    // The inherited lock fd is deliberately retained until process exit.
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  descriptor.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  atomicJson(join(run, "credentials.json"), { instanceId, token });
  chmodSync(join(run, "credentials.json"), 0o600);
  domain.tools.viewer_open.run = (input: any) => {
    const review = domain.reviews.open(
      input.drawingId,
      input.batchId,
      input.coverageId,
    );
    return {
      url: `${descriptor.endpoint}/review#${review.token}`,
      batchId: review.batch.id,
      workingRevision: review.batch.workingRevision,
      geometrySnapshotId: review.batch.geometrySnapshotId,
      expiresAt: new Date(review.expiresAt).toISOString(),
    };
  };
  writeDescriptor();
  const heartbeat = setInterval(() => {
    writeDescriptor();
    for (const [clientId, expiresAt] of leases)
      if (expiresAt < Date.now()) leases.delete(clientId);
    if (
      !leases.size &&
      !activeRequests &&
      !domain.service.controllers.size &&
      Date.now() - lastActivity > domain.catalog.manifest.config.idleTimeoutMs
    )
      void stop();
  }, 2000);
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  return { domain, descriptor, stop };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  startRuntime(process.argv[2]).catch((error) => {
    console.error(
      (error as any)?.code ?? "STARTUP_FAILED",
      (error as Error).message,
    );
    process.exitCode = 1;
  });
}
