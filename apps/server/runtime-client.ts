import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assert, DomainError, readJson } from "./util.ts";

export const RUNTIME_PROTOCOL = 1;
export interface RuntimeDescriptor {
  workspaceId: string;
  root: string;
  pid: number;
  startedAt: string;
  instanceId: string;
  protocolVersion: number;
  state: "ready" | "stopping";
  heartbeat: string;
  endpoint: string;
}
export interface RuntimeConnection {
  descriptor: RuntimeDescriptor;
  token: string;
}
export async function runtimeRequest(
  connection: RuntimeConnection,
  route: string,
  input?: unknown,
) {
  const response = await fetch(`${connection.descriptor.endpoint}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${connection.token}`,
      "X-Bwc-Instance": connection.descriptor.instanceId,
    },
    body: JSON.stringify({
      workspaceId: connection.descriptor.workspaceId,
      instanceId: connection.descriptor.instanceId,
      protocolVersion: RUNTIME_PROTOCOL,
      ...((input ?? {}) as object),
    }),
    signal: AbortSignal.timeout(route === "/handshake" ? 1200 : 15000),
  });
  const result = await response.json();
  assert(
    response.ok,
    result?.error?.code ?? "RUNTIME_UNAVAILABLE",
    "本地运行时请求失败",
  );
  return result;
}
export async function connectRuntime(
  root: string,
): Promise<RuntimeConnection | null> {
  try {
    root = realpathSync(root);
    const run = join(root, ".bwc/run");
    const descriptor = readJson<RuntimeDescriptor>(join(run, "runtime.json"));
    assert(
      descriptor.root === root &&
        descriptor.protocolVersion === RUNTIME_PROTOCOL &&
        descriptor.state === "ready",
      "RUNTIME_MISMATCH",
      "运行时归属或协议不匹配",
    );
    const endpoint = new URL(descriptor.endpoint);
    assert(
      endpoint.protocol === "http:" &&
        endpoint.hostname === "127.0.0.1" &&
        /^\d+$/.test(endpoint.port) &&
        endpoint.pathname === "/",
      "INVALID_ENDPOINT",
      "运行时须使用回环地址",
    );
    const credentials = readJson<{ instanceId: string; token: string }>(
      join(run, "credentials.json"),
    );
    assert(
      credentials.instanceId === descriptor.instanceId,
      "RUNTIME_MISMATCH",
      "运行实例凭据不匹配",
    );
    const connection = { descriptor, token: credentials.token };
    const ready = await runtimeRequest(connection, "/handshake");
    assert(
      ready.workspaceId === descriptor.workspaceId &&
        ready.instanceId === descriptor.instanceId &&
        ready.protocolVersion === RUNTIME_PROTOCOL,
      "RUNTIME_MISMATCH",
      "运行时握手不匹配",
    );
    return connection;
  } catch {
    return null;
  }
}
export async function ensureRuntime(
  workspaceRoot: string,
  options: { timeoutMs?: number; autoStart?: boolean } = {},
): Promise<RuntimeConnection> {
  assert(
    isAbsolute(workspaceRoot),
    "INVALID_WORKSPACE",
    "workspace_open 须传入绝对路径",
  );
  const root = realpathSync(workspaceRoot);
  const connected = await connectRuntime(root);
  if (connected) return connected;
  assert(
    options.autoStart !== false,
    "RUNTIME_NOT_STARTED",
    "请由用户先运行 bwc runtime start <工程绝对路径>",
  );
  const run = join(root, ".bwc/run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  chmodSync(run, 0o700);
  const logPath = join(run, "runtime.log");
  const log = openSync(logPath, "a", 0o600);
  const runtimeEntry = join(
    import.meta.dirname,
    `runtime${import.meta.filename.endsWith(".ts") ? ".ts" : ".js"}`,
  );
  const launcher = resolve(
    import.meta.dirname,
    "../../scripts/runtime-lock.py",
  );
  let startupError = "";
  const child = spawn(
    process.env.BWC_LOCK_PYTHON ?? "python3",
    [
      launcher,
      join(run, "runtime.lock"),
      process.execPath,
      ...process.execArgv,
      runtimeEntry,
      root,
    ],
    { cwd: root, detached: true, stdio: ["ignore", log, log] },
  );
  child.on("error", (e) => {
    startupError = e.message;
  });
  child.unref();
  closeSync(log);
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    if (startupError)
      throw new DomainError(
        "RUNTIME_DEPENDENCY_MISSING",
        "需要 Python 3（fcntl）与支持 node:sqlite 的 Node 22.13+；请运行依赖诊断。",
      );
    const connection = await connectRuntime(root);
    if (connection) return connection;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new DomainError(
    "RUNTIME_UNAVAILABLE",
    `运行时未就绪或锁仍被持有；日志：${logPath}。使用 bwc runtime status/stop ${root} 排查；不会自动终止进程。`,
  );
}
