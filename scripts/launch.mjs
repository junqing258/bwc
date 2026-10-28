import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const url = "http://127.0.0.1:4310";
const open = () => {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore" }).on("error", () =>
    console.log(`请在浏览器打开 ${url}`),
  );
};
try {
  const r = await fetch(url + "/api/health", {
    signal: AbortSignal.timeout(1000),
  });
  if (r.ok && (await r.json()).schemaVersion === 1) {
    open();
    process.exit(0);
  }
} catch {}
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("请安装 Node.js 22.13 或更新版本");
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} 失败，请查看上方说明`);
};
if (!existsSync(resolve(root, "node_modules"))) run("npm", ["ci"]);
run("npm", ["run", "setup"]);
run("npm", ["run", "build"]);
const child = spawn(
  process.execPath,
  [
    "--import",
    new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    resolve(root, "server/main.ts"),
  ],
  { cwd: root, stdio: "inherit" },
);
child.on("error", (e) => console.error(e.message));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(url + "/api/health");
    if (r.ok) {
      open();
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}
