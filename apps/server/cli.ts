import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  connectRuntime,
  ensureRuntime,
  runtimeRequest,
} from "./runtime-client.ts";
import { assert } from "./util.ts";
import { modelError } from "./model-output.ts";

export async function cli(args: string[]) {
  const [command, subcommand, rootArg, payload] = args;
  if (command === "runtime") {
    assert(
      rootArg,
      "INVALID_INPUT",
      "用法：bwc runtime start|status|stop <绝对路径>",
    );
    const root = realpathSync(rootArg);
    if (subcommand === "start") {
      const c = await ensureRuntime(root);
      return {
        workspaceId: c.descriptor.workspaceId,
        root,
        instanceId: c.descriptor.instanceId,
        state: c.descriptor.state,
      };
    }
    const c = await connectRuntime(root);
    if (subcommand === "status")
      return c
        ? { ...c.descriptor }
        : {
            root,
            state: "unavailable",
            logPath: `${root}/.bwc/run/runtime.log`,
          };
    assert(
      subcommand === "stop" && c,
      "RUNTIME_UNAVAILABLE",
      "运行时不可用；不会自动终止锁持有者，请检查日志",
    );
    return runtimeRequest(c, "/stop");
  }
  if (command === "policy") {
    assert(
      rootArg && ["summary", "geometry"].includes(subcommand),
      "INVALID_INPUT",
      "用法：bwc policy summary|geometry <绝对路径> [快照ID的JSON数组]（人工入口，不得由模型调用）",
    );
    const c = await ensureRuntime(realpathSync(rootArg));
    return runtimeRequest(c, "/local/policy", {
      mode: subcommand,
      snapshotIds: payload ? JSON.parse(payload) : [],
    });
  }
  if (command === "call") {
    const [_, root, tool, json = "{}"] = args;
    const c = await ensureRuntime(realpathSync(root));
    return runtimeRequest(c, "/call", {
      tool,
      input: { ...JSON.parse(json), workspaceId: c.descriptor.workspaceId },
    });
  }
  if (command === "workspace" && subcommand === "open") {
    const c = await ensureRuntime(realpathSync(rootArg));
    return runtimeRequest(c, "/call", {
      tool: "workspace_status",
      input: { workspaceId: c.descriptor.workspaceId },
    });
  }
  return {
    usage: [
      "bwc workspace open <root>",
      "bwc runtime start|status|stop <root>",
      "bwc call <root> <tool> '<JSON>'",
      "bwc policy summary|geometry <root> '[snapshotId,...]' (human only)",
    ],
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  cli(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result?.error) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(JSON.stringify(modelError(error)));
      process.exitCode = 1;
    });
