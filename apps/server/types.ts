export type Vec3 = [number, number, number];
export type Segment =
  | { kind: "line"; start: Vec3; end: Vec3 }
  | {
      kind: "arc";
      center: Vec3;
      u: Vec3;
      v: Vec3;
      startAngle: number;
      sweep: number;
    };
export type Geometry =
  | { kind: "path"; closed: boolean; segments: Segment[] }
  | {
      kind: "region";
      islandStyle: "Normal" | "Outer" | "Ignore";
      loops: Extract<Geometry, { kind: "path" }>[];
      native?: unknown;
    }
  | {
      kind: "annotation";
      parts: Geometry[];
      quantityRole: "annotation_only";
      native?: unknown;
    }
  | { kind: "point"; position: Vec3; native?: unknown }
  | {
      kind: "text";
      text: string;
      position: Vec3;
      height: number;
      rotation: number;
      formatting: string;
    };
export interface Occurrence {
  occurrenceId: string;
  entityId: string;
  sourceHandle: string;
  entityType: string;
  layer: string;
  space: string;
  instancePath: {
    insertHandle: string;
    insertEntityId?: string;
    arrayCell?: { row: number; column: number };
  }[];
  occurrenceKey: string;
  geometry: Geometry | null;
  visible: boolean;
  color: string;
  matrix: number[];
}
export interface Artifact {
  schemaVersion: 1;
  coordinateContractVersion: string;
  parser: string;
  parserVersion: string;
  adapterVersion?: string;
  dwgVersion: string;
  insUnits: number;
  sourceEntityCount: number;
  sourceRecordCount: number;
  sources: {
    handle: string;
    type: string;
    owner: string;
    layer: string;
    geometry: Geometry | null;
    insert?: unknown;
  }[];
  occurrences: Occurrence[];
  layers: { name: string; isOn: boolean; isFrozen: boolean; color: string }[];
  blocks: unknown[];
  classes?: unknown[];
  resources?: {
    kind: string;
    style?: string;
    path: string;
    verification: string;
  }[];
  dependencies: { kind: string; path: string; blockName?: string }[];
  diagnostics: {
    code: string;
    handle?: string;
    entityType?: string;
    reason?: string;
  }[];
  notifications: string[];
  stateFingerprint: string;
  importCompleteness: "complete" | "partial";
  displayLimitations: string[];
  readSeconds: number;
  peakWorkingSetBytes: number;
  roundtrip?: { stateEqual: boolean; independentCad: string; scope: string };
}
export interface UnitProfile {
  id: string;
  confirmed: boolean;
  metresPerDrawingUnit: number | null;
  sourceInsUnits: number;
  evidence: string;
}
export interface Parameter {
  value: number;
  unit: string;
  unitBinding: "physical_quantity" | "source_geometry";
  normalizedMetres?: number;
  sourceOccurrenceId?: string;
  evidence: string;
}
export interface Business {
  classification?: string;
  material?: string;
  floor?: string;
  uniform_thickness?: Parameter;
  holes?: string[];
  evidence?: string;
}
export interface Snapshot {
  id: string;
  fingerprint: string;
  drawingVersion: string;
  parseArtifactVersion: string;
  coordinateContractVersion: string;
  artifactPath: string;
  artifactSha256: string;
  patches: NativePatch[];
  units: UnitProfile;
  business: Record<string, Business>;
  importCompleteness: "complete" | "partial";
  createdAt: string;
}
export interface Revision {
  id: string;
  parent: string | null;
  geometrySnapshotId: string;
  operationId: string;
  createdAt: string;
}
export interface Drawing {
  id: string;
  name: string;
  sha256: string;
  path: string;
  format: string;
  role: "original" | "compatible_copy";
  conversionRecordId?: string;
  sourcePath?: string;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  currentRevision: string | null;
  dataPolicy: {
    id: string;
    mode: "summary" | "geometry" | "source";
    provider: string;
  };
  schemaVersion: 1;
}
export interface Selection {
  id: string;
  version: 1;
  workingRevision: string;
  geometrySnapshotId: string;
  members: string[];
  filter?: Filter;
  evidence: string;
}
export interface Filter {
  entityTypes?: string[];
  layers?: string[];
  text?: string;
  space?: string;
  classification?: string;
  rectangle?: [number, number, number, number];
}
export interface NativePatch {
  kind: "move_entities" | "set_layer" | "set_text";
  handles: string[];
  delta?: Vec3;
  value?: string;
}
export type Operation =
  | {
      kind: "set_measurement_parameter";
      field: "uniform_thickness";
      value: number;
      unit: "mm" | "cm" | "m";
      unitBinding: "physical_quantity" | "source_geometry";
      sourceOccurrenceId?: string;
    }
  | {
      kind: "set_business";
      classification?: string;
      material?: string;
      floor?: string;
    }
  | { kind: "set_holes"; holes: string[] }
  | { kind: "set_units"; metresPerDrawingUnit: number; evidence: string }
  | {
      kind: "move_entities";
      delta: Vec3;
      coordinateSystem: "drawing_wcs";
      unit: "m" | "mm" | "drawing_unit";
      scope: "entity";
    }
  | { kind: "set_layer" | "set_text"; value: string; scope: "entity" };
export interface Intent {
  id: string;
  origin: "ui" | "message";
  text: string;
  workingRevision: string;
  selectionSet?: { id: string; version: number };
  operation?: Operation;
  messageId?: string;
  createdAt: string;
}
export interface Change {
  id: string;
  operationId: string;
  requestFingerprint: string;
  baseRevision: string;
  baseGeometrySnapshotId: string;
  selectionSet?: { id: string; version: number };
  operation: Operation;
  intentId: string;
  candidateSnapshotId: string;
  candidateFingerprint: string;
  diff: unknown[];
  status: "proposed" | "applied";
  appliedRevision?: string;
  trial?: unknown;
}
export interface Job {
  id: string;
  kind: string;
  operationId: string;
  requestFingerprint: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "partial"
    | "failed"
    | "cancelled"
    | "interrupted";
  stage: string;
  createdAt: string;
  workingRevision?: string;
  geometrySnapshotId?: string;
  result?: any;
  error?: { code: string; message: string };
}
export interface Issue {
  id: string;
  check: string;
  checkerVersion: string;
  status: "passed" | "failed" | "not_run" | "unsupported" | "not_applicable";
  severity: string;
  reason: string;
  occurrenceIds: string[];
  geometrySnapshotId: string;
  evidence?: unknown;
}
export interface Takeoff {
  id: string;
  workingRevision: string;
  geometrySnapshotId: string;
  selectionSet: { id: string; version: number };
  quantityKind: string;
  unit: string;
  knownSubtotal: number;
  completeTotal: number | null;
  completeness: "complete" | "partial";
  importCompleteness: string;
  conversionVerification: string;
  conversionRecordId: string | null;
  items: any[];
  validity: "valid" | "stale";
  methodVersion: string;
  unitProfileVersion: string;
  exclusions: string[];
}
