import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
for (const [cmd, args] of [
  ["dotnet", ["build", "apps/workers/cad", "-c", "Release"]],
  ["uv", ["venv", "--python", "3.12", ".venv"]],
  [
    "uv",
    [
      "pip",
      "install",
      "--python",
      resolve(root, ".venv/bin/python"),
      "-r",
      "apps/workers/geometry/requirements.txt",
    ],
  ],
]) {
  if (
    cmd === "uv" &&
    args[0] === "venv" &&
    existsSync(resolve(root, ".venv/bin/python"))
  )
    continue;
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
