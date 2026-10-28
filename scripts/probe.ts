import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { worker, ROOT } from "../apps/server/workers.ts";
import { WorkflowService } from "../apps/server/service.ts";
import { hash, now } from "../apps/server/util.ts";
import type { Artifact } from "../apps/server/types.ts";
const service = new WorkflowService();
await service.fixture();
const samples = service.samples();
const rows: any[] = [];
mkdirSync(join(ROOT, "docs/evidence"), { recursive: true });
mkdirSync(join(ROOT, ".cache/probe"), { recursive: true });
for (const sample of samples) {
  process.stdout.write(`Parsing ${sample.name} … `);
  const started = performance.now();
  try {
    const a = await worker<Artifact>("cad", {
      mode: "parse",
      input: sample.path,
    });
    const counts: Record<string, number> = {};
    for (const o of a.occurrences)
      counts[o.entityType] = (counts[o.entityType] ?? 0) + 1;
    const gaps: Record<string, number> = {};
    for (const d of a.diagnostics) gaps[d.code] = (gaps[d.code] ?? 0) + 1;
    const classes: Record<string, number> = {};
    for (const n of a.notifications) {
      const m = n.match(/DXF name\s+(\S+)/);
      if (m) classes[m[1]] = (classes[m[1]] ?? 0) + 1;
    }
    let roundtrip: any;
    try {
      const out = await worker<Artifact>("cad", {
        mode: "export",
        input: sample.path,
        output: join(ROOT, ".cache/probe", sample.id + ".roundtrip.dwg"),
      });
      roundtrip = {
        status: out.roundtrip?.stateEqual
          ? "supported_state_equal"
          : "supported_state_changed",
        ...out.roundtrip,
        completeDelivery: false,
      };
    } catch (e) {
      roundtrip = {
        status: "failed",
        error: (e as Error).message.slice(0, 2000),
        completeDelivery: false,
      };
    }
    const record = {
      name: basename(sample.path),
      source: sample.source,
      sha256: hash(readFileSync(sample.path)),
      sizeBytes: readFileSync(sample.path).byteLength,
      format: readFileSync(sample.path).subarray(0, 6).toString(),
      parser: "ACadSharp 3.8.30",
      status: "parsed",
      sourceEntityCount: a.sourceEntityCount,
      sourceRecordCount: a.sourceRecordCount,
      occurrenceCount: a.occurrences.length,
      entityTypes: counts,
      insUnits: a.insUnits,
      diagnosticCount: a.diagnostics.length,
      diagnosticsByCode: gaps,
      notificationCount: a.notifications.length,
      unknownNotificationClasses: classes,
      dependencies: a.dependencies,
      resources: a.resources ?? [],
      registeredClasses: a.classes ?? [],
      sourceTypes: a.sources.reduce((count: Record<string, number>, o) => {
        count[o.type] = (count[o.type] ?? 0) + 1;
        return count;
      }, {}),
      importCompleteness: a.importCompleteness,
      workerSeconds: a.readSeconds,
      wallSeconds: (performance.now() - started) / 1000,
      peakWorkingSetBytes:
        a.peakWorkingSetBytes > 0 ? a.peakWorkingSetBytes : null,
      peakMemoryStatus:
        a.peakWorkingSetBytes > 0
          ? "measured"
          : "dotnet_metric_unavailable_on_this_platform",
      conversionVerification:
        sample.source === "controlled_fixture"
          ? "not_applicable"
          : "not_verified",
      programmaticNoopRoundtrip: roundtrip,
      independentCad: "not_run",
      originalT3Pair: "not_provided",
      completeDelivery: false,
    };
    rows.push(record);
    writeFileSync(
      join(ROOT, ".cache/probe", sample.id + ".json"),
      JSON.stringify(a),
    );
    console.log(
      `${a.sourceEntityCount} records / ${a.occurrences.length} occurrences / ${a.diagnostics.length} diagnostics`,
    );
  } catch (e) {
    rows.push({
      name: sample.name,
      status: "failed",
      error: (e as Error).message,
    });
    console.log("failed");
  }
}
const report = {
  schemaVersion: 1,
  createdAt: now(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  scope:
    "seven real files plus one controlled fixture; parsing and programmatic no-op write probes, no independent CAD acceptance",
  samples: rows,
};
writeFileSync(
  join(ROOT, "docs/evidence/sample-probe.json"),
  JSON.stringify(report, null, 2),
);
writeFileSync(
  join(ROOT, "docs/evidence/样本解析实测.md"),
  `# 样本解析实测\n\n生成时间：${report.createdAt}。${report.platform}/${report.architecture}，ACadSharp 3.8.30。计时为本机单次测量，不代表性能承诺。\n\n| 文件 | 版本 | 模型源实体 | 展开实例 | 诊断 | 读取通知 | 解析秒 | 状态 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |\n${rows.map((r) => `| ${r.name} | ${r.format ?? "—"} | ${r.sourceEntityCount ?? "—"} | ${r.occurrenceCount ?? "—"} | ${r.diagnosticCount ?? "—"} | ${r.notificationCount ?? "—"} | ${r.workerSeconds?.toFixed(2) ?? "—"} | ${r.importCompleteness ?? r.status} |`).join("\n")}\n\n原图/T3 同修订配对样本和独立 CAD 参考均未提供，转换核验未完成。此报告证明读取与提取的实际范围，并在 JSON 中记录不修改另存的程序探测；程序指纹相等也不证明未知载荷、完整对象属性或独立 CAD 保持。不证明全图完整显示、构件语义、全图工程量或完整另存。完整分类、指纹与未支持对象类型见 sample-probe.json。macOS 上 .NET 峰值内存计数返回 0，报告保留 null，不作为内存实测值。\n`,
);
service.close();
