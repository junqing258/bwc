import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  atomicJson,
  canonical,
  hash,
  id,
  now,
  readJson,
  assert,
  within,
} from "./util.ts";
import type {
  Project,
  Snapshot,
  Revision,
  Artifact,
  Occurrence,
} from "./types.ts";
import { bounds } from "./geometry.ts";
export class ProjectStore {
  db: DatabaseSync;
  constructor(public path: string) {
    mkdirSync(path, { recursive: true });
    this.db = new DatabaseSync(join(path, "project.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS occurrences(n INTEGER PRIMARY KEY,snapshot TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(snapshot,id));
      CREATE VIRTUAL TABLE IF NOT EXISTS spatial USING rtree(n,minX,maxX,minY,maxY);
      CREATE INDEX IF NOT EXISTS snapshot_index ON occurrences(snapshot);`);
  }
  put(kind: string, data: any, recordId = data.id) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json",
      )
      .run(kind, recordId, JSON.stringify(data));
    return data;
  }
  get<T = any>(kind: string, recordId: string): T {
    const row = this.db
      .prepare("SELECT json FROM records WHERE kind=? AND id=?")
      .get(kind, recordId) as { json: string } | undefined;
    assert(row, "NOT_FOUND", `${kind}/${recordId} 不存在`);
    return JSON.parse(row.json);
  }
  has(kind: string, recordId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM records WHERE kind=? AND id=?")
      .get(kind, recordId);
  }
  all<T = any>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT json FROM records WHERE kind=? ORDER BY rowid")
        .all(kind) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  meta() {
    const p = this.get<Project & { projectId?: string }>("project", "meta");
    return { ...p, id: p.projectId ?? p.id };
  }
  updateMeta(patch: Partial<Project>) {
    const p = { ...this.meta(), ...patch };
    this.put("project", p, "meta");
    this.writeManifest();
    return p;
  }
  writeManifest() {
    atomicJson(join(this.path, "project.json"), this.meta());
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(channel: string, payload: any) {
    const data = { eventId: id("evt"), at: now(), ...payload };
    const result = this.db
      .prepare("INSERT INTO events(channel,json) VALUES(?,?)")
      .run(channel, JSON.stringify(data));
    return { ...data, sequence: Number(result.lastInsertRowid) };
  }
  events(channel: string, after = 0, limit = 500) {
    return (
      (channel === "*"
        ? this.db
            .prepare(
              "SELECT seq,channel,json FROM events WHERE seq>? ORDER BY seq LIMIT ?",
            )
            .all(after, limit)
        : this.db
            .prepare(
              "SELECT seq,channel,json FROM events WHERE channel=? AND seq>? ORDER BY seq LIMIT ?",
            )
            .all(channel, after, limit)) as {
        seq: number;
        channel: string;
        json: string;
      }[]
    ).map((r) => ({
      ...JSON.parse(r.json),
      channel: r.channel,
      ...(r.channel.startsWith("session:")
        ? { sessionId: r.channel.slice(8) }
        : {}),
      sequence: r.seq,
    }));
  }
  current() {
    const m = this.meta();
    assert(m.currentRevision, "PROJECT_EMPTY", "请先导入图纸");
    return this.get<Revision>("revision", m.currentRevision);
  }
  context(revisionId?: string, snapshotId?: string) {
    const revision = revisionId
      ? this.get<Revision>("revision", revisionId)
      : this.current();
    assert(
      !snapshotId || snapshotId === revision.geometrySnapshotId,
      "SNAPSHOT_MISMATCH",
      "修订与几何快照不匹配",
    );
    const snapshot = this.get<Snapshot>(
      "snapshot",
      revision.geometrySnapshotId,
    );
    const content = Object.fromEntries(
      Object.entries(snapshot).filter(
        ([k]) => !["id", "fingerprint", "createdAt"].includes(k),
      ),
    );
    assert(
      hash(canonical(content)) === snapshot.fingerprint,
      "ARTIFACT_CORRUPT",
      "快照清单指纹不匹配",
    );
    return { revision, snapshot };
  }
  file(path: string, expectedSha256: string) {
    const resolved = within(this.path, path);
    assert(
      hash(readFileSync(resolved)) === expectedSha256,
      "ARTIFACT_CORRUPT",
      "文件指纹不匹配",
    );
    return resolved;
  }
  artifact(snapshot: Snapshot): Artifact {
    const path = within(this.path, snapshot.artifactPath);
    const raw = readFileSync(path);
    assert(
      hash(raw) === snapshot.artifactSha256,
      "ARTIFACT_CORRUPT",
      "几何产物指纹不匹配",
    );
    return JSON.parse(raw.toString());
  }
  saveSnapshot(
    input: Omit<Snapshot, "id" | "fingerprint" | "createdAt">,
    artifact?: Artifact,
  ): Snapshot {
    const fingerprint = hash(canonical(input));
    const sid = `gs_${fingerprint}`;
    if (this.has("snapshot", sid)) return this.get("snapshot", sid);
    const snap = { ...input, id: sid, fingerprint, createdAt: now() };
    atomicJson(join(this.path, "revisions", sid, "manifest.json"), snap);
    this.transaction(() => {
      this.put("snapshot", snap);
      const insert = this.db.prepare(
        "INSERT INTO occurrences(snapshot,id,json) VALUES(?,?,?)",
      );
      const spatial = this.db.prepare("INSERT INTO spatial VALUES(?,?,?,?,?)");
      for (const o of (artifact ?? this.artifact(snap)).occurrences) {
        const result = insert.run(sid, o.occurrenceId, JSON.stringify(o));
        const b = bounds(o.geometry);
        if (b) spatial.run(result.lastInsertRowid, b[0], b[2], b[1], b[3]);
      }
    });
    return snap;
  }
  occurrences(snapshot: string, rectangle?: number[]): Occurrence[] {
    const rows = rectangle
      ? this.db
          .prepare(
            "SELECT o.json FROM occurrences o JOIN spatial s ON o.n=s.n WHERE snapshot=? AND s.maxX>=? AND s.minX<=? AND s.maxY>=? AND s.minY<=? ORDER BY o.n",
          )
          .all(snapshot, rectangle[0], rectangle[2], rectangle[1], rectangle[3])
      : this.db
          .prepare("SELECT json FROM occurrences WHERE snapshot=? ORDER BY n")
          .all(snapshot);
    return (rows as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  close() {
    this.db.close();
  }
}
export class Catalog {
  stores = new Map<string, ProjectStore>();
  constructor(public root: string) {
    mkdirSync(root, { recursive: true });
  }
  create(name: string) {
    const pid = id("p");
    const store = new ProjectStore(join(this.root, pid));
    store.put("project", {
      id: "meta",
      projectId: pid,
      name,
      schemaVersion: 1,
      createdAt: now(),
      currentRevision: null,
      dataPolicy: {
        id: id("dp"),
        mode: "summary",
        provider: "Codex CLI 配置的模型服务方",
      },
    });
    store.writeManifest();
    this.stores.set(pid, store);
    return { projectId: pid, ...store.meta() };
  }
  open(pid: string) {
    assert(/^p_[a-f0-9]{32}$/.test(pid), "INVALID_PROJECT", "项目 ID 无效");
    if (!this.stores.has(pid)) {
      const p = join(this.root, pid);
      assert(existsSync(join(p, "project.sqlite")), "NOT_FOUND", "项目不存在");
      this.stores.set(pid, new ProjectStore(p));
    }
    return this.stores.get(pid)!;
  }
  list() {
    return readdirSync(this.root)
      .filter(
        (p) =>
          /^p_[a-f0-9]{32}$/.test(p) &&
          existsSync(join(this.root, p, "project.sqlite")),
      )
      .map((p) => ({ ...this.open(p).meta(), projectId: p }));
  }
  close() {
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
  }
}
