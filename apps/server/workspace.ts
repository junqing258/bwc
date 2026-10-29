import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { Catalog, ProjectStore } from "./store.ts";
import {
  assert,
  atomicJson,
  canonical,
  hash,
  id,
  now,
  readJson,
} from "./util.ts";
import type { Revision, Snapshot } from "./types.ts";

export const WORKSPACE_SCHEMA = 1;
export interface WorkspaceManifest {
  schemaVersion: 1;
  databaseSchemaVersion: number;
  workspaceId: string;
  createdAt: string;
  config: { outputDirectory: string; idleTimeoutMs: number };
}

// The process holding runtime.lock is the only caller allowed to construct this catalog.
export class WorkspaceCatalog extends Catalog {
  db: DatabaseSync;
  manifest: WorkspaceManifest;
  constructor(public workspaceRoot: string) {
    assert(
      isAbsolute(workspaceRoot),
      "INVALID_WORKSPACE",
      "工作目录须为绝对路径",
    );
    workspaceRoot = realpathSync(workspaceRoot);
    assert(
      statSync(workspaceRoot).isDirectory(),
      "INVALID_WORKSPACE",
      "工作目录不存在",
    );
    const state = join(workspaceRoot, ".bwc");
    const manifestPath = join(state, "workspace.json");
    const manifest = existsSync(manifestPath)
      ? readJson<WorkspaceManifest>(manifestPath)
      : null;
    assert(
      !manifest ||
        (manifest.schemaVersion === 1 &&
          manifest.databaseSchemaVersion <= WORKSPACE_SCHEMA),
      "SCHEMA_TOO_NEW",
      "请升级插件后再打开此工作目录",
    );
    super(state);
    this.workspaceRoot = workspaceRoot;
    this.db = new DatabaseSync(join(state, "workspace.sqlite"));
    const version = (this.db.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (version > WORKSPACE_SCHEMA) {
      this.db.close();
      assert(false, "SCHEMA_TOO_NEW", "数据库版本高于插件支持版本");
    }
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    if (version === 0) {
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE drawings (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, discipline TEXT, floor TEXT, view_purpose TEXT,
          current_revision_id TEXT,
          FOREIGN KEY(id,current_revision_id) REFERENCES revisions(drawing_id,id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TABLE drawing_versions (
          id TEXT PRIMARY KEY, drawing_id TEXT NOT NULL REFERENCES drawings(id), sha256 TEXT NOT NULL,
          source_path TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('original','compatible_copy')),
          UNIQUE(drawing_id,id)
        );
        CREATE TABLE geometry_snapshots (
          id TEXT PRIMARY KEY, drawing_id TEXT NOT NULL, version_id TEXT NOT NULL,
          parser_version TEXT NOT NULL, artifact_hash TEXT NOT NULL, unit_profile_id TEXT NOT NULL,
          UNIQUE(drawing_id,id),
          FOREIGN KEY(drawing_id,version_id) REFERENCES drawing_versions(drawing_id,id)
        );
        CREATE TABLE revisions (
          id TEXT PRIMARY KEY, drawing_id TEXT NOT NULL REFERENCES drawings(id), parent_id TEXT,
          snapshot_id TEXT NOT NULL, business_version TEXT NOT NULL,
          UNIQUE(drawing_id,id), UNIQUE(drawing_id,id,snapshot_id),
          FOREIGN KEY(drawing_id,parent_id) REFERENCES revisions(drawing_id,id),
          FOREIGN KEY(drawing_id,snapshot_id) REFERENCES geometry_snapshots(drawing_id,id)
        );
        CREATE TABLE input_manifests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
        CREATE TABLE input_manifest_members (
          manifest_id TEXT NOT NULL REFERENCES input_manifests(id), drawing_id TEXT NOT NULL,
          revision_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, PRIMARY KEY(manifest_id,drawing_id),
          FOREIGN KEY(drawing_id,revision_id,snapshot_id) REFERENCES revisions(drawing_id,id,snapshot_id)
        );
        PRAGMA user_version=1;
        COMMIT;`);
    }
    this.manifest = manifest ?? {
      schemaVersion: 1,
      databaseSchemaVersion: 1,
      workspaceId: id("ws"),
      createdAt: now(),
      config: { outputDirectory: "outputs/bwc", idleTimeoutMs: 300000 },
    };
    atomicJson(manifestPath, this.manifest);
    for (const dir of ["sources", "artifacts", "reviews", "cache", "run"])
      mkdirSync(join(state, dir), { recursive: true });
    // Initializes shared legacy tables; records are namespaced per drawing.
    new ProjectStore(state, { db: this.db, namespace: "workspace:" });
    if (!this.policy()) this.setPolicy("summary", "initialization");
  }
  policy(): any {
    const row = this.db
      .prepare(
        "SELECT json FROM records WHERE kind='workspace:policy' AND id='current'",
      )
      .get() as any;
    return row ? JSON.parse(row.json) : null;
  }
  setPolicy(
    mode: "summary" | "geometry",
    source: string,
    snapshotIds: string[] = [],
  ) {
    assert(
      mode === "summary" || snapshotIds.length > 0,
      "INVALID_POLICY_SCOPE",
      "详细资料授权须指定快照范围",
    );
    for (const sid of snapshotIds)
      assert(
        this.db
          .prepare("SELECT id FROM geometry_snapshots WHERE id=?")
          .get(sid),
        "NOT_FOUND",
        "授权快照不存在",
      );
    const before = this.policy();
    const after = {
      id: id("dp"),
      mode,
      snapshotIds: [...new Set(snapshotIds)].sort(),
      provider: "Codex 配置的模型服务方",
      at: now(),
    };
    const store = new ProjectStore(this.root, {
      db: this.db,
      namespace: "workspace:",
    });
    store.transaction(() => {
      store.put("policy", after, "current");
      store.put("policy_audit", {
        id: id("policy"),
        before,
        after,
        source,
        at: now(),
      });
    });
    return after;
  }
  override create(name: string) {
    const drawingId = id("d");
    this.db
      .prepare("INSERT INTO drawings(id,name) VALUES(?,?)")
      .run(drawingId, name);
    const store = this.open(drawingId);
    store.put(
      "project",
      {
        id: "meta",
        projectId: drawingId,
        name,
        schemaVersion: 1,
        createdAt: now(),
        currentRevision: null,
        dataPolicy: this.policy(),
      },
      "meta",
    );
    store.writeManifest();
    return { ...store.meta(), projectId: drawingId };
  }
  override open(drawingId: string): ProjectStore {
    assert(
      this.db.prepare("SELECT id FROM drawings WHERE id=?").get(drawingId),
      "DRAWING_NOT_FOUND",
      "图纸不属于此工作目录",
    );
    if (!this.stores.has(drawingId))
      this.stores.set(drawingId, new WorkspaceDrawingStore(this, drawingId));
    return this.stores.get(drawingId)!;
  }
  override list() {
    return (
      this.db.prepare("SELECT id FROM drawings ORDER BY rowid").all() as {
        id: string;
      }[]
    ).map(({ id }) => ({ ...this.open(id).meta(), projectId: id }));
  }
  freeze(
    members: { drawingId: string; revisionId: string; snapshotId: string }[],
  ) {
    assert(
      members.length > 0 &&
        new Set(members.map((m) => m.drawingId)).size === members.length,
      "INVALID_MANIFEST",
      "输入清单须非空且每张图纸仅出现一次",
    );
    const sorted = [...members].sort((a, b) =>
      a.drawingId.localeCompare(b.drawingId),
    );
    const fingerprint = hash(canonical(sorted)),
      manifestId = `im_${fingerprint}`;
    const store = this.open(sorted[0].drawingId);
    store.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO input_manifests VALUES(?,?,?)")
        .run(manifestId, fingerprint, now());
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO input_manifest_members VALUES(?,?,?,?)",
      );
      for (const m of sorted) {
        const { revision, snapshot } = this.open(m.drawingId).context(
          m.revisionId,
          m.snapshotId,
        );
        insert.run(manifestId, m.drawingId, revision.id, snapshot.id);
      }
    });
    return this.inputManifest(manifestId);
  }
  inputManifest(manifestId: string) {
    const manifest = this.db
      .prepare("SELECT * FROM input_manifests WHERE id=?")
      .get(manifestId);
    assert(manifest, "NOT_FOUND", "冻结输入清单不存在");
    return {
      ...manifest,
      id: manifestId,
      members: this.db
        .prepare(
          "SELECT drawing_id AS drawingId, revision_id AS revisionId,snapshot_id AS snapshotId FROM input_manifest_members WHERE manifest_id=? ORDER BY drawing_id",
        )
        .all(manifestId),
    };
  }
  override close() {
    this.stores.clear();
    this.db.close();
  }
}
class WorkspaceDrawingStore extends ProjectStore {
  constructor(
    private catalog: WorkspaceCatalog,
    private drawingId: string,
  ) {
    super(catalog.root, { db: catalog.db, namespace: `${drawingId}:` });
  }
  override meta() {
    return { ...super.meta(), dataPolicy: this.catalog.policy() };
  }
  override published(revision: Revision, snapshot: Snapshot) {
    const drawing = this.get("drawing", snapshot.drawingVersion);
    const artifact = this.artifact(snapshot);
    this.db
      .prepare("INSERT OR IGNORE INTO drawing_versions VALUES(?,?,?,?,?)")
      .run(
        drawing.id,
        this.drawingId,
        drawing.sha256,
        drawing.sourcePath ?? drawing.path,
        drawing.role,
      );
    this.db
      .prepare("INSERT OR IGNORE INTO geometry_snapshots VALUES(?,?,?,?,?,?)")
      .run(
        snapshot.id,
        this.drawingId,
        drawing.id,
        artifact.adapterVersion ?? artifact.parserVersion,
        snapshot.artifactSha256,
        snapshot.units.id,
      );
    this.db
      .prepare("INSERT INTO revisions VALUES(?,?,?,?,?)")
      .run(
        revision.id,
        this.drawingId,
        revision.parent,
        snapshot.id,
        hash(canonical(snapshot.business)),
      );
    this.db
      .prepare("UPDATE drawings SET current_revision_id=? WHERE id=?")
      .run(revision.id, this.drawingId);
  }
}
