import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const out = join(root, "release/bwc-macos-arm64");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("首版发行包必须在 macOS arm64 构建");
rmSync(join(root, ".cache/plugin-code"), { recursive: true, force: true });
run("npx", ["tsc", "--project", "tsconfig.plugin.json"]);
run("npm", ["run", "build:reviewer"]);
run("dotnet", [
  "publish",
  "apps/workers/cad",
  "-c",
  "Release",
  "--self-contained",
  "false",
  "-o",
  join(root, ".cache/cad-publish"),
]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, ".cache/plugin-code/apps"), join(out, "apps"), {
  recursive: true,
});
cpSync(join(root, ".cache/reviewer"), join(out, "reviewer"), {
  recursive: true,
});
cpSync(join(root, ".cache/cad-publish"), join(out, "workers/cad"), {
  recursive: true,
});
mkdirSync(join(out, "workers/geometry"), { recursive: true });
for (const name of ["worker.py", "requirements.txt"])
  cpSync(
    join(root, "apps/workers/geometry", name),
    join(out, "workers/geometry", name),
  );
for (const name of ["plugin.json", "mcp.json"])
  cpSync(join(root, name), join(out, name));
cpSync(join(root, "skills/dwg-workflow"), join(out, "skills/dwg-workflow"), {
  recursive: true,
});
mkdirSync(join(out, "scripts"), { recursive: true });
for (const name of ["runtime-lock.py", "doctor.mjs"])
  cpSync(join(root, "scripts", name), join(out, "scripts", name));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "bwc-workspace",
      version: JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"))
        .version,
      type: "module",
      private: true,
      engines: pkg.engines,
      scripts: {
        doctor: "node scripts/doctor.mjs",
        bwc: "node apps/server/cli.js",
        mcp: "node apps/server/plugin-mcp.js",
      },
      dependencies: {
        "@modelcontextprotocol/sdk":
          pkg.dependencies["@modelcontextprotocol/sdk"],
        zod: pkg.dependencies.zod,
      },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(out, "workers/runtime.json"),
  JSON.stringify({
    platform: "darwin-arm64",
    node: "preinstalled >=22.13",
    dotnet: "preinstalled >=8",
    python: "preinstalled >=3.10",
    numpy: "preinstalled 2.2.6",
    shapely: "preinstalled 2.1.2",
    codex: "0.165.0",
    autostart: false,
  }),
);
cpSync(join(root, "docs/plugin-runtime.md"), join(out, "README.md"));
run(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  out,
);
// Install into a local marketplace without changing the developer's Codex configuration.
const market = join(root, "release/.agents/plugins");
mkdirSync(market, { recursive: true });
writeFileSync(
  join(market, "marketplace.json"),
  JSON.stringify(
    {
      name: "bwc-local",
      plugins: [
        {
          name: "bwc-workspace",
          source: { source: "local", path: "./bwc-macos-arm64" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    },
    null,
    2,
  ),
);
console.log(`Built ${out}`);

run("tar", [
  "-czf",
  join(root, "release/bwc-macos-arm64.tar.gz"),
  "-C",
  join(root, "release"),
  ".agents",
  "bwc-macos-arm64",
]);

run("python3", [
  join(root, "scripts/package-plugin.py"),
  out,
  join(root, "release/bwc-macos-arm64.zip"),
]);
