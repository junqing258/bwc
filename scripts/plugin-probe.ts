// Acceptance probe only. The distributed plugin never imports or starts a Codex host.
import { JsonRpcProcess } from "../apps/server/rpc.ts";
import { resolve, join } from "node:path";
import { atomicJson } from "../apps/server/util.ts";
const client = new JsonRpcProcess("codex", ["app-server"], {
  cwd: resolve("release"),
  onNotification: () => {},
  onExit: () => {},
});
try {
  const init = await client.request("initialize", {
    clientInfo: { name: "bwc_plugin_spike", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");
  const { plugin } = await client.request("plugin/read", {
    marketplacePath: resolve("release/.agents/plugins/marketplace.json"),
    pluginName: "bwc-workspace",
  });
  const skills = await client.request("skills/list", {
    cwds: [resolve("release")],
    forceReload: true,
  });
  const visible = (skills.data ?? [])
    .flatMap((entry: any) => entry.skills ?? [])
    .filter((skill: any) => skill.path?.includes("bwc-workspace"));
  const inventory = await client.request("mcpServerStatus/list", {
    detail: "toolsAndAuthOnly",
    limit: 100,
  });
  const report = {
    inventory: inventory.data
      .filter(
        (server: any) =>
          server.pluginId?.includes("bwc-workspace") ||
          server.name.includes("bwc"),
      )
      .map((server: any) => ({
        name: server.name,
        pluginId: server.pluginId,
        runtimeStatus: server.runtimeStatus,
        tools: Object.keys(server.tools ?? {}),
        toolsError: server.toolsError,
      })),
    at: new Date().toISOString(),
    codex: init.userAgent,
    plugin: {
      name: plugin.summary?.name,
      skills: plugin.skills,
      mcpServers: plugin.mcpServers,
    },
    visibleSkills: visible.map((skill: any) => ({
      name: skill.name,
      path: skill.path,
    })),
    modelTaskSent: false,
  };
  atomicJson(resolve("docs/evidence/plugin-host-spike.json"), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  client.stop();
}
