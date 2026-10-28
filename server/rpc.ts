import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { DomainError } from "./util.ts";
export class JsonRpcProcess {
  child: ChildProcessWithoutNullStreams;
  nextId = 1;
  pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      onNotification: (method: string, params: any) => void;
      onRequest?: (method: string, params: any) => Promise<any>;
      onExit: () => void;
    },
  ) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && m.method) {
          void (async () => {
            try {
              const result = await options.onRequest?.(m.method, m.params);
              this.send({ id: m.id, result: result ?? {} });
            } catch {
              this.send({
                id: m.id,
                error: {
                  code: -32601,
                  message: "Host interaction not supported by this client",
                },
              });
            }
          })();
        } else if (m.id !== undefined) {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error
              ? p.reject(new DomainError("HOST_ERROR", m.error.message))
              : p.resolve(m.result);
          }
        } else if (m.method) options.onNotification(m.method, m.params ?? {});
      } catch {
        /* Host stderr and non-protocol diagnostics never become domain success. */
      }
    });
    let exitedOnce = false;
    const exited = () => {
      if (exitedOnce) return;
      exitedOnce = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new DomainError("HOST_UNAVAILABLE", "宿主进程已退出"));
      }
      this.pending.clear();
      options.onExit();
    };
    this.child.on("error", exited);
    this.child.on("exit", exited);
    this.child.stderr.on("data", () => {});
  }
  send(value: any) {
    if (!this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(method: string, params: any, timeout = 30000): Promise<any> {
    const rid = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(
          new DomainError(
            method === "turn/start"
              ? "MESSAGE_DELIVERY_UNCERTAIN"
              : "HOST_TIMEOUT",
            `${method} 响应超时`,
          ),
        );
      }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      this.send({ id: rid, method, params });
    });
  }
  notify(method: string, params: any = {}) {
    this.send({ method, params });
  }
  stop() {
    this.child.kill("SIGTERM");
  }
}
