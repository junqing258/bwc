import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("scripts/package-plugin.py");
function invoke(...args: string[]) {
  const r = spawnSync("python3", [script, ...args], { encoding: "utf8" });
  return {
    status: r.status,
    result: JSON.parse(r.status === 0 ? r.stdout : r.stderr),
  };
}
function fixture(root: string) {
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, "skills/test"), { recursive: true });
  mkdirSync(join(plugin, "apps/server"), { recursive: true });
  writeFileSync(
    join(plugin, "plugin.json"),
    JSON.stringify({
      name: "test-plugin",
      version: "1.0.0",
      description: "test",
    }),
  );
  writeFileSync(
    join(plugin, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        test: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/apps/server/mcp.js"],
        },
      },
    }),
  );
  writeFileSync(
    join(plugin, "skills/test/SKILL.md"),
    "---\nname: test\ndescription: test\n---\nTest",
  );
  writeFileSync(join(plugin, "apps/server/mcp.js"), "// fixture");
  return plugin;
}
test("desktop ZIP contains one plugin root and a shipped MCP entry", () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-package-"));
  try {
    const plugin = fixture(root),
      zip = join(root, "plugin.zip");
    const built = invoke(plugin, zip);
    assert.equal(built.status, 0, JSON.stringify(built));
    assert.equal(built.result.pluginRoot, ".");
    assert.equal(built.result.skills, 1);
    assert.equal(invoke("--validate", zip).status, 0);
    rmSync(join(plugin, "apps/server/mcp.js"));
    assert.equal(invoke(plugin, join(root, "broken.zip")).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejects marketplace parents, non-ZIP archives and plugin ZIPs with sibling marketplace metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "bwc-package-invalid-"));
  try {
    const plugin = fixture(root);
    assert.equal(invoke(root, join(root, "out.zip")).status, 1);
    const tar = join(root, "marketplace.tar.gz");
    writeFileSync(tar, "not a ZIP");
    assert.equal(invoke("--validate", tar).status, 1);
    const zip = join(root, "siblings.zip");
    const result = spawnSync(
      "python3",
      [
        "-c",
        "import sys,zipfile,pathlib; z=zipfile.ZipFile(sys.argv[1], 'w'); z.write(pathlib.Path(sys.argv[2])/'plugin.json','plugin/plugin.json'); z.writestr('.agents/plugins/marketplace.json','{}'); z.close()",
        zip,
        plugin,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(invoke("--validate", zip).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
