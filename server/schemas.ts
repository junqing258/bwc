import { z } from "zod";
export const OperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("set_measurement_parameter"),
      field: z.literal("uniform_thickness"),
      value: z.number().positive().finite(),
      unit: z.enum(["mm", "cm", "m"]),
      unitBinding: z.enum(["physical_quantity", "source_geometry"]),
      sourceOccurrenceId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_business"),
      classification: z.string().max(100).optional(),
      material: z.string().max(100).optional(),
      floor: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_holes"),
      holes: z.array(z.string()).max(10000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_units"),
      metresPerDrawingUnit: z.number().positive().finite().max(1e9),
      evidence: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("move_entities"),
      delta: z.tuple([
        z.number().finite(),
        z.number().finite(),
        z.number().finite(),
      ]),
      coordinateSystem: z.literal("drawing_wcs"),
      unit: z.enum(["m", "mm", "drawing_unit"]),
      scope: z.literal("entity"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_layer"),
      value: z.string().min(1).max(255),
      scope: z.literal("entity"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_text"),
      value: z.string().max(10000),
      scope: z.literal("entity"),
    })
    .strict(),
]);
export const FilterSchema = z
  .object({
    entityTypes: z.array(z.string()).max(100).optional(),
    layers: z.array(z.string()).max(1000).optional(),
    text: z.string().max(1000).optional(),
    space: z.string().optional(),
    classification: z.string().optional(),
    rectangle: z
      .tuple([
        z.number().finite(),
        z.number().finite(),
        z.number().finite(),
        z.number().finite(),
      ])
      .refine((v) => v[0] <= v[2] && v[1] <= v[3])
      .optional(),
  })
  .strict();
export const SelectionRef = z
  .object({ id: z.string(), version: z.literal(1) })
  .strict();
export const ContextSchema = z.object({
  projectId: z.string(),
  workingRevision: z.string().optional(),
  geometrySnapshotId: z.string().optional(),
});
export const ErrorMessages: Record<string, string> = {
  REVISION_CONFLICT: "当前修订已变化，请刷新后重新生成差异",
  UNITS_UNCONFIRMED: "请先确认图纸单位",
  ROUNDTRIP_UNVERIFIED: "图纸保持或独立 CAD 往返验证尚未通过",
  HOST_UNAVAILABLE: "AI 宿主不可用，人工工具仍可使用",
};
