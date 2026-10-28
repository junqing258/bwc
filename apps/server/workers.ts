import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DomainError } from "./util.ts";
export const ROOT = resolve(import.meta.dirname, "../..");
export function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 120000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "",
      stderr = "",
      ended = false;
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      p.kill("SIGTERM");
      kill = setTimeout(() => p.kill("SIGKILL"), 2000);
    }, timeout);
    const append = (old: string, chunk: Buffer) => {
      if (old.length + chunk.length > 8_000_000) {
        p.kill("SIGKILL");
        return old;
      }
      return old + chunk.toString();
    };
    p.stdout.on("data", (b) => {
      stdout = append(stdout, b);
    });
    p.stderr.on("data", (b) => {
      stderr = append(stderr, b);
    });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(kill);
      ended = true;
    };
    p.on("error", (e) => {
      cleanup();
      rej(
        new DomainError(
          signal?.aborted ? "CANCELLED" : "WORKER_UNAVAILABLE",
          e.message,
        ),
      );
    });
    p.on("close", (code) => {
      if (ended) return;
      cleanup();
      if (code === 0) res({ stdout, stderr });
      else
        rej(
          new DomainError(
            signal?.aborted ? "CANCELLED" : "WORKER_FAILED",
            stderr.slice(-4000) || `Worker exit ${code}`,
          ),
        );
    });
  });
}
export async function worker<T>(
  kind: "cad" | "geometry",
  request: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "bwc-worker-"));
  const input = join(dir, "request.json"),
    output = join(dir, "response.json");
  writeFileSync(input, JSON.stringify(request));
  try {
    if (kind === "cad")
      await runProcess(
        "dotnet",
        [
          join(ROOT, "apps/workers/cad/bin/Release/net8.0/CadWorker.dll"),
          input,
          output,
        ],
        signal,
      );
    else
      await runProcess(
        process.env.BWC_PYTHON ??
          (existsSync(join(ROOT, ".venv/bin/python"))
            ? join(ROOT, ".venv/bin/python")
            : "python3"),
        [join(ROOT, "apps/workers/geometry/worker.py"), input, output],
        signal,
      );
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
