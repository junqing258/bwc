import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
export const now = () => new Date().toISOString();
export const id = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export function canonical(x: any): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object")
    return `{${Object.keys(x)
      .filter((k) => x[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
      .join(",")}}`;
  return JSON.stringify(x);
}
export function atomicJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function within(root: string, relative: string) {
  const p = resolve(root, relative);
  if (!p.startsWith(resolve(root) + sep))
    fail("INVALID_PATH", "路径必须在项目内");
  return p;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string, details?: unknown): never {
  throw new DomainError(code, message, details);
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) fail(code, message);
}
