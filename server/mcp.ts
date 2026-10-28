import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolRegistry } from "./tools.ts";
import type { WorkflowService } from "./service.ts";
import { z } from "zod";
import { FilterSchema } from "./schemas.ts";
// MCP consumers commonly reject draft-07 tuple `items: [...]` inside a union.
// Keep the model-facing schema portable; the HTTP service still validates the
// original discriminated operation schema before executing any domain action.
const portableOperation = z
  .object({
    kind: z.enum([
      "set_measurement_parameter",
      "set_business",
      "set_holes",
      "set_units",
      "move_entities",
      "set_layer",
      "set_text",
    ]),
    field: z.literal("uniform_thickness").optional(),
    value: z.union([z.number(), z.string()]).optional(),
    unit: z.enum(["mm", "cm", "m", "drawing_unit"]).optional(),
    unitBinding: z.enum(["physical_quantity", "source_geometry"]).optional(),
    sourceOccurrenceId: z.string().optional(),
    classification: z.string().optional(),
    material: z.string().optional(),
    floor: z.string().optional(),
    holes: z.array(z.string()).optional(),
    metresPerDrawingUnit: z.number().optional(),
    evidence: z.string().optional(),
    delta: z.array(z.number()).length(3).optional(),
    coordinateSystem: z.literal("drawing_wcs").optional(),
    scope: z.literal("entity").optional(),
  })
  .strict();
const server = new McpServer({ name: "bwc-dwg-workflow", version: "0.1.0" });
const registry = toolRegistry({} as WorkflowService);
for (const [name, tool] of Object.entries(registry)) {
  if (["project_list", "dwg_import"].includes(name)) continue;
  const readOnly = [
    "project_open",
    "dwg_capabilities",
    "job_get",
    "dwg_summary",
    "dwg_layers",
    "dwg_query",
    "dwg_get",
    "selection_get",
    "issue_list",
    "change_preview",
    "takeoff_get",
    "export_verify",
    "viewer_open",
  ].includes(name);
  server.registerTool(
    name,
    {
      description: tool.description,
      inputSchema:
        name === "change_propose"
          ? { ...tool.schema.shape, operation: portableOperation }
          : name === "dwg_query" || name === "selection_create"
            ? {
                ...tool.schema.shape,
                filter: FilterSchema.extend({
                  rectangle: z.array(z.number()).length(4).optional(),
                }).optional(),
              }
            : tool.schema.shape,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint:
          readOnly ||
          [
            "change_apply",
            "change_propose",
            "takeoff_run",
            "dwg_check",
            "result_export",
            "dwg_export",
          ].includes(name),
      },
    },
    async (input: any) => {
      try {
        const response = await fetch(
          `${process.env.BWC_URL ?? "http://127.0.0.1:4310"}/api/mcp`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.BWC_SERVICE_TOKEN ?? ""}`,
            },
            body: JSON.stringify({
              tool: name,
              input,
              projectId: process.env.BWC_PROJECT_ID,
              sessionId: process.env.BWC_SESSION_ID,
            }),
          },
        );
        const result = await response.json();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: !response.ok,
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: {
                  code: "HOST_UNAVAILABLE",
                  message: (e as Error).message,
                },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
await server.connect(new StdioServerTransport());
