import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "..");
const checks = [];
const add = (name, ok, remedy) =>
  checks.push({ name, ok, ...(ok ? {} : { remedy }) });
add(
  "macOS arm64",
  process.platform === "darwin" && process.arch === "arm64",
  "首版仅验证 macOS arm64；其他平台尚未验收。",
);
const [major, minor] = process.versions.node.split(".").map(Number);
add(
  "Node 22.13+",
  major > 22 || (major === 22 && minor >= 13),
  "安装 Node 22.13 或更新版本。",
);
const dotnet = spawnSync("dotnet", ["--list-runtimes"], { encoding: "utf8" });
add(
  ".NET 8+ runtime",
  dotnet.status === 0 &&
    /Microsoft.NETCore.App (?:[89]|[1-9]\d)\./.test(dotnet.stdout),
  "安装 .NET 8 macOS Arm64 运行时，并将 dotnet 加入 PATH。",
);
const python = process.env.BWC_PYTHON ?? "python3";
const result = spawnSync(
  python,
  [
    "-c",
    "import sys,numpy,shapely; assert sys.version_info >= (3,10); assert numpy.__version__ == '2.2.6'; assert shapely.__version__ == '2.1.2'",
  ],
  { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
);
add(
  "Python 3.10+ / numpy 2.2.6 / shapely 2.1.2",
  result.status === 0,
  "在用户可写目录创建 Python 虚拟环境，安装 workers/geometry/requirements.txt，设置 BWC_PYTHON 为该解释器绝对路径。",
);
const lock = spawnSync(
  process.env.BWC_LOCK_PYTHON ?? "python3",
  ["-c", "import fcntl,sys; assert sys.version_info >= (3,10)"],
  { encoding: "utf8" },
);
add(
  "POSIX advisory lock",
  lock.status === 0,
  "安装 Python 3.10+（含 fcntl），设置 BWC_LOCK_PYTHON 为其绝对路径。",
);
for (const path of [
  "apps/server/cli.js",
  "apps/server/plugin-mcp.js",
  "reviewer/review.html",
  "workers/cad/CadWorker.dll",
  "workers/geometry/worker.py",
])
  add(
    path,
    existsSync(join(root, path)),
    "发行包不完整，请重新安装；不要在安装目录临时构建。",
  );
console.log(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2));
if (checks.some((c) => !c.ok)) process.exitCode = 1;
