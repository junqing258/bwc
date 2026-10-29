import type { ProjectStore } from "./store.ts";
import { id, now } from "./util.ts";

export function compactPayload(value: any, mode: string): any {
  if (Array.isArray(value)) {
    if (value.length > 50)
      return {
        items: value.slice(0, 50).map((v) => compactPayload(v, mode)),
        total: value.length,
        truncated: true,
      };
    return value.map((v) => compactPayload(v, mode));
  }
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "error" && v) {
        out[k] = modelError(v).error;
        continue;
      }
      if (
        mode === "summary" &&
        [
          "geometry",
          "diagnosticPreview",
          "matrix",
          "delta",
          "sources",
          "occurrences",
          "bounds",
          "boundary",
          "coordinates",
          "vertices",
          "points",
          "center",
          "startPoint",
          "endPoint",
          "controlPoints",
          "knots",
          "weights",
        ].includes(k)
      ) {
        out[k] = { omittedByDataPolicy: true };
        continue;
      }
      out[k] = compactPayload(v, mode);
    }
    return out;
  }
  return typeof value === "string" && value.length > 20000
    ? value.slice(0, 20000) + " [truncated]"
    : value;
}

export function modelOutput(
  store: ProjectStore,
  tool: string,
  value: unknown,
  context: Record<string, unknown> = {},
) {
  const policy = store.meta().dataPolicy;
  const snapshots = new Set<string>();
  const collect = (v: any) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") {
      if (typeof v.geometrySnapshotId === "string")
        snapshots.add(v.geometrySnapshotId);
      Object.values(v).forEach(collect);
    }
  };
  collect(value);
  collect(context);
  const scopes = (policy as any).snapshotIds as string[] | undefined;
  const geometry =
    policy.mode === "geometry" &&
    (!scopes ||
      (snapshots.size > 0 && [...snapshots].every((s) => scopes.includes(s))));
  const output = compactPayload(value, geometry ? "geometry" : "summary");
  store.put("data_send", {
    ...context,
    id: id("send"),
    tool,
    policyVersion: policy.id,
    at: now(),
    geometrySnapshotIds: [...snapshots],
    categories: [geometry ? "domain_result_with_geometry" : "domain_summary"],
    filtered: JSON.stringify(output).includes('"omittedByDataPolicy":true'),
  });
  return output;
}

// Error text can contain worker diagnostics, input coordinates, or credentials.
// Only stable codes cross the model boundary. Full errors remain in local logs.
export function modelError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  const safeCode =
    typeof code === "string" && /^[A-Z][A-Z0-9_]{1,70}$/.test(code)
      ? code
      : "INVALID_REQUEST";
  const messages: Record<string, string> = {
    RUNTIME_NOT_STARTED:
      "请由用户在独立终端运行发行包 CLI：runtime start <工程绝对路径>，然后重新 workspace_open。",
    RUNTIME_UNAVAILABLE:
      "运行时未响应或锁被持有；请运行 CLI runtime status 检查 .bwc/run/runtime.log，不会自动终止进程。",
    RUNTIME_DEPENDENCY_MISSING:
      "需要 Node 22.13+ 和含 fcntl 的 Python 3.10+；请运行发行包 scripts/doctor.mjs 获取安装说明。",
    WORKER_UNAVAILABLE:
      "计算环境不可用；请运行发行包 scripts/doctor.mjs 检查 .NET、Python、numpy 和 shapely。",
    WORKER_FAILED:
      "Worker 执行失败；请检查本地运行日志并运行 scripts/doctor.mjs 检查依赖。",
    COVERAGE_STALE: "冻结图纸或候选已变化，请重新准备独立覆盖审阅后再计算。",
    COVERAGE_INCOMPLETE:
      "覆盖范围存在未决项；请查看 scope_coverage_status 并在 Web 独立核对。",
    COVERAGE_VERSION_CONFLICT: "排除理由或覆盖版本已变化，请刷新本地审阅页面。",
    REVIEW_STALE: "审阅内容已变化，请重新准备审阅批次并打开链接。",
    SCHEMA_TOO_NEW: "工程数据版本高于插件支持版本，请升级插件。",
    EXTERNAL_IMPORT_REQUIRED: "工程外文件须通过显式 externalImport 复制导入。",
  };
  return {
    error: {
      code: safeCode,
      message:
        messages[safeCode] ??
        "操作未完成；请通过本地诊断检查错误代码和运行日志。",
    },
  };
}
