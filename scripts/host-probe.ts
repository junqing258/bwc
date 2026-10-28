import { JsonRpcProcess } from "../apps/server/rpc.ts";
import { ROOT } from "../apps/server/workers.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const notifications: any[] = [];
const client = new JsonRpcProcess("codex", ["app-server"], {
  cwd: ROOT,
  onNotification: (method, params) => {
    if (!method.includes("delta"))
      notifications.push({ method, threadId: params.threadId });
  },
  onExit: () => {},
});
try {
  const init = await client.request("initialize", {
    clientInfo: { name: "bwc_protocol_probe", version: "0.1.0" },
  });
  client.notify("initialized");
  const r = await client.request(
    "thread/start",
    { cwd: ROOT, approvalPolicy: "never", sandbox: "read-only" },
    60000,
  );
  const read = await client.request("thread/read", {
    threadId: r.thread.id,
    includeTurns: false,
  });
  let fullHistory: any;
  try {
    await client.request("thread/read", {
      threadId: r.thread.id,
      includeTurns: true,
    });
    fullHistory = { status: "supported" };
  } catch (e) {
    fullHistory = { status: "unsupported", error: (e as Error).message };
  }
  const report = {
    at: new Date().toISOString(),
    host: "codex",
    initialize: init,
    threadId: r.thread.id,
    readStatus: read.thread.status,
    fullHistory,
    notifications,
    modelTaskSent: false,
    claude: {
      status: "not_integrated",
      reason:
        "Codex App Server selected for structured persistent thread/turn bridge; Claude print/stream-json CLI only inventoried; comparative behavioral acceptance pending",
    },
  };
  mkdirSync(join(ROOT, "docs/evidence"), { recursive: true });
  writeFileSync(
    join(ROOT, "docs/evidence/host-protocol-probe.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  client.stop();
}
